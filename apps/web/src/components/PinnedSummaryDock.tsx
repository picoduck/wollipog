import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * The Pinned Summary's container beside the reader (#2147; docs/design-system.md §4.3): a column
 * that takes its own width while docked, otherwise a drawer over the reader with a scrim over the
 * reader only. The session bar is outside the scrim, so the toggle, the status popover, Share and
 * More Actions stay usable while the drawer is open. The phone sheet is a dialog (SessionDetail).
 */
export function PinnedSummaryDock({
  presentation,
  onClose,
  toggleRef,
  children,
}: {
  presentation: "docked" | "drawer";
  onClose: () => void;
  toggleRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const asideRef = useRef<HTMLElement>(null);
  const drawer = presentation === "drawer";
  // Focus moves into the drawer when it opens, and back to the toggle when it closes with focus
  // inside it (a narrowing or widening closes it as well). The cleanup runs before React removes
  // the aside, so it can still see where focus is. Escape and the scrim return focus themselves.
  useLayoutEffect(() => {
    const aside = asideRef.current;
    if (!drawer || !aside) return;
    aside.focus({ preventScroll: true });
    return () => {
      if (aside.contains(aside.ownerDocument.activeElement)) toggleRef.current?.focus();
    };
  }, [drawer, toggleRef]);

  return (
    <>
      {drawer && (
        <div
          className="ps-scrim"
          aria-hidden="true"
          onClick={() => {
            onClose();
            toggleRef.current?.focus();
          }}
        />
      )}
      <aside
        ref={asideRef}
        className="ps"
        data-presentation={presentation}
        aria-label="Pinned Summary"
        tabIndex={drawer ? -1 : undefined}
      >
        {children}
      </aside>
    </>
  );
}
