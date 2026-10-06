import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { recordSessionActivity } from "../activity.js";
import { ActivityStrip } from "./ActivityStrip.js";

const domWindow = new Window();
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

test("activity strip renders a thirty-minute series, named only in its compact row form", async () => {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const now = 30 * 60_000;
  let activity = recordSessionActivity(undefined, now - 60_000);
  activity = recordSessionActivity(activity, now);
  activity = recordSessionActivity(activity, now);

  await act(async () => {
    root.render(<ActivityStrip activity={activity} now={now} compact className="test-strip" />);
  });

  const strip = container.querySelector<HTMLElement>(".activity-strip")!;
  // #2209: the row's strip is an image with a name and tooltip, not decoration.
  assert.equal(strip.getAttribute("aria-hidden"), null);
  assert.equal(strip.getAttribute("role"), "img");
  assert.equal(strip.getAttribute("aria-label"), "Tool activity in the last 30 minutes");
  assert.equal(strip.getAttribute("title"), "Tool activity in the last 30 minutes");
  assert.equal(strip.classList.contains("compact"), true);
  assert.equal(strip.classList.contains("live"), true);
  assert.equal(strip.classList.contains("test-strip"), true);
  assert.equal(strip.querySelectorAll(".activity-strip-bar").length, 30);
  assert.equal(strip.querySelectorAll(".activity-strip-bar.active").length, 2);

  // The session detail's full-size strip stays decorative beside its own label.
  await act(async () => {
    root.render(<ActivityStrip activity={activity} now={now} />);
  });
  const full = container.querySelector<HTMLElement>(".activity-strip")!;
  assert.equal(full.getAttribute("aria-hidden"), "true");
  assert.equal(full.getAttribute("role"), null);
  assert.equal(full.getAttribute("title"), null);

  await act(async () => { root.unmount(); });
  container.remove();
});
