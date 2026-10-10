import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { relativeTime } from "../format.js";
import { RelativeTime, relativeTimeChangesIn } from "./RelativeTime.js";

/** An age keeps itself current instead of waiting for something else to render it (#2872). */

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("relativeTimeChangesIn names exactly when the reading next changes", () => {
  const now = 1_800_000_000_000;
  const readingAt = (age: number) => {
    const clock = mock.method(Date, "now", () => now);
    try { return relativeTime(now - age); } finally { clock.mock.restore(); }
  };
  const ages = [0, 4_999, 5_000, 5_499, 5_500, 30_000, 59_499, 59_500, 59_999, 60_000, 89_999, 90_000,
    3_599_999, 3_600_000, 5_399_999, 86_399_999, 86_400_000, 129_600_000, 250_000_000];
  for (let age = 0; age < 3 * 86_400_000; age = age * 1.37 + 997) ages.push(Math.round(age));
  for (const age of ages) {
    const wait = relativeTimeChangesIn(age);
    assert.ok(wait > 0, `positive wait at ${age}`);
    assert.equal(readingAt(age + wait - 1), readingAt(age), `unchanged just before the change, from ${age}`);
    assert.notEqual(readingAt(age + wait), readingAt(age), `changed at the change, from ${age}`);
  }
});

test("a rendered age moves on by itself", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const at = Date.now();
  try {
    await act(async () => root.render(<RelativeTime at={at} />));
    assert.equal(container.textContent, "just now");
    await act(async () => { mock.timers.tick(5_600); });
    assert.equal(container.textContent, "6s ago");
    await act(async () => { mock.timers.tick(60_000); });
    assert.equal(container.textContent, "1m ago");
    await act(async () => { mock.timers.tick(3_600_000); });
    assert.equal(container.textContent, "1h ago");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    mock.timers.reset();
  }
});
