import React, {
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
  highlightCodeBlock,
  loadCodeHighlighter,
  loadedCodeHighlighter,
  markdownHighlightEligible,
  subscribeCodeHighlighter,
  type CodeHighlighter,
  type HighlightNode,
} from "../markdown-highlight.js";
import { CopyButton } from "./common.js";
import { CheckIcon, WrapLinesIcon } from "./Icons.js";

type MarkdownComponents = NonNullable<ComponentProps<typeof ReactMarkdown>["components"]>;
type RemarkPlugins = NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>;

function reactNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return reactNodeText(node.props.children);
  return "";
}

/** ReactMarkdown appends one presentation newline to fenced blocks; do not copy that extra byte. */
export function markdownCodeText(children: ReactNode): string {
  return reactNodeText(children).replace(/\n$/, "");
}

/** Fence info-string language of a rendered block, read from react-markdown's `language-*` class. */
export function markdownCodeLanguage(children: ReactNode): string {
  if (Array.isArray(children)) return children.map(markdownCodeLanguage).find(Boolean) ?? "";
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return "";
  const match = /(?:^|\s)language-([^\s]+)/.exec(children.props.className ?? "");
  return match ? match[1]!.toLowerCase() : markdownCodeLanguage(children.props.children);
}

const PROSE_FENCE_LANGUAGES = new Set(["", "text", "txt", "plain", "plaintext", "md", "markdown"]);

/**
 * Prose-oriented fences (no language tag, `text`, `markdown`, …) wrap by default so long sentences
 * stay readable without a horizontal scrollbar; source-code fences keep `white-space: pre`.
 */
export function markdownCodeWrapsByDefault(language: string): boolean {
  return PROSE_FENCE_LANGUAGES.has(language.toLowerCase());
}

/**
 * A same-language text change reads as streaming when one text extends the other; anything else is
 * a replacement (a different block now occupies this tree position), which must not inherit state.
 */
export function markdownCodeBlockContinues(
  seen: { language: string; text: string },
  next: { language: string; text: string },
): boolean {
  if (seen.language !== next.language) return false;
  return next.text.startsWith(seen.text) || seen.text.startsWith(next.text);
}

interface MarkdownRenderContext {
  inlineMedia: boolean;
  mediaSettled: boolean;
  compactUrls: boolean;
  /** The document is settled, in view and small enough to highlight its fenced blocks now. */
  highlight: boolean;
  highlighter: CodeHighlighter | null;
}

const MarkdownContext = createContext<MarkdownRenderContext>({
  inlineMedia: false,
  mediaSettled: true,
  compactUrls: false,
  highlight: false,
  highlighter: null,
});

/** lowlight emits spans and text only; anything else still renders as a plain span, never markup. */
function renderHighlightNodes(nodes: readonly HighlightNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value ?? "";
    const classes = node.properties?.className;
    return (
      <span key={index} className={Array.isArray(classes) ? classes.join(" ") : undefined}>
        {renderHighlightNodes(node.children ?? [])}
      </span>
    );
  });
}

function CodeBlockPre({ children, node: _node, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  const { highlight, highlighter } = useContext(MarkdownContext);
  const source = reactNodeText(children);
  const text = markdownCodeText(children);
  const language = markdownCodeLanguage(children);
  const defaultWrap = markdownCodeWrapsByDefault(language);
  // React reuses this instance across content changes (a streamed info string growing `m` →
  // `markdown`, or a whole document swap), so the language-derived default cannot live in a state
  // initializer. Keep only the user's explicit choice in state, remember which block it belonged to
  // as {language, text}, and — during render, per React's state-adjustment pattern (StrictMode's
  // double render sees the updated state and takes the stable branch) — drop the choice whenever a
  // different block replaces this one. Streaming growth of the same block keeps the toggle.
  const [userWrap, setUserWrap] = useState<boolean | null>(null);
  const [seenBlock, setSeenBlock] = useState({ language, text });
  if (seenBlock.language !== language || seenBlock.text !== text) {
    if (!markdownCodeBlockContinues(seenBlock, { language, text })) setUserWrap(null);
    setSeenBlock({ language, text });
  }
  const wrap = userWrap ?? defaultWrap;
  // A settled block highlights in the render that first paints it, and from the cache when the same
  // language and text were highlighted before (scrolling back), so it never flashes plain first.
  const nodes = highlight && language ? highlightCodeBlock(language, source, highlighter) : undefined;
  // Wrapping is presentation-only: `text` always carries the original characters, so copying a
  // visually wrapped block still yields the exact fenced content.
  return (
    <div className={wrap ? "md-code-block md-code-wrap" : "md-code-block"}>
      <div className="md-code-head">
        {language && <span className="md-code-lang">{language}</span>}
        <div className="md-code-actions">
          <button
            type="button"
            className="icon-btn sm"
            title="Wrap Lines"
            aria-label="Wrap Lines"
            aria-pressed={wrap}
            onClick={() => setUserWrap(!wrap)}
          >
            <WrapLinesIcon size={16} />
          </button>
          <CopyButton text={text} iconOnly ariaLabel="Copy Code" className="icon-btn sm" />
        </div>
      </div>
      <pre {...props}>
        {nodes ? <code>{renderHighlightNodes(nodes)}</code> : children}
      </pre>
    </div>
  );
}

/** Inline code inside a table cell keeps its words whole and breaks a path at its separators. */
const TableCellContext = createContext(false);

/** A break opportunity after every `/`, `.` and `_`, and nowhere else. */
export function separatorBreaks(text: string): ReactNode[] {
  return text.split(/(?<=[/._])/).flatMap((part, index) => (index === 0 ? [part] : [<wbr key={index} />, part]));
}

function MarkdownCode({ children, node: _node, ...props }: ComponentProps<"code"> & { node?: unknown }) {
  const inCell = useContext(TableCellContext);
  return <code {...props}>{inCell && typeof children === "string" ? separatorBreaks(children) : children}</code>;
}

function MarkdownTable({ children, node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const [fadeEnd, setFadeEnd] = useState(false);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = () => {
      const overflow = wrap.scrollWidth - wrap.clientWidth > 1;
      setScrollable(overflow);
      setFadeEnd(overflow && wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1);
    };
    update();
    wrap.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(wrap);
    if (wrap.firstElementChild) observer?.observe(wrap.firstElementChild);
    return () => {
      wrap.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);
  // A wide table scrolls sideways inside its bordered wrapper rather than squeezing its cells, and
  // the trailing edge fades while columns lie beyond it. A scrolling wrapper takes focus so the
  // keyboard can scroll it too.
  return (
    <div ref={wrapRef} className="md-table-wrap" data-fade-end={fadeEnd || undefined} tabIndex={scrollable ? 0 : undefined}>
      <table {...props}>{children}</table>
    </div>
  );
}

type CellProps = ComponentProps<"td"> & { node?: { properties?: { align?: unknown } } };

/**
 * A column aligned right or center in the markdown holds figures, so its cells take `.num`
 * (tabular, unwrapped, right-aligned) in place of react-markdown's inline text-align.
 */
function cellAttributes({ node, style, className }: CellProps): { className?: string; style?: CSSProperties } {
  const align = node?.properties?.align ?? style?.textAlign;
  if (align !== "right" && align !== "center") return { className, style };
  const { textAlign: _textAlign, ...rest }: CSSProperties = style ?? {};
  return {
    className: className ? `${className} num` : "num",
    style: Object.keys(rest).length > 0 ? rest : undefined,
  };
}

function MarkdownHeaderCell({ children, node, style, className, ...props }: CellProps) {
  return (
    <TableCellContext.Provider value>
      <th {...props} {...cellAttributes({ node, style, className })}>{children}</th>
    </TableCellContext.Provider>
  );
}

function MarkdownDataCell({ children, node, style, className, ...props }: CellProps) {
  return (
    <TableCellContext.Provider value>
      <td {...props} {...cellAttributes({ node, style, className })}>{children}</td>
    </TableCellContext.Provider>
  );
}

/** A task-list box is read-only, so it is drawn with the checkbox recipe, not a disabled control. */
function MarkdownInput({ type, checked, node: _node, ...props }: ComponentProps<"input"> & { node?: unknown }) {
  if (type !== "checkbox") return <input type={type} checked={checked} {...props} />;
  return (
    <span className="md-check" role="img" aria-label={checked ? "Done" : "Not Done"} data-checked={checked || undefined}>
      {checked && <CheckIcon size={14} className="md-check-mark" />}
    </span>
  );
}

export type TranscriptMediaKind = "image" | "video";

const TRANSCRIPT_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TRANSCRIPT_VIDEO_EXTENSIONS = new Set([".mp4", ".webm"]);
const UNSAFE_GENERATED_MEDIA_LABEL = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** Classify only HTTPS media paths; query strings and fragments never influence the file type. */
export function transcriptMediaKind(href: string | undefined): TranscriptMediaKind | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return null;
    const pathname = url.pathname.toLowerCase();
    if ([...TRANSCRIPT_IMAGE_EXTENSIONS].some((extension) => pathname.endsWith(extension))) return "image";
    if ([...TRANSCRIPT_VIDEO_EXTENSIONS].some((extension) => pathname.endsWith(extension))) return "video";
  } catch {
    // Malformed and relative URLs remain ordinary links and never become remote fetches.
  }
  return null;
}

/** Prefer author text, then a decoded path basename; signed query strings are never announced. */
export function transcriptMediaLabel(
  href: string,
  kind: TranscriptMediaKind,
  authorLabel?: string,
): string {
  const trimmed = authorLabel?.trim();
  if (trimmed && trimmed !== href) {
    try {
      // GFM preserves raw Unicode as link text while normalizing the href. Treat both forms as the
      // generated autolink URL so signatures never become an accessibility label.
      if (new URL(trimmed).href !== new URL(href).href) return trimmed;
    } catch {
      return trimmed;
    }
  }
  try {
    const basename = new URL(href).pathname.split("/").filter(Boolean).at(-1);
    if (basename) {
      try {
        const decoded = decodeURIComponent(basename).replace(UNSAFE_GENERATED_MEDIA_LABEL, "").trim();
        if (decoded) return decoded;
      } catch {
        const sanitized = basename.replace(UNSAFE_GENERATED_MEDIA_LABEL, "").trim();
        if (sanitized) return sanitized;
      }
    }
  } catch {
    // Classification already rejects malformed media URLs; keep this helper defensive for tests.
  }
  return kind === "image" ? "Image" : "Video";
}

function TranscriptMediaEmbed({ href, kind, label, imageAlt }: {
  href: string;
  kind: TranscriptMediaKind;
  label: string;
  imageAlt?: string;
}) {
  const [loadState, setLoadState] = useState<"pending" | "loaded" | "failed">("pending");
  if (loadState === "failed") return null;

  return (
    <span className="md-media-embed">
      {kind === "image" ? (
        <a
          className="md-media-image-link"
          href={loadState === "loaded" ? href : undefined}
          target={loadState === "loaded" ? "_blank" : undefined}
          rel={loadState === "loaded" ? "noopener noreferrer" : undefined}
          aria-label={loadState === "loaded" ? `Open ${label} Full Size` : undefined}
          aria-hidden={loadState === "loaded" ? undefined : true}
        >
          <img
            className="md-media-image"
            src={href}
            alt={imageAlt ?? label}
            loading="lazy"
            decoding="async"
            data-load-state={loadState}
            onLoad={() => setLoadState("loaded")}
            onError={() => setLoadState("failed")}
          />
        </a>
      ) : (
        <video
          className="md-media-video"
          src={href}
          aria-label={label}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={() => setLoadState("loaded")}
          onError={() => setLoadState("failed")}
        />
      )}
    </span>
  );
}

/** A stable, query-free label for generated URL links; the anchor still retains the full href. */
export function compactMarkdownUrlLabel(href: string): string {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return href;
    const basename = url.pathname.split("/").filter(Boolean).at(-1);
    if (!basename) return url.hostname;
    let decoded = basename;
    try {
      decoded = decodeURIComponent(basename);
    } catch {
      // Keep the encoded path segment when it is malformed.
    }
    const safe = decoded.replace(UNSAFE_GENERATED_MEDIA_LABEL, "").trim() || "link";
    const bounded = safe.length > 48 ? `${safe.slice(0, 45)}…` : safe;
    return `${url.hostname}/${bounded}`;
  } catch {
    return href;
  }
}

function isGeneratedUrlLabel(label: string, href: string): boolean {
  try {
    return new URL(label).href === new URL(href).href;
  } catch {
    return false;
  }
}

function MarkdownLink({ href, children, inlineMedia, mediaSettled, compactUrls }: ComponentProps<"a"> & {
  inlineMedia: boolean;
  mediaSettled: boolean;
  compactUrls: boolean;
}) {
  const kind = inlineMedia ? transcriptMediaKind(href) : null;
  const childText = reactNodeText(children).trim();
  const label = kind && href ? transcriptMediaLabel(href, kind, childText) : childText || href || "media";
  const visibleChildren = compactUrls && href && isGeneratedUrlLabel(childText, href)
    ? compactMarkdownUrlLabel(href)
    : children;
  return (
    <>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {visibleChildren}
      </a>
      {kind && href && mediaSettled && (
        <TranscriptMediaEmbed key={href} href={href} kind={kind} label={label} />
      )}
    </>
  );
}

function MarkdownAnchor({ href, children }: ComponentProps<"a">) {
  const { inlineMedia, mediaSettled, compactUrls } = useContext(MarkdownContext);
  return (
    <MarkdownLink href={href} inlineMedia={inlineMedia} mediaSettled={mediaSettled} compactUrls={compactUrls}>
      {children}
    </MarkdownLink>
  );
}

function MarkdownImage({ src, alt }: ComponentProps<"img">) {
  const { inlineMedia, mediaSettled } = useContext(MarkdownContext);
  const href = typeof src === "string" ? src : undefined;
  const kind = inlineMedia ? transcriptMediaKind(href) : null;
  const label = kind && href ? transcriptMediaLabel(href, kind, alt) : alt || href || "image";
  if (kind === "image" && href && mediaSettled) {
    return (
      <>
        <a className="md-img-link" href={href} target="_blank" rel="noopener noreferrer">🖼 {label}</a>
        <TranscriptMediaEmbed key={href} href={href} kind="image" label={label} imageAlt={alt} />
      </>
    );
  }
  return (
    <a className="md-img-link" href={href} target="_blank" rel="noopener noreferrer">🖼 {label}</a>
  );
}

const MARKDOWN_COMPONENTS: MarkdownComponents = {
  pre: CodeBlockPre,
  code: MarkdownCode,
  table: MarkdownTable,
  th: MarkdownHeaderCell,
  td: MarkdownDataCell,
  input: MarkdownInput,
  a: MarkdownAnchor,
  img: MarkdownImage,
};

/**
 * The micromark constructs a user message does not use. Its source then renders as the text the
 * person typed: `# Heading` stays a line starting with `#`, a pipe table stays pipes, `![](…)`
 * stays a link and fetches nothing, and `<b>` stays visible text.
 */
const INLINE_PROFILE_DISABLED_CONSTRUCTS = [
  "headingAtx",
  "setextUnderline",
  "thematicBreak",
  "blockQuote",
  "codeIndented",
  "htmlFlow",
  "htmlText",
  "labelStartImage",
  "table",
];

function remarkInlineProfile(this: { data(): Record<string, unknown> }) {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push({ disable: { null: INLINE_PROFILE_DISABLED_CONSTRUCTS } });
}

const DOCUMENT_PLUGINS: RemarkPlugins = [remarkGfm, remarkBreaks];
const INLINE_PLUGINS: RemarkPlugins = [remarkGfm, remarkBreaks, remarkInlineProfile as unknown as RemarkPlugins[number]];

export type MarkdownProfile = "document" | "inline";

/**
 * Markdown renderer for agent messages, reasoning, user messages and markdown previews. GFM
 * (tables, task lists, strikethrough, autolinks) plus syntax-highlighted code fences (lowlight's
 * `hljs-*` classes, themed in styles.css). react-markdown does NOT render raw HTML by default, so
 * adopted/agent transcript content can't inject markup. Links open in a new tab.
 *
 * `remark-breaks` keeps single newlines as line breaks, so line-oriented agent output (status
 * lines, pasted command output) doesn't collapse into one paragraph the way CommonMark would.
 *
 * The `inline` profile is for what a person typed: code spans, emphasis, links, lists and fenced
 * code, with no headings, tables, quotes, images or media (INLINE_PROFILE_DISABLED_CONSTRUCTS).
 *
 * Security: transcript content is semi-untrusted. Callers must explicitly opt into inline media;
 * even then only HTTPS URLs with known image/video path extensions become `<img>`/`<video>` fetches.
 * Raw HTML stays disabled and all media retains a plain external link as its failure fallback.
 *
 * Memoized on `children`: agent bubbles re-render on every streaming chunk, and re-parsing a long
 * message each tick is wasteful — the same text string skips the markdown pipeline.
 */
export const Markdown = memo(function Markdown({
  children,
  profile = "document",
  highlightEligible = true,
  inlineMedia = false,
  settled = true,
  compactUrls = false,
}: {
  children: string;
  profile?: MarkdownProfile;
  /** False opts out of highlighting; timeline virtualization passes whether the row is in view. */
  highlightEligible?: boolean;
  /** Transcript-only opt-in for HTTPS image and video URL embeds. */
  inlineMedia?: boolean;
  /**
   * False while a transcript row is still streaming: its code highlights and its remote media
   * mounts only once the row completes.
   */
  settled?: boolean;
  /** Replace generated absolute-URL text with a bounded, query-free label while retaining href. */
  compactUrls?: boolean;
}) {
  const highlighter = useSyncExternalStore(subscribeCodeHighlighter, loadedCodeHighlighter, () => null);
  const eligible = markdownHighlightEligible(children, highlightEligible);
  useEffect(() => {
    // The highlighter loads once, as soon as any document with a fence could use it, so a row is
    // usually highlighted in its first paint. A failed load leaves safe, plain Markdown.
    if (eligible && !highlighter) loadCodeHighlighter().catch(() => undefined);
  }, [eligible, highlighter]);

  const inline = profile === "inline";
  // Settlement is monotonic for one streamed document: a later session-active transition must not
  // hide or refetch media that already loaded. An unrelated replacement starts its own lifecycle.
  const [mediaActivation, setMediaActivation] = useState({ text: children, enabled: settled });
  let activeMedia = mediaActivation;
  const previousMedia = mediaActivation;
  if (previousMedia.text !== children) {
    const continues = children.startsWith(previousMedia.text) || previousMedia.text.startsWith(children);
    activeMedia = {
      text: children,
      enabled: settled || (continues && previousMedia.enabled),
    };
    setMediaActivation(activeMedia);
  } else if (settled && !previousMedia.enabled) {
    activeMedia = { text: children, enabled: true };
    setMediaActivation(activeMedia);
  }
  // ReactMarkdown uses each renderer function as the React element type. Keep these identities
  // stable across scroll-driven highlightEligible changes so loaded media is updated in place
  // instead of remounting, collapsing its row, and issuing another remote request.
  return (
    <div className="md">
      <MarkdownContext.Provider value={{
        inlineMedia: inlineMedia && !inline,
        mediaSettled: activeMedia.enabled,
        compactUrls,
        highlight: eligible && settled,
        highlighter,
      }}>
        <ReactMarkdown remarkPlugins={inline ? INLINE_PLUGINS : DOCUMENT_PLUGINS} components={MARKDOWN_COMPONENTS}>
          {children}
        </ReactMarkdown>
      </MarkdownContext.Provider>
    </div>
  );
});
