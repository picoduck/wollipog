/**
 * Runner-mediated cross-model review for sessions (#3306).
 *
 * A protected native session cannot run the cross-model review controller: its root filesystem is
 * read-only and a reviewer's own sandbox cannot nest inside the session's user namespace. The
 * runner runs the installed controller on the session's behalf, outside that namespace, for the
 * session's own pull request at its exact pushed head, from a runner-private snapshot. The reviewer
 * keeps its own read-only sandbox; nothing is written to the session's worktree or git metadata.
 *
 * Trust: the runner runs only a controller, interpreter, git, gh and reviewer CLIs that no session
 * can modify. Each is resolved one symlink at a time, and refused when the path or any directory
 * holding a link on the way is owned by another user, writable by other users, or inside any root a
 * session can write (provider credential homes, including configured account and per-session ones,
 * shared caches, temporary directories, project checkouts, worktrees and runner state). A session
 * could otherwise plant or repoint a binary the runner then runs unsandboxed.
 * The controller is looked up only in its installed location, never through a provider home's
 * skills directory, which sessions can write. Nothing the runner runs looks a program up on the
 * runner's own PATH: git, gh and recovery run with PATH set to runner-private links to the verified
 * git, gh and ssh followed by the system directories, SSH runs by its verified path (or not at
 * all), and the controller's PATH links the verified reviewer, git and the interpreter a reviewer
 * script names through `env` (an npm install's `node`).
 *
 * Durability: a job is saved as `launching`, with a per-launch marker the controller carries in
 * its environment, before the controller is spawned, so a runner that stops before recording the
 * process finds it again by that marker rather than leaving it unsupervised.
 *
 * Integrity: the reviewed snapshot comes from a runner-owned mirror filled over the pack protocol,
 * which names every object by the hash it computes, so a session that rewrites its own object
 * store cannot change what is reviewed. Every fetch URL is built by the runner from the verified
 * repository name; no remote string from session-writable configuration reaches git.
 */
import { execFile, spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import {
  SESSION_REVIEW_ARTIFACT_LIMIT_BYTES, SESSION_REVIEW_BRIEF_LIMIT_BYTES, SESSION_REVIEW_SUMMARY_LIMIT_BYTES,
  sanitizedSessionReviewReason,
  type SessionReviewCapability, type SessionReviewHarness, type SessionReviewJobCommand, type SessionReviewJobUpdate,
} from "@wollipog/protocol";
import {
  resolveAgentEnvironmentValue, type RunnerConfigAgent, type RunnerConfigWorkspace, type RunnerProviderAccount,
} from "./config.js";
import { githubSlug } from "./git-ops.js";
import type { SessionMeta, SessionStore } from "./session-store.js";

const execFileAsync = promisify(execFile);

/** Per-attempt controller timeout; the runner's watchdog adds a margin before it intervenes. */
export const SESSION_REVIEW_TIMEOUT_SECONDS = 1800;
const WATCHDOG_MARGIN_MS = 5 * 60_000;
/** How long a signalled process group gets to exit on SIGTERM before it is killed. */
const KILL_GRACE_MS = 30_000;
/** How much of the controller's stdout is read back for its final summary line. */
const CONTROLLER_STDOUT_TAIL_BYTES = 64 * 1024;
const MAX_VALID_ROUNDS = 4;
const MAX_CONSUMED_ATTEMPTS_PER_ROUND = 2;
const DEFAULT_MAX_CONCURRENT = 2;
/** Home-relative caches a protected session can write (mirrors execution-isolation's list). */
const SESSION_WRITABLE_CACHE_PATHS = [
  ".cache", ".npm", ".cargo/registry", ".cargo/git", ".local/share/pnpm/store", "go/pkg/mod",
] as const;
/** Where the controller is installed (Devbox). `~/.claude/skills/cross-model-review` usually links
 * here, but that link sits in a provider home a session can write, so it is never followed. */
const INSTALLED_SKILL_DIRECTORY = ".devbox/skills/cross-model-review";
/** Temporary directories every session can write. */
const SESSION_WRITABLE_TEMPORARY_ROOTS = ["/tmp", "/var/tmp", "/dev/shm"] as const;
/** A GitHub `owner/name`; the only form a review request may name. */
const GITHUB_REPOSITORY = /^[A-Za-z0-9-]{1,39}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u;
const SESSION_IDENTITY = /^[A-Za-z0-9_-]{1,128}$/u;

/** Flags for every git command the runner runs against a session's repository. The session can
 * write its worktree's git config, and these commands run outside its sandbox. */
const SAFE_GIT = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"] as const;
/** Transports a mirror fetch may use, and full object checks on everything it receives. SSH is
 * allowed only with a verified `ssh`, which every fetch then runs by its absolute path. */
function fetchGit(ssh: boolean): string[] {
  return [
    "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "protocol.https.allow=always",
    "-c", `protocol.ssh.allow=${ssh ? "always" : "never"}`, "-c", "transfer.fsckObjects=true",
  ];
}
/** Names the controller's process (and the reviewer it starts) so a restarted runner can find a
 * controller it spawned but never recorded. The value is a per-launch secret in runner state. */
const SESSION_REVIEW_JOB_VARIABLE = "WOLLIPOG_SESSION_REVIEW_JOB";
const MIRROR_FETCH_TIMEOUT_MS = 600_000;

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function within(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The roots below one HOME that a session using it can write: its default provider homes, the
 * runner's legacy state and the shared package caches. */
export function homeWritableRoots(home: string): string[] {
  return [
    join(home, ".codex"),
    join(home, ".claude"),
    join(home, ".agent-manager"),
    ...SESSION_WRITABLE_CACHE_PATHS.map((path) => join(home, path)),
  ];
}

/**
 * Every root a session can write, so nothing the runner runs may live there. `extra` carries the
 * configured project checkouts (their git directories are writable), provider account and
 * session provider homes, and any provider homes set through the runner's environment.
 */
export function sessionWritableRoots(
  home: string,
  dataDir: string,
  extra: readonly string[] = [],
  temporary: readonly string[] = [tmpdir(), ...SESSION_WRITABLE_TEMPORARY_ROOTS],
): string[] {
  const roots = [
    ...homeWritableRoots(home),
    dataDir,
    ...temporary,
    ...extra,
  ];
  return [...new Set(roots.flatMap((root) => {
    try { return [root, realpathSync(root)]; } catch { return [root]; }
  }))];
}

/** Check one resolved path: outside every session-writable root, and every component owned by
 * `uid` or root and not writable by other users. */
function checkResolved(real: string, roots: readonly string[], uid: number, rootUid: number): void {
  for (const root of roots) {
    if (within(root, real)) throw new Error(`${real} is inside a directory a session can write (${root})`);
  }
  const components: string[] = [];
  for (let current = real; ; current = join(current, "..")) {
    components.push(current);
    if (current === "/" || current === join(current, "..")) break;
  }
  let privateAncestor = false;
  const ordered = components.reverse();
  for (const [index, component] of ordered.entries()) {
    const info = lstatSync(component);
    if (info.uid !== uid && info.uid !== rootUid) throw new Error(`${component} is owned by another user`);
    // A sticky directory (like /tmp, mode 1777) cannot have entries it does not own replaced by
    // anyone, its group included, so it is a safe ancestor; the path itself never may be writable.
    const stickyAncestor = info.isDirectory() && (info.mode & 0o1000) !== 0 && index < ordered.length - 1;
    if ((info.mode & 0o002) && !stickyAncestor) throw new Error(`${component} is writable by every user`);
    if ((info.mode & 0o020) && !privateAncestor && !stickyAncestor) throw new Error(`${component} is writable by its group`);
    if (info.isDirectory() && info.uid === uid && (info.mode & 0o077) === 0) privateAncestor = true;
  }
}

/**
 * Resolve `path` and refuse it unless no other user, and no session, could have changed it.
 * Links are followed one at a time: each must be owned by `uid` or root and sit in a directory that
 * passes the same checks, so no hop on the way can be repointed. Group-write is accepted only
 * below a directory that only `uid` can enter, which keeps other users out.
 */
export function trustedPath(path: string, roots: readonly string[], uid: number, rootUid = 0): string {
  if (!isAbsolute(path)) throw new Error(`${path} is not an absolute path`);
  let resolved = "/";
  const pending = path.split("/").filter(Boolean);
  let hops = 0;
  while (pending.length) {
    const name = pending.shift()!;
    if (name === ".") continue;
    if (name === "..") { resolved = dirname(resolved); continue; }
    const next = join(resolved, name);
    let info;
    try { info = lstatSync(next); } catch { throw new Error(`${path} does not exist`); }
    if (!info.isSymbolicLink()) { resolved = next; continue; }
    if (++hops > 40) throw new Error(`${path} has too many symbolic links`);
    if (info.uid !== uid && info.uid !== rootUid) throw new Error(`${next} is owned by another user`);
    checkResolved(resolved, roots, uid, rootUid);
    const target = readlinkSync(next);
    if (isAbsolute(target)) resolved = "/";
    pending.unshift(...target.split("/").filter(Boolean));
  }
  checkResolved(resolved, roots, uid, rootUid);
  return resolved;
}

/** Provider home variables a session's environment can point at a writable directory. */
const PROVIDER_HOME_VARIABLES = ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;

/** Where the runner's configuration and its sessions say provider state lives. */
export interface SessionWritableSources {
  workspaces?: ReadonlyArray<Pick<RunnerConfigWorkspace, "path" | "additionalDirectoryGrants">>;
  providerAccounts?: ReadonlyArray<Pick<RunnerProviderAccount, "directory">>;
  agents?: ReadonlyArray<Pick<RunnerConfigAgent, "id" | "env">>;
  sessions?: Iterable<Pick<SessionMeta, "repoPath" | "worktreePath" | "worktrees" | "env" | "providerCredentialHome" |
    "providerConversationHome" | "pendingProviderCredentialHome" | "adoptedProviderState">>;
  hostEnv?: NodeJS.ProcessEnv;
}

/**
 * The session-writable directories the runner's configuration and persisted sessions name:
 * project checkouts and their directory grants, every provider account's credential directory,
 * provider homes (and HOME-derived provider directories) set in an agent's or a session's
 * environment, each session's worktrees, and each session's current, transcript-source and
 * pending provider credential homes. Relative and unresolvable values are dropped.
 */
export function configuredSessionWritablePaths(sources: SessionWritableSources): string[] {
  const paths: Array<string | null | undefined> = [];
  const fromEnvironment = (read: (name: string) => string | undefined) => {
    for (const name of PROVIDER_HOME_VARIABLES) paths.push(read(name));
    const home = read("HOME");
    if (home && isAbsolute(home)) paths.push(...homeWritableRoots(home));
  };
  const hostEnv = sources.hostEnv ?? {};
  fromEnvironment((name) => hostEnv[name]);
  for (const workspace of sources.workspaces ?? []) paths.push(workspace.path, ...(workspace.additionalDirectoryGrants ?? []));
  for (const account of sources.providerAccounts ?? []) paths.push(account.directory);
  for (const agent of sources.agents ?? []) {
    fromEnvironment((name) => {
      try { return resolveAgentEnvironmentValue(agent, name, hostEnv); } catch { return undefined; }
    });
  }
  for (const meta of sources.sessions ?? []) {
    paths.push(meta.providerCredentialHome, meta.providerConversationHome, meta.pendingProviderCredentialHome,
      meta.repoPath, meta.worktreePath, ...(meta.worktrees ?? []).map((worktree) => worktree.path),
      meta.adoptedProviderState?.sessionDir);
    const env = meta.env ?? {};
    fromEnvironment((name) => env[name]);
  }
  return [...new Set(paths.filter((path): path is string => typeof path === "string" && isAbsolute(path)))];
}

/**
 * The first `name` on `pathEnv` that passes `trustedPath`. A candidate a session could have
 * planted earlier on PATH is skipped, never run; when no candidate is trusted the first refusal
 * is reported.
 */
function trustedExecutable(name: string, pathEnv: string | undefined, roots: readonly string[], uid: number, rootUid?: number): string {
  let refusal: string | undefined;
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      const info = statSync(candidate);
      if (!info.isFile() || !(info.mode & 0o111)) continue;
    } catch { continue; }
    try { return trustedPath(candidate, roots, uid, rootUid); }
    catch (error) { refusal ??= (error as Error).message; }
  }
  throw new Error(refusal ?? `${name} is not installed`);
}

/** The interpreter line of a script (after `#!`), or undefined for anything else. */
function interpreterLine(path: string): string | undefined {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(256);
    const text = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString("latin1");
    if (!text.startsWith("#!")) return undefined;
    const end = text.indexOf("\n");
    return (end < 0 ? text : text.slice(0, end)).slice(2).trim();
  } finally {
    closeSync(fd);
  }
}

/**
 * Verify the interpreter a reviewer script runs under. An absolute interpreter must itself be
 * trusted; `env <program>` (how npm installs Node CLIs, `#!/usr/bin/env node`) looks the program
 * up on PATH, which for the controller holds only its private links and the system directories, so
 * the program is resolved here like every other executable and returned for linking there.
 */
function reviewerInterpreter(
  script: string, pathEnv: string | undefined, roots: readonly string[], uid: number, rootUid?: number,
): { name: string; path: string } | undefined {
  const line = interpreterLine(script);
  if (line === undefined) return undefined;
  const words = line.split(/\s+/u).filter(Boolean);
  const interpreter = words[0];
  if (!interpreter || !isAbsolute(interpreter)) throw new Error(`${script} names an interpreter that is not an absolute path`);
  trustedPath(interpreter, roots, uid, rootUid);
  if (basename(interpreter) !== "env") return undefined;
  const program = words.slice(1).find((word) => !word.startsWith("-") && !word.includes("="));
  if (!program) throw new Error(`${script} names no program for env to run`);
  if (isAbsolute(program)) { trustedPath(program, roots, uid, rootUid); return undefined; }
  if (!/^[A-Za-z0-9_+-][A-Za-z0-9._+-]{0,63}$/u.test(program)) throw new Error(`${script} names an unsupported interpreter`);
  try {
    return { name: program, path: trustedExecutable(program, pathEnv, roots, uid, rootUid) };
  } catch (error) {
    throw new Error(`${script} runs under ${program}, which is unavailable: ${(error as Error).message}`);
  }
}

export interface SessionReviewInstallation {
  controller: string;
  controllerDigest: string;
  python: string;
  git: string;
  /** The verified GitHub CLI the runner reads pull request facts with. */
  gh: string;
  /** The verified `ssh` git fetches over SSH with; without one, mirror fetches use HTTPS only. */
  ssh?: string;
  reviewers: Partial<Record<SessionReviewHarness, string>>;
  /** The verified interpreter a reviewer script runs under through `env` (an npm CLI's `node`),
   * linked into the controller's private PATH under its own name. */
  reviewerInterpreters?: Partial<Record<SessionReviewHarness, { name: string; path: string }>>;
  capability: SessionReviewCapability;
}

export interface InstallationEnvironment {
  home: string;
  dataDir: string;
  uid: number;
  /** The uid root-owned files show; 0 except inside a user namespace (tests). */
  rootUid?: number;
  pathEnv: string | undefined;
  /** Further session-writable roots: project checkouts, provider account and session provider
   * homes, and env-set provider homes (see `configuredSessionWritablePaths`). */
  extraRoots?: readonly string[];
  /** Session-writable temporary directories; defaults to the system's. */
  temporaryRoots?: readonly string[];
  /** Runner-configured controller skill directory, used instead of the Devbox install. */
  skillDirectory?: string;
}

/** Find and verify the installed controller and reviewer CLIs. Never throws: an untrusted or
 * missing piece is reported in the capability and that piece is not used. */
export function discoverSessionReviewInstallation(env: InstallationEnvironment): SessionReviewInstallation | null {
  const roots = sessionWritableRoots(env.home, env.dataDir, env.extraRoots, env.temporaryRoots);
  const unavailable: NonNullable<SessionReviewCapability["unavailable"]> = {};
  const skill = env.skillDirectory ?? join(env.home, INSTALLED_SKILL_DIRECTORY);
  if (!existsSync(skill)) return null;
  let controller: string;
  let controllerDigest: string;
  let python: string;
  let git: string;
  let gh: string;
  try {
    const skillDir = trustedPath(skill, roots, env.uid, env.rootUid);
    controller = trustedPath(join(skillDir, "scripts", "review.py"), roots, env.uid, env.rootUid);
    const scripts = join(skillDir, "scripts");
    const files = [
      ...readdirSync(scripts).filter((name) => /\.(py|sh|json)$/u.test(name)).map((name) => join(scripts, name)),
      ...["reviewers.json", "workflow-contract.json"].map((name) => join(skillDir, name)).filter((file) => existsSync(file)),
    ].sort();
    const contract = JSON.parse(readFileSync(join(skillDir, "workflow-contract.json"), "utf8")) as { contract_version?: unknown };
    if (contract.contract_version !== 1) throw new Error("the installed review controller has an unsupported contract");
    controllerDigest = sha256(files.map((file) => `${relative(skillDir, trustedPath(file, roots, env.uid, env.rootUid))}\0${sha256(readFileSync(file))}\n`).join(""));
    // All three are required: the runner runs gh and git itself, outside every sandbox.
    python = trustedExecutable("python3", env.pathEnv, roots, env.uid, env.rootUid);
    git = trustedExecutable("git", env.pathEnv, roots, env.uid, env.rootUid);
    gh = trustedExecutable("gh", env.pathEnv, roots, env.uid, env.rootUid);
  } catch (error) {
    return {
      controller: "", controllerDigest: "", python: "", git: "", gh: "", reviewers: {},
      capability: { reviewers: [], unavailable: { controller: (error as Error).message } },
    };
  }
  // Optional: without a trusted ssh, the mirror is filled over HTTPS only.
  let ssh: string | undefined;
  try { ssh = trustedExecutable("ssh", env.pathEnv, roots, env.uid, env.rootUid); } catch { ssh = undefined; }
  const reviewers: SessionReviewInstallation["reviewers"] = {};
  const reviewerInterpreters: NonNullable<SessionReviewInstallation["reviewerInterpreters"]> = {};
  for (const [harness, command] of [["codex", "codex"], ["claude-code", "claude"]] as const) {
    try {
      const path = trustedExecutable(command, env.pathEnv, roots, env.uid, env.rootUid);
      const interpreter = reviewerInterpreter(path, env.pathEnv, roots, env.uid, env.rootUid);
      reviewers[harness] = path;
      if (interpreter) reviewerInterpreters[harness] = interpreter;
    } catch (error) { unavailable[harness] = (error as Error).message; }
  }
  return {
    controller, controllerDigest, python, git, gh, ...(ssh ? { ssh } : {}), reviewers, reviewerInterpreters,
    capability: {
      controllerDigest,
      reviewers: (Object.keys(reviewers) as SessionReviewHarness[]).sort(),
      ...(Object.keys(unavailable).length ? { unavailable } : {}),
    },
  };
}

/** The reviewer for an implementing session's driver: always the other model family. */
export function reviewerForDriver(driver: string): SessionReviewHarness | null {
  if (driver === "claude-code") return "codex";
  if (driver === "codex" || driver === "codex-app-server") return "claude-code";
  return null;
}

/** A case-insensitive directory name for a validated `owner/name` (`_` cannot occur in an owner). */
function repositoryKey(repository: string): string {
  return repository.toLowerCase().replace("/", "__");
}

class RefusedReview extends Error {}
const refuse = (reason: string): never => { throw new RefusedReview(reason); };

interface AttemptRecord {
  epoch: number;
  round: number;
  attempt: number;
  dir: string;
  head: string;
  valid: boolean;
  consumed: boolean;
}

interface PullRequestState {
  epoch: number;
  attempts: AttemptRecord[];
}

interface JobState {
  command: SessionReviewJobCommand;
  /** `launching` is saved before the controller is spawned and `running` once its process is
   * recorded, so a restart in between can still find the controller by its marker. */
  phase: "prepared" | "launching" | "running" | "finished";
  prDir: string;
  attemptDir?: string;
  checkout?: string;
  round?: number;
  attempt?: number;
  epoch?: number;
  reviewer?: SessionReviewHarness;
  args?: string[];
  /** Runner-owned file holding the controller's stdout, where a preflight failure reports. */
  stdoutPath?: string;
  /** The per-launch value of `WOLLIPOG_SESSION_REVIEW_JOB` in the controller's environment. */
  marker?: string;
  controllerDigest?: string;
  /** The controller's process: also its process group, since it is spawned detached. */
  pid?: number;
  startIdentity?: string;
  /** The reviewer the controller started (from its running summary), proven to be in the
   * controller's process group; it can outlive the controller. */
  reviewerPid?: number;
  reviewerIdentity?: string;
  startedAt?: number;
  /** When the process group was first signalled; SIGKILL follows after a grace period. */
  signalledAt?: number;
  timedOut?: boolean;
  recoveryAttempted?: boolean;
  cancelled?: boolean;
  update?: SessionReviewJobUpdate;
}

/** The fields of /proc/<pid>/stat after the command name (field 3 onwards), or null. */
function processStat(pid: number): string[] | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch { return null; }
}

/** A live process's start time, which with its pid identifies it across pid reuse. A zombie has
 * already exited and is not alive. */
function processIdentity(pid: number): string | null {
  const fields = processStat(pid);
  if (!fields || fields[0] === "Z" || fields[0] === "X") return null;
  return fields[19] ?? null;
}

function processGroup(pid: number): number | null {
  const group = Number(processStat(pid)?.[2]);
  return Number.isSafeInteger(group) ? group : null;
}

/**
 * Live processes started with `WOLLIPOG_SESSION_REVIEW_JOB=<marker>`. `/proc/<pid>/environ` is
 * readable only for the runner's own processes, which is every controller it spawned.
 */
function markedProcesses(marker: string): number[] {
  const entry = `${SESSION_REVIEW_JOB_VARIABLE}=${marker}`;
  let names: string[];
  try { names = readdirSync("/proc"); } catch { return []; }
  const found: number[] = [];
  for (const name of names) {
    if (!/^[0-9]+$/u.test(name) || Number(name) === process.pid) continue;
    let environ: string;
    try { environ = readFileSync(`/proc/${name}/environ`, "latin1"); } catch { continue; }
    if (environ.split("\0").includes(entry) && processIdentity(Number(name)) !== null) found.push(Number(name));
  }
  return found;
}

/** The runner's environment without anything that can make git or ssh run another program or
 * read another repository; the callers set PATH and the SSH command themselves. */
function helperEnvironmentBase(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("GIT_") || name.endsWith("ASKPASS") || name === SESSION_REVIEW_JOB_VARIABLE) continue;
    env[name] = value;
  }
  return env;
}

const shellQuote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;

function readBounded(path: string, limit: number, tail = false): { text: string; truncated: boolean } | undefined {
  try {
    const bytes = readFileSync(path);
    if (bytes.length <= limit) return { text: bytes.toString("utf8"), truncated: false };
    const slice = tail ? bytes.subarray(bytes.length - limit) : bytes.subarray(0, limit);
    return { text: slice.toString("utf8"), truncated: true };
  } catch { return undefined; }
}

export interface PullRequestFacts {
  state: string;
  baseRepository: string;
  headRepository: string;
  headRef: string;
  headSha: string;
  baseSha: string;
}

/**
 * Runs the controller under `python3 -I`, which keeps the environment, user site-packages and the
 * working directory out of `sys.path`, but also drops the script's own directory, so the
 * controller's sibling modules would not import. The bootstrap puts back exactly the verified
 * scripts directory, then runs the controller as `__main__` with its own argv.
 */
const CONTROLLER_BOOTSTRAP = [
  "import os, runpy, sys",
  "controller = sys.argv[1]",
  "sys.argv = sys.argv[1:]",
  "sys.path.insert(0, os.path.dirname(controller))",
  "runpy.run_path(controller, run_name='__main__')",
].join("\n");

/** Interpreter arguments for `controllerArgs` (the controller's path, then its own arguments). */
export function sessionReviewLaunchArgs(controllerArgs: readonly string[]): string[] {
  return ["-I", "-B", "-c", CONTROLLER_BOOTSTRAP, ...controllerArgs];
}

export interface SessionReviewDependencies {
  /** Run a short command and return stdout (git, the controller's recovery), with `env` when given. */
  exec(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<string>;
  /** Open pull request facts from the forge, read with the verified GitHub CLI `gh`. */
  pullRequest(gh: string, repository: string, number: number, env?: NodeJS.ProcessEnv): Promise<PullRequestFacts>;
  /** Start the controller; `args` begins with the controller's path. `stdout` is a file descriptor. */
  spawnController(python: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdout: number }): ChildProcess;
  installation(): SessionReviewInstallation | null;
  now(): number;
  log(message: string): void;
}

export function defaultSessionReviewDependencies(
  dataDir: string,
  log: (message: string) => void,
  /** Directories sessions can write (see `configuredSessionWritablePaths`), read at each
   * discovery so configuration and session changes apply. */
  sessionWritablePaths: () => readonly string[] = () => [],
): SessionReviewDependencies {
  return {
    exec: async (command, args, options = {}) => (await execFileAsync(command, args, {
      encoding: "utf8", timeout: options.timeoutMs ?? 30_000, maxBuffer: 8_000_000,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env ?? { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
    })).stdout,
    pullRequest: async (gh, repository, number, env) => {
      if (!isAbsolute(gh)) throw new Error("the GitHub CLI path is not verified");
      const raw = (await execFileAsync(gh, ["api", `repos/${repository}/pulls/${number}`], {
        encoding: "utf8", timeout: 30_000, maxBuffer: 2_000_000,
        env: env ?? { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
      })).stdout;
      const pr = JSON.parse(raw) as {
        state?: string; base?: { sha?: string; repo?: { full_name?: string } };
        head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null };
      };
      return {
        state: String(pr.state ?? ""),
        baseRepository: String(pr.base?.repo?.full_name ?? ""),
        headRepository: String(pr.head?.repo?.full_name ?? ""),
        headRef: String(pr.head?.ref ?? ""),
        headSha: String(pr.head?.sha ?? ""),
        baseSha: String(pr.base?.sha ?? ""),
      };
    },
    spawnController: (python, args, options) => spawnProcess(python, sessionReviewLaunchArgs(args), {
      cwd: options.cwd, env: options.env, stdio: ["ignore", options.stdout, "ignore"], detached: true,
    }),
    installation: () => discoverSessionReviewInstallation({
      home: homedir(), dataDir, uid: process.getuid?.() ?? -1, pathEnv: process.env.PATH,
      extraRoots: [
        ...sessionWritablePaths(),
        ...[process.env.CODEX_HOME, process.env.CLAUDE_CONFIG_DIR].filter((value): value is string => Boolean(value)),
      ],
      ...(process.env.WOLLIPOG_SESSION_REVIEW_SKILL_DIR ? { skillDirectory: process.env.WOLLIPOG_SESSION_REVIEW_SKILL_DIR } : {}),
    }),
    now: () => Date.now(),
    log,
  };
}

/** Owns every session review job: durable intent before launch, one job per session at a time,
 * restart recovery from persisted state and process identity. */
export class SessionReviewJobs {
  private readonly polling = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly active = new Set<string>();
  /** The single in-memory state of every unfinished job; cancel and poll share it. */
  private readonly states = new Map<string, JobState>();
  /** One mirror fetch at a time per repository. */
  private readonly mirrorQueues = new Map<string, Promise<void>>();
  /** Jobs whose controller recovery is in flight; only its completion may finish them. */
  private readonly recovering = new Set<string>();

  constructor(
    private readonly root: string,
    private readonly store: Pick<SessionStore, "readMeta">,
    private readonly send: (update: SessionReviewJobUpdate) => void,
    private readonly deps: SessionReviewDependencies,
    private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT,
  ) {
    mkdirSync(join(root, "jobs"), { recursive: true, mode: 0o700 });
    for (const name of readdirSync(join(root, "jobs"))) {
      const match = /^(srj_[A-Za-z0-9_-]{8,64})\.json$/u.exec(name);
      if (!match) continue;
      try {
        const state = this.load(match[1]!);
        if (state.phase !== "finished") this.states.set(state.command.jobId, state);
        if (state.phase === "prepared") {
          this.finish(state, { state: "not_launched", reason: "the review process ended without a result" });
        } else if (state.phase === "launching") {
          this.reconcileLaunch(state);
        } else if (state.phase === "running") {
          this.active.add(state.command.sessionId);
          this.poll(state);
        }
      } catch (error) {
        deps.log(`session review job ${name} could not be restored: ${(error as Error).message}`);
      }
    }
  }

  capability(): SessionReviewCapability | undefined {
    return this.deps.installation()?.capability;
  }

  /**
   * A job the runner restarted during: saved as `launching`, but its controller's process was never
   * recorded. A live process carrying the job's marker is adopted (the controller, or the reviewer
   * it started, in the controller's process group); an attempt directory or controller output with
   * no live process is a launched controller that died, which the normal poll recovers; with
   * neither, nothing launched and the attempt is returned.
   */
  private reconcileLaunch(state: JobState): void {
    const marked = state.marker ? markedProcesses(state.marker) : [];
    const leader = marked.find((pid) => processGroup(pid) === pid);
    const member = leader ?? marked[0];
    const group = member === undefined ? null : processGroup(member);
    const launched = Boolean(state.attemptDir && existsSync(state.attemptDir)) ||
      Boolean(state.stdoutPath && (statSync(state.stdoutPath, { throwIfNoEntry: false })?.size ?? 0) > 0);
    if (member !== undefined && group !== null && group > 1) {
      state.pid = group;
      if (leader !== undefined) {
        state.startIdentity = processIdentity(leader) ?? undefined;
      } else {
        state.reviewerPid = member;
        state.reviewerIdentity = processIdentity(member) ?? undefined;
      }
    } else if (!launched) {
      this.releaseAttempt(state);
      this.finish(state, { state: "not_launched", reason: "the review process ended without a result" });
      return;
    }
    state.phase = "running";
    this.save(state);
    this.active.add(state.command.sessionId);
    this.emit(state, { state: "running", ...(state.controllerDigest ? { controllerDigest: state.controllerDigest } : {}) });
    this.poll(state);
  }

  /** Remove the attempt a job recorded but never launched, so it is not charged. */
  private releaseAttempt(state: JobState): void {
    const prStatePath = join(state.prDir, "attempts.json");
    try {
      if (!existsSync(prStatePath)) return;
      const prState = JSON.parse(readFileSync(prStatePath, "utf8")) as PullRequestState;
      const attempts = prState.attempts.filter((attempt) => attempt.dir !== state.attemptDir);
      if (attempts.length === prState.attempts.length) return;
      writeFileSync(`${prStatePath}.next`, JSON.stringify({ ...prState, attempts }), { mode: 0o600 });
      renameSync(`${prStatePath}.next`, prStatePath);
    } catch (error) {
      this.deps.log(`session review attempt record could not be released: ${(error as Error).message}`);
    }
  }

  /**
   * The environment for every git, gh and recovery command the runner runs for a review. PATH
   * holds only a runner-private directory of links to the verified git, gh and ssh, then the system
   * directories, so no program that git or a credential helper looks up by name (`ssh` for an SSH
   * fetch above all) can come from a directory a session can write; SSH runs by its verified path.
   * HOME stays, so the user's own git and gh configuration and credentials keep working.
   */
  private helperEnvironment(install: SessionReviewInstallation): NodeJS.ProcessEnv {
    const links: Record<string, string> = {
      git: install.git, ...(install.gh ? { gh: install.gh } : {}), ...(install.ssh ? { ssh: install.ssh } : {}),
    };
    const bin = join(this.root, "tools", sha256(JSON.stringify(links)).slice(0, 24));
    if (!existsSync(bin)) {
      // Built aside and renamed into place, so a directory that exists is always complete.
      const staging = `${bin}.${process.pid}.${randomBytes(6).toString("hex")}`;
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      for (const [name, target] of Object.entries(links)) symlinkSync(target, join(staging, name));
      try { renameSync(staging, bin); } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        if (!existsSync(bin)) throw error;
      }
    }
    return {
      ...helperEnvironmentBase(),
      PATH: `${bin}:/usr/bin:/bin`,
      GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
      // Overrides any `core.sshCommand`; without a verified ssh no fetch is allowed SSH at all.
      GIT_SSH_COMMAND: install.ssh ? shellQuote(install.ssh) : "/bin/false",
    };
  }

  private jobPath(jobId: string): string {
    if (!/^srj_[A-Za-z0-9_-]{8,64}$/u.test(jobId)) throw new Error("invalid session review job identity");
    return join(this.root, "jobs", `${jobId}.json`);
  }

  private load(jobId: string): JobState {
    return JSON.parse(readFileSync(this.jobPath(jobId), "utf8")) as JobState;
  }

  private save(state: JobState): void {
    const path = this.jobPath(state.command.jobId);
    writeFileSync(`${path}.next`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${path}.next`, path);
  }

  private emit(state: JobState, update: Omit<SessionReviewJobUpdate, "type" | "jobId" | "nonce">): void {
    const full: SessionReviewJobUpdate = {
      type: "session_review_job_update", jobId: state.command.jobId, nonce: state.command.nonce,
      ...(state.round !== undefined ? { round: state.round } : {}),
      ...(state.attempt !== undefined ? { attempt: state.attempt } : {}),
      ...(state.reviewer ? { reviewer: state.reviewer } : {}),
      ...update,
    };
    if (full.reason !== undefined) full.reason = sanitizedSessionReviewReason(full.reason);
    if (full.state !== "running") {
      state.phase = "finished";
      state.update = full;
      this.active.delete(state.command.sessionId);
      this.states.delete(state.command.jobId);
      if (state.checkout) {
        try { rmSync(state.checkout, { recursive: true, force: true }); } catch { /* retried on the next finish */ }
      }
    }
    this.save(state);
    this.send(full);
  }

  private finish(state: JobState, update: Omit<SessionReviewJobUpdate, "type" | "jobId" | "nonce">): void {
    const timer = this.polling.get(state.command.jobId);
    if (timer) clearTimeout(timer);
    this.polling.delete(state.command.jobId);
    this.emit(state, update);
  }

  /** Dispatch one job. Idempotent on jobId: a known job re-sends its result or resumes polling. */
  async dispatch(command: SessionReviewJobCommand): Promise<void> {
    if (this.states.has(command.jobId) || existsSync(this.jobPath(command.jobId))) {
      const state = this.states.get(command.jobId) ?? this.load(command.jobId);
      if (state.command.nonce !== command.nonce) return;
      if (state.phase === "finished" && state.update) this.send(state.update);
      else if (state.phase === "running") this.poll(state);
      return;
    }
    // GitHub names are case-insensitive: one directory per repository however a request spells it.
    const repository = command.request.pullRequest.repository;
    const named = GITHUB_REPOSITORY.test(repository) && SESSION_IDENTITY.test(command.sessionId) &&
      Number.isSafeInteger(command.request.pullRequest.number) && command.request.pullRequest.number > 0;
    const prDir = named
      ? join(this.root, "sessions", command.sessionId, repositoryKey(repository), `pr-${command.request.pullRequest.number}`)
      : join(this.root, "refused");
    const state: JobState = { command, phase: "prepared", prDir };
    if (!named) {
      this.save(state);
      this.finish(state, { state: "not_launched", reason: "the pull request is not this session's open, same-repository pull request" });
      return;
    }
    if (this.active.has(command.sessionId)) {
      this.save(state);
      this.finish(state, { state: "not_launched", reason: "a review of this session is already running" });
      return;
    }
    if (this.active.size >= this.maxConcurrent) {
      this.save(state);
      this.finish(state, { state: "not_launched", reason: "the runner is at its review concurrency limit" });
      return;
    }
    this.active.add(command.sessionId);
    this.states.set(command.jobId, state);
    this.save(state); // Durable intent exists before anything can launch.
    try {
      await this.prepareAndLaunch(state);
    } catch (error) {
      const reason = error instanceof RefusedReview ? error.message : "the review snapshot could not be prepared";
      if (!(error instanceof RefusedReview)) this.deps.log(`session review ${command.jobId} failed to start: ${(error as Error).message}`);
      this.finish(state, { state: state.pid ? "failed" : "not_launched", reason });
    }
  }

  private async prepareAndLaunch(state: JobState): Promise<void> {
    const { command } = state;
    const request = command.request;
    const install = this.deps.installation();
    if (!install?.controller) refuse("the runner has no trusted cross-model review installation");
    const meta = this.store.readMeta(command.sessionId);
    const worktree = meta?.worktreePath ? meta.worktrees?.find((candidate) => candidate.path === meta.worktreePath) : undefined;
    if (!meta || !worktree || worktree.source !== "created" || meta.context?.kind !== "native" ||
        (meta.executionTarget?.adapter && meta.executionTarget.adapter !== "host")) {
      refuse("the review must cover the session's own native managed worktree");
    }
    const reviewer = reviewerForDriver(meta!.driver);
    if (!reviewer) refuse("this session's harness has no cross-model reviewer");
    const reviewerPath = install!.reviewers[reviewer!];
    if (!reviewerPath) refuse("the reviewer for this session's harness is unavailable on this runner");
    state.reviewer = reviewer!;
    const helperEnv = this.helperEnvironment(install!);

    // Scope: the session's own open pull request, from its own repository, at its pushed head. The
    // repository is read from the runner-recorded project checkout, never through the worktree's
    // own `.git` pointer, which the session can rewrite.
    const repoPath = realpathSync(meta!.repoPath);
    const origin = (await this.deps.exec(install!.git, [...SAFE_GIT, "-C", repoPath, "remote", "get-url", "origin"], { env: helperEnv })).trim();
    const repository = request.pullRequest.repository;
    if (githubSlug(origin)?.toLowerCase() !== repository.toLowerCase()) {
      refuse("the pull request is not this session's open, same-repository pull request");
    }
    const pr = await this.deps.pullRequest(install!.gh, repository, request.pullRequest.number, helperEnv);
    if (pr.state !== "open" || pr.baseRepository.toLowerCase() !== repository.toLowerCase() ||
        pr.headRepository.toLowerCase() !== repository.toLowerCase() || pr.headRef !== worktree!.branch) {
      refuse("the pull request is not this session's open, same-repository pull request");
    }
    if (!/^[0-9a-f]{40}$/u.test(request.headSha) || pr.headSha !== request.headSha) {
      refuse("the requested head is not the pull request's pushed head");
    }

    // Brief: required once per pull request, kept by the runner afterwards.
    mkdirSync(state.prDir, { recursive: true, mode: 0o700 });
    const briefPath = join(state.prDir, "brief.md");
    if (request.brief !== undefined) {
      if (Buffer.byteLength(request.brief) > SESSION_REVIEW_BRIEF_LIMIT_BYTES) refuse("the brief exceeds its size limit");
      writeFileSync(briefPath, request.brief, { mode: 0o600 });
    } else if (!existsSync(briefPath)) {
      refuse("the first review of a pull request needs a brief");
    }

    // Round and attempt, following the controller's limits.
    const prStatePath = join(state.prDir, "attempts.json");
    const prState: PullRequestState = existsSync(prStatePath)
      ? JSON.parse(readFileSync(prStatePath, "utf8")) as PullRequestState
      : { epoch: 1, attempts: [] };
    // The checkout's own `.git` directory, never a gitdir file or link that could name another
    // repository; and no `commondir` indirection inside it.
    const commonDir = join(repoPath, ".git");
    if (!lstatSync(commonDir, { throwIfNoEntry: false })?.isDirectory() || existsSync(join(commonDir, "commondir"))) {
      refuse("the review snapshot could not be prepared");
    }
    // Built here from the verified name; the origin's spelling only chooses SSH or HTTPS, and SSH
    // only with a verified ssh.
    const forgeUrl = /^https:\/\//iu.test(origin) || !install!.ssh
      ? `https://github.com/${pr.baseRepository}.git` : `git@github.com:${pr.baseRepository}.git`;
    const mirror = join(this.root, "mirrors", `${repositoryKey(repository)}.git`);
    await this.syncMirror(install!.git, helperEnv, Boolean(install!.ssh), mirror, commonDir, worktree!.branch, forgeUrl, [pr.baseSha, request.headSha]);
    let epochAttempts = prState.attempts.filter((attempt) => attempt.epoch === prState.epoch);
    // The head the epoch was reviewed at: its last valid round's, or before any valid round, its
    // most recent attempt's (valid or not).
    const reference = [...epochAttempts].reverse().find((attempt) => attempt.valid) ?? epochAttempts.at(-1);
    if (reference && reference.head !== request.headSha) {
      // Objects missing from the mirror fail the check, which counts as a rewrite.
      const ancestor = await this.deps.exec(install!.git, [...SAFE_GIT, "--git-dir", mirror, "merge-base", "--is-ancestor", "--end-of-options", reference.head, request.headSha], { env: helperEnv })
        .then(() => true, () => false);
      if (!ancestor) { // A rebase or force-push starts a new review epoch with a full round.
        prState.epoch += 1;
        epochAttempts = [];
      }
    }
    const last = epochAttempts.at(-1);
    const validRounds = epochAttempts.filter((attempt) => attempt.valid).length;
    let round: number;
    let attempt: number;
    if (!last || last.valid) {
      if (validRounds >= MAX_VALID_ROUNDS) refuse("this pull request has reached its review round limit");
      round = (last?.round ?? 0) + 1;
      attempt = 1;
    } else {
      const consumed = epochAttempts.filter((item) => item.round === last.round && item.consumed).length;
      if (consumed >= MAX_CONSUMED_ATTEMPTS_PER_ROUND) refuse("this review round has used its attempts");
      round = last.round;
      attempt = last.attempt + 1;
    }
    const previous = [...epochAttempts].reverse().find((item) => item.valid);
    state.epoch = prState.epoch;
    state.round = round;
    state.attempt = attempt;
    state.attemptDir = join(state.prDir, `e${prState.epoch}-r${round}-a${attempt}`);
    if (existsSync(state.attemptDir)) refuse("the review snapshot could not be prepared");

    // Snapshot: a checkout of the runner-owned mirror at the exact head. Nothing touches the
    // session's worktree or its git metadata, and the session may keep working during the review.
    state.checkout = join(state.prDir, `checkout-${command.jobId}`);
    await this.deps.exec(install!.git, [...SAFE_GIT, "clone", "--quiet", "--shared", "--no-checkout", "--end-of-options", mirror, state.checkout], { timeoutMs: 120_000, env: helperEnv });
    await this.deps.exec(install!.git, [...SAFE_GIT, "-C", state.checkout, "checkout", "--quiet", "--detach", request.headSha], { timeoutMs: 120_000, env: helperEnv });

    const ledger = join(state.prDir, "ledger.md");
    if (!existsSync(ledger)) {
      writeFileSync(ledger, [
        `# Cross-Model Review: ${repository}#${request.pullRequest.number}`,
        "",
        `- Implementer / Reviewer: ${meta!.driver} / ${reviewer}`,
        "- Runner-mediated review (#3306): the runner runs the installed controller outside the session sandbox.",
        "- Final Recommendation: Pending",
        "",
      ].join("\n"), { mode: 0o600 });
    }
    state.args = [
      install!.controller, "run",
      "--repo", state.checkout,
      "--base-ref", pr.baseSha,
      "--expected-base", pr.baseSha,
      "--expected-head", request.headSha,
      "--brief", briefPath,
      "--attempt-dir", state.attemptDir,
      "--ledger", ledger,
      "--round", String(round),
      "--reviewer", reviewer!,
      "--timeout-seconds", String(SESSION_REVIEW_TIMEOUT_SECONDS),
      ...(request.scope === "full"
        ? ["--full-reason", (request.fullReason ?? "full re-review requested by the session").slice(0, 500)]
        : previous ? ["--previous-attempt", previous.dir] : []),
    ];

    // Only the verified reviewer (with the interpreter its script names through env) and git are
    // on PATH ahead of the system directories; the controller resolves them by name.
    const bin = join(state.prDir, `bin-${command.jobId}`);
    mkdirSync(bin, { mode: 0o700 });
    const reviewerCommand = reviewer === "codex" ? "codex" : "claude";
    symlinkSync(reviewerPath!, join(bin, reviewerCommand));
    symlinkSync(install!.git, join(bin, "git"));
    const interpreter = install!.reviewerInterpreters?.[reviewer!];
    if (interpreter && interpreter.name !== reviewerCommand && interpreter.name !== "git") {
      symlinkSync(interpreter.path, join(bin, interpreter.name));
    }
    const env: NodeJS.ProcessEnv = { ...helperEnvironmentBase(), PATH: `${bin}:/usr/bin:/bin`, GIT_OPTIONAL_LOCKS: "0" };
    // The controller identifies the implementer from CLAUDECODE; keep it consistent with the
    // session so its self-review refusal and reviewer choice agree with the runner's.
    if (meta!.driver === "claude-code") env.CLAUDECODE = "1"; else delete env.CLAUDECODE;

    // Last point a cancel can still stop the launch without consuming an attempt.
    if (state.cancelled) refuse("the review was cancelled");

    // The controller's stdout goes to a runner-owned file, not a pipe, so it survives a runner
    // restart: a preflight failure reports only there, with no attempt directory.
    state.stdoutPath = join(state.prDir, `stdout-${command.jobId}.jsonl`);
    // Durable before the spawn: a restart before `running` is saved finds the controller by this
    // marker in its environment (see `reconcileLaunch`).
    state.marker = `${command.jobId}:${sha256(`${command.nonce}\0${randomBytes(16).toString("hex")}`).slice(0, 32)}`;
    env[SESSION_REVIEW_JOB_VARIABLE] = state.marker;
    state.controllerDigest = install!.controllerDigest;
    state.startedAt = this.deps.now();
    state.phase = "launching";
    this.save(state);
    prState.attempts.push({
      epoch: prState.epoch, round, attempt, dir: state.attemptDir, head: request.headSha, valid: false, consumed: true,
    });
    writeFileSync(`${prStatePath}.next`, JSON.stringify(prState), { mode: 0o600 });
    renameSync(`${prStatePath}.next`, prStatePath);

    let child: ChildProcess;
    try {
      const stdout = openSync(state.stdoutPath, "w", 0o600);
      try {
        child = this.deps.spawnController(install!.python, state.args, { cwd: state.prDir, env, stdout });
      } finally {
        closeSync(stdout);
      }
    } catch (error) {
      this.releaseAttempt(state); // nothing started
      throw error;
    }
    state.pid = child.pid;
    state.startIdentity = child.pid ? processIdentity(child.pid) ?? undefined : undefined;
    state.phase = "running";
    try {
      this.save(state);
    } catch (error) {
      // An unrecorded controller would run unsupervised: stop it (it cannot have been reaped yet,
      // so its group is still its own) and report the job failed.
      this.deps.log(`session review ${command.jobId} could not record its controller: ${(error as Error).message}`);
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      try {
        this.finish(state, { state: "failed", reason: "the review process ended without a result" });
      } catch {
        if (state.update) this.send(state.update);
      }
      return;
    }
    child.on("error", () => this.poll(state));
    child.on("exit", () => this.poll(state));
    this.emit(state, { state: "running", controllerDigest: install!.controllerDigest });
    this.poll(state);
  }

  /**
   * Bring `commits` into the runner-owned mirror. The session's object store is read over the pack
   * protocol, which hashes everything it receives, so rewritten objects there are refused rather
   * than reviewed; anything still missing comes from the forge.
   */
  private async syncMirror(
    git: string, env: NodeJS.ProcessEnv, ssh: boolean, mirror: string, commonDir: string, branch: string, forgeUrl: string, commits: string[],
  ): Promise<void> {
    const previous = this.mirrorQueues.get(mirror) ?? Promise.resolve();
    const run = previous.then(async () => {
      if (!existsSync(join(mirror, "HEAD"))) {
        mkdirSync(dirname(mirror), { recursive: true, mode: 0o700 });
        await this.deps.exec(git, [...SAFE_GIT, "init", "--quiet", "--bare", "--end-of-options", mirror], { env });
      }
      const has = (sha: string) => this.deps.exec(git, [...SAFE_GIT, "--git-dir", mirror, "cat-file", "-e", `${sha}^{commit}`], { env })
        .then(() => true, () => false);
      const missing = async () => (await Promise.all(commits.map(async (sha) => (await has(sha)) ? null : sha)))
        .filter((sha): sha is string => sha !== null);
      if ((await missing()).length) {
        await this.deps.exec(git, [
          ...SAFE_GIT, ...fetchGit(ssh), "--git-dir", mirror, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head",
          // Only the session's own branch: nothing else in the checkout reaches the reviewer.
          "--end-of-options", `file://${commonDir}`, `+refs/heads/${branch}:refs/session/heads/${branch}`,
        ], { timeoutMs: MIRROR_FETCH_TIMEOUT_MS, env }).catch((error: Error) => this.deps.log(`session review mirror could not read the project repository: ${error.message}`));
      }
      const still = await missing();
      if (still.length) {
        await this.deps.exec(git, [
          ...SAFE_GIT, ...fetchGit(ssh), "--git-dir", mirror, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head",
          "--end-of-options", forgeUrl, ...still,
        ], { timeoutMs: MIRROR_FETCH_TIMEOUT_MS, env });
      }
    });
    const settledRun = run.then(() => {}, () => {});
    this.mirrorQueues.set(mirror, settledRun);
    try {
      await run;
    } finally {
      if (this.mirrorQueues.get(mirror) === settledRun) this.mirrorQueues.delete(mirror);
    }
  }

  private controllerAlive(state: JobState): boolean {
    return Boolean(state.pid && state.startIdentity && processIdentity(state.pid) === state.startIdentity);
  }

  /** The recorded reviewer is the same process and still in the controller's process group. */
  private reviewerAlive(state: JobState): boolean {
    return Boolean(state.pid && state.reviewerPid && state.reviewerIdentity &&
      processIdentity(state.reviewerPid) === state.reviewerIdentity && processGroup(state.reviewerPid) === state.pid);
  }

  /** The controller or the reviewer it started is still running. */
  private alive(state: JobState): boolean {
    return this.controllerAlive(state) || this.reviewerAlive(state);
  }

  /**
   * Record the reviewer named by the controller's running summary, once it is proven to be the
   * controller's: in its process group and started no earlier than it. The controller starts the
   * reviewer in its own group, so the reviewer outlives a controller that is killed.
   */
  private trackReviewer(state: JobState, summary: Record<string, unknown> | undefined): void {
    if (state.reviewerPid !== undefined || !state.pid || !state.startIdentity) return;
    const pid = summary?.status === "running" ? summary.pid : undefined;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || pid === state.pid) return;
    const identity = processIdentity(pid);
    if (!identity || processGroup(pid) !== state.pid || Number(identity) < Number(state.startIdentity)) return;
    state.reviewerPid = pid;
    state.reviewerIdentity = identity;
    this.save(state);
  }

  /** The controller's last JSON line on stdout: its summary when it wrote no attempt directory. */
  private controllerOutput(state: JobState): { value: Record<string, unknown>; text: string } | undefined {
    if (!state.stdoutPath) return undefined;
    const tail = readBounded(state.stdoutPath, CONTROLLER_STDOUT_TAIL_BYTES, true);
    const lines = tail?.text.split("\n").map((line) => line.trim()).filter(Boolean) ?? [];
    for (const line of lines.reverse()) {
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === "object" && !Array.isArray(value)) return { value: value as Record<string, unknown>, text: line };
      } catch { /* not a summary line */ }
    }
    return undefined;
  }

  private poll(state: JobState): void {
    if (state.phase !== "running" || !state.attemptDir) return;
    const key = state.command.jobId;
    const previous = this.polling.get(key);
    if (previous) clearTimeout(previous);
    this.polling.delete(key);
    // A recovery in flight decides the result and polls again once it settles.
    if (this.recovering.has(key)) return;
    const controllerAlive = this.controllerAlive(state);
    let summary: Record<string, unknown> | undefined;
    try { summary = JSON.parse(readFileSync(join(state.attemptDir, "summary.json"), "utf8")) as Record<string, unknown>; } catch { /* not yet */ }
    this.trackReviewer(state, summary);
    const alive = controllerAlive || this.reviewerAlive(state);
    // A preflight failure creates no attempt directory; the controller reports it on stdout only.
    let stdoutSummary: string | undefined;
    // Only a genuine preflight failure is read from stdout: no attempt directory, no reviewer ever
    // started, and a summary that says it never launched. Anything else falls through to recovery.
    if (!summary && !alive && !state.reviewerPid && !existsSync(state.attemptDir)) {
      const output = this.controllerOutput(state);
      if (output && output.value.phase === "preflight" && output.value.launched === false &&
          output.value.attempt_valid === false) {
        summary = output.value;
        stdoutSummary = output.text;
      }
    }
    const complete = summary?.status === "complete" || summary?.attempt_valid !== undefined;
    if (alive) {
      // Nothing is released while the controller or its reviewer still runs.
      const now = this.deps.now();
      if (!state.timedOut && state.startedAt !== undefined &&
          now - state.startedAt > SESSION_REVIEW_TIMEOUT_SECONDS * 1000 + WATCHDOG_MARGIN_MS) {
        state.timedOut = true;
        this.signalGroup(state, "SIGTERM");
      } else if (state.signalledAt !== undefined && now - state.signalledAt > KILL_GRACE_MS) {
        this.signalGroup(state, "SIGKILL");
      }
      const timer = setTimeout(() => this.poll(state), 2_000);
      timer.unref?.();
      this.polling.set(key, timer);
      return;
    }
    if (!complete && !state.timedOut && !state.recoveryAttempted && state.args) {
      // The controller died before writing its result: let it reconcile the attempt once. While
      // that runs, no other poll (a redispatch, a cancel, a timer) may finish the job; it is marked
      // attempted only once it has settled, so a restart in the meantime runs it again.
      this.recovering.add(key);
      const round = state.args[state.args.indexOf("--round") + 1]!;
      const ledger = state.args[state.args.indexOf("--ledger") + 1]!;
      const attemptDir = state.attemptDir;
      void (async () => {
        const install = this.deps.installation();
        if (!install?.controller) throw new Error("no installation");
        await this.deps.exec(install.python, sessionReviewLaunchArgs([install.controller, "recover", "--attempt-dir", attemptDir, "--ledger", ledger, "--round", round]),
          { timeoutMs: 120_000, env: this.helperEnvironment(install) });
      })()
        .catch(() => {})
        .finally(() => {
          this.recovering.delete(key);
          // A reviewer that turned out to be running refuses recovery; try again once it is gone.
          if (!this.alive(state)) {
            state.recoveryAttempted = true;
            try { this.save(state); } catch (error) {
              this.deps.log(`session review job ${key} could not be saved: ${(error as Error).message}`);
            }
          }
          this.poll(state);
        });
      return;
    }
    this.recordAttempt(state, summary);
    const reason = state.timedOut ? "the review exceeded its time limit"
      : state.cancelled ? "the review was cancelled" : "the review process ended without a result";
    this.finish(state, complete
      ? { state: "completed", ...this.artifacts(state, stdoutSummary) }
      : { state: "failed", reason, ...this.artifacts(state) });
  }

  private recordAttempt(state: JobState, summary: Record<string, unknown> | undefined): void {
    const prStatePath = join(state.prDir, "attempts.json");
    try {
      const prState = JSON.parse(readFileSync(prStatePath, "utf8")) as PullRequestState;
      const record = prState.attempts.find((attempt) => attempt.dir === state.attemptDir);
      if (!record) return;
      record.valid = summary?.attempt_valid === true;
      record.consumed = summary?.attempt_consumed !== false;
      writeFileSync(`${prStatePath}.next`, JSON.stringify(prState), { mode: 0o600 });
      renameSync(`${prStatePath}.next`, prStatePath);
    } catch (error) {
      this.deps.log(`session review attempt record could not be updated: ${(error as Error).message}`);
    }
  }

  private artifacts(state: JobState, stdoutSummary?: string): Partial<SessionReviewJobUpdate> {
    if (!state.attemptDir) return {};
    const summary = stdoutSummary !== undefined
      ? { text: stdoutSummary, truncated: Buffer.byteLength(stdoutSummary) > SESSION_REVIEW_SUMMARY_LIMIT_BYTES }
      : readBounded(join(state.attemptDir, "summary.json"), SESSION_REVIEW_SUMMARY_LIMIT_BYTES);
    const report = readBounded(join(state.attemptDir, "report.json"), SESSION_REVIEW_ARTIFACT_LIMIT_BYTES);
    const ledger = readBounded(join(state.prDir, "ledger.md"), SESSION_REVIEW_ARTIFACT_LIMIT_BYTES, true);
    return {
      ...(summary && !summary.truncated ? { summary: summary.text.trim() } : {}),
      ...(report ? { report: report.text, ...(report.truncated ? { reportTruncated: true } : {}) } : {}),
      ...(ledger ? { ledger: ledger.text, ...(ledger.truncated ? { ledgerTruncated: true } : {}) } : {}),
    };
  }

  /**
   * Signal the job's process group, and only while a member is proven alive by identity: the
   * controller (the group leader), or the recorded reviewer still in that group. A group cannot be
   * reused while a live member is in it, and nothing is signalled once neither is alive.
   */
  private signalGroup(state: JobState, signal: NodeJS.Signals): void {
    if (!state.pid || !this.alive(state)) return;
    try { process.kill(-state.pid, signal); } catch { /* already gone */ }
    state.signalledAt ??= this.deps.now();
    this.save(state);
  }

  /** Cancel a running job; only its own recorded process group is signalled. The job ends once
   * the controller and its reviewer are both gone. */
  cancel(jobId: string, nonce: string): void {
    const state = this.states.get(jobId);
    if (!state || state.command.nonce !== nonce || state.phase === "finished") return;
    state.cancelled = true;
    this.save(state);
    // Preparation refuses before it would spawn. A recovery in flight is not interrupted; the
    // job finishes once it settles.
    if (state.phase === "prepared" || state.phase === "launching") return;
    this.signalGroup(state, "SIGTERM");
    this.poll(state);
  }

  /** Stop polling (runner shutdown). Running reviews continue and are recovered on restart. */
  close(): void {
    for (const timer of this.polling.values()) clearTimeout(timer);
    this.polling.clear();
  }
}
