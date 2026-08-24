/**
 * Keeps the app inside the *visible* viewport while a software keyboard is open.
 *
 * `interactive-widget=resizes-content` in the viewport meta is the right fix, but it is optional:
 * browsers that do not implement it shrink only the visual viewport, so `100dvh` still measures the
 * full screen and the fixed bottom rail sits behind the keyboard with every destination
 * unreachable. This is the fallback for those browsers.
 *
 * Publishes `--keyboard-inset`: how much of the layout viewport is occluded at the BOTTOM. Anything
 * anchored to the bottom edge — the rail, the More sheet — adds it to its own offset, and the app
 * height subtracts it.
 *
 * Measured as the residual bottom gap rather than inferred from total shrink, because browsers
 * split the same shrink differently: some resize the visual viewport in place (offsetTop stays 0),
 * others pan it toward the focused field (offsetTop grows and the bottom gap narrows). Only the
 * bottom gap describes what is actually hidden underneath the content, which is what a
 * bottom-anchored element needs to clear. An earlier version keyed a boolean off this value with a
 * 120px threshold, so a panned viewport — 300px shorter but only 100px of bottom gap — switched
 * the fallback off entirely and put the rail back under the keyboard.
 *
 * Also keeps FOCUS consistent with the keyboard: when the viewport reports the keyboard closed
 * while a text field still holds focus (Android Back), the field is blurred, because the phone
 * stylesheet reads "a text field has focus" as "the keyboard is up" (see KEYBOARD_EDITABLE).
 */

/** Below this the gap is sub-pixel rounding, not an occlusion worth compensating for. */
const NOISE_FLOOR_PX = 8;

/**
 * How far below the tallest observed height the viewport must SHRINK to count as the keyboard
 * opening, and how close to it the height must return for the keyboard to count as closed.
 *
 * Sits between the two populations it separates: a collapsing browser toolbar moves 56-100px, and
 * the smallest software keyboard — a small phone in landscape — occupies ~120, which is also the
 * landscape keyboard the e2e suite drives, so this cannot rise past it. The close side reuses the
 * same number so a keyboard that closes while the browser toolbar returns — leaving the height up
 * to ~100px short of where it started — still reads as closed.
 */
const KEYBOARD_CLOSE_PX = 100;

/**
 * The controls whose focus summons the software keyboard.
 *
 * Kept in step with the while-typing rule in styles.css (the `.app:has(...)` selector in the phone
 * block): that rule hides the rail while one of these holds focus, and the blur below is what
 * releases it when the keyboard was dismissed WITHOUT a blur — Android Back closes the keyboard
 * and leaves the field focused, which would otherwise strand the navigation hidden. Read-only
 * fields are excluded on both sides: focusing one selects its text and summons nothing, and no
 * viewport event would ever arrive to put the rail back.
 */
const KEYBOARD_EDITABLE = "textarea:not([readonly]), [contenteditable=''], [contenteditable='true'], "
  + "input:not([readonly], [type='button'], [type='checkbox'], [type='color'], [type='file'], "
  + "[type='image'], [type='radio'], [type='range'], [type='reset'], [type='submit'])";

export function installMobileViewportFallback(win: Window = window): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => undefined;

  const root = win.document.documentElement;
  let frame = 0;
  // The keyboard-presence detector: armed by a keyboard-scale SHRINK below the tallest height seen
  // at the current width, released when the height climbs back to within KEYBOARD_CLOSE_PX of it.
  // States rather than per-frame deltas, because a closing keyboard animates: several resize
  // frames each growing less than any threshold, whose sum is the keyboard. Comparing single
  // steps missed every animated dismissal.
  let peak = viewport.height;
  let lastWidth = viewport.width;
  let keyboardOpen = false;

  const apply = () => {
    frame = 0;
    const occluded = win.innerHeight - viewport.offsetTop - viewport.height;
    if (occluded > NOISE_FLOOR_PX) {
      root.style.setProperty("--keyboard-inset", `${Math.round(occluded)}px`);
    } else {
      root.style.removeProperty("--keyboard-inset");
    }

    // The keyboard closing while a text field keeps focus, which Android Back does and no event
    // announces. The blur is what lets the focus-keyed hiding rule in styles.css release the
    // rail. It requires the detector to have been ARMED by a keyboard-scale shrink first — a
    // split-screen pane growing taller is same-width growth too, and blurring on growth alone
    // would dismiss a keyboard that was never open. A width change resets the tracking outright:
    // a rotation or a pinch-zoom moves both axes, nothing about the keyboard survives across one,
    // and blurring there would dismiss a keyboard mid-word. The blur is gated to the geometry the
    // hiding rule exists in, so a desktop window resize never steals focus from a form.
    const height = viewport.height;
    if (viewport.width !== lastWidth) {
      lastWidth = viewport.width;
      peak = height;
      keyboardOpen = false;
    } else if (keyboardOpen && height >= peak - KEYBOARD_CLOSE_PX) {
      keyboardOpen = false;
      peak = Math.max(peak, height);
      if (win.matchMedia("(max-width: 760px) and (pointer: coarse)").matches) {
        const active = win.document.activeElement;
        if (active instanceof HTMLElement && active.matches(KEYBOARD_EDITABLE)) active.blur();
      }
    } else {
      if (!keyboardOpen && height > peak) peak = height;
      if (peak - height >= KEYBOARD_CLOSE_PX) keyboardOpen = true;
    }
  };

  // resize and scroll both fire in bursts as the keyboard animates in; coalesce to one write.
  const schedule = () => {
    if (frame) return;
    frame = win.requestAnimationFrame(apply);
  };

  viewport.addEventListener("resize", schedule);
  viewport.addEventListener("scroll", schedule);
  apply();

  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    viewport.removeEventListener("resize", schedule);
    viewport.removeEventListener("scroll", schedule);
    root.style.removeProperty("--keyboard-inset");
  };
}
