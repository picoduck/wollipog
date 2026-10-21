import type { Locator } from "@playwright/test";

export interface VerticalHitArea {
  /** The control's drawn box. */
  top: number;
  bottom: number;
  /** The span, down the control's centre line, where a tap lands on the control or inside it. */
  hitTop: number;
  hitBottom: number;
}

/**
 * Probes each matched control's tap target down its centre line with `elementFromPoint`, so a
 * borrowed hit area (a `::after` reaching past the drawn box, docs/design-system.md §2.8) counts and
 * a neighbour covering the edge does not. Scrolls the first control into view, then measures every
 * match in one pass so the coordinates share a scroll position.
 */
export async function verticalHitAreas(controls: Locator, reach = 12): Promise<VerticalHitArea[]> {
  await controls.first().scrollIntoViewIfNeeded();
  return controls.evaluateAll((elements, reach) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    let hitTop = Number.POSITIVE_INFINITY;
    let hitBottom = Number.NEGATIVE_INFINITY;
    for (let y = box.top - reach; y <= box.bottom + reach; y += 0.5) {
      const target = document.elementFromPoint(x, y);
      if (target && (target === element || element.contains(target))) {
        hitTop = Math.min(hitTop, y);
        hitBottom = Math.max(hitBottom, y + 0.5);
      }
    }
    return { top: box.top, bottom: box.bottom, hitTop, hitBottom };
  }), reach);
}
