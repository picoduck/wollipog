import { fixedContainingBlockOffset } from "./fixed-containing-block.js";
import { inTypingContext, shortcutLayerActive, type ShortcutScope } from "./shortcuts.js";

/**
 * F6 zones (docs/design-system.md §16.1). The shell marks every route's page root `main`;
 * master-detail pages mark their list pane `list` and their detail pane `main`. The innermost
 * mounted root wins, so the shell's `main` is the fallback for a page without a detail pane.
 */
export type FocusZone = "rail" | "list" | "main";

export const FOCUS_ZONE_ORDER: readonly FocusZone[] = ["rail", "list", "main"];

/** How long the F6 zone indicator stays on the entered zone's top edge. */
export const ZONE_INDICATOR_MS = 1500;

export type ShortcutViewName = "inbox" | "session" | string;

export function focusZoneForElement(element: Element | null): FocusZone | null {
  const zone = element?.closest<HTMLElement>("[data-focus-zone]")?.dataset.focusZone;
  return zone === "rail" || zone === "list" || zone === "main" ? zone : null;
}

/**
 * Landing targets, tried one selector at a time and never joined into a comma list:
 * querySelector returns the first match in DOCUMENT order, not the first selector that matches,
 * so a list resolved to the brand link above the rail's current destination.
 */
export const ZONE_TARGETS: Readonly<Record<FocusZone, readonly string[]>> = {
  // The current destination (the Settings control while in Settings), then the first destination.
  rail: ['[aria-current="page"]', ".rail-item"],
  // Board mode replaces the Sessions list with the kanban canvas, a state replaces both panes
  // (No Matches #2200, an empty group #2220), and skeleton rows stand in while sessions arrive; F6
  // still needs a landing spot in each.
  list: [".inbox-list", ".inbox-state", ".inbox-skeleton", ".board-wrap"],
  // The Sessions reading pane lands on its transcript scroller, as opening a session does, or on its
  // placeholder while the list loads. An expanded side panel hides the transcript (#2845), so the
  // session lands on the panel's tool switcher instead.
  main: ['#right-panel[data-presentation="expanded"] .rpanel-switcher', ".detail-scroll", ".inbox-preview-skeleton"],
};

function zoneRoot(targetDocument: Document, zone: FocusZone): HTMLElement | null {
  const roots = [...targetDocument.querySelectorAll<HTMLElement>(`[data-focus-zone="${zone}"]`)]
    .filter((candidate) => !candidate.closest('[inert], [hidden], [aria-hidden="true"]'));
  // A page's own zone sits inside the shell's page root, and the page's is the one it means.
  return roots.find((root) => !roots.some((other) => other !== root && root.contains(other))) ?? null;
}

function focusTargetForZone(targetDocument: Document, zone: FocusZone): HTMLElement | null {
  const root = zoneRoot(targetDocument, zone);
  if (!root) return null;
  for (const selector of ZONE_TARGETS[zone]) {
    const target = root.querySelector<HTMLElement>(selector);
    if (target) return target;
  }
  // Otherwise the zone lands on its root (tabIndex -1, no ring), so the next Tab continues inside it.
  return root;
}

/** Focus one mounted zone using the same durable target chain as F6 navigation. */
export function focusZone(targetDocument: Document, zone: FocusZone): FocusZone | null {
  const target = focusTargetForZone(targetDocument, zone);
  if (!target) return null;
  target.focus();
  return zone;
}

/** Cycle only through zones mounted on the current surface, with deterministic wraparound. */
export function cycleFocusZone(
  targetDocument: Document,
  direction: "next" | "previous" = "next",
): FocusZone | null {
  const available = FOCUS_ZONE_ORDER.filter((zone) => focusTargetForZone(targetDocument, zone) !== null);
  if (available.length === 0) return null;
  const current = focusZoneForElement(targetDocument.activeElement);
  const currentIndex = current === null ? -1 : available.indexOf(current);
  const delta = direction === "next" ? 1 : -1;
  const nextIndex = currentIndex < 0
    ? (direction === "next" ? 0 : available.length - 1)
    : (currentIndex + delta + available.length) % available.length;
  const next = available[nextIndex]!;
  return focusZone(targetDocument, next);
}

const ZONE_LINE_PROPERTIES = ["--zone-line-top", "--zone-line-left", "--zone-line-width"] as const;
let clearLitZone: (() => void) | null = null;

/**
 * Mark the zone F6 just entered with `.zone-lit` for ZONE_INDICATOR_MS, which draws a line on its
 * top edge (§16.1). Only the F6 handler calls this, so a click, a digit, a route change or
 * programmatic focus never lights a zone. The line is `position: fixed` at the root's top edge
 * because most roots scroll, and an absolute line would scroll away with their content. The edge
 * is re-measured every frame while lit, so it follows the root when landing focus scrolls an
 * ancestor, the window resizes or content above it loads.
 * It goes out early on a pointer press, on focus leaving the zone, on any other key and on history
 * navigation: a digit or Back changes the route while the shell's page root keeps focus, so focus
 * alone would not notice.
 */
export function indicateFocusZone(targetDocument: Document, zone: FocusZone): HTMLElement | null {
  clearLitZone?.();
  const root = zoneRoot(targetDocument, zone);
  const view = targetDocument.defaultView;
  if (!root || !view) return null;
  let frame = 0;
  let placedFor = "";
  const place = () => {
    if (!root.isConnected) return clear();
    const edge = root.getBoundingClientRect();
    const key = `${edge.left},${edge.top},${edge.width}`;
    if (key !== placedFor) {
      placedFor = key;
      // The line is the root's own pseudo-element, so it cannot be portalled out of the main
      // column. Its offsets count from the box `position: fixed` actually resolves against, which
      // the `app` container becomes at the build floor (§2.10). Measured only when the edge moved.
      const box = fixedContainingBlockOffset(root);
      root.style.setProperty("--zone-line-top", `${edge.top - box.top}px`);
      root.style.setProperty("--zone-line-left", `${edge.left - box.left}px`);
      root.style.setProperty("--zone-line-width", `${edge.width}px`);
    }
    frame = view.requestAnimationFrame(place);
  };
  const clear = () => {
    view.clearTimeout(timer);
    view.cancelAnimationFrame(frame);
    targetDocument.removeEventListener("pointerdown", clear, true);
    targetDocument.removeEventListener("focusin", onFocusIn, true);
    targetDocument.removeEventListener("keydown", onKeyDown, true);
    view.removeEventListener("popstate", clear);
    root.classList.remove("zone-lit");
    for (const property of ZONE_LINE_PROPERTIES) root.style.removeProperty(property);
    if (clearLitZone === clear) clearLitZone = null;
  };
  const onFocusIn = (event: Event) => {
    if (!(event.target instanceof view.Node) || !root.contains(event.target)) clear();
  };
  // F6 relights through the shortcut handler, which clears the previous zone itself.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "F6" && event.key !== "Shift") clear();
  };
  const timer = view.setTimeout(clear, ZONE_INDICATOR_MS);
  place();
  root.classList.add("zone-lit");
  targetDocument.addEventListener("pointerdown", clear, true);
  targetDocument.addEventListener("focusin", onFocusIn, true);
  targetDocument.addEventListener("keydown", onKeyDown, true);
  // Back and Forward change the route under the same page root, with no key or focus change.
  view.addEventListener("popstate", clear);
  clearLitZone = clear;
  return root;
}

/** Resolve contextual precedence once; component handlers should not invent their own scopes. */
export function shortcutScopeForFocus({
  viewName,
  activeElement,
  sessionReading = false,
}: {
  viewName: ShortcutViewName;
  activeElement: Element | null;
  sessionReading?: boolean;
}): ShortcutScope {
  const zone = focusZoneForElement(activeElement);
  if (viewName === "inbox" && (zone === null || zone === "list" || zone === "main")) return "Sessions List";
  if (viewName === "session" && sessionReading && (zone === null || zone === "main")) return "Session Reading";
  return viewName === "session" ? "Session" : "Global";
}

export type EscapeOwner =
  | "layer"
  | "terminal"
  | "terminal-exit"
  | "composer"
  | "session-reading"
  | "inbox-preview"
  | "inbox-filter"
  | "settings-input"
  | "settings"
  | null;

type EscapeKeyboardLike = Pick<
  KeyboardEvent,
  "key" | "defaultPrevented" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
>;

/**
 * Return the one owner for an Escape press. `terminal` means the app must leave plain Escape
 * untouched for xterm; `terminal-exit` is the sole Ctrl+Escape exception.
 */
export function escapeOwner(
  event: EscapeKeyboardLike,
  {
    document: targetDocument,
    viewName,
    inboxFilterActive = false,
  }: {
    document: Document;
    viewName: ShortcutViewName;
    inboxFilterActive?: boolean;
  },
): EscapeOwner {
  if (event.key !== "Escape" || event.defaultPrevented) return null;
  if (shortcutLayerActive(targetDocument, false, event instanceof Event ? event : undefined)) return "layer";

  const active = targetDocument.activeElement;
  if (active instanceof Element && active.closest(".xterm")) {
    return event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey ? "terminal-exit" : "terminal";
  }
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;
  if (active instanceof Element && active.closest(".composer")) return "composer";
  if (viewName === "settings" && inTypingContext(targetDocument)) return "settings-input";
  if (viewName === "session") return "session-reading";
  // Escape in the Sessions preview returns to the selected row (§6.3), before it clears a search.
  if (viewName === "inbox" && active instanceof Element && active.closest(".inbox-preview-pane")) return "inbox-preview";
  // Board mode shares the Sessions search box, so Escape clears its query the same way.
  if ((viewName === "inbox" || viewName === "board") && inboxFilterActive) return "inbox-filter";
  if (viewName === "settings") return "settings";
  return null;
}
