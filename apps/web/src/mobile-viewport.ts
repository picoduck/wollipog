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
 * The growth from the LOWEST armed height that counts as the keyboard actually leaving.
 *
 * Deliberately larger than KEYBOARD_CLOSE_PX: a collapsing browser toolbar can return up to
 * ~100px of same-width height in one step, so a release keyed at 100 read a toolbar collapse
 * against a 120px landscape keyboard as the keyboard closing and blurred the field mid-word. No
 * toolbar returns 120; every keyboard this file models does. A keyboard between the two constants
 * arms but cannot release this way — it strands the rail until any tap blurs the field, which is
 * recoverable, where the false blur it replaces dismissed a keyboard the user was typing on.
 */
const KEYBOARD_LEAVE_PX = 120;

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

/**
 * The layout in which typing means a software keyboard: the phone breakpoint on a coarse pointer.
 *
 * One string shared by everything that changes behavior for on-screen typing — the while-typing
 * rail hiding in styles.css restates it as a media block, the dismissal blur below is gated on
 * it, and the composer swaps Enter from send to newline under it.
 */
export const TOUCH_PHONE_MEDIA = "(max-width: 760px) and (pointer: coarse)";

/**
 * Dispatched on the window immediately before the dismissal blur below.
 *
 * The composer's focus-recovery machinery (SessionDetail) treats a blur with no preceding user
 * gesture as ACCIDENTAL background loss and refocuses one frame later — and on Android that
 * refocus re-summons the keyboard the user just collapsed, instantly. Every user-initiated blur
 * is announced by a pointerdown or a keydown; this event is how the detector's programmatic blur
 * announces itself the same way, so the recovery machinery lets it stand.
 */
export const KEYBOARD_DISMISS_BLUR_EVENT = "wollipog:keyboard-dismiss-blur";

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
  // The lowest height seen while armed. Release needs growth of a keyboard's worth from HERE as
  // well as near-restoration to the peak: against a 120px landscape keyboard, a 56px URL-bar
  // collapse lands within KEYBOARD_CLOSE_PX of the peak while the keyboard is still open, and
  // releasing on that blurred the field mid-word. The toolbar can only ever grow the height by
  // its own ~56px; a dismissal always grows it by the whole keyboard.
  let trough = viewport.height;
  // Whether this armed episode has shown a real bottom occlusion. On the browsers that shrink
  // only the visual viewport, `occluded` is a DIRECT keyboard signal the height heuristics can
  // only approximate: browser chrome moves innerHeight and the visual viewport together and
  // cancels out of it, while the keyboard alone moves the gap. Keying release on it makes every
  // chrome-motion interleaving irrelevant — a 140px keyboard whose accessory row shrinks while
  // 100px of toolbar collapses satisfies both height predicates with the keyboard still open,
  // but its occlusion never comes near zero. The height path below remains for the
  // resizes-content family, which never publishes an occlusion and pins its toolbar while the
  // keyboard is up, so the interleaving cannot arise there.
  let occlusionTracked = false;

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
    if (keyboardOpen) occlusionTracked ||= occluded > NOISE_FLOOR_PX;
    // The occlusion release also requires the PAN to be gone: `occluded` is the bottom gap, and a
    // viewport panned toward the focused field can drive the gap inside the noise floor with the
    // keyboard fully open — the height never grew, only the origin moved. A dismissal restores
    // both: the visual viewport cannot be full-height and offset at once. (While pinch-zoomed the
    // offset legitimately stays, so a dismissal there strands the rail until a tap — the
    // recoverable side, where releasing on the gap alone blurred mid-word.)
    const released = occlusionTracked
      ? occluded <= NOISE_FLOOR_PX && viewport.offsetTop <= NOISE_FLOOR_PX
      : height >= peak - KEYBOARD_CLOSE_PX && height - trough >= KEYBOARD_LEAVE_PX;
    if (viewport.width !== lastWidth) {
      lastWidth = viewport.width;
      peak = height;
      trough = height;
      keyboardOpen = false;
      occlusionTracked = false;
    } else if (keyboardOpen && released) {
      keyboardOpen = false;
      occlusionTracked = false;
      peak = Math.max(peak, height);
      if (win.matchMedia(TOUCH_PHONE_MEDIA).matches) {
        const active = win.document.activeElement;
        if (active instanceof HTMLElement && active.matches(KEYBOARD_EDITABLE)) {
          // Announced BEFORE the blur, synchronously: the recovery machinery reads the mark
          // inside its blur handler, so an event after the fact arrives one decision too late.
          win.dispatchEvent(new Event(KEYBOARD_DISMISS_BLUR_EVENT));
          active.blur();
        }
      }
    } else {
      if (!keyboardOpen && height > peak) peak = height;
      if (keyboardOpen) trough = Math.min(trough, height);
      else if (peak - height >= KEYBOARD_CLOSE_PX) {
        keyboardOpen = true;
        trough = height;
        occlusionTracked = occluded > NOISE_FLOOR_PX;
      }
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
