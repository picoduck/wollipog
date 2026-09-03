/** Context-native, externally stored per-session git worktrees. */

import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { mkdir, rm, statfs } from "node:fs/promises";
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { AgentContext } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";
import {
  captureWorktreeTree,
  isMissingGitRepositoryError,
  restoreWorktreeToTree,
  withGitExecutionContext,
} from "./git-ops.js";
import { canIgnoreRunnerDataDirDirectorySyncError } from "./runner-data-dir.js";

const MIN_FREE_BYTES = 512 * 1024 * 1024;
const nativeContext: AgentContext = { kind: "native" };
type StatfsResult = Awaited<ReturnType<typeof statfs>>;
let statfsRunner: (path: string) => Promise<StatfsResult> = statfs;

/** A native cleanup target that cannot be a repository is terminal. A present non-directory path
 * is conclusive. ENOENT/ENOTDIR is conclusive only while its immediate parent is reachable: UNC
 * shares, mapped drives, and mounted filesystems can report those codes while their root is
 * transiently offline. Ambiguous roots and all other filesystem failures remain retryable. */
export function nativeRepositoryPathIsUnavailable(context: AgentContext, repoPath: string): boolean {
  if (context.kind !== "native") return false;
  try {
    return !statSync(repoPath).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return false;
    const parent = dirname(repoPath);
    if (parent === repoPath) return false;
    try {
      // A reachable parent proves the final path is absent or unusable. If the parent itself is a
      // regular file, the original ENOTDIR is equally terminal. Do not walk beyond this boundary:
      // an accessible local ancestor (for example C:\ or /mnt) does not prove its child share is
      // currently reachable.
      statSync(parent);
      return true;
    } catch {
      return false;
    }
  }
}

export function setStatfsForTests(runner?: (path: string) => Promise<StatfsResult>): void {
  statfsRunner = runner ?? statfs;
}

export interface WorktreeOptions {
  context?: AgentContext;
  /** Runner data directory. Native worktrees live below `<dataDir>/worktrees`. */
  dataDir?: string;
  /** Stable attested owner for WSL paths and repository-global branch names. */
  ownerHash?: string;
  /** Cleanup-only compatibility boundary for a persisted pre-attestation WSL worktree path. */
  legacyWslRoot?: boolean;
  /** Persisted pre-attestation WSL worktree. Creation may reuse this exact registered path, but
   * must never silently replace or abandon it. */
  legacyWslWorktreePath?: string;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  /** True only when this create call materialized the linked worktree. A healthy registered
   * worktree is returned with false so a losing launch cannot reap durable user changes. */
  created?: boolean;
}

/** A session-requested worktree keeps its user-selected Git identity instead of deriving either
 * coordinate from the session id. `baseRef` is the exact caller-selected ref used at creation;
 * `baseCommit` makes the result stable and auditable even when that ref moves later. */
export interface SessionWorktreeHandle extends WorktreeHandle {
  baseRef: string;
  baseCommit: string;
  attached: boolean;
}

export interface RequestedWorktreeOptions extends WorktreeOptions {
  /** Exact configured Project Location roots. Existing worktrees may only be attached from one of
   * these roots (or from the runner-owned worktree root). */
  allowedProjectPaths?: string[];
}

export interface WorktreeCleanupRecord {
  sessionId: string;
  /** Stable per-worktree identity. Absent records are the singular legacy session worktree. */
  worktreeId?: string;
  repoPath: string;
  worktreePath: string;
  context: AgentContext;
  /** Exact branch recorded when this generation was created or attached. Legacy records derive
   * `agent/<sessionId>` during cleanup. */
  branch?: string;
  /** Exact checkpoint namespace owned by this worktree generation. Absent means legacy refs. */
  checkpointOwnerHash?: string;
}

/** Native-host cleanup journal. Session rows can be deleted immediately while failed context
 * cleanup remains durable and is retried on the next runner start. */
export class WorktreeCleanupJournal {
  private readonly path: string;
  private records = new Map<string, WorktreeCleanupRecord>();

  constructor(dataDir = join(homedir(), ".agent-manager")) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "worktree-cleanup.json");
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as WorktreeCleanupRecord[];
      if (Array.isArray(parsed)) for (const record of parsed) this.records.set(this.key(record), record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`could not read worktree cleanup journal ${this.path}: ${(error as Error).message}`);
      }
    }
  }

  list(): WorktreeCleanupRecord[] { return [...this.records.values()]; }

  add(record: WorktreeCleanupRecord): void {
    this.records.set(this.key(record), record);
    this.flush();
  }

  remove(sessionId: string, worktreeId?: string): void {
    let removed = false;
    if (worktreeId !== undefined) {
      removed = this.records.delete(`${sessionId}\0${worktreeId}`);
    } else {
      for (const [key, record] of this.records) {
        if (record.sessionId !== sessionId) continue;
        this.records.delete(key);
        removed = true;
      }
    }
    if (!removed) return;
    this.flush();
  }

  private key(record: WorktreeCleanupRecord): string {
    return `${record.sessionId}\0${record.worktreeId ?? "legacy"}`;
  }

  private flush(): void {
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(this.list(), null, 2));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.path);
      let directoryFd: number | undefined;
      try {
        directoryFd = openSync(dirname(this.path), constants.O_RDONLY);
        fsyncSync(directoryFd);
      } catch (error) {
        if (!canIgnoreRunnerDataDirDirectorySyncError(error as NodeJS.ErrnoException)) throw error;
      } finally {
        if (directoryFd !== undefined) closeSync(directoryFd);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temp, { force: true });
    }
  }
}

function repoKey(repoPath: string): string {
  const name = repoPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9._-]/g, "-") || "repo";
  return `${name}-${createHash("sha256").update(repoPath).digest("hex").slice(0, 12)}`;
}

async function command(context: AgentContext, cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return (await runContextCommand(context, "git", args, { cwd, timeoutMs })).stdout;
}

async function wslHome(context: Extract<AgentContext, { kind: "wsl" }>): Promise<string> {
  const result = await runContextCommand(context, "sh", ["-c", 'printf "%s" "$HOME"'], { cwd: "/", timeoutMs: 8_000 });
  const home = result.stdout.trim();
  if (!home.startsWith("/")) throw new Error(`could not resolve HOME inside WSL distro ${context.distro}`);
  return home;
}

/** Resolve/create the external root without a capacity gate (cleanup must work on a full disk). */
async function worktreeRootPath(options: WorktreeOptions = {}): Promise<string> {
  const context = options.context ?? nativeContext;
  if (context.kind === "wsl") {
    if (options.legacyWslRoot) {
      const root = `${await wslHome(context)}/.agent-manager/worktrees`;
      await runContextCommand(context, "mkdir", ["-p", "--", root], { cwd: "/", timeoutMs: 8_000 });
      return root;
    }
    if (!options.ownerHash || !/^[a-f0-9]{64}$/u.test(options.ownerHash)) {
      throw new Error("WSL worktrees require a valid attested runner owner hash");
    }
    const root = `${await wslHome(context)}/.agent-manager/runner-instances/${options.ownerHash}/worktrees`;
    await runContextCommand(context, "mkdir", ["-p", "--", root], { cwd: "/", timeoutMs: 8_000 });
    return root;
  }
  const root = join(options.dataDir ?? join(homedir(), ".agent-manager"), "worktrees");
  await mkdir(root, { recursive: true });
  return root;
}

/** Resolve and capacity-preflight the external worktree root before creation. */
export async function resolveWorktreeRoot(options: WorktreeOptions = {}): Promise<string> {
  const context = options.context ?? nativeContext;
  const root = await worktreeRootPath(options);
  if (context.kind === "wsl") {
    const disk = await runContextCommand(context, "df", ["-Pk", root], { cwd: "/", timeoutMs: 8_000 });
    const fields = disk.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
    const available = Number(fields[3]) * 1024;
    if (Number.isFinite(available) && available < MIN_FREE_BYTES) {
      throw new Error(`worktree storage has only ${Math.floor(available / 1024 / 1024)} MiB free (512 MiB required)`);
    }
    return root;
  }
  const disk = await statfsRunner(root);
  const available = Number(disk.bavail) * Number(disk.bsize);
  if (available < MIN_FREE_BYTES) {
    throw new Error(`worktree storage has only ${Math.floor(available / 1024 / 1024)} MiB free (512 MiB required)`);
  }
  return root;
}

async function sessionPath(
  repoPath: string,
  sessionId: string,
  options: WorktreeOptions,
  capacityPreflight = true,
): Promise<string> {
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new Error("session id is not safe for a worktree path/branch");
  }
  const root = capacityPreflight ? await resolveWorktreeRoot(options) : await worktreeRootPath(options);
  const context = options.context ?? nativeContext;
  const parent = context.kind === "wsl" ? `${root}/${repoKey(repoPath)}` : join(root, repoKey(repoPath));
  if (capacityPreflight) {
    if (context.kind === "wsl") await runContextCommand(context, "mkdir", ["-p", "--", parent], { cwd: "/", timeoutMs: 8_000 });
    else await mkdir(parent, { recursive: true });
  }
  return context.kind === "wsl" ? `${parent}/${sessionId}` : join(parent, sessionId);
}

function requestedSlot(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** Stable session-private directory used by platform isolation before a requested worktree exists.
 * Binding this directory writable is narrower than exposing the runner's shared worktree root. */
export async function requestedWorktreeBoundary(
  repoPath: string,
  sessionId: string,
  options: WorktreeOptions = {},
  capacityPreflight = true,
): Promise<string> {
  const context = options.context ?? nativeContext;
  const root = capacityPreflight ? await resolveWorktreeRoot(options) : await worktreeRootPath(options);
  const parent = context.kind === "wsl" ? `${root}/${repoKey(repoPath)}` : join(root, repoKey(repoPath));
  const boundary = context.kind === "wsl"
    ? `${parent}/${sessionId}.requested`
    : join(parent, `${sessionId}.requested`);
  if (context.kind === "wsl") {
    await runContextCommand(context, "mkdir", ["-p", "--", boundary], { cwd: "/", timeoutMs: 8_000 });
  } else {
    await mkdir(boundary, { recursive: true });
  }
  return boundary;
}

function safeGitArgument(value: string, label: string): string {
  if (!value || value.startsWith("-") || /[\0\r\n]/u.test(value)) {
    throw new Error(`${label} is not a safe Git argument`);
  }
  return value;
}

async function validateBranch(context: AgentContext, repoPath: string, branch: string): Promise<string> {
  safeGitArgument(branch, "worktree branch");
  const validated = (await command(context, repoPath, ["check-ref-format", "--branch", branch])).trim();
  if (validated !== branch) throw new Error("worktree branch did not round-trip through Git validation");
  return branch;
}

/** Create a distinct session-owned worktree from an explicit ref without consulting the primary
 * checkout's HEAD. The branch is created, never reset: a pre-existing branch fails closed instead
 * of moving an unrelated ref. */
export async function createRequestedWorktree(
  repoPath: string,
  sessionId: string,
  request: { baseRef: string; branch: string },
  options: RequestedWorktreeOptions = {},
): Promise<SessionWorktreeHandle> {
  const context = options.context ?? nativeContext;
  const baseRef = safeGitArgument(request.baseRef, "worktree base ref");
  const branch = await validateBranch(context, repoPath, request.branch);
  const baseCommit = (await command(
    context,
    repoPath,
    ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
  )).trim();
  if (!/^[a-f0-9]{40,64}$/u.test(baseCommit)) throw new Error("worktree base did not resolve to a commit");
  const boundary = await requestedWorktreeBoundary(repoPath, sessionId, options);
  const path = context.kind === "wsl"
    ? `${boundary}/${requestedSlot(branch)}`
    : join(boundary, requestedSlot(branch));
  const listed = await command(context, repoPath, ["worktree", "list", "--porcelain", "-z"]);
  const matching = parseWorktreePorcelain(listed).find((entry) => sameContextPath(context, entry.path, path));
  if (matching) {
    if (matching.branch === branch) {
      return { path, branch, baseRef, baseCommit, attached: false, created: false };
    }
    throw new Error("requested worktree slot is already registered with different Git coordinates");
  }
  await removeExternalDirectory(context, path, options);
  await command(context, repoPath, ["worktree", "add", "-b", branch, path, baseCommit], 120_000);
  return { path, branch, baseRef, baseCommit, attached: false, created: true };
}

/** Resolve and fetch the remote's advertised default branch. No primary-checkout HEAD or current
 * branch participates in the result. */
export async function fetchRemoteDefaultBase(
  repoPath: string,
  options: WorktreeOptions = {},
  remote = "origin",
): Promise<string> {
  const context = options.context ?? nativeContext;
  safeGitArgument(remote, "Git remote");
  const advertised = await command(context, repoPath, ["ls-remote", "--symref", remote, "HEAD"], 120_000);
  const headRef = advertised.split("\n")
    .map((line) => /^ref:\s+(refs\/heads\/[^\s]+)\s+HEAD$/u.exec(line)?.[1])
    .find((value): value is string => !!value);
  if (!headRef) throw new Error(`remote ${remote} did not advertise a default branch`);
  const branch = headRef.slice("refs/heads/".length);
  safeGitArgument(branch, "remote default branch");
  const trackingRef = `refs/remotes/${remote}/${branch}`;
  await command(context, repoPath, ["fetch", "--no-tags", remote, `+${headRef}:${trackingRef}`], 120_000);
  return `${remote}/${branch}`;
}

interface ListedWorktree { path: string; head: string; branch: string | null }

function parseWorktreePorcelain(value: string): ListedWorktree[] {
  return value.split("\0\0").flatMap((block) => {
    const fields = block.split("\0");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    const head = fields.find((field) => field.startsWith("HEAD "))?.slice(5);
    const branchRef = fields.find((field) => field.startsWith("branch "))?.slice(7);
    if (!path || !head) return [];
    return [{ path, head, branch: branchRef?.startsWith("refs/heads/") ? branchRef.slice(11) : null }];
  });
}

function pathWithin(context: AgentContext, candidate: string, root: string): boolean {
  if (sameContextPath(context, candidate, root)) return true;
  if (context.kind === "wsl") return candidate.startsWith(root.replace(/\/$/u, "") + "/");
  const normalizedCandidate = resolve(candidate).replace(/\\/gu, "/");
  const normalizedRoot = resolve(root).replace(/\\/gu, "/");
  const insensitive = process.platform === "win32";
  return (insensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate)
    .startsWith((insensitive ? normalizedRoot.toLowerCase() : normalizedRoot) + "/");
}

/** Attach only a Git-registered linked worktree from the same repository and an operator-configured
 * location boundary. Merely existing on disk is insufficient. */
export async function attachRequestedWorktree(
  repoPath: string,
  sessionId: string,
  requestedPath: string,
  options: RequestedWorktreeOptions = {},
): Promise<SessionWorktreeHandle> {
  const context = options.context ?? nativeContext;
  const path = safeGitArgument(requestedPath, "worktree path");
  const runnerBoundary = await requestedWorktreeBoundary(repoPath, sessionId, options, false);
  const allowed = [runnerBoundary, ...(options.allowedProjectPaths ?? [])];
  if (!allowed.some((root) => pathWithin(context, path, root))) {
    throw new Error("worktree path is outside the runner's configured Project Locations");
  }
  const listed = parseWorktreePorcelain(await command(context, repoPath, ["worktree", "list", "--porcelain", "-z"]));
  const match = listed.find((entry) => sameContextPath(context, entry.path, path));
  if (!match) throw new Error("worktree path is not registered with the session repository");
  if (!match.branch) throw new Error("a detached worktree cannot be attached to a session");
  const healthy = (await command(context, match.path, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  if (!healthy) throw new Error("registered worktree is not healthy");
  return {
    path: match.path,
    branch: match.branch,
    baseRef: match.head,
    baseCommit: match.head,
    attached: true,
    created: false,
  };
}

/** True if `repoPath` is inside a git work tree in the requested context. */
export async function isGitRepo(repoPath: string, options: WorktreeOptions = {}): Promise<boolean> {
  try {
    return (await command(options.context ?? nativeContext, repoPath, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch (error) {
    const detail = `${(error as { stderr?: string }).stderr ?? ""}\n${(error as Error).message}`;
    if (/not a git repository/i.test(detail)) return false;
    throw new Error(`git preflight failed in the selected runner context: ${(error as Error).message}`);
  }
}

/** Reuse a persisted pre-attestation WSL worktree only when its exact expected path remains
 * registered and healthy. Kept independent from WSL command execution so every fail-closed
 * decision is covered on all CI hosts. */
export async function reuseRegisteredLegacyWslWorktree(
  persistedPath: string,
  expectedPath: string,
  sessionId: string,
  porcelain: string,
  isHealthy: () => Promise<boolean>,
): Promise<WorktreeHandle> {
  if (persistedPath.replace(/\/$/u, "") !== expectedPath.replace(/\/$/u, "")) {
    throw new Error("persisted WSL worktree is outside the expected legacy session path");
  }
  const registered = porcelain
    .split(/\n\s*\n/u)
    .map((block) => block.split("\n").find((line) => line.startsWith("worktree "))?.slice(9).trim())
    .filter((candidate): candidate is string => !!candidate)
    .some((candidate) => candidate.replace(/\/$/u, "") === expectedPath.replace(/\/$/u, ""));
  if (!registered) {
    throw new Error("persisted legacy WSL worktree is no longer registered; recover it manually before restarting this session");
  }
  try {
    if (await isHealthy()) {
      return { path: expectedPath, branch: `agent/${sessionId}`, created: false };
    }
  } catch {
    // Fail closed below so user changes are never replaced.
  }
  throw new Error("persisted legacy WSL worktree is not healthy; recover it manually before restarting this session");
}

export async function createWorktree(repoPath: string, sessionId: string, options: WorktreeOptions = {}): Promise<WorktreeHandle> {
  const context = options.context ?? nativeContext;
  const branch = context.kind === "wsl" && options.ownerHash
    ? `agent/${options.ownerHash.slice(0, 16)}/${sessionId}`
    : `agent/${sessionId}`;
  const listed = await command(context, repoPath, ["worktree", "list", "--porcelain"]);
  if (context.kind === "wsl" && options.legacyWslWorktreePath) {
    // Reusing an already registered worktree neither allocates storage nor needs the new owner's
    // root. Avoid rejecting recovery solely because creation capacity is currently unavailable.
    const legacyPath = await sessionPath(repoPath, sessionId, { ...options, legacyWslRoot: true }, false);
    return reuseRegisteredLegacyWslWorktree(
      options.legacyWslWorktreePath, legacyPath, sessionId, listed,
      async () => (await command(context, legacyPath, ["rev-parse", "--is-inside-work-tree"])).trim() === "true",
    );
  }
  const path = await sessionPath(repoPath, sessionId, options);
  const registered = listed
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").find((line) => line.startsWith("worktree "))?.slice(9).trim())
    .filter((candidate): candidate is string => !!candidate)
    .some((candidate) => sameContextPath(context, candidate, path));
  if (registered) {
    try {
      if ((await command(context, path, ["rev-parse", "--is-inside-work-tree"])).trim() === "true") {
        return { path, branch, created: false };
      }
    } catch { /* stale registration: remove below */ }
    await command(context, repoPath, ["worktree", "remove", "--force", path], 120_000).catch(() => {});
    await command(context, repoPath, ["worktree", "prune"]).catch(() => {});
  } else {
    // A crash can leave an unregistered directory at the deterministic path. It is owned by this
    // exact session root, so clear it before `git worktree add` rather than failing every restart.
    await removeExternalDirectory(context, path, options);
  }
  await command(context, repoPath, ["worktree", "add", "-B", branch, path, "HEAD"], 120_000);
  return { path, branch, created: true };
}

function sameContextPath(context: AgentContext, left: string, right: string): boolean {
  if (context.kind === "wsl") return left.replace(/\/$/, "") === right.replace(/\/$/, "");
  const normalize = (value: string) => {
    const normalized = resolve(value).replace(/\\/g, "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

export async function createWorktreeFromTree(
  repoPath: string,
  sessionId: string,
  tree: string,
  baseRef: string,
  options: WorktreeOptions = {},
): Promise<WorktreeHandle> {
  const context = options.context ?? nativeContext;
  const path = await sessionPath(repoPath, sessionId, options);
  const branch = context.kind === "wsl" && options.ownerHash
    ? `agent/${options.ownerHash.slice(0, 16)}/${sessionId}`
    : `agent/${sessionId}`;
  await command(context, repoPath, ["worktree", "add", "-B", branch, path, baseRef], 120_000);
  const handle = { path, branch, created: true };
  try {
    await withGitExecutionContext(context, () => restoreWorktreeToTree(path, tree));
    return handle;
  } catch (error) {
    await removeWorktree(repoPath, handle, options);
    throw error;
  }
}

export async function worktreeHead(worktreePath: string, options: WorktreeOptions = {}): Promise<string> {
  return (await command(options.context ?? nativeContext, worktreePath, ["rev-parse", "HEAD"])).trim();
}

/** Remove the linked worktree, its branch, and stale administrative records. */
export async function removeWorktree(repoPath: string, handle: WorktreeHandle, options: WorktreeOptions = {}): Promise<void> {
  const context = options.context ?? nativeContext;
  const failures: string[] = [];
  let repositoryUnavailable = false;
  try {
    await command(context, repoPath, ["worktree", "remove", "--force", handle.path], 120_000);
  } catch (error) {
    repositoryUnavailable = nativeRepositoryPathIsUnavailable(context, repoPath) ||
      isMissingGitRepositoryError(error);
    // A crash can remove the directory before metadata/admin cleanup. Prune, then accept the
    // desired end state when git no longer lists the path; cleanup must be safely retryable.
    if (repositoryUnavailable) {
      try { await removeExternalDirectory(context, handle.path, options); }
      catch (removeError) { failures.push(`external remove: ${(removeError as Error).message}`); }
    } else {
      await command(context, repoPath, ["worktree", "prune"]).catch(() => {});
      try {
        const listed = await command(context, repoPath, ["worktree", "list", "--porcelain"]);
        const paths = listed.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9).trim());
        if (paths.includes(handle.path)) failures.push(`remove: ${(error as Error).message}`);
        else await removeExternalDirectory(context, handle.path, options);
      } catch (verifyError) {
        try { await removeExternalDirectory(context, handle.path, options); }
        catch { failures.push(`remove verification: ${(verifyError as Error).message}`); }
      }
    }
  }
  if (!repositoryUnavailable) {
    try { await command(context, repoPath, ["branch", "-D", handle.branch]); }
    catch { /* branch may already be absent */ }
    try { await command(context, repoPath, ["worktree", "prune"]); }
    catch (error) { failures.push(`prune: ${(error as Error).message}`); }
  }
  if (failures.length) throw new Error(`worktree cleanup incomplete (${failures.join("; ")})`);
}

async function removeExternalDirectory(context: AgentContext, path: string, options: WorktreeOptions): Promise<void> {
  const root = await worktreeRootPath(options);
  if (context.kind === "wsl") {
    const prefix = root.replace(/\/$/, "") + "/";
    if (!path.startsWith(prefix) || path === root) throw new Error("refusing to remove a path outside the WSL worktree root");
    await runContextCommand(context, "rm", ["-rf", "--", path], { cwd: "/", timeoutMs: 120_000 });
    return;
  }
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  if (!absolutePath.startsWith(absoluteRoot + sep) || absolutePath === absoluteRoot) {
    throw new Error("refusing to remove a path outside the native worktree root");
  }
  await rm(absolutePath, { recursive: true, force: true });
}

export async function worktreeDiff(worktreePath: string, options: WorktreeOptions = {}): Promise<string> {
  const context = options.context ?? nativeContext;
  try {
    const tree = await withGitExecutionContext(context, () => captureWorktreeTree(worktreePath));
    return await command(context, worktreePath, ["diff", "HEAD", tree, "--"]);
  } catch {
    return "";
  }
}

export async function captureTurnDiff(
  worktreePath: string,
  baseTree: string,
  options: WorktreeOptions = {},
): Promise<{ diff: string; tree: string } | null> {
  const context = options.context ?? nativeContext;
  try {
    const tree = await withGitExecutionContext(context, () => captureWorktreeTree(worktreePath));
    return { diff: await command(context, worktreePath, ["diff", baseTree, tree, "--"]), tree };
  } catch {
    return null;
  }
}
