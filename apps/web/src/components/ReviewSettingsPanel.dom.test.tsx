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
import { assertNoDomNode } from "../dom-test-assertions.js";

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
    assertNoDomNode(container.querySelector(".save-bar"));
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
    assertNoDomNode(container.querySelector("input"));
    await act(async () => { fireDomEvent.click([...container.querySelectorAll("button")].find(b => b.textContent === "Try Again")!); });
    assert.equal(container.querySelector("input")?.value, "4");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("colliding reviewer model names remain distinguishable and save their exact IDs", async () => {
  const implementer = { agentId: "codex-app", driver: "codex-app-server" as const,
    context: { kind: "native" as const }, name: "Codex App Server" };
  const models = [
    { id: "opus", displayName: "Opus 5.5" },
    { id: "claude-opus-5-5", displayName: "Opus 5.5" },
    { id: "sonnet", displayName: "Sonnet" },
    { id: "custom-model" },
  ];
  let view: ReviewSettingsView = { ...structuredClone(initial), implementers: [implementer],
    reviewers: [{ harness: "claude-code", name: "Claude Code", runnerId: "machine", agentId: "claude-native",
      capabilities: { models, effortLevels: ["high"], slashCommands: [], supportsImages: true, supportsApprovals: true } }] };
  const saved: string[] = [];
  const client: ApiClient = { ...api, reviewSettings: async () => structuredClone(view),
    updateReviewSettings: async (_, settings) => {
      view = { ...view, settings: settings!, source: "user_default" };
      saved.push(settings!.reviewers[0]!.model!);
      return structuredClone(view);
    } };
  const container = dom.document.createElement("div") as unknown as HTMLDivElement;
  dom.document.body.append(container as never);
  const root = createRoot(container);
  const button = (label: string) => [...container.querySelectorAll("button")].find(b => b.textContent === label)!;
  try {
    await act(async () => root.render(<ApiProvider client={client}><FeedbackProvider><ReviewSettingsPanel /></FeedbackProvider></ApiProvider>));
    for (const id of ["opus", "claude-opus-5-5"]) {
      const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Reviewer Model:"]')!;
      await act(async () => { fireDomEvent.click(trigger); });
      const options = [...dom.document.querySelectorAll('[role="option"]')];
      const names = options.map(option => option.getAttribute("aria-labelledby")!.split(" ")
        .map(labelId => dom.document.getElementById(labelId)!.textContent).join(" "));
      assert.deepEqual(names, ["Automatic", "Opus 5.5 (opus)", "Opus 5.5 (claude-opus-5-5)", "Sonnet", "custom-model"]);
      const chosen = options[names.indexOf(`Opus 5.5 (${id})`)]!;
      assert.equal(chosen.textContent, `Opus 5.5 (${id})`, "visible text matches the accessible option name");
      await act(async () => { fireDomEvent.click(chosen as unknown as Element); });
      assert.equal(trigger.textContent, `Opus 5.5 (${id})`);
      await act(async () => { fireDomEvent.click(button("Save Defaults")); });
      assert.equal(saved.at(-1), id);
    }
    assert.deepEqual(saved, ["opus", "claude-opus-5-5"]);
    assert.equal(models[0]!.displayName, "Opus 5.5", "the catalog's ordinary model name is unchanged");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
