import type React from "react";
import { KEYBOARD_EDITABLE, TOUCH_PHONE_MEDIA } from "../../mobile-viewport.js";

/**
 * A request card's `onMouseDown` (#2205, #2675). On a touch phone a focused text field is the
 * software keyboard: the request dock caps lower and the tab bar hides (styles.css). Pressing a
 * button, row or label in a docked card while a field has focus, the card's own (an authorization
 * code, Something Else…) or the composer's, keeps that field focused until the click lands. Its blur
 * would restore the full layout between the press and the click and move the control out from under
 * the finger. The layout may change after the click, never between press and click. A press on a
 * text field itself moves focus as usual.
 */
export function holdFieldFocus(event: React.MouseEvent<HTMLElement>): void {
  const doc = event.currentTarget.ownerDocument;
  const active = doc.activeElement;
  const target = event.target as HTMLElement;
  if (!(active instanceof HTMLElement) || !active.matches(KEYBOARD_EDITABLE) ||
      target.closest(KEYBOARD_EDITABLE) || !target.closest("button, label, input") ||
      !doc.defaultView?.matchMedia(TOUCH_PHONE_MEDIA).matches) return;
  event.preventDefault();
}
