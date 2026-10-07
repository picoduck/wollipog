/** Markdown's backslash-escapable punctuation. */
const ESCAPED = /\\([\\`*_{}[\]()#+\-.!|>~<])/g;
/** The HTML an agent's markdown actually carries; anything else in angle brackets is text ("Vec<T>"). */
const HTML_TAG = /<\/?(?:a|b|i|u|s|em|strong|code|kbd|pre|sub|sup|br|hr|p|div|span|img|details|summary|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|blockquote)\b[^>]*>/gi;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };
const CODE_SPAN = /(`+)([\s\S]*?)\1(?!`)/;

/**
 * Inline markdown outside code spans as text: links and images keep their text, emphasis and
 * strikethrough markers go (`_` only at a word's edge, so snake_case stays), a stray backtick goes,
 * and an escaped character is kept as itself.
 */
function stripInline(text: string): string {
  const escapes: string[] = [];
  return text
    .replace(ESCAPED, (_, char: string) => `${escapes.push(char) - 1}`)
    .replace(/!\[([^\]]*)\](?:\([^)]*\)?|\[[^\]]*\])?/g, "$1")
    .replace(/\[\^[^\]]*\]/g, "")
    .replace(/\[([^\]]*)\](?:\([^)]*\)?|\[[^\]]*\])/g, "$1")
    // A link the 240-character cut ended inside: "[the docs](https://exa".
    .replace(/\[([^\]]*)\]\([^)]*$/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1")
    .replace(HTML_TAG, " ")
    .replace(/\*\*|~~|`+/g, "")
    .replace(/(^|[^\w])__(?=\S)|(?<=\S)__(?!\w)/g, "$1")
    .replace(/(^|[^\w*])\*(?=[^\s*])|(?<=[^\s*])\*(?![\w*])/g, "$1")
    .replace(/(^|[^\w])_(?=[^\s_])|(?<=[^\s_])_(?!\w)/g, "$1")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => ENTITIES[name]!)
    .replace(/(\d+)/g, (_, index: string) => escapes[Number(index)]!);
}

/** One line of inline markdown as text. A code span keeps its contents exactly as written. */
function plainLine(line: string): string {
  let out = "";
  let rest = line;
  for (let match = CODE_SPAN.exec(rest); match; match = CODE_SPAN.exec(rest)) {
    out += `${stripInline(rest.slice(0, match.index))}${match[2]!.trim()}`;
    rest = rest.slice(match.index + match[0].length);
  }
  return out + stripInline(rest);
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
  for (const raw of markdown.split(/\r\n|\r|\n/)) {
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
