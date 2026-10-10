import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { backLabel } from "../navigation.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { DetailBar } from "./PageHeader.js";
import { useRemovedFocus } from "./useRemovedFocus.js";

/** A reader download/render failure must leave its Sessions list and navigation usable. Recovery
 * uses the standard explicit Reload Page action: browsers cache failed module imports. */
export function LazySessionBoundary({ sessionId, preview, isMobile, onBack, containerRef, children }: {
  sessionId: string;
  preview: boolean;
  isMobile: boolean;
  onBack: () => void;
  containerRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const removedFocus = useRemovedFocus(containerRef);
  return (
    <ErrorBoundary name="This Session" resetKey={sessionId} wrapError={(notice) => (
      <FailedSessionSurface sessionId={sessionId} preview={preview} isMobile={isMobile}
        onBack={onBack} removedFocus={removedFocus}>{notice}</FailedSessionSurface>
    )}>
      {children}
    </ErrorBoundary>
  );
}

function FailedSessionSurface({ sessionId, preview, isMobile, onBack, removedFocus, children }: {
  sessionId: string;
  preview: boolean;
  isMobile: boolean;
  onBack: () => void;
  removedFocus: () => boolean;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (removedFocus()) {
      const root = rootRef.current;
      (preview ? root?.querySelector<HTMLElement>(".detail-scroll") : root?.ownerDocument.getElementById("page-title"))?.focus();
    }
  }, [preview, removedFocus]);
  return (
    <div ref={rootRef} className="session-detail expanded" data-session-surface-id={sessionId}>
      {!preview && !isMobile && <DetailBar title="Session" backLabel={backLabel("inbox")} onBack={onBack} />}
      <div className="detail-scroll" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
