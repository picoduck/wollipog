import { inTypingContext, shortcutLayerActive, type ShortcutScope } from "./shortcuts.js";

export type FocusZone = "rail" | "list" | "detail";

export const FOCUS_ZONE_ORDER: readonly FocusZone[] = ["rail", "list", "detail"];

export type ShortcutViewName = "inbox" | "session" | string;

export function focusZoneForElement(element: Element | null): FocusZone | null {
  const zone = element?.closest<HTMLElement>("[data-focus-zone]")?.dataset.focusZone;
  return zone === "rail" || zone === "list" || zone === "detail" ? zone : null;
}

function focusTargetForZone(targetDocument: Document, zone: FocusZone): HTMLElement | null {
  const root = [...targetDocument.querySelectorAll<HTMLElement>(`[data-focus-zone="${zone}"]`)]
    .find((candidate) => !candidate.closest("[inert]") && !candidate.hidden && candidate.getAttribute("aria-hidden") !== "true");
  if (!root) return null;
  if (zone === "rail") {
    return root.querySelector<HTMLElement>('[aria-current="page"], button:not(:disabled), [href]') ?? root;
  }
  if (zone === "list") return root.querySelector<HTMLElement>(".inbox-list, .inbox-zero") ?? root;
  if (zone === "detail") return root.querySelector<HTMLElement>(".detail-scroll, .inbox-preview-empty") ?? root;
  if (root.matches('[tabindex]:not([tabindex="-1"])')) return root;
  return root.querySelector<HTMLElement>(
    '[tabindex]:not([tabindex="-1"]), button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href]',
  ) ?? root;
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
  focusTargetForZone(targetDocument, next)?.focus();
  return next;
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
  if (viewName === "inbox" && (zone === null || zone === "list" || zone === "detail")) return "Inbox";
  if (viewName === "session" && sessionReading && (zone === null || zone === "detail")) return "Session Reading";
  return viewName === "session" ? "Session" : "Global";
}

export type EscapeOwner =
  | "layer"
  | "terminal"
  | "terminal-exit"
  | "composer"
  | "session-reading"
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
  if (shortcutLayerActive(targetDocument)) return "layer";

  const active = targetDocument.activeElement;
  if (active instanceof Element && active.closest(".xterm")) {
    return event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey ? "terminal-exit" : "terminal";
  }
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null;
  if (active instanceof Element && active.closest(".composer")) return "composer";
  if (viewName === "settings" && inTypingContext(targetDocument)) return "settings-input";
  if (viewName === "session") return "session-reading";
  if (viewName === "inbox" && inboxFilterActive) return "inbox-filter";
  if (viewName === "settings") return "settings";
  return null;
}
