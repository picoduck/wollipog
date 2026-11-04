import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { useAutomationPolling } from "./useAutomationPolling.js";

/**
 * `reread()` (#2972): a write's follow-up read belongs to the polling lifecycle it was asked in. When
 * that lifecycle ends (an API change, unmount) while the reread waits behind a read in flight, it
 * must not run the obsolete loader afterwards.
 */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

type Load = (current: () => boolean) => Promise<void>;
type Polling = ReturnType<typeof useAutomationPolling>;

function Probe({ load, report }: { load: Load; report: (polling: Polling) => void }) {
  report(useAutomationPolling(load));
  return null;
}

const settle = () => act(async () => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
});

test("a reread queued behind a read in flight never runs the loader a replaced lifecycle owned", async () => {
  let release: (() => void) | undefined;
  const obsolete: string[] = [];
  const loadA: Load = async () => {
    obsolete.push("read");
    if (obsolete.length === 1) await new Promise<void>((resolve) => { release = resolve; });
  };
  let currentReads = 0;
  const loadB: Load = async () => { currentReads += 1; };
  let polling: Polling | undefined;
  const report = (next: Polling) => { polling = next; };

  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  try {
    await act(async () => { root.render(<Probe load={loadA} report={report} />); });
    assert.deepEqual(obsolete, ["read"], "the first poll is in flight");

    // A write settles and asks for a fresh read; it waits behind the poll in flight.
    const queued = polling!.reread();
    // The API changes before the poll comes back: a new lifecycle with its own loader.
    await act(async () => { root.render(<Probe load={loadB} report={report} />); });
    await act(async () => { release?.(); });
    await act(async () => { await queued; });
    await settle();

    assert.deepEqual(obsolete, ["read"], "the queued reread does not run the obsolete loader");
    assert.ok(currentReads >= 1, "the new lifecycle reads with its own loader");
  } finally {
    release?.();
    await act(async () => root.unmount());
    mountPoint.remove();
  }
});

test("a reread in a live lifecycle waits for the read in flight and then reads again", async () => {
  let release: (() => void) | undefined;
  const reads: string[] = [];
  const load: Load = async (current) => {
    reads.push(`read ${reads.length + 1}`);
    if (reads.length === 1) {
      await new Promise<void>((resolve) => { release = resolve; });
      // A read that started before the write commits nothing.
      assert.equal(current(), false);
    }
  };
  let polling: Polling | undefined;
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  try {
    await act(async () => { root.render(<Probe load={load} report={(next) => { polling = next; }} />); });
    const queued = polling!.reread();
    await act(async () => { release?.(); });
    await act(async () => { await queued; });
    assert.deepEqual(reads, ["read 1", "read 2"]);
  } finally {
    release?.();
    await act(async () => root.unmount());
    mountPoint.remove();
  }
});
