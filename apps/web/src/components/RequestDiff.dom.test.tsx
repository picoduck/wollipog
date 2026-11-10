import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { GitActionData, GitPrSummary } from "@wollipog/protocol";
import { ApiProvider } from "../api-context.js";
import { api, type ApiClient } from "../api.js";
import { RequestDiff } from "./RequestDiff.js";

test("a late response cannot replace a newer observation; failed reload removes the old diff", async () => {
  const window = new Window({ url: "http://localhost/" });
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node, React, IS_REACT_ACT_ENVIRONMENT: true };
  const prior = Object.getOwnPropertyDescriptors(globalThis);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const pending: { resolve: (value: GitActionData) => void; reject: (error: Error) => void }[] = [];
  const client: ApiClient = { ...api, git: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) };
  const pr: GitPrSummary = { url: "https://github.com/o/r/pull/1", number: 1, state: "OPEN", title: "Fixture" };
  const render = async (observation: number) => act(async () => root.render(<ApiProvider client={client}><RequestDiff sessionId="s" pr={pr} online protocol={345} observation={observation} /></ApiProvider>));
  const snapshot = (headRef: string): GitActionData => ({ requestDiff: {
    requestUrl: pr.url, headRef, baseRef: "release", headOid: "a".repeat(40), baseOid: "b".repeat(40), targetOid: "c".repeat(40),
    readAt: 1, incomplete: false, diff: { scope: "all_branch", files: [], diffHash: "d".repeat(64), stats: { filesChanged: 0, insertions: 0, deletions: 0 } },
  } });
  try {
    await render(1);
    await act(async () => {
      const details = container.querySelector("details")!;
      details.open = true;
      details.dispatchEvent(new window.Event("toggle"));
    });
    assert.equal(pending.length, 1);
    await render(2);
    assert.equal(pending.length, 2);
    await act(async () => pending[1]!.resolve(snapshot("current-head")));
    await act(async () => pending[0]!.resolve(snapshot("stale-head")));
    assert.match(container.textContent!, /current-head/);
    assert.doesNotMatch(container.textContent!, /stale-head/);
    await act(async () => container.querySelector("button")!.click());
    assert.doesNotMatch(container.textContent!, /current-head/);
    await act(async () => pending[2]!.reject(new Error("changed")));
    assert.match(container.textContent!, /revisions changed while loading/);
    assert.doesNotMatch(container.textContent!, /current-head/);
  } finally {
    await act(async () => root.unmount());
    window.close();
    for (const name of Object.keys(globals)) {
      if (prior[name]) Object.defineProperty(globalThis, name, prior[name]!);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
