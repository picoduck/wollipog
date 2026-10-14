import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  AutomationExecution,
  AutomationSchedule,
  AutomationSpec,
  AutomationTriggerView,
  CreateAutomationTriggerRequest,
  CreateOutboundEventSubscriptionRequest,
  OutboundEventDeliveryView,
  OutboundEventSubscriptionView,
  RunnerView,
  UiSnapshotMessage,
  WorkflowDefinition,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { AutomationsView } from "./AutomationsView.js";
import { agentOptions } from "./agent-options.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { withScopedClockOverrides } from "./test-clock-overrides.js";

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
  InputEvent: domWindow.InputEvent,
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

function snapshot(runnerViews = runners): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: false,
    },
    runners: runnerViews,
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
  triggerCreates: Array<{ id: string; request: CreateAutomationTriggerRequest }>;
  outboundCreates: CreateOutboundEventSubscriptionRequest[];
  replaceClient: (overrides: Partial<ApiClient>) => Promise<void>;
}

let fixtureSequence = 0;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.resolve();
}

async function mountFixture(
  items: AutomationSchedule[] = [],
  executions: Record<string, AutomationExecution[]> = {},
  triggerViews: Record<string, AutomationTriggerView[]> = {},
  outboundSubscriptions: OutboundEventSubscriptionView[] = [],
  outboundDeliveries: Record<string, OutboundEventDeliveryView[]> = {},
  runnerViews: RunnerView[] = runners,
  workflowViews: WorkflowDefinition[] = [],
  clientOverrides: Partial<ApiClient> = {},
): Promise<Fixture> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const updates: Array<{ id: string; spec: AutomationSpec }> = [];
  const triggerCreates: Array<{ id: string; request: CreateAutomationTriggerRequest }> = [];
  const outboundCreates: CreateOutboundEventSubscriptionRequest[] = [];
  fixtureSequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `automations-${fixtureSequence}`,
    runtimeKey: `automations-${fixtureSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  let client = {
    ...api,
    // A NEW array on every poll, exactly like the control plane's response. Returning the same
    // reference would let expansion state survive for the wrong reason and pass a test the real
    // app fails; the caller mutates `items` in place to simulate creations and deletions.
    automations: async () => ({ automations: [...items] }),
    automation: async (id: string) => ({
      automation: items.find((item) => item.automationId === id)!,
      executions: executions[id] ?? [],
      events: [],
    }),
    automationTriggers: async (id: string) => ({ triggers: triggerViews[id] ?? [] }),
    createAutomationTrigger: async (id: string, request: CreateAutomationTriggerRequest) => {
      triggerCreates.push({ id, request: structuredClone(request) });
      const trigger: AutomationTriggerView = {
        triggerId: "atr_created", automationId: id, kind: request.kind, name: request.name,
        generation: 1, createdBy: { kind: "human", id: "test" }, createdAt: 1, updatedAt: 1,
        invocationCount: 0, ...(request.deliveryPolicy ? { deliveryPolicy: request.deliveryPolicy } : {}),
      };
      triggerViews[id] = [...(triggerViews[id] ?? []), trigger];
      return { trigger, secret: `wollipogwhsec_${"A".repeat(43)}` };
    },
    workflowDefinitions: async () => workflowViews,
    outboundEventSubscriptions: async () => [...outboundSubscriptions],
    outboundEventDeliveries: async (subscriptionId: string) => outboundDeliveries[subscriptionId] ?? [],
    createOutboundEventSubscription: async (request: CreateOutboundEventSubscriptionRequest) => {
      outboundCreates.push(structuredClone(request));
      const subscription: OutboundEventSubscriptionView = {
        subscriptionId: "oes_created",
        callbackUrl: request.callbackUrl,
        scope: request.scope,
        eventKinds: request.eventKinds,
        includeSessionName: request.includeSessionName === true,
        includeQuestionTitle: request.includeQuestionTitle === true,
        state: "active",
        generation: 1,
        createdBy: { kind: "human", id: "test" },
        createdAt: 1,
        updatedAt: 1,
      };
      outboundSubscriptions.push(subscription);
      return { subscription, secret: `wollipogwhsec_${"B".repeat(43)}` };
    },
    updateAutomation: async (id: string, spec: AutomationSpec) => {
      updates.push({ id, spec: structuredClone(spec) });
      return { ...items.find((item) => item.automationId === id)!, ...spec };
    },
    ...clientOverrides,
  } as unknown as ApiClient;

  const render = () => root.render(
    <ApiProvider client={client}>
      <StoreProvider connection={connection} navigation={navigation}>
        <AutomationsWhenReady />
      </StoreProvider>
    </ApiProvider>,
  );
  await act(async () => { render(); });
  await act(async () => { socket.push(snapshot(runnerViews)); });
  await act(settle);
  return {
    container, root, updates, triggerCreates, outboundCreates,
    replaceClient: async (overrides) => {
      client = { ...client, ...overrides };
      await act(async () => { render(); });
      await act(settle);
    },
  };
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

async function setLabeledInput(container: HTMLDivElement, label: string, value: string): Promise<void> {
  const wrapper = [...container.querySelectorAll<HTMLLabelElement>("label")]
    .find((candidate) => candidate.childNodes[0]?.textContent?.trim() === label);
  const input = wrapper?.querySelector("input") as HTMLInputElement | null;
  assert.ok(input, `${label} input is rendered`);
  const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")?.set;
  assert.ok(setter);
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true, data: value }) as never);
  });
}

function cardToggle(container: HTMLDivElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>(".automation-card-toggle")]
    .find((candidate) => candidate.querySelector(".automation-card-name")?.textContent === name);
  assert.ok(found, `${name} automation card is rendered`);
  return found;
}

async function expandCard(fixture: Fixture, name: string): Promise<void> {
  await act(async () => { cardToggle(fixture.container, name).click(); });
  await act(settle);
}

function maybeCardToggle(container: HTMLDivElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>(".automation-card-toggle")]
    .find((candidate) => candidate.querySelector(".automation-card-name")?.textContent === name);
}

function expansionOf(container: HTMLDivElement, name: string): string | null {
  return cardToggle(container, name).getAttribute("aria-expanded");
}

/** Anything a keyboard or screen reader can land on inside the rendered cards. */
function focusableInCards(container: HTMLDivElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(
    ".automation-card button, .automation-card a, .automation-card input, .automation-card select,"
    + " .automation-card textarea, .automation-card summary, .automation-card [tabindex]",
  )];
}

function schedule(automationId: string, name: string, enabled = true): AutomationSchedule {
  return {
    automationId,
    revision: 1,
    name,
    cron: "0 2 * * *",
    timezone: "America/Chicago",
    enabled,
    action: {
      kind: "create_session",
      request: {
        runnerId: "runner-1", workspaceId: "runner-1-workspace", agentId: "rich-agent",
        prompt: "Sweep.", useWorktree: false,
      },
    },
    misfirePolicy: { kind: "skip" },
    runnerPolicy: { kind: "wait" },
    concurrencyPolicy: "wait",
    limits: { maxCostUsd: 5, maxToolCalls: 50 },
    notifications: { pushEvents: [] },
    createdBy: { kind: "human", id: "test" },
    createdAt: 1,
    updatedAt: 1,
  };
}

/**
 * Waits for one real five-second poll of the automation list to commit. The interval is the
 * behaviour under test — expansion has to survive the refresh the running app actually performs,
 * not a hand-called refresh helper — so the wait is real rather than faked.
 */
async function awaitPoll(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5_400)); });
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

test("outbound event subscriptions expose privacy opt-ins and reveal the signing secret once", async () => {
  const automation = schedule("automation-events", "Event Source");
  const fixture = await mountFixture([automation]);
  try {
    await act(async () => { button(fixture.container, "New Subscription").click(); });
    await choose(fixture.container, "Scope Type", "Automation");
    await setLabeledInput(fixture.container, "Callback URL", "https://events.example.test/wollipog");
    const sessionName = [...fixture.container.querySelectorAll<HTMLLabelElement>("label")]
      .find((candidate) => candidate.textContent?.trim() === "Include Session Name")
      ?.querySelector("input") as HTMLInputElement | null;
    const questionTitle = [...fixture.container.querySelectorAll<HTMLLabelElement>("label")]
      .find((candidate) => candidate.textContent?.trim() === "Include Question Title")
      ?.querySelector("input") as HTMLInputElement | null;
    assert.ok(sessionName && questionTitle);
    await act(async () => {
      sessionName.click();
      questionTitle.click();
    });
    await act(async () => { button(fixture.container, "Create Subscription").click(); });
    await act(settle);
    assert.deepEqual(fixture.outboundCreates, [{
      callbackUrl: "https://events.example.test/wollipog",
      scope: { kind: "automation", automationId: "automation-events" },
      eventKinds: ["session.created", "session.input_required"],
      includeSessionName: true,
      includeQuestionTitle: true,
    }]);
    assert.match(fixture.container.textContent ?? "", /Copy this signing secret now/);
    assert.match(fixture.container.textContent ?? "", /wollipogwhsec_B+/);
    assert.match(fixture.container.textContent ?? "", /Session Name Included/);
    assert.match(fixture.container.textContent ?? "", /Question Title Included/);
    await act(async () => { button(fixture.container, "Hide").click(); });
    assert.doesNotMatch(fixture.container.textContent ?? "", /wollipogwhsec_B+/);
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
    await expandCard(fixture, "Nightly Sweep");
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

test("an unavailable automation installation stays visible until explicitly rebound", async () => {
  const machine = { ...runners[0]!, protocolVersion: 175, agents: [{
    ...runners[0]!.agents[0]!, id: "rich-agent", installation: {
      id: "local", path: "/home/u/.local/bin/claude", via: "common-dir" as const,
      selection: "selected" as const,
    },
  }] };
  const stored: AutomationSchedule = {
    automationId: "saved-installation", revision: 1, name: "Pinned Sweep",
    cron: "0 2 * * *", timezone: "UTC", enabled: true,
    action: { kind: "create_session", request: {
      runnerId: "runner-1", workspaceId: "runner-1-workspace", agentId: "rich-agent", prompt: "Sweep",
    }, installationBindings: { agent: {
      driver: "claude-code", context: { kind: "native" }, installationId: "system",
    } } },
    runnerPolicy: { kind: "wait" }, misfirePolicy: { kind: "skip" },
    concurrencyPolicy: "wait", limits: { maxCostUsd: 5, maxToolCalls: 50 },
    notifications: { pushEvents: [] }, createdBy: { kind: "human", id: "test" },
    createdAt: 1, updatedAt: 1,
  };
  const fixture = await mountFixture([stored], {}, {}, [], {}, [machine]);
  try {
    await expandCard(fixture, "Pinned Sweep");
    assert.match(fixture.container.textContent ?? "", /Saved Agent Harness installation unavailable/);
    await act(async () => { button(fixture.container, "Edit").click(); });
    await act(async () => { button(fixture.container, "Use Current Installation").click(); });
    await act(async () => { button(fixture.container, "Save Automation").click(); });
    await act(settle);
    const action = fixture.updates[0]?.spec.action;
    assert.equal(action?.kind === "create_session" &&
      action.installationBindings?.agent?.installationId, "local");
  } finally {
    await unmountFixture(fixture);
  }
});

test("editing a pinned automation shows its rediscovered installation instead of a reused id", async () => {
  const oldId = { ...runners[0]!.agents[0]!, id: "rich-agent", driver: "acp" as const,
    installation: undefined };
  const selected = { ...runners[0]!.agents[0]!, id: "system-new", installation: {
    id: "system", path: "/usr/bin/claude", via: "path" as const,
    selection: "selected" as const,
  } };
  const manual = { ...runners[0]!.agents[0]!, id: "manual", driver: "acp" as const,
    installation: undefined };
  const machine = { ...runners[0]!, protocolVersion: 175, agents: [oldId, selected, manual] };
  const stored = schedule("pinned", "Pinned Sweep");
  stored.action = { kind: "create_session", request: {
    runnerId: "runner-1", workspaceId: "runner-1-workspace", agentId: "rich-agent", prompt: "Sweep",
  }, installationBindings: { agent: {
    driver: "claude-code", context: { kind: "native" }, installationId: "system",
  } } };
  const fixture = await mountFixture([stored], {}, {}, [], {}, [machine]);
  try {
    await expandCard(fixture, "Pinned Sweep");
    await act(async () => { button(fixture.container, "Edit").click(); });
    assert.equal(nativeSelect(fixture.container, "Agent").value, "system-new");
    await act(async () => { button(fixture.container, "Save Automation").click(); });
    await act(settle);
    const action = fixture.updates[0]?.spec.action;
    assert.equal(action?.kind === "create_session" && action.request.agentId, "system-new");
    assert.equal(action?.kind === "create_session" &&
      action.installationBindings?.agent?.installationId, "system");
    await act(async () => { button(fixture.container, "Edit").click(); });
    await changeNativeSelect(fixture.container, "Agent", "manual");
    await act(async () => { button(fixture.container, "Save Automation").click(); });
    await act(settle);
    assert.equal(fixture.updates[1]?.spec.action.kind === "create_session" &&
      fixture.updates[1].spec.action.request.agentId, "manual",
    "switching to a config-authored agent clears the automatic installation rebind");
    await act(async () => { button(fixture.container, "Edit").click(); });
    await changeNativeSelect(fixture.container, "Agent", "rich-agent");
    await act(async () => { button(fixture.container, "Save Automation").click(); });
    await act(settle);
    const reselected = fixture.updates[2]?.spec.action;
    assert.equal(reselected?.kind === "create_session" && reselected.request.agentId, "rich-agent");
    assert.deepEqual(reselected?.kind === "create_session" && reselected.installationBindings, {},
      "explicitly choosing a reused plain id clears the old installation reference");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a workflow role named orchestrator keeps a role binding separate from its orchestrator", async () => {
  const manual = { ...runners[0]!.agents[0]!, id: "manual", driver: "acp" as const,
    installation: undefined };
  const machine = { ...runners[0]!, protocolVersion: 175, agents: [{
    ...runners[0]!.agents[0]!, id: "orchestrator", installation: {
      id: "system", path: "/usr/bin/claude", via: "path" as const,
      selection: "selected" as const,
    },
  }, manual] };
  const stored = schedule("role-orchestrator", "Workflow Sweep");
  stored.action = { kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "runner-1-workspace", workflowId: "graph-1", task: "Build",
  } };
  const workflow: WorkflowDefinition = {
    workflowId: "graph-1", version: 1, name: "Graph", source: "custom",
    maxTransitions: 1, createdBy: { kind: "human", id: "test" }, createdAt: 1, edges: [],
    nodes: [{ nodeId: "worker", kind: "agent", role: "worker", agentId: "orchestrator",
      inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 }],
  };
  const fixture = await mountFixture([stored], {}, {}, [], {}, [machine], [workflow]);
  try {
    await expandCard(fixture, "Workflow Sweep");
    await act(async () => { button(fixture.container, "Edit").click(); });
    await act(async () => { button(fixture.container, "Use Current Installation").click(); });
    await act(async () => { button(fixture.container, "Save Automation").click(); });
    await act(settle);
    const action = fixture.updates[0]?.spec.action;
    assert.equal(action?.kind === "workflow_run" && action.request.agentBindings?.orchestrator, "orchestrator");
    assert.equal(action?.kind === "workflow_run" && action.request.orchestratorAgentId, undefined);
    assert.equal(action?.kind === "workflow_run" &&
      action.installationBindings?.["role:orchestrator"]?.installationId, "system");
    await act(async () => { button(fixture.container, "Edit").click(); });
    await choose(fixture.container, "Orchestrator Agent",
      agentOptions(machine.agents).find((option) => option.agent.id === "manual")!.label);
    await act(async () => { button(fixture.container, "Save Automation").click(); });
    await act(settle);
    const configAction = fixture.updates[1]?.spec.action;
    assert.equal(configAction?.kind === "workflow_run" &&
      configAction.request.agentBindings?.orchestrator, "manual");
    assert.equal(configAction?.kind === "workflow_run" &&
      configAction.installationBindings?.["role:orchestrator"], undefined);
  } finally {
    await unmountFixture(fixture);
  }
});

test("switching workflows does not call a new discovered role's installation saved and unavailable", async () => {
  const machine = { ...runners[0]!, protocolVersion: 175, agents: [{
    ...runners[0]!.agents[0]!, installation: {
      id: "system", path: "/usr/bin/claude", via: "path" as const, selection: "selected" as const,
    },
  }] };
  const stored = schedule("workflow-switch", "Workflow Switch");
  stored.action = { kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "runner-1-workspace", workflowId: "old-graph", task: "Build",
  } };
  const workflow = (workflowId: string): WorkflowDefinition => ({
    workflowId, version: 1, name: workflowId, source: "custom", maxTransitions: 1,
    createdBy: { kind: "human", id: "test" }, createdAt: 1, edges: [],
    nodes: [{ nodeId: "worker", kind: "agent", role: "worker", agentId: "rich-agent",
      inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 }],
  });
  const fixture = await mountFixture([stored], {}, {}, [], {}, [machine],
    [workflow("old-graph"), workflow("new-graph")]);
  try {
    await expandCard(fixture, "Workflow Switch");
    await act(async () => { button(fixture.container, "Edit").click(); });
    await changeNativeSelect(fixture.container, "Workflow", "new-graph");
    assert.doesNotMatch(fixture.container.textContent ?? "", /This saved role installation is unavailable or unbound/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("switching workflow Machines stops displaying the old Machine's installation binding", async () => {
  const oldMachine = { ...runners[0]!, protocolVersion: 175, agents: [{
    ...runners[0]!.agents[0]!, installation: {
      id: "system", path: "/usr/bin/claude", via: "path" as const, selection: "selected" as const,
    },
  }] };
  const newMachine = { ...runners[1]!, protocolVersion: 175, agents: [
    { ...runners[0]!.agents[0]!, driver: "acp" as const, installation: undefined },
    { ...runners[1]!.agents[0]!, id: "new-agent", installation: {
      id: "system", path: "/usr/bin/claude", via: "path" as const, selection: "selected" as const,
    } },
  ] };
  const stored = schedule("workflow-machine", "Workflow Machine");
  stored.action = { kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "runner-1-workspace", workflowId: "graph-1", task: "Build",
    agentBindings: { "rich-agent": "rich-agent" },
  }, installationBindings: { "role:rich-agent": {
    driver: "claude-code", context: { kind: "native" }, installationId: "system",
  } } };
  const workflow: WorkflowDefinition = {
    workflowId: "graph-1", version: 1, name: "Graph", source: "custom", maxTransitions: 1,
    createdBy: { kind: "human", id: "test" }, createdAt: 1, edges: [],
    nodes: [{ nodeId: "worker", kind: "agent", role: "worker", agentId: "rich-agent",
      inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 }],
  };
  const fixture = await mountFixture([stored], {}, {}, [], {}, [oldMachine, newMachine], [workflow]);
  try {
    await expandCard(fixture, "Workflow Machine");
    await act(async () => { button(fixture.container, "Edit").click(); });
    await changeNativeSelect(fixture.container, "Machine", "runner-2");
    assert.doesNotMatch(fixture.container.textContent ?? "", /This saved role installation is unavailable or unbound/);
    assert.match(choiceTrigger(fixture.container, "Rich-Agent Agent")?.getAttribute("aria-label") ?? "",
      /Rich-Agent Agent: Rich Agent/,
    "the new Machine's same-id installation must not replace the role shown in the editor");
    await act(async () => { button(fixture.container, "Save Automation").click(); });
    await act(settle);
    const action = fixture.updates[0]?.spec.action;
    assert.equal(action?.kind === "workflow_run" && action.request.runnerId, "runner-2");
    assert.equal(action?.kind === "workflow_run" && action.request.agentBindings, undefined);
    assert.equal(action?.kind === "workflow_run" && action.installationBindings, undefined);
  } finally {
    await unmountFixture(fixture);
  }
});

test("switching alternate workflow Machines clears the old alternate installation display", async () => {
  const oldAlternate = { ...runners[1]!, protocolVersion: 175, agents: [{
    ...runners[1]!.agents[0]!, id: "rich-agent", installation: {
      id: "system", path: "/usr/bin/claude", via: "path" as const, selection: "selected" as const,
    },
  }] };
  const newAlternate = { ...runners[2]!, protocolVersion: 175, agents: [
    { ...runners[2]!.agents[0]!, id: "rich-agent", name: "Configured Alternate",
      driver: "acp" as const, installation: undefined },
    { ...runners[2]!.agents[0]!, id: "new-agent", name: "Discovered Alternate", installation: {
      id: "system", path: "/usr/bin/claude", via: "path" as const, selection: "selected" as const,
    } },
  ] };
  const stored = schedule("alternate-workflow-machine", "Alternate Workflow Machine");
  stored.action = { kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "runner-1-workspace", workflowId: "graph-1", task: "Build",
  } };
  stored.runnerPolicy = { kind: "alternate", targets: [{
    runnerId: "runner-2", workspaceId: "runner-2-workspace",
    agentBindings: { "rich-agent": "rich-agent" },
    installationBindings: { "role:rich-agent": {
      driver: "claude-code", context: { kind: "native" }, installationId: "system",
    } },
  }] };
  const workflow: WorkflowDefinition = {
    workflowId: "graph-1", version: 1, name: "Graph", source: "custom", maxTransitions: 1,
    createdBy: { kind: "human", id: "test" }, createdAt: 1, edges: [],
    nodes: [{ nodeId: "worker", kind: "agent", role: "worker", agentId: "rich-agent",
      inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 }],
  };
  const fixture = await mountFixture([stored], {}, {}, [], {}, [runners[0]!, oldAlternate, newAlternate], [workflow]);
  try {
    await expandCard(fixture, "Alternate Workflow Machine");
    await act(async () => { button(fixture.container, "Edit").click(); });
    await changeNativeSelect(fixture.container, "Alternate Machine", "runner-3");
    assert.doesNotMatch(fixture.container.textContent ?? "", /This saved alternate role installation is unavailable or unbound/);
    assert.match(choiceTrigger(fixture.container, "Alternate Rich-Agent Agent")?.getAttribute("aria-label") ?? "",
      /Alternate Rich-Agent Agent: Configured Alternate/);
    await act(async () => { button(fixture.container, "Save Automation").click(); });
    await act(settle);
    const policy = fixture.updates[0]?.spec.runnerPolicy;
    assert.equal(policy?.kind, "alternate");
    assert.equal(policy?.kind === "alternate" && policy.targets[0]?.runnerId, "runner-3");
    assert.equal(policy?.kind === "alternate" && policy.targets[0]?.installationBindings, undefined);
  } finally {
    await unmountFixture(fixture);
  }
});

test("alternate workflow selectors follow the effective primary choice after a Machine switch", async () => {
  const alternate = { ...runners[1]!, agents: [
    { ...runners[0]!.agents[0]! },
    { ...runners[0]!.agents[1]! },
  ] };
  const newPrimary = { ...runners[2]!, agents: [{
    ...runners[2]!.agents[0]!, id: "rich-agent", driver: "acp" as const,
  }] };
  const stored = schedule("primary-switch-alternate", "Primary Switch Alternate");
  stored.action = { kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "runner-1-workspace", workflowId: "graph-1", task: "Build",
    agentBindings: { "rich-agent": "other-agent" }, orchestratorAgentId: "other-agent",
  } };
  stored.runnerPolicy = { kind: "alternate", targets: [{
    runnerId: "runner-2", workspaceId: "runner-2-workspace",
  }] };
  const workflow: WorkflowDefinition = {
    workflowId: "graph-1", version: 1, name: "Graph", source: "custom", maxTransitions: 1,
    createdBy: { kind: "human", id: "test" }, createdAt: 1, edges: [],
    nodes: [{ nodeId: "worker", kind: "agent", role: "worker", agentId: "rich-agent",
      inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 }],
  };
  const fixture = await mountFixture([stored], {}, {}, [], {}, [runners[0]!, alternate, newPrimary], [workflow]);
  try {
    await expandCard(fixture, "Primary Switch Alternate");
    await act(async () => { button(fixture.container, "Edit").click(); });
    assert.match(choiceTrigger(fixture.container, "Alternate Rich-Agent Agent")?.getAttribute("aria-label") ?? "",
      /Alternate Rich-Agent Agent: Codex App Server/);
    await choose(fixture.container, "Rich-Agent Agent", "Claude Code");
    assert.match(choiceTrigger(fixture.container, "Alternate Rich-Agent Agent")?.getAttribute("aria-label") ?? "",
      /Alternate Rich-Agent Agent: Claude Code/,
    "the alternate must follow an edited primary role when it has no override");
    await changeNativeSelect(fixture.container, "Machine", "runner-3");
    assert.match(choiceTrigger(fixture.container, "Alternate Rich-Agent Agent")?.getAttribute("aria-label") ?? "",
      /Alternate Rich-Agent Agent: Claude Code/,
    "the alternate must not keep the old primary role override after that override is dropped");
    assert.equal(choiceTrigger(fixture.container, "Alternate Orchestrator Agent"), undefined,
      "the alternate must not display an orchestrator that the new primary request drops");
  } finally {
    await unmountFixture(fixture);
  }
});

test("inherited alternate installation pins display edited primary workflow identities", async () => {
  const installedAgents = runners[0]!.agents.slice(0, 2).map((agent, index) => ({
    ...agent,
    installation: {
      id: index === 0 ? "claude-system" : "codex-system",
      path: index === 0 ? "/usr/bin/claude" : "/usr/bin/codex",
      via: "path" as const,
      selection: "selected" as const,
    },
  }));
  const primary = { ...runners[0]!, protocolVersion: 175, agents: installedAgents };
  const alternate = { ...runners[1]!, protocolVersion: 175, agents: installedAgents };
  const oldPin = { driver: "claude-code" as const, context: { kind: "native" as const }, installationId: "claude-system" };
  const stored = schedule("inherited-alternate-pins", "Inherited Alternate Pins");
  stored.action = { kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "runner-1-workspace", workflowId: "graph-1", task: "Build",
    agentBindings: { "rich-agent": "rich-agent" }, orchestratorAgentId: "rich-agent",
  }, installationBindings: { "role:rich-agent": oldPin, orchestrator: oldPin } };
  stored.runnerPolicy = { kind: "alternate", targets: [{
    runnerId: "runner-2", workspaceId: "runner-2-workspace",
    installationBindings: { "role:rich-agent": oldPin, orchestrator: oldPin },
  }] };
  const workflow: WorkflowDefinition = {
    workflowId: "graph-1", version: 1, name: "Graph", source: "custom", maxTransitions: 1,
    createdBy: { kind: "human", id: "test" }, createdAt: 1, edges: [],
    nodes: [{ nodeId: "worker", kind: "agent", role: "worker", agentId: "rich-agent",
      inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 }],
  };
  const fixture = await mountFixture([stored], {}, {}, [], {}, [primary, alternate], [workflow]);
  try {
    await expandCard(fixture, "Inherited Alternate Pins");
    await act(async () => { button(fixture.container, "Edit").click(); });
    const alternateRole = () => choiceTrigger(fixture.container, "Alternate Rich-Agent Agent")?.getAttribute("aria-label") ?? "";
    const alternateOrchestrator = () => choiceTrigger(fixture.container, "Alternate Orchestrator Agent")?.getAttribute("aria-label") ?? "";
    assert.match(alternateRole(), /Claude Code/);
    assert.match(alternateOrchestrator(), /Claude Code/);

    await choose(fixture.container, "Rich-Agent Agent", "Codex App Server");
    await choose(fixture.container, "Orchestrator Agent", "Codex App Server");
    assert.match(alternateRole(), /Codex App Server/, "inherited role must display the identity that saving will pin");
    assert.match(alternateOrchestrator(), /Codex App Server/, "inherited Orchestrator must follow the primary edit");
    assert.doesNotMatch(fixture.container.textContent ?? "", /This saved alternate (role|orchestrator) installation is unavailable or unbound/);

    await act(async () => { button(fixture.container, "Save Automation").click(); });
    await act(settle);
    const saved = fixture.updates[0]?.spec;
    assert.equal(saved?.action.kind, "workflow_run");
    assert.equal(saved.action.request.agentBindings?.["rich-agent"], "other-agent");
    assert.equal(saved.action.request.orchestratorAgentId, "other-agent");
    assert.equal(saved.runnerPolicy.kind, "alternate");
    assert.equal(saved.runnerPolicy.targets[0]?.agentBindings?.["rich-agent"], undefined);
    assert.equal(saved.runnerPolicy.targets[0]?.orchestratorAgentId, undefined);
  } finally {
    await unmountFixture(fixture);
  }

  const missingAlternate = { ...alternate, agents: [installedAgents[0]!] };
  const unavailableFixture = await mountFixture([stored], {}, {}, [], {}, [primary, missingAlternate], [workflow]);
  try {
    await expandCard(unavailableFixture, "Inherited Alternate Pins");
    await act(async () => { button(unavailableFixture.container, "Edit").click(); });
    await choose(unavailableFixture.container, "Rich-Agent Agent", "Codex App Server");
    await choose(unavailableFixture.container, "Orchestrator Agent", "Codex App Server");
    assert.match(choiceTrigger(unavailableFixture.container, "Alternate Rich-Agent Agent")?.getAttribute("aria-label") ?? "",
      /other-agent \(Unavailable\)/);
    assert.match(choiceTrigger(unavailableFixture.container, "Alternate Orchestrator Agent")?.getAttribute("aria-label") ?? "",
      /other-agent \(Unavailable\)/);
    assert.equal([...unavailableFixture.container.querySelectorAll('[role="alert"]')]
      .filter((alert) => /saved alternate (role|orchestrator) installation is unavailable or unbound/.test(alert.textContent ?? ""))
      .length, 2, "both inherited identities remain fail closed when the edited choice is missing");
  } finally {
    await unmountFixture(unavailableFixture);
  }
});

test("the automation card flags an unbound primary workflow orchestrator", async () => {
  const machine = { ...runners[0]!, protocolVersion: 175, agents: [{
    ...runners[0]!.agents[0]!, installation: {
      id: "system", path: "/usr/bin/claude", via: "path" as const, selection: "selected" as const,
    },
  }] };
  const stored = schedule("unbound-orchestrator", "Unbound Orchestrator");
  stored.action = { kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "runner-1-workspace", workflowId: "graph-1", task: "Build",
    orchestratorAgentId: "rich-agent",
  } };
  const fixture = await mountFixture([stored], {}, {}, [], {}, [machine]);
  try {
    await expandCard(fixture, "Unbound Orchestrator");
    assert.match(fixture.container.textContent ?? "", /Saved Agent Harness installation unavailable or unbound/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("an unavailable alternate installation is visible on the automation card", async () => {
  const alternate = { ...runners[1]!, protocolVersion: 175, agents: [{
    ...runners[1]!.agents[0]!, installation: {
      id: "local", path: "/home/u/bin/claude", via: "common-dir" as const,
      selection: "selected" as const,
    },
  }] };
  const stored = schedule("alternate-missing", "Alternate Missing");
  stored.runnerPolicy = { kind: "alternate", targets: [{
    runnerId: "runner-2", workspaceId: "runner-2-workspace", agentId: "alternate-agent",
    installationBindings: { agent: {
      driver: "claude-code", context: { kind: "native" }, installationId: "system",
    } },
  }] };
  const fixture = await mountFixture([stored], {}, {}, [], {}, [runners[0]!, alternate]);
  try {
    await expandCard(fixture, "Alternate Missing");
    assert.match(fixture.container.textContent ?? "", /Saved Agent Harness installation unavailable or unbound/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a waiting target's resolution error is visible on its automation card", async () => {
  const stored = schedule("waiting-target", "Waiting Target");
  stored.targetHealth = {
    scheduledFor: 60_000, firstSeenAt: 60_001,
    error: "No configured automation target is available. Check that its Machine is online.",
  };
  const fixture = await mountFixture([stored]);
  try {
    assert.match(cardToggle(fixture.container, "Waiting Target").textContent ?? "", /Target Unavailable/);
    await expandCard(fixture, "Waiting Target");
    assert.match(fixture.container.querySelector('[role="alert"]')?.textContent ?? "",
      /Waiting for target: No configured automation target is available/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a legacy create-session Agent with one installation is shown as available", async () => {
  const machine = { ...runners[0]!, protocolVersion: 175, agents: [{
    ...runners[0]!.agents[0]!, installation: {
      id: "system", path: "/usr/bin/claude", via: "path" as const, selection: "selected" as const,
    },
  }] };
  const stored = schedule("legacy-installation", "Legacy Installation");
  const fixture = await mountFixture([stored], {}, {}, [], {}, [machine]);
  try {
    await expandCard(fixture, "Legacy Installation");
    assert.doesNotMatch(fixture.container.textContent ?? "",
      /Saved Agent Harness installation unavailable or unbound/);
    await act(async () => { button(fixture.container, "Edit").click(); });
    assert.doesNotMatch(fixture.container.textContent ?? "",
      /The saved Agent Harness installation is unavailable or unbound/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("an explicit empty installation binding remains visibly blocked", async () => {
  const machine = { ...runners[0]!, protocolVersion: 175, agents: [{
    ...runners[0]!.agents[0]!, installation: {
      id: "system", path: "/usr/bin/claude", via: "path" as const, selection: "selected" as const,
    },
  }] };
  const stored = schedule("explicit-unbound", "Explicit Unbound");
  if (stored.action.kind !== "create_session") throw new Error("expected create-session action");
  stored.action.installationBindings = {};
  const fixture = await mountFixture([stored], {}, {}, [], {}, [machine]);
  try {
    await expandCard(fixture, "Explicit Unbound");
    assert.match(fixture.container.textContent ?? "",
      /Saved Agent Harness installation unavailable or unbound/);
    await act(async () => { button(fixture.container, "Edit").click(); });
    assert.match(fixture.container.textContent ?? "",
      /The saved Agent Harness installation is unavailable or unbound/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("legacy alternate targets auto-pin while explicitly unbound alternates warn in both views", async () => {
  const alternate = { ...runners[1]!, protocolVersion: 175, agents: [{
    ...runners[1]!.agents[0]!, installation: {
      id: "system", path: "/usr/bin/claude", via: "path" as const, selection: "selected" as const,
    },
  }] };
  for (const explicit of [false, true]) {
    const stored = schedule(`alternate-${explicit}`, `Alternate ${explicit}`);
    stored.runnerPolicy = { kind: "alternate", targets: [{
      runnerId: "runner-2", workspaceId: "runner-2-workspace", agentId: "alternate-agent",
      ...(explicit ? { installationBindings: {} } : {}),
    }] };
    const fixture = await mountFixture([stored], {}, {}, [], {}, [runners[0]!, alternate]);
    try {
      await expandCard(fixture, stored.name);
      assert.equal(/Saved Agent Harness installation unavailable or unbound/.test(
        fixture.container.textContent ?? ""), explicit);
      await act(async () => { button(fixture.container, "Edit").click(); });
      assert.equal(/The alternate Agent Harness installation is unavailable or unbound/.test(
        fixture.container.textContent ?? ""), explicit);
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("automation cards are collapsed by default and render only their headers", async () => {
  const fixture = await mountFixture([
    schedule("automation-a", "Alpha"),
    schedule("automation-b", "Beta", false),
  ]);
  try {
    const alpha = cardToggle(fixture.container, "Alpha");
    const beta = cardToggle(fixture.container, "Beta");

    // A native button is what makes pointer, touch, Enter, and Space activation work without any
    // key handling of our own; the e2e spec drives the real keys in a real browser.
    assert.equal(alpha.tagName, "BUTTON");
    assert.equal(alpha.getAttribute("type"), "button");
    assert.equal(expansionOf(fixture.container, "Alpha"), "false");
    assert.equal(expansionOf(fixture.container, "Beta"), "false");
    assert.equal(alpha.getAttribute("aria-controls"), "automation-body-automation-a");
    assert.equal(beta.getAttribute("aria-controls"), "automation-body-automation-b");

    // Name, action summary, and state — and nothing beyond them.
    assert.equal(
      alpha.querySelector(".automation-card-action")?.textContent,
      "Create rich-agent session on runner-1",
    );
    assert.equal(alpha.querySelector(".status.t-success")?.textContent, "Enabled");
    assert.equal(beta.querySelector(".status.t-neutral")?.textContent, "Paused");
    assert.equal(fixture.container.querySelectorAll(".automation-card-body").length, 0);
    assert.equal(fixture.container.querySelectorAll(".automation-facts").length, 0);
    assert.equal(fixture.container.querySelectorAll(".automation-card-actions").length, 0);
    assert.equal(fixture.container.querySelectorAll(".automation-history").length, 0);

    // Collapsed cards hold no reachable hidden controls: the two toggles are the only focus targets.
    const focusable = focusableInCards(fixture.container);
    assert.equal(focusable.length, 2);
    assert.equal(focusable[0], alpha);
    assert.equal(focusable[1], beta);
  } finally {
    await unmountFixture(fixture);
  }
});

test("cards expand independently and collapse back to header-only", async () => {
  const fixture = await mountFixture([
    schedule("automation-a", "Alpha"),
    schedule("automation-b", "Beta"),
  ]);
  try {
    await expandCard(fixture, "Alpha");
    await expandCard(fixture, "Beta");
    assert.equal(expansionOf(fixture.container, "Alpha"), "true");
    assert.equal(expansionOf(fixture.container, "Beta"), "true");
    assert.equal(fixture.container.querySelectorAll(".automation-card-body").length, 2);

    // The expanded body carries the details and the management actions.
    const body = fixture.container.querySelector("#automation-body-automation-a");
    assert.ok(body);
    assert.equal(body.getAttribute("aria-labelledby"), "automation-toggle-automation-a");
    assert.match(body.textContent ?? "", /Schedule/);
    assert.match(body.textContent ?? "", /Next Fire/);
    assert.ok([...body.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Edit"));
    assert.ok([...body.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Pause"));

    // Collapsing one leaves the other open.
    await expandCard(fixture, "Alpha");
    assert.equal(expansionOf(fixture.container, "Alpha"), "false");
    assert.equal(expansionOf(fixture.container, "Beta"), "true");
    assert.equal(fixture.container.querySelectorAll(".automation-card-body").length, 1);
    assertNoDomNode(fixture.container.querySelector("#automation-body-automation-a"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("failed fan-out reads stay busy until every request settles and a mutation then refreshes", async () => {
  const items = [schedule("automation-a", "Alpha")];
  const intervals = new Set<() => void>();
  let listCalls = 0;
  let failDetails = false;
  let release: (() => void) | undefined;
  let mutationFinished = false;
  await withScopedClockOverrides(domWindow, {
    setInterval: (poll: () => void) => { intervals.add(poll); return 1; },
    clearInterval: () => {},
  }, async () => {
    const fixture = await mountFixture(items, {}, {}, [], {}, runners, [], {
      automations: async () => { listCalls += 1; return { automations: structuredClone(items) }; },
      automation: async () => {
        if (failDetails) throw new Error("Detail unavailable");
        return { automation: items[0]!, executions: [], events: [] };
      },
      automationTriggers: async () => {
        if (failDetails) await new Promise<void>((resolve) => { release = resolve; });
        return { triggers: [] };
      },
      workflowDefinitions: async () => {
        if (failDetails) throw new Error("Workflow unavailable");
        return [];
      },
      updateAutomation: async (_id, spec) => {
        items[0] = { ...items[0]!, ...spec };
        mutationFinished = true;
        return items[0];
      },
    });
    try {
      await expandCard(fixture, "Alpha");
      assert.equal(listCalls, 1);
      failDetails = true;
      await act(async () => { for (const poll of intervals) poll(); });
      assert.equal(listCalls, 2);
      await act(async () => { for (const poll of intervals) poll(); });
      assert.equal(listCalls, 2, "a failed sibling cannot release the guard while another read is pending");
      await act(async () => { button(fixture.container, "Pause").click(); });
      assert.equal(mutationFinished, true);
      assert.equal(listCalls, 2, "the post-mutation refresh waits for the outstanding poll");
      failDetails = false;
      await act(async () => { release?.(); });
      assert.equal(listCalls, 3, "the mutation gets a fresh read after the earlier refresh settles");
      assert.ok(button(fixture.container, "Enable"), "the authoritative post-mutation state is rendered");
    } finally {
      release?.();
      await unmountFixture(fixture);
    }
  });
});

test("a routine poll preserves expansion and leaves newly loaded cards collapsed", async () => {
  const items = [schedule("automation-a", "Alpha"), schedule("automation-b", "Beta")];
  const fixture = await mountFixture(items);
  try {
    await expandCard(fixture, "Alpha");
    items.push(schedule("automation-c", "Gamma"));
    await awaitPoll();

    assert.ok(maybeCardToggle(fixture.container, "Gamma"), "the poll loaded the new automation");
    assert.equal(expansionOf(fixture.container, "Alpha"), "true");
    assert.equal(expansionOf(fixture.container, "Beta"), "false");
    assert.equal(expansionOf(fixture.container, "Gamma"), "false");
  } finally {
    await unmountFixture(fixture);
  }
});

test("deleting an automation does not move expansion onto another card", async () => {
  const items = [
    schedule("automation-a", "Alpha"),
    schedule("automation-b", "Beta"),
    schedule("automation-c", "Gamma"),
  ];
  const fixture = await mountFixture(items);
  try {
    // Expand the last card, then remove the first: position-keyed state would slide the open body
    // onto a different automation, identity-keyed state stays on Gamma.
    await expandCard(fixture, "Gamma");
    items.splice(0, 1);
    await awaitPoll();

    assert.equal(maybeCardToggle(fixture.container, "Alpha"), undefined);
    assert.equal(expansionOf(fixture.container, "Beta"), "false");
    assert.equal(expansionOf(fixture.container, "Gamma"), "true");
    assert.equal(fixture.container.querySelectorAll(".automation-card-body").length, 1);
    assert.ok(fixture.container.querySelector("#automation-body-automation-c"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("Execution History defaults to collapsed inside an expanded card", async () => {
  const execution: AutomationExecution = {
    executionId: "execution-1",
    automationId: "automation-a",
    idempotencyKey: "automation-a:1",
    scheduledFor: 1,
    automationRevision: 1,
    actionKind: "create_session",
    status: "succeeded",
    actor: { kind: "human", id: "test" },
    createdAt: 1,
    startedAt: 1,
    completedAt: 2,
  };
  const fixture = await mountFixture([schedule("automation-a", "Alpha")], { "automation-a": [execution] });
  try {
    await expandCard(fixture, "Alpha");
    const history = fixture.container.querySelector<HTMLDetailsElement>("details.automation-history");
    assert.ok(history, "execution history is rendered inside the expanded card");
    assert.equal(history.open, false);
    assert.match(history.querySelector("summary")?.textContent ?? "", /Execution History \(1\)/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("signed trigger editor sends an explicit prompt, parameter, and selector allowlist", async () => {
  const item = schedule("automation-a", "Alpha");
  item.action = { kind: "prompt_session", sessionId: "s_default", request: { text: "{{delivery.prompt}}" } };
  const fixture = await mountFixture([item]);
  try {
    await expandCard(fixture, "Alpha");
    await act(async () => { button(fixture.container, "Add Webhook").click(); });
    const editor = fixture.container.querySelector<HTMLElement>('[aria-label="New Signed Trigger"]');
    assert.ok(editor);
    const checkbox = (label: string) => {
      const wrapper = [...editor.querySelectorAll<HTMLLabelElement>("label")]
        .find((candidate) => candidate.textContent?.trim() === label);
      const input = wrapper?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      assert.ok(input, `${label} checkbox is rendered`);
      return input;
    };
    await act(async () => { checkbox("Accept Delivery Fields").click(); });
    await act(async () => { checkbox("Delivered Prompt").click(); });
    await act(async () => { checkbox("Branch").click(); });
    const parameterInput = [...editor.querySelectorAll<HTMLInputElement>("input")]
      .find((candidate) => candidate.closest("label")?.textContent?.includes("Parameter Names"));
    assert.ok(parameterInput);
    const inputSetter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")?.set;
    assert.ok(inputSetter);
    await act(async () => {
      inputSetter.call(parameterInput, "issue, run_id");
      parameterInput.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true, data: "issue, run_id" }) as never);
      parameterInput.dispatchEvent(new domWindow.Event("change", { bubbles: true }) as never);
    });
    await act(settle);
    await act(async () => { button(fixture.container, "Create Trigger").click(); });
    await act(settle);
    assert.deepEqual(fixture.triggerCreates, [{
      id: "automation-a",
      request: {
        kind: "webhook", name: "Alpha webhook",
        deliveryPolicy: {
          allowPrompt: true, parameterNames: ["issue", "run_id"], missingReferences: "reject",
          sessionSelectors: ["branch"],
        },
      },
    }]);
    assert.match(fixture.container.textContent ?? "", /Accepts Prompt · Parameters issue, run_id · Selectors Branch/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("execution history shows content-free signed delivery provenance", async () => {
  const execution: AutomationExecution = {
    executionId: "execution-trigger",
    automationId: "automation-a",
    idempotencyKey: "trigger:atr_1:delivery-1",
    scheduledFor: 1,
    automationRevision: 1,
    actionKind: "create_session",
    status: "succeeded",
    actor: { kind: "policy", id: "webhook:atr_1" },
    createdAt: 1,
    completedAt: 2,
    triggerDelivery: {
      fields: ["prompt", "parameters"],
      promptSha256: "a".repeat(64),
      parameterNames: ["issue"],
    },
  };
  const fixture = await mountFixture([schedule("automation-a", "Alpha")], { "automation-a": [execution] });
  try {
    await expandCard(fixture, "Alpha");
    const history = fixture.container.querySelector<HTMLDetailsElement>("details.automation-history")!;
    history.open = true;
    assert.match(history.textContent ?? "", /Delivered Fields: Prompt · Parameters issue/);
    assert.match(history.textContent ?? "", /Prompt Digest aaaaaaaaaaaa…/);
    assert.doesNotMatch(history.textContent ?? "", /delivered prompt text|parameter value/);
  } finally {
    await unmountFixture(fixture);
  }
});

function pageError(fixture: Fixture): string | null {
  return fixture.container.querySelector('.page > .automation-error[role="alert"]')?.textContent ?? null;
}

async function invokePolls(intervals: Set<() => void>): Promise<void> {
  await act(async () => { for (const poll of intervals) poll(); });
  await act(settle);
}

for (const failedEndpoint of ["list", "workflow", "detail", "trigger"] as const) {
  test(`polling recovery clears a ${failedEndpoint} error only after the complete refresh`, async () => {
    const items = [schedule("automation-a", "Alpha")];
    const intervals = new Set<() => void>();
    let fail = false;
    let holdRecovery = false;
    let release: (() => void) | undefined;
    let listCalls = 0;
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; },
      clearInterval: () => {},
    }, async () => {
      const reject = (endpoint: typeof failedEndpoint) => {
        if (fail && endpoint === failedEndpoint) throw new Error("Polling unavailable");
      };
      const fixture = await mountFixture(items, {}, {}, [], {}, runners, [], {
        automations: async () => {
          listCalls++;
          reject("list");
          return { automations: structuredClone(items) };
        },
        workflowDefinitions: async () => { reject("workflow"); return []; },
        automation: async (id) => {
          reject("detail");
          return { automation: items.find((item) => item.automationId === id)!, executions: [], events: [] };
        },
        automationTriggers: async () => {
          reject("trigger");
          if (holdRecovery) await new Promise<void>((resolve) => { release = resolve; });
          return { triggers: [] };
        },
      });
      const visibility = Object.getOwnPropertyDescriptor(domWindow.document, "visibilityState");
      try {
        fail = true;
        await invokePolls(intervals);
        assert.equal(pageError(fixture), "Polling unavailable");
        Object.defineProperty(domWindow.document, "visibilityState", { configurable: true, value: "hidden" });
        fail = false;
        await invokePolls(intervals);
        assert.equal(listCalls, 2, "a hidden skip cannot read or report recovery");
        assert.equal(pageError(fixture), "Polling unavailable");
        Object.defineProperty(domWindow.document, "visibilityState", { configurable: true, value: "visible" });
        holdRecovery = true;
        items[0] = { ...items[0]!, name: "Recovered" };
        await invokePolls(intervals);
        assert.ok(maybeCardToggle(fixture.container, "Recovered"));
        assert.equal(pageError(fixture), "Polling unavailable", "list success alone is not recovery");
        await invokePolls(intervals);
        assert.equal(listCalls, 3, "a pending fan-out read retains serialization");
        holdRecovery = false;
        await act(async () => { release?.(); });
        await act(settle);
        assert.equal(pageError(fixture), null);
        await invokePolls(intervals);
        assert.equal(pageError(fixture), null);
      } finally {
        release?.();
        if (visibility) Object.defineProperty(domWindow.document, "visibilityState", visibility);
        else Reflect.deleteProperty(domWindow.document, "visibilityState");
        await unmountFixture(fixture);
      }
    });
  });
}

test("partial polling recovery retains the remaining failure and a later complete poll clears it", async () => {
  const intervals = new Set<() => void>();
  let failure: "list" | "workflow" | null = null;
  await withScopedClockOverrides(domWindow, {
    setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => {},
  }, async () => {
    const fixture = await mountFixture([], {}, {}, [], {}, runners, [], {
      automations: async () => {
        if (failure === "list") throw new Error("List unavailable");
        return { automations: [] };
      },
      workflowDefinitions: async () => {
        if (failure === "workflow") throw new Error("Workflow unavailable");
        return [];
      },
    });
    try {
      failure = "list";
      await invokePolls(intervals);
      assert.equal(pageError(fixture), "List unavailable");
      failure = "workflow";
      await invokePolls(intervals);
      assert.equal(pageError(fixture), "Workflow unavailable");
      failure = null;
      await invokePolls(intervals);
      assert.equal(pageError(fixture), null);
    } finally { await unmountFixture(fixture); }
  });
});

for (const pollFails of [false, true]) {
  test(`a ${pollFails ? "failed" : "successful"} earlier poll cannot replace a newer failed action`, async () => {
    const item = schedule("automation-a", "Alpha");
    const intervals = new Set<() => void>();
    let holdPoll = false;
    let release: (() => void) | undefined;
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => {},
    }, async () => {
      const fixture = await mountFixture([item], {}, {}, [], {}, runners, [], {
        automationTriggers: async () => {
          if (holdPoll) {
            await new Promise<void>((resolve) => { release = resolve; });
            if (pollFails) throw new Error("Old polling failure");
          }
          return { triggers: [] };
        },
        updateAutomation: async () => { throw new Error("Pause failed"); },
      });
      try {
        await expandCard(fixture, "Alpha");
        holdPoll = true;
        await invokePolls(intervals);
        await act(async () => { button(fixture.container, "Pause").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "Pause failed");
        await act(async () => { release?.(); });
        await act(settle);
        assert.equal(pageError(fixture), "Pause failed");
        holdPoll = false;
        await invokePolls(intervals);
        assert.equal(pageError(fixture), "Pause failed", "later successful polling preserves action provenance");
        holdPoll = true;
        await invokePolls(intervals);
        await act(async () => { release?.(); });
        await act(settle);
        assert.equal(pageError(fixture), "Pause failed", "later failures also preserve the failed action");
      } finally { release?.(); await unmountFixture(fixture); }
    });
  });
}

for (const oldPollFails of [false, true]) {
  test(`API replacement ignores an obsolete ${oldPollFails ? "failure" : "success"} and skips revoked queued refreshes`, async () => {
    const item = schedule("automation-a", "Alpha");
    const intervals = new Set<() => void>();
    let holdOld = false;
    let release: (() => void) | undefined;
    let obsoleteQueuedReads = 0;
    let newReads = 0;
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; },
      clearInterval: () => { intervals.clear(); },
    }, async () => {
      const fixture = await mountFixture([item], {}, {}, [], {}, runners, [], {
        automationTriggers: async () => {
          if (holdOld) {
            await new Promise<void>((resolve) => { release = resolve; });
            if (oldPollFails) throw new Error("Obsolete poll failed");
          }
          return { triggers: [] };
        },
      });
      try {
        await expandCard(fixture, "Alpha");
        holdOld = true;
        await invokePolls(intervals);
        await fixture.replaceClient({
          automations: async () => { obsoleteQueuedReads++; return { automations: [item] }; },
        });
        await fixture.replaceClient({
          automations: async () => { newReads++; return { automations: [item] }; },
          automationTriggers: async () => ({ triggers: [] }),
          updateAutomation: async () => { throw new Error("New client Pause failed"); },
        });
        await act(async () => { button(fixture.container, "Pause").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "New client Pause failed");
        assert.equal(newReads, 0, "replacement refresh waits for every old request");
        await act(async () => { release?.(); });
        await act(settle);
        assert.equal(obsoleteQueuedReads, 0, "a cleaned-up effect must not start its queued read");
        assert.equal(newReads, 1);
        assert.equal(pageError(fixture), "New client Pause failed");
        await invokePolls(intervals);
        assert.equal(pageError(fixture), "New client Pause failed");
      } finally { release?.(); await unmountFixture(fixture); }
    });
  });
}

test("unmount revokes a pending poll and removes its timer before its rejection settles", async () => {
  const intervals = new Set<() => void>();
  let hold = false;
  let release: (() => void) | undefined;
  let reads = 0;
  await withScopedClockOverrides(domWindow, {
    setInterval: (poll: () => void) => { intervals.add(poll); return 1; },
    clearInterval: () => { intervals.clear(); },
  }, async () => {
    const fixture = await mountFixture([], {}, {}, [], {}, runners, [], {
      automations: async () => {
        reads++;
        if (hold) {
          await new Promise<void>((resolve) => { release = resolve; });
          throw new Error("Unmounted polling failure");
        }
        return { automations: [] };
      },
    });
    hold = true;
    await invokePolls(intervals);
    await unmountFixture(fixture);
    assert.equal(intervals.size, 0);
    await act(async () => { release?.(); });
    await invokePolls(intervals);
    assert.equal(reads, 2);
    assert.equal(fixture.container.childNodes.length, 0);
  });
});

for (const mutationFails of [false, true]) {
  test(`API replacement revokes an old action's ${mutationFails ? "failure" : "post-mutation read"}`, async () => {
    const item = schedule("automation-a", "Alpha");
    const intervals = new Set<() => void>();
    let release: (() => void) | undefined;
    let oldReads = 0;
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; },
      clearInterval: () => { intervals.clear(); },
    }, async () => {
      const fixture = await mountFixture([item], {}, {}, [], {}, runners, [], {
        automations: async () => { oldReads++; return { automations: [item] }; },
        updateAutomation: async () => {
          await new Promise<void>((resolve) => { release = resolve; });
          if (mutationFails) throw new Error("Obsolete action failed");
          return item;
        },
      });
      try {
        await expandCard(fixture, "Alpha");
        await act(async () => { button(fixture.container, "Pause").click(); });
        await fixture.replaceClient({ automations: async () => { throw new Error("New client polling failed"); } });
        assert.equal(pageError(fixture), "New client polling failed");
        await act(async () => { release?.(); });
        await act(settle);
        assert.equal(pageError(fixture), "New client polling failed");
        assert.equal(oldReads, 1, "the obsolete action cannot read with its old client");
      } finally { release?.(); await unmountFixture(fixture); }
    });
  });
}


for (const failedEndpoint of ["list", "workflow", "detail", "trigger"] as const) {
  test(`accepted Pause recovers its post-mutation ${failedEndpoint} read error`, async () => {
    const items = [schedule("automation-a", "Alpha")];
    const intervals = new Set<() => void>();
    let fail = false;
    let writes = 0;
    const reads = { list: 0, workflow: 0, detail: 0, trigger: 0 };
    const read = (endpoint: keyof typeof reads) => {
      reads[endpoint]++;
      if (fail && endpoint === failedEndpoint) throw new Error("Accepted Pause refresh failed");
    };
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => {},
    }, async () => {
      const fixture = await mountFixture(items, {}, {}, [], {}, runners, [], {
        automations: async () => { read("list"); return { automations: structuredClone(items) }; },
        workflowDefinitions: async () => { read("workflow"); return []; },
        automation: async () => { read("detail"); return { automation: items[0]!, executions: [], events: [] }; },
        automationTriggers: async () => { read("trigger"); return { triggers: [] }; },
        updateAutomation: async (_id, spec) => {
          writes++;
          items[0] = { ...items[0]!, ...spec };
          fail = true;
          return items[0]!;
        },
        outboundEventSubscriptions: async () => { throw new Error("Unrelated subscription warning"); },
      });
      const subscriptionError = () => fixture.container.querySelector('.outbound-events .automation-error')?.textContent;
      try {
        await expandCard(fixture, "Alpha");
        await act(async () => { button(fixture.container, "Pause").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "Accepted Pause refresh failed");
        assert.equal(items[0]!.enabled, false);
        fail = false;
        items[0] = { ...items[0]!, name: "Recovered" };
        const before = { ...reads };
        await invokePolls(intervals);
        for (const endpoint of Object.keys(reads) as Array<keyof typeof reads>) {
          assert.equal(reads[endpoint], before[endpoint] + 1, `healthy ${endpoint} read completed`);
        }
        assert.ok(maybeCardToggle(fixture.container, "Recovered"));
        assert.ok(button(fixture.container, "Enable"));
        assert.equal(pageError(fixture), null);
        assert.equal(subscriptionError(), "Unrelated subscription warning", "automation recovery leaves subscription errors alone");
        await invokePolls(intervals);
        assert.equal(pageError(fixture), null);
        assert.equal(writes, 1, "recovery must never retry the mutation");
      } finally { await unmountFixture(fixture); }
    });
  });
}

for (const outcome of ["accepted", "rejected", "unknown acceptance"] as const) {
  test(`healthy polls preserve the ${outcome} Pause outcome without another write`, async () => {
    const items = [schedule("automation-a", "Alpha")];
    const intervals = new Set<() => void>();
    let writes = 0;
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => {},
    }, async () => {
      const fixture = await mountFixture(items, {}, {}, [], {}, runners, [], {
        updateAutomation: async (_id, spec) => {
          writes++;
          // A transport failure after the server changes state still does not prove acceptance
          // to the caller. Authoritative polling must not clear that failed write's error.
          if (outcome !== "rejected") items[0] = { ...items[0]!, ...spec };
          if (outcome !== "accepted") throw new Error(`Pause ${outcome}`);
          return items[0]!;
        },
      });
      try {
        await expandCard(fixture, "Alpha");
        await act(async () => { button(fixture.container, "Pause").click(); });
        await act(settle);
        await invokePolls(intervals);
        assert.equal(pageError(fixture), outcome === "accepted" ? null : `Pause ${outcome}`);
        assert.equal(items[0]!.enabled, outcome === "rejected");
        assert.ok(button(fixture.container, outcome === "rejected" ? "Pause" : "Enable"));
        assert.equal(writes, 1);
      } finally { await unmountFixture(fixture); }
    });
  });
}

test("post-mutation read recovery needs a complete visible refresh", async () => {
  const items = [schedule("automation-a", "Alpha")];
  const intervals = new Set<() => void>();
  let fail = false;
  let hold = false;
  let writes = 0;
  let listReads = 0;
  let release: (() => void) | undefined;
  await withScopedClockOverrides(domWindow, {
    setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => {},
  }, async () => {
    const fixture = await mountFixture(items, {}, {}, [], {}, runners, [], {
      automations: async () => { listReads++; return { automations: structuredClone(items) }; },
      workflowDefinitions: async () => { if (fail) throw new Error("Post-action workflow unavailable"); return []; },
      automationTriggers: async () => {
        if (hold) await new Promise<void>((resolve) => { release = resolve; });
        return { triggers: [] };
      },
      updateAutomation: async (_id, spec) => { writes++; items[0] = { ...items[0]!, ...spec }; fail = true; return items[0]!; },
    });
    const visibility = Object.getOwnPropertyDescriptor(domWindow.document, "visibilityState");
    try {
      await expandCard(fixture, "Alpha");
      await act(async () => { button(fixture.container, "Pause").click(); });
      await act(settle);
      assert.equal(pageError(fixture), "Post-action workflow unavailable");
      await invokePolls(intervals);
      assert.equal(pageError(fixture), "Post-action workflow unavailable", "another failed refresh is not recovery");
      fail = false;
      const beforeHidden = listReads;
      Object.defineProperty(domWindow.document, "visibilityState", { configurable: true, value: "hidden" });
      await invokePolls(intervals);
      assert.equal(listReads, beforeHidden);
      assert.equal(pageError(fixture), "Post-action workflow unavailable");
      Object.defineProperty(domWindow.document, "visibilityState", { configurable: true, value: "visible" });
      hold = true;
      items[0] = { ...items[0]!, name: "Fresh List" };
      await invokePolls(intervals);
      assert.ok(maybeCardToggle(fixture.container, "Fresh List"));
      assert.equal(pageError(fixture), "Post-action workflow unavailable", "partial fan-out completion cannot clear it");
      const beforeBusy = listReads;
      await invokePolls(intervals);
      assert.equal(listReads, beforeBusy, "busy polls preserve serialization");
      hold = false;
      await act(async () => { release?.(); });
      await act(settle);
      assert.equal(pageError(fixture), null);
      assert.equal(writes, 1);
    } finally {
      release?.();
      if (visibility) Object.defineProperty(domWindow.document, "visibilityState", visibility);
      else Reflect.deleteProperty(domWindow.document, "visibilityState");
      await unmountFixture(fixture);
    }
  });
});

for (const recoveryFails of [false, true]) {
  test(`a ${recoveryFails ? "failed" : "healthy"} read recovery cannot overwrite a newer failed action`, async () => {
    const items = [schedule("automation-a", "Alpha")];
    const intervals = new Set<() => void>();
    let failAfterWrite = false;
    let holdRecovery = false;
    let writes = 0;
    let release: (() => void) | undefined;
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => {},
    }, async () => {
      const fixture = await mountFixture(items, {}, {}, [], {}, runners, [], {
        workflowDefinitions: async () => { if (failAfterWrite) throw new Error("Old post-action read failed"); return []; },
        automationTriggers: async () => {
          if (holdRecovery) {
            await new Promise<void>((resolve) => { release = resolve; });
            if (recoveryFails) throw new Error("Old recovery failed");
          }
          return { triggers: [] };
        },
        updateAutomation: async (_id, spec) => {
          writes++;
          if (writes > 1) throw new Error("New Enable write failed");
          items[0] = { ...items[0]!, ...spec }; failAfterWrite = true; return items[0]!;
        },
      });
      try {
        await expandCard(fixture, "Alpha");
        await act(async () => { button(fixture.container, "Pause").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "Old post-action read failed");
        failAfterWrite = false; holdRecovery = true;
        await invokePolls(intervals);
        await act(async () => { button(fixture.container, "Enable").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "New Enable write failed");
        await act(async () => { release?.(); });
        await act(settle);
        assert.equal(pageError(fixture), "New Enable write failed");
        holdRecovery = false;
        await invokePolls(intervals);
        assert.equal(pageError(fixture), "New Enable write failed");
        assert.equal(writes, 2);
      } finally { release?.(); await unmountFixture(fixture); }
    });
  });
}

for (const obsoleteReadFails of [false, true]) {
  test(`API replacement revokes an accepted write's obsolete ${obsoleteReadFails ? "failed" : "healthy"} recovery`, async () => {
    const items = [schedule("automation-a", "Alpha")];
    const intervals = new Set<() => void>();
    let hold = false;
    let failAfterWrite = false;
    let release: (() => void) | undefined;
    let writes = 0;
    let listReads = 0;
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => { intervals.clear(); },
    }, async () => {
      const fixture = await mountFixture(items, {}, {}, [], {}, runners, [], {
        automations: async () => { listReads++; return { automations: structuredClone(items) }; },
        workflowDefinitions: async () => {
          if (failAfterWrite) throw new Error("Accepted-write refresh failed");
          if (hold) {
            await new Promise<void>((resolve) => { release = resolve; });
            if (obsoleteReadFails) throw new Error("Obsolete accepted-write refresh failed");
          }
          return [];
        },
        updateAutomation: async (_id, spec) => { writes++; items[0] = { ...items[0]!, ...spec }; failAfterWrite = true; return items[0]!; },
      });
      try {
        await expandCard(fixture, "Alpha");
        await act(async () => { button(fixture.container, "Pause").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "Accepted-write refresh failed");
        failAfterWrite = false;
        hold = true;
        await invokePolls(intervals);
        assert.ok(release, "the old client's recovery is in flight");
        await fixture.replaceClient({
          workflowDefinitions: async () => [],
          updateAutomation: async () => { throw new Error("Replacement Enable failed"); },
        });
        await act(async () => { button(fixture.container, "Enable").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "Replacement Enable failed");
        await act(async () => { release?.(); });
        await act(settle);
        assert.equal(pageError(fixture), "Replacement Enable failed");
        await invokePolls(intervals);
        assert.equal(pageError(fixture), "Replacement Enable failed");
        assert.equal(writes, 1);
        assert.equal(listReads, 5, "initial, accepted-action, old recovery and two current-client reads only");
      } finally { release?.(); await unmountFixture(fixture); }
    });
  });
}
