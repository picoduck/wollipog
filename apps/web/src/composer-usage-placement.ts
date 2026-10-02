import { useCallback, useLayoutEffect, useState } from "react";

/**
 * Below this composer-column width the bar cannot seat the usage triggers without crowding (#2166):
 * 640px at the default 16px root. It is in rem because the triggers' text is, so a reader who has
 * raised their text size gets the roomier placements at a proportionally wider column.
 */
export const COMPOSER_USAGE_MIN_COLUMN_REM = 40;

/**
 * - `bar`: the composer bar's trailing cluster, before the mic.
 * - `model-settings`: the read-only Session Usage group at the top of Model Settings.
 * - `row`: their own right-aligned row above the bar, for a narrow column whose Model Settings
 *   cannot open (an agent with nothing to configure, or a person who may not change it).
 */
export type ComposerUsagePlacement = "bar" | "model-settings" | "row";

/**
 * Where the live context and cost figures go (#2166; docs/design-system.md §15.1). The composer
 * bar never wraps (#1065), so on a phone, or in a composer column narrower than the minimum at any
 * width, the two triggers leave it, for Model Settings when it can open and their own row when it
 * cannot.
 */
export function composerUsagePlacement({ narrow, modelSettingsOpenable }: {
  /** A phone, or a composer column measured narrower than the minimum. */
  narrow: boolean;
  modelSettingsOpenable: boolean;
}): ComposerUsagePlacement {
  if (!narrow) return "bar";
  return modelSettingsOpenable ? "model-settings" : "row";
}

/**
 * Whether an element that may mount and unmount is laid out narrower than `rem` root ems, kept
 * current by a ResizeObserver on the element and on a hidden `rem`-wide probe, so a change of the
 * root font size re-measures as a resize does. It holds the comparison rather than the width, so a
 * resize that does not cross the threshold renders nothing. Measured in a layout effect so the first
 * paint already reflects it; an element not laid out yet (0 wide) or not mounted counts as not
 * narrow, so a desktop never flashes the figures out of the bar while it measures.
 */
export function useNarrowerThanRem<T extends HTMLElement>(rem: number): [(element: T | null) => void, boolean] {
  const [element, setElement] = useState<T | null>(null);
  const [narrow, setNarrow] = useState(false);
  const ref = useCallback((next: T | null) => setElement(next), []);
  useLayoutEffect(() => {
    if (!element) {
      setNarrow(false);
      return;
    }
    const probe = element.ownerDocument.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = `position:absolute;top:0;left:0;width:${rem}rem;height:0;visibility:hidden;pointer-events:none`;
    element.ownerDocument.body.append(probe);
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      setNarrow(width > 0 && width < probe.getBoundingClientRect().width);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    observer?.observe(probe);
    return () => {
      observer?.disconnect();
      probe.remove();
    };
  }, [element, rem]);
  return [ref, narrow];
}
