/** What the commit bar was doing when Git failed: committing, or pushing to open or update a request. */
export type GitFailureAction = "commit" | "push";

/** A failed Git action in user terms: one sentence for the notice, the runner's words for Show Details. */
export interface GitFailure {
  sentence: string;
  /** The runner's own error text, shown only behind Show Details (§13.2, §17.2). */
  detail: string;
}

/**
 * The Git failures a person can act on, matched on the words Git and the runner print. Each says
 * what happened and what to do, in one sentence (docs/design-system.md §12.4, §17.2). Order matters:
 * a push refused by a hook also prints "failed to push some refs", so the remote's own refusal is
 * matched before the out-of-date case.
 */
const KNOWN_FAILURES: readonly { pattern: RegExp; sentence: (request: string) => string }[] = [
  {
    pattern: /partially staged change-set/i,
    sentence: (request) => `Some changes are staged and some aren't. Commit the staged changes first, then open the ${request}.`,
  },
  {
    pattern: /nothing to commit/i,
    sentence: () => "There's nothing to commit.",
  },
  {
    pattern: /no such remote|does not appear to be a git repository|no configured push destination/i,
    sentence: () => "This branch has no remote to push to. Add a remote named origin, then try again.",
  },
  {
    pattern: /authentication failed|permission denied \(publickey|could not read (username|password)|terminal prompts disabled|invalid username or password|returned error: 403|http 403/i,
    sentence: () => "Git couldn't sign in to the remote. Check this machine's Git credentials, then try again.",
  },
  {
    pattern: /\[remote rejected\]|pre-receive hook declined|protected branch/i,
    sentence: () => "The remote refused the push. Show Details has its reason.",
  },
  {
    pattern: /\[rejected\]|non-fast-forward|updates were rejected|fetch first|failed to push some refs/i,
    sentence: () => "The remote rejected the push because it has commits this branch doesn't. Bring the branch up to date, then try again.",
  },
];

/** Rewrite a failed commit or push for the commit bar, keeping the raw output for Show Details. */
export function describeGitFailure(
  action: GitFailureAction,
  message: string,
  requestName = "Pull Request",
): GitFailure {
  const request = requestName.toLowerCase();
  const known = KNOWN_FAILURES.find((failure) => failure.pattern.test(message));
  if (known) return { sentence: known.sentence(request), detail: message };
  return {
    sentence: action === "commit" ? "Couldn't commit the changes. Try again." : "Couldn't push the branch. Try again.",
    detail: message,
  };
}
