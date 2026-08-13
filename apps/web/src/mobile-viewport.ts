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
 */

/** Below this the gap is sub-pixel rounding, not an occlusion worth compensating for. */
const NOISE_FLOOR_PX = 8;

export function installMobileViewportFallback(win: Window = window): () => void {
  const viewport = win.visualViewport;
  if (!viewport) return () => undefined;

  const root = win.document.documentElement;
  let frame = 0;

  const apply = () => {
    frame = 0;
    const occluded = win.innerHeight - viewport.offsetTop - viewport.height;
    if (occluded > NOISE_FLOOR_PX) {
      root.style.setProperty("--keyboard-inset", `${Math.round(occluded)}px`);
    } else {
      root.style.removeProperty("--keyboard-inset");
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
