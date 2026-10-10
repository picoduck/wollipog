import { useLayoutEffect, useState, type ReactNode } from "react";
import { InfoIcon } from "./Icons.js";
import { useDismissiblePopover } from "./interactions.js";
import { MenuSurface } from "./Menu.js";

/**
 * A panel tool's About popover (docs/design-system.md §4.9, §9.2; #2856): the explanation a tool
 * would otherwise leave on screen (what it shows, what stays private), behind an `.icon-btn` with the
 * Info icon named "About <Tool>". A tool passes it to the header's action slot
 * (`PanelHeaderActions`). Anchored on a fine pointer, a bottom sheet with the grabber on phones.
 * Escape closes only the popover and returns focus to its button.
 *
 * Its content is a short sentence-case `children` and an optional `.facts` list.
 */
export function InfoPopover({
  tool,
  facts,
  children,
}: {
  /** The tool's name, Title Case: the button and the popover are "About <tool>". */
  tool: string;
  facts?: readonly { term: string; value: ReactNode }[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const popover = useDismissiblePopover(open, setOpen, "info-popover");
  const name = `About ${tool}`;
  // Nothing in it takes focus, so the popover holds focus itself and Escape and Tab still reach it.
  useLayoutEffect(() => {
    if (open) popover.panelRef.current?.focus();
  }, [open, popover.panelRef]);
  return (
    <>
      <button
        ref={popover.triggerRef}
        type="button"
        className="icon-btn"
        title={name}
        aria-label={name}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popover.panelId : undefined}
        onClick={popover.toggle}
        onKeyDown={popover.onTriggerKeyDown}
      >
        <InfoIcon />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={popover.panelRef}
          anchor={{ trigger: popover.triggerRef }}
          id={popover.panelId}
          kind="popover"
          role="dialog"
          label={name}
          head={<div className="menu-head info-popover-head" aria-hidden="true">{name}</div>}
          align="end"
          tabIndex={-1}
          onDismiss={() => popover.close(true)}
          onKeyDown={popover.onPanelKeyDown}
        >
          <div className="info-popover-text">{children}</div>
          {facts && facts.length > 0 && (
            <dl className="facts">
              {facts.map((fact) => (
                <div key={fact.term}>
                  <dt>{fact.term}</dt>
                  <dd>{fact.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </MenuSurface>
      )}
    </>
  );
}
