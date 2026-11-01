/**
 * The artifact viewer's gesture arithmetic (#3924), kept apart from the DOM so it can be tested
 * exactly. Coordinates are CSS pixels relative to the stage's center; an image's transform is
 * `translate(x, y) scale(scale)` about its own center, which sits on the stage's center at fit.
 */

export interface ZoomTransform {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Fit to screen: the image's laid-out size, centered. */
export const FIT_TRANSFORM: ZoomTransform = Object.freeze({ scale: 1, x: 0, y: 0 });
export const MAX_ZOOM = 5;
/** Double-tap, double-click and Zoom In's first step. */
export const STEP_ZOOM = 2.5;

/** A horizontal drag this long, and clearly more across than down, moves to the next artifact. */
export const SWIPE_MIN_DISTANCE = 56;
/** A quicker flick counts from this distance, at SWIPE_MIN_VELOCITY px/ms or faster. */
export const SWIPE_FLICK_DISTANCE = 24;
export const SWIPE_MIN_VELOCITY = 0.45;
/** How much more horizontal than vertical a swipe must be: a scroll down the page is not a swipe. */
const SWIPE_DOMINANCE = 1.5;

export const isZoomed = (transform: ZoomTransform): boolean => transform.scale > 1.001;

/**
 * Keep the image covering the stage wherever it is zoomed: it pans no further than its edges, and
 * an axis it does not overflow stays centered. At fit it is exactly centered.
 */
export function clampTransform(transform: ZoomTransform, stage: Size, content: Size): ZoomTransform {
  const scale = Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(transform.scale) ? transform.scale : 1));
  if (scale <= 1.001) return FIT_TRANSFORM;
  const limit = (contentLength: number, stageLength: number) => Math.max(0, (contentLength * scale - stageLength) / 2);
  const clampAxis = (value: number, max: number) => (Number.isFinite(value) ? Math.min(max, Math.max(-max, value)) : 0);
  return {
    scale,
    x: clampAxis(transform.x, limit(content.width, stage.width)),
    y: clampAxis(transform.y, limit(content.height, stage.height)),
  };
}

/** Scale to `scale` keeping the image point under `focus` where it is. */
export function zoomAt(transform: ZoomTransform, focus: Point, scale: number): ZoomTransform {
  const ratio = scale / transform.scale;
  return {
    scale,
    x: focus.x - (focus.x - transform.x) * ratio,
    y: focus.y - (focus.y - transform.y) * ratio,
  };
}

/**
 * A two-finger pinch: the image point that was under the fingers' first midpoint follows their
 * midpoint, and the scale follows how far apart they are. Unclamped; the caller clamps.
 */
export function pinchTransform(
  start: ZoomTransform,
  startMidpoint: Point,
  startDistance: number,
  midpoint: Point,
  distance: number,
): ZoomTransform {
  if (!(startDistance > 0) || !(distance > 0)) return start;
  const scale = start.scale * (distance / startDistance);
  // The image point under the first midpoint, in unscaled image coordinates.
  const px = (startMidpoint.x - start.x) / start.scale;
  const py = (startMidpoint.y - start.y) / start.scale;
  return { scale, x: midpoint.x - px * scale, y: midpoint.y - py * scale };
}

export const midpointOf = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const distanceBetween = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Whether a finished one-finger drag was a swipe, and which way: a drag to the left shows the next
 * artifact, as a page turns. Nothing for a short, slow or mostly vertical drag.
 */
export function swipeDirection(dx: number, dy: number, durationMs: number): "previous" | "next" | null {
  const across = Math.abs(dx);
  if (across < SWIPE_FLICK_DISTANCE || across < Math.abs(dy) * SWIPE_DOMINANCE) return null;
  const velocity = durationMs > 0 ? across / durationMs : Infinity;
  if (across < SWIPE_MIN_DISTANCE && velocity < SWIPE_MIN_VELOCITY) return null;
  return dx < 0 ? "next" : "previous";
}
