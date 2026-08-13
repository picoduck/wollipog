import { isValidElement, memo, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
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

function CodeBlockPre({ children, node: _node, ...props }: ComponentProps<"pre"> & { node?: unknown }) {
  const text = markdownCodeText(children);
  return (
    <div className="md-code-block">
      <CopyButton text={text} label="Copy Code" ariaLabel="Copy Code Block" className="copy-btn md-code-copy" />
      <pre {...props}>{children}</pre>
    </div>
  );
}

/**
 * Markdown renderer for agent messages + reasoning. GFM (tables, task lists, strikethrough,
 * autolinks) plus syntax-highlighted code fences via rehype-highlight (adds `hljs-*` classes;
 * themed in styles.css). react-markdown does NOT render raw HTML by default, so adopted/agent
 * transcript content can't inject markup. Links open in a new tab.
 *
 * `remark-breaks` keeps single newlines as line breaks, so line-oriented agent output (status
 * lines, pasted command output) doesn't collapse into one paragraph the way CommonMark would.
 *
 * Security: transcript content is semi-untrusted. We do NOT auto-load images — `![](url)` is
 * rendered as a plain link instead of an `<img>`, so opening a session can't trigger a fetch to an
 * attacker-controlled URL (which would leak that the session was viewed + the client IP / reachability).
 *
 * Memoized on `children`: agent bubbles re-render on every streaming chunk, and re-parsing a long
 * message each tick is wasteful — the same text string skips the markdown pipeline.
 */
export const Markdown = memo(function Markdown({
  children,
  highlightEligible = true,
}: {
  children: string;
  /** Timeline virtualization passes whether this settled row currently intersects the viewport. */
  highlightEligible?: boolean;
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
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={rehypePlugins}
        components={{
          pre: CodeBlockPre,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          // Never auto-fetch transcript-provided images — render as a (non-loading) link instead.
          img: ({ src, alt }) => (
            <a className="md-img-link" href={typeof src === "string" ? src : undefined} target="_blank" rel="noopener noreferrer">
              🖼 {alt || (typeof src === "string" ? src : "image")}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
