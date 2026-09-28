import React, { createContext, useContext, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon, MoreHorizontalIcon, PlusIcon } from "./Icons.js";
import { useAccessibleMenu, useAnchoredMenuStyle } from "./interactions.js";

/**
 * Page anatomy (docs/design-system.md §4.2, §4.3, §4.5).
 *
 * Every destination renders one `PageHeader` inside its own page container, and every entity page
 * renders one `DetailBar`. Either one owns the page's only `h1`, `#page-title`, which stays
 * focusable only programmatically: the shell's route-change and layout-crossing rescue moves focus
 * there, and §16.1 suppresses the ring on `[tabindex="-1"]`.
 */

export interface PageAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Visible reason or hint; the label stays the accessible name. */
  title?: string;
}

export interface PagePrimaryAction extends PageAction {
  buttonRef?: Ref<HTMLButtonElement>;
}

export interface PageMenuAction extends PageAction {
  /** Destructive: drawn last, after a separator, in the danger text colour (§3.3). */
  danger?: boolean;
}

/**
 * What the shell lends a page header. On phones the page header is the app bar, and the Tauri
 * instance switcher that used to sit in the phone top bar stays in it (§15.1).
 */
interface PageChrome {
  appBarControl?: ReactNode;
}

const PageChromeContext = createContext<PageChrome>({});

export function PageChromeProvider({ appBarControl, children }: { appBarControl?: ReactNode; children: ReactNode }) {
  return <PageChromeContext.Provider value={{ appBarControl }}>{children}</PageChromeContext.Provider>;
}

/** The number of secondaries the widest header shows beside its primary (§3.3). */
export const PAGE_HEADER_VISIBLE_SECONDARIES = 2;

export function PageHeader({
  title,
  description,
  primary,
  secondary = [],
  menu = [],
  tabs,
}: {
  title: string;
  /** One line, at most 80 characters, in user terms (§4.2, §17.2). Hidden on phones. */
  description?: string;
  /** The one create or import action the destination exists for. A 44px `+` icon on phones. */
  primary?: PagePrimaryAction;
  /**
   * Secondaries in display order. The two nearest the primary are buttons on the widest header;
   * as the header narrows they move into ⋯ from the left, and on phones all of them are there.
   */
  secondary?: PageAction[];
  /** Actions that only ever appear in ⋯. */
  menu?: PageMenuAction[];
  /** Optional underline tabs, drawn as the header's last row. */
  tabs?: ReactNode;
}) {
  const { appBarControl } = useContext(PageChromeContext);
  // Slot 1 is the secondary beside the primary. Visibility by slot lives in the stylesheet, where
  // the width tiers and the header's own @container width both apply (§3.3, §15.2).
  const slots = secondary.map((action, index) => ({ action, slot: secondary.length - index }));
  const overflow = secondary.length > PAGE_HEADER_VISIBLE_SECONDARIES || menu.length > 0;
  return (
    <header className="page-header">
      <div className="page-header-row">
        <div className="page-heading">
          <h1 id="page-title" className="page-title" tabIndex={-1}>{title}</h1>
          {description && <p className="page-desc" title={description}>{description}</p>}
        </div>
        {(appBarControl || primary || secondary.length > 0 || menu.length > 0) && (
          <div className="page-actions">
            {appBarControl}
            {slots.filter(({ slot }) => slot <= PAGE_HEADER_VISIBLE_SECONDARIES).map(({ action, slot }) => (
              <button
                key={action.label}
                type="button"
                className="btn page-action"
                data-slot={slot}
                disabled={action.disabled}
                title={action.title}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            ))}
            {(slots.length > 0 || menu.length > 0) && (
              <ActionsMenu
                className="page-more"
                overflow={overflow ? "always" : String(secondary.length)}
                items={[
                  ...slots.map(({ action, slot }) => ({ ...action, slot })),
                  ...menu,
                ]}
              />
            )}
            {primary && (
              <button
                ref={primary.buttonRef}
                type="button"
                className="btn primary page-primary"
                disabled={primary.disabled}
                title={primary.title}
                onClick={primary.onClick}
              >
                <PlusIcon />
                <span className="page-primary-label">{primary.label}</span>
              </button>
            )}
          </div>
        )}
      </div>
      {tabs && <div className="page-tabs">{tabs}</div>}
    </header>
  );
}

export function DetailBar({
  title,
  backLabel,
  onBack,
  status,
  primary,
  secondary,
  menu = [],
}: {
  title: string;
  /** "Back to <Destination>" — the button's accessible name and tooltip. */
  backLabel: string;
  onBack: () => void;
  /** The one status badge, placed right after the title. */
  status?: ReactNode;
  primary?: PageAction;
  secondary?: PageAction;
  /** ⋯ contents. Destructive actions belong only here (§3.3). */
  menu?: PageMenuAction[];
}) {
  return (
    <header className="detail-bar">
      <button type="button" className="icon-btn detail-bar-back" onClick={onBack} title={backLabel} aria-label={backLabel}>
        <ChevronLeftIcon />
      </button>
      <div className="detail-bar-heading">
        <h1 id="page-title" className="detail-bar-title" tabIndex={-1} title={title}>{title}</h1>
        {status}
      </div>
      {(primary || secondary || menu.length > 0) && (
        <div className="detail-bar-actions">
          {secondary && (
            <button type="button" className="btn" disabled={secondary.disabled} title={secondary.title} onClick={secondary.onClick}>
              {secondary.label}
            </button>
          )}
          {menu.length > 0 && <ActionsMenu overflow="always" items={menu} />}
          {primary && (
            <button type="button" className="btn primary" disabled={primary.disabled} title={primary.title} onClick={primary.onClick}>
              {primary.label}
            </button>
          )}
        </div>
      )}
    </header>
  );
}

interface ActionsMenuItem extends PageMenuAction {
  /** A page-header secondary that also has a button; ⋯ lists it only while that button is hidden. */
  slot?: number;
}

const UNANCHORED_POP: React.CSSProperties = { position: "fixed", top: 0, right: 0 };

/** Whether a header secondary's own button is showing; the stylesheet hides it by width (§3.3). */
function slotButtonShown(trigger: HTMLElement | null, slot: number): boolean {
  const button = trigger?.closest(".page-actions")?.querySelector<HTMLElement>(`.page-action[data-slot="${slot}"]`);
  return Boolean(button && button.ownerDocument.defaultView?.getComputedStyle(button).display !== "none");
}

/**
 * The ⋯ menu shared by the page header and the detail bar. Destructive items sort last.
 *
 * The pop is portalled: the page header is an inline-size query container, and engines at the
 * build floor that give `container-type` layout containment would make it the containing block of
 * a fixed-position pop and its backdrop.
 */
function ActionsMenu({ className, overflow, items }: { className?: string; overflow: string; items: ActionsMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "page-actions-menu");
  // Read while open, so the list matches the buttons the header is showing right now.
  const shown = open
    ? items.filter((item) => item.slot === undefined || !slotButtonShown(menu.triggerRef.current, item.slot))
    : [];
  const menuStyle = useAnchoredMenuStyle(open, menu.triggerRef, {
    desiredWidth: 220,
    // A touch row is 44px plus the 2px gap; the pop adds its padding and a separator.
    desiredHeight: 48 * Math.max(shown.length, 1) + 16,
    align: "end",
  });
  const ordered = [...shown.filter((item) => !item.danger), ...shown.filter((item) => item.danger)];
  const firstDanger = ordered.findIndex((item) => item.danger);
  const choose = (action: () => void) => {
    menu.close(false);
    menu.triggerRef.current?.focus();
    action();
  };
  return (
    <div className={`overflow-menu${className ? ` ${className}` : ""}`} data-overflow={overflow}>
      <button
        ref={menu.triggerRef}
        type="button"
        className="icon-btn"
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        title="More Actions"
        aria-label="More Actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menu.menuId}
      >
        <MoreHorizontalIcon />
      </button>
      {open && createPortal((
        <>
          <div className="menu-backdrop" onClick={() => menu.close(true)} aria-hidden="true" />
          <div
            className="menu-pop"
            id={menu.menuId}
            ref={menu.menuRef}
            role="menu"
            aria-label="More Actions"
            // Fixed from the first commit: before the anchor is measured, `.menu-pop`'s own absolute
            // position would put it at the end of <body>, and focusing its first item scrolls there.
            style={menuStyle ?? UNANCHORED_POP}
            onKeyDown={menu.onMenuKeyDown}
          >
            {ordered.map((item, index) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={`menu-item${item.danger ? " menu-danger" : ""}${index === firstDanger && index > 0 ? " menu-separated" : ""}`}
                disabled={item.disabled}
                title={item.title}
                onClick={() => choose(item.onClick)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      ), document.body)}
    </div>
  );
}
