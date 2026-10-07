/**
 * How much of the input is read. A snippet shows a line or two, and the patterns below are not all
 * linear on hostile input, so a long request title never costs more than this much work.
 */
const MAX_INPUT_LENGTH = 2_000;
/** Markdown's backslash-escapable punctuation. */
const ESCAPABLE = "\\`*_{}[]()#+-.!|>~<";
const TAG_NAMES = "a|b|i|u|s|em|strong|code|kbd|pre|sub|sup|p|div|span|details|summary|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|blockquote";
/**
 * The HTML an agent's markdown actually carries, in lowercase as agents write it. An opening tag
 * never follows a letter, so a generic type in prose ("Box<U>", "Vec<T>") stays text; a closing tag
 * and a line break or rule can sit anywhere.
 */
const HTML_TAG = new RegExp(`(?<!\\w)<(?:${TAG_NAMES})\\b[^>]*>|</(?:${TAG_NAMES})>|<(?:br|hr|img)\\b[^>]*>`, "g");
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };
/** A placeholder's marks, private-use characters. Input holding either keeps it as a placeholder too. */
const OPEN = "";
const CLOSE = "";
const PLACEHOLDER = /(\d+)/g;

/**
 * One line, in a single pass, as the text whose markdown is stripped, with a placeholder for each
 * thing kept exactly as written: a code span's contents (one the 240-character cut left open runs to
 * the end of the line), an escaped character, and either placeholder mark if the input holds one.
 * An escaped backtick is a character, so it never opens a span. In a table row an escaped pipe is a
 * pipe even inside code, as GFM renders it.
 */
function protect(line: string, table: boolean): { text: string; kept: string[] } {
  const kept: string[] = [];
  const keep = (value: string) => `${OPEN}${kept.push(value) - 1}${CLOSE}`;
  let text = "";
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (char === "\\" && index + 1 < line.length && ESCAPABLE.includes(line[index + 1]!)) {
      text += keep(line[index + 1]!);
      index += 2;
    } else if (char === "`") {
      let opened = index;
      while (line[opened] === "`") opened += 1;
      const size = opened - index;
      // The span closes at the next run of exactly as many backticks.
      let close = -1;
      for (let at = line.indexOf("`", opened); at >= 0 && close < 0;) {
        let run = at;
        while (line[run] === "`") run += 1;
        if (run - at === size) close = at;
        else at = line.indexOf("`", run);
      }
      const code = line.slice(opened, close < 0 ? line.length : close);
      text += keep((table ? code.replace(/\\\|/g, "|") : code).trim());
      index = close < 0 ? line.length : close + size;
    } else {
      text += char === OPEN || char === CLOSE ? keep(char) : char;
      index += 1;
    }
  }
  return { text, kept };
}

/**
 * One line of inline markdown as text. Links and images keep their text. Emphasis and
 * strikethrough markers go only in pairs, so an identifier with a trailing underscore ("name_"),
 * snake_case, `**kwargs` and arithmetic ("2 * 3") keep every character; a placeholder sits between a
 * pair like any other character, so emphasis around code still pairs up.
 */
function plainLine(line: string, table: boolean): string {
  const { text, kept } = protect(line, table);
  const cells = table ? text.replace(/^\s*\||\|\s*$/g, "").replace(/\s*\|\s*/g, "  ") : text;
  return cells
    .replace(/!\[([^\]]*)\](?:\([^)]*\)?|\[[^\]]*\])?/g, "$1")
    .replace(/\[\^[^\]]*\]/g, "")
    .replace(/\[([^\]]*)\](?:\([^)]*\)?|\[[^\]]*\])/g, "$1")
    // A link the 240-character cut ended inside: "[the docs](https://exa".
    .replace(/\[([^\]]*)\]\([^)]*$/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1")
    .replace(HTML_TAG, " ")
    .replace(/(^|[^\w*])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
    .replace(/(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, "$1$2")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => ENTITIES[name]!)
    .replace(PLACEHOLDER, (_, index: string) => kept[Number(index)]!);
}

/**
 * A markdown snippet as one line of plain text (#2218): what a Sessions row's snippet and a Board
 * card (#2222) show of a session's latest agent message. `SessionView.preview` is that message's
 * first 240 characters as the agent wrote them, so a construct may be cut off part way; the words
 * stay and the syntax goes: headings, quotes, list markers and task boxes, emphasis, code fences
 * and backticks (their code kept as written), links and images (their text kept), tables' rules and
 * pipes, and the common HTML tags. Line breaks and runs of whitespace collapse to one space.
 */
export function plainTextPreview(markdown: string | null | undefined): string {
  if (!markdown) return "";
  const lines: string[] = [];
  let fenced = false;
  for (const raw of markdown.slice(0, MAX_INPUT_LENGTH).split(/\r\n|\r|\n/)) {
    // Fences, rules, setext underlines, table separators and link definitions carry no words. Code
    // inside a fence is kept as written.
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      lines.push(raw);
      continue;
    }
    if (/^\s{0,3}([-*_=])(?:\s*\1){2,}\s*$/.test(raw)) continue;
    if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(raw)) continue;
    if (/^\s{0,3}\[[^\]]+\]:\s*\S/.test(raw)) continue;
    let line = raw
      .replace(/^\s{0,3}(?:>\s?)+/, "")
      .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "");
    const heading = /^\s{0,3}#{1,6}(?:\s+|$)/.exec(line);
    if (heading) line = line.slice(heading[0].length).replace(/\s+#+\s*$/, "");
    lines.push(plainLine(line, /^\s*\|/.test(line)));
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}
