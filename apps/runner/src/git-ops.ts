/**
 * Git/PR operations on a session worktree. Runs `git`/`gh` in the session's native
 * host or selected WSL distro via an async-scoped execution context.
 *
 * The pure parsers (parsePorcelain / githubSlug / pickPrUrl) are exported and unit-
 * tested; the exec-backed functions are verified end-to-end against the running stack
 * (a throwaway repo + worktree session). Child processes are time-bounded so a hung
 * git/gh can't wedge a request.
 */

import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, openSync, readSync, closeSync, rmSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  GitAction,
  GitActionData,
  GitChecksSummary,
  GitCommitInfo,
  GitDiffFile,
  GitDiffInfo,
  GitDiffLine,
  GitDiffScope,
  GitDiffStats,
  GitErrorCode,
  GitFileChange,
  GitHunk,
  GitHubReviewSyncInfo,
  GitHubReviewThread,
  GitPrInfo,
  GitPrSummary,
  GitRepositoryFacts,
  GitStatusInfo,
  GitSummaryInfo,
  AgentContext,
} from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";

/** A git-action failure the UI reacts to by code (stale diff / index conflict → refetch). */
export class GitOpError extends Error {
  constructor(
    message: string,
    readonly code: GitErrorCode,
  ) {
    super(message);
  }
}

/** Per-session context a git action runs with, resolved from the box store's meta.json. */
export interface GitActionContext {
  /** Session kind — gates the linked-worktree assertion + branch-relative scopes. */
  useWorktree: boolean;
  /** Turn-start snapshot tree sha from box meta.json. undefined = never captured; null = capture failed. */
  lastTurnBaseTree?: string | null;
  /** Native host or a named WSL distro. Omitted by old callers/tests means native. */
  context?: AgentContext;
}

// Bound child processes so a hung credential prompt, pre-push hook, or stuck
// `gh pr create` can't wedge a request forever (the control plane gives up too,
// but without a kill the child could still push/PR later).
const GIT_TIMEOUT_MS = 30_000;
const GH_TIMEOUT_MS = 45_000;
const GH_REVIEW_MAX_BUFFER = 8 * 1024 * 1024;
const GH_REVIEW_PAGE_SIZE = 100;
const GH_REVIEW_MAX_PAGES = 5;
const GH_REVIEW_BODY_MAX = 4_000;

const GH_REVIEW_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      headRefOid baseRefOid
      reviewThreads(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          id isResolved isOutdated subjectType path line originalLine diffSide
          comments(first:100){
            nodes{databaseId body url createdAt updatedAt author{login} commit{oid} originalCommit{oid} replyTo{databaseId}}
          }
        }
      }
    }
  }
}`;

/** Per-invocation extras a git call may need beyond cwd+argv. */
export interface GitRunOpts {
  /** Extra env merged over process.env (temp-index snapshots: GIT_INDEX_FILE=<tmp>). */
  env?: Record<string, string>;
  /** Text piped to git's stdin, then stdin is closed (per-hunk staging: the patch for `git apply … -`). */
  stdin?: string;
  /** Override the default 30s guard. The guard exists for credential prompts/hooks; purely local
   * commands (worktree snapshots on big repos) can legitimately need longer. */
  timeoutMs?: number;
}

/**
 * All `git` invocations go through this indirection. Production runs the real, time-bounded
 * `execFile("git", …)`; tests can swap it (via `setGitRunnerForTests`) to assert exact argv and
 * simulate ref-existence for the merge-base fallback — Node's plain test runner can't redefine the
 * non-configurable `child_process.execFile` export, so a seam here is the reliable way to mock it.
 * A rejecting runner mimics a non-zero git exit; the string it resolves is treated as stdout.
 * Two-arg test fakes remain assignable — `opts` only matters to calls that pass it.
 */
type GitRunner = (cwd: string, args: string[], opts?: GitRunOpts) => Promise<string>;

// Callback-form execFile (not promisify) because stdin needs the child handle. The rejection
// keeps promisify's shape (err.stdout/err.stderr attached) — stage errors read err.stderr.
const executionContext = new AsyncLocalStorage<AgentContext>();

/** Scope git/gh operations to a session context without leaking it across concurrent sessions. */
export function withGitExecutionContext<T>(context: AgentContext, fn: () => Promise<T>): Promise<T> {
  return executionContext.run(context, fn);
}

const realGitRunner: GitRunner = (cwd, args, opts) => {
  const context = executionContext.getStore() ?? { kind: "native" as const };
  if (context.kind === "wsl") {
    return runContextCommand(context, "git", args, {
      cwd,
      env: opts?.env,
      stdin: opts?.stdin,
      timeoutMs: opts?.timeoutMs ?? GIT_TIMEOUT_MS,
    }).then((result) => result.stdout);
  }
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: opts?.timeoutMs ?? GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
        env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      },
      (err, stdout, stderr) => (err ? reject(Object.assign(err as Error, { stdout, stderr })) : resolve(stdout)),
    );
    if (child.stdin) {
      // EPIPE guard: if git exits before the write lands, the callback's err carries the real failure.
      child.stdin.on("error", () => {});
      child.stdin.end(opts?.stdin ?? "");
    }
  });
};

let gitRunner: GitRunner = realGitRunner;

/** Test-only: replace the git runner. Pass no argument to restore the real one. */
export function setGitRunnerForTests(runner?: GitRunner): void {
  gitRunner = runner ?? realGitRunner;
}

/** True only for Git failures that prove the requested repository is permanently unavailable.
 * Callers may treat these as an already-clean terminal state; permission, lock, timeout, and
 * transport failures deliberately remain retryable. */
export function isMissingGitRepositoryError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown; stderr?: unknown } | null;
  const detail = `${typeof candidate?.message === "string" ? candidate.message : ""}\n` +
    `${typeof candidate?.stderr === "string" ? candidate.stderr : ""}`;
  return /not a git repository|cannot change to [^\r\n]+(?:no such file or directory|system cannot find the path specified)/i
    .test(detail.slice(0, 4_096));
}

async function git(cwd: string, args: string[], opts?: GitRunOpts): Promise<string> {
  return gitRunner(cwd, args, opts);
}

/** git that swallows errors and returns "" — for best-effort reads. */
async function gitSoft(cwd: string, args: string[], opts?: GitRunOpts): Promise<string> {
  try {
    return await git(cwd, args, opts);
  } catch {
    return "";
  }
}

export interface GitPathMetadata {
  exists: boolean;
  mtimeMs: number | null;
}

type GitPathMetadataReader = (
  cwd: string,
  gitPath: string,
  context: AgentContext,
) => Promise<GitPathMetadata>;

/** Files returned by git rev-parse live inside the selected execution boundary. Native paths can
 * use Node stat; WSL paths must stay in WSL and use GNU stat. */
const realGitPathMetadataReader: GitPathMetadataReader = async (cwd, gitPath, context) => {
  try {
    if (context.kind === "wsl") {
      const { stdout } = await runContextCommand(context, "stat", ["-c", "%Y", "--", gitPath], {
        cwd,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      const seconds = stdout.trim();
      return /^\d+$/.test(seconds)
        ? { exists: true, mtimeMs: Number(seconds) * 1_000 }
        : { exists: true, mtimeMs: null };
    }
    const info = await stat(isAbsolute(gitPath) ? gitPath : resolve(cwd, gitPath));
    return { exists: true, mtimeMs: Number.isFinite(info.mtimeMs) ? Math.trunc(info.mtimeMs) : null };
  } catch {
    return { exists: false, mtimeMs: null };
  }
};

let gitPathMetadataReader: GitPathMetadataReader = realGitPathMetadataReader;

/** Test-only seam for native/WSL git metadata paths. Pass no argument to restore production. */
export function setGitPathMetadataReaderForTests(reader?: GitPathMetadataReader): void {
  gitPathMetadataReader = reader ?? realGitPathMetadataReader;
}

type RemoteRefsMetadataReader = (
  cwd: string,
  commonDir: string,
  context: AgentContext,
) => Promise<GitPathMetadata>;

const MAX_REMOTE_REF_FILES = 4_096;

function commonGitPath(
  cwd: string,
  commonDir: string,
  relativePath: string,
  context: AgentContext,
): string {
  if (context.kind === "wsl") {
    return commonDir.replace(/\/+$/, "") + "/" + relativePath;
  }
  const root = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  return join(root, ...relativePath.split("/"));
}

async function newestNativeRefMtime(root: string): Promise<GitPathMetadata> {
  let visited = 0;
  let newest: number | null = null;
  const visit = async (dir: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      return false;
    }
    for (const entry of entries) {
      if (++visited > MAX_REMOTE_REF_FILES) return false;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!await visit(path)) return false;
        continue;
      }
      try {
        const info = await stat(path);
        if (!Number.isFinite(info.mtimeMs)) return false;
        newest = Math.max(newest ?? 0, Math.trunc(info.mtimeMs));
      } catch {
        return false;
      }
    }
    return true;
  };
  return await visit(root)
    ? { exists: newest !== null, mtimeMs: newest }
    : { exists: true, mtimeMs: null };
}

/** Remote-tracking refs are repository-common even when status runs inside a linked worktree. */
const realRemoteRefsMetadataReader: RemoteRefsMetadataReader = async (cwd, commonDir, context) => {
  const refsDir = commonGitPath(cwd, commonDir, "refs/remotes", context);
  const packedRefs = commonGitPath(cwd, commonDir, "packed-refs", context);
  let loose: GitPathMetadata;
  if (context.kind === "wsl") {
    const directory = await gitPathMetadataReader(cwd, refsDir, context);
    if (!directory.exists) {
      loose = { exists: false, mtimeMs: null };
    } else {
      try {
        const { stdout } = await runContextCommand(
          context,
          "find",
          [refsDir, "-type", "f", "-printf", "%T@\n"],
          { cwd, timeoutMs: GIT_TIMEOUT_MS },
        );
        let newest: number | null = null;
        let count = 0;
        for (const line of stdout.split("\n").filter(Boolean)) {
          if (++count > MAX_REMOTE_REF_FILES) return { exists: true, mtimeMs: null };
          const seconds = Number(line.trim());
          if (!Number.isFinite(seconds) || seconds < 0) return { exists: true, mtimeMs: null };
          newest = Math.max(newest ?? 0, Math.trunc(seconds * 1_000));
        }
        loose = { exists: newest !== null, mtimeMs: newest };
      } catch {
        loose = { exists: true, mtimeMs: null };
      }
    }
  } else {
    loose = await newestNativeRefMtime(refsDir);
  }
  const packed = await gitPathMetadataReader(cwd, packedRefs, context);
  if ((loose.exists && loose.mtimeMs === null) || (packed.exists && packed.mtimeMs === null)) {
    return { exists: true, mtimeMs: null };
  }
  const timestamps = [loose.mtimeMs, packed.mtimeMs].filter((value): value is number => value !== null);
  return timestamps.length > 0
    ? { exists: true, mtimeMs: Math.max(...timestamps) }
    : { exists: false, mtimeMs: null };
};

let remoteRefsMetadataReader: RemoteRefsMetadataReader = realRemoteRefsMetadataReader;

/** Test-only seam for repository-common remote-ref metadata. */
export function setRemoteRefsMetadataReaderForTests(reader?: RemoteRefsMetadataReader): void {
  remoteRefsMetadataReader = reader ?? realRemoteRefsMetadataReader;
}

/** The snapshot's git steps are purely local (no credential prompts/hooks), so they may run
 * longer than the default guard — a big repo's first add -A re-hash can take a while. */
const SNAPSHOT_TIMEOUT_MS = 120_000;

/**
 * Snapshot the ENTIRE current worktree state (tracked changes + non-ignored untracked files) as a
 * dangling TREE object via a throwaway index. The REAL index is never touched; no refs are created.
 * Trees are content-addressed, so identical states re-use the same object, and dangling ones are
 * exactly what `git gc` prunes — consumers must treat a missing tree as "snapshot expired".
 */
export async function captureWorktreeTree(cwd: string): Promise<string> {
  const context = executionContext.getStore() ?? { kind: "native" as const };
  // OUTSIDE the worktree — an in-worktree temp file would itself be snapshotted by add -A.
  const indexFile = context.kind === "wsl" ? `/tmp/wollipog-idx-${randomUUID()}` : join(tmpdir(), `wollipog-idx-${randomUUID()}`);
  const opts: GitRunOpts = { env: { GIT_INDEX_FILE: indexFile }, timeoutMs: SNAPSHOT_TIMEOUT_MS };
  try {
    // Seed the temp index from a COPY of the real index when possible: it carries the stat cache
    // (so `add -A` re-hashes only what changed, not the whole tree on every turn) and keeps
    // force-added ignored files tracked (a HEAD seed would treat them as ignored-untracked and
    // silently drop them from the snapshot). Fall back to read-tree HEAD when the copy fails
    // (missing index, unusual layouts) — load-bearing vs an empty seed, which would false-delete
    // every tracked-but-ignored file.
    let seeded = false;
    const gitDir = (await gitSoft(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
    if (gitDir) {
      try {
        if (context.kind === "wsl") {
          await runContextCommand(context, "cp", ["--", `${gitDir}/index`, indexFile], { cwd, timeoutMs: SNAPSHOT_TIMEOUT_MS });
        } else {
          copyFileSync(join(gitDir, "index"), indexFile);
        }
        seeded = true;
      } catch {
        /* no readable index — fall back to HEAD */
      }
    }
    if (!seeded) await git(cwd, ["read-tree", "HEAD"], opts);
    // A copied index can trust a same-size rewrite as clean when its mtime lands in the cached
    // timestamp tick. First capture deletions/untracked, then force the remaining tracked entries
    // through the clean/hash path in the TEMP index so the snapshot is content-authoritative.
    await git(cwd, ["add", "-A"], opts); // stages into the TEMP index only; .gitignore respected
    await git(cwd, ["add", "--renormalize", "-u"], opts);
    return (await git(cwd, ["write-tree"], opts)).trim();
  } finally {
    if (context.kind === "wsl") {
      await runContextCommand(context, "rm", ["-f", "--", indexFile], { cwd, timeoutMs: SNAPSHOT_TIMEOUT_MS }).catch(() => {});
    } else {
      rmSync(indexFile, { force: true });
    }
  }
}

/* ------------------------ per-turn checkpoints (v25) ---------------------- */

const CURRENT_CHECKPOINT_REF_ROOT = "refs/wollipog";
const LEGACY_CHECKPOINT_REF_ROOT = "refs/mam";
const CHECKPOINT_REF_ROOTS = [CURRENT_CHECKPOINT_REF_ROOT, LEGACY_CHECKPOINT_REF_ROOT] as const;
const CHECKPOINT_OWNER_HASH = /^[a-f0-9]{64}$/u;

type CheckpointRefKind = "turn" | "fork";

export interface CheckpointRefSyncResult {
  mirroredToCurrent: number;
  mirroredToLegacy: number;
  conflicts: string[];
}

function assertCheckpointSessionId(sessionId: string): void {
  if (sessionId === "owners" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) {
    throw new Error(`invalid checkpoint session id: ${sessionId}`);
  }
}

function checkpointSessionRoot(root: typeof CHECKPOINT_REF_ROOTS[number], sessionId: string, ownerHash?: string): string {
  assertCheckpointSessionId(sessionId);
  if (ownerHash !== undefined && !CHECKPOINT_OWNER_HASH.test(ownerHash)) throw new Error("invalid checkpoint owner hash");
  return ownerHash ? `${root}/owners/${ownerHash}/${sessionId}` : `${root}/${sessionId}`;
}

/** Ref name for a session checkpoint. Session ids are runner-minted slugs (s_<hex>), safe as a
 * ref component. Both namespaces remain live throughout the rollback-compatible release window. */
function checkpointRefName(
  root: typeof CHECKPOINT_REF_ROOTS[number],
  sessionId: string,
  kind: CheckpointRefKind,
  turn: number,
  ownerHash?: string,
): string {
  return `${checkpointSessionRoot(root, sessionId, ownerHash)}/${kind}-${turn}`;
}

function checkpointRefNames(sessionId: string, kind: CheckpointRefKind, turn: number, ownerHash?: string) {
  return {
    current: checkpointRefName(CURRENT_CHECKPOINT_REF_ROOT, sessionId, kind, turn, ownerHash),
    legacy: checkpointRefName(LEGACY_CHECKPOINT_REF_ROOT, sessionId, kind, turn, ownerHash),
  };
}

async function updateCheckpointRefs(cwd: string, commands: string[]): Promise<void> {
  if (!commands.length) return;
  // update-ref --stdin applies every command as one ref transaction: callers never observe a
  // successful checkpoint in only one namespace because the process died between two commands.
  await git(cwd, ["update-ref", "--stdin"], { stdin: `${commands.join("\n")}\n` });
}

async function readCheckpointRefPair(
  cwd: string,
  names: { current: string; legacy: string },
): Promise<{ current: string | null; legacy: string | null }> {
  const out = await git(cwd, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    names.current,
    names.legacy,
  ]);
  let current: string | null = null;
  let legacy: string | null = null;
  for (const line of out.split("\n")) {
    const separator = line.indexOf("\t");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    const oid = line.slice(separator + 1).trim();
    if (name === names.current && oid) current = oid;
    if (name === names.legacy && oid) legacy = oid;
  }
  return { current, legacy };
}

async function anchorCheckpointRef(
  cwd: string,
  sessionId: string,
  kind: CheckpointRefKind,
  turn: number,
  tree: string,
  ownerHash?: string,
): Promise<void> {
  const names = checkpointRefNames(sessionId, kind, turn, ownerHash);
  await updateCheckpointRefs(cwd, [
    `update ${names.legacy} ${tree}`,
    `update ${names.current} ${tree}`,
  ]);
}

/** Keep a completed-turn tree alive for provider-native conversation forks. */
export async function anchorForkRef(cwd: string, sessionId: string, turn: number, tree: string, ownerHash?: string): Promise<void> {
  await anchorCheckpointRef(cwd, sessionId, "fork", turn, tree, ownerHash);
}

/** Anchor a snapshot tree as real refs so `git gc` can never prune it (unlike the dangling
 * lastTurnBaseTree, which is only best-effort). Refs may point at tree objects directly. */
export async function anchorTurnRef(cwd: string, sessionId: string, turn: number, tree: string, ownerHash?: string): Promise<void> {
  await anchorCheckpointRef(cwd, sessionId, "turn", turn, tree, ownerHash);
}

/** Read a session's checkpoint tree for `turn` (null = never anchored / deleted). The current
 * namespace is probed first, but the legacy value is still checked: after a downgrade an old
 * runner can update only refs/mam, so silently preferring a stale current ref would rewind files
 * to the wrong tree. Divergence therefore fails closed for explicit repair. */
export async function readTurnRef(cwd: string, sessionId: string, turn: number, ownerHash?: string): Promise<string | null> {
  const names = checkpointRefNames(sessionId, "turn", turn, ownerHash);
  let pair: { current: string | null; legacy: string | null };
  try {
    pair = await readCheckpointRefPair(cwd, names);
    if (pair.current && pair.legacy && pair.current !== pair.legacy) {
      // update-ref commits atomically for writers, but a concurrent reader can straddle the
      // transaction. Only a mismatch that survives a fresh read is durable divergence.
      pair = await readCheckpointRefPair(cwd, names);
    }
  } catch {
    // Checkpoint lookup is a soft read. A missing/unreadable repository must not prevent the
    // provider turn from running; only two successfully-read, durably divergent refs fail closed.
    return null;
  }
  if (pair.current && pair.legacy && pair.current !== pair.legacy) {
    throw new Error(
      `checkpoint refs diverged for session ${sessionId} turn ${turn}: ${names.current}=${pair.current}, ${names.legacy}=${pair.legacy}`,
    );
  }
  return pair.current ?? pair.legacy;
}

/** Remove one prepared checkpoint ref without disturbing earlier turns or fork points. */
export async function deleteTurnRef(cwd: string, sessionId: string, turn: number, ownerHash?: string): Promise<void> {
  const names = checkpointRefNames(sessionId, "turn", turn, ownerHash);
  await updateCheckpointRefs(cwd, [`delete ${names.current}`, `delete ${names.legacy}`]);
}

async function listCheckpointRefs(
  cwd: string,
  sessionId: string,
  root: typeof CHECKPOINT_REF_ROOTS[number],
  ownerHash?: string,
): Promise<Map<string, string>> {
  const prefix = `${checkpointSessionRoot(root, sessionId, ownerHash)}/`;
  const out = await git(cwd, ["for-each-ref", "--format=%(refname)%09%(objectname)", prefix]);
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const separator = line.indexOf("\t");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    const oid = line.slice(separator + 1).trim();
    if (!name.startsWith(prefix) || !oid) continue;
    const suffix = name.slice(prefix.length);
    if (/^(?:turn|fork)-[1-9]\d*$/.test(suffix)) refs.set(suffix, oid);
  }
  return refs;
}

/** Mirror every known checkpoint for one durable session without deleting either namespace.
 * Conditional verify+create transactions prevent a startup sweep from overwriting a concurrent
 * writer. Divergent pairs are deliberately left untouched and reported to the caller. */
export async function synchronizeCheckpointRefs(
  cwd: string,
  sessionId: string,
  ownerHash?: string,
): Promise<CheckpointRefSyncResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await listCheckpointRefs(cwd, sessionId, CURRENT_CHECKPOINT_REF_ROOT, ownerHash);
    const legacy = await listCheckpointRefs(cwd, sessionId, LEGACY_CHECKPOINT_REF_ROOT, ownerHash);
    const currentPrefix = checkpointSessionRoot(CURRENT_CHECKPOINT_REF_ROOT, sessionId, ownerHash);
    const legacyPrefix = checkpointSessionRoot(LEGACY_CHECKPOINT_REF_ROOT, sessionId, ownerHash);
    const commands: string[] = [];
    const conflicts: string[] = [];
    let mirroredToCurrent = 0;
    let mirroredToLegacy = 0;
    const suffixes = [...new Set([...current.keys(), ...legacy.keys()])].sort();

    for (const suffix of suffixes) {
      const currentOid = current.get(suffix);
      const legacyOid = legacy.get(suffix);
      if (currentOid && legacyOid) {
        if (currentOid !== legacyOid) conflicts.push(suffix);
        continue;
      }
      if (legacyOid) {
        commands.push(
          `verify ${legacyPrefix}/${suffix} ${legacyOid}`,
          `create ${currentPrefix}/${suffix} ${legacyOid}`,
        );
        mirroredToCurrent++;
      } else if (currentOid) {
        commands.push(
          `verify ${currentPrefix}/${suffix} ${currentOid}`,
          `create ${legacyPrefix}/${suffix} ${currentOid}`,
        );
        mirroredToLegacy++;
      }
    }

    try {
      await updateCheckpointRefs(cwd, commands);
      return { mirroredToCurrent, mirroredToLegacy, conflicts };
    } catch (error) {
      if (attempt === 1) throw error;
      // A concurrent writer may have created or changed one of the verified refs. Re-read once;
      // the next pass either observes a stable pair or surfaces the real failure.
    }
  }
  return { mirroredToCurrent: 0, mirroredToLegacy: 0, conflicts: [] };
}

/** Explicit offline adoption: copy a legacy session namespace into one attested owner namespace.
 * Source refs are verified in the same transaction and deliberately retained for rollback. */
export async function adoptLegacyCheckpointRefs(cwd: string, sessionId: string, ownerHash: string): Promise<number> {
  const legacyCurrent = await listCheckpointRefs(cwd, sessionId, CURRENT_CHECKPOINT_REF_ROOT);
  const legacyMam = await listCheckpointRefs(cwd, sessionId, LEGACY_CHECKPOINT_REF_ROOT);
  const ownedCurrent = await listCheckpointRefs(cwd, sessionId, CURRENT_CHECKPOINT_REF_ROOT, ownerHash);
  const ownedMam = await listCheckpointRefs(cwd, sessionId, LEGACY_CHECKPOINT_REF_ROOT, ownerHash);
  const suffixes = [...new Set([...legacyCurrent.keys(), ...legacyMam.keys()])].sort();
  const commands: string[] = [];
  let adopted = 0;
  const sourceCurrentRoot = checkpointSessionRoot(CURRENT_CHECKPOINT_REF_ROOT, sessionId);
  const sourceMamRoot = checkpointSessionRoot(LEGACY_CHECKPOINT_REF_ROOT, sessionId);
  const targetCurrentRoot = checkpointSessionRoot(CURRENT_CHECKPOINT_REF_ROOT, sessionId, ownerHash);
  const targetMamRoot = checkpointSessionRoot(LEGACY_CHECKPOINT_REF_ROOT, sessionId, ownerHash);
  for (const suffix of suffixes) {
    const current = legacyCurrent.get(suffix);
    const mam = legacyMam.get(suffix);
    if (current && mam && current !== mam) throw new Error(`legacy checkpoint refs diverged for ${sessionId}/${suffix}`);
    const oid = current ?? mam!;
    const targetCurrent = ownedCurrent.get(suffix);
    const targetMam = ownedMam.get(suffix);
    if ((targetCurrent && targetCurrent !== oid) || (targetMam && targetMam !== oid)) {
      throw new Error(`owned checkpoint target conflicts for ${sessionId}/${suffix}`);
    }
    if (current) commands.push(`verify ${sourceCurrentRoot}/${suffix} ${current}`);
    if (mam) commands.push(`verify ${sourceMamRoot}/${suffix} ${mam}`);
    if (!targetCurrent) commands.push(`create ${targetCurrentRoot}/${suffix} ${oid}`);
    if (!targetMam) commands.push(`create ${targetMamRoot}/${suffix} ${oid}`);
    if (!targetCurrent || !targetMam) adopted++;
  }
  await updateCheckpointRefs(cwd, commands);
  return adopted;
}

/** Drop every checkpoint ref a session anchored (session delete / worktree removal). */
export async function deleteTurnRefs(cwd: string, sessionId: string, ownerHash?: string): Promise<void> {
  const refs = new Set<string>();
  for (const root of CHECKPOINT_REF_ROOTS) {
    const prefix = `${checkpointSessionRoot(root, sessionId, ownerHash)}/`;
    const out = await git(cwd, ["for-each-ref", "--format=%(refname)", prefix]);
    for (const ref of out.split("\n")) {
      const name = ref.trim();
      if (name.startsWith(prefix)) refs.add(name);
    }
  }
  await updateCheckpointRefs(cwd, [...refs].sort().map((name) => `delete ${name}`));
}

/**
 * Restore the WORKING TREE to a checkpoint tree (T3-style rewind, files only):
 *  1. delete files that exist now but not in the checkpoint (a plain `git restore` would
 *     leave files the agent created after the checkpoint lying around),
 *  2. write every checkpoint file's content back.
 * The REAL index is untouched (user-owned per the per-hunk staging contract) — staged
 * selections referring to rewound content will read as stale in the Git panel, which
 * re-derives from the worktree on open.
 */
export async function restoreWorktreeToTree(cwd: string, tree: string): Promise<void> {
  const context = executionContext.getStore() ?? { kind: "native" as const };
  const now = await captureWorktreeTree(cwd);
  // Files added since the checkpoint (present in `now`, absent in `tree`) → delete.
  // -z: NUL-delimited RAW paths — the default core.quotepath C-escapes non-ASCII names,
  // and a newline+trim parser would rm the wrong (escaped) name or miss it entirely.
  const added = await git(cwd, ["diff", "-z", "--name-only", "--diff-filter=A", tree, now, "--"]);
  const root = resolve(cwd);
  for (const name of added.split("\0")) {
    if (!name) continue;
    if (context.kind === "wsl") {
      if (name.startsWith("/") || name.split("/").includes("..")) continue;
      await runContextCommand(context, "rm", ["-f", "--", `${cwd.replace(/\/$/, "")}/${name}`], {
        cwd,
        timeoutMs: SNAPSHOT_TIMEOUT_MS,
      });
      continue;
    }
    // Defense in depth: git emits repo-relative forward-slash paths; never follow one outside
    // (path-BOUNDARY check — a plain startsWith would let "<root>evil" through).
    const abs = resolve(cwd, name);
    if (abs !== root && !abs.startsWith(root + sep)) continue;
    rmSync(abs, { force: true });
  }
  // Write checkpoint content over the worktree (handles modified + deleted-since files).
  await git(cwd, ["restore", "--source", tree, "--worktree", "--", "."]);
}

/* ----------------------------- pure parsers ------------------------------ */

/** Parse `git status --porcelain` output into structured file changes. */
export function parsePorcelain(out: string): GitFileChange[] {
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
}

/** Keep a pathological repository from turning one status response into an unbounded wire payload.
 * Aggregate counts and hasChanges still describe the complete porcelain snapshot. */
export const MAX_GIT_STATUS_FILES = 1_000;

export interface PorcelainCategoryCounts {
  stagedCount: number;
  modifiedCount: number;
  untrackedCount: number;
  conflictedCount: number;
}

const CONFLICTED_PORCELAIN_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Count raw porcelain XY columns without collapsing them into exclusive buckets. */
export function parsePorcelainCategories(out: string): PorcelainCategoryCounts {
  const counts: PorcelainCategoryCounts = {
    stagedCount: 0,
    modifiedCount: 0,
    untrackedCount: 0,
    conflictedCount: 0,
  };
  for (const line of out.split("\n")) {
    if (line.length < 2) continue;
    const code = line.slice(0, 2);
    if (code === "??") {
      counts.untrackedCount++;
      continue;
    }
    if (CONFLICTED_PORCELAIN_CODES.has(code)) counts.conflictedCount++;
    if (code[0] !== " " && code[0] !== "?") counts.stagedCount++;
    if (code[1] !== " " && code[1] !== "?") counts.modifiedCount++;
  }
  return counts;
}

export interface RevListPair {
  /** Commits reachable only from the left side of the three-dot range. */
  left: number;
  /** Commits reachable only from the right side of the three-dot range. */
  right: number;
}

/** Parse one atomic git rev-list --left-right --count response. */
export function parseRevListPair(out: string): RevListPair | null {
  const match = out.trim().match(/^(\d+)\s+(\d+)$/);
  if (!match) return null;
  return { left: Number(match[1]), right: Number(match[2]) };
}

/** Extract owner/repo from a github remote (ssh or https), or null. */
export function githubSlug(remote: string): string | null {
  const s = remote.trim();
  // git@github.com:owner/repo.git  |  ssh://git@github.com/owner/repo.git
  // https://github.com/owner/repo(.git)
  const m = s.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Pull a GitHub *pull-request* URL out of gh stdout/stderr text. Strictly matches
 * the `/pull/<n>` shape: a docs/login/status URL in a gh error must NOT be mistaken
 * for a created PR (otherwise a failed `gh pr create` looks like success).
 */
export function pickPrUrl(text: string): string | null {
  const m = text.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
  return m ? m[0] : null;
}

/* ------------------------------ diff parsing ----------------------------- */

/** Strip a `a/` or `b/` prefix git prepends to diff paths (unless it's `/dev/null`). */
function stripDiffPrefix(p: string): string {
  if (p === "/dev/null") return p;
  return p.replace(/^[ab]\//, "");
}

/** Parse the `@@ -a,b +c,d @@` header numbers. Counts default to 1 when omitted. */
function parseHunkHeader(line: string): Pick<GitHunk, "oldStart" | "oldCount" | "newStart" | "newCount"> | null {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/**
 * Parse `git diff` unified output into structured per-file diffs. Pure state machine over
 * the raw text — handles multi-file, add/delete/rename/copy, mode-only changes, binaries, and
 * the "\ No newline at end of file" marker. Renames/mode-only/binary files carry `hunks: []`.
 *
 * Line status is symbol-form: ' ' (context), '+' (added), '-' (removed). The leading symbol
 * is stripped from `text`. Empty input yields an empty list.
 */
export function parseDiff(raw: string): GitDiffFile[] {
  const files: GitDiffFile[] = [];
  const lines = raw.split("\n");
  let file: GitDiffFile | null = null;
  let hunk: GitHunk | null = null;

  const closeHunk = (): void => {
    if (file && hunk) file.hunks.push(hunk);
    hunk = null;
  };
  const closeFile = (): void => {
    closeHunk();
    if (file) files.push(file);
    file = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // Start a new file. Header form: `diff --git a/old b/new` (paths may contain spaces, but
      // the actual paths are re-stated by the ---/+++ or rename from/to lines below, which we
      // prefer). Seed path from the b/ side of the header as a fallback.
      closeFile();
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const path = m?.[2] ?? line.slice("diff --git ".length);
      file = { path, status: "modified", binary: false, hunks: [] };
      continue;
    }
    if (!file) continue; // preamble before the first file header — ignore

    if (line.startsWith("@@")) {
      closeHunk();
      const nums = parseHunkHeader(line);
      if (nums) hunk = { header: line, ...nums, lines: [] };
      continue;
    }

    if (hunk) {
      // Inside a hunk body. Every real content line carries a leading marker; an empty-context line
      // is " " (space + nothing), NOT a bare "". A bare "" is only the trailing artifact of splitting
      // on "\n" when the diff ends in a newline, so ignore it rather than inventing a context line.
      const c = line[0];
      if (c === "+") {
        hunk.lines.push({ status: "+", text: line.slice(1) });
      } else if (c === "-") {
        hunk.lines.push({ status: "-", text: line.slice(1) });
      } else if (c === " ") {
        hunk.lines.push({ status: " ", text: line.slice(1) });
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file" — annotate the current hunk, don't add a line.
        hunk.noNewlineAtEof = true;
      } else if (line === "") {
        // Trailing split artifact — end of content for this hunk; keep the hunk as-is.
        continue;
      } else {
        // Any other leading char that isn't a diff/@@ header (handled above) is unexpected; close
        // the hunk defensively so stray output doesn't get absorbed as context.
        closeHunk();
      }
      continue;
    }

    // File header lines (between `diff --git` and the first `@@`).
    if (line.startsWith("new file mode")) {
      file.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
    } else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      file.status = "renamed";
      file.oldPath = line.replace(/^(rename|copy) from /, "");
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      file.status = "renamed";
      file.path = line.replace(/^(rename|copy) to /, "");
    } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      file.binary = true;
    } else if (line.startsWith("--- ")) {
      const p = stripDiffPrefix(line.slice(4).trim());
      if (p !== "/dev/null") file.oldPath = file.oldPath ?? p;
    } else if (line.startsWith("+++ ")) {
      const p = stripDiffPrefix(line.slice(4).trim());
      if (p !== "/dev/null") file.path = p;
    }
    // `index …`, `old mode`, `new mode`, `similarity index`, etc. carry no structural data we keep.
  }
  closeFile();

  // A pure `--- a/x` (no `+++ b/x`) fallback path: the `---`/`+++` lines set oldPath even for
  // renames; drop a redundant oldPath that equals path so context modifies read cleanly.
  for (const f of files) {
    if (f.status !== "renamed" && f.oldPath === f.path) delete f.oldPath;
  }
  return files;
}

/**
 * Deterministic content hash for a diff: sha256 (hex) over the raw text normalized to LF line
 * endings with a single trailing newline ensured. CRLF and LF inputs of the same change hash equal;
 * one changed line changes the hash. Used to detect a stale diff before per-hunk staging (PR-B).
 */
export function computeDiffHash(rawNormalized: string): string {
  let text = rawNormalized.replace(/\r/g, "");
  if (!text.endsWith("\n")) text += "\n";
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Aggregate insertion/deletion/file counts from parsed files (mirrors `git diff --shortstat`). */
function diffStats(files: GitDiffFile[]): GitDiffStats {
  let insertions = 0;
  let deletions = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.status === "+") insertions++;
        else if (l.status === "-") deletions++;
      }
    }
  }
  return { filesChanged: files.length, insertions, deletions };
}

/* --------------------------- git operations ------------------------------ */

/** Paths whose index content differs from HEAD — the staged set (same definition the commit gate uses). */
async function stagedPaths(cwd: string): Promise<string[]> {
  return (await gitSoft(cwd, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
}

/**
 * The base ref for ahead/behind counts: `origin/HEAD`'s target when set, else the first
 * existing candidate from the all_branch chain (`origin/main`, `origin/master`, `main`,
 * `master`). Clones don't always create the symbolic `origin/HEAD` — without this fallback
 * a branch ahead of `origin/main` silently reports 0 and the Push affordance hides.
 */
async function resolveBaseRef(cwd: string): Promise<string | null> {
  const head = await defaultBaseRef(cwd);
  if (head) return head;
  for (const cand of ALL_BRANCH_BASE_CANDIDATES) {
    if (cand === "origin/HEAD") continue; // defaultBaseRef already covers it
    if (await refExists(cwd, cand)) return cand;
  }
  return null;
}

type GitOperation = Exclude<GitRepositoryFacts["operation"], null | undefined>;

const OPERATION_MARKERS: ReadonlyArray<readonly [GitOperation, readonly string[]]> = [
  ["merge", ["MERGE_HEAD"]],
  ["rebase", ["rebase-merge", "rebase-apply"]],
  ["cherry_pick", ["CHERRY_PICK_HEAD"]],
  ["revert", ["REVERT_HEAD"]],
  ["bisect", ["BISECT_LOG"]],
];

async function repositoryOperation(cwd: string, gitDir: string): Promise<GitOperation | null> {
  if (!gitDir) return null;
  const context = executionContext.getStore() ?? { kind: "native" as const };
  const probes = await Promise.all(OPERATION_MARKERS.flatMap(([operation, markers]) => markers.map(async (marker) => ({
    operation,
    exists: (await gitPathMetadataReader(cwd, commonGitPath(cwd, gitDir, marker, context), context)).exists,
  }))));
  return probes.find((probe) => probe.exists)?.operation ?? null;
}

async function remoteRefsTimestamp(cwd: string): Promise<number | null> {
  const remoteRefs = (await gitSoft(cwd, ["for-each-ref", "--count=1", "--format=%(refname)", "refs/remotes"]))
    .split("\n")
    .some((line) => line.startsWith("refs/remotes/"));
  if (!remoteRefs) return null;
  const commonDir = (await gitSoft(cwd, ["rev-parse", "--git-common-dir"])).trim();
  if (!commonDir) return null;
  const context = executionContext.getStore() ?? { kind: "native" as const };
  const metadata = await remoteRefsMetadataReader(cwd, commonDir, context);
  return metadata.exists ? metadata.mtimeMs : null;
}

async function revListPair(cwd: string, range: string): Promise<RevListPair | null> {
  return parseRevListPair(await gitSoft(cwd, ["rev-list", "--left-right", "--count", range]));
}

interface CollectedGitStatus {
  status: GitStatusInfo;
  behindBase: number;
}

/** Collect one coherent local snapshot. Divergence pairs each come from one rev-list invocation,
 * so HEAD cannot move between separate ahead and behind reads and produce an impossible pair. */
async function collectGitStatus(cwd: string): Promise<CollectedGitStatus> {
  // Porcelain is the authority for dirty state. Unlike optional enrichment reads, it must fail
  // closed: a timeout, max-buffer failure, or Git error must never be projected as a clean tree.
  // A bare repository has no worktree by definition, so Git legitimately rejects status there.
  const bare = (await gitSoft(cwd, ["rev-parse", "--is-bare-repository"])).trim() === "true";
  const porcelainPromise = bare
    ? Promise.resolve("")
    : git(cwd, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]);
  const [
    abbreviatedBranch,
    symbolicBranch,
    headText,
    porcelain,
    remoteText,
    gitDirText,
    upstreamText,
    shallowText,
    resolvedBaseRef,
  ] = await Promise.all([
    gitSoft(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitSoft(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitSoft(cwd, ["rev-parse", "--short=12", "HEAD"]),
    porcelainPromise,
    gitSoft(cwd, ["remote", "get-url", "origin"]),
    gitSoft(cwd, ["rev-parse", "--git-dir"]),
    gitSoft(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    gitSoft(cwd, ["rev-parse", "--is-shallow-repository"]),
    resolveBaseRef(cwd),
  ]);

  const abbreviated = abbreviatedBranch.trim();
  const symbolic = symbolicBranch.trim();
  const rawHead = headText.trim().toLowerCase();
  const headSha = /^[0-9a-f]{4,64}$/.test(rawHead) ? rawHead : null;
  const detached = headSha !== null && (abbreviated === "HEAD" || (!abbreviated && !symbolic));
  const branch = abbreviated && abbreviated !== "HEAD" ? abbreviated : symbolic || "HEAD";
  const upstreamBranch = upstreamText.trim() || null;
  const rawShallow = shallowText.trim();
  const shallow = rawShallow === "true" ? true : rawShallow === "false" ? false : null;

  const [baseCounts, upstreamCounts, operation, remoteRefsAt, numstat] = await Promise.all([
    resolvedBaseRef && headSha ? revListPair(cwd, resolvedBaseRef + "...HEAD") : Promise.resolve(null),
    upstreamBranch && headSha ? revListPair(cwd, "@{upstream}...HEAD") : Promise.resolve(null),
    repositoryOperation(cwd, gitDirText.trim()),
    remoteRefsTimestamp(cwd),
    gitSoft(cwd, ["--no-optional-locks", "diff", "HEAD", "--numstat"]),
  ]);
  const categories = parsePorcelainCategories(porcelain);
  let addedLines = 0;
  let deletedLines = 0;
  for (const row of numstat.split("\n")) {
    const match = row.match(/^(\d+)\t(\d+)\t/);
    if (!match) continue;
    addedLines += Number(match[1]);
    deletedLines += Number(match[2]);
  }
  const allFiles = parsePorcelain(porcelain);
  const files = allFiles.slice(0, MAX_GIT_STATUS_FILES);
  return {
    status: {
      branch,
      files,
      hasChanges: allFiles.length > 0,
      ahead: baseCounts?.right ?? upstreamCounts?.right ?? 0,
      remoteUrl: remoteText.trim() || null,
      headSha,
      detached,
      upstreamBranch,
      aheadUpstream: upstreamCounts?.right ?? null,
      behindUpstream: upstreamCounts?.left ?? null,
      baseRef: baseCounts ? resolvedBaseRef : null,
      worktreeKind: isLinkedWorktreeGitDir(gitDirText.trim()) ? "linked" : "primary",
      shallow,
      ...categories,
      ...(allFiles.length > files.length ? { filesTruncated: true } : {}),
      operation,
      remoteRefsAt,
      addedLines,
      deletedLines,
    },
    behindBase: baseCounts?.left ?? upstreamCounts?.left ?? 0,
  };
}

export async function gitStatus(cwd: string): Promise<GitStatusInfo> {
  return (await collectGitStatus(cwd)).status;
}

/* ------------------------- git summary (pinned card) ---------------------- */

/**
 * Collapse a `gh pr view` statusCheckRollup into counts + failing names. The rollup mixes two
 * node shapes: CheckRun ({name, status, conclusion}) and StatusContext ({context, state}).
 * Exported for unit tests. Failure stance: a COMPLETED check run with an unrecognized
 * conclusion counts as FAILING (fail closed) — labeling a terminal non-pass state as
 * "running" would hide it and suppress the Fix affordance if GitHub adds new vocabulary.
 * Only genuinely in-flight states (and unknown node shapes) count as pending.
 */
export function summarizeCheckRollup(nodes: unknown): Omit<GitChecksSummary, "url"> {
  const failing: string[] = [];
  let pending = 0;
  let passing = 0;
  // GitHub's CheckConclusionState vocabulary as of 2026: SUCCESS, FAILURE, NEUTRAL, CANCELLED,
  // SKIPPED, TIMED_OUT, ACTION_REQUIRED, STALE, STARTUP_FAILURE.
  const PASS_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
  for (const raw of Array.isArray(nodes) ? nodes : []) {
    const n = raw as { name?: string; context?: string; status?: string; conclusion?: string; state?: string };
    const name = n.name ?? n.context ?? "check";
    if (typeof n.state === "string") {
      // StatusContext
      if (n.state === "SUCCESS") passing++;
      else if (n.state === "FAILURE" || n.state === "ERROR") failing.push(name);
      else pending++; // PENDING / EXPECTED
    } else if (n.status === "COMPLETED") {
      // CheckRun, finished: pass on the known-good conclusions, fail on everything else.
      if (PASS_CONCLUSIONS.has(n.conclusion ?? "")) passing++;
      else failing.push(name);
    } else {
      pending++; // QUEUED / IN_PROGRESS / unknown shape
    }
  }
  return { failing: failing.length, pending, passing, failingNames: failing.slice(0, 8) };
}

/** TTL cache for the gh PR lookup — the pinned summary refreshes on every turn flip, and a
 * network round trip to GitHub per flip would be wasteful (and rate-limited). */
const GH_PR_CACHE_TTL_MS = 15_000;
const ghPrCache = new Map<string, { at: number; pr: GitPrSummary | null; checks: GitChecksSummary | null }>();

/** Test-only: drop the gh PR cache. */
export function clearGhPrCacheForTests(): void {
  ghPrCache.clear();
}

type JsonObject = Record<string, unknown>;
const jsonObject = (value: unknown): JsonObject | null =>
  value != null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const jsonString = (value: unknown): string | null => typeof value === "string" ? value : null;
const jsonInt = (value: unknown): number | null => Number.isSafeInteger(value) ? value as number : null;

function githubReviewPath(value: unknown): string | null {
  const path = jsonString(value);
  if (!path || path.length > 4096 || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return null;
  }
  return path.split("/").some((part) => !part || part === "." || part === "..") ? null : path;
}

/** Strictly parse one GraphQL reviewThreads page. gh output is an external trust boundary: an
 * invalid node aborts the whole authoritative sync rather than partially reconciling it. */
export function parseGitHubReviewPage(raw: string): {
  pullRequestHeadOid: string;
  pullRequestBaseOid: string;
  hasNextPage: boolean;
  endCursor: string | null;
  threads: GitHubReviewThread[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GitHub returned malformed review data");
  }
  const root = jsonObject(parsed);
  const errors = Array.isArray(root?.errors) ? root.errors : [];
  if (errors.length) throw new Error("GitHub could not read pull-request review threads");
  const repository = jsonObject(jsonObject(root?.data)?.repository);
  const pr = jsonObject(repository?.pullRequest);
  const head = jsonString(pr?.headRefOid);
  const base = jsonString(pr?.baseRefOid);
  const connection = jsonObject(pr?.reviewThreads);
  const pageInfo = jsonObject(connection?.pageInfo);
  const nodes = connection?.nodes;
  if (!head || !/^[0-9a-f]{40}$/i.test(head) || !base || !/^[0-9a-f]{40}$/i.test(base) ||
      !Array.isArray(nodes) || typeof pageInfo?.hasNextPage !== "boolean") {
    throw new Error("GitHub returned incomplete pull-request review data");
  }
  const endCursor = pageInfo.hasNextPage ? jsonString(pageInfo.endCursor) : null;
  if (pageInfo.hasNextPage && !endCursor) throw new Error("GitHub review pagination did not return a cursor");

  const threads = nodes.map((value): GitHubReviewThread => {
    const node = jsonObject(value);
    const threadId = jsonString(node?.id);
    const path = githubReviewPath(node?.path);
    const subjectTypeRaw = jsonString(node?.subjectType);
    const subjectType = subjectTypeRaw === "LINE" ? "line" : subjectTypeRaw === "FILE" ? "file" : null;
    const line = subjectType === "file" ? 1 : jsonInt(node?.line) ?? jsonInt(node?.originalLine);
    const diffSide = jsonString(node?.diffSide);
    const comments = jsonObject(node?.comments)?.nodes;
    const rootComment = Array.isArray(comments)
      ? comments.map(jsonObject).find((comment) => comment?.replyTo == null)
      : null;
    const commentId = jsonInt(rootComment?.databaseId);
    const url = jsonString(rootComment?.url);
    const bodyRaw = jsonString(rootComment?.body);
    const author = jsonString(jsonObject(rootComment?.author)?.login) ?? "ghost";
    const createdAt = Date.parse(jsonString(rootComment?.createdAt) ?? "");
    const updatedAt = Date.parse(jsonString(rootComment?.updatedAt) ?? "");
    const commitId = jsonString(jsonObject(rootComment?.originalCommit)?.oid)
      ?? jsonString(jsonObject(rootComment?.commit)?.oid);
    if (!threadId || !path || !subjectType || line == null || line < 1 || line > 10_000_000 ||
        (diffSide !== "LEFT" && diffSide !== "RIGHT") || commentId == null || commentId < 1 ||
        !url || !/^https:\/\/github\.com\//i.test(url) || bodyRaw == null ||
        !Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || updatedAt < createdAt ||
        !commitId || !/^[0-9a-f]{40}$/i.test(commitId) ||
        typeof node?.isResolved !== "boolean" || typeof node?.isOutdated !== "boolean") {
      throw new Error("GitHub returned an invalid review-thread anchor");
    }
    const trimmed = bodyRaw.trim() || "(empty GitHub review comment)";
    const body = trimmed.length > GH_REVIEW_BODY_MAX
      ? `${trimmed.slice(0, GH_REVIEW_BODY_MAX - 1)}…`
      : trimmed;
    return {
      threadId,
      commentId,
      url,
      path,
      side: diffSide === "LEFT" ? "left" : "right",
      line,
      body,
      author: author.slice(0, 160),
      createdAt,
      updatedAt,
      commitId: commitId.toLowerCase(),
      subjectType,
      resolved: node.isResolved,
      outdated: node.isOutdated,
    };
  });
  if (new Set(threads.map((thread) => thread.threadId)).size !== threads.length) {
    throw new Error("GitHub returned duplicate review threads");
  }
  return {
    pullRequestHeadOid: head.toLowerCase(),
    pullRequestBaseOid: base.toLowerCase(),
    hasNextPage: pageInfo.hasNextPage,
    endCursor,
    threads,
  };
}

/** Read the complete GitHub review-thread set for the PR associated with this exact worktree HEAD.
 * This operation is intentionally read-only; local reconciliation never resolves remote threads. */
async function githubReviewSync(cwd: string): Promise<GitHubReviewSyncInfo> {
  const context = executionContext.getStore() ?? { kind: "native" as const };
  const remote = (await git(cwd, ["remote", "get-url", "origin"])).trim();
  const repository = githubSlug(remote)?.toLowerCase() ?? null;
  if (!repository) throw new Error("the origin remote is not a GitHub repository");
  const [owner, name] = repository.split("/");
  let prView: JsonObject;
  try {
    const result = await runContextCommand(context, "gh", ["pr", "view", "--json", "number,url,headRefOid,baseRefOid"], {
      cwd,
      timeoutMs: GH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    prView = jsonObject(JSON.parse(result.stdout)) ?? {};
  } catch (error) {
    throw new Error(`GitHub review sync requires gh authentication and a pull request for this branch (${firstErrLine(error)})`);
  }
  const pullRequestNumber = jsonInt(prView.number);
  const pullRequestUrl = jsonString(prView.url);
  const viewHeadOid = jsonString(prView.headRefOid);
  const viewBaseOid = jsonString(prView.baseRefOid);
  const expectedPrUrl = pullRequestNumber == null
    ? ""
    : `https://github.com/${repository}/pull/${pullRequestNumber}`;
  if (pullRequestNumber == null || pullRequestNumber < 1 || !pullRequestUrl ||
      pullRequestUrl.toLowerCase() !== expectedPrUrl.toLowerCase() ||
      !viewHeadOid || !/^[0-9a-f]{40}$/i.test(viewHeadOid) ||
      !viewBaseOid || !/^[0-9a-f]{40}$/i.test(viewBaseOid)) {
    throw new Error("GitHub returned invalid pull-request metadata");
  }

  const threads: GitHubReviewThread[] = [];
  let cursor: string | null = null;
  let queryHead = "";
  let queryBase = "";
  for (let page = 0; page < GH_REVIEW_MAX_PAGES; page += 1) {
    const args = [
      "api", "graphql", "-f", `query=${GH_REVIEW_QUERY}`,
      "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${pullRequestNumber}`,
      ...(cursor ? ["-F", `cursor=${cursor}`] : []),
    ];
    let response: string;
    try {
      response = (await runContextCommand(context, "gh", args, {
        cwd,
        timeoutMs: GH_TIMEOUT_MS,
        maxBuffer: GH_REVIEW_MAX_BUFFER,
      })).stdout;
    } catch (error) {
      throw new Error(`could not read GitHub review threads (${firstErrLine(error)})`);
    }
    const parsed = parseGitHubReviewPage(response);
    if (queryHead && queryHead !== parsed.pullRequestHeadOid) {
      throw new Error("the pull request changed while its review threads were loading — retry the sync");
    }
    queryHead = parsed.pullRequestHeadOid;
    if (queryBase && queryBase !== parsed.pullRequestBaseOid) {
      throw new Error("the pull request base changed while its review threads were loading — retry the sync");
    }
    queryBase = parsed.pullRequestBaseOid;
    threads.push(...parsed.threads);
    if (threads.length > GH_REVIEW_PAGE_SIZE * GH_REVIEW_MAX_PAGES) {
      throw new Error("the pull request has more review threads than this build can reconcile safely");
    }
    if (!parsed.hasNextPage) {
      cursor = null;
      break;
    }
    cursor = parsed.endCursor;
  }
  if (cursor) throw new Error("the pull request has more than 500 review threads; no partial reconciliation was applied");
  if (queryHead !== viewHeadOid.toLowerCase()) {
    throw new Error("the pull request changed while its review threads were loading — retry the sync");
  }
  if (queryBase !== viewBaseOid.toLowerCase()) {
    throw new Error("the pull request base changed while its review threads were loading — retry the sync");
  }
  if (new Set(threads.map((thread) => thread.threadId)).size !== threads.length) {
    throw new Error("GitHub returned duplicate review threads across pages");
  }
  const localHeadOid = (await git(cwd, ["rev-parse", "HEAD"])).trim().toLowerCase();
  if (!(await treeExists(cwd, queryBase))) {
    throw new Error("the pull request base commit is not available in this worktree — fetch the base branch and retry the sync");
  }
  const mergeBase = (await git(cwd, ["merge-base", queryBase, "HEAD"])).trim();
  const raw = await git(cwd, [...DIFF_CFG, "diff", "--no-ext-diff", "--unified=3", `${mergeBase}..HEAD`, "--"]);
  const verifiedLocalHeadOid = (await git(cwd, ["rev-parse", "HEAD"])).trim().toLowerCase();
  if (localHeadOid !== verifiedLocalHeadOid) {
    throw new Error("the local branch changed while its review diff was loading — retry the sync");
  }
  return {
    repository,
    pullRequestNumber,
    pullRequestUrl,
    pullRequestHeadOid: queryHead,
    pullRequestBaseOid: queryBase,
    localHeadOid,
    diffHash: computeDiffHash(raw),
    threads,
    synchronizedAt: Date.now(),
  };
}

/** The PR + checks for the branch checked out in `cwd`, via gh. Null when gh is missing,
 * unauthenticated, the repo isn't on GitHub, or the branch has no PR — never a throw. */
async function ghPrSummary(cwd: string): Promise<{ pr: GitPrSummary | null; checks: GitChecksSummary | null }> {
  const context = executionContext.getStore() ?? { kind: "native" as const };
  const cacheKey = `${context.kind === "wsl" ? `wsl:${context.distro}` : "native"}:${cwd}`;
  const hit = ghPrCache.get(cacheKey);
  if (hit && Date.now() - hit.at < GH_PR_CACHE_TTL_MS) return { pr: hit.pr, checks: hit.checks };
  let pr: GitPrSummary | null = null;
  let checks: GitChecksSummary | null = null;
  try {
    const { stdout } = await runContextCommand(context, "gh", ["pr", "view", "--json", "number,title,url,state,statusCheckRollup"], {
      cwd,
      timeoutMs: GH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const d = JSON.parse(stdout) as {
      number?: number;
      title?: string;
      url?: string;
      state?: string;
      statusCheckRollup?: unknown;
    };
    const url = safeHttpUrl(d.url);
    if (typeof d.number === "number" && url) {
      pr = { number: d.number, title: d.title ?? "", url, state: d.state ?? "OPEN" };
      const rollup = summarizeCheckRollup(d.statusCheckRollup);
      // No checks configured at all → omit the section rather than showing 0/0/0.
      checks = rollup.failing + rollup.pending + rollup.passing > 0 ? { ...rollup, url: `${url.replace(/\/$/, "")}/checks` } : null;
    }
  } catch {
    // gh absent/unauth/no PR — the card simply hides the PR/checks rows.
  }
  ghPrCache.set(cacheKey, { at: Date.now(), pr, checks });
  return { pr, checks };
}

/** Forge metadata is untrusted input. Only publish absolute web URLs to dashboard clients. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** One read powering the pinned summary card: status bits + behind-count + the gh PR/checks. */
export async function gitSummary(cwd: string): Promise<GitSummaryInfo> {
  const { status, behindBase } = await collectGitStatus(cwd);
  // Commits the base has that this branch lacks (0 if unknown) — same resolved base as the
  // ahead count in gitStatus, so the two can never disagree about what "the base" is.
  const { files: _files, ...facts } = status;
  const { pr, checks } = await ghPrSummary(cwd);
  return {
    ...facts,
    behind: behindBase,
    addedLines: status.addedLines ?? 0,
    deletedLines: status.deletedLines ?? 0,
    pr,
    checks,
  };
}

/**
 * Force the `a/ b/` path prefixes on every raw diff we parse or hand back out as a patch.
 * A repo/user `diff.noprefix=true` (or mnemonicPrefix) would otherwise change the ---/+++
 * lines, breaking both parseDiff's prefix stripping and `git apply -p1` on extracted hunks.
 */
const DIFF_CFG = ["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false"];

/** Candidate base refs for an all_branch diff, tried in order until one exists. */
const ALL_BRANCH_BASE_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

/** True if `ref` resolves to a commit in this repo. */
async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** True if `sha` still names a tree object (dangling snapshot trees are gc-prunable). */
async function treeExists(cwd: string, sha: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the merge-base of HEAD against the first existing base ref, walking the fallback chain
 * origin/HEAD → origin/main → origin/master → main → master. Throws a clear error if none exist. */
async function allBranchBase(cwd: string): Promise<string> {
  for (const ref of ALL_BRANCH_BASE_CANDIDATES) {
    if (!(await refExists(cwd, ref))) continue;
    const base = (await gitSoft(cwd, ["merge-base", ref, "HEAD"])).trim();
    if (base) return base;
  }
  throw new Error(
    "could not determine a base branch for the all-branch diff — none of origin/HEAD, origin/main, origin/master, main, master exist",
  );
}

/** True if the file at `abs` looks binary — a NUL byte in the first 8 KiB. */
async function looksBinary(cwd: string, path: string): Promise<boolean> {
  const context = executionContext.getStore() ?? { kind: "native" as const };
  if (context.kind === "wsl") {
    if (path.startsWith("/") || path.split("/").includes("..")) return false;
    try {
      await runContextCommand(
        context,
        "sh",
        ["-c", 'od -An -tx1 -N8192 -- "$1" | grep -qw 00', "sh", `${cwd.replace(/\/$/, "")}/${path}`],
        { cwd, timeoutMs: 8_000 },
      );
      return true;
    } catch (error) {
      const code = (error as { code?: string | number }).code;
      if (Number(code) === 1) return false;
      return false;
    }
  }
  const abs = isAbsolute(path) ? path : join(cwd, path);
  let fd: number | null = null;
  try {
    fd = openSync(abs, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Map with a hard in-flight ceiling; used where each WSL item is a full wsl.exe spawn. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("concurrency limit must be a positive integer");
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const WSL_BINARY_PROBE_CONCURRENCY = 4;

/** Untracked files as synthetic name-only `??` diff files (git diff never shows them). */
async function untrackedFiles(cwd: string): Promise<GitDiffFile[]> {
  const out = await gitSoft(cwd, ["ls-files", "--others", "--exclude-standard"]);
  const paths = out
    .split("\n")
    // Strip only the line terminator — git emits literal leading/trailing spaces in paths
    // unquoted, and a trim() would mangle them (they feed both the pane and the diffHash).
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.length > 0);
  const build = async (path: string): Promise<GitDiffFile> => ({
      path,
      status: "untracked" as const,
      binary: await looksBinary(cwd, path),
      hunks: [],
    });
  const context = executionContext.getStore() ?? { kind: "native" as const };
  return context.kind === "wsl"
    ? mapWithConcurrency(paths, WSL_BINARY_PROBE_CONCURRENCY, build)
    : Promise.all(paths.map(build));
}

/** The three canonical uncommitted views plus one hash input. The identity covers both index and
 * worktree state; this closes the old gap where an external `git add` did not change diffHash. */
async function uncommittedRaw(cwd: string): Promise<{
  raw: string;
  stagedRaw: string;
  unstagedRaw: string;
  hashInput: string;
  fineHashInput: string;
  untracked: GitDiffFile[];
}> {
  const [raw, stagedRaw, unstagedRaw] = await Promise.all([
    git(cwd, [...DIFF_CFG, "diff", "--no-ext-diff", "--unified=3", "HEAD", "--"]),
    git(cwd, [...DIFF_CFG, "diff", "--no-ext-diff", "--unified=3", "--cached", "--"]),
    git(cwd, [...DIFF_CFG, "diff", "--no-ext-diff", "--unified=3", "--"]),
  ]);
  // Untracked files are part of the uncommitted change-set but invisible to `git diff`, so fold
  // their (name-only) manifest into the hash input — otherwise adding or removing an untracked
  // file would leave the change-set identity unchanged. Name-only matches what the pane shows;
  // `ls-files` output is sorted, so it's deterministic.
  const untracked = await untrackedFiles(cwd);
  const manifest = untracked.map((f) => `?? ${f.path}\n`).join("");
  return {
    raw,
    stagedRaw,
    unstagedRaw,
    untracked,
    hashInput: raw + manifest,
    fineHashInput: `${raw}\0staged\n${stagedRaw}\0unstaged\n${unstagedRaw}\0untracked\n${manifest}`,
  };
}

/** The index-vs-HEAD diff, parsed — used to mark staged hunks. Best-effort ("" on failure). */
async function cachedDiffFiles(cwd: string): Promise<GitDiffFile[]> {
  return parseDiff(await gitSoft(cwd, [...DIFF_CFG, "diff", "--no-ext-diff", "--unified=3", "--cached", "--"]));
}

/**
 * Compute a structured diff for a session worktree.
 *   uncommitted - `git diff --no-ext-diff --unified=3 HEAD --` plus untracked files (name-only),
 *                 with per-hunk `staged` flags derived from the index-vs-HEAD diff.
 *   all_branch  - `git diff --no-ext-diff --unified=3 <merge-base>..HEAD --` against the base chain.
 *   last_turn   - tree-to-tree: the turn-start snapshot tree vs a fresh snapshot of the worktree
 *                 now. Untracked files live inside both trees, so no synthesis and no manifest.
 *
 * `ctx.useWorktree` gates the linked-worktree assertion (only worktree sessions have one).
 */
export async function gitDiff(cwd: string, scope: GitDiffScope, ctx: GitActionContext): Promise<GitDiffInfo> {
  if (ctx.useWorktree) await assertWorktree(cwd);

  if (scope === "last_turn") {
    const snap = ctx.lastTurnBaseTree;
    if (snap === undefined) {
      throw new Error("no last-turn snapshot exists for this session yet — run a prompt first, or use the Uncommitted scope");
    }
    if (snap === null) {
      throw new Error(
        "the snapshot at the start of the last turn could not be captured, so a last-turn diff isn't available — use the Uncommitted scope",
      );
    }
    if (!(await treeExists(cwd, snap))) {
      throw new Error("the last-turn snapshot was pruned by git (gc) — use the Uncommitted scope instead");
    }
    let raw: string;
    try {
      const now = await captureWorktreeTree(cwd);
      raw = await git(cwd, [...DIFF_CFG, "diff", "--no-ext-diff", "--unified=3", snap, now, "--"]);
    } catch (err) {
      throw new Error(
        `could not compute the last-turn diff (its snapshot may have been partially pruned by git) — use the Uncommitted scope. ${errMessage(err)}`,
      );
    }
    const files = parseDiff(raw);
    // Untracked content is inside the trees here, so the hash needs no name manifest.
    return { scope, files, diffHash: computeDiffHash(raw), stats: diffStats(files) };
  }

  if (scope === "all_branch") {
    const base = await allBranchBase(cwd);
    const raw = await git(cwd, [...DIFF_CFG, "diff", "--no-ext-diff", "--unified=3", `${base}..HEAD`, "--"]);
    const files = parseDiff(raw);
    return { scope, files, diffHash: computeDiffHash(raw), stats: diffStats(files) };
  }

  // uncommitted
  const { raw, stagedRaw, unstagedRaw, hashInput, fineHashInput, untracked } = await uncommittedRaw(cwd);
  const files = parseDiff(raw);
  const stagedFiles = parseDiff(stagedRaw);
  const unstagedFiles = parseDiff(unstagedRaw);
  for (const file of stagedFiles) for (const hunk of file.hunks) hunk.staged = true;
  markStagedHunks(files, stagedFiles);
  files.push(...untracked);
  unstagedFiles.push(...untracked);
  return {
    scope,
    files,
    stagedFiles,
    unstagedFiles,
    diffHash: computeDiffHash(hashInput),
    fineDiffHash: computeDiffHash(fineHashInput),
    stagedDiffHash: computeDiffHash(stagedRaw),
    unstagedDiffHash: computeDiffHash(unstagedRaw + untracked.map((file) => `?? ${file.path}\n`).join("")),
    stats: diffStats(files),
    stagedStats: diffStats(stagedFiles),
    unstagedStats: diffStats(unstagedFiles),
  };
}

/* ------------------------ per-hunk staging (PR-B) ------------------------- */

/**
 * Extract the patch for exactly one hunk — the file's header block plus the hunkIndex-th hunk
 * block — VERBATIM from the raw diff text (no reconstruction from parsed structures, so what git
 * applies is byte-identical to what the client reviewed, including any `\r` inside content lines
 * and the "\ No newline at end of file" markers). Returns null when the file is absent, binary,
 * renamed (its header block carries the whole rename), or the index is out of range.
 */
export function extractHunkPatch(raw: string, filePath: string, hunkIndex: number): string | null {
  const lines = raw.split("\n");
  // File sections start at `diff --git ` lines — unambiguous, since hunk body lines always begin
  // with ' ', '+', '-', or '\' (the parseDiff invariant).
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i]!.startsWith("diff --git ")) starts.push(i);

  // Sections ↔ parsed files are 1:1 in order, and parseDiff owns the path precedence
  // (+++/rename-to/header fallback) — so the file we pick is the one the client's list showed.
  const files = parseDiff(raw);
  const n = files.findIndex((f) => f.path === filePath);
  if (n === -1) return null;
  const file = files[n]!;
  if (file.binary || file.status === "renamed") return null;
  if (hunkIndex < 0 || hunkIndex >= file.hunks.length) return null;

  const sectionEnd = starts[n + 1] ?? lines.length;
  const section = lines.slice(starts[n]!, sectionEnd);
  const hunkStarts: number[] = [];
  for (let i = 0; i < section.length; i++) if (parseHunkHeader(section[i]!) !== null) hunkStarts.push(i);
  if (hunkIndex >= hunkStarts.length) return null;

  // Strip chmod lines (`old mode`/`new mode`) so per-hunk patches are content-only and
  // stage/unstage are true inverses — otherwise every hunk patch would silently stage the mode
  // change and reverse-applying ONE hunk would silently revert a chmod other hunks rely on.
  // (`new file mode`/`deleted file mode` are different prefixes and stay — added/deleted files
  // need them.) Mode changes flow through the Commit-all path instead.
  const headerBlock = section
    .slice(0, hunkStarts[0]!)
    .filter((l) => !l.startsWith("old mode ") && !l.startsWith("new mode "));
  const hunkEnd = hunkStarts[hunkIndex + 1] ?? section.length;
  const hunkBlock = section.slice(hunkStarts[hunkIndex]!, hunkEnd);
  // Cross-check against the parsed hunk so parser/extractor drift is a loud null, never a mis-stage.
  if (hunkBlock[0] !== file.hunks[hunkIndex]!.header) return null;

  const out = [...headerBlock, ...hunkBlock];
  // Drop the trailing "" split artifact (raw ends in \n) so join+`\n` yields exactly one terminator.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

/** Build a valid partial patch from selected +/- source-line indices in one canonical pane hunk.
 * Forward staging must preserve the index preimage: unselected deletions become context and
 * unselected additions disappear. Reverse unstaging mirrors that rule because git matches the
 * patch's new side against the index: unselected additions become context and unselected
 * deletions disappear. Keeping the full applicable preimage makes git apply fail closed on drift. */
export function extractSelectedLinePatch(
  raw: string,
  filePath: string,
  hunkIndex: number,
  lineIndices: readonly number[],
  direction: "stage" | "unstage",
): string | null {
  if (lineIndices.length === 0 || new Set(lineIndices).size !== lineIndices.length) return null;
  const lines = raw.split("\n");
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i]!.startsWith("diff --git ")) starts.push(i);
  const files = parseDiff(raw);
  const fileIndex = files.findIndex((file) => file.path === filePath);
  if (fileIndex < 0) return null;
  const file = files[fileIndex]!;
  if (file.binary || file.status === "renamed" || file.status === "untracked") return null;
  const hunk = file.hunks[hunkIndex];
  if (!hunk || hunk.noNewlineAtEof) return null;
  const selected = new Set(lineIndices);
  if ([...selected].some((index) => index < 0 || index >= hunk.lines.length || hunk.lines[index]!.status === " ")) {
    return null;
  }

  const sectionEnd = starts[fileIndex + 1] ?? lines.length;
  const section = lines.slice(starts[fileIndex]!, sectionEnd);
  const hunkStarts: number[] = [];
  for (let i = 0; i < section.length; i++) if (parseHunkHeader(section[i]!) !== null) hunkStarts.push(i);
  if (hunkIndex >= hunkStarts.length) return null;
  const headerBlock = section
    .slice(0, hunkStarts[0]!)
    .filter((line) => !line.startsWith("old mode ") && !line.startsWith("new mode "));

  const patchLines: string[] = [];
  for (let index = 0; index < hunk.lines.length; index++) {
    const line = hunk.lines[index]!;
    if (line.status === " ") patchLines.push(` ${line.text}`);
    else if (selected.has(index)) patchLines.push(`${line.status}${line.text}`);
    else if (
      (direction === "stage" && line.status === "-") ||
      (direction === "unstage" && line.status === "+")
    ) patchLines.push(` ${line.text}`);
  }
  if (!patchLines.some((line) => line.startsWith("+") || line.startsWith("-"))) return null;
  const oldCount = patchLines.filter((line) => !line.startsWith("+")).length;
  const newCount = patchLines.filter((line) => !line.startsWith("-")).length;
  const range = (start: number, count: number) => count === 1 ? `${start}` : `${start},${count}`;
  const suffix = hunk.header.replace(/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/, "");
  const patchHeader = `@@ -${range(hunk.oldStart, oldCount)} +${range(hunk.newStart, newCount)} @@${suffix}`;
  return [...headerBlock, patchHeader, ...patchLines].join("\n") + "\n";
}

/** Two hunks describe the same change iff their HEAD-side position and content match exactly.
 * The NEW-side numbers are ignored: the worktree diff and the cached diff both use HEAD as the
 * old side, so oldStart/oldCount are stable under partial staging while newStart drifts. */
function hunkMatches(a: GitHunk, b: GitHunk): boolean {
  return (
    a.oldStart === b.oldStart &&
    a.oldCount === b.oldCount &&
    (a.noNewlineAtEof ?? false) === (b.noNewlineAtEof ?? false) &&
    a.lines.length === b.lines.length &&
    a.lines.every((l, i) => l.status === b.lines[i]!.status && l.text === b.lines[i]!.text)
  );
}

/** True when `hunk` of `filePath` exists byte-identically in the index-vs-HEAD diff. */
export function hunkIsStaged(cachedFiles: GitDiffFile[], filePath: string, hunk: GitHunk): boolean {
  const cached = cachedFiles.find((f) => f.path === filePath);
  if (!cached || cached.binary || cached.status === "renamed") return false;
  return cached.hunks.some((c) => hunkMatches(c, hunk));
}

/** Set `staged` on every worktree-diff hunk that exists identically in the cached diff.
 * Conservative: merged-context hunks or post-stage edits read as unstaged, never falsely staged. */
export function markStagedHunks(files: GitDiffFile[], cachedFiles: GitDiffFile[]): void {
  for (const f of files) {
    if (f.binary || f.status === "untracked" || f.status === "renamed") continue;
    for (const h of f.hunks) {
      if (hunkIsStaged(cachedFiles, f.path, h)) h.staged = true;
    }
  }
}

function errMessage(err: unknown): string {
  return err && typeof err === "object" && "message" in err ? String((err as { message: unknown }).message) : String(err);
}

/** First line of a git error's stderr (or message) — the part worth showing a user. */
function firstErrLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  const text = (e.stderr?.trim() || e.message || String(err)).split("\n")[0] ?? "";
  return text;
}

/**
 * Stage or unstage one hunk in the index via `git apply --cached [--reverse]`, guarded by the
 * change-set identity: the uncommitted diff is re-read and must hash to the client's `diffHash`,
 * else GIT_STALE (the UI refetches). Success returns fresh {status, diff} in one round trip.
 */
export async function stageHunk(
  cwd: string,
  action: { direction: "stage" | "unstage"; filePath: string; hunkIndex: number; diffHash: string },
  ctx: GitActionContext,
): Promise<GitActionData> {
  const { raw, hashInput } = await uncommittedRaw(cwd);
  if (computeDiffHash(hashInput) !== action.diffHash) {
    throw new GitOpError("the diff is out of date — the worktree changed since it was loaded", "GIT_STALE");
  }

  // Hash matched, so failures below are client bugs (bad identity), not races — plain errors.
  const files = parseDiff(raw);
  const file = files.find((f) => f.path === action.filePath);
  if (!file) throw new Error("file not found in the current diff (untracked, binary, and mode-only files can't be staged per-hunk)");
  if (file.status === "renamed") {
    throw new Error("staging individual hunks of a renamed file isn't supported yet — use Commit to include the whole rename");
  }
  if (file.binary) throw new Error("binary files can't be staged per-hunk");
  const hunk = file.hunks[action.hunkIndex];
  if (!hunk) throw new Error(`hunk ${action.hunkIndex} not found in ${action.filePath}`);

  const isStaged = hunkIsStaged(await cachedDiffFiles(cwd), action.filePath, hunk);
  if (action.direction === "stage" && isStaged) {
    // Already staged in this exact form — the desired end state holds (double-click, second
    // dashboard). Fall through to the fresh read; no apply.
  } else if (action.direction === "stage" && file.status === "added") {
    // The path may already exist in the index (added earlier, then edited in the worktree) and
    // `git apply --cached` refuses new-file patches for existing index entries. An added file's
    // single hunk IS the whole worktree content, so `git add` stages exactly what the client
    // reviewed (the diffHash guard above pins that content).
    try {
      await git(cwd, ["add", "--", action.filePath]);
    } catch (err) {
      throw new GitOpError(`could not stage ${action.filePath} (${firstErrLine(err)})`, "GIT_APPLY_FAILED");
    }
  } else if (action.direction === "unstage" && !isStaged) {
    // The index may hold a DRIFTED copy of this hunk; silently "succeeding" would leave that
    // content staged while the user believes it's out — noisy-but-honest beats silent wrong belief.
    throw new GitOpError(
      "this hunk isn't currently staged in this exact form — the staged copy may have drifted or was unstaged elsewhere",
      "GIT_APPLY_FAILED",
    );
  } else {
    const patch = extractHunkPatch(raw, action.filePath, action.hunkIndex);
    if (!patch) throw new Error(`could not extract hunk ${action.hunkIndex} of ${action.filePath} from the diff`);
    try {
      // --whitespace=nowarn: a repo/user `apply.whitespace=fix` would otherwise MUTATE the patch.
      // No --recount (headers are verbatim — recount would mask extraction bugs) and no --3way
      // (it would silently merge on stale content instead of failing loudly).
      await git(cwd, ["apply", "--cached", ...(action.direction === "unstage" ? ["--reverse"] : []), "--whitespace=nowarn", "-"], {
        stdin: patch,
      });
    } catch (err) {
      throw new GitOpError(
        `the hunk no longer applies to the index — it may have been staged or changed elsewhere (${firstErrLine(err)})`,
        "GIT_APPLY_FAILED",
      );
    }
  }

  // One round trip refreshes the pane AND the commit row. Mandatory re-read: unstaging an added
  // file's hunk turns it untracked (raw shrinks, manifest grows — the diffHash changes).
  return { status: await gitStatus(cwd), diff: await gitDiff(cwd, "uncommitted", ctx) };
}

/** Stage selected lines from index->worktree, or unstage selected lines from HEAD->index. The
 * canonical pane is re-read and the whole index/worktree identity must still match the UI. */
export async function stageLines(
  cwd: string,
  action: {
    direction: "stage" | "unstage";
    filePath: string;
    hunkIndex: number;
    lineIndices: number[];
    diffHash: string;
  },
  ctx: GitActionContext,
): Promise<GitActionData> {
  const current = await uncommittedRaw(cwd);
  if (computeDiffHash(current.fineHashInput) !== action.diffHash) {
    throw new GitOpError("the diff is out of date — the index or worktree changed since it was loaded", "GIT_STALE");
  }
  const source = action.direction === "stage" ? current.unstagedRaw : current.stagedRaw;
  const sourceFiles = parseDiff(source);
  const file = sourceFiles.find((candidate) => candidate.path === action.filePath);
  const hunk = file?.hunks[action.hunkIndex];
  if (!file || !hunk) throw new Error("the selected hunk is not present in the current canonical diff pane");
  if (file.status !== "modified") {
    throw new Error("line staging is limited to modified files — stage or unstage the whole added/deleted file hunk instead");
  }
  if (hunk.noNewlineAtEof) {
    throw new Error("line staging is unavailable for a hunk with a missing final newline — stage the whole hunk instead");
  }
  const patch = extractSelectedLinePatch(
    source,
    action.filePath,
    action.hunkIndex,
    action.lineIndices,
    action.direction,
  );
  if (!patch) throw new Error("the selected lines are invalid — choose one or more added/removed lines from one hunk");
  try {
    await git(cwd, [
      "apply",
      "--cached",
      ...(action.direction === "unstage" ? ["--reverse"] : []),
      "--whitespace=nowarn",
      "-",
    ], { stdin: patch });
  } catch (err) {
    throw new GitOpError(
      `the selected lines no longer apply to the index (${firstErrLine(err)})`,
      "GIT_APPLY_FAILED",
    );
  }
  return { status: await gitStatus(cwd), diff: await gitDiff(cwd, "uncommitted", ctx) };
}

/** Restore one TRACKED file to HEAD, including the index. The stale hash includes both index and
 * worktree state. Untracked files are rejected because their name-only rows do not review bytes. */
export async function discardFile(
  cwd: string,
  action: { filePath: string; diffHash: string },
  ctx: GitActionContext,
): Promise<GitActionData> {
  const current = await uncommittedRaw(cwd);
  if (computeDiffHash(current.fineHashInput) !== action.diffHash) {
    throw new GitOpError("the diff is out of date — the index or worktree changed since it was loaded", "GIT_STALE");
  }
  const file = parseDiff(current.raw).find((candidate) => candidate.path === action.filePath);
  if (!file) {
    if (current.untracked.some((candidate) => candidate.path === action.filePath)) {
      throw new Error("untracked files cannot be discarded here because their content is not shown — delete the file explicitly in a shell or editor");
    }
    throw new Error("file not found in the current tracked diff");
  }
  try {
    if (file.status === "added") {
      await git(cwd, ["reset", "-q", "HEAD", "--", file.path]);
      // A force-added path may be ignored after reset; plain `clean -f` silently leaves it behind.
      // `-x` is safe here because the exact reviewed path is pinned by the stale hash.
      await git(cwd, ["clean", "-fx", "--", file.path]);
    } else if (file.status === "renamed" && file.oldPath) {
      await git(cwd, ["reset", "-q", "HEAD", "--", file.oldPath, file.path]);
      await git(cwd, ["restore", "--source=HEAD", "--worktree", "--", file.oldPath]);
      await git(cwd, ["clean", "-f", "--", file.path]);
    } else {
      await git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path]);
    }
  } catch (err) {
    throw new GitOpError(`could not discard ${file.path} (${firstErrLine(err)})`, "GIT_APPLY_FAILED");
  }
  return { status: await gitStatus(cwd), diff: await gitDiff(cwd, "uncommitted", ctx) };
}

/** Best-effort mixed reset (index -> HEAD, worktree untouched). Used once per pre-existing
 * session to clear the fully-staged index residue old builds left behind after every turn. */
export async function resetWorktreeIndex(cwd: string): Promise<void> {
  await gitSoft(cwd, ["reset", "-q"]);
}

/**
 * Commit the session's changes. When hunks were staged selectively (index ≠ HEAD) the commit
 * takes ONLY the staged set — a blanket `git add -A` would silently bulldoze the selection.
 * `all` forces the legacy commit-everything path (the UI's "Commit all" escape hatch).
 */
export async function commitAll(cwd: string, message: string, all = false): Promise<GitCommitInfo> {
  if (!message.trim()) throw new Error("a commit message is required");
  let staged = await stagedPaths(cwd);
  const stagedOnly = !all && staged.length > 0;
  if (!stagedOnly) {
    await git(cwd, ["add", "-A"]);
    staged = await stagedPaths(cwd);
    if (staged.length === 0) throw new Error("nothing to commit — the worktree has no changes");
  }
  await git(cwd, ["commit", "-m", message]);
  const sha = (await git(cwd, ["rev-parse", "HEAD"])).trim().slice(0, 10);
  return { sha, message, filesChanged: staged.length, stagedOnly };
}

export async function openPr(cwd: string, opts: { title: string; body: string; branch?: string }): Promise<GitPrInfo> {
  let branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (opts.branch && opts.branch.trim() && opts.branch !== branch) {
    await git(cwd, ["branch", "-m", opts.branch.trim()]);
    branch = opts.branch.trim();
  }
  await git(cwd, ["push", "-u", "origin", branch]);

  // Prefer a real PR via gh; fall back to a prefilled compare URL if gh is absent,
  // unauthenticated, or the repo isn't on GitHub.
  const gh = await tryGhPr(cwd, opts.title, opts.body, branch);
  if (gh) return { url: gh, branch, pushed: true, createdWithGh: true };
  return { url: await compareUrl(cwd, branch), branch, pushed: true, createdWithGh: false };
}

const cleanGitPath = (value: string): string => {
  const normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
};

export interface GitActionSessionMeta {
  repoPath: string;
  worktreePath: string | null;
  worktreePending?: boolean;
  context?: AgentContext;
  lastTurnBaseTree?: string | null;
}

/** Resolve a Git request against runner-owned session metadata before executing anything. The wire
 * path is only a consistency assertion for linked worktrees; it can never select a primary path. */
export function resolveGitActionExecution(
  requestedWorktreePath: string | undefined,
  action: GitAction,
  meta: GitActionSessionMeta | null,
): { cwd: string; context: GitActionContext } {
  if (!meta) throw new Error("git action session metadata is unavailable");
  if (meta.worktreePending && !meta.worktreePath) {
    throw new Error("the session's worktree is still being prepared — try again in a moment");
  }
  if (meta.worktreePath) {
    if (requestedWorktreePath !== undefined &&
        cleanGitPath(requestedWorktreePath) !== cleanGitPath(meta.worktreePath)) {
      throw new Error("git action path does not match runner-owned session metadata");
    }
    return {
      cwd: meta.worktreePath,
      context: {
        useWorktree: true,
        lastTurnBaseTree: meta.lastTurnBaseTree,
        context: meta.context,
      },
    };
  }
  if (requestedWorktreePath !== undefined) {
    throw new Error("a primary-checkout git read cannot supply a caller-selected path");
  }
  if (action.kind !== "status" && action.kind !== "summary") {
    throw new Error("this git action requires a runner-owned linked worktree");
  }
  if (!meta.repoPath) throw new Error("the session has no authoritative repository path");
  return {
    cwd: meta.repoPath,
    context: {
      useWorktree: false,
      lastTurnBaseTree: meta.lastTurnBaseTree,
      context: meta.context,
    },
  };
}

export interface PodReconciliationSessionMeta {
  workspaceId: string | null;
  worktreePath: string | null;
  context?: AgentContext;
}

/** Resolve the two runner-owned worktree paths and execution boundary before any git command.
 * This is deliberately independent of control-plane claims: the box store is authoritative. */
export function validatePodReconciliationMetadata(
  requestedTargetPath: string,
  target: PodReconciliationSessionMeta | null,
  source: PodReconciliationSessionMeta | null,
): { sourceWorktreePath: string; context: AgentContext } {
  if (!target?.worktreePath || cleanGitPath(target.worktreePath) !== cleanGitPath(requestedTargetPath)) {
    throw new Error("target reconciliation path does not match runner-owned session metadata");
  }
  if (!source?.worktreePath) throw new Error("source reconciliation session has no runner-owned worktree");
  if (cleanGitPath(source.worktreePath) === cleanGitPath(target.worktreePath)) {
    throw new Error("pod reconciliation requires distinct source and target worktrees");
  }
  if (!target.workspaceId || source.workspaceId !== target.workspaceId) {
    throw new Error("pod reconciliation requires source and target sessions in the same workspace");
  }
  const targetContext = target.context ?? { kind: "native" };
  const sourceContext = source.context ?? { kind: "native" };
  if (targetContext.kind !== sourceContext.kind ||
      (targetContext.kind === "wsl" && sourceContext.kind === "wsl" && targetContext.distro !== sourceContext.distro)) {
    throw new Error("pod reconciliation requires source and target sessions in the same execution context");
  }
  return { sourceWorktreePath: source.worktreePath, context: targetContext };
}

async function restoreReconciliationTarget(cwd: string, targetHead: string): Promise<void> {
  const mergeHead = (await gitSoft(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).trim();
  if (mergeHead) {
    try {
      await git(cwd, ["merge", "--abort"], { timeoutMs: 120_000 });
    } catch {
      // Fall through to the exact immutable target reset below.
    }
  }
  let restoredHead = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  let restoredStatus = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (restoredHead !== targetHead || restoredStatus) {
    await git(cwd, ["reset", "--hard", targetHead], { timeoutMs: 120_000 });
    await git(cwd, ["clean", "-fd"], { timeoutMs: 120_000 });
    restoredHead = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    restoredStatus = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  }
  if (restoredHead !== targetHead || restoredStatus) {
    throw new Error("reconciliation failed and the target worktree could not be proven restored to its original clean head");
  }
}

/** Merge one runner-owned session worktree into another without ever sharing a writable
 * filesystem. Both worktrees must be clean and backed by the same git common directory. A
 * conflict is fully aborted and verified back at the exact target head before it is reported. */
export async function runPodReconcile(
  targetCwd: string,
  sourceCwd: string,
  action: Extract<GitAction, { kind: "pod_reconcile" }>,
): Promise<NonNullable<GitActionData["podReconciliation"]>> {
  await Promise.all([assertWorktree(targetCwd), assertWorktree(sourceCwd)]);
  if (cleanGitPath(targetCwd) === cleanGitPath(sourceCwd)) {
    throw new Error("pod reconciliation requires distinct source and target worktrees");
  }
  const [targetDirty, sourceDirty, targetCommon, sourceCommon, targetHead, sourceHead] = await Promise.all([
    git(targetCwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(sourceCwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(targetCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(sourceCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(targetCwd, ["rev-parse", "HEAD"]),
    git(sourceCwd, ["rev-parse", "HEAD"]),
  ]);
  if (targetDirty) throw new Error("target member worktree must be clean before reconciliation");
  if (sourceDirty) throw new Error("source member worktree must be clean and committed before reconciliation");
  if (cleanGitPath(targetCommon) !== cleanGitPath(sourceCommon)) {
    throw new Error("pod reconciliation requires source and target worktrees from the same git repository");
  }
  const target = targetHead.trim();
  const source = sourceHead.trim();
  if (!/^[0-9a-f]{40,64}$/.test(target) || !/^[0-9a-f]{40,64}$/.test(source)) {
    throw new Error("pod reconciliation could not resolve immutable source and target heads");
  }
  const mergeBase = (await git(targetCwd, ["merge-base", target, source])).trim();
  try {
    await git(targetCwd, ["merge-base", "--is-ancestor", source, target]);
    return { status: "already_applied", sourceHead: source, targetHead: target, mergeBase, resultHead: target };
  } catch {
    // Non-zero means source is not already contained. Both commits and their common repository
    // were proven above, so continue to the guarded merge.
  }

  try {
    await git(
      targetCwd,
      [
        "-c", "user.name=Wollipog",
        "-c", "user.email=wollipog@localhost",
        "merge", "--no-ff", "--no-edit", "--no-verify", "-m", action.message.slice(0, 240), source,
      ],
      { timeoutMs: 120_000 },
    );
  } catch (error) {
    const conflicts = (await gitSoft(targetCwd, ["diff", "--name-only", "--diff-filter=U", "-z"]))
      .split("\0").filter(Boolean).slice(0, 100);
    await restoreReconciliationTarget(targetCwd, target);
    if (conflicts.length > 0) {
      return { status: "conflicted", sourceHead: source, targetHead: target, mergeBase, conflictPaths: conflicts };
    }
    throw error;
  }

  const resultHead = (await git(targetCwd, ["rev-parse", "HEAD"])).trim();
  const [firstParent, secondParent] = (await git(targetCwd, ["rev-parse", "HEAD^1", "HEAD^2"]))
    .trim().split(/\s+/);
  const finalStatus = await git(targetCwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (firstParent !== target || secondParent !== source || finalStatus) {
    await restoreReconciliationTarget(targetCwd, target);
    throw new Error("reconciliation merge did not produce the expected clean two-parent commit");
  }
  return { status: "applied", sourceHead: source, targetHead: target, mergeBase, resultHead };
}

/** Run a git action and return its typed result. `ctx` carries the session kind (worktree
 * assertion + branch-relative scopes) and the last-turn snapshot tree from the box store. */
export async function runGitAction(cwd: string, action: GitAction, ctx: GitActionContext): Promise<GitActionData> {
  // Only status/summary may inspect a primary checkout. Every diff, review, and mutation keeps the
  // existing linked-worktree boundary even if a caller reaches the runner directly.
  if (ctx.useWorktree) {
    await assertWorktree(cwd);
  } else {
    if (action.kind !== "status" && action.kind !== "summary") {
      throw new Error("this git action requires a runner-owned linked worktree");
    }
    await assertGitRepository(cwd);
  }
  switch (action.kind) {
    case "status":
      return { status: await gitStatus(cwd) };
    case "summary":
      return { summary: await gitSummary(cwd) };
    case "github_review_sync":
      return { githubReview: await githubReviewSync(cwd) };
    case "diff":
      return { diff: await gitDiff(cwd, action.scope, ctx) };
    case "commit": {
      // The button's meaning depends on whether anything is staged ("Commit staged" vs commit-
      // everything). If the index moved since the panel read it (agent's own git add, another
      // dashboard, external reset), refuse instead of committing a different set than promised.
      if (action.all !== true && action.expectStaged !== undefined) {
        const stagedNow = (await stagedPaths(cwd)).length > 0;
        if (stagedNow !== action.expectStaged) {
          throw new GitOpError(
            "the staged set changed since this panel was loaded — refresh and re-check what will be committed",
            "GIT_STALE",
          );
        }
      }
      return { commit: await commitAll(cwd, action.message, action.all === true) };
    }
    case "stage_hunk":
      return await stageHunk(cwd, action, ctx);
    case "stage_lines":
      return await stageLines(cwd, action, ctx);
    case "discard_file":
      return await discardFile(cwd, action, ctx);
    case "pod_reconcile":
      throw new Error("pod reconciliation requires runner-owned source session metadata");
    case "open_pr": {
      // One-click flow: commit any uncommitted changes first, then push + open the PR.
      // Use the explicit commit message when provided, else the PR title.
      const st = await gitStatus(cwd);
      if (st.hasChanges) {
        // A one-click PUBLISH must not guess at a partial stage: committing only the staged
        // subset ships half the work; add -A bulldozes the selection. Refuse with guidance.
        const staged = await stagedPaths(cwd);
        const unstagedDirty = (await gitSoft(cwd, ["diff", "--name-only"])).split("\n").filter(Boolean);
        const untracked = await untrackedFiles(cwd);
        if (staged.length > 0 && (unstagedDirty.length > 0 || untracked.length > 0)) {
          throw new Error(
            "this worktree has a partially staged change-set — press Commit first (it commits only the staged hunks), or stage/commit everything, then open the PR",
          );
        }
        await commitAll(cwd, action.message?.trim() || action.title, staged.length === 0);
      }
      return { pr: await openPr(cwd, action) };
    }
    default: {
      // A version-skewed unknown kind must fail loudly, not return ok:true with empty data —
      // while the `never` keeps compile-time exhaustiveness for known kinds.
      const _exhaustive: never = action;
      throw new Error(`unsupported git action: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/* ------------------------------- helpers --------------------------------- */

/** True if a `git rev-parse --git-dir` result belongs to a linked worktree. */
export function isLinkedWorktreeGitDir(gitDir: string): boolean {
  return /[\\/]worktrees[\\/]/.test(gitDir);
}

/**
 * Throw a clear error unless `cwd` is the session's git worktree. Session worktrees
 * are always *linked* worktrees (`.git/worktrees/<id>`). A fully-removed worktree makes
 * `rev-parse` fail; a partially-removed one (its `.git` link gone, dir left behind)
 * would otherwise resolve up to the parent repo and report the wrong tree as clean —
 * so we also require the resolved git dir to be a linked worktree, not the main repo.
 */
async function assertWorktree(cwd: string): Promise<void> {
  let gitDir: string;
  try {
    if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") throw new Error("not a work tree");
    gitDir = (await git(cwd, ["rev-parse", "--git-dir"])).trim();
  } catch {
    throw new Error("worktree is missing or no longer a git repository — the session's worktree may have been removed");
  }
  if (!isLinkedWorktreeGitDir(gitDir)) {
    throw new Error("the session's worktree is gone — it resolved to a different repository (the worktree was likely removed)");
  }
}

async function assertGitRepository(cwd: string): Promise<void> {
  try {
    const bare = (await git(cwd, ["rev-parse", "--is-bare-repository"])).trim() === "true";
    const authoritativeRoot = bare
      ? (await git(cwd, ["rev-parse", "--absolute-git-dir"])).trim()
      : (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
    if (!authoritativeRoot || cleanGitPath(authoritativeRoot) !== cleanGitPath(cwd)) {
      throw new Error("repository root does not match");
    }
  } catch {
    throw new GitOpError(
      "the session repository is missing, moved, or no longer the authoritative repository root",
      "GIT_NO_REPOSITORY",
    );
  }
}

async function tryGhPr(cwd: string, title: string, body: string, branch: string): Promise<string | null> {
  try {
    const context = executionContext.getStore() ?? { kind: "native" as const };
    const { stdout } = await runContextCommand(context, "gh", ["pr", "create", "--title", title, "--body", body, "--head", branch], {
      cwd,
      timeoutMs: GH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return pickPrUrl(stdout);
  } catch (err) {
    // gh missing/unauth, or a PR already exists (gh prints the existing PR URL to
    // stderr). pickPrUrl only matches a real /pull/<n> URL, so a docs/login/error
    // URL won't be misread as a created PR.
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return pickPrUrl(`${e.stderr ?? ""}\n${e.stdout ?? ""}\n${e.message ?? ""}`);
  }
}

/** The default base ref (e.g. origin/main) for ahead-counts and compare URLs. */
async function defaultBaseRef(cwd: string): Promise<string | null> {
  const head = (await gitSoft(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"])).trim();
  if (head) return head.replace(/^refs\/remotes\//, ""); // origin/main
  return null;
}

async function compareUrl(cwd: string, branch: string): Promise<string> {
  const remote = (await gitSoft(cwd, ["remote", "get-url", "origin"])).trim();
  const slug = githubSlug(remote);
  if (!slug) return remote || "(no GitHub remote configured)";
  const baseRef = (await defaultBaseRef(cwd)) ?? "origin/main";
  const base = baseRef.replace(/^origin\//, "");
  return `https://github.com/${slug}/compare/${base}...${encodeURIComponent(branch)}?expand=1`;
}
