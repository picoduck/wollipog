import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampTransform,
  FIT_TRANSFORM,
  isZoomed,
  MAX_ZOOM,
  pinchTransform,
  swipeDirection,
  zoomAt,
} from "./artifact-gallery-gestures.js";

const stage = { width: 400, height: 300 };
const content = { width: 400, height: 200 };

test("an image never zooms out past fit or in past the limit, and fit is exactly centered", () => {
  assert.deepEqual(clampTransform({ scale: 0.4, x: 30, y: -20 }, stage, content), FIT_TRANSFORM);
  assert.equal(clampTransform({ scale: 50, x: 0, y: 0 }, stage, content).scale, MAX_ZOOM);
  assert.deepEqual(clampTransform({ scale: Number.NaN, x: 5, y: 5 }, stage, content), FIT_TRANSFORM);
  assert.equal(isZoomed(FIT_TRANSFORM), false);
  assert.equal(isZoomed({ scale: 2, x: 0, y: 0 }), true);
});

test("a zoomed image pans only as far as its edges, and an axis it does not overflow stays centered", () => {
  // At 2x the 400x200 image is 800x400: 200px of travel each side across, 50px down.
  assert.deepEqual(clampTransform({ scale: 2, x: 999, y: -999 }, stage, content), { scale: 2, x: 200, y: -50 });
  // At 1.2x it is 480x240, shorter than the 300px stage: it stays centered vertically.
  assert.deepEqual(clampTransform({ scale: 1.2, x: -10, y: 40 }, stage, content), { scale: 1.2, x: -10, y: 0 });
});

test("zooming at a point keeps that point of the image under it", () => {
  const zoomed = zoomAt(FIT_TRANSFORM, { x: 100, y: 50 }, 2);
  // Image point (100, 50) at scale 1 lands at 2*(100,50)+t, which must stay (100, 50).
  assert.deepEqual(zoomed, { scale: 2, x: -100, y: -50 });
  assert.deepEqual(zoomAt(zoomed, { x: 100, y: 50 }, 1), { scale: 1, x: 0, y: 0 });
});

test("a pinch scales by the fingers' spread and carries the image with their midpoint", () => {
  const start = { scale: 1, x: 0, y: 0 };
  const spread = pinchTransform(start, { x: 0, y: 0 }, 100, { x: 0, y: 0 }, 250);
  assert.deepEqual(spread, { scale: 2.5, x: 0, y: 0 });
  // Fingers that spread while moving 40px right keep the pinched point under them.
  const moved = pinchTransform(start, { x: 20, y: 10 }, 100, { x: 60, y: 10 }, 200);
  assert.equal(moved.scale, 2);
  assert.equal(moved.x, 60 - 20 * 2);
  assert.equal(moved.y, 10 - 10 * 2);
  // A degenerate pinch changes nothing.
  assert.equal(pinchTransform(start, { x: 0, y: 0 }, 0, { x: 0, y: 0 }, 50), start);
});

test("a swipe is a clear horizontal drag; a scroll, a nudge or a slow short drag is not", () => {
  assert.equal(swipeDirection(-80, 10, 300), "next");
  assert.equal(swipeDirection(80, -10, 300), "previous");
  // A quick flick counts from a shorter distance.
  assert.equal(swipeDirection(-30, 2, 40), "next");
  assert.equal(swipeDirection(-30, 2, 400), null);
  // Mostly vertical: the person is scrolling.
  assert.equal(swipeDirection(-80, 70, 300), null);
  assert.equal(swipeDirection(-10, 0, 10), null);
});
