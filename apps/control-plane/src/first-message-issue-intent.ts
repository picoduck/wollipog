import { campaignRepositoryLocation } from "@wollipog/protocol";

/** One issue reference in a message, at its exact place in the text. */
export interface MessageIssueReference { number: number; start: number; end: number }

/** Every reference a message makes to the campaign's own repository's issues, in text order:
 * `#123`, `owner/repo#123` and `https://github.com/owner/repo/issues/123`, or for a GitLab project
 * (#3539) `http(s)://<host>/<project>/-/issues/123`. References to another repository and pull or
 * merge request URLs are ignored. */
export function issueReferenceSpans(text: string, repository: string): MessageIssueReference[] {
  const own = repository.toLowerCase();
  const found: MessageIssueReference[] = [];
  const add = (value: string, start: number, end: number) => {
    const n = Number(value);
    if (Number.isSafeInteger(n) && n > 0) found.push({ number: n, start, end });
  };
  for (const match of text.matchAll(/(?<![\w./#-])#([1-9][0-9]{0,15})(?![\w-])/gu)) add(match[1]!, match.index, match.index + match[0].length);
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
  return found.sort((a, b) => a.start - b.start);
}

/** How one occurrence of a reference is used. Only `directive` can grant scope. */
export type IssueReferenceIntent = "directive" | "background" | "negated" | "unclear";

/** A first message's verified-candidate split (#3920): `scope` is what it asks the campaign to act
 * on; `context` is every other reference, kept for the owner to see and promote, with no authority. */
export interface FirstMessageIssueIntent { scope: number[]; context: number[] }

// Present-tense requests to act on an issue. Past tense ("fixed", "closed") is history, not a request.
const DIRECTIVE = /\b(?:deliver(?:s|ing)?|implement(?:s|ing)?|fix(?:es|ing)?|close[s]?|closing|claim(?:s|ing)?|resolve[s]?|resolving|address(?:es|ing)?|finish(?:es|ing)?|ship(?:s|ping)?|land(?:s|ing)?|tackle[s]?|tackling|solve[s]?|solving|handle[s]?|handling|orchestrate[s]?|orchestrating|work(?:s|ing)?\s+(?:on|through)|take\s+on|taking\s+on|pick(?:s|ing)?\s+up)\b/iu;
// Words that turn a clause into background: citing, relating, explaining or recording history.
const BACKGROUND = /\b(?:see|cf|related|relates|relating|relation|known|caused?|acceptance\s+tests?|elsewhere|being\s+handled|handled\s+by|tracked|tracking|tracks|background|context|for\s+reference|reference[sd]?|refs?|e\.g|i\.e|example|similar|same\s+as|such\s+as|duplicates?|duplicated|dupes?|block(?:s|ed|ing|ers?)?|depend(?:s|ed|ing|ency|encies)?|follow[- ]?ups?|builds?\s+on|based\s+on|fixed|closed|resolved|delivered|implemented|merged|landed|shipped|addressed|completed|finished|already|previously|earlier|prior|mentioned|discussed|described|reported|explain(?:s|ed|ing)?|per|according|introduced|supersede[sd]?|inspired|cit(?:e|es|ed|ing)|citation|history|historical|(?:some|any)(?:one|body)\s+else|another\s+(?:campaign|team|session|person|agent|orchestrator|child)|other\s+(?:campaigns?|teams?|sessions?|people|agents?|orchestrators?|children))\b/iu;
// Words that withhold authority: refusals, rejected alternatives ("instead of", "rather than") and
// requests to stop or put off work. Bare "no" is left out: it is common in requests ("no regressions").
const NEGATION = /\b(?:not|never|without|except|excluding|exclude[sd]?|avoid(?:s|ing)?|skip(?:s|ping)?|ignor(?:e|es|ing)|leave|leaving|nor|cannot|out\s+of\s+scope|hands\s+off|instead\s+of|rather\s+than|other\s+than|apart\s+from|stop(?:s|ped|ping)?|halt(?:s|ed|ing)?|paus(?:e|es|ed|ing)|abandon(?:s|ed|ing)?|defer(?:s|red|ring)?|postpon(?:e|es|ed|ing)|hold(?:ing)?\s+off|deprioriti[sz](?:e|es|ed|ing))\b|n['’]t\b/iu;
// Words that start a new clause wherever they appear: subordinate, contrasting or sequencing.
const CLAUSE_START = /\b(?:but|except|excluding|without|unless|although|though|while|whereas|because|since|which|whose|rather\s+than|instead\s+of|other\s+than|however|once|after|before|until|when|whenever|if|so)\b/giu;
// Coordinators start a new clause only when a word follows them, so "#1, #2 and #3" stays one list.
const COORDINATOR = /\s\b(?:and|or|then|also|plus)\b(?=\s+[^\s\u0001])/giu;
const REF = "\u0001";

type Cue = "directive" | "background" | "negated" | null;

function clauseCue(clause: string): Cue {
  if (NEGATION.test(clause)) return "negated";
  if (BACKGROUND.test(clause)) return "background";
  return DIRECTIVE.test(clause) ? "directive" : null;
}

/** A clause's own cue under the lead governing it: a negation on either side wins, then a
 * background lead, and only then the clause's own request or the lead's. */
function withholding(own: Cue, lead: Cue): Cue {
  if (own === "negated" || lead === "negated") return "negated";
  if (lead === "background") return "background";
  return own ?? lead;
}

/** Positions that split `text` into pieces at each match's start, as [start, end) ranges. */
function splitAt(start: number, end: number, text: string, patterns: RegExp[]): Array<[number, number]> {
  const cuts = new Set<number>();
  const piece = text.slice(start, end);
  for (const pattern of patterns) for (const match of piece.matchAll(pattern)) if (match.index > 0) cuts.add(start + match.index);
  const points = [start, ...[...cuts].sort((a, b) => a - b), end];
  return points.slice(1).map((to, index) => [points[index]!, to]);
}

/** Whether `line[from, end)` is a list ordinal: one to three digits at the start of the range or
 * after a colon, with only spaces in between. Reads at most a few characters back. */
function ordinalBefore(line: string, from: number, end: number): boolean {
  let i = end;
  while (i > from && end - i < 3 && /\d/u.test(line[i - 1]!)) i--;
  if (i === end) return false;
  while (i > from && /\s/u.test(line[i - 1]!)) i--;
  return i === from || line[i - 1] === ":";
}

/** Sentence ranges in one line: a period, question or exclamation mark, or semicolon followed by
 * space ends one, except a list ordinal ("1." at the start or after a colon). */
function sentences(line: string, offset: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (const match of line.matchAll(/[.!?;](?=\s|$)/gu)) {
    if (match[0] === "." && ordinalBefore(line, from, match.index)) continue;
    ranges.push([offset + from, offset + match.index + 1]);
    from = match.index + 1;
  }
  if (from < line.length) ranges.push([offset + from, offset + line.length]);
  return ranges;
}

/** Splits a first message's references by intent (#3920). A reference is in scope only when a
 * clause asks the campaign to act on it (deliver, implement, fix, close, claim, work on and the
 * like) and that clause carries no background or negation cue; any negated occurrence withholds it.
 * Everything else is context: references in parentheses, brackets or inline code (citations),
 * background ("see", "related to", "known cause", "acceptance test for", "handled elsewhere"),
 * negated ones ("not", "don't touch", "never", "instead of", "postpone") and any whose intent is
 * unclear. A negation reaches every later clause of its sentence. A line ending in a colon leads
 * what follows it: a request passes only to list items without a cue of their own, while a negated
 * or background lead withholds every following item and plain line up to a blank line. When in doubt a reference is context, never scope: the owner can promote it through the
 * existing scope review. The same 100-issue bound as before applies to the union. */
export function firstMessageIssueIntent(text: string, repository: string): FirstMessageIssueIntent {
  const references = issueReferenceSpans(text, repository);
  const distinct = [...new Set(references.map((r) => r.number))].sort((a, b) => a - b).slice(0, MAX_MESSAGE_ISSUES);
  if (!references.length) return { scope: [], context: [] };
  // A message too long or too dense to classify in bounded time asks for nothing: every reference
  // is context. Truncating instead could cut off a negation and widen what is granted.
  if (text.length > MAX_CLASSIFIED_MESSAGE_LENGTH || references.length > MAX_CLASSIFIED_REFERENCES) return { scope: [], context: distinct };
  const occurrences = new Map<number, IssueReferenceIntent[]>();
  const record = (n: number, intent: IssueReferenceIntent) => {
    const list = occurrences.get(n);
    if (list) list.push(intent); else occurrences.set(n, [intent]);
  };
  const cited = new Set<MessageIssueReference>();
  // A same-length working copy: references become markers, and URLs, paths, file names and code
  // lose their words, so a word inside an address or file name ("fix-login/issues/1") is never a cue.
  const masked = text.split("");
  const blankKeepingReferences = (start: number, end: number) => { for (let i = start; i < end; i++) if (masked[i] !== REF) masked[i] = " "; };
  // Inline code is a citation: its references are unclear, or negated when it says so.
  const code = new Int32Array(text.length + 1).fill(-1);
  const spans: Array<[number, number]> = [];
  for (const match of text.matchAll(/`[^`\n]*`/gu)) {
    for (let i = match.index; i < match.index + match[0].length; i++) code[i] = spans.length;
    spans.push([match.index, match.index + match[0].length]);
  }
  for (const r of references) {
    const span = spans[code[r.start]!];
    if (span && r.end <= span[1]) { record(r.number, NEGATION.test(text.slice(...span)) ? "negated" : "unclear"); cited.add(r); }
  }
  for (const r of references) for (let i = r.start; i < r.end; i++) masked[i] = REF;
  for (const [start, end] of spans) blankKeepingReferences(start, end);
  // Each whitespace-delimited token is read once, without its trailing punctuation, so the masks
  // stay linear in the message's length.
  for (const token of text.matchAll(/\S+/gu)) {
    let length = token[0].length;
    while (length > 0 && ".,;:!?)]}".includes(token[0][length - 1]!)) length--;
    const word = token[0].slice(0, length);
    // An address or path starts after the last opening bracket before its first slash, so the
    // brackets of a Markdown link still delimit its citation.
    const slash = word.search(/[/\\]/u);
    let from = 0;
    if (slash >= 0) from = Math.max(word.lastIndexOf("(", slash), word.lastIndexOf("[", slash), word.lastIndexOf("{", slash)) + 1;
    else while (from < word.length && "([{".includes(word[from]!)) from++;
    if (slash >= 0 || word.length - from <= 256 && /^[\w-]{2,}(?:\.[\w-]+)*\.[a-z]\w+$/iu.test(word.slice(from))) {
      blankKeepingReferences(token.index + from, token.index + length);
    }
  }
  // Quoted text is someone else's words: its references are background, or negated when it says so.
  let quotedNext = 0;
  for (const match of text.matchAll(/"[^"\n]*"|“[^”\n]*”/gu)) {
    const end = match.index + match[0].length;
    while (quotedNext < references.length && references[quotedNext]!.start <= match.index) quotedNext++;
    for (; quotedNext < references.length && references[quotedNext]!.start < end; quotedNext++) {
      const r = references[quotedNext]!;
      if (cited.has(r) || r.end >= end) continue;
      record(r.number, NEGATION.test(match[0]) ? "negated" : "background");
      cited.add(r);
    }
    blankKeepingReferences(match.index, end);
  }
  // Parenthetical and bracketed text is a citation: its references are background, or negated when
  // it says so, and its words never govern the clause around it. An unclosed one runs to the end.
  const unparenthesized = masked.join("");
  const group = new Int32Array(masked.length + 1).fill(-1);
  const groups: Array<[number, number]> = [];
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]!;
    if (c === "(" || c === "[" || c === "{") { if (depth++ === 0) groups.push([i, masked.length]); }
    if (depth > 0) group[i] = groups.length - 1;
    if (depth > 0 && c !== "\n") masked[i] = " ";
    if ((c === ")" || c === "]" || c === "}") && depth > 0 && --depth === 0) groups[groups.length - 1]![1] = i + 1;
  }
  const negatedGroup = groups.map((range) => NEGATION.test(unparenthesized.slice(...range)));
  const plain = masked.join("");
  for (const r of references) {
    const index = group[r.start]!;
    if (cited.has(r) || index < 0) continue;
    record(r.number, negatedGroup[index] ? "negated" : "background");
    cited.add(r);
  }

  // References and clauses are both in text order, so one pointer walks them together.
  const open = references.filter((r) => !cited.has(r));
  let next = 0;
  // A line ending in a colon leads what follows it. A requesting lead passes its request only to
  // list items without a cue of their own. A withholding lead (negated or background) governs every
  // following list item, whatever verb it uses, and plain lines up to the next blank line.
  let lead: Cue = null;
  let blank = false;
  let offset = 0;
  for (const line of plain.split("\n")) {
    const item = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/u.test(line);
    // A blockquote line is quoted material, whatever it asks.
    const quoted = /^\s*>/u.test(line);
    if (!line.trim()) blank = true;
    else if (!item && (lead === "directive" || lead === null || blank)) lead = null;
    const governed = item || lead === "negated" || lead === "background" ? lead : null;
    let last: Cue = null;
    for (const [sentenceStart, sentenceEnd] of sentences(line, offset)) {
      // A question asks nothing unless it is phrased as a request ("Can you fix #5?").
      const sentence = plain.slice(sentenceStart, sentenceEnd).trim();
      const question = sentence.endsWith("?") &&
        !/^(?:[-*+•>]\s*|\d{1,3}[.)]\s+)?(?:please\b|(?:can|could|would|will)\s+you\b)/iu.test(sentence);
      // A negation reaches every later clause of its sentence: "Do not fix #1 or close #2".
      let negated = false;
      for (const [start, end] of splitAt(sentenceStart, sentenceEnd, plain, [CLAUSE_START, COORDINATOR, /,\s*(?=(?:not|never)\b)/giu, /\s[-–—]\s/gu])) {
        const own = clauseCue(plain.slice(start, end));
        negated ||= own === "negated";
        let cue = withholding(negated ? "negated" : own, quoted && governed !== "negated" ? "background" : governed);
        if (question && cue === "directive") cue = null;
        last = cue;
        while (next < open.length && open[next]!.start < start) record(open[next++]!.number, "unclear");
        while (next < open.length && open[next]!.start < end) record(open[next++]!.number, cue ?? "unclear");
      }
    }
    if (line.trim()) {
      if (line.trimEnd().endsWith(":")) lead = last;
      blank = false;
    }
    offset += line.length + 1;
  }
  while (next < open.length) record(open[next++]!.number, "unclear");

  const scope: number[] = [];
  const context: number[] = [];
  for (const n of distinct) {
    const intents = occurrences.get(n) ?? [];
    (intents.includes("directive") && !intents.includes("negated") ? scope : context).push(n);
  }
  return { scope, context };
}

/** Bounds on what is classified at all (#3920): a longer or denser first message scopes nothing. */
export const MAX_CLASSIFIED_MESSAGE_LENGTH = 64 * 1024;
export const MAX_CLASSIFIED_REFERENCES = 1000;
export const MAX_MESSAGE_ISSUES = 100;
