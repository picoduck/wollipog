export const MARKDOWN_HIGHLIGHT_MAX_BYTES = 64 * 1024;
/** Highlighted blocks kept for reuse; a long session scrolls back over far fewer distinct blocks. */
export const MARKDOWN_HIGHLIGHT_CACHE_ENTRIES = 256;

/** The subset of a hast node that lowlight emits for one highlighted block: spans and text. */
export interface HighlightNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HighlightNode[];
}

/** Highlights one fenced block, or returns null when the language is not registered. */
export type CodeHighlighter = (language: string, text: string) => HighlightNode[] | null;

/** Exact UTF-8 byte accounting without allocating a second buffer for a potentially large row. */
export function utf8ByteLengthExceeds(text: string, limit: number): boolean {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > limit) return true;
  }
  return false;
}

export function hasFencedCode(text: string): boolean {
  return /(^|\n)[\t ]{0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)/.test(text);
}

export function markdownHighlightEligible(text: string, visible: boolean): boolean {
  return visible && hasFencedCode(text) && !utf8ByteLengthExceeds(text, MARKDOWN_HIGHLIGHT_MAX_BYTES);
}

/** cyrb53: a fast 53-bit string hash. Cache hits still compare the text, so a collision is a miss. */
export function markdownBlockHash(language: string, text: string): string {
  const input = `${language}\u0000${text}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

interface CachedBlock {
  language: string;
  text: string;
  /** Null records an unregistered language, so it is not retried on every render either. */
  nodes: HighlightNode[] | null;
}

/** A bounded least-recently-used map from a block's language and text to its highlighted nodes. */
export class HighlightCache {
  private readonly entries = new Map<string, CachedBlock>();

  constructor(private readonly limit = MARKDOWN_HIGHLIGHT_CACHE_ENTRIES) {}

  get(language: string, text: string): CachedBlock | undefined {
    const key = markdownBlockHash(language, text);
    const entry = this.entries.get(key);
    if (!entry || entry.language !== language || entry.text !== text) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(language: string, text: string, nodes: HighlightNode[] | null): void {
    const key = markdownBlockHash(language, text);
    this.entries.delete(key);
    this.entries.set(key, { language, text, nodes });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  get size(): number {
    return this.entries.size;
  }
}

const cache = new HighlightCache();
let loaded: CodeHighlighter | null = null;
let loading: Promise<CodeHighlighter> | null = null;
let runs = 0;
const listeners = new Set<() => void>();

/**
 * Wraps rehype-highlight's transform so it runs on one block at a time. Each fenced block is
 * highlighted once and cached, rather than re-running the plugin over the whole document whenever a
 * row mounts again.
 */
export function createCodeHighlighter(
  transform: (tree: HighlightNode, file: { message: () => void }) => void,
): CodeHighlighter {
  return (language, text) => {
    const code: HighlightNode = {
      type: "element",
      tagName: "code",
      properties: { className: [`language-${language}`] },
      children: [{ type: "text", value: text }],
    };
    let unknownLanguage = false;
    transform(
      { type: "root", children: [{ type: "element", tagName: "pre", properties: {}, children: [code] }] },
      { message: () => { unknownLanguage = true; } },
    );
    return unknownLanguage ? null : code.children ?? null;
  };
}

/**
 * Lazily loads lowlight/highlight.js, which stays out of the initial Markdown chunk. Every mounted
 * Markdown subscribed through `subscribeCodeHighlighter` re-renders once it arrives.
 */
export function loadCodeHighlighter(): Promise<CodeHighlighter> {
  loading ??= import("rehype-highlight").then((module) => {
    loaded = createCodeHighlighter(module.default({ detect: false }) as unknown as Parameters<typeof createCodeHighlighter>[0]);
    for (const listener of listeners) listener();
    return loaded;
  }).catch((error: unknown) => {
    // Highlighting is optional; a failed chunk load leaves plain code and may be retried later.
    loading = null;
    throw error;
  });
  return loading;
}

export function loadedCodeHighlighter(): CodeHighlighter | null {
  return loaded;
}

export function subscribeCodeHighlighter(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The highlighted nodes for one block: from the cache when this language and text were seen before,
 * otherwise by running `highlighter` (when given) and caching the result. Returns undefined when
 * the block is not cached and no highlighter is available yet.
 */
export function highlightCodeBlock(
  language: string,
  text: string,
  highlighter: CodeHighlighter | null,
): HighlightNode[] | null | undefined {
  const cached = cache.get(language, text);
  if (cached) return cached.nodes;
  if (!highlighter) return undefined;
  runs += 1;
  let nodes: HighlightNode[] | null;
  try {
    nodes = highlighter(language, text);
  } catch {
    nodes = null;
  }
  cache.set(language, text, nodes);
  return nodes;
}

/** How many blocks the highlighter has run on since load; tests use it to prove cache reuse. */
export function codeHighlighterRuns(): number {
  return runs;
}
