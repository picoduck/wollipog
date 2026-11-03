import { useLayoutEffect, useState } from "react";

/** Side by Side's two columns need this much of the side panel (#2848): `@container rp (min-width: 720px)`. */
export const SPLIT_MIN_PANEL_PX = 720;

/**
 * Review's toolbar holds Scope, Select Lines and View Options on one row from this panel width
 * (#2849). Narrower, Select Lines is a View Options item, so the row stays one line (#2846).
 */
export const SELECT_LINES_TOOLBAR_MIN_PANEL_PX = 360;

/**
 * Whether the side panel holding `element` (the `rp` container, docs/design-system.md §2.10) is at least
 * `min` pixels wide, followed with a ResizeObserver as the panel is dragged, expanded or restored.
 *
 * The panel's content box is what `@container rp` rules read, so this agrees with the stylesheet.
 * Where nothing can be measured — no ResizeObserver, no panel around `element`, or no layout at all — it
 * answers yes: a choice is never withdrawn on a width nobody measured.
 */
export function usePanelAtLeast(element: HTMLElement | null, min: number): boolean {
  return useContainerAtLeast(element, ".rpanel", min);
}

/**
 * Whether the main column holding `element` (`.main`, the `app` container, §2.10) is at least `min`
 * pixels wide: the room left after the rail and any docked panel, never the viewport's. Followed and
 * defaulted as `usePanelAtLeast` is.
 */
export function useColumnAtLeast(element: HTMLElement | null, min: number): boolean {
  return useContainerAtLeast(element, ".main", min);
}

function useContainerAtLeast(element: HTMLElement | null, container: string, min: number): boolean {
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const box = element?.closest<HTMLElement>(container);
    if (!box || typeof ResizeObserver === "undefined") return;
    const apply = (width: number) => {
      if (width > 0) setWide(width >= min);
    };
    // Before the first paint, so a narrow container never flashes a layout it cannot hold.
    apply(box.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) apply(entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [element, container, min]);
  return wide;
}
