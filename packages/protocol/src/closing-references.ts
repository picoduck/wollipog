/**
 * GitHub closing-keyword references (#3713).
 *
 * GitHub closes an issue when a merged pull request's description puts a closing keyword directly
 * before the issue's reference, whatever the sentence around it says: "This PR does not close #12"
 * and "must not auto-close #12" both close #12, and "does not resolve #12's cause" closes it too.
 * The rules below were measured against GitHub's own `closingIssuesReferences` on a draft pull
 * request (2026-10-27). Where GitHub's behavior is unknown the matcher reports the reference: a
 * false report costs a reworded sentence, while a missed one closes an issue that must stay open.
 *
 * Measured as closing: any keyword case, a colon after the keyword (`Closes: #12`, `closes : #12`),
 * spaces or a tab before the reference, `#12`, `GH-12`, `owner/repo#12`, an `https` issue or pull
 * URL, a Markdown link to one (`closes [the issue](https://github.com/o/r/issues/12)`) or whose
 * text is one, `\#12`, `#12's`, `#12-part`, `#12.5`, and every block (heading, list, table, quote,
 * HTML) outside code. Measured as not closing: inline code, fenced and indented code blocks, HTML
 * comments, a line break or no-break space between keyword and reference, no space at all
 * (`closes#12`, `closes:#12`), `closes (#12)`, emphasis that ends between the two
 * (`**Closes:** #12`, `_closes_ #12`), a keyword that is itself a link, `http` URLs, `#12_x`, a
 * second reference after one keyword (`Closes #11, #12` closes only #11), and the title.
 * Indented code and `#12_x` are still reported, as the simpler rule; neither is common.
 */

/** GitHub's documented closing keywords, matched without regard to case. */
export const GITHUB_CLOSING_KEYWORDS = [
  "close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved",
] as const;

/** The longest excerpt a finding carries, so every consumer can accept what the matcher produces. */
export const CLOSING_REFERENCE_EXCERPT_MAX = 240;

export interface ClosingReference {
  /** `owner/repo#N`, with the repository lowercased as GitHub compares it. */
  issue: string;
  /** The keyword as written, e.g. `Closes`. */
  keyword: string;
  /** Offset of the keyword in the scanned text. */
  index: number;
  /** One bounded line of the text around the reference, for showing the author where it is. */
  excerpt: string;
}

const OWNER = String.raw`[A-Za-z0-9][A-Za-z0-9-]{0,38}`;
const NAME = String.raw`[A-Za-z0-9._-]{1,100}`;
const NUMBER = String.raw`[0-9]{1,10}`;
const URL = String.raw`https:\/\/(?:www\.)?github\.com\/${OWNER}\/${NAME}\/(?:issues|pull)\/${NUMBER}`;
/** A keyword that starts a word (so `auto-close` counts and `disclose` does not), then a space or a
 * tab, optionally around a colon. */
const KEYWORD = /(?<![\p{L}\p{N}])(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?![\p{L}\p{N}_])(?:[ \t]+(?::[ \t]*)?|:[ \t]+)/giu;
/** What may follow it: a plain reference, an autolinked URL, or a Markdown inline link. */
const TARGET = new RegExp(String.raw`(?:\\?#${NUMBER}|gh-${NUMBER}|${OWNER}\/${NAME}#${NUMBER}|<?${URL}|` +
  String.raw`\[[^\]\n]{0,256}\]\(<?[^)\s>]{0,2048}>?(?:[ \t]+"[^"\n]{0,256}")?\))(?![\p{L}\p{N}])`, "iuy");
const LINK = /^\[([^\]\n]*)\]\(<?([^)\s>]*)>?/u;
const REPOSITORY = new RegExp(String.raw`^${OWNER}\/${NAME}$`, "u");
const PLAIN = new RegExp(String.raw`^(?:#(${NUMBER})|gh-(${NUMBER}))$`, "iu");
const QUALIFIED = new RegExp(String.raw`^(${OWNER}\/${NAME})#(${NUMBER})$`, "u");
const ISSUE_URL = new RegExp(String.raw`^https:\/\/(?:www\.)?github\.com\/(${OWNER}\/${NAME})\/(?:issues|pull)\/(${NUMBER})(?:[/?#].*)?$`, "iu");

function issue(repository: string, number: string): string | null {
  const value = Number(number);
  return Number.isSafeInteger(value) && value > 0 ? `${repository.toLowerCase()}#${value}` : null;
}

function reference(value: string, repository: string | undefined): string | null {
  const plain = PLAIN.exec(value);
  if (plain) return repository && REPOSITORY.test(repository) ? issue(repository, (plain[1] ?? plain[2])!) : null;
  const qualified = QUALIFIED.exec(value) ?? ISSUE_URL.exec(value);
  return qualified ? issue(qualified[1]!, qualified[2]!) : null;
}

/** Orders canonical `owner/repo#N` references by repository, then by issue number. */
export function compareIssueReferences(a: string, b: string): number {
  const [repositoryA = "", numberA] = a.split("#");
  const [repositoryB = "", numberB] = b.split("#");
  return repositoryA === repositoryB ? Number(numberA) - Number(numberB) : repositoryA < repositoryB ? -1 : 1;
}

/** `owner/repo#N` for `#N` (in `repository`), `owner/repo#N`, or a GitHub issue URL; else null. */
export function canonicalIssueReference(value: string, repository?: string): string | null {
  return reference(value.trim(), repository);
}

const MASK = "\u0000";

/** A fence line's delimiter and the text after it, read in one pass: blockquote markers (each after
 * up to three spaces and followed by an optional space), up to three spaces, then three or more
 * backticks or tildes. A scan rather than a regular expression, which would backtrack
 * exponentially over a long run of `> ` markers. */
function fence(line: string): { char: string; length: number; rest: string } | null {
  let i = 0;
  for (;;) {
    let j = i;
    while (j < line.length && j - i < 3 && line[j] === " ") j += 1;
    if (line[j] !== ">") {
      i = j;
      break;
    }
    i = line[j + 1] === " " ? j + 2 : j + 1;
  }
  const char = line[i];
  if (char !== "`" && char !== "~") return null;
  let end = i;
  while (line[end] === char) end += 1;
  return end - i >= 3 ? { char, length: end - i, rest: line.slice(end) } : null;
}

/** The text with code and HTML comments blanked out, at the same offsets. A blank never reads as
 * a space, so nothing hidden can join a keyword to a reference either. */
function maskMarkdown(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = MASK;
  };
  // Fenced code blocks, line by line. An unclosed fence runs to the end, as CommonMark reads it.
  let offset = 0;
  let open: { char: string; length: number; from: number } | null = null;
  for (const line of text.split("\n")) {
    const delimiter = fence(line);
    if (open) {
      if (delimiter && delimiter.char === open.char && delimiter.length >= open.length && !delimiter.rest.trim()) {
        blank(open.from, offset + line.length);
        open = null;
      }
    } else if (delimiter && !(delimiter.char === "`" && delimiter.rest.includes("`"))) {
      open = { char: delimiter.char, length: delimiter.length, from: offset };
    }
    offset += line.length + 1;
  }
  if (open) blank(open.from, text.length);
  // Inline code: a run of N backticks up to the next run of exactly N in the same paragraph.
  // Linear in the number of runs: each length keeps a cursor that only moves forward.
  const masked = out.join("");
  const runs = [...masked.matchAll(/(?<!\\)`+/gu)].map((match) => ({ start: match.index, length: match[0].length }));
  const paragraphEnds = [...masked.matchAll(/\n[ \t]*\n/gu)].map((match) => match.index);
  const paragraph: number[] = [];
  for (let i = 0, p = 0; i < runs.length; i += 1) {
    while (p < paragraphEnds.length && paragraphEnds[p]! < runs[i]!.start) p += 1;
    paragraph.push(p);
  }
  const byLength = new Map<number, number[]>();
  runs.forEach((run, i) => {
    const same = byLength.get(run.length);
    if (same) same.push(i);
    else byLength.set(run.length, [i]);
  });
  const next = new Map<number, number>();
  let cursor = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const { start, length } = runs[i]!;
    if (start < cursor) continue;
    const same = byLength.get(length)!;
    let k = next.get(length) ?? 0;
    while (k < same.length && same[k]! <= i) k += 1;
    next.set(length, k);
    const close = same[k];
    if (close === undefined || paragraph[close] !== paragraph[i]) continue;
    cursor = runs[close]!.start + length;
    blank(start, cursor);
  }
  // HTML comments. One left open is not a comment GitHub hides, so it stays readable.
  const commented = out.join("");
  let from = commented.indexOf("<!--");
  while (from >= 0) {
    if (out[from] === MASK) {
      from = commented.indexOf("<!--", from + 1);
      continue;
    }
    const end = commented.indexOf("-->", from + 4);
    if (end < 0) break;
    blank(from, end + 3);
    from = commented.indexOf("<!--", end + 3);
  }
  return out.join("");
}

/** The line around a finding: up to 60 characters before its keyword and 40 after its reference,
 * never longer than CLOSING_REFERENCE_EXCERPT_MAX even when the reference is a long link. */
function excerpt(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", end);
  const lineEnd = newline < 0 ? text.length : newline;
  const from = Math.max(lineStart, start - 60);
  let to = Math.min(lineEnd, end + 40, from + CLOSING_REFERENCE_EXCERPT_MAX - 2);
  // Never split a surrogate pair at the cut.
  if (to < lineEnd && /[\uD800-\uDBFF]/u.test(text[to - 1] ?? "")) to -= 1;
  const line = text.slice(from, to).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return `${from > lineStart ? "…" : ""}${line}${to < lineEnd ? "…" : ""}`;
}

/** Every closing reference in a Markdown description, in order. `#N` and `GH-N` name issues in
 * `repository`. Code and HTML comments are blanked first, as GitHub ignores them. */
export function findClosingReferences(text: string, repository: string): ClosingReference[] {
  if (!REPOSITORY.test(repository)) throw new Error("repository must be owner/name");
  const scanned = maskMarkdown(text);
  const found: ClosingReference[] = [];
  for (const match of scanned.matchAll(KEYWORD)) {
    TARGET.lastIndex = match.index + match[0].length;
    const target = TARGET.exec(scanned);
    if (!target) continue;
    const token = target[0];
    const link = token.startsWith("[") ? LINK.exec(token) : null;
    const issues = link
      ? [reference(link[1]!.trim(), repository), reference(link[2]!, repository)]
      : [reference(token.replace(/^[\\<]/u, ""), repository)];
    const shown = excerpt(text, match.index, target.index + token.length);
    for (const target of new Set(issues)) {
      if (target) found.push({ issue: target, keyword: match[1]!, index: match.index, excerpt: shown });
    }
  }
  return found;
}
