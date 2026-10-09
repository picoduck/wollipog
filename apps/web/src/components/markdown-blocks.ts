/**
 * Where a Markdown document can be cut into blocks that parse to exactly what the whole document
 * parses to (#2763). A streaming reply is rendered block by block, so a chunk re-parses only the
 * block it lands in instead of the whole reply.
 *
 * Cuts are deliberately conservative: only between two plain top-level blocks, never inside or next
 * to a container. A cut sits before a line that:
 * - follows a blank line, outside a fenced code block;
 * - starts like a paragraph, heading, fence or link (not with whitespace, a list marker or `>`);
 * - comes after a last non-blank line that was not part of a blockquote, a list or indented code.
 *
 * A document is never cut when it contains a line starting with `<` (raw HTML blocks may span blank
 * lines), or `[^` or `]:` anywhere: footnotes and link reference definitions reach across the
 * document, and a definition's label may span lines, escape brackets or sit inside a container. Nor
 * when it contains a carriage return: lines here end at `\n` only. A blank line holds only spaces and
 * tabs, as in CommonMark. The equivalence tests render the cut and the whole document and compare
 * the markup.
 *
 * Cuts only ever change which React subtree renders a block. When a later chunk removes a cut (a
 * definition arrives), the blocks after it remount, which resets a code block's Wrap Lines choice.
 */

const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const PLAIN_BLOCK_START = /^(?:[A-Za-z0-9#`~[!("'_]|\*(?![ \t]))/;
const CONTAINER_LINE = /^(?:[ \t]|>)/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HTML_LINE = /^ {0,3}</m;
const BLANK_LINE = /^[ \t]*$/;

/** The offsets at which `text`'s blocks start; always begins with 0. */
export function markdownBlockStarts(text: string): number[] {
  const starts = [0];
  if (text.includes("\r") || text.includes("[^") || text.includes("]:") || HTML_LINE.test(text)) return starts;
  let fence: { marker: string; length: number } | null = null;
  let afterBlank = false;
  /** The last non-blank line outside a fence ended a plain block (and there was one). */
  let plainBefore = false;
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(offset, end);
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) fence = null;
    } else if (BLANK_LINE.test(line)) {
      afterBlank = true;
    } else {
      const listItem = LIST_MARKER.test(line);
      if (afterBlank && plainBefore && PLAIN_BLOCK_START.test(line) && !listItem) starts.push(offset);
      afterBlank = false;
      plainBefore = !CONTAINER_LINE.test(line) && !listItem;
      const open = FENCE_OPEN.exec(line);
      // A backtick fence's info string cannot contain a backtick; such a line is inline code.
      if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
        // An indented fence may belong to a list item, where a later unindented fence line opens a
        // new fence instead of closing it. Without tracking containers, stop cutting from here on.
        if (line[0] === " ") return starts;
        fence = { marker: open[1]![0]!, length: open[1]!.length };
      }
    }
    offset = end + 1;
  }
  return starts;
}
