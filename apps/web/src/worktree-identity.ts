import type { SessionWorktreeView } from "@wollipog/protocol";

export type WorktreePullRequestState = NonNullable<SessionWorktreeView["pullRequest"]>["state"];

/** Title Case state label for a worktree's linked pull request. */
export function pullRequestStateLabel(state: WorktreePullRequestState): string {
  return state === "open" ? "Open" : state === "merged" ? "Merged" : "Closed";
}

/**
 * Conventional default-branch names, matched after remote and ref prefixes are stripped.
 *
 * The protocol carries no repository default branch — `SessionWorktreeView` records only the ref
 * the caller passed at creation — and #664 is a web-only change, so the Inbox decides by name.
 * A repository whose default branch is something else keeps showing its base ref, which is the
 * safe direction to be wrong in: the row states more than it must, never less.
 */
const CONVENTIONAL_DEFAULT_BRANCHES = new Set(["main", "master"]);

/** Remote prefixes stripped before the name comparison. Anything else is left intact. */
const CONVENTIONAL_REMOTES = ["origin/", "upstream/"];

export function isConventionalDefaultBaseRef(baseRef: string): boolean {
  let name = baseRef.trim();
  if (name.startsWith("refs/heads/")) name = name.slice("refs/heads/".length);
  else if (name.startsWith("refs/remotes/")) name = name.slice("refs/remotes/".length);
  for (const remote of CONVENTIONAL_REMOTES) {
    if (name.startsWith(remote)) {
      name = name.slice(remote.length);
      break;
    }
  }
  return CONVENTIONAL_DEFAULT_BRANCHES.has(name);
}

/**
 * The base ref worth showing beside a branch, or null when it says nothing.
 *
 * Nearly every session branches from the default branch, so printing "← origin/main" on every row
 * spends the Inbox's scarcest resource — line width — on the one fact the reader already assumes.
 */
export function displayBaseRef(worktree: Pick<SessionWorktreeView, "baseRef">): string | null {
  const baseRef = worktree.baseRef?.trim();
  if (!baseRef) return null;
  return isConventionalDefaultBaseRef(baseRef) ? null : baseRef;
}
