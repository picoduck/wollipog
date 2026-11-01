/**
 * Artifact ids an agent cites in its reply (#3970). The control plane names a session artifact
 * `art_` and 12 hex digits, or 32 for one derived from its content; nothing else is read as one.
 */
const ARTIFACT_ID_SOURCE = "\\bart_[0-9a-f]{12}(?:[0-9a-f]{20})?\\b";
const ARTIFACT_ID = new RegExp(`^${ARTIFACT_ID_SOURCE}$`);

export const isArtifactId = (value: string): boolean => ARTIFACT_ID.test(value);

/** The text split around each artifact id it names, in order; text without one is one part. */
export function splitArtifactIds(text: string): Array<{ text: string } | { id: string }> {
  if (!text.includes("art_")) return [{ text }];
  const parts: Array<{ text: string } | { id: string }> = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(ARTIFACT_ID_SOURCE, "g"))) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ id: match[0] });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.length > 0 ? parts : [{ text }];
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The artifact ids a Markdown reply cites, each once, in order of first mention. A fenced code
 * block is quoted material, so ids inside one are not references.
 */
export function referencedArtifactIds(markdown: string): string[] {
  if (!markdown.includes("art_")) return [];
  const ids = new Set<string>();
  let fence: { char: string; length: number } | null = null;
  for (const line of markdown.split("\n")) {
    const opener = FENCE.exec(line);
    if (fence) {
      if (opener && opener[1]![0] === fence.char && opener[1]!.length >= fence.length && line.trim() === opener[1]) fence = null;
      continue;
    }
    if (opener) {
      fence = { char: opener[1]![0]!, length: opener[1]!.length };
      continue;
    }
    for (const part of splitArtifactIds(line)) if ("id" in part) ids.add(part.id);
  }
  return [...ids];
}

/** The element an id becomes in the parsed reply, for `MarkdownArtifactReference` to resolve. */
export const ARTIFACT_REFERENCE_TAG = "artifact-reference";

interface HastText { type: "text"; value: string }
interface HastElement {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] };

const referenceElement = (id: string, code: boolean): HastElement => ({
  type: "element",
  tagName: ARTIFACT_REFERENCE_TAG,
  properties: code ? { dataCode: "true" } : {},
  children: [{ type: "text", value: id }],
});

/**
 * A rehype pass that marks each artifact id in prose, and each inline code span that is exactly
 * one, as an `artifact-reference` element holding the id as its text. Fenced code (`pre`) is left
 * alone. The element renders as the plain id wherever no session resolves it, so the pass changes
 * nothing a reader sees outside a session's transcript.
 */
export function rehypeArtifactReferences() {
  const visit = (node: HastNode): void => {
    const children = "children" in node ? node.children : undefined;
    if (!children) return;
    const next: HastNode[] = [];
    let changed = false;
    for (const child of children) {
      if (child.type === "text" && (child as HastText).value.includes("art_")) {
        const parts = splitArtifactIds((child as HastText).value);
        if (parts.some((part) => "id" in part)) {
          changed = true;
          for (const part of parts) next.push("id" in part ? referenceElement(part.id, false) : { type: "text", value: part.text });
          continue;
        }
      }
      if (child.type === "element") {
        const element = child as HastElement;
        if (element.tagName === "pre") {
          next.push(element);
          continue;
        }
        const only = element.children.length === 1 ? element.children[0] : undefined;
        if (element.tagName === "code" && only?.type === "text" && isArtifactId((only as HastText).value.trim())) {
          changed = true;
          next.push(referenceElement((only as HastText).value.trim(), true));
          continue;
        }
        // Any other code span is code: an id among its words is quoted, not cited.
        if (element.tagName !== "code") visit(element);
      }
      next.push(child);
    }
    if (changed) (node as { children: HastNode[] }).children = next;
  };
  return (tree: HastNode) => visit(tree);
}
