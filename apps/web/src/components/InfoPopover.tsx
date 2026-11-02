import { useLayoutEffect, useState, type ReactNode } from "react";
import { InfoIcon } from "./Icons.js";
import { useDismissiblePopover } from "./interactions.js";
import { MenuSurface } from "./Menu.js";
import { useIsMobile } from "./useIsMobile.js";

/**
 * A panel tool's About popover (docs/design-system.md §4.9, §9.2; #2856): the explanation a tool
 * would otherwise leave on screen (what it shows, what stays private), behind an `.icon-btn` with the
 * Info icon named "About <Tool>". A tool passes it to the header's action slot
 * (`PanelHeaderActions`). Anchored on a fine pointer, a bottom sheet with the grabber on phones.
 * Escape closes only the popover and returns focus to its button.
 *
 * Its content is a short sentence-case `children` and an optional `.facts` list. Beside a field's
 * label (Time Zone's About Time Zones, #2971) its button is the small `.icon-btn.sm`.
 */
interface InfoPopoverProps {
  /** The tool's name, Title Case: the button and the popover are "About <tool>". */
  tool: string;
  facts?: readonly { term: string; value: ReactNode }[];
  /** `sm` beside a field's label. */
  size?: "sm";
  /**
   * At a toolbar's trailing end (Usage and Cost's About These Numbers, #3010): a ghost button with
   * the icon and its name on desktop, the icon alone on phones.
   */
  labelled?: boolean;
  children: ReactNode;
}

export function InfoPopover({ labelled = false, ...props }: InfoPopoverProps) {
  // Only a labelled one follows the width; an icon is an icon at every width, so the rest never
  // subscribe to the viewport.
  return labelled ? <LabelledInfoPopover {...props} /> : <InfoPopoverControl {...props} showLabel={false} />;
}

function LabelledInfoPopover(props: Omit<InfoPopoverProps, "labelled">) {
  const phone = useIsMobile();
  return <InfoPopoverControl {...props} showLabel={!phone} />;
}

function InfoPopoverControl({
  tool,
  facts,
  size,
  showLabel,
  children,
}: Omit<InfoPopoverProps, "labelled"> & { showLabel: boolean }) {
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
        className={showLabel ? "btn ghost" : size ? `icon-btn ${size}` : "icon-btn"}
        title={showLabel ? undefined : name}
        aria-label={showLabel ? undefined : name}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popover.panelId : undefined}
        onClick={popover.toggle}
        onKeyDown={popover.onTriggerKeyDown}
      >
        <InfoIcon />
        {showLabel && name}
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
