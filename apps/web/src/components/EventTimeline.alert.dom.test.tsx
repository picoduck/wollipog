import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { TimelineItem } from "../timeline.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { TranscriptErrorAlert } from "./EventTimeline.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const { cleanup } = installDomTestCleanup(domWindow);

test("transcript errors announce once when appended, not when history is hydrated or replayed", async () => {
  const happyContainer = domWindow.document.createElement("div");
  domWindow.document.body.append(happyContainer);
  const container = happyContainer as unknown as HTMLDivElement;
  const root = createRoot(container);
  cleanup(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  const oldItems: TimelineItem[] = [
    { kind: "user_message", id: 1, text: "Run the task" },
    { kind: "error", id: 2, message: "Earlier distinct failure" },
  ];
  const render = async (historyKey: string, items: TimelineItem[], ready = true) => {
    await act(async () => {
      root.render(<TranscriptErrorAlert historyKey={historyKey} items={items} ready={ready} />);
    });
  };

  await render("session:0", oldItems, false);
  await render("session:0", oldItems);
  const alert = container.querySelector('[aria-live="assertive"][data-transcript-error-alert]')!;
  assert.equal(alert.textContent, "", "opening history must not be announced");

  const verificationItems: TimelineItem[] = [
    ...oldItems,
    { kind: "error", id: 3, message: "Worktree verification failed" },
  ];
  await render("session:0", verificationItems);
  assert.equal(alert.textContent, "Worktree verification failed");
  const announcedNode = alert.firstElementChild;
  assert.ok(announcedNode);

  await render("session:0", [
    { kind: "error", id: 0, message: "Loaded from older history" },
    ...verificationItems,
  ]);
  assert.equal(alert.firstElementChild, announcedNode,
    "paging and row remounts must not mutate the live region");

  await render("session:0", verificationItems, false);
  await render("session:0", verificationItems);
  assert.equal(alert.firstElementChild, announcedNode,
    "reconnect hydration must not announce the same durable error again");

  await render("session:1", [
    { kind: "error", id: 1, message: "Error from replacement history" },
  ]);
  assert.equal(alert.textContent, "", "a replacement history primes a fresh announcement cursor");
});
