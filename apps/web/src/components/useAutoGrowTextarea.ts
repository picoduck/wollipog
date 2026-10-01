import { useLayoutEffect, type RefObject } from "react";

/** The §8.4 textarea maximum: a field grows with its text up to this many rows, then scrolls. */
export const TEXTAREA_MAX_ROWS = 12;

/** Fit `field` to its text: its `rows` height at least, `maxRows` at most, scrolling beyond. */
function fitTextarea(field: HTMLTextAreaElement, maxRows: number) {
  const style = field.ownerDocument.defaultView?.getComputedStyle(field);
  if (!style) return;
  const px = (length: string) => Number.parseFloat(length) || 0;
  const lineHeight = px(style.lineHeight) || px(style.fontSize) * 1.5;
  const borders = px(style.borderTopWidth) + px(style.borderBottomWidth);
  const max = lineHeight * maxRows + px(style.paddingTop) + px(style.paddingBottom) + borders;
  // Back to the `rows` height first, so deleting text shrinks the field again.
  field.style.height = "";
  const wanted = field.scrollHeight + borders;
  if (wanted <= field.offsetHeight) {
    field.style.overflowY = "hidden";
    return;
  }
  field.style.height = `${Math.min(wanted, max)}px`;
  field.style.overflowY = wanted > max ? "auto" : "hidden";
}

/**
 * Grow a textarea with its text, from its `rows` up to `maxRows`, then let it scroll (§8.4).
 *
 * The height is measured rather than left to `field-sizing: content`, which WebKit (the desktop
 * app's webview on macOS and Linux) does not support. It is measured again when the text changes
 * and when the field's width does (a narrower window or a rotated phone rewraps the same text);
 * the heights this sets are ignored, so measuring never feeds itself.
 */
export function useAutoGrowTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxRows = TEXTAREA_MAX_ROWS) {
  useLayoutEffect(() => {
    if (ref.current) fitTextarea(ref.current, maxRows);
  }, [ref, value, maxRows]);

  useLayoutEffect(() => {
    const field = ref.current;
    const Observer = field?.ownerDocument.defaultView?.ResizeObserver;
    if (!field || !Observer) return;
    let width = field.offsetWidth;
    const observer = new Observer(() => {
      if (field.offsetWidth === width) return;
      width = field.offsetWidth;
      fitTextarea(field, maxRows);
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [ref, maxRows]);
}
