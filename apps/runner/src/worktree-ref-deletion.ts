/**
 * Runner-managed deletion of an isolated session's own refs (#3316).
 *
 * Git takes `packed-refs.lock` in the shared Git directory before it deletes any ref, including a
 * worktree's own `CHERRY_PICK_HEAD` or `AUTO_MERGE` and refs that exist only as loose files. That
 * directory stays read-only inside a protected session, because making it writable would let the
 * sandbox create files host Git reads, such as `commondir` or `config.worktree`. No layout Git
 * supports (2.43 through 2.55) lets the sandbox take that lock without such a write path. So the
 * runner deletes the refs instead, outside the sandbox, and only refs the session owns:
 *
 * - the sequencer leftovers of one of its managed worktrees, as `git cherry-pick --quit` would
 *   clear them, never while a rebase or merge is in progress there;
 * - `refs/heads/<branch>` for a branch the runner recorded for one of its worktrees, only while no
 *   worktree has it checked out or is rebasing it;
 * - `refs/remotes/<remote>/<branch>` for such a branch and a configured remote.
 *
 * Every deletion names the value the caller expects, and one `update-ref --stdin` transaction
 * deletes all of them or none. Host Git runs as plumbing with explicit Git directories, no hooks,
 * no fsmonitor, no global or system config and a minimal environment. Refusals are fixed strings
 * that never echo repository content.
 *
 * The session can still change its writable `refs` and `logs` trees while the runner works, for
 * example by swapping a directory for a symlink after the runner checked it. On Linux the runner's
 * Git therefore runs in its own bubblewrap mount view (`confinedGitRunner`), in which only the shared
 * Git directory's `refs`, `logs`, `packed-refs` and lock files and this worktree's admin directory
 * are writable. A path redirected anywhere else then fails instead of deleting a file there.
 */

import { execFile } from "node:child_process";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { MAX_SESSION_WORKTREE_REF_DELETIONS } from "@wollipog/protocol";

/** Per-worktree refs a stopped cherry-pick, revert or rebase leaves behind. */
export const SEQUENCER_LEFTOVER_REFS = ["CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE"] as const;
export const MAX_WORKTREE_REF_DELETIONS = MAX_SESSION_WORKTREE_REF_DELETIONS;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GIT_TIMEOUT_MS = 30_000;
const SAFE_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
] as const;

export class WorktreeRefDeletionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeRefDeletionRefusal";
  }
}

export interface WorktreeRefDeletionRequest {
  ref: string;
  oldOid: string;
}

export interface WorktreeRefDeletionScope {
  /** The session's recorded worktree the per-worktree refs belong to. */
  worktreePath: string;
  /** Its admin directory, already proved by the caller to be this worktree's registration. */
  worktreeGitDir: string;
  /** The repository's shared Git directory, derived from the runner-recorded repository path. */
  commonGitDir: string;
  /** Branches the runner recorded for the session's runner-created worktrees of this repository. */
  ownedBranches: readonly string[];
}

export interface WorktreeRefDeletionResult {
  deleted: string[];
  /** Requested refs that no longer exist. A repeated call reports them here instead of failing. */
  absent: string[];
}

type Classified =
  | { kind: "sequencer"; ref: string; oldOid: string }
  | { kind: "branch"; ref: string; oldOid: string; branch: string }
  | { kind: "remote"; ref: string; oldOid: string; branch: string; remote: string };

export type GitRunner = (args: readonly string[], options: { env: NodeJS.ProcessEnv; input?: string }) =>
  Promise<{ code: number; stdout: string }>;

function runProcess(command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; input?: string }):
  Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(command, [...args], {
    env: options.env,
    cwd: "/",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    encoding: "utf8",
    }, (error, stdout) => {
      const exitCode = (error as { code?: unknown } | null)?.code;
      resolve({ code: error ? (typeof exitCode === "number" ? exitCode : 1) : 0, stdout: String(stdout ?? "") });
    });
    // A child that exits before reading its input reports through its exit code, not EPIPE.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input);
  });
}

const runGit: GitRunner = (args, options) => runProcess("git", args, options);

/**
 * Git inside a bubblewrap mount view where the whole filesystem is read-only except the shared Git
 * directory's root (for `packed-refs.lock` and the `packed-refs` it renames into place), its `refs`
 * and `logs` trees, and this worktree's admin directory. Every other root entry of the shared Git
 * directory (`config`, `hooks`, `objects`, `HEAD`, ...), every other worktree's admin directory and
 * this one's registration files are bound read-only over it, so they can be neither written nor
 * unlinked. The session can already write `refs` and `logs` itself, so a symlink it plants there can
 * reach nothing through this Git that it could not already change.
 */
export async function confinedGitRunner(scope: WorktreeRefDeletionScope, bwrap: string): Promise<GitRunner> {
  const common = scope.commonGitDir;
  const args = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
    "--bind", common, common,
  ];
  for (const entry of await readdir(common)) {
    if (entry === "refs" || entry === "logs" || entry === "packed-refs") continue;
    args.push("--ro-bind", join(common, entry), join(common, entry));
  }
  args.push("--bind", scope.worktreeGitDir, scope.worktreeGitDir);
  for (const name of ["gitdir", "commondir", "config.worktree"]) {
    const path = join(scope.worktreeGitDir, name);
    if (await exists(path)) args.push("--ro-bind", path, path);
  }
  args.push("--chdir", "/", "--", "git");
  return (gitArgs, options) => runProcess(bwrap, [...args, ...gitArgs], options);
}

/** The first executable `bwrap` on PATH, or undefined. */
export async function findBubblewrap(path = process.env.PATH ?? ""): Promise<string | undefined> {
  for (const directory of path.split(":")) {
    if (!posix.isAbsolute(directory)) continue;
    const candidate = join(directory, "bwrap");
    try {
      const entry = await stat(candidate);
      if (entry.isFile() && (entry.mode & 0o111) !== 0) return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** Only the names of the refs the session asked for leave this module, and only once validated. */
export function validateWorktreeRefDeletionRequests(value: unknown): WorktreeRefDeletionRequest[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WORKTREE_REF_DELETIONS) {
    throw new WorktreeRefDeletionRefusal(`name between 1 and ${MAX_WORKTREE_REF_DELETIONS} refs to delete`);
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const ref = (entry as { ref?: unknown } | null)?.ref;
    const oldOid = (entry as { oldOid?: unknown } | null)?.oldOid;
    if (typeof ref !== "string" || !ref || ref.length > 1024 || typeof oldOid !== "string" || !OBJECT_ID.test(oldOid)) {
      throw new WorktreeRefDeletionRefusal("each ref needs a name and its expected full object id");
    }
    if (seen.has(ref)) throw new WorktreeRefDeletionRefusal("a ref is named more than once");
    seen.add(ref);
    return { ref, oldOid };
  });
}

function gitEnvironment(scope: WorktreeRefDeletionScope): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_DIR: scope.worktreeGitDir,
    GIT_COMMON_DIR: scope.commonGitDir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function configuredRemotes(git: GitRunner, env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const result = await git([...SAFE_CONFIG, "config", "--null", "--name-only", "--get-regexp", "^remote\\..+\\.url$"], { env });
  // Exit 1 means no remote is configured.
  if (result.code !== 0 && result.code !== 1) throw new WorktreeRefDeletionRefusal("the repository's remotes could not be read");
  const remotes = new Set<string>();
  for (const name of result.stdout.split("\0")) {
    if (name.startsWith("remote.") && name.endsWith(".url")) remotes.add(name.slice("remote.".length, -".url".length));
  }
  return remotes;
}

function classify(request: WorktreeRefDeletionRequest, owned: ReadonlySet<string>, remotes: ReadonlySet<string>): Classified {
  const { ref, oldOid } = request;
  if ((SEQUENCER_LEFTOVER_REFS as readonly string[]).includes(ref)) return { kind: "sequencer", ref, oldOid };
  if (ref.startsWith("refs/heads/") && owned.has(ref.slice("refs/heads/".length))) {
    return { kind: "branch", ref, oldOid, branch: ref.slice("refs/heads/".length) };
  }
  if (ref.startsWith("refs/remotes/")) {
    const rest = ref.slice("refs/remotes/".length);
    for (const remote of remotes) {
      const branch = rest.startsWith(`${remote}/`) ? rest.slice(remote.length + 1) : undefined;
      if (branch && owned.has(branch)) return { kind: "remote", ref, oldOid, branch, remote };
    }
  }
  throw new WorktreeRefDeletionRefusal(
    "only this worktree's CHERRY_PICK_HEAD, REVERT_HEAD and AUTO_MERGE, and refs/heads/<branch> or " +
    "refs/remotes/<remote>/<branch> for a branch recorded for this session's worktrees, can be deleted",
  );
}

/** A worktree is busy with a branch while it has it checked out or is rebasing it. */
async function branchInUse(commonGitDir: string, branch: string): Promise<boolean> {
  const target = `refs/heads/${branch}`;
  const adminDirs = [commonGitDir];
  try {
    for (const entry of await readdir(join(commonGitDir, "worktrees"), { withFileTypes: true })) {
      if (entry.isDirectory()) adminDirs.push(join(commonGitDir, "worktrees", entry.name));
    }
  } catch {
    // No linked worktrees.
  }
  for (const admin of adminDirs) {
    for (const file of ["HEAD", "rebase-merge/head-name", "rebase-apply/head-name", "BISECT_START"]) {
      let content: string;
      try {
        content = (await readFile(join(admin, file), "utf8")).trim();
      } catch {
        continue;
      }
      if (content === `ref: ${target}` || content === target || (file === "BISECT_START" && content === branch)) return true;
    }
  }
  return false;
}

/** Host Git follows a directory symlink inside the session-writable `refs` and `logs` trees, so a
 * path the sandbox redirected must be refused before Git runs, not after. */
async function assertPlainRefPath(root: string, relative: string): Promise<void> {
  const parts = relative.split("/");
  let current = root;
  const rootEntry = await lstat(root).catch(() => null);
  if (rootEntry && (!rootEntry.isDirectory() || rootEntry.isSymbolicLink())) {
    throw new WorktreeRefDeletionRefusal("a ref's storage path is not a plain file or directory");
  }
  if (!rootEntry) return;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    const entry = await lstat(current).catch(() => null);
    if (!entry) return;
    const last = index === parts.length - 1;
    if (entry.isSymbolicLink() || (last ? !entry.isFile() : !entry.isDirectory())) {
      throw new WorktreeRefDeletionRefusal("a ref's storage path is not a plain file or directory");
    }
  }
}

/** The exact ref's value, or undefined when it is gone. Never a revision lookup: `rev-parse` would
 * also accept `refs/heads/AUTO_MERGE` for `AUTO_MERGE`. A sequencer leftover is a file in the
 * worktree's admin directory, already proved to be a plain file. */
async function currentValue(
  git: GitRunner,
  env: NodeJS.ProcessEnv,
  scope: WorktreeRefDeletionScope,
  entry: Classified,
): Promise<string | undefined> {
  if (entry.kind === "sequencer") {
    let content: string;
    try {
      content = (await readFile(join(scope.worktreeGitDir, entry.ref), "utf8")).trim();
    } catch {
      return undefined;
    }
    if (!OBJECT_ID.test(content)) throw new WorktreeRefDeletionRefusal(`${entry.ref} does not hold an object id`);
    return content;
  }
  const result = await git([...SAFE_CONFIG, "for-each-ref", "--format=%(refname)%00%(objectname)", entry.ref], { env });
  if (result.code !== 0) throw new WorktreeRefDeletionRefusal("the session's refs could not be read");
  for (const line of result.stdout.split("\n")) {
    const [name, value] = line.split("\0");
    if (name === entry.ref) return value;
  }
  return undefined;
}

export async function deleteOwnedWorktreeRefs(
  scope: WorktreeRefDeletionScope,
  requests: readonly WorktreeRefDeletionRequest[],
  git: GitRunner = runGit,
): Promise<WorktreeRefDeletionResult> {
  if (!posix.isAbsolute(scope.worktreeGitDir) || !posix.isAbsolute(scope.commonGitDir) ||
      posix.dirname(scope.worktreeGitDir) !== posix.join(scope.commonGitDir, "worktrees")) {
    throw new WorktreeRefDeletionRefusal("the worktree's Git registration could not be verified");
  }
  const env = gitEnvironment(scope);
  const owned = new Set(scope.ownedBranches.filter((branch) => branch.length > 0));
  const needsRemotes = requests.some((request) => request.ref.startsWith("refs/remotes/"));
  const remotes = needsRemotes ? await configuredRemotes(git, env) : new Set<string>();
  const classified = requests.map((request) => classify(request, owned, remotes));

  if (classified.some((entry) => entry.kind === "sequencer")) {
    for (const marker of ["rebase-merge", "rebase-apply", "MERGE_HEAD"]) {
      if (await exists(join(scope.worktreeGitDir, marker))) {
        throw new WorktreeRefDeletionRefusal(
          "a rebase or merge is in progress in this worktree; finish or abort it before clearing its refs",
        );
      }
    }
    if (await exists(join(scope.worktreeGitDir, "sequencer"))) {
      throw new WorktreeRefDeletionRefusal(
        "a cherry-pick or revert sequence is in progress in this worktree; run git cherry-pick --quit " +
        "(or --abort) there first, then delete the refs it could not remove",
      );
    }
  }
  for (const entry of classified) {
    if (entry.kind === "branch" && await branchInUse(scope.commonGitDir, entry.branch)) {
      throw new WorktreeRefDeletionRefusal(`${entry.ref} is checked out or being rebased in a worktree`);
    }
  }
  for (const entry of classified) {
    if (entry.kind === "sequencer") {
      await assertPlainRefPath(scope.worktreeGitDir, entry.ref);
      await assertPlainRefPath(join(scope.worktreeGitDir, "logs"), entry.ref);
    } else {
      await assertPlainRefPath(join(scope.commonGitDir, "refs"), entry.ref.slice("refs/".length));
      await assertPlainRefPath(join(scope.commonGitDir, "logs", "refs"), entry.ref.slice("refs/".length));
    }
  }

  const deleted: string[] = [];
  const absent: string[] = [];
  const lines: string[] = [];
  for (const entry of classified) {
    const current = await currentValue(git, env, scope, entry);
    if (current === undefined) {
      absent.push(entry.ref);
      continue;
    }
    if (current !== entry.oldOid) {
      throw new WorktreeRefDeletionRefusal(`${entry.ref} no longer has the expected value; nothing was deleted`);
    }
    lines.push(`delete ${entry.ref} ${entry.oldOid}\n`);
    deleted.push(entry.ref);
  }
  if (lines.length) {
    const result = await git([...SAFE_CONFIG, "update-ref", "--no-deref", "--stdin"], { env, input: lines.join("") });
    if (result.code !== 0) {
      throw new WorktreeRefDeletionRefusal("Git refused the deletion, for example because a ref changed; nothing was deleted");
    }
  }
  return { deleted, absent };
}
