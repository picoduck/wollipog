import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { prefersReducedMotion, scrollBehavior } from "./motion.js";

const original = Object.getOwnPropertyDescriptor(globalThis, "window");

function withMatchMedia(reduce: boolean | null) {
  // null models an environment with no matchMedia at all (SSR, plain node:test).
  const value = reduce === null
    ? {}
    : { matchMedia: (query: string) => ({ matches: reduce && /prefers-reduced-motion:\s*reduce/.test(query) }) };
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value });
}

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "window", original);
  else Reflect.deleteProperty(globalThis, "window");
});

/**
 * The stylesheet's global reduced-motion guard sets `scroll-behavior: auto !important`, but an
 * explicit `ScrollToOptions.behavior` overrides the CSS property outright. The Inbox's Page Down
 * and Page Up passed `behavior: "smooth"` unconditionally, so the single largest movement in the
 * app kept animating for a user who had asked their OS to stop animation.
 */
test("scroll behaviour follows the reduced-motion setting", () => {
  withMatchMedia(true);
  assert.equal(prefersReducedMotion(), true);
  assert.equal(scrollBehavior(), "auto", "a reduce request must produce an instant jump");

  withMatchMedia(false);
  assert.equal(prefersReducedMotion(), false);
  assert.equal(scrollBehavior(), "smooth", "and must not flatten motion for everyone else");
});

test("the helper is safe where matchMedia does not exist", () => {
  withMatchMedia(null);
  assert.equal(prefersReducedMotion(), false);
  assert.equal(scrollBehavior(), "smooth");
});

/**
 * "auto" rather than omitting the field: with the property absent the element's own CSS
 * `scroll-behavior` still applies, and that could itself be smooth.
 */
test("reduced motion requests auto explicitly, not absence", () => {
  withMatchMedia(true);
  const behavior = scrollBehavior();
  assert.notEqual(behavior, undefined);
  assert.equal(behavior, "auto");
});

test("the query asked is the reduced-motion query", () => {
  const asked: string[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true, writable: true,
    value: { matchMedia: (query: string) => { asked.push(query); return { matches: true }; } },
  });
  scrollBehavior();
  // A helper that matched any media query would report reduce for every user.
  assert.deepEqual(asked, ["(prefers-reduced-motion: reduce)"]);
});
