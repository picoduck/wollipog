import { useCallback } from "react";

// Chrome publishes its own mount/unmount signal. Transcript mutations never reach this registry.
const chrome = new Set<HTMLElement>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

export function toastChromeElements(doc: Document): HTMLElement[] {
  return [...chrome].filter((element) => element.ownerDocument === doc && element.isConnected);
}

export function subscribeToastChrome(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Register chrome or a dock that moves it; optionally keep the element's existing ref. */
export function useToastChrome<T extends HTMLElement = HTMLElement>(ref?: { current: T | null }) {
  return useCallback((element: T | null) => {
    if (ref) ref.current = element;
    if (!element) return;
    chrome.add(element);
    changed();
    return () => {
      chrome.delete(element);
      if (ref?.current === element) ref.current = null;
      changed();
    };
  }, [ref]);
}
