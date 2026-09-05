import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  AutomationSchedule,
  AutomationSpec,
  RunnerView,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { AutomationsView } from "./AutomationsView.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const richCapabilities = {
  models: [
    { id: "opus", displayName: "Opus", efforts: ["low", "high"] },
    { id: "haiku", displayName: "Haiku", efforts: ["low"] },
  ],
  effortLevels: ["low", "high"],
  permissionModes: ["default", "auto"],
  slashCommands: [],
  supportsImages: true,
  supportsApprovals: true,
};

const otherCapabilities = {
  models: [{ id: "gpt", displayName: "GPT", efforts: ["medium"] }],
  effortLevels: ["medium"],
  permissionModes: ["default"],
  slashCommands: [],
  supportsImages: true,
  supportsApprovals: true,
};

function runner(
  runnerId: string,
  agents: RunnerView["agents"],
  workspaceId = `${runnerId}-workspace`,
): RunnerView {
  return {
    runnerId,
    hostname: runnerId,
    os: "linux",
    version: "1",
    status: "online",
    agents,
    workspaces: [{ id: workspaceId, name: workspaceId, path: `/repos/${workspaceId}` }],
    connectedAt: 1,
    lastSeen: 1,
    protocolVersion: 90,
  };
}

const runners: RunnerView[] = [
  runner("runner-1", [
    {
      id: "rich-agent", name: "Rich Agent", command: "rich", args: [], env: {},
      driver: "claude-code", available: true, capabilities: richCapabilities,
    },
    {
      id: "other-agent", name: "Other Agent", command: "other", args: [], env: {},
      driver: "codex-app-server", available: true, capabilities: otherCapabilities,
    },
    {
      id: "plain-agent", name: "Plain Agent", command: "plain", args: [], env: {},
      driver: "acp", available: true,
    },
  ]),
  runner("runner-2", [{
    id: "alternate-agent", name: "Alternate Agent", command: "alternate", args: [], env: {},
    driver: "claude-code", available: true, capabilities: richCapabilities,
  }]),
  runner("runner-3", [{
    id: "third-agent", name: "Third Agent", command: "third", args: [], env: {},
    driver: "claude-code", available: true, capabilities: richCapabilities,
  }]),
];

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const navigation: ViewNavigation = {
  current: () => ({ name: "automations" }),
  push() {},
  listen: () => () => {},
};

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: false,
    },
    runners,
    boxes: [],
    sessions: [],
    runs: [],
    pods: [],
  };
}

function AutomationsWhenReady() {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  return ready ? <AutomationsView /> : null;
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  updates: Array<{ id: string; spec: AutomationSpec }>;
}

let fixtureSequence = 0;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.resolve();
}

async function mountFixture(items: AutomationSchedule[] = []): Promise<Fixture> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const updates: Array<{ id: string; spec: AutomationSpec }> = [];
  fixtureSequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `automations-${fixtureSequence}`,
    runtimeKey: `automations-${fixtureSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const client = {
    ...api,
    automations: async () => ({ automations: items }),
    automation: async (id: string) => ({
      automation: items.find((item) => item.automationId === id)!,
      executions: [],
      events: [],
    }),
    automationTriggers: async () => ({ triggers: [] }),
    workflowDefinitions: async () => [],
    updateAutomation: async (id: string, spec: AutomationSpec) => {
      updates.push({ id, spec: structuredClone(spec) });
      return { ...items.find((item) => item.automationId === id)!, ...spec };
    },
  } as unknown as ApiClient;

  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <AutomationsWhenReady />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => { socket.push(snapshot()); });
  await act(settle);
  return { container, root, updates };
}

async function unmountFixture(fixture: Fixture): Promise<void> {
  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
}

function button(container: HTMLDivElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(found, `${label} button is rendered`);
  return found;
}

function nativeSelect(container: HTMLDivElement, label: string): HTMLSelectElement {
  const wrapper = [...container.querySelectorAll<HTMLLabelElement>("label")]
    .find((candidate) => candidate.childNodes[0]?.textContent?.trim() === label);
  const select = wrapper?.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, `${label} select is rendered`);
  return select;
}

async function changeNativeSelect(container: HTMLDivElement, label: string, value: string): Promise<void> {
  const select = nativeSelect(container, label);
  const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLSelectElement.prototype, "value")?.set;
  assert.ok(setter);
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new domWindow.Event("change", { bubbles: true }) as never);
  });
}

function choiceTrigger(container: HTMLDivElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]')]
    .find((candidate) => candidate.getAttribute("aria-label")?.startsWith(`${label}:`));
}

async function choose(container: HTMLDivElement, label: string, optionLabel: string): Promise<void> {
  const trigger = choiceTrigger(container, label);
  assert.ok(trigger, `${label} choice is rendered`);
  await act(async () => { trigger.click(); });
  const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
  const option = options
    .find((candidate) => candidate.textContent?.trim() === optionLabel);
  assert.ok(option, `${optionLabel} option is rendered; found ${options.map((item) => item.textContent?.trim()).join(", ")}`);
  await act(async () => { option.click(); });
  await act(settle);
}

async function openNew(fixture: Fixture): Promise<void> {
  await act(async () => { button(fixture.container, "New Automation").click(); });
  await act(settle);
}

test("Agent, Machine, and Model controls invoke their capability-transition helpers", async () => {
  const fixture = await mountFixture();
  try {
    await openNew(fixture);
    await choose(fixture.container, "Model", "Opus");
    await choose(fixture.container, "Reasoning Effort", "High");
    await choose(fixture.container, "Permission Mode", "Auto");

    await changeNativeSelect(fixture.container, "Agent", "other-agent");
    assert.equal(choiceTrigger(fixture.container, "Model")?.getAttribute("aria-label"), "Model: Agent Default");
    assert.equal(choiceTrigger(fixture.container, "Reasoning Effort")?.getAttribute("aria-label"), "Reasoning Effort: Agent Default");
    assert.equal(choiceTrigger(fixture.container, "Permission Mode")?.getAttribute("aria-label"), "Permission Mode: Agent Default");

    await choose(fixture.container, "Model", "GPT");
    await choose(fixture.container, "Reasoning Effort", "Medium");
    await changeNativeSelect(fixture.container, "Machine", "runner-2");
    assert.equal(choiceTrigger(fixture.container, "Model")?.getAttribute("aria-label"), "Model: Agent Default");
    assert.equal(choiceTrigger(fixture.container, "Reasoning Effort")?.getAttribute("aria-label"), "Reasoning Effort: Agent Default");

    await changeNativeSelect(fixture.container, "Machine", "runner-1");
    await choose(fixture.container, "Model", "Opus");
    await choose(fixture.container, "Reasoning Effort", "High");
    await choose(fixture.container, "Permission Mode", "Auto");
    await choose(fixture.container, "Model", "Haiku");
    assert.equal(choiceTrigger(fixture.container, "Reasoning Effort")?.getAttribute("aria-label"), "Reasoning Effort: Agent Default");
    assert.equal(choiceTrigger(fixture.container, "Permission Mode")?.getAttribute("aria-label"), "Permission Mode: Auto");
  } finally {
    await unmountFixture(fixture);
  }
});

test("capability controls render only for create-session actions with advertised values", async () => {
  const fixture = await mountFixture();
  try {
    await openNew(fixture);
    assert.ok(choiceTrigger(fixture.container, "Model"));
    assert.ok(choiceTrigger(fixture.container, "Reasoning Effort"));
    assert.ok(choiceTrigger(fixture.container, "Permission Mode"));

    await changeNativeSelect(fixture.container, "Action", "prompt_session");
    assert.equal(choiceTrigger(fixture.container, "Model"), undefined);
    assert.equal(choiceTrigger(fixture.container, "Reasoning Effort"), undefined);
    assert.equal(choiceTrigger(fixture.container, "Permission Mode"), undefined);

    await changeNativeSelect(fixture.container, "Action", "create_session");
    await changeNativeSelect(fixture.container, "Agent", "plain-agent");
    assert.equal(choiceTrigger(fixture.container, "Model"), undefined);
    assert.equal(choiceTrigger(fixture.container, "Reasoning Effort"), undefined);
    assert.equal(choiceTrigger(fixture.container, "Permission Mode"), undefined);
  } finally {
    await unmountFixture(fixture);
  }
});

test("editing and saving without changes sends the exact stored multi-alternate spec", async () => {
  const stored: AutomationSchedule = {
    automationId: "automation-1",
    revision: 1,
    name: "Nightly Sweep",
    cron: "0 2 * * *",
    timezone: "America/Chicago",
    enabled: true,
    action: {
      kind: "create_session",
      request: {
        runnerId: "runner-1", workspaceId: "runner-1-workspace", agentId: "rich-agent",
        prompt: "Sweep.", useWorktree: false,
        config: { model: "opus", effort: "high", permissionMode: "auto" },
      },
    },
    misfirePolicy: { kind: "skip" },
    runnerPolicy: {
      kind: "alternate",
      targets: [
        { runnerId: "runner-2", workspaceId: "runner-2-workspace", agentId: "alternate-agent" },
        { runnerId: "runner-3", workspaceId: "runner-3-workspace", agentId: "third-agent" },
      ],
      expireAfterMinutes: 60,
    },
    concurrencyPolicy: "wait",
    limits: { maxCostUsd: 5, maxToolCalls: 50 },
    notifications: { pushEvents: ["failed", "expired"] },
    createdBy: { kind: "human", id: "test" },
    createdAt: 1,
    updatedAt: 1,
  };
  const fixture = await mountFixture([stored]);
  try {
    await act(async () => { button(fixture.container, "Edit").click(); });
    const nameInput = [...fixture.container.querySelectorAll<HTMLLabelElement>("label")]
      .find((candidate) => candidate.childNodes[0]?.textContent?.trim() === "Name")
      ?.querySelector("input") as HTMLInputElement | null;
    assert.equal(nameInput?.value, "Nightly Sweep");
    assert.equal(nativeSelect(fixture.container, "Machine").value, "runner-1");
    assert.equal(nativeSelect(fixture.container, "Agent").value, "rich-agent");
    assert.equal(choiceTrigger(fixture.container, "Model")?.getAttribute("aria-label"), "Model: Opus");
    assert.equal(choiceTrigger(fixture.container, "Reasoning Effort")?.getAttribute("aria-label"), "Reasoning Effort: High");
    assert.equal(choiceTrigger(fixture.container, "Permission Mode")?.getAttribute("aria-label"), "Permission Mode: Auto");
    assert.equal(
      [...nativeSelect(fixture.container, "Machine").options].find((option) => option.value === "runner-3")?.disabled,
      true,
    );
    assert.deepEqual(
      [...nativeSelect(fixture.container, "Alternate Machine").options].map((option) => option.value),
      ["", "runner-2"],
    );
    assert.match(fixture.container.textContent ?? "", /Additional stored alternate machines are preserved: runner-3\./);

    await changeNativeSelect(fixture.container, "Runner Availability", "wait");
    assert.equal(
      [...nativeSelect(fixture.container, "Machine").options].find((option) => option.value === "runner-3")?.disabled,
      false,
    );
    await changeNativeSelect(fixture.container, "Runner Availability", "alternate");

    await act(async () => { button(fixture.container, "Save Automation").click(); });
    await act(settle);
    assert.equal(fixture.updates.length, 1);
    const { automationId: _id, revision: _revision, createdBy: _createdBy,
      createdAt: _createdAt, updatedAt: _updatedAt, ...storedSpec } = stored;
    assert.deepEqual(fixture.updates[0], { id: stored.automationId, spec: storedSpec });
  } finally {
    await unmountFixture(fixture);
  }
});
