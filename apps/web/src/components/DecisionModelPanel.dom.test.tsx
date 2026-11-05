import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type { DecisionModelSettingsView, DecisionModelTestResult } from "@wollipog/protocol";
import { createApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ApiTransport } from "../api-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { DecisionModelPanel } from "./DecisionModelPanel.js";

const domWindow = new Window({ url: "http://localhost/settings/orchestrator" });
const previous = new Map<string, unknown>();
const globals = {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Element: domWindow.Element,
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

const MACHINES: DecisionModelSettingsView["machines"] = [{
  runnerId: "runner-studio",
  machineName: "Studio Workstation",
  harnesses: [{
    agentId: "claude-code",
    name: "Claude Code",
    driver: "claude-code",
    provider: "claude",
    billingSource: "subscription",
    models: [{ id: "haiku", displayName: "Haiku", efforts: ["low", "medium"] }],
  }],
}];

function view(overrides: Partial<DecisionModelSettingsView> = {}): DecisionModelSettingsView {
  return { source: "automatic", canManage: true, machines: MACHINES, automaticPreference: ["haiku"], ...overrides };
}

const CHOSEN: DecisionModelSettingsView = view({
  source: "organization",
  target: {
    runnerId: "runner-studio", machineName: "Studio Workstation", agentId: "claude-code", harnessName: "Claude Code",
    driver: "claude-code", context: { kind: "native" }, provider: "claude", billingSource: "subscription",
    model: "haiku", modelName: "Haiku", effort: "low", available: true,
  },
});

const TEST_RESULT: DecisionModelTestResult = {
  latencyMs: 3_200,
  occurrence: {
    occurrenceId: "dec_1", kind: "probe", promptVersion: "probe.v1", state: "decided", verdict: "confirm",
    reason: "Listed.", inputDigests: {}, attempts: [{ attempt: 1, latencyMs: 3_100 }],
    usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: null },
    createdAt: 1,
    target: {
      source: "automatic", runnerId: "runner-studio", machineName: "Studio Workstation", agentId: "claude-code",
      harnessName: "Claude Code", driver: "claude-code", provider: "claude", model: "haiku", effort: "low",
    },
  },
};

type Call = { path: string; method: string; body?: Record<string, unknown> };

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function recording(respond: (call: Call) => Response): { transport: ApiTransport; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    transport: {
      instanceId: "test",
      publicOrigin: "http://localhost",
      close() {},
      async request(path, init) {
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
        const call = { path, method, ...(body ? { body } : {}) };
        calls.push(call);
        return respond(call);
      },
    },
  };
}

async function render(transport: ApiTransport): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ApiProvider client={createApiClient(transport)}>
        <FeedbackProvider><DecisionModelPanel /></FeedbackProvider>
      </ApiProvider>,
    );
  });
  return { container, root };
}

async function cleanup({ container, root }: { container: HTMLElement; root: Root }) {
  await act(async () => root.unmount());
  container.remove();
}

const body = () => domWindow.document.body as unknown as HTMLElement;
const settle = () => act(async () => new Promise<void>((resolve) => domWindow.setTimeout(resolve, 0)));

function button(scope: HTMLElement, name: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim() === name);
  assert.ok(found, `expected button named ${name}`);
  return found;
}

async function selectOption(scope: HTMLElement, label: string, option: string): Promise<void> {
  const trigger = scope.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`);
  assert.ok(trigger, `expected ${label} select`);
  await act(async () => trigger.click());
  const choice = [...body().querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) =>
    (candidate.textContent ?? "").startsWith(option));
  assert.ok(choice, `expected ${option} option in ${label}`);
  await act(async () => choice.click());
  await settle();
}

test("the group is labeled for the organization and states the provider boundary", async () => {
  const { transport } = recording(() => json(view()));
  const mounted = await render(transport);
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes("Decision Model"));
    assert.ok(text.includes("This Organization"));
    assert.ok(text.includes("Model Source"));
    assert.ok(text.includes("Each campaign uses its own agent"));
    assert.ok(text.includes("to the selected agent's provider"));
    assert.ok(text.includes("Test Decision Model"));
  } finally {
    await cleanup(mounted);
  }
});

test("a member who is not an administrator reads the setting but cannot change or test it", async () => {
  const { transport, calls } = recording(() => json({ ...CHOSEN, canManage: false }));
  const mounted = await render(transport);
  try {
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes("Claude Code on Studio Workstation"));
    assert.ok(text.includes("Only an organization owner or admin can change this."));
    assert.equal(button(mounted.container, "Run Test").disabled, true);
    assert.equal(button(mounted.container, "Edit…").disabled, true);
    // The source cannot be changed: opening the list offers no other choice.
    const trigger = mounted.container.querySelector<HTMLButtonElement>('[aria-label^="Model Source:"]');
    assert.ok(trigger);
    await act(async () => trigger.click());
    const choosable = [...body().querySelectorAll<HTMLElement>('[role="option"]')]
      .filter((option) => option.getAttribute("aria-disabled") !== "true" && !(option.textContent ?? "").startsWith("Chosen Agent"));
    assert.deepEqual(choosable, []);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ["GET /api/decision-model"]);
  } finally {
    await cleanup(mounted);
  }
});

test("an administrator chooses an agent in the dialog, and Automatic saves at once", async () => {
  let current = view();
  const { transport, calls } = recording((call) => {
    if (call.method === "PUT") current = CHOSEN;
    if (call.method === "DELETE") current = view();
    return json(current);
  });
  const mounted = await render(transport);
  try {
    await selectOption(mounted.container, "Model Source", "Chosen Agent");
    const dialog = body().querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog?.textContent?.includes("Agent for Decisions"));
    // One machine with one agent preselects both; the model and effort are chosen.
    await selectOption(dialog!, "Model", "Haiku");
    await selectOption(dialog!, "Reasoning Effort", "Low");
    await act(async () => button(dialog!, "Save").click());
    await settle();
    const put = calls.find((call) => call.method === "PUT");
    assert.deepEqual(put?.body, {
      runnerId: "runner-studio", agentId: "claude-code", driver: "claude-code", model: "haiku", effort: "low",
    });
    assert.ok((mounted.container.textContent ?? "").includes("Claude Code on Studio Workstation"));
    assert.equal(body().querySelector('[role="dialog"]'), null);

    await selectOption(mounted.container, "Model Source", "Automatic");
    assert.ok(calls.some((call) => call.method === "DELETE" && call.path === "/api/decision-model"));
    assert.equal((mounted.container.textContent ?? "").includes("Claude Code on Studio Workstation"), false);
  } finally {
    await cleanup(mounted);
  }
});

test("Test Decision Model reports the verdict, latency and attempts", async () => {
  const { transport, calls } = recording((call) => call.path === "/api/decision-model/test" ? json(TEST_RESULT) : json(view()));
  const mounted = await render(transport);
  try {
    await act(async () => button(mounted.container, "Run Test").click());
    await settle();
    assert.ok(calls.some((call) => call.method === "POST" && call.path === "/api/decision-model/test"));
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes("Verdict: Confirm."), text);
    assert.ok(text.includes("3.2 s, 1 attempt on Claude Code (haiku, Low effort)."), text);
  } finally {
    await cleanup(mounted);
  }
});

test("a failed test says no verdict was reached and that a campaign would ask its owner", async () => {
  const failed: DecisionModelTestResult = {
    latencyMs: 61_000,
    occurrence: {
      ...TEST_RESULT.occurrence, state: "failed", failureClass: "rate_limited",
      attempts: [{ attempt: 1, errorClass: "rate_limited", latencyMs: 1 }, { attempt: 2, errorClass: "rate_limited", latencyMs: 1 }],
    },
  };
  delete (failed.occurrence as { verdict?: string }).verdict;
  const { transport } = recording((call) => call.path === "/api/decision-model/test" ? json(failed) : json(view()));
  const mounted = await render(transport);
  try {
    await act(async () => button(mounted.container, "Run Test").click());
    await settle();
    const text = mounted.container.textContent ?? "";
    assert.ok(text.includes("No verdict: the provider asked to slow down. A campaign would ask its owner instead."), text);
    assert.ok(text.includes("61 s, 2 attempts"), text);
  } finally {
    await cleanup(mounted);
  }
});
