/**
 * Trust checks for programs the runner runs on a session's behalf outside every sandbox (#3306,
 * #561): cross-model review controllers, reviewer CLIs, git, gh and ssh.
 *
 * A program is trusted only when no other user, and no session, could have changed it. Each path
 * is resolved one symlink at a time, and refused when the path or any directory holding a link on
 * the way is owned by another user, writable by other users, or inside any root a session can
 * write (provider credential homes, including configured account and per-session ones, shared
 * caches, temporary directories, project checkouts, worktrees and runner state). A session could
 * otherwise plant or repoint a binary the runner then runs unsandboxed.
 */
import { closeSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import {
  resolveAgentEnvironmentValue, type RunnerConfigAgent, type RunnerConfigWorkspace, type RunnerProviderAccount,
} from "./config.js";
import type { SessionMeta } from "./session-store.js";
import { isUserPrivateGroup } from "./review-private-group.js";

/** Home-relative caches a protected session can write (mirrors execution-isolation's list). */
const SESSION_WRITABLE_CACHE_PATHS = [
  ".cache", ".npm", ".cargo/registry", ".cargo/git", ".local/share/pnpm/store", "go/pkg/mod",
] as const;
/** Temporary directories every session can write. */
const SESSION_WRITABLE_TEMPORARY_ROOTS = ["/tmp", "/var/tmp", "/dev/shm"] as const;

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

export interface CodexReviewerProtection {
  /** Only the conventional native install gets an exception. */
  home: string;
  /** Launch-time sandbox rules, rather than live writer evidence, protect this installation. */
}

/** Check the write boundary and ownership of every component, retaining both for the exception. */
function checkResolved(real: string, roots: readonly string[], uid: number, rootUid: number,
  codex: CodexReviewerProtection | undefined, privateGroup: (uid: number, gid: number) => boolean): void {
  for (const root of roots) {
    if (!within(root, real)) continue;
    const codexHome = codex && join(codex.home, ".codex");
    // Broader writable roots (HOME, a checkout, /tmp, an account parent) never get an
    // exception. The symlink walker checks every link's containing directory too.
    if (codex && codexHome === root && within(join(codexHome, "packages", "standalone"), real)) {
      continue;
    }
    throw new Error(`${real} is inside a directory a session can write (${root})`);
  }
  const components: string[] = [];
  for (let current = real; ; current = join(current, "..")) {
    components.push(current);
    if (current === "/" || current === join(current, "..")) break;
  }
  const ordered = components.reverse();
  for (const [index, component] of ordered.entries()) {
    const info = lstatSync(component);
    if (info.uid !== uid && info.uid !== rootUid) throw new Error(`${component} is owned by another user`);
    // A sticky directory (like /tmp, mode 1777) cannot have entries it does not own replaced by
    // anyone, its group included, so it is a safe ancestor; the path itself never may be writable.
    const stickyAncestor = info.isDirectory() && (info.mode & 0o1000) !== 0 && index < ordered.length - 1;
    if ((info.mode & 0o002) && !stickyAncestor) throw new Error(`${component} is writable by every user`);
    if ((info.mode & 0o020) && !stickyAncestor) {
      let safe = false;
      try { safe = info.uid === uid && privateGroup(uid, info.gid); }
      catch (error) { throw new Error(`${component} is writable by its group: ${(error as Error).message}`); }
      if (!safe) throw new Error(`${component} is writable by its group`);
    }
  }
}

/**
 * Resolve `path` and refuse it unless no other user, and no session, could have changed it.
 * Links are followed one at a time: each must be owned by `uid` or root and sit in a directory that
 * passes the same checks, so no hop on the way can be repointed. Group-write is accepted only
 * for a proven user-private group, even below a private ancestor.
 */
export function trustedPath(path: string, roots: readonly string[], uid: number, rootUid = 0,
  codex?: CodexReviewerProtection, privateGroup: (uid: number, gid: number) => boolean = isUserPrivateGroup): string {
  const groups = new Map<number, boolean>();
  const checkGroup = (owner: number, gid: number) => {
    if (!groups.has(gid)) groups.set(gid, privateGroup(owner, gid));
    return groups.get(gid)!;
  };
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
    checkResolved(resolved, roots, uid, rootUid, codex, checkGroup);
    const target = readlinkSync(next);
    if (isAbsolute(target)) resolved = "/";
    pending.unshift(...target.split("/").filter(Boolean));
  }
  checkResolved(resolved, roots, uid, rootUid, codex, checkGroup);
  return resolved;
}

/** Provider home variables a session's environment can point at a writable directory. */
const PROVIDER_HOME_VARIABLES = ["CODEX_HOME", "CLAUDE_CONFIG_DIR"] as const;

/** Where the runner's configuration and its sessions say provider state lives. */
export interface SessionWritableSources {
  workspaces?: ReadonlyArray<Pick<RunnerConfigWorkspace, "path" | "additionalDirectoryGrants" | "sharedWritableDirectories">>;
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
  for (const workspace of sources.workspaces ?? []) paths.push(workspace.path, ...(workspace.additionalDirectoryGrants ?? []),
    ...(workspace.sharedWritableDirectories ?? []));
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
export function trustedExecutable(name: string, pathEnv: string | undefined, roots: readonly string[], uid: number,
  rootUid?: number, codex?: CodexReviewerProtection): string {
  let refusal: string | undefined;
  for (const dir of (pathEnv ?? "").split(":")) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try {
      const info = statSync(candidate);
      if (!info.isFile() || !(info.mode & 0o111)) continue;
    } catch { continue; }
    try { return trustedPath(candidate, roots, uid, rootUid, codex); }
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
export function reviewerInterpreter(
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

/** Installation homes to protect in every native session, regardless of its harness. */
export function configuredCodexHomes(home: string, sources: SessionWritableSources): string[] {
  const homes = new Set([join(home, ".codex")]);
  const environment = (read: (name: string) => string | undefined) => {
    const explicit = read("CODEX_HOME");
    if (explicit && isAbsolute(explicit)) homes.add(explicit);
    const osHome = read("HOME");
    if (osHome && isAbsolute(osHome)) homes.add(join(osHome, ".codex"));
  };
  environment((name) => sources.hostEnv?.[name]);
  for (const agent of sources.agents ?? []) environment((name) => {
    try { return resolveAgentEnvironmentValue(agent, name, sources.hostEnv ?? {}); } catch { return undefined; }
  });
  // An account root can be selected as CODEX_HOME independently of its current binding.
  for (const account of sources.providerAccounts ?? []) homes.add(account.directory);
  for (const session of sources.sessions ?? []) {
    environment((name) => session.env?.[name]);
    for (const root of [session.providerCredentialHome, session.providerConversationHome, session.pendingProviderCredentialHome]) {
      if (root && isAbsolute(root)) homes.add(root);
    }
  }
  return [...homes];
}

/** The verified git, gh and optional ssh used outside every sandbox. */
export interface ReviewTools {
  git: string;
  gh: string;
  /** Without a trusted ssh, mirror fetches use HTTPS only. */
  ssh?: string;
}

export interface ReviewToolEnvironment {
  home: string;
  dataDir: string;
  uid: number;
  /** The uid root-owned files show; 0 except inside a user namespace (tests). */
  rootUid?: number;
  pathEnv: string | undefined;
  /** Further session-writable roots (see `configuredSessionWritablePaths`). */
  extraRoots?: readonly string[];
  /** Session-writable temporary directories; defaults to the system's. */
  temporaryRoots?: readonly string[];
}

/** Find and verify git, gh and ssh. Never throws: a refusal is returned as its reason. */
export function discoverReviewTools(env: ReviewToolEnvironment): ReviewTools | { unavailable: string } {
  try {
    const roots = sessionWritableRoots(env.home, env.dataDir, env.extraRoots, env.temporaryRoots);
    const git = trustedExecutable("git", env.pathEnv, roots, env.uid, env.rootUid);
    const gh = trustedExecutable("gh", env.pathEnv, roots, env.uid, env.rootUid);
    let ssh: string | undefined;
    try { ssh = trustedExecutable("ssh", env.pathEnv, roots, env.uid, env.rootUid); } catch { ssh = undefined; }
    return { git, gh, ...(ssh ? { ssh } : {}) };
  } catch (error) {
    return { unavailable: (error as Error).message };
  }
}
