import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  AgentDefinition,
  CreateRunRequest,
  CreateWorkflowRunRequest,
  ProjectView,
  RunnerView,
  UiSnapshotMessage,
  WorkflowDefinition,
} from "@wollipog/protocol";
import { ApiError, api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { NewRunDialog } from "./NewRunDialog.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const project: ProjectView = {
  id: "project-1",
  name: "Wollipog",
  hidden: false,
  locations: [{
    id: "location-1",
    projectId: "project-1",
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    name: "Wollipog",
    path: "/repos/wollipog",
    source: "managed",
    availability: "available",
    isDefault: true,
    createdAt: 1,
    updatedAt: 1,
  }],
  activeSessionCount: 0,
  unarchivedSessionCount: 0,
  totalSessionCount: 0,
  createdAt: 1,
  updatedAt: 1,
};

const claude: AgentDefinition = { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true };
const codex: AgentDefinition = { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true };

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  displayName: "Build Server",
  os: "linux",
  version: "1",
  status: "online",
  agents: [claude, codex],
  workspaces: [{ id: "workspace-1", name: "Wollipog", path: "/repos/wollipog" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 63,
};

const workflow: WorkflowDefinition = {
  workflowId: "builtin:build-review",
  version: 1,
  source: "builtin",
  name: "Build + Review",
  maxTransitions: 4,
  edges: [],
  createdBy: { kind: "system" },
  createdAt: 1,
  nodes: [
    { nodeId: "build", kind: "agent", role: "builder", agentId: "claude", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 },
    { nodeId: "review", kind: "agent", role: "reviewer", agentId: "codex", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 },
    { nodeId: "approve", kind: "human_gate", role: "approver", inputs: [], outputs: [], retry: { maxAttempts: 1, backoffMs: 0 }, timeoutMs: 1_000 },
  ],
};

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

function snapshot(overrides: Partial<UiSnapshotMessage> = {}): UiSnapshotMessage {
  return {
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    runners: [runner],
    boxes: [],
    projects: [project],
    sessions: [],
    runs: [],
    pods: [],
    ...overrides,
  };
}

function DialogWhenReady({ onClose }: { onClose: () => void }) {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  return ready ? <NewRunDialog onClose={onClose} /> : null;
}

interface Fixture {
  container: HTMLDivElement;
  mountPoint: HTMLDivElement;
  root: Root;
  socket: FakeSocket;
  parallelRequests: CreateRunRequest[];
  workflowRequests: CreateWorkflowRunRequest[];
  pushed: View[];
  closed: () => number;
}

let fixtureSequence = 0;

async function mountFixture(
  snapshotOverrides: Partial<UiSnapshotMessage> = {},
  options: { failCreate?: Error } = {},
): Promise<Fixture> {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  // Dialogs are portalled to <body>, so the test queries the body.
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  const parallelRequests: CreateRunRequest[] = [];
  const workflowRequests: CreateWorkflowRunRequest[] = [];
  const pushed: View[] = [];
  let closed = 0;
  fixtureSequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `new-run-${fixtureSequence}`,
    runtimeKey: `new-run-${fixtureSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "inbox" }),
    push(view) { pushed.push(view); },
    listen: () => () => {},
  };
  const client = {
    ...api,
    workflowDefinitions: async () => [workflow],
    createRun: async (request: CreateRunRequest) => {
      parallelRequests.push(structuredClone(request));
      if (options.failCreate) throw options.failCreate;
      return { run: { id: "parallel-run" }, sessions: [] };
    },
    createWorkflowRun: async (request: CreateWorkflowRunRequest) => {
      workflowRequests.push(structuredClone(request));
      return { run: { id: "workflow-run" }, sessions: [], instance: {} };
    },
  } as unknown as ApiClient;

  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <DialogWhenReady onClose={() => { closed += 1; }} />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => { socket.push(snapshot(snapshotOverrides)); });
  await settle();
  return { container, mountPoint, root, socket, parallelRequests, workflowRequests, pushed, closed: () => closed };
}

async function unmountFixture(fixture: Fixture): Promise<void> {
  await act(async () => { fixture.root.unmount(); });
  fixture.mountPoint.remove();
}

async function settle(): Promise<void> {
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

function dialog(container: HTMLDivElement): HTMLElement {
  const found = container.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(found, "the dialog is open");
  return found;
}

function trigger(container: HTMLDivElement, label: string): HTMLButtonElement {
  const found = dialog(container).querySelector<HTMLButtonElement>(`button.ui-select-trigger[aria-label^="${label}:"]`);
  assert.ok(found, `${label} is a Select`);
  return found;
}

/** The open list's options as their labels, with whether each is disabled and its second lines. */
function openOptions(container: HTMLDivElement): { label: string; text: string; disabled: boolean }[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((option) => {
    const labelId = option.getAttribute("aria-labelledby")!.split(" ")[0]!;
    return {
      label: domWindow.document.getElementById(labelId)?.textContent ?? "",
      text: option.textContent ?? "",
      disabled: option.getAttribute("aria-disabled") === "true",
    };
  });
}

async function openSelect(container: HTMLDivElement, label: string): Promise<void> {
  const button = trigger(container, label);
  await act(async () => { button.click(); });
  await settle();
}

async function choose(container: HTMLDivElement, label: string, option: string): Promise<void> {
  await openSelect(container, label);
  const choice = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) => {
    const labelId = candidate.getAttribute("aria-labelledby")!.split(" ")[0]!;
    return domWindow.document.getElementById(labelId)?.textContent === option;
  });
  assert.ok(choice, `${label} offers ${option}`);
  await act(async () => { choice.click(); });
  await settle();
}

async function enterTask(container: HTMLDivElement, text = "Implement the Project flow"): Promise<void> {
  const task = dialog(container).querySelector("textarea");
  assert.ok(task);
  const valueSetter = Object.getOwnPropertyDescriptor(domWindow.HTMLTextAreaElement.prototype, "value")?.set;
  assert.ok(valueSetter);
  await act(async () => {
    valueSetter.call(task, text);
    fireDomEvent.change(task, { target: task });
  });
}

async function chooseType(container: HTMLDivElement, label: string): Promise<void> {
  const option = [...dialog(container).querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Run Type"] [role="radio"]')]
    .find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(option, `${label} is a run type`);
  await act(async () => { option.click(); });
  await settle();
}

function button(container: HTMLDivElement, name: string | RegExp): HTMLButtonElement {
  const found = [...dialog(container).querySelectorAll<HTMLButtonElement>("button")].find((candidate) => {
    const text = candidate.textContent?.trim() ?? "";
    return typeof name === "string" ? text === name : name.test(text);
  });
  assert.ok(found, `${name} button is rendered`);
  return found;
}

async function clickPrimary(container: HTMLDivElement, label: string): Promise<void> {
  const primary = button(container, label);
  assert.equal(primary.disabled, false, `${label} is enabled: ${footerReason(container)}`);
  await act(async () => { primary.click(); });
  await settle();
}

function footerReason(container: HTMLDivElement): string | null {
  return dialog(container).querySelector(".modal-foot .new-run-reason")?.textContent ?? null;
}

/** Every labelled field in the form, in order: a `.field`'s first bare span. */
function fieldLabels(container: HTMLDivElement): string[] {
  return [...dialog(container).querySelectorAll(".form .field")]
    .map((field) => field.querySelector(":scope > span:first-child")?.textContent ?? null)
    .filter((label): label is string => label !== null);
}

function agentRows(container: HTMLDivElement) {
  return [...dialog(container).querySelectorAll<HTMLLabelElement>(".new-run-agents .choice-row")].map((row) => ({
    title: row.querySelector(".choice-row-title")?.textContent?.trim() ?? "",
    second: row.querySelector(".choice-row-desc, .choice-row-reason")?.textContent?.trim() ?? "",
    checked: row.querySelector("input")?.checked ?? false,
    disabled: row.querySelector("input")?.getAttribute("aria-disabled") === "true" || row.querySelector("input")?.disabled === true,
  }));
}

test("Task is the first field and focused, Title (Optional) is the last, and nothing is a native select", async () => {
  const fixture = await mountFixture();
  try {
    const labels = fieldLabels(fixture.container);
    assert.equal(labels[0], "Task");
    assert.equal(labels.at(-1), "Title (Optional)");
    assert.equal(domWindow.document.activeElement, dialog(fixture.container).querySelector("textarea"));
    assertNoDomNode(dialog(fixture.container).querySelector("select"), "the dialog uses the shared Select");
    await chooseType(fixture.container, "Run a Workflow");
    assertNoDomNode(dialog(fixture.container).querySelector("select"), "Run a Workflow uses the shared Select");
    assert.equal(fieldLabels(fixture.container).at(-1), "Title (Optional)");
  } finally {
    await unmountFixture(fixture);
  }
});

test("the type is a Compare Agents | Run a Workflow switch with one sentence for the selected type", async () => {
  const fixture = await mountFixture();
  try {
    const helper = () => dialog(fixture.container).querySelector('[role="radiogroup"][aria-label="Run Type"] + .field-helper')?.textContent;
    assert.equal(helper(), "Each agent gets the same task in its own worktree.");
    await chooseType(fixture.container, "Run a Workflow");
    assert.equal(helper(), "Agents take turns as roles, and you approve between steps.");
    assertNoDomNode(dialog(fixture.container).querySelector(".choice-row-title + .choice-row-desc"), "no preset rows remain");
    assert.doesNotMatch(dialog(fixture.container).textContent ?? "", /Preset|Parallel Comparison|Workers start idle/u);
  } finally {
    await unmountFixture(fixture);
  }
});

test("with five available agents across three drivers and one signed out, three start chosen, distinct drivers first", async () => {
  const agents: AgentDefinition[] = [
    claude,
    { ...claude, id: "claude-wsl", context: { kind: "wsl", distro: "Ubuntu" } },
    { ...codex, authStatus: "authenticated" },
    { ...codex, id: "codex-wsl", context: { kind: "wsl", distro: "Ubuntu" } },
    { id: "gemini", name: "Gemini", command: "gemini", args: [], env: {}, driver: "acp", available: true },
    { id: "opencode", name: "OpenCode", command: "opencode", args: [], env: {}, driver: "acp", available: true, authStatus: "unauthenticated" },
  ];
  const fixture = await mountFixture({ runners: [{ ...runner, agents }] });
  try {
    await choose(fixture.container, "Project", "Wollipog");
    const rows = agentRows(fixture.container);
    assert.deepEqual(rows.filter((row) => row.checked).map((row) => row.title), ["Claude Code — Native", "Codex App Server", "Gemini"]);
    const signedOut = rows.find((row) => row.title === "OpenCode");
    assert.ok(signedOut);
    assert.equal(signedOut.disabled, true);
    assert.equal(signedOut.checked, false);
    assert.equal(signedOut.second, "Sign in on Build Server first.");
    assert.equal(rows.find((row) => row.title === "Codex App Server")?.second, "Build Server · Signed in");
    assert.equal(rows.find((row) => row.title === "Gemini")?.second, "Build Server");
    assert.ok(dialog(fixture.container).querySelector(".surface.new-run-agents"), "the agents are one surface");
    await enterTask(fixture.container);
    await clickPrimary(fixture.container, "Run 3 Agents");
    assert.deepEqual(fixture.parallelRequests[0]?.agentIds, ["claude", "codex", "gemini"]);
  } finally {
    await unmountFixture(fixture);
  }
});

test("before a project is chosen the agents section says to choose one", async () => {
  const fixture = await mountFixture();
  try {
    const agents = [...dialog(fixture.container).querySelectorAll(".form .field")]
      .find((field) => field.querySelector(":scope > span:first-child")?.textContent === "Agents");
    assert.ok(agents);
    assert.equal(agents.querySelector(".field-helper")?.textContent, "Choose a project to see its agents.");
    assertNoDomNode(agents.querySelector(".choice-row"), "no agent rows before a project");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Location options read <folder> on <Machine> with the path below, and an unavailable one says why", async () => {
  const offline: RunnerView = { ...runner, runnerId: "runner-2", hostname: "studio.local", displayName: "Studio Mac", status: "offline" };
  const twoLocations: ProjectView = {
    ...project,
    locations: [
      { ...project.locations[0]!, isDefault: false },
      { ...project.locations[0]!, id: "location-2", runnerId: "runner-2", path: "/Users/me/src/docs", isDefault: false },
    ],
  };
  const fixture = await mountFixture({ runners: [runner, offline], projects: [twoLocations] });
  try {
    await choose(fixture.container, "Project", "Wollipog");
    await openSelect(fixture.container, "Location");
    const options = openOptions(fixture.container);
    assert.deepEqual(options.map((option) => option.label), ["wollipog on Build Server", "docs on Studio Mac"]);
    assert.match(options[0]!.text, /\/repos\/wollipog/u);
    assert.equal(options[0]!.disabled, false);
    assert.equal(options[1]!.disabled, true);
    assert.match(options[1]!.text, /Studio Mac is offline\./u);
    for (const option of options) assert.doesNotMatch(option.text, /runner-\d/u);
  } finally {
    await unmountFixture(fixture);
  }
});

test("two same-named projects in same-named folders on one Machine read apart, and each sends its own identity", async () => {
  const docs = (id: string, path: string, workspaceId: string): ProjectView => ({
    ...project,
    id,
    name: "Docs",
    locations: [{ ...project.locations[0]!, id: `${id}-location`, projectId: id, workspaceId, path }],
  });
  const twoDocs = { ...runner, workspaces: [
    { id: "workspace-a", name: "docs", path: "/home/me/a/docs" },
    { id: "workspace-b", name: "docs", path: "/home/me/b/docs" },
  ] };
  const expectations = [
    ["project-a", "Build Server · …/a/docs", "workspace-a"],
    ["project-b", "Build Server · …/b/docs", "workspace-b"],
  ] as const;
  for (const [projectId, where, workspaceId] of expectations) {
    const fixture = await mountFixture({
      runners: [twoDocs],
      projects: [docs("project-a", "/home/me/a/docs", "workspace-a"), docs("project-b", "/home/me/b/docs", "workspace-b")],
    });
    try {
      await openSelect(fixture.container, "Project");
      const options = openOptions(fixture.container).filter((option) => option.label === "Docs");
      assert.deepEqual(options.map((option) => option.text), ["DocsBuild Server · …/a/docs", "DocsBuild Server · …/b/docs"]);
      const option = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find((candidate) => candidate.textContent === `Docs${where}`);
      assert.ok(option);
      await act(async () => { option.click(); });
      await settle();
      assert.equal(trigger(fixture.container, "Project").getAttribute("aria-label"), `Project: Docs · ${where}`);
      await enterTask(fixture.container);
      await clickPrimary(fixture.container, "Run 2 Agents");
      assert.equal(fixture.parallelRequests[0]?.projectId, projectId);
      assert.equal(fixture.parallelRequests[0]?.projectLocationId, `${projectId}-location`);
      assert.equal(fixture.parallelRequests[0]?.workspaceId, workspaceId);
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("Project's one sentence says who can see the agents' sessions", async () => {
  const expectations = [
    ["user", "Only the project owner can see the agents' sessions."],
    ["team", "Everyone on the owning team can see the agents' sessions."],
    ["organization", "Everyone in your organization can see the agents' sessions."],
    [undefined, "Wollipog can't show who can see the agents' sessions."],
  ] as const;
  for (const [audience, expected] of expectations) {
    const fixture = await mountFixture({ projects: [{ ...project, audience }] });
    try {
      const helper = () => trigger(fixture.container, "Project").closest(".field")?.querySelector(":scope > .field-helper")?.textContent ?? null;
      assert.equal(helper(), null, "nothing before a project is chosen");
      await choose(fixture.container, "Project", "Wollipog");
      assert.equal(helper(), expected);
      await choose(fixture.container, "Project", "No Project");
      assert.equal(helper(), "This run won't be added to a project.");
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("Run a Workflow names the workflow without its version and labels each role in Title Case, prebound", async () => {
  const fixture = await mountFixture();
  try {
    await choose(fixture.container, "Project", "Wollipog");
    await chooseType(fixture.container, "Run a Workflow");
    assert.equal(trigger(fixture.container, "Workflow").getAttribute("aria-label"), "Workflow: Build + Review");
    assert.doesNotMatch(dialog(fixture.container).textContent ?? "", /· v1/u);
    await openSelect(fixture.container, "Workflow");
    assert.deepEqual(openOptions(fixture.container).map(({ label, text }) => [label, text]), [["Build + Review", "Build + ReviewVersion 1"]]);
    await act(async () => { domWindow.document.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as never); });
    assert.equal(trigger(fixture.container, "Builder Agent").getAttribute("aria-label"), "Builder Agent: Claude Code");
    assert.equal(trigger(fixture.container, "Reviewer Agent").getAttribute("aria-label"), "Reviewer Agent: Codex App Server");
    const roles = dialog(fixture.container).querySelector("fieldset.new-run-roles");
    assert.equal(roles?.querySelector("legend")?.textContent, "Roles");
    assert.deepEqual([...roles!.querySelectorAll(".facts dt, .facts dd")].map((node) => node.textContent), ["Approver", "You, in the run"]);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a role the person rebinds keeps that agent through a Machine update, and is sent as chosen", async () => {
  const fixture = await mountFixture();
  try {
    await choose(fixture.container, "Project", "Wollipog");
    await chooseType(fixture.container, "Run a Workflow");
    await choose(fixture.container, "Reviewer Agent", "Claude Code");
    // The same Machine, reported again: its agents arrive as new objects.
    await act(async () => { fixture.socket.push(snapshot({ runners: [{ ...runner, agents: runner.agents.map((agent) => ({ ...agent })) }] })); });
    await settle();
    assert.equal(trigger(fixture.container, "Reviewer Agent").getAttribute("aria-label"), "Reviewer Agent: Claude Code");
    await enterTask(fixture.container);
    await clickPrimary(fixture.container, "Start Workflow");
    assert.deepEqual(fixture.workflowRequests[0]?.agentBindings, { claude: "claude", codex: "claude" });
  } finally {
    await unmountFixture(fixture);
  }
});

test("a role whose matching agent is signed out starts unbound, and Start Workflow says why", async () => {
  const fixture = await mountFixture({ runners: [{ ...runner, agents: [claude, { ...codex, authStatus: "unauthenticated" }] }] });
  try {
    await choose(fixture.container, "Project", "Wollipog");
    await chooseType(fixture.container, "Run a Workflow");
    await enterTask(fixture.container);
    assert.equal(trigger(fixture.container, "Reviewer Agent").getAttribute("aria-label"), "Reviewer Agent: Choose an Agent…");
    assert.equal(button(fixture.container, "Start Workflow").disabled, true);
    assert.equal(footerReason(fixture.container), "Choose an agent for every role.");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a disabled primary says why in the footer, in the order the fields read", async () => {
  const fixture = await mountFixture();
  try {
    const primary = () => button(fixture.container, /^Run (\d )?Agents?$/u);
    assert.equal(footerReason(fixture.container), "Enter a task to continue.");
    assert.equal(primary().disabled, true);
    assert.equal(primary().getAttribute("aria-describedby"), dialog(fixture.container).querySelector(".new-run-reason")?.id);
    await enterTask(fixture.container);
    assert.equal(footerReason(fixture.container), "Choose a project to continue.");
    await choose(fixture.container, "Project", "Wollipog");
    assert.equal(footerReason(fixture.container), null);
    for (const row of dialog(fixture.container).querySelectorAll<HTMLInputElement>(".new-run-agents input:checked")) {
      await act(async () => { row.click(); });
    }
    assert.equal(footerReason(fixture.container), "Choose at least one agent.");
    assert.equal(primary().textContent, "Run Agents");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a server error is a danger notice at the end of the body, never in the footer", async () => {
  const fixture = await mountFixture({}, { failCreate: new ApiError("runner rejected the run: workspace locked", 409) });
  try {
    await choose(fixture.container, "Project", "Wollipog");
    await enterTask(fixture.container);
    await clickPrimary(fixture.container, "Run 2 Agents");
    const body = dialog(fixture.container).querySelector(".modal-body");
    const notice = body?.lastElementChild;
    assert.ok(notice, "the body has content");
    assert.ok(notice.classList.contains("notice"), "the notice ends the body");
    assert.ok(notice.classList.contains("t-danger"));
    assert.match(notice.textContent ?? "", /The run didn't start\. Check the choices above and try again\./u);
    assertNoDomNode(dialog(fixture.container).querySelector(".form-error"), "no footer error");
    assert.deepEqual([...dialog(fixture.container).querySelectorAll(".modal-foot > button")].map((node) => node.textContent), ["Cancel", "Run 2 Agents"]);
    assert.equal(dialog(fixture.container).querySelector(".modal-foot")?.textContent, "CancelRun 2 Agents", "nothing else in the footer");
    const details = [...notice.querySelectorAll("button")].find((candidate) => candidate.textContent === "Show Details");
    assert.ok(details, "the server's words are behind Show Details");
    await act(async () => { details.click(); });
    assert.match(notice.textContent ?? "", /workspace locked/u);
    assert.equal(fixture.closed(), 0);
  } finally {
    await unmountFixture(fixture);
  }
});

test("with no Machine online a warning leads the body, the form stays visible and Open Connections goes there", async () => {
  const fixture = await mountFixture({ runners: [] });
  try {
    const first = dialog(fixture.container).querySelector(".modal-body")?.firstElementChild;
    assert.ok(first, "the body has content");
    assert.ok(first.classList.contains("notice") && first.classList.contains("t-warning"), "a warning notice comes first");
    assert.match(first.textContent ?? "", /No Machines Online/u);
    assert.match(first.textContent ?? "", /Start Wollipog on a machine to run agents\./u);
    assert.ok(dialog(fixture.container).querySelector("textarea"), "the form stays visible");
    assert.equal(trigger(fixture.container, "Project").getAttribute("aria-disabled"), null);
    await enterTask(fixture.container);
    assert.equal(footerReason(fixture.container), "Bring a machine online to continue.");
    assert.doesNotMatch(dialog(fixture.container).textContent ?? "", /runner/iu);
    await act(async () => { button(fixture.container, "Open Connections").click(); });
    assert.deepEqual(fixture.pushed.at(-1), { name: "runners", section: "machines" });
    assert.equal(fixture.closed(), 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("without projects the run is placed by Machine and Folder, and no text reads runner", async () => {
  const fixture = await mountFixture({
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false },
    projects: undefined,
  });
  try {
    assert.deepEqual(fieldLabels(fixture.container), ["Task", "Machine", "Folder", "Agents", "Title (Optional)"]);
    assert.equal(trigger(fixture.container, "Machine").getAttribute("aria-label"), "Machine: Build Server");
    assert.equal(trigger(fixture.container, "Folder").getAttribute("aria-label"), "Folder: Wollipog");
    assert.doesNotMatch(dialog(fixture.container).textContent ?? "", /runner/iu);
    await enterTask(fixture.container);
    await clickPrimary(fixture.container, "Run 2 Agents");
    assert.deepEqual(fixture.parallelRequests[0], {
      runnerId: runner.runnerId,
      workspaceId: "workspace-1",
      agentIds: ["claude", "codex"],
      task: "Implement the Project flow",
      title: undefined,
      useWorktree: true,
    });
  } finally {
    await unmountFixture(fixture);
  }
});

test("parallel run submission sends the selected exact Project identity", async () => {
  const fixture = await mountFixture();
  try {
    await choose(fixture.container, "Project", "Wollipog");
    await enterTask(fixture.container);
    await clickPrimary(fixture.container, "Run 2 Agents");

    assert.equal(fixture.parallelRequests.length, 1);
    assert.deepEqual(fixture.parallelRequests[0], {
      runnerId: runner.runnerId,
      workspaceId: "workspace-1",
      projectId: project.id,
      projectLocationId: "location-1",
      agentIds: ["claude", "codex"],
      task: "Implement the Project flow",
      title: undefined,
      useWorktree: true,
    });
    assert.deepEqual(fixture.pushed.at(-1), { name: "run", id: "parallel-run" });
  } finally {
    await unmountFixture(fixture);
  }
});

test("workflow run submission sends the selected exact Project identity", async () => {
  const fixture = await mountFixture();
  try {
    await choose(fixture.container, "Project", "Wollipog");
    await chooseType(fixture.container, "Run a Workflow");
    await enterTask(fixture.container);
    await clickPrimary(fixture.container, "Start Workflow");

    assert.equal(fixture.workflowRequests.length, 1);
    assert.equal(fixture.workflowRequests[0]?.runnerId, runner.runnerId);
    assert.equal(fixture.workflowRequests[0]?.workspaceId, "workspace-1");
    assert.equal(fixture.workflowRequests[0]?.projectId, project.id);
    assert.equal(fixture.workflowRequests[0]?.projectLocationId, "location-1");
    assert.deepEqual(fixture.workflowRequests[0]?.agentBindings, { claude: "claude", codex: "codex" });
    assert.equal(fixture.workflowRequests[0]?.workflowVersion, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("No Project submission sends explicit null Project identities", async () => {
  const fixture = await mountFixture();
  try {
    await choose(fixture.container, "Project", "No Project");
    await enterTask(fixture.container);
    await clickPrimary(fixture.container, "Run 2 Agents");

    assert.equal(fixture.parallelRequests.length, 1);
    assert.equal(fixture.parallelRequests[0]?.projectId, null);
    assert.equal(fixture.parallelRequests[0]?.projectLocationId, null);
    assert.equal(fixture.parallelRequests[0]?.runnerId, runner.runnerId);
    assert.equal(fixture.parallelRequests[0]?.workspaceId, "workspace-1");
  } finally {
    await unmountFixture(fixture);
  }
});
