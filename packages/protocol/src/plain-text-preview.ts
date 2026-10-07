/**
 * How much of the input is read. A snippet shows a line or two, and the patterns below are not all
 * linear on hostile input, so a long request title never costs more than this much work.
 */
const MAX_INPUT_LENGTH = 2_000;
/** Markdown's backslash-escapable punctuation. */
const ESCAPED = /\\([\\`*_{}[\]()#+\-.!|>~<])/g;
const TAG_NAMES = "a|b|i|u|s|em|strong|code|kbd|pre|sub|sup|p|div|span|details|summary|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|blockquote";
/**
 * The HTML an agent's markdown actually carries, in lowercase as agents write it. An opening tag
 * never follows a letter, so a generic type in prose ("Box<U>", "Vec<T>") stays text; a closing tag
 * and a line break or rule can sit anywhere.
 */
const HTML_TAG = new RegExp(`(?<!\\w)<(?:${TAG_NAMES})\\b[^>]*>|</(?:${TAG_NAMES})>|<(?:br|hr|img)\\b[^>]*>`, "g");
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };
const CODE_SPAN = /(`+)([\s\S]*?)\1(?!`)/g;

/**
 * One line of inline markdown as text. Code keeps its contents exactly as written, including a span
 * the 240-character cut left open; an escaped character is kept as itself. Both are set aside as
 * placeholders first, so emphasis around them still pairs up. Links and images keep their text.
 * Emphasis and strikethrough markers go only in pairs, so an identifier with a trailing underscore
 * ("name_"), snake_case, `**kwargs` and arithmetic ("2 * 3") keep every character.
 */
function plainLine(line: string): string {
  const kept: string[] = [];
  const keep = (text: string) => `${kept.push(text) - 1}`;
  let text = line
    .replace(CODE_SPAN, (_, _fence: string, code: string) => keep(code.trim()))
    .replace(ESCAPED, (_, char: string) => keep(char));
  const open = text.indexOf("`");
  if (open >= 0) text = text.slice(0, open) + keep(text.slice(open).replace(/^`+/, ""));
  return text
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
    .replace(/(\d+)/g, (_, index: string) => kept[Number(index)]!);
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
    if (/^\s*\|/.test(line)) line = line.replace(/^\s*\||\|\s*$/g, "").replace(/\s*\|\s*/g, "  ");
    lines.push(plainLine(line));
  }
  return lines.join(" ").replace(/\s+/g, " ").trim();
}
