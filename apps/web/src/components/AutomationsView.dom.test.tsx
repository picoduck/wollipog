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
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { viewPath, type View, type ViewNavigation } from "../navigation.js";
import { setExperimentFlag } from "../experiments.js";
import { MULTI_AGENT_OFF_HELPER } from "./AutomationEditor.js";
import { FeedbackContext } from "./FeedbackProvider.js";

type FeedbackContextValue = React.ContextType<typeof FeedbackContext>;
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { AutomationsView } from "./AutomationsView.js";
import { AutomationEditor } from "./AutomationEditor.js";
import { AutomationDetail } from "./AutomationDetail.js";
import { agentOptions } from "./agent-options.js";
import { agentDisplayName } from "../agent-presentation.js";
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

/** Confirmations and toasts for a fixture mounted while it is set; none otherwise (every confirm declines). */
let feedback: FeedbackContextValue | null = null;

/** The route a fixture opens on: the list, unless a test opens an editor route directly. */
let initialView: View = { name: "automations" };
const navigation: ViewNavigation = {
  current: () => initialView,
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

/** The list, an automation's page, or the editor, as App routes them. */
function AutomationsWhenReady() {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  const view = useStoreSelector((state) => state.view);
  if (!ready) return null;
  if (view.name === "automation") return <AutomationDetail key={view.id} automationId={view.id} />;
  return view.name === "automations" && view.editor
    ? <AutomationEditor key={viewPath(view)} route={view.editor} />
    : <AutomationsView />;
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  updates: Array<{ id: string; spec: AutomationSpec }>;
  triggerCreates: Array<{ id: string; request: CreateAutomationTriggerRequest }>;
  outboundCreates: CreateOutboundEventSubscriptionRequest[];
  /** Every list, detail and trigger read, in order: "list", "automation:<id>", "triggers:<id>". */
  requests: string[];
  deletes: string[];
  replaceClient: (overrides: Partial<ApiClient>) => Promise<void>;
  pushRunners: (views: RunnerView[]) => Promise<void>;
}

let fixtureSequence = 0;

const CARD_INSTALLATION_ALERT =
  /This automation's agent installation isn't available\. Edit the automation to choose another installation\./;
const SAVED_INSTALLATION_WARNING =
  /The saved installation of this agent isn't available\. This automation waits until you choose an available installation\./;
const SAVED_ALTERNATE_INSTALLATION_WARNING = /The saved installation of this agent isn't available on the other machine\./;
const SAVED_ROLE_WARNING = /The saved installation of this role's agent isn't available\./;
const SAVED_ALTERNATE_ROLE_WARNING = /The saved installation of this role's agent isn't available on the other machine\./;
const SAVED_ALTERNATE_ROLE_OR_ORCHESTRATOR_WARNING =
  /The saved installation of (this role's|the Orchestrator's) agent isn't available on the other machine\./;

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
  const requests: string[] = [];
  const deletes: string[] = [];
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
    automations: async () => {
      requests.push("list");
      return { automations: [...items] };
    },
    automation: async (id: string) => {
      requests.push(`automation:${id}`);
      const automation = items.find((item) => item.automationId === id);
      if (!automation) throw new ApiError("automation not found", 404);
      return { automation, executions: executions[id] ?? [], events: [] };
    },
    automationTriggers: async (id: string) => {
      requests.push(`triggers:${id}`);
      return { triggers: triggerViews[id] ?? [] };
    },
    deleteAutomation: async (id: string) => {
      deletes.push(id);
      items.splice(items.findIndex((item) => item.automationId === id), 1);
      return { deleted: true };
    },
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

  const store = (
    <StoreProvider connection={connection} navigation={navigation}>
      <AutomationsWhenReady />
    </StoreProvider>
  );
  const render = () => root.render(
    <ApiProvider client={client}>
      {feedback ? <FeedbackContext.Provider value={feedback}>{store}</FeedbackContext.Provider> : store}
    </ApiProvider>,
  );
  await act(async () => { render(); });
  await act(async () => { socket.push(snapshot(runnerViews)); });
  await act(settle);
  return {
    container, root, updates, triggerCreates, outboundCreates, requests, deletes,
    replaceClient: async (overrides) => {
      client = { ...client, ...overrides };
      await act(async () => { render(); });
      await act(settle);
    },
    pushRunners: async (views) => {
      await act(async () => { socket.push(snapshot(views)); });
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

/** The value a Select shows, from its trigger's name ("Machine: runner-1"). */
function shownValue(container: HTMLDivElement, label: string): string | undefined {
  return choiceTrigger(container, label)?.getAttribute("aria-label")?.slice(label.length + 2);
}

/** A Select's options as listed, with whether each can be chosen; the list is closed again. */
async function listOptions(container: HTMLDivElement, label: string): Promise<Array<{ label: string; disabled: boolean }>> {
  const trigger = choiceTrigger(container, label);
  assert.ok(trigger, `${label} choice is rendered`);
  await act(async () => { trigger.click(); });
  const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((option) => ({
    label: option.querySelector('[id$="-label"]')?.textContent?.trim() ?? "",
    disabled: option.getAttribute("aria-disabled") === "true",
  }));
  await act(async () => { trigger.click(); });
  return options;
}

/** Choose the editor's action by its choice row's title. */
async function chooseAction(container: HTMLDivElement, title: string): Promise<void> {
  const row = [...container.querySelectorAll<HTMLLabelElement>(".choice-row")]
    .find((candidate) => candidate.querySelector(".choice-row-title")?.textContent?.trim() === title);
  const input = row?.querySelector("input");
  assert.ok(input, `${title} action is rendered`);
  await act(async () => { input.click(); });
  await act(settle);
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
  // By the option's label alone: its description and status are its other lines.
  const option = options
    .find((candidate) => (candidate.querySelector('[id$="-label"]') ?? candidate).textContent?.trim() === optionLabel);
  assert.ok(option, `${optionLabel} option is rendered; found ${options.map((item) => item.textContent?.trim()).join(", ")}`);
  await act(async () => { option.click(); });
  await act(settle);
}

async function openNew(fixture: Fixture): Promise<void> {
  await act(async () => { button(fixture.container, "New Automation").click(); });
  await act(settle);
}

/** Edit on the automation's page opens the editor's route, which loads the stored automation. */
async function openEdit(fixture: Fixture): Promise<void> {
  await act(async () => { button(fixture.container, "Edit").click(); });
  await act(settle);
}

/** Back to the automation's page and Edit again: the editor reloads the automation as it is stored. */
async function reopenEdit(fixture: Fixture, name: string): Promise<void> {
  const back = fixture.container.querySelector<HTMLButtonElement>(`button[aria-label="Back to ${name}"]`);
  assert.ok(back, "the editor's Back to the automation is rendered");
  await act(async () => { back.click(); });
  await act(settle);
  await openEdit(fixture);
}

async function saveChanges(fixture: Fixture): Promise<void> {
  await act(async () => { button(fixture.container, "Save Changes").click(); });
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
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true, data: value }) as never);
    // React reads a text field's change from focus and keyup here, as SessionMoveDialogs' tests do.
    input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as never);
  });
}

function cardToggle(container: HTMLDivElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>(".automation-card-toggle")]
    .find((candidate) => candidate.querySelector(".automation-card-name")?.textContent === name);
  assert.ok(found, `${name} automation card is rendered`);
  return found;
}

/** A card's heading opens the automation's page (#2968). */
async function openPage(fixture: Fixture, name: string): Promise<void> {
  await act(async () => { cardToggle(fixture.container, name).click(); });
  await act(settle);
}

function maybeCardToggle(container: HTMLDivElement, name: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>(".automation-card-toggle")]
    .find((candidate) => candidate.querySelector(".automation-card-name")?.textContent === name);
}

/** The automation page's title, from its detail bar. */
function pageTitle(container: HTMLDivElement): string | null {
  return container.querySelector(".automation-detail .detail-bar-title")?.textContent ?? null;
}

/** Opens the detail bar's ⋯ and chooses `label` from it. */
async function chooseMoreAction(fixture: Fixture, label: string): Promise<void> {
  const more = fixture.container.querySelector<HTMLButtonElement>('.detail-bar button[aria-label="More Actions"]');
  assert.ok(more, "the detail bar's ⋯ is rendered");
  await act(async () => { more.click(); });
  // The menu is portalled to the document, outside the fixture's container.
  const items = [...fixture.container.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const item = items.find((candidate) => candidate.querySelector(".menu-text")?.textContent?.trim() === label);
  assert.ok(item, `${label} is in ⋯; found ${items.map((candidate) => candidate.textContent?.trim()).join(", ")}`);
  await act(async () => { item.click(); });
  await act(settle);
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

    await choose(fixture.container, "Agent", "Other Agent");
    assert.equal(choiceTrigger(fixture.container, "Model")?.getAttribute("aria-label"), "Model: Agent Default");
    assert.equal(choiceTrigger(fixture.container, "Reasoning Effort")?.getAttribute("aria-label"), "Reasoning Effort: Agent Default");
    assert.equal(choiceTrigger(fixture.container, "Permission Mode")?.getAttribute("aria-label"), "Permission Mode: Agent Default");

    await choose(fixture.container, "Model", "GPT");
    await choose(fixture.container, "Reasoning Effort", "Medium");
    await choose(fixture.container, "Machine", "runner-2");
    assert.equal(choiceTrigger(fixture.container, "Model")?.getAttribute("aria-label"), "Model: Agent Default");
    assert.equal(choiceTrigger(fixture.container, "Reasoning Effort")?.getAttribute("aria-label"), "Reasoning Effort: Agent Default");

    await choose(fixture.container, "Machine", "runner-1");
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

    await chooseAction(fixture.container, "Prompt a Session");
    assert.equal(choiceTrigger(fixture.container, "Model"), undefined);
    assert.equal(choiceTrigger(fixture.container, "Reasoning Effort"), undefined);
    assert.equal(choiceTrigger(fixture.container, "Permission Mode"), undefined);

    await chooseAction(fixture.container, "Start a Session");
    await choose(fixture.container, "Agent", "Plain Agent");
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
    await openPage(fixture, "Nightly Sweep");
    await openEdit(fixture);
    const nameInput = [...fixture.container.querySelectorAll<HTMLLabelElement>("label")]
      .find((candidate) => candidate.childNodes[0]?.textContent?.trim() === "Name")
      ?.querySelector("input") as HTMLInputElement | null;
    assert.equal(nameInput?.value, "Nightly Sweep");
    assert.equal(shownValue(fixture.container, "Machine"), "runner-1");
    assert.equal(shownValue(fixture.container, "Agent"), "Rich Agent");
    assert.equal(choiceTrigger(fixture.container, "Model")?.getAttribute("aria-label"), "Model: Opus");
    assert.equal(choiceTrigger(fixture.container, "Reasoning Effort")?.getAttribute("aria-label"), "Reasoning Effort: High");
    assert.equal(choiceTrigger(fixture.container, "Permission Mode")?.getAttribute("aria-label"), "Permission Mode: Auto");
    assert.equal((await listOptions(fixture.container, "Machine")).find((option) => option.label === "runner-3")?.disabled, true);
    // The stored first alternate, never "Select…"; a later stored alternate is carried, not offered.
    assert.equal(shownValue(fixture.container, "Other Machine"), "runner-2");
    assert.deepEqual((await listOptions(fixture.container, "Other Machine")).map((option) => option.label), ["runner-2"]);
    assert.doesNotMatch(fixture.container.textContent ?? "", /Additional stored alternate machines are preserved/);

    await choose(fixture.container, "If the Machine Is Offline", "Wait Until It's Back");
    assert.equal((await listOptions(fixture.container, "Machine")).find((option) => option.label === "runner-3")?.disabled, false);
    await choose(fixture.container, "If the Machine Is Offline", "Use Another Machine");
    assertNoDomNode(fixture.container.querySelector(".save-bar"), "a change undone leaves nothing to save");

    // Only the name changes; every other stored field, including both alternates, round-trips.
    await setLabeledInput(fixture.container, "Name", "Nightly Sweep Renamed");
    await saveChanges(fixture);
    assert.equal(fixture.updates.length, 1);
    const { automationId: _id, revision: _revision, createdBy: _createdBy,
      createdAt: _createdAt, updatedAt: _updatedAt, ...storedSpec } = stored;
    assert.deepEqual(fixture.updates[0], { id: stored.automationId, spec: { ...storedSpec, name: "Nightly Sweep Renamed" } });
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
    await openPage(fixture, "Pinned Sweep");
    assert.match(fixture.container.textContent ?? "", CARD_INSTALLATION_ALERT);
    await openEdit(fixture);
    await act(async () => { button(fixture.container, "Use Current Installation").click(); });
    await saveChanges(fixture);
    const action = fixture.updates[0]?.spec.action;
    assert.equal(action?.kind === "create_session" &&
      action.installationBindings?.agent?.installationId, "local");
  } finally {
    await unmountFixture(fixture);
  }
});

test("saving a rebind whose installation disappeared names the machine it needs", async () => {
  const installed = (machine: RunnerView, selection: "selected" | "other"): RunnerView => ({
    ...machine, protocolVersion: 175, agents: [{ ...machine.agents[0]!, installation: {
      id: "local", path: "/home/u/.local/bin/claude", via: "common-dir" as const, selection,
    } }],
  });
  const saved = { driver: "claude-code" as const, context: { kind: "native" as const }, installationId: "system" };
  for (const alternate of [false, true]) {
    const stored = schedule(`rebind-${alternate}`, alternate ? "Alternate Rebind" : "Primary Rebind");
    if (stored.action.kind !== "create_session") throw new Error("expected create-session action");
    if (alternate) {
      stored.runnerPolicy = { kind: "alternate", targets: [{
        runnerId: "runner-2", workspaceId: "runner-2-workspace", agentId: "alternate-agent",
        installationBindings: { agent: saved },
      }] };
    } else {
      stored.action.installationBindings = { agent: saved };
    }
    const machines = [installed(runners[0]!, "selected"), installed(runners[1]!, "selected")];
    const fixture = await mountFixture([stored], {}, {}, [], {}, machines);
    try {
      await openPage(fixture, stored.name);
      await openEdit(fixture);
      assert.match(fixture.container.textContent ?? "",
        alternate ? SAVED_ALTERNATE_INSTALLATION_WARNING : SAVED_INSTALLATION_WARNING);
      await act(async () => { button(fixture.container, "Use Current Installation").click(); });
      // Rediscovery while the editor is open: another installation is now selected on that machine.
      await fixture.pushRunners(alternate
        ? [machines[0]!, installed(runners[1]!, "other")]
        : [installed(runners[0]!, "other"), machines[1]!]);
      await saveChanges(fixture);
      assert.equal(fixture.updates.length, 0);
      const field = choiceTrigger(fixture.container, alternate ? "Other Agent" : "Agent");
      assert.equal(field?.getAttribute("aria-invalid"), "true");
      assert.match(fixture.container.querySelector(`#${field?.getAttribute("aria-describedby")}`)?.textContent ?? "", alternate
        ? /Choose an available installation of this agent on the other machine\./
        : /Choose an available installation of this agent on this machine\./);
      assertNoDomNode(fixture.container.querySelector(".notice.t-danger"), "a field's error is not repeated in the notice");
    } finally {
      await unmountFixture(fixture);
    }
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
    await openPage(fixture, "Pinned Sweep");
    const agentLabel = (id: string) => agentDisplayName(machine.agents.find((agent) => agent.id === id)!, machine.agents);
    // The page names the agent the scheduler will start: the rediscovered installation's, not the
    // stored id's, which now names another agent (CR-1.2).
    assert.equal(fixture.container.querySelector(".automation-sentence")?.textContent,
      `Starts ${agentLabel("system-new")} in runner-1-workspace on runner-1.`);
    await openEdit(fixture);
    assert.equal(shownValue(fixture.container, "Agent"), agentLabel("system-new"));
    await setLabeledInput(fixture.container, "Name", "Pinned Sweep Renamed");
    await saveChanges(fixture);
    const action = fixture.updates[0]?.spec.action;
    assert.equal(action?.kind === "create_session" && action.request.agentId, "system-new");
    assert.equal(action?.kind === "create_session" &&
      action.installationBindings?.agent?.installationId, "system");
    // The saved name, which the fixture does not store: the page reloads the original.
    await reopenEdit(fixture, "Pinned Sweep Renamed");
    await choose(fixture.container, "Agent", agentLabel("manual"));
    await saveChanges(fixture);
    assert.equal(fixture.updates[1]?.spec.action.kind === "create_session" &&
      fixture.updates[1].spec.action.request.agentId, "manual",
    "switching to a config-authored agent clears the automatic installation rebind");
    await reopenEdit(fixture, "Pinned Sweep");
    await choose(fixture.container, "Agent", agentLabel("rich-agent"));
    await saveChanges(fixture);
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
    await openPage(fixture, "Workflow Sweep");
    await openEdit(fixture);
    await act(async () => { button(fixture.container, "Use Current Installation").click(); });
    await saveChanges(fixture);
    const action = fixture.updates[0]?.spec.action;
    assert.equal(action?.kind === "workflow_run" && action.request.agentBindings?.orchestrator, "orchestrator");
    assert.equal(action?.kind === "workflow_run" && action.request.orchestratorAgentId, undefined);
    assert.equal(action?.kind === "workflow_run" &&
      action.installationBindings?.["role:orchestrator"]?.installationId, "system");
    await reopenEdit(fixture, "Workflow Sweep");
    await choose(fixture.container, "Worker Agent",
      agentOptions(machine.agents).find((option) => option.agent.id === "manual")!.label);
    await saveChanges(fixture);
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
    await openPage(fixture, "Workflow Switch");
    await openEdit(fixture);
    await choose(fixture.container, "Workflow", "new-graph");
    assert.doesNotMatch(fixture.container.textContent ?? "", SAVED_ROLE_WARNING);
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
    await openPage(fixture, "Workflow Machine");
    await openEdit(fixture);
    await choose(fixture.container, "Machine", "runner-2");
    assert.doesNotMatch(fixture.container.textContent ?? "", SAVED_ROLE_WARNING);
    assert.match(choiceTrigger(fixture.container, "Worker Agent")?.getAttribute("aria-label") ?? "",
      /Worker Agent: Rich Agent/,
    "the new Machine's same-id installation must not replace the role shown in the editor");
    await saveChanges(fixture);
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
    await openPage(fixture, "Alternate Workflow Machine");
    await openEdit(fixture);
    await choose(fixture.container, "Other Machine", "runner-3");
    assert.doesNotMatch(fixture.container.textContent ?? "", SAVED_ALTERNATE_ROLE_WARNING);
    assert.match(choiceTrigger(fixture.container, "Other Worker Agent")?.getAttribute("aria-label") ?? "",
      /Other Worker Agent: Configured Alternate/);
    await saveChanges(fixture);
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
    await openPage(fixture, "Primary Switch Alternate");
    await openEdit(fixture);
    assert.match(choiceTrigger(fixture.container, "Other Worker Agent")?.getAttribute("aria-label") ?? "",
      /Other Worker Agent: Codex App Server/);
    await choose(fixture.container, "Worker Agent", "Claude Code");
    assert.match(choiceTrigger(fixture.container, "Other Worker Agent")?.getAttribute("aria-label") ?? "",
      /Other Worker Agent: Claude Code/,
    "the alternate must follow an edited primary role when it has no override");
    await choose(fixture.container, "Machine", "runner-3");
    assert.match(choiceTrigger(fixture.container, "Other Worker Agent")?.getAttribute("aria-label") ?? "",
      /Other Worker Agent: Claude Code/,
    "the alternate must not keep the old primary role override after that override is dropped");
    assert.equal(choiceTrigger(fixture.container, "Other Orchestrator Agent"), undefined,
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
    await openPage(fixture, "Inherited Alternate Pins");
    await openEdit(fixture);
    const alternateRole = () => choiceTrigger(fixture.container, "Other Worker Agent")?.getAttribute("aria-label") ?? "";
    const alternateOrchestrator = () => choiceTrigger(fixture.container, "Other Orchestrator Agent")?.getAttribute("aria-label") ?? "";
    assert.match(alternateRole(), /Claude Code/);
    assert.match(alternateOrchestrator(), /Claude Code/);

    await choose(fixture.container, "Worker Agent", "Codex App Server");
    await choose(fixture.container, "Orchestrator Agent", "Codex App Server");
    assert.match(alternateRole(), /Codex App Server/, "inherited role must display the identity that saving will pin");
    assert.match(alternateOrchestrator(), /Codex App Server/, "inherited Orchestrator must follow the primary edit");
    assert.doesNotMatch(fixture.container.textContent ?? "", SAVED_ALTERNATE_ROLE_OR_ORCHESTRATOR_WARNING);

    await saveChanges(fixture);
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
    await openPage(unavailableFixture, "Inherited Alternate Pins");
    await openEdit(unavailableFixture);
    await choose(unavailableFixture.container, "Worker Agent", "Codex App Server");
    await choose(unavailableFixture.container, "Orchestrator Agent", "Codex App Server");
    assert.match(choiceTrigger(unavailableFixture.container, "Other Worker Agent")?.getAttribute("aria-label") ?? "",
      /other-agent \(Unavailable\)/);
    assert.match(choiceTrigger(unavailableFixture.container, "Other Orchestrator Agent")?.getAttribute("aria-label") ?? "",
      /other-agent \(Unavailable\)/);
    assert.equal([...unavailableFixture.container.querySelectorAll(".notice.t-warning")]
      .filter((alert) => SAVED_ALTERNATE_ROLE_OR_ORCHESTRATOR_WARNING.test(alert.textContent ?? ""))
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
    await openPage(fixture, "Unbound Orchestrator");
    assert.match(fixture.container.textContent ?? "", CARD_INSTALLATION_ALERT);
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
    await openPage(fixture, "Alternate Missing");
    assert.match(fixture.container.textContent ?? "", CARD_INSTALLATION_ALERT);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a waiting target's resolution error is the page's warning notice, Waiting for its machine", async () => {
  const stored = schedule("waiting-target", "Waiting Target");
  stored.targetHealth = {
    scheduledFor: 60_000, firstSeenAt: 60_001,
    error: "None of this automation's machines can run it now. " +
      "Check that the machine is online and up to date and still has the workspace and project.",
  };
  const fixture = await mountFixture([stored]);
  try {
    assert.match(cardToggle(fixture.container, "Waiting Target").textContent ?? "", /Target Unavailable/);
    await openPage(fixture, "Waiting Target");
    const notice = fixture.container.querySelector(".automation-notice-slot .notice.t-warning");
    assert.equal(notice?.querySelector(".notice-title")?.textContent, "Waiting for runner-1");
    assert.match(notice?.querySelector(".notice-body")?.textContent ?? "",
      /^None of this automation's machines can run it now\./);
    assertNoDomNode(fixture.container.querySelector('[role="alert"]'), "a warning is not an alert");
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
    await openPage(fixture, "Legacy Installation");
    assert.doesNotMatch(fixture.container.textContent ?? "",
      CARD_INSTALLATION_ALERT);
    await openEdit(fixture);
    assert.doesNotMatch(fixture.container.textContent ?? "",
      SAVED_INSTALLATION_WARNING);
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
    await openPage(fixture, "Explicit Unbound");
    assert.match(fixture.container.textContent ?? "",
      CARD_INSTALLATION_ALERT);
    await openEdit(fixture);
    assert.match(fixture.container.textContent ?? "",
      SAVED_INSTALLATION_WARNING);
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
      await openPage(fixture, stored.name);
      assert.equal(CARD_INSTALLATION_ALERT.test(
        fixture.container.textContent ?? ""), explicit);
      await openEdit(fixture);
      assert.equal(SAVED_ALTERNATE_INSTALLATION_WARNING.test(
        fixture.container.textContent ?? ""), explicit);
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("a card's heading opens its automation's page, and the list reads the list alone", async () => {
  const fixture = await mountFixture([
    schedule("automation-a", "Alpha"),
    schedule("automation-b", "Beta", false),
  ]);
  try {
    const alpha = cardToggle(fixture.container, "Alpha");
    // A native button, so pointer, touch, Enter and Space all open it; it no longer discloses.
    assert.equal(alpha.tagName, "BUTTON");
    assert.equal(alpha.getAttribute("aria-expanded"), null);
    assert.equal(alpha.getAttribute("aria-controls"), null);
    assert.doesNotMatch(alpha.textContent ?? "", /▸/);
    assert.equal(alpha.querySelector(".automation-card-action")?.textContent, "Create rich-agent session on runner-1");
    assert.equal(alpha.querySelector(".status.t-success")?.textContent, "Enabled");
    assert.equal(cardToggle(fixture.container, "Beta").querySelector(".status.t-neutral")?.textContent, "Paused");
    // The card body is gone: the heading is the card's only control.
    assert.equal(fixture.container.querySelectorAll(".automation-card button").length, 2);
    assert.equal(fixture.container.querySelectorAll(".automation-history, .automation-trigger").length, 0);
    assert.deepEqual(fixture.requests, ["list"], "the list reads no automation's history or triggers");

    await openPage(fixture, "Alpha");
    assert.equal(pageTitle(fixture.container), "Alpha");
    assertNoDomNode(fixture.container.querySelector(".automation-list"));
    assert.deepEqual(fixture.requests.slice(1).sort(), ["automation:automation-a", "triggers:automation-a"]);
  } finally {
    await unmountFixture(fixture);
  }
});

test("failed page reads stay busy until every request settles and a mutation then refreshes", async () => {
  const items = [schedule("automation-a", "Alpha")];
  const intervals = new Set<() => void>();
  let detailCalls = 0;
  let failDetails = false;
  let release: (() => void) | undefined;
  let mutationFinished = false;
  await withScopedClockOverrides(domWindow, {
    setInterval: (poll: () => void) => { intervals.add(poll); return 1; },
    clearInterval: () => {},
  }, async () => {
    const fixture = await mountAt(pageRoute("automation-a"), items, {}, {}, [], {}, runners, [], {
      automation: async () => {
        detailCalls += 1;
        if (failDetails) throw new Error("Detail unavailable");
        return { automation: items[0]!, executions: [], events: [] };
      },
      automationTriggers: async () => {
        if (failDetails) await new Promise<void>((resolve) => { release = resolve; });
        return { triggers: [] };
      },
      updateAutomation: async (_id, spec) => {
        items[0] = { ...items[0]!, ...spec };
        mutationFinished = true;
        return items[0];
      },
    });
    try {
      assert.equal(detailCalls, 1);
      failDetails = true;
      await act(async () => { for (const poll of intervals) poll(); });
      assert.equal(detailCalls, 2);
      await act(async () => { for (const poll of intervals) poll(); });
      assert.equal(detailCalls, 2, "a failed sibling cannot release the guard while another read is pending");
      await act(async () => { button(fixture.container, "Pause").click(); });
      assert.equal(mutationFinished, true);
      assert.equal(detailCalls, 2, "the post-mutation refresh waits for the outstanding poll");
      failDetails = false;
      await act(async () => { release?.(); });
      assert.equal(detailCalls, 3, "the mutation gets a fresh read after the earlier refresh settles");
      assert.ok(button(fixture.container, "Resume"), "the authoritative post-mutation state is rendered");
    } finally {
      release?.();
      await unmountFixture(fixture);
    }
  });
});

test("signed trigger editor sends an explicit prompt, parameter, and selector allowlist", async () => {
  const item = schedule("automation-a", "Alpha");
  item.action = { kind: "prompt_session", sessionId: "s_default", request: { text: "{{delivery.prompt}}" } };
  const fixture = await mountFixture([item]);
  try {
    await openPage(fixture, "Alpha");
    await chooseMoreAction(fixture, "Add Webhook Trigger…");
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
    await openPage(fixture, "Alpha");
    const history = fixture.container.querySelector<HTMLDetailsElement>("details.automation-history")!;
    history.open = true;
    assert.match(history.textContent ?? "", /Delivered Fields: Prompt · Parameters issue/);
    assert.match(history.textContent ?? "", /Prompt Digest aaaaaaaaaaaa…/);
    assert.doesNotMatch(history.textContent ?? "", /delivered prompt text|parameter value/);
  } finally {
    await unmountFixture(fixture);
  }
});

/* ------------- Polling and actions (the list's read, and the automation page's) ------------- */

/**
 * The failed read or action as the surface says it: the list's error line, or the sentence of the
 * automation page's one notice (#2968).
 */
function pageError(fixture: Fixture): string | null {
  const list = fixture.container.querySelector('.page > .automation-error[role="alert"]');
  if (list) return list.textContent;
  return fixture.container.querySelector(".automation-notice-slot .notice-body")?.textContent ?? null;
}

async function invokePolls(intervals: Set<() => void>): Promise<void> {
  await act(async () => { for (const poll of intervals) poll(); });
  await act(settle);
}

/** The page's reads, with a workflow action where the workflow read is the one under test. */
function pageItem(endpoint: "detail" | "trigger" | "workflow"): AutomationSchedule {
  return endpoint === "workflow" ? workflowAutomation("automation-a", "Alpha") : schedule("automation-a", "Alpha");
}

for (const failedEndpoint of ["detail", "trigger", "workflow"] as const) {
  test(`polling recovery clears a ${failedEndpoint} error only after the complete refresh`, async () => {
    const items = [pageItem(failedEndpoint)];
    const intervals = new Set<() => void>();
    let fail = false;
    let holdRecovery = false;
    let release: (() => void) | undefined;
    let detailCalls = 0;
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; },
      clearInterval: () => {},
    }, async () => {
      const reject = (endpoint: typeof failedEndpoint) => {
        if (fail && endpoint === failedEndpoint) throw new Error("Polling unavailable");
      };
      const fixture = await mountAt(pageRoute("automation-a"), items, {}, {}, [], {}, runners, [], {
        workflowDefinitions: async () => { reject("workflow"); return []; },
        automation: async (id) => {
          detailCalls++;
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
        assert.equal(detailCalls, 2, "a hidden skip cannot read or report recovery");
        assert.equal(pageError(fixture), "Polling unavailable");
        Object.defineProperty(domWindow.document, "visibilityState", { configurable: true, value: "visible" });
        holdRecovery = true;
        items[0] = { ...items[0]!, name: "Recovered" };
        await invokePolls(intervals);
        assert.equal(pageTitle(fixture.container), "Recovered");
        assert.equal(pageError(fixture), "Polling unavailable", "the automation's own read alone is not recovery");
        await invokePolls(intervals);
        assert.equal(detailCalls, 3, "a pending trigger read retains serialization");
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
  let failure: "trigger" | "workflow" | null = null;
  await withScopedClockOverrides(domWindow, {
    setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => {},
  }, async () => {
    const fixture = await mountAt(pageRoute("automation-a"), [pageItem("workflow")], {}, {}, [], {}, runners, [], {
      automationTriggers: async () => {
        if (failure === "trigger") throw new Error("Triggers unavailable");
        return { triggers: [] };
      },
      workflowDefinitions: async () => {
        if (failure === "workflow") throw new Error("Workflow unavailable");
        return [];
      },
    });
    try {
      failure = "trigger";
      await invokePolls(intervals);
      assert.equal(pageError(fixture), "Triggers unavailable");
      failure = "workflow";
      await invokePolls(intervals);
      assert.equal(pageError(fixture), "Workflow unavailable");
      failure = null;
      await invokePolls(intervals);
      assert.equal(pageError(fixture), null);
    } finally { await unmountFixture(fixture); }
  });
});

test("the list's failed read shows above it, and the next complete read clears it", async () => {
  const intervals = new Set<() => void>();
  let fail = false;
  await withScopedClockOverrides(domWindow, {
    setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => {},
  }, async () => {
    const fixture = await mountFixture([schedule("automation-a", "Alpha")], {}, {}, [], {}, runners, [], {
      automations: async () => {
        if (fail) throw new Error("List unavailable");
        return { automations: [schedule("automation-a", "Alpha")] };
      },
    });
    try {
      fail = true;
      await invokePolls(intervals);
      assert.equal(pageError(fixture), "List unavailable");
      assert.ok(maybeCardToggle(fixture.container, "Alpha"), "the last-known cards stay");
      fail = false;
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
      const fixture = await mountAt(pageRoute("automation-a"), [item], {}, {}, [], {}, runners, [], {
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
        holdPoll = true;
        await invokePolls(intervals);
        await act(async () => { button(fixture.container, "Pause").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "Pause failed");
        assert.equal(fixture.container.querySelector(".automation-notice-slot .notice-title")?.textContent,
          "Automation Not Paused", "the notice names the action that failed");
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
    const detail = () => ({ automation: item, executions: [], events: [] });
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; },
      clearInterval: () => { intervals.clear(); },
    }, async () => {
      const fixture = await mountAt(pageRoute("automation-a"), [item], {}, {}, [], {}, runners, [], {
        automationTriggers: async () => {
          if (holdOld) {
            await new Promise<void>((resolve) => { release = resolve; });
            if (oldPollFails) throw new Error("Obsolete poll failed");
          }
          return { triggers: [] };
        },
      });
      try {
        holdOld = true;
        await invokePolls(intervals);
        await fixture.replaceClient({
          automation: async () => { obsoleteQueuedReads++; return detail(); },
        });
        await fixture.replaceClient({
          automation: async () => { newReads++; return detail(); },
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

for (const surface of ["list", "page"] as const) {
  test(`unmounting the ${surface} revokes a pending poll and removes its timer before its rejection settles`, async () => {
    const intervals = new Set<() => void>();
    let hold = false;
    let release: (() => void) | undefined;
    let reads = 0;
    const item = schedule("automation-a", "Alpha");
    const read = async () => {
      reads++;
      if (hold) {
        await new Promise<void>((resolve) => { release = resolve; });
        throw new Error("Unmounted polling failure");
      }
    };
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; },
      clearInterval: () => { intervals.clear(); },
    }, async () => {
      const fixture = surface === "list"
        ? await mountFixture([], {}, {}, [], {}, runners, [], {
          automations: async () => { await read(); return { automations: [] }; },
        })
        : await mountAt(pageRoute("automation-a"), [item], {}, {}, [], {}, runners, [], {
          automation: async () => { await read(); return { automation: item, executions: [], events: [] }; },
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
}

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
      const fixture = await mountAt(pageRoute("automation-a"), [item], {}, {}, [], {}, runners, [], {
        automation: async () => { oldReads++; return { automation: item, executions: [], events: [] }; },
        updateAutomation: async () => {
          await new Promise<void>((resolve) => { release = resolve; });
          if (mutationFails) throw new Error("Obsolete action failed");
          return item;
        },
      });
      try {
        await act(async () => { button(fixture.container, "Pause").click(); });
        await fixture.replaceClient({ automation: async () => { throw new Error("New client polling failed"); } });
        assert.equal(pageError(fixture), "New client polling failed");
        await act(async () => { release?.(); });
        await act(settle);
        assert.equal(pageError(fixture), "New client polling failed");
        assert.equal(oldReads, 1, "the obsolete action cannot read with its old client");
      } finally { release?.(); await unmountFixture(fixture); }
    });
  });
}

for (const failedEndpoint of ["detail", "trigger", "workflow"] as const) {
  test(`accepted Pause recovers its post-mutation ${failedEndpoint} read error`, async () => {
    const items = [pageItem(failedEndpoint)];
    const intervals = new Set<() => void>();
    let fail = false;
    let writes = 0;
    const reads: Record<string, number> = failedEndpoint === "workflow"
      ? { workflow: 0, detail: 0, trigger: 0 } : { detail: 0, trigger: 0 };
    const read = (endpoint: string) => {
      reads[endpoint] = (reads[endpoint] ?? 0) + 1;
      if (fail && endpoint === failedEndpoint) throw new Error("Accepted Pause refresh failed");
    };
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => {},
    }, async () => {
      const fixture = await mountAt(pageRoute("automation-a"), items, {}, {}, [], {}, runners, [], {
        workflowDefinitions: async () => { read("workflow"); return []; },
        automation: async () => { read("detail"); return { automation: items[0]!, executions: [], events: [] }; },
        automationTriggers: async () => { read("trigger"); return { triggers: [] }; },
        updateAutomation: async (_id, spec) => {
          writes++;
          items[0] = { ...items[0]!, ...spec };
          fail = true;
          return items[0]!;
        },
      });
      try {
        await act(async () => { button(fixture.container, "Pause").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "Accepted Pause refresh failed");
        assert.equal(fixture.container.querySelector(".automation-notice-slot .notice-title")?.textContent, "Couldn't Refresh");
        assert.equal(items[0]!.enabled, false);
        fail = false;
        items[0] = { ...items[0]!, name: "Recovered" };
        const before = { ...reads };
        await invokePolls(intervals);
        for (const endpoint of Object.keys(reads)) {
          assert.equal(reads[endpoint], before[endpoint]! + 1, `healthy ${endpoint} read completed`);
        }
        assert.equal(pageTitle(fixture.container), "Recovered");
        assert.ok(button(fixture.container, "Resume"));
        assert.equal(pageError(fixture), null);
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
      const fixture = await mountAt(pageRoute("automation-a"), items, {}, {}, [], {}, runners, [], {
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
        await act(async () => { button(fixture.container, "Pause").click(); });
        await act(settle);
        await invokePolls(intervals);
        assert.equal(pageError(fixture), outcome === "accepted" ? null : `Pause ${outcome}`);
        assert.equal(items[0]!.enabled, outcome === "rejected");
        assert.ok(button(fixture.container, outcome === "rejected" ? "Pause" : "Resume"));
        assert.equal(writes, 1);
      } finally { await unmountFixture(fixture); }
    });
  });
}

test("post-mutation read recovery needs a complete visible refresh", async () => {
  const items = [pageItem("workflow")];
  const intervals = new Set<() => void>();
  let fail = false;
  let hold = false;
  let writes = 0;
  let detailReads = 0;
  let release: (() => void) | undefined;
  await withScopedClockOverrides(domWindow, {
    setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => {},
  }, async () => {
    const fixture = await mountAt(pageRoute("automation-a"), items, {}, {}, [], {}, runners, [], {
      automation: async () => { detailReads++; return { automation: structuredClone(items[0]!), executions: [], events: [] }; },
      workflowDefinitions: async () => { if (fail) throw new Error("Post-action workflow unavailable"); return []; },
      automationTriggers: async () => {
        if (hold) await new Promise<void>((resolve) => { release = resolve; });
        return { triggers: [] };
      },
      updateAutomation: async (_id, spec) => { writes++; items[0] = { ...items[0]!, ...spec }; fail = true; return items[0]!; },
    });
    const visibility = Object.getOwnPropertyDescriptor(domWindow.document, "visibilityState");
    try {
      await act(async () => { button(fixture.container, "Pause").click(); });
      await act(settle);
      assert.equal(pageError(fixture), "Post-action workflow unavailable");
      await invokePolls(intervals);
      assert.equal(pageError(fixture), "Post-action workflow unavailable", "another failed refresh is not recovery");
      fail = false;
      const beforeHidden = detailReads;
      Object.defineProperty(domWindow.document, "visibilityState", { configurable: true, value: "hidden" });
      await invokePolls(intervals);
      assert.equal(detailReads, beforeHidden);
      assert.equal(pageError(fixture), "Post-action workflow unavailable");
      Object.defineProperty(domWindow.document, "visibilityState", { configurable: true, value: "visible" });
      hold = true;
      items[0] = { ...items[0]!, name: "Fresh Name" };
      await invokePolls(intervals);
      assert.equal(pageTitle(fixture.container), "Fresh Name");
      assert.equal(pageError(fixture), "Post-action workflow unavailable", "a partial read cannot clear it");
      const beforeBusy = detailReads;
      await invokePolls(intervals);
      assert.equal(detailReads, beforeBusy, "busy polls preserve serialization");
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
    const items = [pageItem("workflow")];
    const intervals = new Set<() => void>();
    let failAfterWrite = false;
    let holdRecovery = false;
    let writes = 0;
    let release: (() => void) | undefined;
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => {},
    }, async () => {
      const fixture = await mountAt(pageRoute("automation-a"), items, {}, {}, [], {}, runners, [], {
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
          if (writes > 1) throw new Error("New Resume write failed");
          items[0] = { ...items[0]!, ...spec }; failAfterWrite = true; return items[0]!;
        },
      });
      try {
        await act(async () => { button(fixture.container, "Pause").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "Old post-action read failed");
        failAfterWrite = false; holdRecovery = true;
        await invokePolls(intervals);
        await act(async () => { button(fixture.container, "Resume").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "New Resume write failed");
        await act(async () => { release?.(); });
        await act(settle);
        assert.equal(pageError(fixture), "New Resume write failed");
        holdRecovery = false;
        await invokePolls(intervals);
        assert.equal(pageError(fixture), "New Resume write failed");
        assert.equal(writes, 2);
      } finally { release?.(); await unmountFixture(fixture); }
    });
  });
}

for (const obsoleteReadFails of [false, true]) {
  test(`API replacement revokes an accepted write's obsolete ${obsoleteReadFails ? "failed" : "healthy"} recovery`, async () => {
    const items = [pageItem("workflow")];
    const intervals = new Set<() => void>();
    let hold = false;
    let failAfterWrite = false;
    let release: (() => void) | undefined;
    let writes = 0;
    let detailReads = 0;
    await withScopedClockOverrides(domWindow, {
      setInterval: (poll: () => void) => { intervals.add(poll); return 1; }, clearInterval: () => { intervals.clear(); },
    }, async () => {
      const fixture = await mountAt(pageRoute("automation-a"), items, {}, {}, [], {}, runners, [], {
        automation: async () => { detailReads++; return { automation: structuredClone(items[0]!), executions: [], events: [] }; },
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
        await act(async () => { button(fixture.container, "Pause").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "Accepted-write refresh failed");
        failAfterWrite = false;
        hold = true;
        await invokePolls(intervals);
        assert.ok(release, "the old client's recovery is in flight");
        await fixture.replaceClient({
          workflowDefinitions: async () => [],
          updateAutomation: async () => { throw new Error("Replacement Resume failed"); },
        });
        await act(async () => { button(fixture.container, "Resume").click(); });
        await act(settle);
        assert.equal(pageError(fixture), "Replacement Resume failed");
        await act(async () => { release?.(); });
        await act(settle);
        assert.equal(pageError(fixture), "Replacement Resume failed");
        await invokePolls(intervals);
        assert.equal(pageError(fixture), "Replacement Resume failed");
        assert.equal(writes, 1);
        assert.equal(detailReads, 5, "initial, accepted-action, old recovery and two current-client reads only");
      } finally { release?.(); await unmountFixture(fixture); }
    });
  });
}

/* ------------------------- The Automation editor's routes (#2967) ------------------------- */

function editorRoot(container: HTMLDivElement): HTMLElement {
  const root = container.querySelector<HTMLElement>(".automation-editor");
  assert.ok(root, "the Automation editor is rendered");
  return root;
}

function editorTitle(container: HTMLDivElement): string | null {
  return container.querySelector(".detail-bar-title")?.textContent ?? null;
}

async function goBack(fixture: Fixture): Promise<void> {
  const back = fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Back to Automations"]');
  assert.ok(back, "the editor's Back is rendered");
  await act(async () => { back.click(); });
  await act(settle);
}

/** Mount on a route, as a reload or a link to it does. */
async function mountAt(view: View, ...args: Parameters<typeof mountFixture>): Promise<Fixture> {
  initialView = view;
  try {
    return await mountFixture(...args);
  } finally {
    initialView = { name: "automations" };
  }
}

const NEW_ROUTE: View = { name: "automations", editor: { kind: "new" } };
const editRoute = (automationId: string): View => ({ name: "automations", editor: { kind: "edit", automationId } });
const pageRoute = (id: string): View => ({ name: "automation", id });

function workflowAutomation(id: string, name: string): AutomationSchedule {
  const stored = schedule(id, name);
  stored.action = { kind: "workflow_run", request: {
    runnerId: "runner-1", workspaceId: "runner-1-workspace", workflowId: "graph-1", task: "Build",
  } };
  return stored;
}

const reviewGraph: WorkflowDefinition = {
  workflowId: "graph-1", version: 1, name: "Graph", source: "custom", maxTransitions: 1,
  createdBy: { kind: "human", id: "test" }, createdAt: 1, edges: [],
  nodes: [
    { nodeId: "build", kind: "agent", role: "builder", agentId: "rich-agent",
      inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 },
    { nodeId: "approve", kind: "human_gate", role: "approver",
      inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 },
  ],
};

test("New Automation opens the editor in the list's place and returns to the list; Edit returns to the automation's page", async () => {
  const fixture = await mountFixture([schedule("automation-1", "Nightly")]);
  try {
    assertNoDomNode(fixture.container.querySelector(".automation-editor"), "the list renders no editor");
    assertNoDomNode(fixture.container.querySelector('[aria-label="Close Automation Editor"]'));

    await openNew(fixture);
    assert.equal(editorTitle(fixture.container), "New Automation");
    assertNoDomNode(fixture.container.querySelector(".automation-list"));
    assertNoDomNode(fixture.container.querySelector('[aria-label="Close Automation Editor"]'));
    await goBack(fixture);
    assert.ok(fixture.container.querySelector(".automation-list"));

    await openPage(fixture, "Nightly");
    await openEdit(fixture);
    assert.equal(editorTitle(fixture.container), "Edit Nightly");
    // #2968: the editor's Back names the automation and returns to its page.
    const back = fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Back to Nightly"]');
    assert.ok(back, "Back to Nightly is rendered");
    assertNoDomNode(fixture.container.querySelector('button[aria-label="Back to Automations"]'));
    await act(async () => { back.click(); });
    await act(settle);
    assert.equal(pageTitle(fixture.container), "Nightly");
    await act(async () => {
      fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Back to Automations"]')!.click();
    });
    await act(settle);
    assert.ok(fixture.container.querySelector(".automation-list"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("each editor route opens directly, in four sections, with no native select for any action", async () => {
  for (const view of [NEW_ROUTE, editRoute("automation-1")]) {
    const fixture = await mountAt(view, [schedule("automation-1", "Nightly")], {}, {}, [], {}, runners, [reviewGraph]);
    try {
      const root = editorRoot(fixture.container);
      assert.equal(editorTitle(fixture.container), view.name === "automations" && view.editor?.kind === "new"
        ? "New Automation" : "Edit Nightly");
      assert.deepEqual([...root.querySelectorAll(".section-title")].map((title) => title.textContent),
        ["What to Run", "When to Run", "Limits", "Notifications"]);
      for (const action of ["Prompt a Session", "Run a Workflow", "Start a Session"]) {
        await chooseAction(fixture.container, action);
        await choose(fixture.container, "If the Machine Is Offline", action === "Prompt a Session"
          ? "Give Up After a While" : "Use Another Machine");
        assert.equal(root.querySelectorAll("select").length, 0, `${action} renders no native select`);
      }
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("an edit route for an automation that no longer exists says so and offers Back", async () => {
  const fixture = await mountAt(editRoute("gone"), [], {}, {}, [], {}, runners, [], {
    automation: async () => { throw new ApiError("automation not found", 404); },
  });
  try {
    assert.match(editorRoot(fixture.container).textContent ?? "", /Automation Not Found/);
    assertNoDomNode(fixture.container.querySelector(".automation-editor-form"));
    assert.ok(button(fixture.container, "Back to Automations"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("a new automation starts on the first online machine, and switching the action keeps Folder and Agent filled", async () => {
  const offline: RunnerView = { ...runners[0]!, status: "offline" };
  const fixture = await mountAt(NEW_ROUTE, [], {}, {}, [], {}, [offline, runners[1]!], [reviewGraph]);
  try {
    assert.equal(shownValue(fixture.container, "Machine"), "runner-2");
    const machine = choiceTrigger(fixture.container, "Machine")!;
    await act(async () => { machine.click(); });
    const offlineOption = [...fixture.container.querySelectorAll('[role="option"]')]
      .find((option) => option.querySelector('[id$="-label"]')?.textContent === "runner-1");
    assert.match(offlineOption?.textContent ?? "", /Offline/, "an offline machine carries its badge in the list");
    await act(async () => { machine.click(); });
    for (const action of ["Prompt a Session", "Run a Workflow", "Start a Session"]) {
      await chooseAction(fixture.container, action);
      if (action === "Prompt a Session") continue;
      assert.equal(shownValue(fixture.container, "Folder"), "runner-2-workspace", `${action} keeps a Folder`);
      if (action === "Start a Session") assert.equal(shownValue(fixture.container, "Agent"), "Alternate Agent");
    }
  } finally {
    await unmountFixture(fixture);
  }

  // An automation that prompts a session has no machine; starting a session instead derives one.
  const prompt = schedule("prompt", "Prompt Sweep");
  prompt.action = { kind: "prompt_session", sessionId: "session-1", request: { text: "Continue." } };
  const edit = await mountAt(editRoute("prompt"), [prompt]);
  try {
    await chooseAction(edit.container, "Start a Session");
    assert.equal(shownValue(edit.container, "Machine"), "runner-1");
    assert.equal(shownValue(edit.container, "Folder"), "runner-1-workspace");
    assert.equal(shownValue(edit.container, "Agent"), "Rich Agent");
  } finally {
    await unmountFixture(edit);
  }
});

test("an offline stored other machine shows in Other Machine with its Offline badge", async () => {
  const stored = schedule("offline-alternate", "Offline Alternate");
  stored.runnerPolicy = { kind: "alternate", targets: [
    { runnerId: "runner-2", workspaceId: "runner-2-workspace", agentId: "alternate-agent" },
  ], expireAfterMinutes: 30 };
  const fixture = await mountAt(editRoute("offline-alternate"), [stored], {}, {}, [], {}, [
    runners[0]!, { ...runners[1]!, status: "offline" }, runners[2]!,
  ]);
  try {
    const trigger = choiceTrigger(fixture.container, "Other Machine");
    assert.equal(trigger?.getAttribute("aria-label"), "Other Machine: runner-2, Offline");
    assert.match(trigger?.textContent ?? "", /runner-2\s*Offline/);
    assert.equal(shownValue(fixture.container, "Other Agent"), "Alternate Agent");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a save refused for the other machine marks Other Machine; any other refusal is one notice above the save bar", async () => {
  const stored = schedule("alternate-refused", "Alternate Refused");
  stored.runnerPolicy = { kind: "alternate", targets: [
    { runnerId: "runner-2", workspaceId: "runner-2-workspace", agentId: "alternate-agent" },
  ], expireAfterMinutes: 60 };
  let refusal = "alternate runner policy requires unique explicit compatible targets and an optional bounded expiry";
  const fixture = await mountAt(editRoute("alternate-refused"), [stored], {}, {}, [], {}, runners, [], {
    updateAutomation: async () => { throw new ApiError(refusal, 400); },
  });
  try {
    await setLabeledInput(fixture.container, "Name", "Renamed");
    await saveChanges(fixture);
    const other = choiceTrigger(fixture.container, "Other Machine")!;
    assert.equal(other.getAttribute("aria-invalid"), "true");
    assert.match(fixture.container.querySelector(`#${other.getAttribute("aria-describedby")}`)?.textContent ?? "",
      /alternate runner policy requires/);
    assert.ok(fixture.container.ownerDocument.activeElement === other, "focus moves to the field it marks");
    assertNoDomNode(fixture.container.querySelector(".notice.t-danger"));
    assert.ok(fixture.container.querySelector(".save-bar.is-error"));

    refusal = "Synthetic control plane failure";
    await act(async () => { button(fixture.container, "Try Again").click(); });
    await act(settle);
    assert.equal(choiceTrigger(fixture.container, "Other Machine")?.getAttribute("aria-invalid"), null);
    const notices = [...fixture.container.querySelectorAll(".notice.t-danger")];
    assert.equal(notices.length, 1);
    assert.match(notices[0]!.textContent ?? "",
      /These changes weren't saved\. Fix what the details below describe, then try again\./);
    const form = fixture.container.querySelector(".automation-editor-form")!;
    assert.ok(form.lastElementChild === notices[0], "the notice ends the form");
    assert.ok(form.nextElementSibling?.classList.contains("save-bar"), "the save bar follows it directly");
    await act(async () => { button(fixture.container, "Show Details").click(); });
    assert.match(notices[0]!.textContent ?? "", /Synthetic control plane failure/);
    // Nothing at the top of the page: the detail bar is followed by the form's column.
    assertNoDomNode(fixture.container.querySelector(".automation-error"));
    assert.ok(fixture.container.querySelector(".automation-editor > .detail-bar + .page > .automation-editor-form"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("on an edit route the save bar appears with a change, discards it, saves it and turns into the error bar", async () => {
  let fail = false;
  const fixture = await mountAt(editRoute("automation-1"), [schedule("automation-1", "Nightly")], {}, {}, [], {}, runners, [], {
    updateAutomation: async (_id: string, spec: AutomationSpec) => {
      if (fail) throw new Error("Synthetic failure");
      fixture.updates.push({ id: "automation-1", spec: structuredClone(spec) });
      return { ...schedule("automation-1", "Nightly"), ...spec };
    },
  });
  try {
    assertNoDomNode(fixture.container.querySelector(".save-bar"), "a clean edit shows no save bar");
    await setLabeledInput(fixture.container, "Name", "Nightly Renamed");
    const bar = () => fixture.container.querySelector(".save-bar");
    assert.match(bar()?.textContent ?? "", /Unsaved changes/);
    assert.deepEqual([...bar()!.querySelectorAll("button")].map((item) => item.textContent), ["Discard", "Save Changes"]);
    await act(async () => { button(fixture.container, "Discard").click(); });
    assertNoDomNode(bar());
    assert.equal((editorRoot(fixture.container).querySelector("input") as HTMLInputElement).value, "Nightly");

    await setLabeledInput(fixture.container, "Name", "Nightly Renamed");
    await saveChanges(fixture);
    assert.equal(fixture.updates.length, 1);
    assertNoDomNode(bar(), "a saved edit is clean again");
    assert.equal(editorTitle(fixture.container), "Edit Nightly Renamed");

    fail = true;
    await setLabeledInput(fixture.container, "Name", "Nightly Again");
    await saveChanges(fixture);
    assert.ok(bar()?.classList.contains("is-error"));
    assert.match(bar()?.textContent ?? "", /Couldn't save the changes\./);
    assert.ok(button(fixture.container, "Try Again"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("a new automation's save bar shows Cancel and Create Automation at once, and Create keeps its label while busy", async () => {
  let release: () => void = () => {};
  const creates: AutomationSpec[] = [];
  const fixture = await mountAt(NEW_ROUTE, [], {}, {}, [], {}, runners, [], {
    createAutomation: async (spec: AutomationSpec) => {
      creates.push(structuredClone(spec));
      await new Promise<void>((resolve) => { release = resolve; });
      return { ...schedule("created", spec.name), ...spec };
    },
  });
  try {
    const bar = fixture.container.querySelector(".save-bar");
    assert.deepEqual([...bar!.querySelectorAll("button")].map((item) => item.textContent), ["Cancel", "Create Automation"]);
    await setLabeledInput(fixture.container, "Name", "Morning Digest");
    await act(async () => { button(fixture.container, "Create Automation").click(); });
    const create = button(fixture.container, "Create Automation");
    assert.equal(create.getAttribute("aria-busy"), "true");
    assert.equal(create.getAttribute("data-busy-spinner"), "prepended", "the spinner sits beside the kept label");
    assert.equal(creates.length, 1);
    assert.equal(creates[0]!.name, "Morning Digest");
    await act(async () => { release(); });
    await act(settle);
    assertNoDomNode(fixture.container.querySelector(".automation-editor"), "a created automation returns to the list");
  } finally {
    await unmountFixture(fixture);
  }

  const cancelled = await mountAt(NEW_ROUTE, []);
  try {
    await act(async () => { button(cancelled.container, "Cancel").click(); });
    await act(settle);
    assertNoDomNode(cancelled.container.querySelector(".automation-editor"));
  } finally {
    await unmountFixture(cancelled);
  }
});

test("with Multi-Agent Runs off, a stored workflow action keeps its choice, says why and saves unchanged", async () => {
  setExperimentFlag("multiAgent", false);
  try {
    const stored = workflowAutomation("workflow-off", "Workflow Off");
    const fixture = await mountAt(editRoute("workflow-off"), [stored], {}, {}, [], {}, runners, [reviewGraph]);
    try {
      const helper = [...fixture.container.querySelectorAll<HTMLElement>(".field-helper")]
        .find((item) => item.textContent === MULTI_AGENT_OFF_HELPER);
      assert.ok(helper, "the helper sentence renders");
      assertNoDomNode(helper.closest(".notice"), "it is a helper, not a notice");
      const workflowRow = [...fixture.container.querySelectorAll(".choice-row")]
        .find((row) => row.querySelector(".choice-row-title")?.textContent === "Run a Workflow");
      const input = workflowRow?.querySelector("input");
      assert.equal(input?.checked, true);
      assert.ok(input?.getAttribute("aria-describedby")?.split(" ").includes(helper.id),
        "Run a Workflow is described by the helper");
      assert.ok(helper.previousElementSibling?.classList.contains("choice-rows"), "it sits directly under the choices");
      // Roles are named by what they do, and a human step is the person.
      assert.ok(choiceTrigger(fixture.container, "Builder Agent"));
      const approver = [...fixture.container.querySelectorAll("label")]
        .find((label) => label.childNodes[0]?.textContent === "Approver")?.querySelector("input");
      assert.equal(approver?.value, "You, in the run");
      assert.equal(approver?.readOnly, true);

      await setLabeledInput(fixture.container, "Name", "Workflow Still Off");
      await saveChanges(fixture);
      assert.deepEqual(fixture.updates[0]?.spec.action, stored.action);
    } finally {
      await unmountFixture(fixture);
    }

    const fresh = await mountAt(NEW_ROUTE, [], {}, {}, [], {}, runners, [reviewGraph]);
    try {
      assert.deepEqual([...fresh.container.querySelectorAll(".choice-row-title")].map((title) => title.textContent),
        ["Start a Session", "Prompt a Session"]);
      assert.equal([...fresh.container.querySelectorAll(".field-helper")]
        .some((item) => item.textContent === MULTI_AGENT_OFF_HELPER), false);
    } finally {
      await unmountFixture(fresh);
    }
  } finally {
    setExperimentFlag("multiAgent", true);
  }
});

test("number fields are 96px wide, units sit in their helpers, and no label holds a unit", async () => {
  const fixture = await mountAt(NEW_ROUTE, []);
  try {
    await choose(fixture.container, "If a Run Is Missed", "Catch Up");
    await choose(fixture.container, "If the Machine Is Offline", "Give Up After a While");
    const field = (label: string) => [...fixture.container.querySelectorAll<HTMLLabelElement>("label.field")]
      .find((candidate) => candidate.childNodes[0]?.textContent === label);
    for (const [label, helper] of [["Catch Up at Most", "Missed runs"], ["Give Up After", "In minutes"],
      ["Tool Call Limit", "For each run."]] as const) {
      assert.ok(field(label)?.querySelector("input")?.classList.contains("w-xs"), `${label} is 96px`);
      assert.equal(field(label)?.querySelector(".field-helper")?.textContent, helper);
    }
    const cost = field("Cost Limit")?.querySelector(".input-affix.w-xs");
    assert.equal(cost?.firstElementChild?.textContent, "$", "Cost Limit's dollar sign is a prefix inside the field");
    const labels = [...editorRoot(fixture.container).querySelectorAll(".field-label, label.field > span:first-child")]
      .map((label) => label.textContent ?? "");
    assert.ok(labels.length > 10);
    assert.deepEqual(labels.filter((label) => /\(/.test(label)), [], "no field label holds a unit in parentheses");
  } finally {
    await unmountFixture(fixture);
  }
});

test("switching or reselecting the action never replaces a stored machine, folder or agent discovery cannot find", async () => {
  // Review finding CR-1.1: a nonempty stored runner absent from the snapshot was read as "no machine"
  // and replaced by the first one, and ChoiceRow reports a click on the checked action too.
  const stored = schedule("missing-machine", "Missing Machine");
  stored.action = { kind: "create_session", request: {
    runnerId: "runner-gone", workspaceId: "gone-workspace", agentId: "gone-agent", prompt: "Sweep.",
    useWorktree: false, config: { model: "opus" },
  }, installationBindings: { agent: { driver: "claude-code", context: { kind: "native" }, installationId: "system" } } };
  const fixture = await mountAt(editRoute("missing-machine"), [stored], {}, {}, [], {}, runners, [reviewGraph]);
  try {
    await chooseAction(fixture.container, "Start a Session");
    await chooseAction(fixture.container, "Prompt a Session");
    await chooseAction(fixture.container, "Run a Workflow");
    await chooseAction(fixture.container, "Start a Session");
    await setLabeledInput(fixture.container, "Name", "Missing Machine Renamed");
    await saveChanges(fixture);
    assert.equal(fixture.updates.length, 1);
    assert.deepEqual(fixture.updates[0]!.spec.action, stored.action,
      "the stored machine, folder, agent, config and installation binding round-trip");
  } finally {
    await unmountFixture(fixture);
  }

  // A stored folder or agent the machine no longer lists is kept the same way.
  const gone = schedule("missing-folder", "Missing Folder");
  if (gone.action.kind !== "create_session") throw new Error("expected create-session action");
  gone.action.request.workspaceId = "gone-workspace";
  gone.action.request.agentId = "gone-agent";
  const kept = await mountAt(editRoute("missing-folder"), [gone], {}, {}, [], {}, runners, [reviewGraph]);
  try {
    await chooseAction(kept.container, "Run a Workflow");
    await chooseAction(kept.container, "Start a Session");
    await setLabeledInput(kept.container, "Name", "Missing Folder Renamed");
    await saveChanges(kept);
    assert.deepEqual(kept.updates[0]!.spec.action, gone.action);
  } finally {
    await unmountFixture(kept);
  }
});

test("a create that settles after the person left does not navigate away from where they went", async () => {
  // Review finding CR-1.2: the create continuation navigated (replacing, so unasked) after its
  // editor had unmounted, discarding a newer editor's unsaved draft.
  let release: () => void = () => {};
  const confirmations: string[] = [];
  const toasts: string[] = [];
  feedback = {
    confirm: async (options) => { confirmations.push(options.title ?? ""); return true; },
    showToast: (message) => { toasts.push(message); return 1; },
    showUndo: () => 1,
    dismissToast: () => undefined,
  } as FeedbackContextValue;
  let fixture: Fixture;
  try {
    fixture = await mountFixture([schedule("automation-1", "Nightly")], {}, {}, [], {}, runners, [], {
      createAutomation: async (spec: AutomationSpec) => {
        await new Promise<void>((resolve) => { release = resolve; });
        return { ...schedule("created", spec.name), ...spec };
      },
    });
  } finally {
    feedback = null;
  }
  try {
    await openNew(fixture);
    await setLabeledInput(fixture.container, "Name", "Morning Digest");
    await act(async () => { button(fixture.container, "Create Automation").click(); });
    // Leave while the create is still running, and discard the draft when asked.
    await goBack(fixture);
    assert.deepEqual(confirmations, ["Discard Changes"]);
    assertNoDomNode(fixture.container.querySelector(".automation-editor"), "Back left the editor");

    // Another editor, with an unsaved change of its own.
    await openPage(fixture, "Nightly");
    await openEdit(fixture);
    await setLabeledInput(fixture.container, "Name", "Nightly Draft");
    assert.equal(editorTitle(fixture.container), "Edit Nightly");

    await act(async () => { release(); });
    await act(settle);
    assert.equal(editorTitle(fixture.container), "Edit Nightly", "the settled create left the newer editor alone");
    assert.equal((editorRoot(fixture.container).querySelector("input") as HTMLInputElement).value, "Nightly Draft");
    assert.match(fixture.container.querySelector(".save-bar")?.textContent ?? "", /Unsaved changes/);
    assert.ok(toasts.includes("Automation created."), "the person still hears that it was created");
  } finally {
    await unmountFixture(fixture);
  }
});
