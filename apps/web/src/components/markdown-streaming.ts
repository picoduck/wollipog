interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> };
}

type MarkdownParser = (source: string, file: unknown) => MarkdownNode;

const INLINE_TAIL = /^(?:paragraph|heading|tableCell)$/;
const INLINE_MARKER = /\*+|_+|~+|`+/g;
const WORD = /[\p{L}\p{N}_]/u;

function escaped(source: string, offset: number): boolean {
  let start = offset;
  while (source[start - 1] === "\\") start--;
  return (offset - start) % 2 === 1;
}

function trailingInline(node: MarkdownNode): MarkdownNode | undefined {
  if (INLINE_TAIL.test(node.type)) return node;
  const last = node.children?.at(-1);
  return last && trailingInline(last);
}

/**
 * Preview only unmatched syntax from the real parser's trailing inline block. In particular, it
 * already knows about open fences, tables, list bullets, and spans that have both delimiters.
 * Reparse the provisional source with that same grammar, leaving the recorded Markdown untouched.
 */
export function streamMarkdownTail(
  source: string,
  file: unknown,
  parse: MarkdownParser,
  tree: MarkdownNode,
): MarkdownNode {
  const tail = trailingInline(tree);
  const end = tail?.position?.end.offset;
  const children = tail?.children;
  if (end === undefined || !children || /\n[ \t]*\n/.test(source.slice(end))) return tree;

  const ranges = children.flatMap((child) => {
    const start = child.position?.start.offset;
    const stop = child.position?.end.offset;
    return child.type === "text" && start !== undefined && stop !== undefined ? [[start, stop] as const] : [];
  });
  let linkStart = -1;
  for (const [start, stop] of ranges) {
    for (const match of source.slice(start, stop).matchAll(/\[/g)) {
      const offset = start + match.index;
      if (source[offset - 1] !== "!" && !escaped(source, offset)) linkStart = offset;
    }
  }
  const labelLength = linkStart < 0 ? undefined : unfinishedLinkLabelLength(source.slice(linkStart, end));
  if (labelLength !== undefined) {
    const prefix = previewMarkers(source, ranges, 0, linkStart, false);
    // A bracket inside an open code span is code, even if it looks like a link label.
    if (!prefix.openCode) {
      const labelStart = linkStart + 1;
      const label = previewMarkers(source, ranges, labelStart, labelStart + labelLength);
      const preview = parse(source.slice(0, linkStart) + "[" + label.text + "]()" + prefix.closers + source.slice(end), file);
      markProvisionalLink(preview, linkStart);
      return preview;
    }
  }
  const { text } = previewMarkers(source, ranges, 0, end);
  return text === source.slice(0, end) ? tree : parse(text + source.slice(end), file);
}

function previewMarkers(
  source: string,
  ranges: ReadonlyArray<readonly [number, number]>,
  start: number,
  end: number,
  hideDangling = true,
) {
  const original = source.slice(start, end);
  const lastText = start + original.trimEnd().length;
  const markers: string[] = [];
  let danglingAt = end;
  for (const [textStart, textEnd] of ranges) {
    const from = Math.max(start, textStart);
    const to = Math.min(end, textEnd);
    if (from >= to) continue;
    for (const match of source.slice(from, to).matchAll(INLINE_MARKER)) {
      const offset = from + match.index;
      const marker = match[0];
      if (escaped(source, offset)) continue;
      const after = offset + marker.length;
      const before = source[offset - 1];
      const isCode = marker[0] === "`";
      // Keep intraword punctuation, spaced operators and filename globs literal. Backtick
      // spans can start within a word and may have a space before their content.
      if (!isCode && (marker.length > 3 || before && WORD.test(before))) continue;
      if (marker === "*" && source[after] === "." && WORD.test(source[after + 1] ?? "")) continue;
      if (marker === "**" && before === "/" && source[after] === "/") continue;
      if (hideDangling && after >= lastText) {
        danglingAt = offset;
        break;
      }
      if (!isCode && (/\s/u.test(source[after] ?? "") || marker === "~")) continue;
      markers.push(marker);
      if (isCode) break;
    }
    if (markers.at(-1)?.[0] === "`") break;
  }
  const openCode = markers.at(-1)?.[0] === "`";
  const closers = markers.reverse().join("");
  // Place the closers against the text so a whitespace-only chunk can't turn them into openers.
  const text = closers || danglingAt < end ? source.slice(start, danglingAt).trimEnd() + closers : original;
  return { text, closers, openCode };
}

/** Locate the unfinished label, including the chunk boundary between its closing bracket and URL. */
function unfinishedLinkLabelLength(value: string): number | undefined {
  const match = /^\[((?:\\.|[^\[\]\\\n])+)(.*)$/.exec(value);
  if (!match || !match[1]!.trim() || match[1]!.startsWith("^")) return;
  const label = match[1]!;
  const rest = match[2]!;
  if (!rest || rest === "]") return label.length;
  if (!rest.startsWith("](")) return;
  let depth = 0;
  for (let index = 2; index < rest.length; index++) {
    if (escaped(rest, index)) continue;
    if (rest[index] === "(") depth++;
    if (rest[index] === ")") {
      if (depth === 0) return;
      depth--;
    }
  }
  return label.length;
}

function markProvisionalLink(node: MarkdownNode, start: number): void {
  if (node.type === "link" && node.position?.start.offset === start) {
    node.data = { ...node.data, hProperties: { "data-streaming-link": true } };
    return;
  }
  for (const child of node.children ?? []) markProvisionalLink(child, start);
}

interface TailElement {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: TailElement[];
}

export const STREAMING_CARET_TAG = "streaming-caret";

export function rehypeStreamingCaret() {
  return (tree: TailElement) => {
    let parent = tree;
    // Descend through block containers into the final phrasing container. In particular, a
    // table or list must never receive a span as a direct child, and a link must stay clickable
    // only over its original label.
    while (parent.children) {
      let index = parent.children.length - 1;
      while (index >= 0 && parent.children[index]?.type === "text" && !parent.children[index]?.value?.trim()) index--;
      const last = parent.children[index];
      if (!last?.children || !/^(p|h[1-6]|blockquote|ol|ul|li|table|thead|tbody|tr|th|td|pre)$/.test(last.tagName ?? "")) break;
      parent = last;
    }
    // Put the caret before the parser's extra presentation newline. The empty span leaves the
    // text read by CodeBlockPre for copying and highlighting unchanged.
    if (parent.tagName === "pre") {
      const code = parent.children?.[0];
      const text = code?.children?.[0];
      if (code && text?.type === "text" && text.value?.endsWith("\n")) {
        code.children = [{ ...text, value: text.value.slice(0, -1) }, createCaret(), { type: "text", value: "\n" }];
      } else {
        code?.children?.push(createCaret());
      }
      return;
    }
    parent.children?.push(createCaret());
  };
}

function createCaret(): TailElement {
  return { type: "element", tagName: STREAMING_CARET_TAG, properties: {}, children: [] };
}
