import "./test-dom-events.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { OrchestratorSettingsView } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ApiTransport } from "../api-transport.js";
import { OrchestratorSettingsPanel } from "./OrchestratorSettingsPanel.js";
import { fireDomEvent } from "./test-dom-events.js";

const domWindow = new Window({ url: "http://localhost/settings/orchestrator" });
const previous = new Map<string, unknown>();
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
};

before(() => {
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, (globalThis as Record<string, unknown>)[name]);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
after(() => {
  for (const [name, value] of previous) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});

function settings(drifted = false): OrchestratorSettingsView {
  return {
    source: "user_default",
    defaults: {
      behavior: {
        childModel: drifted ? "retired-model" : null,
        childEffort: null,
        maximumConcurrentChildren: 4,
        followUps: "recommend_only",
        completion: "retain",
      },
      delegation: {
        parentControl: "questions_and_approvals",
        decisions: {
          implementation_question: "human",
          pr_merge: "human",
          merged_branch_deletion: "human",
          follow_up_issue_publication: "human",
          ui_evidence_approval: "human",
        },
      },
      execution: { strictProjectIsolation: false },
    },
    capabilities: {
      models: [{ id: "sol", displayName: "Sol", efforts: ["high"] }],
      effortLevels: ["high"],
      supportedPairs: [{ modelId: "sol", effortLevels: ["high"] }],
      installations: 1,
      compatibleInstallations: drifted ? 0 : 1,
      status: drifted ? "unavailable" : "available",
      ...(drifted ? { reason: "The saved fixed child model is unavailable. Choose Automatic." } : {}),
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0)));
}

test("Orchestrator settings separate policy areas, validate accessibly, and persist a complete user default", async () => {
  let current = settings();
  const writes: unknown[] = [];
  const transport: ApiTransport = {
    instanceId: "test", publicOrigin: "http://localhost", close() {},
    async request(path, init) {
      assert.equal(path, "/api/orchestrator-settings");
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        current = { ...current, defaults: body.defaults };
      }
      return new Response(JSON.stringify(current), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ApiProvider client={createApiClient(transport)}><OrchestratorSettingsPanel /></ApiProvider>));
    await settle();
    assert.deepEqual([...container.querySelectorAll("h3")].map((node) => node.textContent),
      ["Behavior", "Execution Permissions", "Decision Delegation"]);
    assert.match(container.textContent ?? "", /Human-Only Decisions/);
    assert.equal(container.querySelectorAll('[aria-label*="Approval"]').length > 0, true);

    const limit = container.querySelector<HTMLInputElement>("#orchestrator-max-children")!;
    await act(async () => { fireDomEvent.change(limit, { target: { value: "65" } }); });
    assert.equal(limit.getAttribute("aria-invalid"), "true");
    assert.equal(container.querySelector('[role="alert"]')?.textContent, "Enter a whole number from 0 to 64.");
    assert.equal((container.querySelector("button.btn.primary") as HTMLButtonElement).disabled, true);

    await act(async () => { fireDomEvent.change(limit, { target: { value: "8" } }); });
    const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Save Defaults")!;
    await act(async () => save.click());
    await settle();
    assert.equal((writes[0] as { defaults: OrchestratorSettingsView["defaults"] }).defaults.behavior.maximumConcurrentChildren, 8);
    assert.equal(Object.keys((writes[0] as { defaults: OrchestratorSettingsView["defaults"] }).defaults.delegation.decisions).length, 5);
    assert.equal((writes[0] as { defaults: OrchestratorSettingsView["defaults"] }).defaults.execution.strictProjectIsolation, false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("Orchestrator settings preserve and explain a drifted saved model", async () => {
  const transport: ApiTransport = {
    instanceId: "test", publicOrigin: "http://localhost", close() {},
    async request() {
      return new Response(JSON.stringify(settings(true)), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ApiProvider client={createApiClient(transport)}><OrchestratorSettingsPanel /></ApiProvider>));
    await settle();
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="Child Model:"]')!;
    assert.match(trigger.getAttribute("aria-label") ?? "", /Retired-model \(Unavailable\)/i);
    assert.match(container.textContent ?? "", /not supported together by a current installation/i);
    assert.equal((container.querySelector("button.btn.primary") as HTMLButtonElement).disabled, true,
      "drifted fixed defaults cannot be resaved until the user repairs them");
    await act(async () => trigger.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never));
    assert.equal(trigger.getAttribute("aria-expanded"), "true", "the shared select remains keyboard operable in drift state");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("runner discovery refreshes capabilities without discarding unsaved defaults", async () => {
  let current = settings();
  const transport: ApiTransport = {
    instanceId: "test", publicOrigin: "http://localhost", close() {},
    async request() {
      return new Response(JSON.stringify(current), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ApiProvider client={createApiClient(transport)}>
      <OrchestratorSettingsPanel discoveryRevision={{ revision: 1 }} />
    </ApiProvider>));
    await settle();
    const limit = container.querySelector<HTMLInputElement>("#orchestrator-max-children")!;
    await act(async () => { fireDomEvent.change(limit, { target: { value: "8" } }); });
    current = { ...current, capabilities: { ...current.capabilities, installations: 2 } };
    await act(async () => root.render(<ApiProvider client={createApiClient(transport)}>
      <OrchestratorSettingsPanel discoveryRevision={{ revision: 2 }} />
    </ApiProvider>));
    await settle();
    assert.equal(container.querySelector<HTMLInputElement>("#orchestrator-max-children")?.value, "8");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
