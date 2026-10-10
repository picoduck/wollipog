import React, {
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { fixedContainingBlockOffset, type FixedContainingBlockOffset } from "../fixed-containing-block.js";
import { CheckIcon } from "./Icons.js";
import { anchoredMenuPlacement, pointAnchorRect } from "./interactions.js";
import { useIsMobile } from "./useIsMobile.js";

/** What a menu opens from: its trigger, or the pointer position of a context menu. */
export type MenuAnchor =
  | { trigger: RefObject<HTMLElement | null>; point?: undefined }
  | { point: { x: number; y: number }; trigger?: undefined };

/** Menus sit 4px from their anchor (§2.9); a popover sits 8px away (§9.2). */
const MENU_GAP = 4;
const POPOVER_GAP = 8;
/** The widest a menu or a popover grows (§9.1, §9.2); the stylesheet holds the same caps. */
const MENU_MAX_WIDTH = 320;
const POPOVER_MAX_WIDTH = 360;
/** The tallest a desktop menu grows before it scrolls inside. §9 sets no height; a cap keeps a menu
 * opened from the composer clear of the page and session header above it. The stylesheet holds the
 * same cap for the first frame. */
const MENU_MAX_HEIGHT = 480;
/** anchoredMenuPlacement's viewport margin. */
const VIEWPORT_MARGIN = 8;
/** Below this, a side is too short to scroll in, and the menu is fitted to the viewport instead. */
const MIN_SIDE_HEIGHT = 160;

/**
 * Whether any menu or popover is open, counted by the one container that renders them all. The
 * toast stack reads it to step aside on a phone (§13.1), so it follows the behavior rather than a
 * list of menu class names.
 */
let openMenuCount = 0;
const openMenuListeners = new Set<() => void>();

function setMenuOpen(delta: 1 | -1): void {
  openMenuCount += delta;
  for (const listener of [...openMenuListeners]) listener();
}

function subscribeMenuOpen(listener: () => void): () => void {
  openMenuListeners.add(listener);
  return () => {
    openMenuListeners.delete(listener);
  };
}

/** True while at least one MenuSurface is mounted. */
export function useMenuOpen(): boolean {
  return useSyncExternalStore(subscribeMenuOpen, () => openMenuCount > 0, () => false);
}

type Placement = Pick<CSSProperties, "top" | "bottom" | "left" | "maxHeight" | "maxWidth">;

/** The viewport: a portalled menu's fixed containing block, and an inline one's until measured. */
const VIEWPORT_BOX: FixedContainingBlockOffset = { left: 0, top: 0, bottom: 0 };

function sameBox(a: FixedContainingBlockOffset, b: FixedContainingBlockOffset): boolean {
  return a.left === b.left && a.top === b.top && a.bottom === b.bottom;
}

/** A placement in viewport coordinates, moved into the coordinates of the box it resolves against. */
function withinBox(style: Placement, box: FixedContainingBlockOffset): Placement {
  if (sameBox(box, VIEWPORT_BOX)) return style;
  return {
    ...style,
    top: typeof style.top === "number" ? style.top - box.top : style.top,
    bottom: typeof style.bottom === "number" ? style.bottom - box.bottom : style.bottom,
    left: typeof style.left === "number" ? style.left - box.left : style.left,
  };
}

function samePlacement(a: Placement | undefined, b: Placement): boolean {
  return Boolean(a) && a!.top === b.top && a!.bottom === b.bottom && a!.left === b.left &&
    a!.maxHeight === b.maxHeight && a!.maxWidth === b.maxWidth;
}

/**
 * Where an open menu sits, measured from its own rendered size, so a short menu never reserves the
 * height of a long one when it flips above its trigger. Re-anchors on resize, on any scroll (§9.2)
 * and when its content changes size. A phone sheet has no placement: the stylesheet docks it.
 *
 * `boundary` names an ancestor of the trigger whose width the menu stays inside, for a menu that
 * belongs to a narrow pane (the composer in a side panel) rather than to the whole viewport.
 *
 * A flyout (`beside`) opens to the right of that ancestor instead, top-aligned with the trigger and
 * moved up only as far as the viewport needs: the instance menu beside the rail (#1970).
 *
 * An `inline` menu also returns the box `position: fixed` resolves against, which an ancestor with a
 * transform or layout containment becomes (a dialog's motion, a size container at the build floor,
 * §2.10). It is measured when the menu opens and whenever its trigger or the viewport has moved,
 * never on a scroll or resize that moved nothing, and the placement is moved into its coordinates.
 * A phone sheet has no placement and measures nothing.
 */
function useMenuPlacement(
  surfaceRef: RefObject<HTMLDivElement | null>,
  anchor: MenuAnchor,
  align: "start" | "end",
  gap: number,
  maxWidth: number,
  sheet: boolean,
  boundary: string | undefined,
  beside: string | undefined,
  inline: boolean,
  prefer: "below" | "above" | undefined,
): { placement: Placement | undefined; box: FixedContainingBlockOffset } {
  const [placement, setPlacement] = useState<Placement>();
  const [box, setBox] = useState(VIEWPORT_BOX);
  const trigger = anchor.trigger ?? null;
  const pointX = anchor.point?.x;
  const pointY = anchor.point?.y;
  useLayoutEffect(() => {
    // What the containing block was last measured for, and what it measured.
    let measuredFor = "";
    let measured = VIEWPORT_BOX;
    const containingBlock = (rect: Pick<DOMRect, "left" | "top" | "bottom">): FixedContainingBlockOffset => {
      if (!inline) return VIEWPORT_BOX;
      const key = `${rect.left},${rect.top},${rect.bottom},${window.innerWidth},${window.innerHeight}`;
      if (key === measuredFor) return measured;
      measuredFor = key;
      // The surface's parent shares its ancestors, so it resolves against the same box.
      const next = fixedContainingBlockOffset(surfaceRef.current?.parentElement);
      if (!sameBox(measured, next)) measured = next;
      setBox((current) => sameBox(current, measured) ? current : measured);
      return measured;
    };
    // A sheet keeps docking to the box it resolves against: a scroller around that box clips it, so
    // docked to the viewport's edges instead it could land behind a dialog's footer, out of reach.
    if (!inline || sheet) setBox(VIEWPORT_BOX);
    if (sheet) {
      setPlacement(undefined);
      return;
    }
    const update = () => {
      const surface = surfaceRef.current;
      const rect = trigger
        ? trigger.current?.getBoundingClientRect()
        : pointAnchorRect(pointX ?? 0, pointY ?? 0);
      if (!surface || !rect) return;
      const box = containingBlock(rect);
      const edges = surface.offsetHeight - surface.clientHeight;
      const wantedHeight = Math.min(surface.scrollHeight + edges, MENU_MAX_HEIGHT);
      // Fractional, not offsetWidth: a rounded width let the menu overhang its pane by a pixel.
      const surfaceWidth = surface.getBoundingClientRect().width;
      if (beside) {
        const edge = trigger?.current?.closest(beside)?.getBoundingClientRect().right ?? rect.right;
        const maxHeight = Math.min(wantedHeight, window.innerHeight - VIEWPORT_MARGIN * 2);
        const flyout: Placement = {
          top: Math.max(VIEWPORT_MARGIN, Math.min(rect.top, window.innerHeight - VIEWPORT_MARGIN - maxHeight)),
          bottom: "auto",
          left: Math.max(VIEWPORT_MARGIN, Math.min(edge + gap, window.innerWidth - VIEWPORT_MARGIN - surfaceWidth)),
          maxHeight,
        };
        const placed = withinBox(flyout, box);
        setPlacement((current) => samePlacement(current, placed) ? current : placed);
        return;
      }
      const next = anchoredMenuPlacement({
        trigger: rect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        desiredWidth: surfaceWidth,
        desiredHeight: wantedHeight,
        align,
        gap,
        prefer,
      });
      const style: Placement = { top: next.top, bottom: next.bottom, left: next.left, maxHeight: next.maxHeight };
      // Taller than the room on either side: open on the roomier side and
      // scroll there, rather than fitting the menu to the viewport over the trigger it came from.
      const below = window.innerHeight - VIEWPORT_MARGIN - rect.bottom - gap;
      const above = rect.top - gap - VIEWPORT_MARGIN;
      if (wantedHeight > Math.max(below, above) && Math.max(below, above) >= MIN_SIDE_HEIGHT) {
        style.maxHeight = Math.max(below, above);
        if (above > below) {
          style.top = "auto";
          style.bottom = window.innerHeight - (rect.top - gap);
        } else {
          style.top = rect.bottom + gap;
          style.bottom = "auto";
        }
      }
      const bounds = boundary ? trigger?.current?.closest(boundary)?.getBoundingClientRect() : undefined;
      if (bounds) {
        const width = Math.min(surfaceWidth, bounds.width);
        const wanted = align === "end" ? rect.right - width : rect.left;
        style.left = Math.max(bounds.left, Math.min(wanted, bounds.right - width));
        // An inline cap replaces the stylesheet's, so it keeps the menu's own maximum too.
        style.maxWidth = Math.min(bounds.width, maxWidth);
      }
      const placed = withinBox(style, box);
      setPlacement((current) => samePlacement(current, placed) ? current : placed);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    // A dialog sheet slides in from the bottom (§7.5): a menu opened from inside it is measured
    // against a trigger that is still travelling, so place it again once the motion ends.
    document.addEventListener("animationend", update, true);
    // Content that changes size is placed again on the next frame: re-placing inside the observer
    // callback resizes what it observes and trips the browser's ResizeObserver loop guard.
    let frame = 0;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    });
    if (surfaceRef.current) observer?.observe(surfaceRef.current);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      document.removeEventListener("animationend", update, true);
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [sheet, surfaceRef, trigger, pointX, pointY, align, gap, maxWidth, boundary, beside, inline, prefer]);
  return { placement, box };
}

export interface MenuSurfaceProps extends Omit<HTMLAttributes<HTMLDivElement>, "role" | "title"> {
  surfaceRef: RefObject<HTMLDivElement | null>;
  anchor: MenuAnchor;
  /** The accessible name, and the sheet's title row on a phone. */
  label: string;
  /** The phone sheet's title row, when it should read differently from the accessible name (a
   * session menu is titled with the session's title). */
  sheetTitle?: string;
  /** A visible title row shown at every width, replacing the phone-only one (Model Settings). */
  head?: ReactNode;
  /** `dialog` for a popover of detail or form fields (Session Status); never for a list of actions. */
  role?: "menu" | "dialog";
  /** A popover shares the menu's container with 16px of padding, for inline detail and forms. */
  kind?: "menu" | "popover";
  align?: "start" | "end";
  /** "trigger" matches the trigger's width (the instance selector). */
  width?: number | "trigger";
  /** A cap wider than §9.1's or §9.2's, for a popover laid out in columns (Model Settings). */
  maxWidth?: number;
  /** A selector for the trigger's ancestor whose width the menu stays inside on desktop. */
  boundary?: string;
  /** A selector for the trigger's ancestor the menu opens beside as a flyout on desktop (the rail). */
  beside?: string;
  /** The side tried first on desktop: "above" for a menu from a bottom dock's head (§9.1). */
  prefer?: "below" | "above";
  /** A backdrop click. The shell's Escape ladder clicks the same backdrop. */
  onDismiss: () => void;
  /**
   * Render where the menu is written instead of in <body>: a menu inside a dialog (a dialog
   * header's ⋯ menu). An aria-modal dialog hides everything outside it from assistive technology,
   * and every dialog's backdrop covers the popover layer, so a portalled menu would be both unheard
   * and under the dialog. In place it is fixed like any menu and stacks inside the dialog's layer,
   * as a Select's list does, and like that list it subtracts the offset of any ancestor that becomes
   * its fixed containing block, so it still opens beside its trigger and its backdrop still reaches
   * the viewport's edges. A scroller around that ancestor still clips both.
   */
  inline?: boolean;
  children: ReactNode;
}

/**
 * The one menu container (docs/design-system.md §9). Portalled to <body> and fixed from its first
 * commit: an ancestor's `container-type` or transform cannot become its containing block (an inline
 * menu measures one instead), and focusing its first item can never scroll the page to where an unplaced element would sit. On a
 * phone it is a bottom sheet with the dialog sheet's grabber and a title row (§7.5, §9.2).
 */
export function MenuSurface({
  surfaceRef,
  anchor,
  label,
  sheetTitle,
  head,
  role = "menu",
  kind = "menu",
  align = "start",
  width,
  maxWidth,
  boundary,
  beside,
  prefer,
  onDismiss,
  inline = false,
  className,
  style,
  children,
  ...rest
}: MenuSurfaceProps) {
  const sheet = useIsMobile();
  const { placement, box } = useMenuPlacement(
    surfaceRef,
    anchor,
    align,
    kind === "popover" ? POPOVER_GAP : MENU_GAP,
    maxWidth ?? (kind === "popover" ? POPOVER_MAX_WIDTH : MENU_MAX_WIDTH),
    sheet,
    boundary,
    beside,
    inline,
    prefer,
  );
  const fixedWidth = sheet || width === undefined
    ? undefined
    : width === "trigger" ? anchor.trigger?.current?.getBoundingClientRect().width : width;
  useLayoutEffect(() => {
    setMenuOpen(1);
    return () => setMenuOpen(-1);
  }, []);
  // An inline menu under an ancestor that became its fixed containing block: the backdrop still
  // covers the whole viewport, so a click anywhere outside the menu dismisses it.
  const backdropStyle: CSSProperties | undefined = sameBox(box, VIEWPORT_BOX)
    ? undefined
    : { top: -box.top, right: "auto", bottom: "auto", left: -box.left, width: "100vw", height: "100vh" };
  const surface = (
    <>
      <div className="menu-backdrop" aria-hidden="true" style={backdropStyle} onClick={onDismiss} />
      <div
        aria-label={label}
        {...rest}
        ref={surfaceRef}
        role={role}
        className={`${kind === "popover" ? "popover" : "menu"}${className ? ` ${className}` : ""}`}
        style={{ ...(fixedWidth === undefined ? null : { width: fixedWidth }), ...placement, ...style }}
      >
        <div className="sheet-grabber" aria-hidden="true" />
        {head ?? <div className="menu-head" aria-hidden="true">{sheetTitle ?? label}</div>}
        {children}
      </div>
    </>
  );
  return inline ? surface : createPortal(surface, document.body);
}

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role"> {
  /** `radio` draws the same row inside a popover's radio group, where menu roles do not belong. */
  role?: "menuitem" | "menuitemradio" | "menuitemcheckbox" | "radio";
  /** The leading 16px icon slot. */
  icon?: ReactNode;
  /** A second line: an option's description, or why a disabled item is unavailable (§9.1). */
  description?: ReactNode;
  /** A stable id for the second line, when something else refers to it. */
  descriptionId?: string;
  /** The trailing slot: a keycap, a submenu chevron or a status. A checked item's check follows it. */
  trail?: ReactNode;
  /** A radio-like or checkbox item's state, marked by a trailing check, never by color alone. */
  checked?: boolean;
  danger?: boolean;
}

/**
 * One menu row: a leading icon slot, the label, an optional second line, and a trailing slot. With
 * a second line, the label alone names the item and the line describes it, so the name a screen
 * reader or a test hears does not change when a reason appears.
 */
export function MenuItem({
  role = "menuitem",
  icon,
  description,
  descriptionId: givenDescriptionId,
  trail,
  checked,
  danger = false,
  className,
  children,
  ...button
}: MenuItemProps) {
  const id = useId().replace(/:/g, "");
  const labelId = `${id}-label`;
  const descriptionId = givenDescriptionId ?? `${id}-description`;
  const checkable = role !== "menuitem";
  const describedBy = [button["aria-describedby"], description ? descriptionId : null].filter(Boolean).join(" ");
  const classes = ["menu-item", danger ? "danger" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      {...button}
      role={role}
      aria-checked={checkable ? Boolean(checked) : undefined}
      aria-labelledby={button["aria-labelledby"] ?? (description && !button["aria-label"] ? labelId : undefined)}
      aria-describedby={describedBy || undefined}
      className={classes}
    >
      {icon !== undefined && <span className="menu-icon" aria-hidden="true">{icon}</span>}
      <span className="menu-body">
        <span className="menu-text" id={labelId}>{children}</span>
        {description && <span className="menu-desc" id={descriptionId}>{description}</span>}
      </span>
      {(checked || trail) && (
        <span className="menu-trail" aria-hidden="true">{trail}{checked && <CheckIcon className="menu-check" />}</span>
      )}
    </button>
  );
}

/** A section label: Title Case as written, never uppercased (§9.1). */
export function MenuLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `menu-label ${className}` : "menu-label"} role="presentation">{children}</div>;
}

/** The full-width hairline before destructive items or between groups. */
export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}

/** Supporting text inside a menu, such as a warning that several items share. */
export function MenuNote({ id, children }: { id?: string; children: ReactNode }) {
  return <div className="menu-note" id={id} role="presentation">{children}</div>;
}
