import React, {
  useId,
  useLayoutEffect,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
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
/** anchoredMenuPlacement's viewport margin. */
const VIEWPORT_MARGIN = 8;
/** Below this, a side is too short to scroll in, and the menu is fitted to the viewport instead. */
const MIN_SIDE_HEIGHT = 160;

type Placement = Pick<CSSProperties, "top" | "bottom" | "left" | "maxHeight" | "maxWidth">;

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
 */
function useMenuPlacement(
  surfaceRef: RefObject<HTMLDivElement | null>,
  anchor: MenuAnchor,
  align: "start" | "end",
  gap: number,
  maxWidth: number,
  sheet: boolean,
  boundary: string | undefined,
): Placement | undefined {
  const [placement, setPlacement] = useState<Placement>();
  const trigger = anchor.trigger ?? null;
  const pointX = anchor.point?.x;
  const pointY = anchor.point?.y;
  useLayoutEffect(() => {
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
      const edges = surface.offsetHeight - surface.clientHeight;
      // Fractional, not offsetWidth: a rounded width let the menu overhang its pane by a pixel.
      const surfaceWidth = surface.getBoundingClientRect().width;
      const next = anchoredMenuPlacement({
        trigger: rect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        desiredWidth: surfaceWidth,
        desiredHeight: surface.scrollHeight + edges,
        align,
        gap,
      });
      const style: Placement = { top: next.top, bottom: next.bottom, left: next.left, maxHeight: next.maxHeight };
      // Taller than the room on either side (the composer's + menu): open on the roomier side and
      // scroll there, rather than fitting the menu to the viewport over the trigger it came from.
      const below = window.innerHeight - VIEWPORT_MARGIN - rect.bottom - gap;
      const above = rect.top - gap - VIEWPORT_MARGIN;
      if (surface.scrollHeight + edges > Math.max(below, above) && Math.max(below, above) >= MIN_SIDE_HEIGHT) {
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
      setPlacement((current) => samePlacement(current, style) ? current : style);
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
  }, [sheet, surfaceRef, trigger, pointX, pointY, align, gap, maxWidth, boundary]);
  return placement;
}

export interface MenuSurfaceProps extends Omit<HTMLAttributes<HTMLDivElement>, "role" | "title"> {
  surfaceRef: RefObject<HTMLDivElement | null>;
  anchor: MenuAnchor;
  /** The accessible name, and the sheet's title row on a phone. */
  label: string;
  /** A visible title row shown at every width, replacing the phone-only one (Model Settings). */
  head?: ReactNode;
  /** `dialog` for a menu-shaped surface that also holds form fields (the composer's + menu). */
  role?: "menu" | "dialog";
  /** A popover shares the menu's container with 16px of padding, for inline detail and forms. */
  kind?: "menu" | "popover";
  align?: "start" | "end";
  /** "trigger" matches the trigger's width (the instance selector). */
  width?: number | "trigger";
  /** A selector for the trigger's ancestor whose width the menu stays inside on desktop. */
  boundary?: string;
  /** A backdrop click. The shell's Escape ladder clicks the same backdrop. */
  onDismiss: () => void;
  children: ReactNode;
}

/**
 * The one menu container (docs/design-system.md §9). Portalled to <body> and fixed from its first
 * commit: an ancestor's `container-type` or transform cannot become its containing block, and
 * focusing its first item can never scroll the page to where an unplaced element would sit. On a
 * phone it is a bottom sheet with the dialog sheet's grabber and a title row (§7.5, §9.2).
 */
export function MenuSurface({
  surfaceRef,
  anchor,
  label,
  head,
  role = "menu",
  kind = "menu",
  align = "start",
  width,
  boundary,
  onDismiss,
  className,
  style,
  children,
  ...rest
}: MenuSurfaceProps) {
  const sheet = useIsMobile();
  const placement = useMenuPlacement(
    surfaceRef,
    anchor,
    align,
    kind === "popover" ? POPOVER_GAP : MENU_GAP,
    kind === "popover" ? POPOVER_MAX_WIDTH : MENU_MAX_WIDTH,
    sheet,
    boundary,
  );
  const fixedWidth = sheet || width === undefined
    ? undefined
    : width === "trigger" ? anchor.trigger?.current?.getBoundingClientRect().width : width;
  return createPortal(
    <>
      <div className="menu-backdrop" aria-hidden="true" onClick={onDismiss} />
      <div
        aria-label={label}
        {...rest}
        ref={surfaceRef}
        role={role}
        className={`${kind === "popover" ? "popover" : "menu"}${className ? ` ${className}` : ""}`}
        style={{ ...(fixedWidth === undefined ? null : { width: fixedWidth }), ...placement, ...style }}
      >
        <div className="sheet-grabber" aria-hidden="true" />
        {head ?? <div className="menu-head" aria-hidden="true">{label}</div>}
        {children}
      </div>
    </>,
    document.body,
  );
}

export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role"> {
  /** `button` for a plain action inside a menu-shaped dialog (the composer's + menu). */
  role?: "menuitem" | "menuitemradio" | "menuitemcheckbox" | "checkbox" | "button";
  /** The leading 16px icon slot. */
  icon?: ReactNode;
  /** A second line: an option's description, or why a disabled item is unavailable (§9.1). */
  description?: ReactNode;
  /** A stable id for the second line, when something else refers to it. */
  descriptionId?: string;
  /** The trailing slot: a keycap or a submenu chevron. A checked item shows its check here. */
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
  const checkable = role !== "menuitem" && role !== "button";
  const describedBy = [button["aria-describedby"], description ? descriptionId : null].filter(Boolean).join(" ");
  const classes = ["menu-item", danger ? "danger" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      {...button}
      role={role === "button" ? undefined : role}
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
        <span className="menu-trail" aria-hidden="true">{checked ? <CheckIcon className="menu-check" /> : trail}</span>
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
