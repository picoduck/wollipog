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

test("activity strip renders a decorative thirty-minute series and compact state", async () => {
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
  assert.equal(strip.getAttribute("aria-hidden"), "true");
  assert.equal(strip.classList.contains("compact"), true);
  assert.equal(strip.classList.contains("live"), true);
  assert.equal(strip.classList.contains("test-strip"), true);
  assert.equal(strip.querySelectorAll(".activity-strip-bar").length, 30);
  assert.equal(strip.querySelectorAll(".activity-strip-bar.active").length, 2);

  await act(async () => { root.unmount(); });
  container.remove();
});
