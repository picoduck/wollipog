import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "./dom-test-cleanup.js";
import { useConnectionLostFor } from "./connection-lost.js";
import type { ConnState } from "./store.js";

/**
 * docs/design-system.md §12.5: the offline banner appears after 2s of disconnection. The store
 * retries every 1.5s, so a lost connection flips between offline and connecting; the hold has to
 * span those retries, or the banner never appears at all.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

function Probe({ conn }: { conn: ConnState }) {
  return <output>{useConnectionLostFor(conn, 2000) ? "lost" : "fine"}</output>;
}

async function harness() {
  const timers: Array<{ id: number; at: number; run: () => void }> = [];
  let now = 0;
  let nextId = 1;
  const realSet = domWindow.setTimeout;
  const realClear = domWindow.clearTimeout;
  domWindow.setTimeout = ((run: () => void, delay = 0) => {
    const id = nextId++;
    timers.push({ id, at: now + delay, run });
    return id;
  }) as never;
  domWindow.clearTimeout = ((id: number) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index >= 0) timers.splice(index, 1);
  }) as never;
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  return {
    async render(conn: ConnState) { await act(async () => root.render(<Probe conn={conn} />)); },
    async advance(ms: number) {
      now += ms;
      for (const timer of [...timers].filter((candidate) => candidate.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        await act(async () => { timer.run(); });
      }
    },
    text: () => container.textContent,
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
      domWindow.setTimeout = realSet;
      domWindow.clearTimeout = realClear;
    },
  };
}

test("a cold load's first connection attempt never counts as lost", async () => {
  const view = await harness();
  try {
    await view.render("connecting");
    await view.advance(5000);
    assert.equal(view.text(), "fine");
    await view.render("online");
    assert.equal(view.text(), "fine");
  } finally {
    await view.dispose();
  }
});

test("a connection lost across 1.5s retries is reported after 2s, and clears when back online", async () => {
  const view = await harness();
  try {
    await view.render("online");
    await view.render("offline");
    await view.advance(1500);
    assert.equal(view.text(), "fine", "a blip shorter than 2s shows nothing");
    // The retry: connecting, then offline again before the hold has elapsed.
    await view.render("connecting");
    await view.advance(300);
    await view.render("offline");
    await view.advance(300);
    assert.equal(view.text(), "lost", "2.1s of disconnection across a retry shows the banner");
    await view.render("connecting");
    assert.equal(view.text(), "lost", "the banner stays through the next attempt");
    await view.render("online");
    assert.equal(view.text(), "fine");
    await view.render("connecting");
    await view.advance(5000);
    assert.equal(view.text(), "fine", "a reconnect that is only connecting is not lost");
  } finally {
    await view.dispose();
  }
});
