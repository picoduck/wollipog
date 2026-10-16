/** The custom property an `.input-affix` field reserves for its suffix (styles.css, §8.1). */
export const AFFIX_SUFFIX_PROPERTY = "--affix-suffix-w";

/**
 * The ref of an `.input-affix-text` unit after its input (#3185): keeps its field's suffix room equal
 * to the unit as drawn, so the value gets every pixel the unit does not use. The stylesheet reserves
 * 2em of the field's font until the first measurement, which ResizeObserver delivers before the
 * first paint; a unit is drawn in the row's type and the system face, so no fixed reservation fits
 * every unit in every face.
 *
 * One observer per unit, disconnected (and the reservation cleared) when the unit unmounts. It
 * writes only when the width changes, and reads the observer's layout size rather than a client
 * rect, so a dialog's opening scale never shrinks the reservation.
 */
export function affixSuffixRef(unit: HTMLElement | null): (() => void) | undefined {
  const field = unit?.parentElement;
  if (!unit || !field || typeof ResizeObserver === "undefined") return undefined;
  let reserved = "";
  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const width = `${entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width}px`;
    if (width === reserved) return;
    reserved = width;
    field.style.setProperty(AFFIX_SUFFIX_PROPERTY, width);
  });
  observer.observe(unit);
  return () => {
    observer.disconnect();
    field.style.removeProperty(AFFIX_SUFFIX_PROPERTY);
  };
}
