import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { DEFAULT_REVIEW_SETTINGS, type ReviewSettingsView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { ReviewSettingsPanel } from "./ReviewSettingsPanel.js";

const dom = new Window({ url: "http://localhost/settings/reviews" });
for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element, Node: dom.Node, Event: dom.Event, MouseEvent: dom.MouseEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom), React, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const initial: ReviewSettingsView = { settings: DEFAULT_REVIEW_SETTINGS, source: "system_default", projectId: null,
  projects: [], implementers: [], reviewers: [] };

test("invalid budgets block writes, failed saves retain the draft, and a retry renders the saved response", async () => {
  let attempts = 0;
  const client: ApiClient = { ...api, reviewSettings: async () => structuredClone(initial),
    updateReviewSettings: async (_, settings) => {
      attempts++;
      if (attempts === 1) throw new Error("Could not save review settings.");
      return { ...initial, settings: settings!, source: "user_default" };
    } };
  const container = dom.document.createElement("div") as unknown as HTMLDivElement;
  dom.document.body.append(container as never);
  const root = createRoot(container);
  const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent === label)!;
  try {
    await act(async () => root.render(<ApiProvider client={client}><FeedbackProvider><ReviewSettingsPanel /></FeedbackProvider></ApiProvider>));
    const input = container.querySelector("input")!;
    assert.equal(input.value, "4");
    await act(async () => { fireDomEvent.change(input, { target: { value: "0" } }); });
    assert.equal(button("Save Defaults").getAttribute("aria-disabled"), "true");
    await act(async () => { fireDomEvent.click(button("Save Defaults")); });
    assert.equal(attempts, 0);
    await act(async () => { fireDomEvent.change(input, { target: { value: "6" } }); });
    await act(async () => { fireDomEvent.click(button("Save Defaults")); });
    assert.equal(input.value, "6");
    assert.match(container.textContent!, /Could not save review settings/u);
    await act(async () => { fireDomEvent.click(button("Try Again")); });
    assert.equal(attempts, 2);
    assert.equal(container.querySelector(".save-bar"), null);
    assert.equal(input.value, "6");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("a failed read shows an actionable retry and recovers without mounting stale settings", async () => {
  let reads = 0;
  const client: ApiClient = { ...api, reviewSettings: async () => { if (++reads === 1) throw new Error("Machine unavailable."); return structuredClone(initial); } };
  const container = dom.document.createElement("div") as unknown as HTMLDivElement;
  dom.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ApiProvider client={client}><FeedbackProvider><ReviewSettingsPanel /></FeedbackProvider></ApiProvider>));
    assert.match(container.textContent!, /Reviews Unavailable/u);
    assert.equal(container.querySelector("input"), null);
    await act(async () => { fireDomEvent.click([...container.querySelectorAll("button")].find(b => b.textContent === "Try Again")!); });
    assert.equal(container.querySelector("input")?.value, "4");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
