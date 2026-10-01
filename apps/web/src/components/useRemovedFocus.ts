import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Whether a commit just removed the focused control inside `container`, leaving focus nowhere
 * (#2202). Call the returned check from a layout effect after each commit; it answers true once per
 * removal, and only for a control that still held focus when it went. Leaving a control that stays
 * in the document is the person's own move (a click on blank space leaves focus on <body>), so it
 * never counts, even if that control is removed later.
 */
export function useRemovedFocus(container: RefObject<HTMLElement | null>): () => boolean {
  const lastFocused = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const doc = container.current?.ownerDocument ?? window.document;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      lastFocused.current = target instanceof HTMLElement && container.current?.contains(target) ? target : null;
    };
    // A removal may also report focusout, so look once it has settled: a target still in the
    // document was left on purpose.
    const onFocusOut = (event: FocusEvent) => {
      const target = event.target;
      if (target !== lastFocused.current) return;
      queueMicrotask(() => {
        if (lastFocused.current === target && (target as HTMLElement).isConnected) lastFocused.current = null;
      });
    };
    doc.addEventListener("focusin", onFocusIn);
    doc.addEventListener("focusout", onFocusOut);
    return () => {
      doc.removeEventListener("focusin", onFocusIn);
      doc.removeEventListener("focusout", onFocusOut);
    };
  }, [container]);
  return useCallback(() => {
    const last = lastFocused.current;
    if (!last || last.isConnected) return false;
    lastFocused.current = null;
    const doc = last.ownerDocument;
    const active = doc.activeElement;
    return !active || active === doc.body || !active.isConnected;
  }, []);
}
