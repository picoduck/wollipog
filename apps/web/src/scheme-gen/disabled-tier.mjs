/**
 * The disabled text tier, `--text-disabled` (docs/design-system.md §3.1, #2518).
 *
 * A transparent control (a ghost button, an icon button, a composer bar ghost control) rests in
 * `--text-dim`, and `--text-faint` is only 1.10-1.23:1 from it, so a control disabled in the faint
 * tier read as enabled. This tier sits clearly below rest while staying legible as a glyph:
 *
 *   - at least 3:1 on `--bg` and on `--bg-elev`, the glyph floor #1879 set for unavailable actions;
 *   - at least 1.8:1 from `--text-dim`, so disabled is visibly not rest.
 *
 * Both hold only where `--text-dim` clears about 5.4:1 (3 x 1.8) on the worse fill. A palette whose
 * `--text-dim` has less headroom gets a louder `--text-dim` here rather than a component exception.
 */
import { contrast, mix } from "./colour.mjs";

/** The glyph floor on both page fills (#1879). */
export const DISABLED_GLYPH_FLOOR = 3;
/** The least separation from rest (`--text-dim`) that reads as disabled. */
export const DISABLED_REST_STEP = 1.8;
/**
 * How far below rest the tier aims when the fills leave room: about 2:1, the step the composer's
 * one-off disabled ink (#2509) was accepted at. Past that the glyph only gets harder to read.
 */
const DISABLED_REST_AIM = 2;

/**
 * The quietest ink between `rest` and the ground that still clears the glyph floor on every fill,
 * stopping early once it is `DISABLED_REST_AIM` below rest. `null` when rest itself misses the floor.
 */
function settle(rest, ground, fills) {
  let chosen = null;
  for (let t = 0; t <= 1.0001; t += 0.002) {
    const candidate = mix(rest, ground, t);
    if (fills.some((fill) => contrast(candidate, fill) < DISABLED_GLYPH_FLOOR)) break;
    chosen = candidate;
    if (contrast(rest, candidate) >= DISABLED_REST_AIM) break;
  }
  return chosen;
}

/**
 * Derive `--text-disabled` from a palette's `--text-dim`, `--bg` and `--bg-elev`.
 *
 * Returns the tier and the `--text-dim` it was measured against. That is the given `dim` whenever
 * it has the headroom; otherwise `dim` is moved toward `extreme` (white in a dark theme, black in a
 * light one) only as far as the tier needs, and the caller must adopt the louder value. THROWS when
 * even the extreme leaves no room, rather than shipping a tier that misses a bound.
 */
export function disabledTier({ dim, bg, bgElev, extreme }, label = "--text-disabled") {
  const fills = [bg, bgElev];
  for (let s = 0; s <= 1.0001; s += 0.002) {
    const rest = mix(dim, extreme, s);
    const disabled = settle(rest, bg, fills);
    if (disabled && contrast(rest, disabled) >= DISABLED_REST_STEP) return { dim: rest, disabled };
  }
  throw new Error(
    `${label}: no --text-dim between ${dim} and ${extreme} leaves room for a disabled tier ` +
    `${DISABLED_REST_STEP}:1 below it at ${DISABLED_GLYPH_FLOOR}:1 on ${bg} and ${bgElev}`,
  );
}
