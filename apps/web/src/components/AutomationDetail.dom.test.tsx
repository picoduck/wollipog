import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  AutomationExecution,
  AutomationSchedule,
  AutomationSpec,
  AutomationTriggerView,
  RunnerView,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { specOf } from "../automation-form.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { EntityTitleProvider, reportedTitleFor, useEntityTitleState } from "../entity-title.js";
import { browserInstanceManager, InstancesContextProvider, type InstanceManager } from "../instances-context.js";
import { viewPath, viewTitle, type View, type ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { AutomationDetail } from "./AutomationDetail.js";
import { AutomationEditor } from "./AutomationEditor.js";
import { AutomationsView } from "./AutomationsView.js";
import { FeedbackProvider } from "./FeedbackProvider.js";

/**
 * The automation page (#2968): its route, its bar, the glance, Rules and Limits, its one notice,
 * Delete from ⋯ on desktop and on the phone sheet, and the window title, rendered under Strict
 * Mode with the real confirmation and toast provider. The polling and action races are in
 * `AutomationsView.dom.test.tsx`.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
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
  HTMLDetailsElement: domWindow.HTMLDetailsElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  InputEvent: domWindow.InputEvent,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  FocusEvent: domWindow.FocusEvent,
  MutationObserver: domWindow.MutationObserver,
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const machine: RunnerView = {
  runnerId: "runner-1",
  hostname: "build-box",
  displayName: "Build Server",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{ id: "agent-1", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
  workspaces: [{ id: "workspace-1", name: "acme-storefront", path: "/repos/acme" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 90,
};

function automation(automationId: string, name: string, overrides: Partial<AutomationSchedule> = {}): AutomationSchedule {
  return {
    automationId,
    revision: 1,
    name,
    cron: "0 2 * * *",
    timezone: "America/Chicago",
    enabled: true,
    action: { kind: "create_session", request: {
      runnerId: "runner-1", workspaceId: "workspace-1", agentId: "agent-1", prompt: "Sweep the dependencies.",
    } },
    misfirePolicy: { kind: "catch_up", maxRuns: 2 },
    runnerPolicy: { kind: "expire", afterMinutes: 60 },
    concurrencyPolicy: "skip",
    limits: { maxCostUsd: 5, maxToolCalls: 200 },
    notifications: { pushEvents: ["failed"] },
    createdBy: { kind: "human", id: "test" },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** Today (or `days` from today) at 2:00 AM on the viewer's clock. */
function atTwo(days: number): number {
  const date = new Date();
  date.setHours(2, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function run(status: AutomationExecution["status"], overrides: Partial<AutomationExecution> = {}): AutomationExecution {
  return {
    executionId: `execution-${status}`,
    automationId: "automation-a",
    idempotencyKey: `automation-a:${status}`,
    scheduledFor: atTwo(0),
    automationRevision: 1,
    actionKind: "create_session",
    status,
    actor: { kind: "system", id: "automation:automation-a" },
    sessionId: "session-1",
    createdAt: atTwo(0),
    startedAt: atTwo(0),
    completedAt: atTwo(0),
    ...overrides,
  };
}

function trigger(triggerId: string): AutomationTriggerView {
  return {
    triggerId, automationId: "automation-a", kind: "webhook", name: `Hook ${triggerId}`, generation: 1,
    createdBy: { kind: "human", id: "test" }, createdAt: 1, updatedAt: 1, invocationCount: 0,
  };
}

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

function snapshot(): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
    runners: [machine], boxes: [], sessions: [], runs: [], pods: [],
  };
}

/** As App routes Automations, with the window title App derives from the reported entity title. */
function Routes() {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  const view = useStoreSelector((state) => state.view);
  const [reported, report] = useEntityTitleState();
  return (
    <EntityTitleProvider report={report}>
      <output className="window-title">{viewTitle(view, reportedTitleFor(reported, view))}</output>
      {ready && (view.name === "automation" ? <AutomationDetail key={view.id} automationId={view.id} />
        : view.name === "automations" && view.editor ? <AutomationEditor key={viewPath(view)} route={view.editor} />
          : <AutomationsView />)}
    </EntityTitleProvider>
  );
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
});
let sequence = 0;

async function setWidth(width: number) {
  await act(async () => domWindow.happyDOM.setWindowSize({ width, height: 900 }));
  await settle();
}

afterEach(async () => { await setWidth(1440); });

interface Mounted {
  body: HTMLElement;
  requests: string[];
  updates: AutomationSpec[];
  deletes: string[];
  unmount: () => Promise<void>;
}

async function mount({ view, items, executions = {}, triggers = {}, client: overrides = {}, origin }: {
  view: View;
  items: AutomationSchedule[];
  executions?: Record<string, AutomationExecution[]>;
  triggers?: Record<string, AutomationTriggerView[]>;
  client?: Partial<ApiClient>;
  /** A dashboard address, so Copy Link has a link to copy. */
  origin?: string;
}): Promise<Mounted> {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  sequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `automation-detail-${sequence}`,
    runtimeKey: `automation-detail-${sequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const requests: string[] = [];
  const updates: AutomationSpec[] = [];
  const deletes: string[] = [];
  const client = {
    ...api,
    automations: async () => { requests.push("list"); return { automations: [...items] }; },
    automation: async (id: string) => {
      requests.push(`automation:${id}`);
      const found = items.find((item) => item.automationId === id);
      if (!found) throw new ApiError("automation not found", 404);
      return { automation: found, executions: executions[id] ?? [], events: [] };
    },
    automationTriggers: async (id: string) => {
      requests.push(`triggers:${id}`);
      return { triggers: triggers[id] ?? [] };
    },
    workflowDefinitions: async () => { requests.push("workflows"); return []; },
    outboundEventSubscriptions: async () => [],
    updateAutomation: async (id: string, spec: AutomationSpec) => {
      updates.push(structuredClone(spec));
      const index = items.findIndex((item) => item.automationId === id);
      items[index] = { ...items[index]!, ...spec };
      return items[index]!;
    },
    deleteAutomation: async (id: string) => {
      deletes.push(id);
      items.splice(items.findIndex((item) => item.automationId === id), 1);
      return { deleted: true };
    },
    ...overrides,
  } as unknown as ApiClient;
  const navigation: ViewNavigation = { current: () => view, push() {}, replace() {}, listen: () => () => {} };
  const instances: InstanceManager = origin
    ? { ...browserInstanceManager, activeProfile: { ...browserInstanceManager.activeProfile, kind: "remote", origin } as InstanceManager["activeProfile"] }
    : browserInstanceManager;
  await act(async () => {
    root.render(
      <React.StrictMode>
        <ApiProvider client={client}>
          <InstancesContextProvider value={instances}>
            <FeedbackProvider>
              <StoreProvider connection={connection} navigation={navigation}>
                <Routes />
              </StoreProvider>
            </FeedbackProvider>
          </InstancesContextProvider>
        </ApiProvider>
      </React.StrictMode>,
    );
  });
  await act(async () => { socket.push(snapshot()); });
  await settle();
  return {
    body: domWindow.document.body as unknown as HTMLElement,
    requests, updates, deletes,
    unmount: async () => { await act(async () => root.unmount()); mountPoint.remove(); },
  };
}

const page = (body: HTMLElement) => body.querySelector<HTMLElement>(".automation-detail");
const buttonNamed = (scope: Element, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === name) ?? null;
const windowTitle = (body: HTMLElement) => body.querySelector(".window-title")?.textContent;
const route = (id: string): View => ({ name: "automation", id });
const automationPath = (id: string) => viewPath(route(id));

async function click(element: HTMLElement | null | undefined) {
  assert.ok(element, "the control is rendered");
  await act(async () => element.click());
  await settle();
}

async function openMore(body: HTMLElement): Promise<HTMLElement> {
  await click(body.querySelector<HTMLButtonElement>('.detail-bar button[aria-label="More Actions"]'));
  const menu = body.querySelector<HTMLElement>('[role="menu"][aria-label="More Actions"]');
  assert.ok(menu, "⋯ opens");
  return menu;
}
const menuLabels = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.querySelector(".menu-text")?.textContent);
const menuItem = (menu: HTMLElement, label: string) => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  .find((item) => item.querySelector(".menu-text")?.textContent === label);
const dialogNamed = (body: HTMLElement, title: string) => [...body.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
  .find((dialog) => dialog.querySelector("h2, h3, .modal-title")?.textContent?.trim() === title);

test("/automations/~<id> opens that automation's page directly and reads only its detail and triggers", async () => {
  const items = [automation("automation-a", "Nightly Sweep"), automation("automation-b", "Weekly Digest")];
  const view = await mount({ view: route("automation-a"), items });
  try {
    assert.equal(page(view.body)?.querySelector(".detail-bar-title")?.textContent, "Nightly Sweep");
    assert.ok(view.requests.length > 0);
    for (const request of view.requests) {
      assert.ok(request === "automation:automation-a" || request === "triggers:automation-a",
        `the page asked for ${request}`);
    }
    // A create-session action needs no workflow definitions.
    assert.ok(!view.requests.includes("workflows"));
  } finally {
    await view.unmount();
  }
});

test("an unknown id shows Automation Not Found with Back to Automations", async () => {
  const view = await mount({ view: route("gone"), items: [automation("automation-a", "Nightly Sweep")] });
  try {
    const detail = page(view.body)!;
    assert.equal(detail.querySelector(".detail-bar-title")?.textContent, "Automation");
    assert.match(detail.textContent ?? "", /Automation Not Found/);
    assert.match(detail.textContent ?? "", /It may have been deleted, or you may not have access\./);
    await click(buttonNamed(detail, "Back to Automations"));
    assertNoDomNode(page(view.body));
    assert.ok(view.body.querySelector(".automation-list"), "Back opens the list");
  } finally {
    await view.unmount();
  }
});

test("the bar shows one badge, Pause, Edit and ⋯ ending in Delete Automation… after a separator", async () => {
  const view = await mount({ view: route("automation-a"), items: [automation("automation-a", "Nightly Sweep")] });
  try {
    const detail = page(view.body)!;
    const bar = detail.querySelector<HTMLElement>(".detail-bar")!;
    assert.deepEqual([...detail.querySelectorAll(".detail-bar .status")].map((badge) => badge.textContent), ["Enabled"]);
    assert.deepEqual([...bar.querySelectorAll(".detail-bar-action")].map((button) => button.textContent?.trim()), ["Pause", "Edit"]);
    assert.ok(bar.querySelector(".btn.primary.detail-bar-action"), "Edit is the primary");
    const menu = await openMore(view.body);
    assert.deepEqual(menuLabels(menu),
      ["Add Webhook Trigger…", "Add Chat-Ops Trigger…", "Copy Link", "Delete Automation…"]);
    const children = [...menu.querySelectorAll('[role="menuitem"], [role="separator"]')];
    assert.equal(children.at(-2)?.getAttribute("role"), "separator", "a separator comes before Delete");
    assert.ok(menuItem(menu, "Delete Automation…")?.classList.contains("danger"));
    // Copy Link says why it is unavailable where there is no dashboard address.
    assert.match(menuItem(menu, "Copy Link")?.textContent ?? "", /Open Wollipog in a browser to copy a link\./);
    await act(async () => { domWindow.document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();
    // No Delete renders outside ⋯.
    assert.ok(![...detail.querySelectorAll("button")].some((button) => /Delete/.test(button.textContent ?? "")));
  } finally {
    await view.unmount();
  }
});

test("Pause sends the full stored spec with enabled flipped, and the badge turns Paused; Resume turns it back", async () => {
  const stored = automation("automation-a", "Nightly Sweep");
  const view = await mount({ view: route("automation-a"), items: [stored] });
  try {
    const detail = page(view.body)!;
    await click(buttonNamed(detail, "Pause"));
    assert.deepEqual(view.updates, [{ ...specOf(stored), enabled: false }]);
    assert.equal(detail.querySelector(".detail-bar .status")?.textContent, "Paused");
    assert.match(detail.querySelector(".glance")?.textContent ?? "", /Next RunPaused/);
    await click(buttonNamed(detail, "Resume"));
    assert.deepEqual(view.updates[1], { ...specOf(stored), enabled: true });
    assert.equal(detail.querySelector(".detail-bar .status")?.textContent, "Enabled");
  } finally {
    await view.unmount();
  }
});

test("Next Run and Last Run read in words, and nothing on the page has seconds", async () => {
  const stored = automation("automation-a", "Nightly Sweep", { nextFireAt: atTwo(1) });
  const view = await mount({ view: route("automation-a"), items: [stored], executions: { "automation-a": [run("succeeded")] } });
  try {
    const detail = page(view.body)!;
    const facts = Object.fromEntries([...detail.querySelectorAll(".glance > div")]
      .map((pair) => [pair.querySelector("dt")?.textContent, pair.querySelector("dd")]));
    assert.deepEqual(Object.keys(facts), ["Next Run", "Last Run", "Schedule"]);
    assert.equal(facts["Next Run"]?.textContent, "Tomorrow, 2:00 AM");
    assert.equal(facts["Last Run"]?.querySelector(".status")?.textContent, "Succeeded");
    assert.match(facts["Last Run"]?.textContent ?? "", /Today, 2:00 AM/);
    assert.ok(buttonNamed(facts["Last Run"]!, "Open Session"));
    assert.equal(facts.Schedule?.querySelector("span")?.textContent, "Every day at 2:00 AM");
    assert.equal(facts.Schedule?.querySelector("code")?.textContent, "0 2 * * *");
    const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(Boolean(facts.Schedule?.querySelector(".glance-zone")), viewerZone !== "America/Chicago",
      "the time zone shows only when it differs from the viewer's");
    assert.doesNotMatch(detail.textContent ?? "", /\d:\d\d:\d\d/, "no toLocaleString output with seconds");
    await click(buttonNamed(facts["Last Run"]!, "Open Session"));
    assertNoDomNode(page(view.body), "Open Session leaves for the session");
  } finally {
    await view.unmount();
  }
});

test("a paused automation that never ran says Paused and Not Yet, with no zone in the viewer's own zone", async () => {
  const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stored = automation("automation-a", "Weekly Digest", { enabled: false, cron: "0 9 * * 1-5", timezone: viewerZone });
  const view = await mount({ view: route("automation-a"), items: [stored] });
  try {
    const detail = page(view.body)!;
    assert.equal(detail.querySelector(".detail-bar .status")?.textContent, "Paused");
    assert.ok(buttonNamed(detail.querySelector(".detail-bar")!, "Resume"));
    const glance = [...detail.querySelectorAll(".glance dd")].map((value) => value.textContent);
    assert.deepEqual(glance.slice(0, 2), ["Paused", "Not yet"]);
    assert.equal(glance[2], "Weekdays at 9:00 AM0 9 * * 1-5");
    assertNoDomNode(detail.querySelector(".glance-zone"));
    assert.match(detail.textContent ?? "", /No runs yet\./);
    assert.match(detail.textContent ?? "", /No signed triggers yet\./);
  } finally {
    await view.unmount();
  }
});

test("an enabled automation that never ran names its first run", async () => {
  const stored = automation("automation-a", "Nightly Sweep", { nextFireAt: atTwo(1) });
  const view = await mount({ view: route("automation-a"), items: [stored] });
  try {
    assert.equal(page(view.body)!.querySelectorAll(".glance dd")[1]?.textContent, "Not yet; first run Tomorrow, 2:00 AM");
  } finally {
    await view.unmount();
  }
});

test("What It Does is one sentence of display names, then the prompt; Rules and Limits are labeled facts", async () => {
  const view = await mount({ view: route("automation-a"), items: [automation("automation-a", "Nightly Sweep")] });
  try {
    const detail = page(view.body)!;
    assert.equal(detail.querySelector(".automation-sentence")?.textContent, "Starts Claude Code in acme-storefront on Build Server.");
    assert.equal(detail.querySelector(".automation-prompt")?.textContent, "Sweep the dependencies.");
    assert.doesNotMatch(detail.querySelector(".automation-sentence")?.textContent ?? "", /runner-1|workspace-1|agent-1/);
    const facts = detail.querySelector("dl.facts")!;
    assert.deepEqual([...facts.querySelectorAll("dt")].map((label) => label.textContent), [
      "If a Run Is Missed", "If Build Server Is Offline", "If the Last Run Is Still Going",
      "Cost Limit", "Tool Call Limit", "Notifications",
    ]);
    assert.deepEqual([...facts.querySelectorAll("dd")].map((answer) => answer.textContent), [
      "Catch up, at most 2 runs", "Give up after 60 minutes", "Skip this run",
      "$5.00 per run", "200 tool calls per run", "When a run fails",
    ]);
    assert.ok(![...facts.querySelectorAll("dd")].some((answer) => answer.textContent?.includes(" · ")), "no middle-dot enum chain");
    assertNoDomNode(detail.querySelector(".automation-facts"));
    assert.deepEqual([...detail.querySelectorAll(".section-title")].map((title) => title.textContent),
      ["What It Does", "Rules and Limits", "Triggers", "Run History"]);
  } finally {
    await view.unmount();
  }
});

test("a failed last run and a waiting target show one danger notice, Last Run Failed with +1 More, and no other alert", async () => {
  const stored = automation("automation-a", "Nightly Sweep", {
    targetHealth: { scheduledFor: atTwo(0), firstSeenAt: atTwo(0), error: "Build Server is offline." },
  });
  const failed = run("failed", { error: "The agent exited before it finished." });
  const view = await mount({ view: route("automation-a"), items: [stored], executions: { "automation-a": [failed] } });
  try {
    const detail = page(view.body)!;
    assert.equal(detail.querySelector(".detail-bar .status")?.textContent, "Last Run Failed");
    const notices = detail.querySelectorAll(".automation-notice-slot .notice");
    assert.equal(notices.length, 1, "one notice");
    const notice = notices[0]!;
    assert.ok(notice.classList.contains("t-danger"));
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Last Run Failed");
    assert.equal(notice.querySelector(".notice-body")?.textContent, "The agent exited before it finished.");
    assert.ok(buttonNamed(notice, "+1 More"));
    assert.ok(buttonNamed(notice, "Open Session"));
    const alerts = [...detail.querySelectorAll('[role="alert"]')];
    assert.deepEqual(alerts, [notice], "the notice is the page's only alert");

    await click(buttonNamed(notice, "Run Details"));
    const history = detail.querySelector<HTMLDetailsElement>("details.automation-history")!;
    assert.equal(history.open, true, "Run Details opens the run history");

    await click(buttonNamed(detail, "+1 More"));
    const more = [...view.body.querySelectorAll<HTMLElement>('[role="menu"][aria-label="Automation Notices"] [role="menuitem"]')];
    assert.deepEqual(more.map((item) => item.textContent), ["Waiting for Build Server"]);
    await click(more[0]);
    const waiting = detail.querySelector(".automation-notice-slot .notice")!;
    assert.ok(waiting.classList.contains("t-warning"));
    assert.equal(waiting.querySelector(".notice-body")?.textContent, "Build Server is offline.");
  } finally {
    await view.unmount();
  }
});

test("an unavailable agent installation is a warning notice with Edit Automation", async () => {
  const unavailable = automation("automation-a", "Nightly Sweep");
  // A saved installation the machine no longer has.
  if (unavailable.action.kind === "create_session") unavailable.action.installationBindings = { agent: {
    driver: "claude-code", context: { kind: "native" }, installationId: "missing",
  } };
  const view = await mount({ view: route("automation-a"), items: [unavailable] });
  try {
    const notice = page(view.body)!.querySelector(".automation-notice-slot .notice")!;
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Agent Unavailable");
    assert.ok(notice.classList.contains("t-warning"));
    await click(buttonNamed(notice, "Edit Automation"));
    assert.equal(view.body.querySelector(".automation-editor .detail-bar-title")?.textContent, "Edit Nightly Sweep");
  } finally {
    await view.unmount();
  }
});

test("Delete Automation names the automation and its triggers, then returns to the list with a toast", async () => {
  const items = [automation("automation-a", "Nightly Sweep")];
  const view = await mount({
    view: route("automation-a"), items, triggers: { "automation-a": [trigger("one"), trigger("two")] },
  });
  try {
    const menu = await openMore(view.body);
    await click(menuItem(menu, "Delete Automation…"));
    const confirmation = dialogNamed(view.body, "Delete Automation")!;
    assert.ok(confirmation, "the confirmation opens");
    assert.match(confirmation.textContent ?? "",
      /“Nightly Sweep” stops running and is removed, with its 2 triggers\. Its run history is kept\./);
    assertNoDomNode(confirmation.querySelector('button[aria-label="Back to More Actions"]'), "desktop stacks, with no Back");
    await click(buttonNamed(confirmation, "Delete Automation"));
    assert.deepEqual(view.deletes, ["automation-a"]);
    assertNoDomNode(page(view.body));
    assert.ok(view.body.querySelector(".automation-list"), "the list is shown");
    assert.match(view.body.textContent ?? "", /“Nightly Sweep” deleted\./);
  } finally {
    await view.unmount();
  }
});

test("at 390px the bar is Back, the title, the pencil and ⋯; the badge sits under it; Delete replaces the ⋯ sheet with Back", async () => {
  await setWidth(390);
  const view = await mount({
    view: route("automation-a"), items: [automation("automation-a", "Nightly Sweep")],
    triggers: { "automation-a": [trigger("one")] },
  });
  try {
    const detail = page(view.body)!;
    const bar = detail.querySelector<HTMLElement>(".detail-bar")!;
    assertNoDomNode(bar.querySelector(".status"), "the badge leaves the bar");
    assert.equal(detail.querySelector(".automation-status .status")?.textContent, "Enabled");
    assertNoDomNode(buttonNamed(bar, "Pause"), "Pause moves into ⋯");
    const edit = bar.querySelector<HTMLButtonElement>(".detail-bar-action.icon-only");
    assert.ok(edit, "Edit is an icon button");
    assert.equal(edit.title, "Edit");
    const menu = await openMore(view.body);
    assert.deepEqual(menuLabels(menu),
      ["Pause", "Add Webhook Trigger…", "Add Chat-Ops Trigger…", "Copy Link", "Delete Automation…"]);
    await click(menuItem(menu, "Delete Automation…"));
    const confirmation = dialogNamed(view.body, "Delete Automation")!;
    assert.ok(confirmation, "the confirmation opens");
    assert.match(confirmation.textContent ?? "", /with its 1 trigger\./);
    assertNoDomNode(view.body.querySelector('[role="menu"][aria-label="More Actions"]'), "it replaced the sheet");
    const back = confirmation.querySelector<HTMLButtonElement>('button[aria-label="Back to More Actions"]');
    assert.ok(back, "the confirmation has Back to More Actions");
    await click(back);
    assert.ok(view.body.querySelector('[role="menu"][aria-label="More Actions"]'), "Back brings the ⋯ sheet back");
    assert.deepEqual(view.deletes, [], "Back deletes nothing");
  } finally {
    await view.unmount();
  }
});

test("a delete that settles after the person left does not move them", async () => {
  const items = [automation("automation-a", "Nightly Sweep"), automation("automation-b", "Weekly Digest")];
  let release: (() => void) | undefined;
  const view = await mount({
    view: route("automation-a"), items,
    client: { deleteAutomation: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { deleted: true };
    } },
  });
  try {
    const menu = await openMore(view.body);
    await click(menuItem(menu, "Delete Automation…"));
    await click(buttonNamed(dialogNamed(view.body, "Delete Automation")!, "Delete Automation"));
    await click(view.body.querySelector<HTMLButtonElement>('.detail-bar button[aria-label="Back to Automations"]'));
    await click([...view.body.querySelectorAll<HTMLButtonElement>(".automation-row-open")]
      .find((button) => button.textContent?.includes("Weekly Digest")));
    assert.equal(page(view.body)?.querySelector(".detail-bar-title")?.textContent, "Weekly Digest");
    await act(async () => { release?.(); });
    await settle();
    assert.equal(page(view.body)?.querySelector(".detail-bar-title")?.textContent, "Weekly Digest",
      "the page they went to stays");
  } finally {
    release?.();
    await view.unmount();
  }
});

test("a Pause that settles after unmount publishes nothing", async () => {
  let release: (() => void) | undefined;
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  const view = await mount({
    view: route("automation-a"), items: [automation("automation-a", "Nightly Sweep")],
    client: { updateAutomation: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error("Pause failed after unmount");
    } },
  });
  try {
    await click(buttonNamed(page(view.body)!, "Pause"));
    await view.unmount();
    await act(async () => { release?.(); });
    await settle();
    assert.deepEqual(errors, []);
  } finally {
    console.error = originalError;
    release?.();
  }
});

test("the window title reads the automation's name on its page and Edit <Name> on its editor", async () => {
  const view = await mount({ view: route("automation-a"), items: [automation("automation-a", "Nightly Sweep")] });
  try {
    assert.equal(windowTitle(view.body), "Nightly Sweep");
    await click(buttonNamed(page(view.body)!.querySelector(".detail-bar")!, "Edit"));
    assert.equal(windowTitle(view.body), "Edit Nightly Sweep");
    await click(view.body.querySelector<HTMLButtonElement>('button[aria-label="Back to Nightly Sweep"]'));
    assert.equal(windowTitle(view.body), "Nightly Sweep");
    await click(view.body.querySelector<HTMLButtonElement>('button[aria-label="Back to Automations"]'));
    assert.equal(windowTitle(view.body), "Automations", "a page that leaves takes its title with it");
  } finally {
    await view.unmount();
  }
});

/* ----------------- Focus after an action (CR-1.3): it goes where the action meant ----------------- */

const ORIGIN = "https://wollipog.example";
const focused = () => domWindow.document.activeElement as unknown as HTMLElement | null;
const moreActions = (body: HTMLElement) => body.querySelector<HTMLButtonElement>('.detail-bar button[aria-label="More Actions"]')!;

/** Replaces the Clipboard API for one test (undefined: a plain-HTTP page has none), and makes the
 * selected-field fallback move focus to that field, as a browser does. */
function withClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(domWindow.navigator, "clipboard");
  const execCommand = (domWindow.document as unknown as { execCommand?: unknown }).execCommand;
  const fallbacks: string[] = [];
  Object.defineProperty(domWindow.navigator, "clipboard", { configurable: true, value: clipboard });
  (domWindow.document as unknown as { execCommand: (command: string) => boolean }).execCommand = (command) => {
    const field = domWindow.document.querySelector("textarea[readonly]") as unknown as HTMLTextAreaElement | null;
    field?.focus();
    fallbacks.push(field?.value ?? command);
    return true;
  };
  return {
    fallbacks,
    restore() {
      if (navigatorDescriptor) Object.defineProperty(domWindow.navigator, "clipboard", navigatorDescriptor);
      else Reflect.deleteProperty(domWindow.navigator, "clipboard");
      (domWindow.document as unknown as { execCommand?: unknown }).execCommand = execCommand;
    },
  };
}

test("Copy Link without the Clipboard API copies through the fallback and gives focus back to ⋯", async () => {
  const clipboard = withClipboard(undefined);
  const view = await mount({ view: route("automation-a"), items: [automation("automation-a", "Nightly Sweep")], origin: ORIGIN });
  try {
    await click(menuItem(await openMore(view.body), "Copy Link"));
    assert.deepEqual(clipboard.fallbacks, [`${ORIGIN}${automationPath("automation-a")}`]);
    assert.equal(focused(), moreActions(view.body), "focus returns to the trigger the copy came from");
    assert.match(view.body.textContent ?? "", /Link copied\./);
  } finally {
    clipboard.restore();
    await view.unmount();
  }
});

test("a Copy Link refused after the person moved on never takes their focus", async () => {
  let refuse: ((error: Error) => void) | undefined;
  const clipboard = withClipboard({ writeText: () => new Promise<void>((_resolve, reject) => { refuse = reject; }) });
  const view = await mount({ view: route("automation-a"), items: [automation("automation-a", "Nightly Sweep")], origin: ORIGIN });
  try {
    await click(menuItem(await openMore(view.body), "Copy Link"));
    const pause = buttonNamed(page(view.body)!.querySelector(".detail-bar")!, "Pause")!;
    await act(async () => pause.focus());
    await act(async () => { refuse?.(new Error("Clipboard denied")); });
    await settle();
    assert.deepEqual(clipboard.fallbacks, [], "the late refusal does not fall back over the newer control");
    assert.equal(focused(), pause);
  } finally {
    refuse?.(new Error("cleanup"));
    clipboard.restore();
    await view.unmount();
  }
});

test("a Copy Link that settles after the page left publishes nothing and moves no focus", async () => {
  let refuse: ((error: Error) => void) | undefined;
  const clipboard = withClipboard({ writeText: () => new Promise<void>((_resolve, reject) => { refuse = reject; }) });
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  const view = await mount({ view: route("automation-a"), items: [automation("automation-a", "Nightly Sweep")], origin: ORIGIN });
  try {
    await click(menuItem(await openMore(view.body), "Copy Link"));
    await view.unmount();
    await act(async () => { refuse?.(new Error("Clipboard denied")); });
    await settle();
    assert.deepEqual(clipboard.fallbacks, []);
    assert.deepEqual(errors, []);
  } finally {
    console.error = originalError;
    clipboard.restore();
  }
});

test("Create Trigger focuses the new secret's Copy Secret; Hide returns to that trigger's Rotate Secret", async () => {
  const triggers: Record<string, AutomationTriggerView[]> = { "automation-a": [] };
  const view = await mount({
    view: route("automation-a"), items: [automation("automation-a", "Nightly Sweep")], triggers,
    client: { createAutomationTrigger: async (id: string) => {
      const created = trigger("created");
      triggers[id] = [created];
      return { trigger: created, secret: `wollipogwhsec_${"A".repeat(43)}` };
    } } as Partial<ApiClient>,
  });
  try {
    await click(menuItem(await openMore(view.body), "Add Webhook Trigger…"));
    const create = buttonNamed(page(view.body)!, "Create Trigger")!;
    await act(async () => create.focus());
    await click(create);
    assertNoDomNode(page(view.body)!.querySelector('[aria-label="New Signed Trigger"]'), "the form is gone");
    assert.equal(focused()?.textContent, "Copy Secret");
    await click(buttonNamed(page(view.body)!, "Hide"));
    assert.equal(focused()?.textContent, "Rotate Secret");
    assert.equal(focused()?.closest("[data-trigger-id]")?.getAttribute("data-trigger-id"), "created");
  } finally {
    await view.unmount();
  }
});

test("Cancel in the trigger form returns focus to ⋯, and Revoke to the Triggers heading", async () => {
  const triggers: Record<string, AutomationTriggerView[]> = { "automation-a": [trigger("one")] };
  const view = await mount({
    view: route("automation-a"), items: [automation("automation-a", "Nightly Sweep")], triggers,
    client: { deleteAutomationTrigger: async (id: string) => { triggers[id] = []; return { deleted: true }; } } as Partial<ApiClient>,
  });
  try {
    await click(menuItem(await openMore(view.body), "Add Chat-Ops Trigger…"));
    const cancel = buttonNamed(page(view.body)!, "Cancel")!;
    await act(async () => cancel.focus());
    await click(cancel);
    assert.equal(focused(), moreActions(view.body));

    const revoke = buttonNamed(page(view.body)!, "Revoke")!;
    await act(async () => revoke.focus());
    await click(revoke);
    await click(buttonNamed(dialogNamed(view.body, "Revoke Signed Trigger")!, "Revoke Trigger"));
    assertNoDomNode(page(view.body)!.querySelector("[data-trigger-id]"), "the trigger is gone");
    assert.equal(focused()?.id, "automation-triggers");
  } finally {
    await view.unmount();
  }
});

test("a Delete that fails returns focus to ⋯ under its notice", async () => {
  const view = await mount({
    view: route("automation-a"), items: [automation("automation-a", "Nightly Sweep")],
    client: { deleteAutomation: async () => { throw new Error("The control plane refused the delete."); } },
  });
  try {
    await click(menuItem(await openMore(view.body), "Delete Automation…"));
    await click(buttonNamed(dialogNamed(view.body, "Delete Automation")!, "Delete Automation"));
    assert.equal(page(view.body)!.querySelector(".automation-notice-slot .notice-title")?.textContent, "Automation Not Deleted");
    assert.equal(focused(), moreActions(view.body));
  } finally {
    await view.unmount();
  }
});

test("Pause and Resume keep focus on the bar's button through the write", async () => {
  let release: (() => void) | undefined;
  const items = [automation("automation-a", "Nightly Sweep")];
  const view = await mount({
    view: route("automation-a"), items,
    client: { updateAutomation: async (id: string, spec: AutomationSpec) => {
      await new Promise<void>((resolve) => { release = resolve; });
      items[0] = { ...items[0]!, ...spec };
      return items[0]!;
    } } as Partial<ApiClient>,
  });
  try {
    const pause = buttonNamed(page(view.body)!.querySelector(".detail-bar")!, "Pause")!;
    await act(async () => pause.focus());
    await click(pause);
    await act(async () => { release?.(); });
    await settle();
    assert.equal(focused()?.textContent?.trim(), "Resume");
  } finally {
    release?.();
    await view.unmount();
  }
});

test("Try Again after a failed load hands focus to the loaded page's title", async () => {
  let fail = true;
  const items = [automation("automation-a", "Nightly Sweep")];
  const view = await mount({
    view: route("automation-a"), items,
    client: { automation: async () => {
      if (fail) throw new Error("Control plane unavailable");
      return { automation: items[0]!, executions: [], events: [] };
    } } as Partial<ApiClient>,
  });
  try {
    const retry = buttonNamed(page(view.body)!, "Try Again")!;
    assert.ok(retry, "the load error offers Try Again");
    await act(async () => retry.focus());
    fail = false;
    await click(retry);
    assert.ok(page(view.body)!.querySelector(".glance"), "the page loaded");
    assert.equal(focused()?.id, "page-title");
  } finally {
    await view.unmount();
  }
});
