/**
 * Which popover layer is on TOP? Escape must peel exactly one layer, and "first backdrop in
 * document order" is wrong the moment two popovers coexist (a ⋯ menu at z=30 under a
 * creation menu at z=40). Topmost = highest z-index; later-in-document wins ties, matching
 * how equal-z siblings stack. Pure — unit-tested; the DOM caller supplies the z values.
 */
export function pickTopmost<T>(items: T[], zOf: (item: T) => number): T | null {
  let top: T | null = null;
  let topZ = -Infinity;
  for (const item of items) {
    const z = zOf(item);
    if (z >= topZ) {
      top = item;
      topZ = z;
    }
  }
  return top;
}
