import { normalize, resolve } from "node:path";
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
  }
  return [...paths];
}
