/**
 * GitHub closing-keyword references (#3713).
 *
 * GitHub closes an issue when a merged pull request's description, or a commit that lands on the
 * default branch, puts a closing keyword directly before the issue's reference. The sentence
 * around it does not matter: "This PR does not close #12" and "must not auto-close #12" both
 * close #12. This matcher follows GitHub's rules where they are known and reports a reference
 * wherever they are not, because a false report costs a reworded sentence and a missed one closes
 * an issue that must stay open.
 */

/** GitHub's documented closing keywords, matched without regard to case. */
export const GITHUB_CLOSING_KEYWORDS = [
  "close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved",
] as const;

export interface ClosingReference {
  /** `owner/repo#N`, with the repository lowercased as GitHub compares it. */
  issue: string;
  /** The keyword as written, e.g. `Closes`. */
  keyword: string;
  /** Offset of the keyword in the scanned text. */
  index: number;
  /** One bounded line of the text around the reference, for showing where it is. */
  excerpt: string;
}

const OWNER = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})`;
const NAME = String.raw`[A-Za-z0-9._-]{1,100}`;
const NUMBER = String.raw`([0-9]{1,10})`;
const END = String.raw`(?![\p{L}\p{N}_])`;
/** A reference GitHub resolves to an issue: `#N`, `GH-N`, `owner/repo#N`, or an issue URL. */
const REFERENCE = String.raw`(?:#${NUMBER}|[Gg][Hh]-${NUMBER}|(${OWNER})\/(${NAME})#${NUMBER}|` +
  String.raw`https?:\/\/(?:www\.)?github\.com\/(${OWNER})\/(${NAME})\/(?:issues|pull)\/${NUMBER})${END}`;
/** The keyword starts a word (so `auto-close` counts and `disclose` does not), may take a colon,
 * and may be wrapped in Markdown emphasis on either side of the space before the reference. */
const CLOSING = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?![\p{L}\p{N}_])` +
  String.raw`[*_]*:?[*_]*[ \t]*(?:\r?\n[ \t]*)?[*_]*${REFERENCE}`,
  "giu",
);

const ISSUE_REFERENCE = new RegExp(String.raw`^(?:#${NUMBER}|(${OWNER})\/(${NAME})#${NUMBER}|` +
  String.raw`https?:\/\/(?:www\.)?github\.com\/(${OWNER})\/(${NAME})\/(?:issues|pull)\/${NUMBER}\/?)$`, "u");
const REPOSITORY = new RegExp(String.raw`^${OWNER}\/${NAME}$`, "u");

function issue(repository: string, number: string): string | null {
  const value = Number(number);
  return Number.isSafeInteger(value) && value > 0 ? `${repository.toLowerCase()}#${value}` : null;
}

/** `owner/repo#N` for `#N` (in `repository`), `owner/repo#N`, or a GitHub issue URL; else null. */
export function canonicalIssueReference(value: string, repository?: string): string | null {
  const match = ISSUE_REFERENCE.exec(value.trim());
  if (!match) return null;
  if (match[1] !== undefined) return repository && REPOSITORY.test(repository) ? issue(repository, match[1]) : null;
  if (match[4] !== undefined) return issue(`${match[2]}/${match[3]}`, match[4]);
  return issue(`${match[5]}/${match[6]}`, match[7]!);
}

function excerpt(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", end);
  const lineEnd = newline < 0 ? text.length : newline;
  const from = Math.max(lineStart, start - 60);
  const to = Math.min(lineEnd, end + 40);
  const line = text.slice(from, to).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return `${from > lineStart ? "…" : ""}${line}${to < lineEnd ? "…" : ""}`;
}

/** Every closing reference in `text`, in order; `#N` and `GH-N` name issues in `repository`. */
export function findClosingReferences(text: string, repository: string): ClosingReference[] {
  if (!REPOSITORY.test(repository)) throw new Error("repository must be owner/name");
  const found: ClosingReference[] = [];
  for (const match of text.matchAll(CLOSING)) {
    const [, keyword, local, gh, owner, name, number, urlOwner, urlName, urlNumber] = match;
    const target = (local ?? gh) !== undefined
      ? issue(repository, (local ?? gh)!)
      : owner !== undefined ? issue(`${owner}/${name}`, number!) : issue(`${urlOwner}/${urlName}`, urlNumber!);
    if (!target) continue;
    found.push({ issue: target, keyword: keyword!, index: match.index,
      excerpt: excerpt(text, match.index, match.index + match[0].length) });
  }
  return found;
}
