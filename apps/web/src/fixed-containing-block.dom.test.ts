import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import { fixedContainingBlockOffset } from "./fixed-containing-block.js";

/**
 * happy-dom has no layout engine, so the probe's rectangle is stubbed. The real geometry — a
 * contained main column moving an anchored list by the rail's width — is held in a browser by
 * e2e/app-container.spec.ts.
 */
function fixture(probeRect: { left: number; top: number; bottom: number; height: number }) {
  const window = new Window({ url: "http://localhost/", width: 1280, height: 900 });
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const original = window.HTMLElement.prototype.getBoundingClientRect;
  const measured: string[] = [];
  window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    measured.push(this.style.position);
    return { ...probeRect, right: probeRect.left, width: 0, x: probeRect.left, y: probeRect.top, toJSON() {} } as DOMRect;
  } as typeof original;
  return { window, host: host as unknown as Element, measured };
}

test("a containing block's corner and bottom edge become the offsets a fixed surface subtracts", () => {
  const { host, measured } = fixture({ left: 64, top: 0, bottom: 860, height: 860 });
  assert.deepEqual(fixedContainingBlockOffset(host), { left: 64, top: 0, bottom: 40 });
  assert.deepEqual(measured, ["fixed"], "the one element measured is a fixed probe");
  assert.equal(host.childElementCount, 0, "the probe is removed in the same call");
});

test("the viewport is no offset at all", () => {
  const { host } = fixture({ left: 0, top: 0, bottom: 900, height: 900 });
  assert.deepEqual(fixedContainingBlockOffset(host), { left: 0, top: 0, bottom: 0 });
});

test("without layout, or without a host, nothing is offset", () => {
  const { host } = fixture({ left: 0, top: 0, bottom: 0, height: 0 });
  assert.deepEqual(fixedContainingBlockOffset(host), { left: 0, top: 0, bottom: 0 });
  assert.deepEqual(fixedContainingBlockOffset(null), { left: 0, top: 0, bottom: 0 });
});
