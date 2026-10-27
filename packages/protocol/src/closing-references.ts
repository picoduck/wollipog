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
 * Where this approximation of GitHub's Markdown is unsure it reports: indented code, `#12_x`, an
 * unclosed fence, text after a fence indented by one to three spaces once a line is less indented
 * (as a list item's fence ends), code and raw HTML inside a raw HTML block, code spans and inline
 * comments that cross a line, and HTML comments only one of cmark-gfm and the HTML parser would hide.
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
/** Stands in for a backtick in raw HTML, where it is literal text, so it never opens a code span. */
const LITERAL_BACKTICK = "\u0001";

/** Quote markers at the start of a line, at most `limit` of them: each after up to three spaces and
 * followed by an optional space. Returns how many and where the rest of the line starts. A scan
 * rather than a regular expression, which would backtrack exponentially over a run of `> `. */
function quotes(line: string, limit = Number.POSITIVE_INFINITY): { depth: number; rest: number } {
  let rest = 0;
  let depth = 0;
  while (depth < limit) {
    let j = rest;
    while (j < line.length && j - rest < 3 && line[j] === " ") j += 1;
    if (line[j] !== ">") break;
    depth += 1;
    rest = line[j + 1] === " " ? j + 2 : j + 1;
  }
  return { depth, rest };
}

/** A fence delimiter at `from`: up to three spaces, then three or more backticks or tildes. */
function delimiter(line: string, from: number): { indent: number; char: string; length: number; info: string } | null {
  let i = from;
  while (i < line.length && i - from < 3 && line[i] === " ") i += 1;
  const char = line[i];
  if (char !== "`" && char !== "~") return null;
  let end = i;
  while (line[end] === char) end += 1;
  return end - i >= 3 ? { indent: i - from, char, length: end - i, info: line.slice(end) } : null;
}

function leadingSpaces(text: string): number {
  let count = 0;
  while (text[count] === " ") count += 1;
  return count;
}

/** How a raw HTML block that starts on this line ends, or null when none starts. Generous on
 * purpose: a line taken for raw HTML only hides less. Types 1 to 5 run to their end marker, which
 * may be on the same line; the rest (6 and 7) run to the next blank line (`"blank"`). Any indent
 * and list markers are skipped, so `- <div>` starts one too. */
function htmlBlockEnd(content: string): RegExp | "blank" | null {
  let i = 0;
  for (;;) {
    while (content[i] === " " || content[i] === "\t") i += 1;
    const marker = /^(?:[-*+]|[0-9]{1,9}[.)])(?=[ \t]|$)/u.exec(content.slice(i, i + 11));
    if (!marker) break;
    i += marker[0].length;
  }
  const lead = content.slice(i);
  if (/^<(?:script|pre|style|textarea)(?:[\s>]|$)/iu.test(lead)) return /<\/(?:script|pre|style|textarea)>/iu;
  if (lead.startsWith("<!--")) return /-->/u;
  if (lead.startsWith("<?")) return /\?>/u;
  if (lead.startsWith("<![CDATA[")) return /\]\]>/u;
  if (/^<![A-Za-z]/u.test(lead)) return />/u;
  return /^<\/?[A-Za-z]/u.test(lead) ? "blank" : null;
}

/** Positions of every occurrence of `needle`, in order. */
function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/** How many of sorted `positions` come before `at`. */
function indexAt(positions: readonly number[], at: number): number {
  let low = 0;
  let high = positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (positions[middle]! < at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The first position in sorted `positions` at or after `at`, or -1. */
function nextAt(positions: readonly number[], at: number): number {
  const index = indexAt(positions, at);
  return index < positions.length ? positions[index]! : -1;
}

/**
 * The text with code and HTML comments blanked out, at the same offsets. A blank never reads as a
 * space, so nothing hidden can join a keyword to a reference either. Wherever this approximation
 * of GitHub's Markdown is unsure, it leaves text visible: a reference reported needlessly costs a
 * reworded sentence, one hidden wrongly closes an issue. (In the merge gate, GitHub's own
 * `closingIssuesReferences` also backs it up.)
 */
function maskMarkdown(text: string): string {
  const out = text.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = MASK;
  };
  // Blocks, line by line. A fenced code block is hidden once a closing fence ends it, or once its
  // quote ends (code has no lazy continuation) or a line is less indented than its fence (as a list
  // item ends); the line that ended it that way opens no fence of its own. An unclosed fence hides
  // nothing: the text after it stays visible. Raw HTML blocks are never code: no fence opens inside
  // one, and their backticks are literal.
  const raw: Array<[number, number]> = [];
  let offset = 0;
  let fence: { char: string; length: number; from: number; depth: number; indent: number } | null = null;
  let html: { end: RegExp | "blank"; depth: number } | null = null;
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    let fenceEnded = false;
    if (fence) {
      const prefix = quotes(line, fence.depth);
      const content = line.slice(prefix.rest);
      const close = prefix.depth < fence.depth ? null : delimiter(line, prefix.rest);
      if (close && close.char === fence.char && close.length >= fence.length && !close.info.trim()) {
        blank(fence.from, lineEnd);
        fence = null;
        offset = lineEnd + 1;
        continue;
      }
      if (prefix.depth >= fence.depth && (content.trim() === "" || leadingSpaces(content) >= fence.indent)) {
        offset = lineEnd + 1;
        continue;
      }
      blank(fence.from, offset - 1);
      fence = null;
      fenceEnded = true;
    }
    if (html) {
      const prefix = quotes(line, html.depth);
      if (html.end === "blank" ? prefix.depth >= html.depth && line.slice(prefix.rest).trim() !== "" : true) {
        raw.push([offset, lineEnd]);
        if (html.end !== "blank" && html.end.test(line)) html = null;
        offset = lineEnd + 1;
        continue;
      }
      html = null;
    }
    const prefix = quotes(line);
    const opening = delimiter(line, prefix.rest);
    const htmlEnd = opening && !fenceEnded ? null : htmlBlockEnd(line.slice(prefix.rest));
    if (opening && !fenceEnded && !(opening.char === "`" && opening.info.includes("`"))) {
      fence = { char: opening.char, length: opening.length, from: offset, depth: prefix.depth, indent: opening.indent };
    } else if (htmlEnd) {
      raw.push([offset, lineEnd]);
      const startsAt = line.indexOf("<", prefix.rest);
      if (htmlEnd === "blank" || !htmlEnd.test(line.slice(startsAt + 2))) html = { end: htmlEnd, depth: prefix.depth };
    }
    offset = lineEnd + 1;
  }
  // Inline code and HTML comments, in one left-to-right pass as cmark-gfm reads them: whichever
  // starts first wins, a comment's end is found in the text itself (even inside what would
  // otherwise read as a code span), and backtick runs pair across the paragraph. Text is hidden only
  // within one line, though: a later line might start a block (a heading, a list item) that ends the
  // paragraph first, and then GitHub shows the text and pairs that line's backticks afresh. So a
  // pair that crosses a line hides nothing, and neither does anything else on the lines it reaches.
  const masked = out.join("");
  const inline = out.slice();
  for (const [from, to] of raw) for (let i = from; i < to; i += 1) if (inline[i] === "`") inline[i] = LITERAL_BACKTICK;
  const runs = [...inline.join("").matchAll(/(?<!\\)`+/gu)].map((match) => ({ start: match.index, length: match[0].length }));
  const newlines = occurrences(masked, "\n");
  const lineAt = (at: number) => indexAt(newlines, at);
  const paragraphEnds = [...masked.matchAll(/\n[ \t]*\n/gu)].map((match) => match.index);
  const paragraph = runs.map((run) => indexAt(paragraphEnds, run.start));
  const unsure = new Set<number>();
  const byLength = new Map<number, number[]>();
  runs.forEach((run, i) => {
    const same = byLength.get(run.length);
    if (same) same.push(i);
    else byLength.set(run.length, [i]);
  });
  const next = new Map<number, number>();
  const ends = occurrences(masked, "-->");
  const bangEnds = occurrences(masked, "--!>");
  const dashes = occurrences(masked, "--");
  const comments = occurrences(masked, "<!--").filter((at) => masked[at] !== MASK);
  // HTML comments, hidden only where both GitHub's Markdown and its HTML parser hide them:
  // - A line that starts with `<!--` (after quote markers and up to three spaces) is a raw HTML
  //   block, and the HTML parser ends its comment at the first `-->` or `--!>`; `<!-->` and
  //   `<!--->` are complete, empty comments.
  // - Elsewhere, cmark-gfm takes `<!--` as a comment only when the text before the next `-->`
  //   neither starts with `>` or `->`, contains `--`, nor ends with `-`. Anything else is literal
  //   text, which GitHub shows. A comment left open hides nothing.
  const commentEnd = (from: number): number => {
    const window = masked.slice(Math.max(0, from - 64), from);
    const newline = window.lastIndexOf("\n");
    const linePrefix = newline >= 0 ? window.slice(newline + 1) : from <= 64 ? window : null;
    const prefix = linePrefix === null ? null : quotes(linePrefix);
    if (linePrefix !== null && prefix && /^ {0,3}$/u.test(linePrefix.slice(prefix.rest))) {
      const plain = nextAt(ends, from + 2);
      const bang = nextAt(bangEnds, from + 2);
      return bang >= 0 && (plain < 0 || bang < plain) ? bang + 4 : plain >= 0 ? plain + 3 : -1;
    }
    const close = nextAt(ends, from + 4);
    if (close < 0) return -1;
    const content = masked.slice(from + 4, Math.min(close, from + 6));
    const dash = nextAt(dashes, from + 4);
    const lineBreak = nextAt(newlines, from);
    return content.startsWith(">") || content.startsWith("->") || (dash >= 0 && dash < close) ||
      (close > from + 4 && masked[close - 1] === "-") || (lineBreak >= 0 && lineBreak < close) ? -1 : close + 3;
  };
  let cursor = 0;
  for (let r = 0, c = 0; r < runs.length || c < comments.length;) {
    if (c < comments.length && (r >= runs.length || comments[c]! < runs[r]!.start)) {
      const from = comments[c++]!;
      if (from < cursor) continue;
      const end = commentEnd(from);
      if (end >= 0) {
        if (!unsure.has(lineAt(from))) blank(from, end);
        cursor = end;
      }
      continue;
    }
    const i = r++;
    const { start, length } = runs[i]!;
    if (start < cursor) continue;
    const same = byLength.get(length)!;
    let k = next.get(length) ?? 0;
    while (k < same.length && same[k]! <= i) k += 1;
    next.set(length, k);
    const close = same[k];
    if (close === undefined || paragraph[close] !== paragraph[i]) continue;
    cursor = runs[close]!.start + length;
    const [first, last] = [lineAt(start), lineAt(runs[close]!.start)];
    for (let line = first + 1; line <= last; line += 1) unsure.add(line);
    if (first === last && !unsure.has(first)) blank(start, cursor);
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
