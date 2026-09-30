import React, { createContext, Fragment, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ChevronDownIcon, ChevronLeftIcon, MoreHorizontalIcon, PlusIcon, SearchIcon } from "./Icons.js";
import { useAccessibleMenu } from "./interactions.js";
import { MenuItem, MenuSeparator, MenuSurface } from "./Menu.js";
import { useIsCompact } from "./useIsMobile.js";
import { windowDragRegion } from "../desktop-window.js";

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

/** One item of a menu-button secondary: a label and an optional one-line description (§9.1). */
export interface PageMenuButtonItem extends PageAction {
  description?: string;
}

/**
 * A page-header secondary. `variant: "ghost"` draws it at the ghost weight, for destination-level
 * configuration beside the create and import actions (§3.1). A secondary with `items` is a menu
 * button: its label and a caret open a menu of those items, and when it folds into ⋯ the items
 * appear there individually, in order, instead of as a nested menu.
 */
export type PageSecondaryAction =
  | (PageAction & { variant?: "ghost"; items?: undefined })
  | (Omit<PageAction, "onClick"> & { variant?: "ghost"; items: PageMenuButtonItem[]; onClick?: undefined });

/**
 * On phones the page header and the detail bar are the app bar, and it carries a Search icon that
 * opens the command palette (§15.1, #1978). The shell provides the opener only at 760px and below,
 * where the rail has no Search.
 */
const AppBarSearchContext = createContext<(() => void) | undefined>(undefined);

export function AppBarSearchProvider({ onSearch, children }: { onSearch?: () => void; children: ReactNode }) {
  return <AppBarSearchContext.Provider value={onSearch}>{children}</AppBarSearchContext.Provider>;
}

/** The app bar's Search icon (§15.1). */
function AppBarSearch({ onSearch }: { onSearch: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn"
      title="Search"
      aria-label="Search"
      onClick={(event) => {
        // Safari does not focus a clicked button, and the palette returns focus to whatever held it
        // when it opened.
        event.currentTarget.focus();
        onSearch();
      }}
    >
      <SearchIcon />
    </button>
  );
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
  secondary?: PageSecondaryAction[];
  /** Actions that only ever appear in ⋯. */
  menu?: PageMenuAction[];
  /** Optional underline tabs, drawn as the header's last row. */
  tabs?: ReactNode;
}) {
  const onSearch = useContext(AppBarSearchContext);
  // Slot 1 is the secondary beside the primary. Visibility by slot lives in the stylesheet, where
  // the width tiers and the header's own @container width both apply (§3.3, §15.2).
  const slots = secondary.map((action, index) => ({ action, slot: secondary.length - index }));
  const overflow = secondary.length > PAGE_HEADER_VISIBLE_SECONDARIES || menu.length > 0;
  return (
    <header className="page-header" {...windowDragRegion()}>
      <div className="page-header-row">
        <div className="page-heading">
          <h1 id="page-title" className="page-title" tabIndex={-1}>{title}</h1>
          {description && <p className="page-desc" title={description}>{description}</p>}
        </div>
        {(onSearch || primary || secondary.length > 0 || menu.length > 0) && (
          <div className="page-actions">
            {onSearch && <AppBarSearch onSearch={onSearch} />}
            {slots.filter(({ slot }) => slot <= PAGE_HEADER_VISIBLE_SECONDARIES).map(({ action, slot }) => action.items ? (
              <PageMenuButton key={action.label} action={action} items={action.items} slot={slot} />
            ) : (
              <button
                key={action.label}
                type="button"
                className={`btn${action.variant === "ghost" ? " ghost" : ""} page-action`}
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
                  // A menu button folds into ⋯ as its own items, in order: ⋯ never nests a menu.
                  ...slots.flatMap(({ action, slot }): ActionsMenuItem[] => action.items
                    ? action.items.map((item) => ({ ...item, disabled: action.disabled || item.disabled, slot }))
                    : [{ label: action.label, onClick: action.onClick, disabled: action.disabled, title: action.title, slot }]),
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

export interface DetailBarAction extends PageAction {
  /** Drawn before the label; in the compact tier the button shows only this (§15.2). */
  icon?: ReactNode;
}

/**
 * Below this, a truncated detail-bar title stops being readable, so in the compact tier the status
 * badge gives up its label (to its tooltip) before the title gives up more (§15.2).
 */
export const DETAIL_TITLE_READABLE_PX = 200;

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
  primary?: DetailBarAction;
  secondary?: DetailBarAction;
  /** ⋯ contents. Destructive actions belong only here (§3.3). */
  menu?: PageMenuAction[];
}) {
  const compact = useIsCompact();
  const onSearch = useContext(AppBarSearchContext);
  const headingRef = useRef<HTMLDivElement>(null);
  // Whether the badge is a dot is measured against the full badge, every time, so the answer never
  // depends on the previous one. The attribute is written straight to the DOM inside one layout
  // pass: React does not own it, and nothing paints between taking it off and putting it back.
  useLayoutEffect(() => {
    const heading = headingRef.current;
    const badge = heading?.querySelector<HTMLElement>(".detail-bar-status");
    const titleElement = heading?.querySelector<HTMLElement>(".detail-bar-title");
    if (!heading || !badge || !titleElement) return;
    const measure = () => {
      badge.removeAttribute("data-dot");
      badge.removeAttribute("title");
      if (!compact) return;
      const truncated = titleElement.scrollWidth > titleElement.clientWidth;
      if (!truncated || titleElement.clientWidth >= DETAIL_TITLE_READABLE_PX) return;
      badge.setAttribute("data-dot", "");
      badge.title = badge.textContent ?? "";
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // The heading's width is set by the bar, never by the badge, so a collapse cannot re-trigger it.
    const observer = new ResizeObserver(measure);
    observer.observe(heading);
    return () => observer.disconnect();
  });
  const action = (item: DetailBarAction, kind: "btn" | "btn primary") => {
    const iconOnly = compact && Boolean(item.icon);
    return (
      <button
        type="button"
        className={`${kind} detail-bar-action${iconOnly ? " icon-only" : ""}`}
        disabled={item.disabled}
        // An icon-only button's label is its tooltip; a visible reason still wins (§9.3).
        title={item.title ?? (iconOnly ? item.label : undefined)}
        onClick={item.onClick}
      >
        {item.icon}
        <span className="detail-bar-action-label">{item.label}</span>
      </button>
    );
  };
  return (
    <header className="detail-bar" {...windowDragRegion()}>
      <button type="button" className="icon-btn detail-bar-back" onClick={onBack} title={backLabel} aria-label={backLabel}>
        <ChevronLeftIcon />
      </button>
      <div ref={headingRef} className="detail-bar-heading">
        <h1 id="page-title" className="detail-bar-title" tabIndex={-1} title={title}>{title}</h1>
        {status && <span className="detail-bar-status">{status}</span>}
      </div>
      {(onSearch || primary || secondary || menu.length > 0) && (
        <div className="detail-bar-actions">
          {onSearch && <AppBarSearch onSearch={onSearch} />}
          {secondary && action(secondary, "btn")}
          {menu.length > 0 && <ActionsMenu overflow="always" items={menu} />}
          {primary && action(primary, "btn primary")}
        </div>
      )}
    </header>
  );
}

interface ActionsMenuItem extends PageMenuAction {
  /** A page-header secondary that also has a button; ⋯ lists it only while that button is hidden. */
  slot?: number;
  /** A folded menu button's item keeps its description line. */
  description?: string;
}

/**
 * A menu-button secondary (§3.2, §9.1): its label and a caret open the shared MenuSurface with
 * one item per choice. It is a direct child of `.page-actions`, so the priority+ rules hide it by
 * slot like any other secondary; while hidden, ⋯ lists its items instead.
 */
function PageMenuButton({ action, items, slot }: { action: PageSecondaryAction; items: PageMenuButtonItem[]; slot: number }) {
  const [open, setOpen] = useState(false);
  const menu = useAccessibleMenu(open, setOpen, "page-action-menu");
  const { close, triggerRef } = menu;
  // A width change that hides this button (it folded into ⋯) takes its menu with it. Focus that
  // was in the menu moves to ⋯, which now holds the same items, or else to the page title (§16.1).
  useEffect(() => {
    const trigger = triggerRef.current;
    if (!open || !trigger || typeof ResizeObserver === "undefined") return;
    const row = trigger.closest<HTMLElement>(".page-actions");
    const observer = new ResizeObserver(() => {
      if (trigger.getClientRects().length > 0) return;
      const active = trigger.ownerDocument.activeElement;
      const hadFocus = Boolean(active && menu.menuRef.current?.contains(active));
      close(false);
      if (!hadFocus) return;
      const more = row?.querySelector<HTMLElement>(".page-more > .icon-btn");
      (more && more.getClientRects().length > 0 ? more : trigger.ownerDocument.getElementById("page-title"))?.focus();
    });
    observer.observe(trigger);
    if (row) observer.observe(row);
    return () => observer.disconnect();
  }, [open, close, triggerRef, menu.menuRef]);
  return (
    <>
      <button
        ref={menu.triggerRef}
        type="button"
        className={`btn${action.variant === "ghost" ? " ghost" : ""} page-action`}
        data-slot={slot}
        disabled={action.disabled}
        title={action.title}
        onClick={menu.toggle}
        onKeyDown={menu.onTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu.menuId : undefined}
      >
        {action.label}
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label={action.label}
          align="end"
          onDismiss={() => menu.close(true)}
          onKeyDown={menu.onMenuKeyDown}
        >
          {items.map((item) => (
            <MenuItem
              key={item.label}
              description={item.description}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                menu.close(false);
                menu.triggerRef.current?.focus();
                item.onClick();
              }}
            >
              {item.label}
            </MenuItem>
          ))}
        </MenuSurface>
      )}
    </>
  );
}

/** Whether a header secondary's own button is showing; the stylesheet hides it by width (§3.3). */
function slotButtonShown(trigger: HTMLElement | null, slot: number): boolean {
  const button = trigger?.closest(".page-actions")?.querySelector<HTMLElement>(`.page-action[data-slot="${slot}"]`);
  return Boolean(button && button.ownerDocument.defaultView?.getComputedStyle(button).display !== "none");
}

/**
 * The ⋯ menu shared by the page header and the detail bar. Destructive items sort last.
 *
 * The menu is the shared MenuSurface, portalled: the page header is an inline-size query container,
 * and engines at the build floor that give `container-type` layout containment would make it the
 * containing block of a fixed-position menu and its backdrop.
 */
function ActionsMenu({ className, overflow, items }: { className?: string; overflow: string; items: ActionsMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [, remeasure] = useState(0);
  const menu = useAccessibleMenu(open, setOpen, "page-actions-menu");
  // Read while open, so the list matches the buttons the header is showing right now.
  const shown = open
    ? items.filter((item) => item.slot === undefined || !slotButtonShown(menu.triggerRef.current, item.slot))
    : [];
  const { close, triggerRef, menuRef } = menu;
  // Whether keyboard focus is in the pop. A width change can drop the focused item from a menu
  // that stays open (its button reappeared); focus then stays in the menu, not on <body>. A layout
  // effect, so it runs in the same commit, before the shell's route and layout focus rescue.
  const focusInMenu = useRef(false);
  // The slot of the item focus was last on: a re-render can remove that item before the observer
  // below runs, and it still needs to know which button now stands for it.
  const focusedSlot = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open) {
      focusInMenu.current = false;
      focusedSlot.current = undefined;
      return;
    }
    const pop = menuRef.current;
    if (focusInMenu.current && pop && !pop.contains(pop.ownerDocument.activeElement)) {
      pop.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    }
  });
  // A width change can show the buttons ⋯ was standing in for, or hide ⋯ itself: re-read the list,
  // and close a menu whose trigger is gone or that has nothing left to offer. Observed on the
  // action row and the trigger rather than on `resize`, which can arrive before the width tiers
  // and the header's container queries have been re-applied.
  useEffect(() => {
    const trigger = triggerRef.current;
    const row = trigger?.closest<HTMLElement>(".page-actions, .detail-bar-actions");
    if (!open || !trigger || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const active = trigger.ownerDocument.activeElement as HTMLElement | null;
      const hadFocus = Boolean(active && menuRef.current?.contains(active)) || focusInMenu.current;
      const slot = focusedSlot.current;
      const triggerShown = trigger.getClientRects().length > 0;
      const orphaned = !triggerShown ||
        !items.some((item) => item.slot === undefined || !slotButtonShown(trigger, item.slot));
      if (!orphaned) {
        remeasure((tick) => tick + 1);
        return;
      }
      close(false);
      if (!hadFocus) return;
      // The focused item is going away with its menu: keep keyboard focus in the header, on the
      // button that now stands for the item, else on ⋯, else on the page title (§16.1).
      const button = slot ? row?.querySelector<HTMLElement>(`.page-action[data-slot="${slot}"]`) : null;
      const target = button && button.getClientRects().length > 0 ? button
        : triggerShown ? trigger
        : trigger.ownerDocument.getElementById("page-title");
      target?.focus();
    });
    observer.observe(trigger);
    if (row) observer.observe(row);
    return () => observer.disconnect();
  }, [open, items, close, triggerRef, menuRef]);
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
      {open && (
        <MenuSurface
          surfaceRef={menu.menuRef}
          anchor={{ trigger: menu.triggerRef }}
          id={menu.menuId}
          label="More Actions"
          align="end"
          onDismiss={() => menu.close(true)}
          onFocus={(event) => {
            focusInMenu.current = true;
            focusedSlot.current = (event.target as HTMLElement).dataset.slot;
          }}
          onBlur={(event) => {
            // Only a real move out; a removed item blurs with no related target.
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
              focusInMenu.current = false;
            }
          }}
          // Tab hands focus back to ⋯ first (useAccessibleMenu), so it continues from the header.
          onKeyDown={menu.onMenuKeyDown}
        >
          {ordered.map((item, index) => (
            <Fragment key={item.label}>
              {index === firstDanger && index > 0 && <MenuSeparator />}
              <MenuItem
                danger={item.danger}
                data-slot={item.slot}
                disabled={item.disabled}
                title={item.title}
                description={item.description}
                onClick={() => choose(item.onClick)}
              >
                {item.label}
              </MenuItem>
            </Fragment>
          ))}
        </MenuSurface>
      )}
    </div>
  );
}
