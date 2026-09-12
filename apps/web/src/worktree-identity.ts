import type { SessionView, SessionWorktreeView } from "@wollipog/protocol";

export type WorktreePullRequestState = NonNullable<SessionWorktreeView["pullRequest"]>["state"];

/** Title Case state label for a worktree's linked pull request. */
export function pullRequestStateLabel(state: WorktreePullRequestState): string {
  return state === "open" ? "Open" : state === "merged" ? "Merged" : "Closed";
}

/**
 * Conventional default-branch names, used ONLY when the repository's real default is unknown.
 *
 * #664 shipped this list as the whole answer, because nothing carried the repository's default
 * branch. #679 put `defaultBranch` on `SessionWorktreeView`, so the list is now a fallback for the
 * two cases that still have no answer: a runner older than that field, and a repository with no
 * locally recorded remote HEAD. Guessing beats printing a base ref on every row, but only barely —
 * it is wrong in both directions, and `develop`-default repositories are exactly who it fails.
 */
const CONVENTIONAL_DEFAULT_BRANCHES = new Set(["main", "master"]);

/** Remote prefixes stripped before a name comparison. Anything else is left intact. */
const CONVENTIONAL_REMOTES = ["origin/", "upstream/"];

/** Strips only the ref namespaces Git itself defines, never a branch name's own slashes. */
function withoutRefNamespace(ref: string): string {
  const name = ref.trim();
  if (name.startsWith("refs/heads/")) return name.slice("refs/heads/".length);
  if (name.startsWith("refs/remotes/")) return name.slice("refs/remotes/".length);
  return name;
}

export function isConventionalDefaultBaseRef(baseRef: string): boolean {
  let name = withoutRefNamespace(baseRef);
  for (const remote of CONVENTIONAL_REMOTES) {
    if (name.startsWith(remote)) {
      name = name.slice(remote.length);
      break;
    }
  }
  return CONVENTIONAL_DEFAULT_BRANCHES.has(name);
}

/**
 * Whether a base ref names the repository's known default branch.
 *
 * Compares against the exact spellings Git produces for one branch rather than stripping a leading
 * path segment: a branch legitimately named `release/2027-hardening` must not be reduced to
 * `2027-hardening` on the way to a comparison.
 */
export function matchesDefaultBranch(baseRef: string, defaultBranch: string): boolean {
  const name = withoutRefNamespace(baseRef);
  if (name === defaultBranch) return true;
  return CONVENTIONAL_REMOTES.some((remote) => name === `${remote}${defaultBranch}`);
}

/**
 * The base ref worth showing beside a branch, or null when it says nothing.
 *
 * Nearly every session branches from the default branch, so printing "← origin/main" on every row
 * spends the Inbox's scarcest resource — line width — on the one fact the reader already assumes.
 * When the worktree reports its repository's default branch we compare against that; when it does
 * not, we fall back to the conventional-name guess, so an older runner degrades to #664's
 * behaviour rather than changing what the row claims.
 */
export function displayBaseRef(
  worktree: Pick<SessionWorktreeView, "baseRef" | "defaultBranch">,
): string | null {
  const baseRef = worktree.baseRef?.trim();
  if (!baseRef) return null;
  const defaultBranch = worktree.defaultBranch?.trim();
  if (defaultBranch) return matchesDefaultBranch(baseRef, defaultBranch) ? null : baseRef;
  return isConventionalDefaultBaseRef(baseRef) ? null : baseRef;
}

/**
 * What a session card can honestly say about its Git branch (#782).
 *
 * Three states, not two. A row that simply omitted the branch could not be read: "this session has
 * no branch" and "nobody told us this session's branch" looked identical, and both looked like a
 * shorter card. `worktrees` is an additive projection, so a session can hold an active worktree
 * whose identity never reached the client — that is `unknown`, never `none`.
 */
export type SessionBranchState =
  | { kind: "branch"; worktree: SessionWorktreeView }
  | { kind: "none" }
  | { kind: "unknown" };

export function sessionBranchState(
  session: Pick<SessionView, "worktrees" | "worktreePath" | "useWorktree">,
): SessionBranchState {
  if (session.worktreePath) {
    const worktree = session.worktrees?.find((candidate) => candidate.path === session.worktreePath);
    // An active worktree whose entry is missing: an older runner, or a projection that dropped the
    // inventory. The session HAS a branch; we just cannot name it.
    return worktree ? { kind: "branch", worktree } : { kind: "unknown" };
  }
  // Requested but not yet materialised, or materialisation failed. Either way the branch it will
  // work on is not decided yet, so claiming "No Branch" would be a claim we cannot support.
  if (session.useWorktree) return { kind: "unknown" };
  return { kind: "none" };
}

/** Title Case label for the Git state shown on a session card's third line. */
export function branchStateLabel(state: SessionBranchState): string {
  if (state.kind === "branch") return state.worktree.branch;
  return state.kind === "none" ? "No Branch" : "Branch Unavailable";
}
