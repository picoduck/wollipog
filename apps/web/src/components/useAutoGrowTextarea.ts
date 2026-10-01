import { useLayoutEffect, type RefObject } from "react";

/** The §8.4 textarea maximum: a field grows with its text up to this many rows, then scrolls. */
export const TEXTAREA_MAX_ROWS = 12;

/**
 * Grow a textarea with its text, from its `rows` up to `maxRows`, then let it scroll (§8.4).
 *
 * The height is measured rather than left to `field-sizing: content`, which WebKit (the desktop
 * app's webview on macOS and Linux) does not support.
 */
export function useAutoGrowTextarea(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxRows = TEXTAREA_MAX_ROWS) {
  useLayoutEffect(() => {
    const field = ref.current;
    const style = field?.ownerDocument.defaultView?.getComputedStyle(field);
    if (!field || !style) return;
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
  }, [ref, value, maxRows]);
}
