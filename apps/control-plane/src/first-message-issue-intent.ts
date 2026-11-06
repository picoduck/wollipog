import { campaignRepositoryLocation } from "@wollipog/protocol";

/** One issue reference in a message, at its exact place in the text. Every issue a range names is
 * its own `range` reference spanning the whole range. `context` marks the endpoints of a range that
 * names nothing: they are recorded for the owner to see and can never become scope. */
export interface MessageIssueReference { number: number; start: number; end: number; range?: true; context?: true }

// A range between two short references (#4061): "#A–#B", "#A-#B", "#A—#B", "#A..#B", "#A to #B" or
// "#A through #B", with or without spaces, on one line. A chain such as "#1–#2–#3" or "#1 – #3 to
// #5" is no range: neither end may join another reference through a separator, spaced or not.
const SEPARATOR = String.raw`(?:[^\S\r\n]*(?:[-–—]|\.\.)[^\S\r\n]*|[^\S\r\n]+(?:to|through)[^\S\r\n]+)`;
const RANGE = new RegExp(String.raw`(?<![\w./#\-–—]|#[0-9]+${SEPARATOR})#([1-9][0-9]{0,15})${SEPARATOR}#([1-9][0-9]{0,15})(?![\w\-–—]|\.\.|${SEPARATOR}#)`, "giu");

/** Every reference a message makes to the campaign's own repository's issues, in text order:
 * `#123`, `owner/repo#123` and `https://github.com/owner/repo/issues/123`, or for a GitLab project
 * (#3539) `http(s)://<host>/<project>/-/issues/123`. References to another repository and pull or
 * merge request URLs are ignored. A range names every issue from its first end to its last (#4061)
 * only when it is ascending and at most 100 issues wide, and only while every range expanded keeps
 * the message within 100 distinct issues; otherwise no range expands and each one's endpoints are
 * context. The expansion never depends on anything but the text.
 *
 * Since #4104 this parser decides no intent: it is only the scope grant's exact-reference fast path
 * (the runner starts verifying these while the Decision Model reads the message) and grants nothing
 * the model's answer does not name. */
export function issueReferenceSpans(text: string, repository: string): MessageIssueReference[] {
  const own = repository.toLowerCase();
  const found: MessageIssueReference[] = [];
  const add = (value: string, start: number, end: number) => {
    const n = Number(value);
    if (Number.isSafeInteger(n) && n > 0) found.push({ number: n, start, end });
  };
  const ranges: Array<{ from: number; to: number; start: number; end: number }> = [];
  // The positions of both ends' `#`, so neither is also read as a reference of its own.
  const ends = new Set<number>();
  for (const match of text.matchAll(RANGE)) {
    ranges.push({ from: Number(match[1]), to: Number(match[2]), start: match.index, end: match.index + match[0].length });
    ends.add(match.index).add(match.index + match[0].lastIndexOf("#"));
  }
  for (const match of text.matchAll(/(?<![\w./#-])#([1-9][0-9]{0,15})(?![\w-])/gu)) {
    if (!ends.has(match.index)) add(match[1]!, match.index, match.index + match[0].length);
  }
  for (const match of text.matchAll(/(?<![\w./-])([\w.-]+\/[\w.-]+)#([1-9][0-9]{0,15})(?![\w-])/gu)) {
    if (match[1]!.toLowerCase() === own) add(match[2]!, match.index, match.index + match[0].length);
  }
  for (const match of text.matchAll(/\bhttps?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9][0-9]{0,15})(?![\w-])/giu)) {
    if (match[1]!.toLowerCase() === own) add(match[2]!, match.index, match.index + match[0].length);
  }
  if (campaignRepositoryLocation(repository)?.forge === "gitlab") {
    for (const match of text.matchAll(/\bhttps?:\/\/([^\s/?#@]+\/[^\s?#]+?)\/-\/issues\/([1-9][0-9]{0,15})(?![\w-])/giu)) {
      if (match[1]!.toLowerCase() === own) add(match[2]!, match.index, match.index + match[0].length);
    }
  }
  const bounded = (r: { from: number; to: number }) =>
    Number.isSafeInteger(r.to) && r.from < r.to && r.to - r.from < MAX_MESSAGE_ISSUES;
  // Sizes are summed before anything is expanded, so a message of many ranges stays linear.
  let expand = ranges.reduce((sum, r) => sum + (bounded(r) ? r.to - r.from + 1 : 0), 0) <= MAX_EXPANDED_REFERENCES;
  if (expand) {
    const distinct = new Set(found.map((r) => r.number));
    for (const r of ranges) if (bounded(r)) for (let n = r.from; n <= r.to; n++) distinct.add(n);
    expand = distinct.size <= MAX_MESSAGE_ISSUES;
  }
  for (const { from, to, start, end } of ranges) {
    if (expand && bounded({ from, to })) for (let n = from; n <= to; n++) found.push({ number: n, start, end, range: true });
    else for (const n of new Set([from, to])) if (Number.isSafeInteger(n)) found.push({ number: n, start, end, range: true, context: true });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Target epics a first message names (#4061): its own `#N` or issue URL references written right
 * after the word "epic" ("implement epic #40"), whose issue the message scopes. More than
 * `MAX_TARGET_EPICS` names none, so the members' inspection stays bounded. It only leaves a derived
 * Maximum Issues room for members the runner verifies; it never adds an issue to the scope. */
export function firstMessageTargetEpics(text: string, repository: string, scope: readonly number[]): number[] {
  const epics = new Set<number>();
  for (const r of issueReferenceSpans(text, repository)) {
    if (!r.range && scope.includes(r.number) && /\bepic[^\S\r\n]*:?[^\S\r\n]*$/iu.test(text.slice(Math.max(0, r.start - 16), r.start))) epics.add(r.number);
  }
  return epics.size > MAX_TARGET_EPICS ? [] : [...epics].sort((a, b) => a - b);
}

// A bare-digit range right after the word "issue" or "issues" ("issue 1201 through 1207"), on one
// line; a chain ("issues 1-3-5") is no range. `#`-written ranges are `RANGE`'s, a qualified one
// ("other/repo#3-#5") never matches here, and a year span ("2020-2025") names no issue.
const DIGIT_RANGE = new RegExp(String.raw`\bissues?[^\S\r\n]+([1-9][0-9]{0,15})${SEPARATOR}#?([1-9][0-9]{0,15})(?![\w\-–—]|\.\.|${SEPARATOR}#?[0-9])`, "giu");

/** The members of every bare-digit range a message writes after "issue" or "issues" ("issue 1201
 * through 1207"), each range under 100 issues and all of them within 100 (#4282). It is a floor for
 * a Custom campaign's first-message seed only, as the reading allowed: a number a proposal says the
 * person named must be written in the message or inside such a range, and the constraint check still
 * decides whether the message asks for it. It never adds a number to anything by itself. */
export function digitRangeMembers(text: string): number[] {
  const members = new Set<number>();
  for (const match of text.matchAll(DIGIT_RANGE)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (!Number.isSafeInteger(to) || from >= to || to - from >= MAX_MESSAGE_ISSUES) continue;
    if (members.size + (to - from + 1) > MAX_MESSAGE_ISSUES) return [];
    for (let n = from; n <= to; n++) members.add(n);
  }
  return [...members].sort((a, b) => a - b);
}

/** At most this many range members are expanded in one message; more expands no range. */
export const MAX_EXPANDED_REFERENCES = 1000;
export const MAX_MESSAGE_ISSUES = 100;
/** At most this many target epics a first message names get room for their members (#4061). */
export const MAX_TARGET_EPICS = 5;
