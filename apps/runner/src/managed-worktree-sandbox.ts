import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ManagedWorktreeProtection } from "./managed-worktree-protection.js";

/**
 * Entries inside a runner-owned worktree that belong to the runner rather than to the provider.
 *
 * `.git` is the worktree's link file. Git reads it to find the real administrative directory and
 * never rewrites it, so denying writes costs an ordinary edit, commit, branch switch, or test run
 * nothing — while a damaged link breaks every later Git operation and the session's pre-launch
 * verification, from inside a worktree whose contents must stay writable.
 */
export const RUNNER_OWNED_WORKTREE_ENTRIES = [".git"] as const;

function samePath(left: string, right: string): boolean {
  const foldCase = process.platform === "win32" || process.platform === "darwin";
  const normalized = (value: string) => foldCase ? normalize(value).toLowerCase() : normalize(value);
  return normalized(left) === normalized(right);
}

function childOf(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function linkedWorktreeGitLayout(
  worktreePath: string,
  repoPath: string,
): { commonGitDir: string; worktreeGitDir: string } | null {
  if (!isAbsolute(worktreePath) || !isAbsolute(repoPath) || samePath(worktreePath, repoPath)) return null;
  try {
    const commonGitDir = realpathSync.native(resolve(repoPath, ".git"));
    const pointer = readFileSync(resolve(worktreePath, ".git"), "utf8");
    const match = /^gitdir: (.+?)\r?\n?$/u.exec(pointer);
    if (!match) return null;
    const worktreeGitDir = realpathSync.native(resolve(worktreePath, match[1]!));
    const worktreeRegistry = realpathSync.native(join(commonGitDir, "worktrees"));
    return childOf(worktreeRegistry, worktreeGitDir) ? { commonGitDir, worktreeGitDir } : null;
  } catch {
    return null;
  }
}

/**
 * Absolute paths a sandbox should present read-only while the rest of each managed worktree stays
 * writable. Attached operator worktrees never reach this list: the caller derives `protections`
 * from runner-created identities only, exactly as the command-approval boundary does.
 */
export function managedWorktreeReadOnlyPaths(
  protections: readonly ManagedWorktreeProtection[],
): string[] {
  const paths = new Set<string>();
  for (const { worktreePath, repoPath } of protections) {
    // A protection whose worktree IS the checkout points `.git` at the repository's shared
    // administrative directory, which Git writes to constantly. That directory keeps exactly the
    // protection it already has at the command boundary and gains none here.
    if (samePath(worktreePath, repoPath)) continue;
    for (const entry of RUNNER_OWNED_WORKTREE_ENTRIES) paths.add(resolve(worktreePath, entry));
    const layout = linkedWorktreeGitLayout(worktreePath, repoPath);
    if (!layout) continue;
    // The provider needs the admin directory writable for Git's index/HEAD lock-and-rename
    // protocol, but these registration files are inputs to later unsandboxed runner Git calls and
    // are never mutated by staging, commits, status, or branch switches. Reopen them read-only
    // beneath that writable directory. Include per-worktree config when it already exists: Git may
    // read it during runner-side status, and a provider must not turn that read into code execution.
    for (const name of ["gitdir", "commondir", "config.worktree"] as const) {
      const path = join(layout.worktreeGitDir, name);
      if (!existsSync(path)) continue;
      try {
        if (!lstatSync(path).isFile() || !samePath(realpathSync.native(path), path)) continue;
        paths.add(path);
      } catch {
        // A raced or non-regular registration entry gets no new filesystem authority.
      }
    }
  }
  return [...paths];
}

/**
 * Extra roots Codex's own workspace sandbox needs for ordinary Git operations in the selected
 * linked worktree. The worktree contents are already writable through `cwd`, but Git follows its
 * read-only `.git` link into the repository's shared administrative directory for the index,
 * objects, refs, and logs.
 *
 * Codex also derives a more-specific read-only rule for the `.git` pointer's target, so reopening
 * the whole common directory is both broader than necessary and insufficient. Grant only the
 * exact linked-worktree admin directory plus the common objects, refs, and logs descendants used
 * by ordinary stage/commit/checkout operations. Never grant `repoPath` or the common `.git` root:
 * primary-checkout files and unrelated host paths must stay outside the provider's workspace. A
 * protection for another managed worktree is a lifecycle guard, not authority for this cwd.
 */
export function managedWorktreeGitWritableRoots(
  cwd: string,
  protections: readonly ManagedWorktreeProtection[],
): string[] {
  if (!isAbsolute(cwd)) return [];
  const roots = new Set<string>();
  for (const { worktreePath, repoPath } of protections) {
    if (!isAbsolute(worktreePath) || !isAbsolute(repoPath) ||
        !samePath(cwd, worktreePath) || samePath(worktreePath, repoPath)) continue;
    try {
      const layout = linkedWorktreeGitLayout(worktreePath, repoPath);
      if (!layout) continue;
      const { commonGitDir, worktreeGitDir } = layout;
      // The pointer is protected but still untrusted path data at this boundary. Only the exact
      // registered worktree admin directory and existing canonical descendants of the common Git
      // directory may reopen beneath Codex's automatic linked-worktree read-only carveout.
      const candidateRoots = [worktreeGitDir];
      for (const name of ["objects", "refs", "logs"] as const) {
        const path = realpathSync.native(join(commonGitDir, name));
        if (!childOf(commonGitDir, path)) throw new Error("Git metadata path escapes its common directory");
        candidateRoots.push(path);
      }
      for (const path of candidateRoots) roots.add(path);
    } catch {
      // Missing, malformed, or escaping Git metadata is not a reason to broaden sandbox access.
      continue;
    }
  }
  return [...roots];
}
