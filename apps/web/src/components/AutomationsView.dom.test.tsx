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
  const client = {
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
  await act(async () => { socket.push(snapshot(runnerViews)); });
  await act(settle);
  return { container, root, updates, triggerCreates, outboundCreates };
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
  const machine = { ...runners[0]!, protocolVersion: 175, agents: [{
    ...runners[0]!.agents[0]!, id: "orchestrator", installation: {
      id: "system", path: "/usr/bin/claude", via: "path" as const,
      selection: "selected" as const,
    },
  }] };
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
  } finally {
    await unmountFixture(fixture);
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
    assert.equal(alpha.querySelector(".automation-state")?.textContent, "Enabled");
    assert.equal(beta.querySelector(".automation-state")?.textContent, "Paused");
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
    assert.equal(fixture.container.querySelector("#automation-body-automation-a"), null);
  } finally {
    await unmountFixture(fixture);
  }
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
