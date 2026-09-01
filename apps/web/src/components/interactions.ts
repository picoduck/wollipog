import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from "react";

export type RovingKey = "ArrowDown" | "ArrowRight" | "ArrowUp" | "ArrowLeft" | "Home" | "End";

export interface AnchoredMenuPlacement {
  top: number | "auto";
  bottom: number | "auto";
  left: number;
  width: number;
  maxHeight: number;
}

export function anchoredMenuPlacement(input: {
  trigger: Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width">;
  viewportWidth: number;
  viewportHeight: number;
  desiredWidth: number;
  desiredHeight: number;
  align?: "start" | "end";
  gap?: number;
  margin?: number;
}): AnchoredMenuPlacement {
  const gap = input.gap ?? 6;
  const margin = input.margin ?? 8;
  const viewportWidth = Math.max(1, input.viewportWidth);
  const viewportHeight = Math.max(1, input.viewportHeight);
  const width = Math.max(1, Math.min(input.desiredWidth, viewportWidth - margin * 2));
  const maxHeight = Math.max(1, Math.min(input.desiredHeight, viewportHeight - margin * 2));
  const unclampedLeft = input.align === "end" ? input.trigger.right - width : input.trigger.left;
  const left = Math.max(margin, Math.min(unclampedLeft, viewportWidth - width - margin));
  const below = viewportHeight - margin - input.trigger.bottom - gap;
  const above = input.trigger.top - gap - margin;
  let top: number | "auto";
  let bottom: number | "auto" = "auto";
  if (below >= maxHeight) {
    top = input.trigger.bottom + gap;
  } else if (above >= maxHeight) {
    // The menu may render shorter than its requested maximum. Anchor its bottom edge so its real
    // box stays next to the trigger instead of leaving desiredHeight worth of dead space below it.
    top = "auto";
    bottom = viewportHeight - (input.trigger.top - gap);
  } else {
    // Very short panes (especially under Windows display scaling) may have neither side large
    // enough. Fit the menu to the viewport instead of collapsing it to the remaining sliver.
    top = Math.max(margin, Math.min(input.trigger.bottom + gap, viewportHeight - maxHeight - margin));
  }
  return { top, bottom, left, width, maxHeight };
}

export function useAnchoredMenuStyle(
  open: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
  options: {
    desiredWidth?: number;
    desiredHeight: number;
    align?: "start" | "end";
    matchTriggerWidth?: boolean;
    minTriggerWidth?: boolean;
  },
): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open) {
      setStyle(undefined);
      return;
    }
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const placement = anchoredMenuPlacement({
        trigger: rect,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        desiredWidth: options.matchTriggerWidth
          ? rect.width
          : Math.max(options.minTriggerWidth ? rect.width : 0, options.desiredWidth ?? rect.width),
        desiredHeight: options.desiredHeight,
        align: options.align,
      });
      setStyle({
        position: "fixed",
        top: placement.top,
        left: placement.left,
        right: "auto",
        bottom: placement.bottom,
        width: placement.width,
        maxHeight: placement.maxHeight,
      });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [
    open,
    options.align,
    options.desiredHeight,
    options.desiredWidth,
    options.matchTriggerWidth,
    options.minTriggerWidth,
    triggerRef,
  ]);
  return style;
}

export function isRovingChoiceTarget(targetRole: string | null, groupRole: "radio" | "tab"): boolean {
  return targetRole === groupRole;
}

export function rovingChoiceTabIndex(selected: boolean, groupHasSelection: boolean, index: number): 0 | -1 {
  return selected || (!groupHasSelection && index === 0) ? 0 : -1;
}

/**
 * The ONE index that carries `tabIndex={0}` in a roving choice group.
 *
 * Every other option is -1; arrow keys move the stop. Written as a function because the rule has
 * four cases and each of the first three was shipped without the next: the selected option, unless
 * it is disabled; else the first enabled option; else — and this is the case that kept being
 * missed — index 0 anyway, so a group whose options are ALL unavailable is still reachable and can
 * explain itself. A group with no tab stop is invisible to a keyboard user and raises no error.
 */
export function rovingChoiceStop(
  options: readonly { selected: boolean; disabled?: boolean }[],
): number {
  if (options.length === 0) return -1;
  const selected = options.findIndex((option) => option.selected && !option.disabled);
  if (selected >= 0) return selected;
  const enabled = options.findIndex((option) => !option.disabled);
  return enabled >= 0 ? enabled : 0;
}

export function shouldHandleGlobalEscape(key: string, defaultPrevented: boolean): boolean {
  return key === "Escape" && !defaultPrevented;
}

/** Resolve a wrapped roving-focus move while skipping unavailable choices. */
export function rovingChoiceIndex(
  current: number,
  enabled: readonly boolean[],
  key: RovingKey,
): number {
  if (!enabled.some(Boolean)) return -1;
  if (key === "Home") return enabled.findIndex(Boolean);
  if (key === "End") {
    for (let index = enabled.length - 1; index >= 0; index -= 1) {
      if (enabled[index]) return index;
    }
  }
  const delta = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
  let index = current >= 0 ? current : delta > 0 ? -1 : 0;
  for (let count = 0; count < enabled.length; count += 1) {
    index = (index + delta + enabled.length) % enabled.length;
    if (enabled[index]) return index;
  }
  return current;
}

function enabledChoices(
  container: HTMLElement,
  role: "radio" | "tab",
  includeAriaDisabled = false,
): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[role="${role}"]`)).filter(
    (item) => (includeAriaDisabled || item.getAttribute("aria-disabled") !== "true") &&
      !(item instanceof HTMLButtonElement && item.disabled),
  );
}

/** Shared Arrow/Home/End behavior for button radios, segmented controls, and true tabs. */
export function handleRovingChoiceKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  role: "radio" | "tab",
  options: { includeAriaDisabled?: boolean; activate?: boolean } = {},
): void {
  if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
  if (!(event.target instanceof HTMLElement) || !isRovingChoiceTarget(event.target.getAttribute("role"), role)) return;
  const choices = enabledChoices(event.currentTarget, role, options.includeAriaDisabled);
  const current = choices.indexOf(document.activeElement as HTMLElement);
  const next = rovingChoiceIndex(current, choices.map(() => true), event.key as RovingKey);
  const target = choices[next];
  if (!target) return;
  event.preventDefault();
  target.focus();
  // Only ACTIVATE what is not already active. Home and End can resolve to the option that is
  // already selected and focused, and clicking it again is a real event to its owner: Usage treats
  // re-selecting the current range as a refresh, so holding Home fired a request per keydown. The
  // button row this replaced ignored these keys entirely, so the amplification is new.
  const selected = role === "radio" ? target.getAttribute("aria-checked") : target.getAttribute("aria-selected");
  if (options.activate !== false && selected !== "true") target.click();
}

const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]';

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (item) => item.getAttribute("aria-disabled") !== "true" && !(item instanceof HTMLButtonElement && item.disabled),
  );
}

/** Keyboard navigation for collection-owned menus that cannot use one hook instance per row. */
export function handleMenuKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  onClose: (restoreFocus: boolean) => void,
): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    onClose(true);
    return;
  }
  if (event.key === "Tab") {
    onClose(false);
    return;
  }
  const items = menuItems(event.currentTarget);
  const current = items.indexOf(document.activeElement as HTMLElement);
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    const next = rovingChoiceIndex(current, items.map(() => true), event.key as RovingKey);
    if (items[next]) {
      event.preventDefault();
      items[next]!.focus();
    }
    return;
  }
  if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
  const needle = event.key.toLocaleLowerCase();
  for (let offset = 1; offset <= items.length; offset += 1) {
    const item = items[(Math.max(current, -1) + offset) % items.length];
    if (item?.textContent?.trim().toLocaleLowerCase().startsWith(needle)) {
      event.preventDefault();
      item.focus();
      break;
    }
  }
}

export interface AccessibleMenuController {
  menuId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  toggle: () => void;
  close: (restoreFocus?: boolean) => void;
  onTriggerKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onMenuKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export interface DismissiblePopoverController {
  panelId: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  toggle: () => void;
  close: (restoreFocus?: boolean) => void;
  onTriggerKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onPanelKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/** Focus-managed non-modal popover for mixed content and forms (never label these as menus). */
export function useDismissiblePopover(
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
  idPrefix = "popover",
): DismissiblePopoverController {
  const reactId = useId().replace(/:/g, "");
  const panelId = `${idPrefix}-${reactId}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, [setOpen]);
  const toggle = useCallback(() => setOpen((value) => !value), [setOpen]);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    )?.focus();
  }, [open]);
  const onTriggerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    setOpen(true);
  }, [setOpen]);
  const onPanelKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  }, [close]);
  return { panelId, triggerRef, panelRef, toggle, close, onTriggerKeyDown, onPanelKeyDown };
}

/** Menu-button behavior shared by command/choice popovers. Form popovers should not use role=menu. */
export function useAccessibleMenu(
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
  idPrefix = "menu",
): AccessibleMenuController {
  const reactId = useId().replace(/:/g, "");
  const menuId = `${idPrefix}-${reactId}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"first" | "last">("first");
  const typeahead = useRef("");
  const typeaheadTimer = useRef<number | null>(null);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    typeahead.current = "";
    if (typeaheadTimer.current != null) window.clearTimeout(typeaheadTimer.current);
    typeaheadTimer.current = null;
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, [setOpen]);

  useEffect(() => {
    if (!open) return;
    const items = menuItems(menuRef.current);
    const selected = items.find(
      (item) => item.getAttribute("aria-checked") === "true" || item.getAttribute("aria-current") === "page",
    );
    const target = selected ?? (initialFocus.current === "last" ? items.at(-1) : items[0]);
    target?.focus();
  }, [open]);

  useEffect(() => () => {
    if (typeaheadTimer.current != null) window.clearTimeout(typeaheadTimer.current);
  }, []);

  const toggle = useCallback(() => {
    initialFocus.current = "first";
    setOpen((value) => !value);
  }, [setOpen]);

  const onTriggerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    initialFocus.current = event.key === "ArrowUp" ? "last" : "first";
    setOpen(true);
  }, [setOpen]);

  const onMenuKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    const items = menuItems(event.currentTarget);
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const next = rovingChoiceIndex(current, items.map(() => true), event.key as RovingKey);
      if (items[next]) {
        event.preventDefault();
        items[next]!.focus();
      }
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    typeahead.current += event.key.toLocaleLowerCase();
    if (typeaheadTimer.current != null) window.clearTimeout(typeaheadTimer.current);
    typeaheadTimer.current = window.setTimeout(() => {
      typeahead.current = "";
      typeaheadTimer.current = null;
    }, 500);
    for (let offset = 1; offset <= items.length; offset += 1) {
      const item = items[(Math.max(current, -1) + offset) % items.length];
      const label = item?.dataset.menuLabel ?? item?.getAttribute("aria-label") ?? item?.textContent?.trim();
      if (item && label?.toLocaleLowerCase().startsWith(typeahead.current)) {
        event.preventDefault();
        item.focus();
        break;
      }
    }
  }, [close]);

  return { menuId, triggerRef, menuRef, toggle, close, onTriggerKeyDown, onMenuKeyDown };
}

/** Where a context menu anchors: a pointer position, widened to the rect the placer expects. */
export function pointAnchorRect(x: number, y: number): Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width"> {
  return { top: y, bottom: y, left: x, right: x, width: 0 };
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;
/** Grace after RELEASE for the click the press synthesizes; the hold itself can last any time. */
const LONG_PRESS_CLICK_SUPPRESS_MS = 700;

export interface LongPress {
  /** Spread onto the pressed element; `handlers.onDragStart` also belongs on draggable targets.
   * `onClickCapture` runs at capture so a click landing on a NESTED control (a card's approval
   * button) is stopped before that control's own handler — the press asked for a menu, and the
   * nested action must not also run. */
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    onDragStart: () => void;
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  };
  /** Belt to the capture guard's braces, for the caller's own onClick/onDoubleClick. */
  consumeSuppressedClick: () => boolean;
}

/**
 * A touch/pen long-press that opens a context menu without also acting as a tap (#154).
 *
 * Mouse presses are deliberately excluded — desktop already has a real `contextmenu` event, and
 * a mouse resting on a row for half a second is reading, not requesting a menu. Movement past a
 * small slop cancels the press so ordinary touch scrolling never triggers it, and a completed
 * press suppresses the click the same gesture synthesizes on release.
 *
 * Returns stable handler identities: rows are memoized on their props, so a fresh object per
 * render would defeat every row memo at once.
 */
export function useLongPress(onLongPress: (point: { x: number; y: number }) => void): LongPress {
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;
  const stateRef = useRef<{ timer: number; pointerId: number; x: number; y: number } | null>(null);
  /** True from the moment the press fires until its release-click grace expires. The hold can
   * last any time — suppression pivots on RELEASE, not on when the timer fired, or a slow
   * two-second hold would leak its click straight through a 700ms fire-anchored window. */
  const firedHeldRef = useRef(false);
  const releasedAtRef = useRef(0);

  return useMemo<LongPress>(() => {
    const cancel = () => {
      if (stateRef.current === null) return;
      window.clearTimeout(stateRef.current.timer);
      stateRef.current = null;
    };
    const suppressed = () =>
      firedHeldRef.current || Date.now() - releasedAtRef.current <= LONG_PRESS_CLICK_SUPPRESS_MS;
    const release = () => {
      cancel();
      if (!firedHeldRef.current) return;
      firedHeldRef.current = false;
      releasedAtRef.current = Date.now();
    };
    return {
      consumeSuppressedClick: suppressed,
      handlers: {
      onPointerDown: (event) => {
        if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
        cancel();
        firedHeldRef.current = false;
        const { pointerId, clientX, clientY } = event;
        stateRef.current = {
          pointerId,
          x: clientX,
          y: clientY,
          timer: window.setTimeout(() => {
            stateRef.current = null;
            firedHeldRef.current = true;
            callbackRef.current({ x: clientX, y: clientY });
          }, LONG_PRESS_MS),
        };
      },
      onPointerMove: (event) => {
        const pressed = stateRef.current;
        if (pressed === null || event.pointerId !== pressed.pointerId) return;
        if (Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > LONG_PRESS_SLOP_PX) cancel();
      },
      onPointerUp: release,
      onPointerCancel: release,
      onDragStart: cancel,
      onClickCapture: (event) => {
        if (!suppressed()) return;
        event.preventDefault();
        event.stopPropagation();
      },
      },
    };
  }, []);
}
