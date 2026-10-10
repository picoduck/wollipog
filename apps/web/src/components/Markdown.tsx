import React, {
  Fragment,
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useId,
  useMemo,
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
import { markdownBlockStarts } from "./markdown-blocks.js";
import { MarkdownContentCache, type MarkdownContentProfile } from "./markdown-content-cache.js";
import { CheckIcon, ImageIcon, ImageOffIcon, WrapLinesIcon } from "./Icons.js";

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

/**
 * Where media renders. In phrasing content (a heading or emphasis) a `<figure>` is not allowed, so
 * media keeps the same layout built from spans with `role="figure"`. Inside a link it also drops
 * its own Open action, because an anchor cannot hold another; the surrounding link is the action.
 */
type MediaHost = "flow" | "phrasing" | "link";
const MediaHostContext = createContext<MediaHost>("flow");

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
  const [edges, setEdges] = useState({ scrollable: false, fadeEnd: false });
  const measuredEdges = useRef(edges);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const update = () => {
      const width = wrap.clientWidth;
      const contentWidth = wrap.scrollWidth;
      const scrollable = contentWidth - width > 1;
      const fadeEnd = scrollable && wrap.scrollLeft + width < contentWidth - 1;
      if (measuredEdges.current.scrollable === scrollable && measuredEdges.current.fadeEnd === fadeEnd) return;
      measuredEdges.current = { scrollable, fadeEnd };
      setEdges(measuredEdges.current);
    };
    wrap.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(wrap);
    if (wrap.firstElementChild) observer?.observe(wrap.firstElementChild);
    // ResizeObserver's initial delivery measures after layout, avoiding a forced mount layout.
    // Older environments still measure from a deferred task and respond to window resizing.
    const fallback = observer ? undefined : setTimeout(update, 0);
    if (!observer) window.addEventListener("resize", update);
    return () => {
      wrap.removeEventListener("scroll", update);
      observer?.disconnect();
      if (fallback !== undefined) clearTimeout(fallback);
      if (!observer) window.removeEventListener("resize", update);
    };
  }, []);
  // A wide table scrolls sideways inside its bordered wrapper rather than squeezing its cells, and
  // the trailing edge fades while columns lie beyond it. A scrolling wrapper takes focus so the
  // keyboard can scroll it too.
  return (
    <div ref={wrapRef} className="md-table-wrap" data-fade-end={edges.fadeEnd || undefined} tabIndex={edges.scrollable ? 0 : undefined}>
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

const SIGNED_URL_DATE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** When a signed URL stops working, read from its own query string; null when it names no expiry. */
export function transcriptMediaExpiry(href: string): number | null {
  let params: URLSearchParams;
  try {
    params = new URL(href).searchParams;
  } catch {
    return null;
  }
  // S3 and GCS V4: a signing time plus a lifetime in seconds.
  for (const prefix of ["X-Amz", "X-Goog"]) {
    const date = SIGNED_URL_DATE.exec(params.get(`${prefix}-Date`) ?? "");
    const lifetime = Number(params.get(`${prefix}-Expires`) ?? Number.NaN);
    if (date && Number.isFinite(lifetime)) {
      const [year, month, day, hour, minute, second] = date.slice(1).map(Number) as [number, number, number, number, number, number];
      return Date.UTC(year, month - 1, day, hour, minute, second) + lifetime * 1000;
    }
  }
  // S3 V2 and CloudFront: epoch seconds. Azure SAS: an ISO 8601 end time.
  const epoch = params.get("Expires");
  if (epoch && /^\d+$/.test(epoch)) return Number(epoch) * 1000;
  const sasEnd = Date.parse(params.get("se") ?? "");
  return Number.isFinite(sasEnd) ? sasEnd : null;
}

/** A video's length as `m:ss` or `h:mm:ss`; null while unknown (a live or unindexed stream). */
export function formatTranscriptMediaDuration(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

type TranscriptMediaState =
  | { phase: "pending" }
  | { phase: "loaded"; meta: string | null }
  | { phase: "failed" };

/**
 * A captioned figure for transcript media (docs/design-system.md §2.3, §11.3, §18): the image or
 * video, then its name, its size or length once known, and Open Full Size. The signed URL is only
 * ever the href and the source, never visible text. Until the row settles no media mounts and the
 * caption offers Open Link; a failed fetch collapses the figure to that caption with its reason.
 */
function TranscriptMediaFigure({ href, kind, label, settled, imageAlt }: {
  href: string;
  kind: TranscriptMediaKind;
  label: string;
  settled: boolean;
  imageAlt?: string;
}) {
  const [state, setState] = useState<TranscriptMediaState>({ phase: "pending" });
  const nameId = useId();
  const failed = state.phase === "failed";
  const meta = state.phase === "loaded" ? state.meta : null;
  const expiry = failed ? transcriptMediaExpiry(href) : null;
  const reason = expiry !== null && expiry <= Date.now() ? "Link expired" : `Couldn't load this ${kind}`;
  const showMedia = settled && !failed;
  const host = useContext(MediaHostContext);
  const phrasing = host !== "flow";
  const Figure = phrasing ? "span" : "figure";
  const Caption = phrasing ? "span" : "figcaption";

  return (
    <Figure
      className="md-media"
      data-media-state={settled ? state.phase : "unsettled"}
      role={phrasing ? "figure" : undefined}
      aria-labelledby={phrasing ? nameId : undefined}
    >
      {showMedia && (kind === "image" ? (
        <img
          className="md-media-image"
          src={href}
          alt={imageAlt ?? label}
          loading="lazy"
          decoding="async"
          data-load-state={state.phase}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            setState({ phase: "loaded", meta: naturalWidth && naturalHeight ? `${naturalWidth} × ${naturalHeight}` : null });
          }}
          onError={() => setState({ phase: "failed" })}
        />
      ) : (
        <video
          className="md-media-video"
          src={href}
          aria-label={label}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={(event) => setState({
            phase: "loaded",
            meta: formatTranscriptMediaDuration(event.currentTarget.duration),
          })}
          // An unindexed recording reports an unknown length at first and learns it later.
          onDurationChange={(event) => {
            const meta = formatTranscriptMediaDuration(event.currentTarget.duration);
            setState((current) => current.phase === "loaded" ? { phase: "loaded", meta } : current);
          }}
          onError={() => setState({ phase: "failed" })}
        />
      ))}
      <Caption className="md-media-cap">
        <span className="md-media-title">
          {failed && <ImageOffIcon size={14} />}
          <span className="md-media-name" id={nameId}>{label}</span>
        </span>
        {meta && <span className="md-media-meta">{meta}</span>}
        {failed && <span className="md-media-meta">{reason}</span>}
        {host !== "link" && (
          <a className="link" href={href} target="_blank" rel="noopener noreferrer" aria-describedby={nameId}>
            {showMedia ? "Open Full Size" : "Open Link"}
          </a>
        )}
      </Caption>
    </Figure>
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

/** A link's text as its author wrote it, reading a linked image's alt text as that image's words. */
function linkAuthorText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(linkAuthorText).join("");
  if (isValidElement<{ alt?: unknown; children?: ReactNode }>(node)) {
    return typeof node.props.alt === "string" ? node.props.alt : linkAuthorText(node.props.children);
  }
  return reactNodeText(node);
}

function MarkdownLink({ href, children, inlineMedia, mediaSettled, compactUrls }: ComponentProps<"a"> & {
  inlineMedia: boolean;
  mediaSettled: boolean;
  compactUrls: boolean;
}) {
  const kind = inlineMedia ? transcriptMediaKind(href) : null;
  const childText = reactNodeText(children).trim();
  if (kind && href) {
    return (
      <TranscriptMediaFigure
        key={href}
        href={href}
        kind={kind}
        label={transcriptMediaLabel(href, kind, linkAuthorText(children))}
        settled={mediaSettled}
      />
    );
  }
  const visibleChildren = compactUrls && href && isGeneratedUrlLabel(childText, href)
    ? compactMarkdownUrlLabel(href)
    : children;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      <MediaHostContext.Provider value="link">{visibleChildren}</MediaHostContext.Provider>
    </a>
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
  if (kind === "image" && href) {
    return (
      <TranscriptMediaFigure
        key={href}
        href={href}
        kind="image"
        label={transcriptMediaLabel(href, kind, alt)}
        settled={mediaSettled}
        imageAlt={alt}
      />
    );
  }
  const label = kind && href ? transcriptMediaLabel(href, kind, alt) : alt || href || "image";
  return (
    <a className="md-img-link" href={href} target="_blank" rel="noopener noreferrer">
      <ImageIcon size={14} />
      {label}
    </a>
  );
}

/** Whether a rendered paragraph child becomes a media figure rather than phrasing content. */
function isMediaChild(child: ReactNode, inlineMedia: boolean): boolean {
  if (!inlineMedia || !isValidElement<{ href?: unknown; src?: unknown }>(child)) return false;
  const { href, src } = child.props;
  if (child.type === MarkdownAnchor) return transcriptMediaKind(typeof href === "string" ? href : undefined) !== null;
  if (child.type === MarkdownImage) return transcriptMediaKind(typeof src === "string" ? src : undefined) === "image";
  return false;
}

/** Line breaks and blank text at a run's edge would only pad the paragraph around a figure. */
function isEdgeSpace(child: ReactNode): boolean {
  if (typeof child === "string") return child.trim() === "";
  return isValidElement(child) && child.type === "br";
}

/**
 * A figure is flow content and cannot sit inside a `<p>`. A paragraph holding transcript media
 * splits into its text runs, each still a paragraph, and the figures between them, in order.
 */
function MarkdownParagraph({ children, node: _node, ...props }: ComponentProps<"p"> & { node?: unknown }) {
  const { inlineMedia } = useContext(MarkdownContext);
  const items = React.Children.toArray(children);
  if (!items.some((child) => isMediaChild(child, inlineMedia))) return <p {...props}>{children}</p>;

  const blocks: ReactNode[] = [];
  let run: ReactNode[] = [];
  const flush = () => {
    let first = 0;
    let last = run.length;
    while (first < last && isEdgeSpace(run[first])) first += 1;
    while (last > first && isEdgeSpace(run[last - 1])) last -= 1;
    if (last > first) blocks.push(<p key={`text-${blocks.length}`} {...props}>{run.slice(first, last)}</p>);
    run = [];
  };
  for (const child of items) {
    if (isMediaChild(child, inlineMedia)) {
      flush();
      blocks.push(child);
    } else {
      run.push(child);
    }
  }
  flush();
  return <>{blocks}</>;
}

type PhrasingTag = "em" | "strong" | "del" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

/** An element whose content model is phrasing, so media inside it cannot be a `<figure>`. */
function phrasingElement(Tag: PhrasingTag) {
  return function PhrasingElement({ node: _node, children, ...props }: Omit<ComponentProps<"em">, "ref"> & { node?: unknown }) {
    const host = useContext(MediaHostContext);
    // Emphasis inside a link stays inside that link.
    const inner = host === "link" ? host : "phrasing";
    return <Tag {...props}><MediaHostContext.Provider value={inner}>{children}</MediaHostContext.Provider></Tag>;
  };
}

const MARKDOWN_COMPONENTS: MarkdownComponents = {
  p: MarkdownParagraph,
  em: phrasingElement("em"),
  strong: phrasingElement("strong"),
  del: phrasingElement("del"),
  h1: phrasingElement("h1"),
  h2: phrasingElement("h2"),
  h3: phrasingElement("h3"),
  h4: phrasingElement("h4"),
  h5: phrasingElement("h5"),
  h6: phrasingElement("h6"),
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

export type MarkdownProfile = MarkdownContentProfile;

export const markdownContentCache = new MarkdownContentCache<unknown>();

interface CachedParseOptions {
  source: string;
  profile: MarkdownProfile;
  admit: boolean;
  tree?: unknown;
}

function remarkCachedParser(this: { parser: (source: string, file: unknown) => unknown }, options: CachedParseOptions) {
  options.tree = markdownContentCache.get(options.profile, options.source);
  // On a hit the canonical HAST is restored by the final rehype plugin below. The intervening
  // GFM/breaks/rehype passes see an empty root, avoiding a second parse of the unchanged source.
  if (options.tree !== undefined) this.parser = () => ({ type: "root", children: [] });
}

function rehypeCachedTree(options: CachedParseOptions) {
  return (tree: unknown) => {
    if (options.tree !== undefined) return structuredClone(options.tree);
    // react-markdown's final pass mutates URLs and raw nodes. Retain a private clone before that
    // pass, then let the original go through exactly the same security policy as before.
    markdownContentCache.render(options.profile, options.source, () => structuredClone(tree), options.admit);
    return tree;
  };
}

/**
 * Cache canonical parsed HAST, never React elements or their rendering owners. Cold misses use
 * the original parser/plugins; hits skip parsing and clone the cached tree. react-markdown still
 * applies its unchanged URL/raw-HTML security policy and constructs fresh elements on every render.
 */
const ParsedMarkdown = memo(function ParsedMarkdown({ source, profile, admit }: {
  source: string; profile: MarkdownProfile; admit: boolean;
}) {
  const options: CachedParseOptions = { source, profile, admit };
  const plugins: RemarkPlugins = [...(profile === "inline" ? INLINE_PLUGINS : DOCUMENT_PLUGINS),
    [remarkCachedParser as unknown as RemarkPlugins[number], options] as RemarkPlugins[number]];
  return <ReactMarkdown remarkPlugins={plugins}
    rehypePlugins={[[rehypeCachedTree, options]]} components={MARKDOWN_COMPONENTS}>{source}</ReactMarkdown>;
});

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
 * Raw HTML stays disabled, and every media figure keeps a plain external link in its caption.
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
  // A document that starts out streaming renders block by block for as long as it is mounted, so a
  // chunk re-parses only its last block and its earlier blocks keep their state (#2763). A settled
  // document renders whole, as it always has; the two produce the same markup.
  const [blockwise] = useState(() => !settled && !inline);
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
  const context = useMemo<MarkdownRenderContext>(() => ({
    inlineMedia: inlineMedia && !inline,
    mediaSettled: activeMedia.enabled,
    compactUrls,
    highlight: eligible && settled,
    highlighter,
  }), [activeMedia.enabled, compactUrls, eligible, highlighter, inline, inlineMedia, settled]);
  return (
    <div className="md">
      <MarkdownContext.Provider value={context}>
        {blockwise ? (
          markdownBlockStarts(children).map((start, index, starts) => (
            // A whole document separates its top-level blocks with a newline text node; keep it.
            <Fragment key={start}>
              {index > 0 ? "\n" : null}
              <MarkdownBlock profile={profile} settled={settled || index < starts.length - 1}>{children.slice(start, starts[index + 1])}</MarkdownBlock>
            </Fragment>
          ))
        ) : (
          <ParsedMarkdown source={children} profile={profile} admit={settled} />
        )}
      </MarkdownContext.Provider>
    </div>
  );
});

/** One block of a blockwise document, parsed again only when its own text changes. */
const MarkdownBlock = memo(function MarkdownBlock({ children, profile, settled }: { children: string; profile: MarkdownProfile; settled: boolean }) {
  return <ParsedMarkdown source={children} profile={profile} admit={settled} />;
});
