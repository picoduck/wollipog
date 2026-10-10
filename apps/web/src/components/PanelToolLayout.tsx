import type { ReactNode, Ref } from "react";

/**
 * A side panel tool laid out as fixed slots around one scroller (docs/design-system.md §4.9; #2846):
 * a fixed `.rpanel-toolbar` above, `.rpanel-scroll` (the tool's only vertical scroller) and an
 * optional fixed `.rpanel-foot` below. Render it as the tool's body, directly inside `.rpanel-body`:
 * the slots are the body's own children, so the body gives up its scroll and padding to them.
 *
 * The toolbar slot is only the place above the scroller; the row inside it is the shared `.toolbar`
 * (§4.7), which the tool renders itself.
 */
export function PanelToolLayout({ toolbar, foot, scrollRef, scrollLabel, children }: {
  /** The fixed content above the scroller: normally one `.toolbar` row. */
  toolbar?: ReactNode;
  /** The fixed content below the scroller, such as a commit bar. */
  foot?: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
  /** Names the scroller as a region when it holds the tool's main content. */
  scrollLabel?: string;
  children: ReactNode;
}) {
  return (
    <>
      {toolbar != null && toolbar !== false && <div className="rpanel-toolbar">{toolbar}</div>}
      <div
        ref={scrollRef}
        className="rpanel-scroll"
        role={scrollLabel ? "region" : undefined}
        aria-label={scrollLabel}
        // A scroller with no focusable content still has to be reachable by keyboard to scroll.
        tabIndex={scrollLabel ? 0 : undefined}
      >
        {children}
      </div>
      {foot != null && foot !== false && <div className="rpanel-foot">{foot}</div>}
    </>
  );
}
