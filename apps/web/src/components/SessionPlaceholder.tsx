import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DetailPlaceholder } from "../detail-placeholder.js";
import { backLabel } from "../navigation.js";
import { windowDragRegion } from "../desktop-window.js";
import { ChevronLeftIcon } from "./Icons.js";
import { useOpenSearchPalette } from "./search-palette-context.js";
import { State } from "./State.js";
import { TranscriptSkeleton } from "./TranscriptSkeleton.js";

/** Loading shows nothing new for this long, so a quick lookup never flashes a skeleton (§12.3). */
export const SESSION_PLACEHOLDER_SKELETON_DELAY_MS = 300;

/**
 * The Session page while its session is not loaded: Loading, Not Found, Waiting to Reconnect, Pair
 * to Load Session or Couldn't Load Session (docs/design-system.md §12, #2202).
 *
 * The page has one heading. On desktop the session bar keeps only Back and the state carries the
 * page's `h1` (`#page-title`, the focus-rescue anchor); Loading's heading is visually hidden, since
 * the state is skeleton rows. On phones the app's top bar shows the title, so the state leaves its
 * own out. A preview pane has no bar and no page heading, so its state keeps a plain title.
 */
export function SessionPlaceholder({
  sessionId,
  placeholder,
  preview,
  isMobile,
  onBack,
  onRetry,
}: {
  sessionId: string;
  placeholder: DetailPlaceholder;
  preview: boolean;
  isMobile: boolean;
  onBack: () => void;
  onRetry: () => void;
}) {
  const openSearch = useOpenSearchPalette();
  const ownsPageTitle = !preview && !isMobile;
  const loading = placeholder.variant === "loading";
  const [skeletonShown, setSkeletonShown] = useState(false);
  // Reset while rendering, so Loading that returns after another state never shows its skeleton
  // early for a frame.
  if (skeletonShown && !loading) setSkeletonShown(false);
  useEffect(() => {
    if (!loading) return;
    const timer = window.setTimeout(() => setSkeletonShown(true), SESSION_PLACEHOLDER_SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [loading]);

  // Retry swaps the error for Loading, and the state change can take the focused button with it.
  // Focus that was in this view and is now nowhere goes to the page title rather than <body>.
  const rootRef = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);
  useEffect(() => {
    const doc = rootRef.current?.ownerDocument;
    if (!doc) return;
    const onFocusIn = (event: FocusEvent) => {
      focusInside.current = event.target instanceof Node && rootRef.current?.contains(event.target) === true;
    };
    doc.addEventListener("focusin", onFocusIn);
    return () => doc.removeEventListener("focusin", onFocusIn);
  }, []);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !focusInside.current) return;
    const doc = root.ownerDocument;
    const active = doc.activeElement;
    if (active && active !== doc.body && active.isConnected) return;
    focusInside.current = false;
    doc.getElementById("page-title")?.focus();
  });

  const actions = placeholder.actions.flatMap((action) => {
    if (action === "back") {
      // A preview pane is already on Sessions.
      return preview ? [] : [
        <button key="back" type="button" className="btn primary" onClick={onBack}>{backLabel("inbox")}</button>,
      ];
    }
    if (action === "search") {
      return openSearch ? [
        <button
          key="search"
          type="button"
          className="btn"
          onClick={(event) => {
            // Safari does not focus a clicked button, and the palette returns focus to whatever held
            // it when it opened.
            event.currentTarget.focus();
            openSearch();
          }}
        >
          Search Sessions
        </button>,
      ] : [];
    }
    return [<button key="retry" type="button" className="btn sm" onClick={onRetry}>Retry</button>];
  });
  const title = isMobile && !preview ? undefined : placeholder.title;

  return (
    <div ref={rootRef} className="session-detail expanded" data-session-surface-id={sessionId}
      data-placeholder={placeholder.variant}>
      {!preview && !isMobile && (
        <header className="detail-bar session-bar" {...windowDragRegion()}>
          <button
            type="button"
            className="icon-btn detail-bar-back"
            onClick={onBack}
            title={backLabel("inbox")}
            aria-label={backLabel("inbox")}
          >
            <ChevronLeftIcon />
          </button>
        </header>
      )}
      {loading ? (
        <>
          {ownsPageTitle && <h1 className="sr-only" id="page-title" tabIndex={-1}>{placeholder.title}</h1>}
          {skeletonShown && <TranscriptSkeleton label={placeholder.title.replace(/…$/u, "")} />}
        </>
      ) : (
        <State
          variant={placeholder.variant}
          title={title}
          headingLevel={ownsPageTitle ? 1 : undefined}
          titleId={ownsPageTitle ? "page-title" : undefined}
          actions={actions.length > 0 ? actions : undefined}
          details={placeholder.details && <div className="code-well"><code>{placeholder.details}</code></div>}
        >
          {placeholder.hint}
        </State>
      )}
    </div>
  );
}
