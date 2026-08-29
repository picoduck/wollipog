import { createContext, isValidElement, memo, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
  browserTimerDriver,
  CancelableIdleTaskQueue,
  createBrowserIdleDriver,
  markdownHighlightEligible,
  StableIdleTaskCoordinator,
} from "../markdown-highlight.js";
import { CopyButton } from "./common.js";

type RehypePlugins = NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]>;
type MarkdownComponents = NonNullable<ComponentProps<typeof ReactMarkdown>["components"]>;

const highlightQueue = new CancelableIdleTaskQueue(createBrowserIdleDriver());
const highlightCoordinator = new StableIdleTaskCoordinator<symbol>(highlightQueue, browserTimerDriver);
let highlightPluginsPromise: Promise<RehypePlugins> | null = null;

function loadHighlightPlugins(): Promise<RehypePlugins> {
  // Keep lowlight/highlight.js out of the initial Markdown chunk and load it only after a visible,
  // stable fenced block reaches the global idle queue. The module promise is shared by all rows.
  highlightPluginsPromise ??= import("rehype-highlight").then(
    (module) => [[module.default, { detect: false }]] as RehypePlugins,
  );
  return highlightPluginsPromise;
}

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

function CodeBlockPre({ children, node: _node, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
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
  // Wrapping is presentation-only: `text` always carries the original characters, so copying a
  // visually wrapped block still yields the exact fenced content.
  return (
    <div className={wrap ? "md-code-block md-code-wrap" : "md-code-block"}>
      <div className="md-code-actions">
        <button type="button" className="copy-btn md-code-wrap-toggle" onClick={() => setUserWrap(!wrap)}>
          {wrap ? "No Wrap" : "Wrap Lines"}
        </button>
        <CopyButton text={text} label="Copy Code" ariaLabel="Copy Code Block" className="copy-btn md-code-copy" />
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );
}

export type TranscriptMediaKind = "image" | "video";

const TRANSCRIPT_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TRANSCRIPT_VIDEO_EXTENSIONS = new Set([".mp4", ".webm"]);
const UNSAFE_GENERATED_MEDIA_LABEL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

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

function MarkdownLink({ href, children, inlineMedia, mediaSettled }: ComponentProps<"a"> & {
  inlineMedia: boolean;
  mediaSettled: boolean;
}) {
  const kind = inlineMedia ? transcriptMediaKind(href) : null;
  const childText = reactNodeText(children).trim();
  const label = kind && href ? transcriptMediaLabel(href, kind, childText) : childText || href || "media";
  return (
    <>
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
      {kind && href && mediaSettled && (
        <TranscriptMediaEmbed key={href} href={href} kind={kind} label={label} />
      )}
    </>
  );
}

const MarkdownMediaContext = createContext({ inlineMedia: false, mediaSettled: true });

function MarkdownAnchor({ href, children }: ComponentProps<"a">) {
  const { inlineMedia, mediaSettled } = useContext(MarkdownMediaContext);
  return (
    <MarkdownLink href={href} inlineMedia={inlineMedia} mediaSettled={mediaSettled}>
      {children}
    </MarkdownLink>
  );
}

function MarkdownImage({ src, alt }: ComponentProps<"img">) {
  const { inlineMedia, mediaSettled } = useContext(MarkdownMediaContext);
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
  a: MarkdownAnchor,
  img: MarkdownImage,
};

/**
 * Markdown renderer for agent messages + reasoning. GFM (tables, task lists, strikethrough,
 * autolinks) plus syntax-highlighted code fences via rehype-highlight (adds `hljs-*` classes;
 * themed in styles.css). react-markdown does NOT render raw HTML by default, so adopted/agent
 * transcript content can't inject markup. Links open in a new tab.
 *
 * `remark-breaks` keeps single newlines as line breaks, so line-oriented agent output (status
 * lines, pasted command output) doesn't collapse into one paragraph the way CommonMark would.
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
  highlightEligible = true,
  inlineMedia = false,
  mediaSettled = true,
}: {
  children: string;
  /** Timeline virtualization passes whether this settled row currently intersects the viewport. */
  highlightEligible?: boolean;
  /** Transcript-only opt-in for HTTPS image and video URL embeds. */
  inlineMedia?: boolean;
  /** False while a transcript row is still streaming; remote media mounts only after completion. */
  mediaSettled?: boolean;
}) {
  const key = useRef<symbol | null>(null);
  key.current ??= Symbol("markdown-highlight");
  const cancelApply = useRef<(() => void) | null>(null);
  const [highlighted, setHighlighted] = useState<{ text: string; plugins: RehypePlugins } | null>(null);
  const eligible = markdownHighlightEligible(children, highlightEligible);

  useEffect(() => {
    const taskKey = key.current!;
    highlightCoordinator.cancel(taskKey);
    cancelApply.current?.();
    cancelApply.current = null;
    // The current render already ignores a stale text/plugin pair. Clearing it here also prevents
    // a later visibility episode from synchronously reusing an old highlighted rendering.
    setHighlighted(null);
    if (!eligible) return;

    let current = true;
    highlightCoordinator.schedule(taskKey, () => {
      void loadHighlightPlugins().then((plugins) => {
        if (!current) return;
        // The first idle turn starts the lazy import. Re-enter the queue after it resolves so a
        // module/network delay cannot enable the synchronous plugin during a busy turn.
        cancelApply.current = highlightQueue.enqueue(() => {
          cancelApply.current = null;
          if (current) setHighlighted({ text: children, plugins });
        });
      }).catch(() => {
        // Highlighting is optional; a chunk-load or parser failure leaves safe Markdown intact.
      });
    });
    return () => {
      current = false;
      highlightCoordinator.cancel(taskKey);
      cancelApply.current?.();
      cancelApply.current = null;
    };
  }, [children, eligible]);

  const rehypePlugins = eligible && highlighted?.text === children ? highlighted.plugins : undefined;
  // Settlement is monotonic for one streamed document: a later session-active transition must not
  // hide or refetch media that already loaded. An unrelated replacement starts its own lifecycle.
  const [mediaActivation, setMediaActivation] = useState({ text: children, enabled: mediaSettled });
  let activeMedia = mediaActivation;
  const previousMedia = mediaActivation;
  if (previousMedia.text !== children) {
    const continues = children.startsWith(previousMedia.text) || previousMedia.text.startsWith(children);
    activeMedia = {
      text: children,
      enabled: mediaSettled || (continues && previousMedia.enabled),
    };
    setMediaActivation(activeMedia);
  } else if (mediaSettled && !previousMedia.enabled) {
    activeMedia = { text: children, enabled: true };
    setMediaActivation(activeMedia);
  }
  // ReactMarkdown uses each renderer function as the React element type. Keep these identities
  // stable across scroll-driven highlightEligible changes so loaded media is updated in place
  // instead of remounting, collapsing its row, and issuing another remote request.
  return (
    <div className="md">
      <MarkdownMediaContext.Provider value={{ inlineMedia, mediaSettled: activeMedia.enabled }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkBreaks]}
          rehypePlugins={rehypePlugins}
          components={MARKDOWN_COMPONENTS}
        >
          {children}
        </ReactMarkdown>
      </MarkdownMediaContext.Provider>
    </div>
  );
});
