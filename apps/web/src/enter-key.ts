import { useSyncExternalStore } from "react";
import { TOUCH_PHONE_MEDIA } from "./mobile-viewport.js";

/**
 * What the composer's Enter key does on THIS device.
 *
 * The pair (Enter, Shift+Enter) swaps as a unit: "send" is Enter sends and Shift+Enter inserts a
 * newline; "newline" is the reverse. The swap is what keeps a keyboard send available in newline
 * mode without touching Ctrl+Enter, which belongs to steering.
 *
 * Stored per device (localStorage), and only when the user chooses: the default is not stored but
 * DERIVED from the device class, so an untouched phone gets newline (a software keyboard has no
 * Shift+Enter, and messaging apps set that expectation) while an untouched desktop gets send
 * (the Slack/Discord convention). A hardware keyboard on a phone is undetectable — that user
 * flips this setting instead.
 */
export type EnterKeyBehavior = "send" | "newline";

export const ENTER_KEY_STORAGE_KEY = "wollipog.enter-key";

/** Same-tab writes never fire the browser's `storage` event, so the setter announces its own. */
const ENTER_KEY_CHANGE_EVENT = "wollipog:enter-key-change";

/**
 * The page-lifetime home of a choice storage refused to keep.
 *
 * Populated ONLY when the write throws (private mode, quota, sandboxing) and cleared by the next
 * successful write, so it can never shadow a value another tab stored. Without it the change
 * event announced a choice every reader immediately re-derived away: the settings row snapped
 * back and the composer never changed, with no feedback that anything failed.
 */
const unstorableChoice = new WeakMap<Window, EnterKeyBehavior>();

export function storedEnterKeyBehavior(win: Window = window): EnterKeyBehavior | null {
  const remembered = unstorableChoice.get(win);
  if (remembered) return remembered;
  try {
    const value = win.localStorage.getItem(ENTER_KEY_STORAGE_KEY);
    return value === "send" || value === "newline" ? value : null;
  } catch {
    return null;
  }
}

export function enterKeyBehavior(win: Window = window): EnterKeyBehavior {
  return storedEnterKeyBehavior(win)
    ?? (win.matchMedia(TOUCH_PHONE_MEDIA).matches ? "newline" : "send");
}

export function setEnterKeyBehavior(value: EnterKeyBehavior, win: Window = window): void {
  try {
    win.localStorage.setItem(ENTER_KEY_STORAGE_KEY, value);
    unstorableChoice.delete(win);
  } catch {
    // The choice still governs this page for its lifetime; only persistence is lost.
    unstorableChoice.set(win, value);
  }
  win.dispatchEvent(new Event(ENTER_KEY_CHANGE_EVENT));
}

/**
 * Whether THIS Enter keydown sends, reading the live setting: a keydown handler outlives renders,
 * and the settings panel can change the value while a composer is mounted.
 */
export function enterKeystrokeSends(shiftKey: boolean, win: Window = window): boolean {
  return enterKeyBehavior(win) === "send" ? !shiftKey : shiftKey;
}

/** Live value for render-time copy (the Send tooltip); tracks the setter and breakpoint changes. */
export function useEnterKeyBehavior(): EnterKeyBehavior {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(TOUCH_PHONE_MEDIA);
      mq.addEventListener("change", onChange);
      window.addEventListener(ENTER_KEY_CHANGE_EVENT, onChange);
      window.addEventListener("storage", onChange);
      return () => {
        mq.removeEventListener("change", onChange);
        window.removeEventListener(ENTER_KEY_CHANGE_EVENT, onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    () => enterKeyBehavior(),
  );
}
