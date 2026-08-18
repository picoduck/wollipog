/** Structural surface of the composer textarea used by the auto-grow probe. */
export interface ComposerAutoGrowElement {
  clientWidth: number;
  scrollHeight: number;
  style: { height: string };
  parentElement: { offsetHeight: number; style: { height: string } } | null;
}

/**
 * Fits the composer textarea to its content, up to the CSS max-height (then it scrolls internally).
 *
 * The `height: auto` measurement probe must not leak into ancestor layout. If the collapsed probe
 * reaches the pane's flex column, the transcript above momentarily grows and the browser clamps
 * its scrollTop; restoring the final height then leaves a bare scroll event with no net viewport
 * resize, which follow-tail can only read as manual reader intent (BUG-017's false pause).
 * Locking the parent box's height for the probe's forced layout confines the collapse to the
 * composer, so the transcript sees exactly one clean resize: the final committed height.
 *
 * Skips while the element has no laid-out width (e.g. a hidden/collapsed column): a scrollHeight
 * read at zero width returns a garbage-tall value; the next keystroke recomputes once visible.
 */
export function resizeComposerToContent(el: ComposerAutoGrowElement): void {
  if (el.clientWidth === 0) return;
  const box = el.parentElement;
  const previousBoxHeight = box ? box.style.height : "";
  if (box) box.style.height = `${box.offsetHeight}px`;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
  if (box) box.style.height = previousBoxHeight;
}
