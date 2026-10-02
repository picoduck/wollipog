import { useCallback, useLayoutEffect, useState } from "react";

/** Below this composer-column width the bar cannot seat the usage triggers without crowding (#2166). */
export const COMPOSER_USAGE_MIN_COLUMN_PX = 640;

export type ComposerUsagePlacement = "bar" | "model-settings";

/**
 * Where the live context and cost figures go (#2166; docs/design-system.md §15.1).
 *
 * The composer bar never wraps (#1065), so on a phone, or in a composer column narrower than
 * 640px at any width, the two triggers leave the bar and Model Settings opens with a read-only
 * Session Usage group instead. That group is only reachable while Model Settings can open: an agent
 * with nothing to configure has no Model Settings trigger, and a person who may not change the
 * model has a disabled one. The bar then has the room that trigger would have taken, so the figures
 * stay there rather than becoming unreachable.
 */
export function composerUsagePlacement({ phone, narrowColumn, modelSettingsOpenable }: {
  phone: boolean;
  /** The composer column measured narrower than the minimum; false until it has been measured. */
  narrowColumn: boolean;
  modelSettingsOpenable: boolean;
}): ComposerUsagePlacement {
  if (!modelSettingsOpenable) return "bar";
  return phone || narrowColumn ? "model-settings" : "bar";
}

/**
 * Whether an element that may mount and unmount is laid out narrower than `px`, kept current by a
 * ResizeObserver. It holds the comparison rather than the width, so a resize that does not cross
 * the threshold renders nothing. Measured in a layout effect so the first paint already reflects
 * it; an element not laid out yet (0 wide) or not mounted counts as not narrow, so a desktop never
 * flashes the figures into the menu while it measures.
 */
export function useNarrowerThan<T extends HTMLElement>(px: number): [(element: T | null) => void, boolean] {
  const [element, setElement] = useState<T | null>(null);
  const [narrow, setNarrow] = useState(false);
  const ref = useCallback((next: T | null) => setElement(next), []);
  useLayoutEffect(() => {
    if (!element) {
      setNarrow(false);
      return;
    }
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      setNarrow(width > 0 && width < px);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, px]);
  return [ref, narrow];
}
