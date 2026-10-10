import { useLayoutEffect, useState } from "react";

/** Side by Side's two columns need this much of the side panel (#2848): `@container rp (min-width: 720px)`. */
export const SPLIT_MIN_PANEL_PX = 720;

/**
 * Whether the side panel holding `element` (the `rp` container, docs/design-system.md §2.10) is at least
 * `min` pixels wide, followed with a ResizeObserver as the panel is dragged, expanded or restored.
 *
 * The panel's content box is what `@container rp` rules read, so this agrees with the stylesheet.
 * Where nothing can be measured — no ResizeObserver, no panel around `element`, or no layout at all — it
 * answers yes: a choice is never withdrawn on a width nobody measured.
 */
export function usePanelAtLeast(element: HTMLElement | null, min: number): boolean {
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const panel = element?.closest<HTMLElement>(".rpanel");
    if (!panel || typeof ResizeObserver === "undefined") return;
    const apply = (width: number) => {
      if (width > 0) setWide(width >= min);
    };
    // Before the first paint, so a narrow panel never flashes a layout it cannot hold.
    apply(panel.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) apply(entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, [element, min]);
  return wide;
}
