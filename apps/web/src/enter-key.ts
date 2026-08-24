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

export function storedEnterKeyBehavior(win: Window = window): EnterKeyBehavior | null {
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
  } catch {
    // Private-mode storage failures leave the derived default in force; the UI still reflects
    // the attempted choice for this page's lifetime only via the change event below.
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
