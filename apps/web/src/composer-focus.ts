export function placeComposerCaretAtEnd(
  element: HTMLTextAreaElement,
  isComposing = false,
): boolean {
  if (isComposing) return false;
  const end = element.value.length;
  element.setSelectionRange(end, end);
  element.scrollTop = element.scrollHeight;
  return true;
}

export function focusComposerAtEnd(
  element: HTMLTextAreaElement,
  isComposing = false,
): boolean {
  if (element.ownerDocument.activeElement === element) return false;
  element.focus();
  return placeComposerCaretAtEnd(element, isComposing);
}

export const COMPOSER_FOCUS_DIAGNOSTIC_EVENT = "wollipog:composer-focus";

export type ComposerFocusDiagnosticKind =
  | "focus"
  | "blur"
  | "restore"
  | "selection"
  | "scroll"
  | "composition-start"
  | "composition-end"
  | "mount"
  | "unmount";

export interface ComposerFocusSnapshot {
  valueLength: number;
  selectionStart: number;
  selectionEnd: number;
  selectionDirection: "forward" | "backward" | "none";
  scrollTop: number;
}

interface RememberedComposerFocus extends ComposerFocusSnapshot {
  element: HTMLTextAreaElement;
  expires: ReturnType<typeof setTimeout>;
}

const rememberedComposerFocus = new Map<string, RememberedComposerFocus>();

function diagnosticElementName(element: Element | null): string | null {
  if (!element) return null;
  const role = element.getAttribute("role");
  return role ? `${element.tagName.toLowerCase()}[role=${role}]` : element.tagName.toLowerCase();
}

/** Publish content-free focus diagnostics for browser automation and opt-in development tooling. */
export function reportComposerFocus(
  sessionId: string,
  kind: ComposerFocusDiagnosticKind,
  element: HTMLTextAreaElement,
  isComposing: boolean,
  relatedTarget: EventTarget | null = null,
): void {
  const detail = {
    sessionId,
    kind,
    activeElement: diagnosticElementName(element.ownerDocument.activeElement),
    relatedTarget: relatedTarget instanceof Element ? diagnosticElementName(relatedTarget) : null,
    selectionStart: element.selectionStart,
    selectionEnd: element.selectionEnd,
    selectionDirection: element.selectionDirection,
    scrollTop: element.scrollTop,
    isComposing,
  };
  const targetWindow = element.ownerDocument.defaultView;
  if (targetWindow) {
    targetWindow.dispatchEvent(new targetWindow.CustomEvent(COMPOSER_FOCUS_DIAGNOSTIC_EVENT, { detail }));
  }
}

export function captureComposerFocus(element: HTMLTextAreaElement): ComposerFocusSnapshot {
  return {
    valueLength: element.value.length,
    selectionStart: element.selectionStart,
    selectionEnd: element.selectionEnd,
    selectionDirection: element.selectionDirection,
    scrollTop: element.scrollTop,
  };
}

export function restoreComposerFocus(
  element: HTMLTextAreaElement,
  snapshot: ComposerFocusSnapshot,
  replaceActive = false,
): boolean {
  const active = element.ownerDocument.activeElement;
  if (!replaceActive && active && active !== element.ownerDocument.body && active !== element) return false;
  if (element.value.length !== snapshot.valueLength) return false;
  element.focus({ preventScroll: true });
  const end = element.value.length;
  const start = Math.min(snapshot.selectionStart, end);
  const selectionEnd = Math.min(Math.max(snapshot.selectionEnd, start), end);
  element.setSelectionRange(start, selectionEnd, snapshot.selectionDirection);
  element.scrollTop = snapshot.scrollTop;
  return true;
}

/** Preserve exact focus geometry only across an immediate same-session remount. */
export function rememberComposerFocusForRemount(key: string, element: HTMLTextAreaElement): void {
  const current = rememberedComposerFocus.get(key);
  if (current) clearTimeout(current.expires);
  const remembered: RememberedComposerFocus = {
    ...captureComposerFocus(element),
    element,
    expires: setTimeout(() => {
      if (rememberedComposerFocus.get(key) === remembered) rememberedComposerFocus.delete(key);
    }, 0),
  };
  rememberedComposerFocus.set(key, remembered);
}

export function restoreRememberedComposerFocus(key: string, element: HTMLTextAreaElement): ComposerFocusSnapshot | null {
  for (const [rememberedKey, remembered] of rememberedComposerFocus) {
    if (rememberedKey === key) continue;
    clearTimeout(remembered.expires);
    rememberedComposerFocus.delete(rememberedKey);
  }
  const remembered = rememberedComposerFocus.get(key);
  if (!remembered || remembered.element === element) return null;
  clearTimeout(remembered.expires);
  rememberedComposerFocus.delete(key);
  return remembered;
}
