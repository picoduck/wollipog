import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { Window } from "happy-dom";
import type {
  CreateRunRequest,
  CreateWorkflowRunRequest,
  ProjectView,
  RunnerView,
  UiSnapshotMessage,
  WorkflowDefinition,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { NewRunDialog } from "./NewRunDialog.js";

const domWindow = new Window({ url: "http://localhost/" });
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLSelectElement: domWindow.HTMLSelectElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
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

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  agents: [
    { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true },
    { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true },
  ],
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

const navigation: ViewNavigation = {
  current: () => ({ name: "inbox" }),
  push() {},
  listen: () => () => {},
};

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

function DialogWhenReady() {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  return ready ? <NewRunDialog onClose={() => {}} /> : null;
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  socket: FakeSocket;
  parallelRequests: CreateRunRequest[];
  workflowRequests: CreateWorkflowRunRequest[];
}

let fixtureSequence = 0;

async function mountFixture(snapshotOverrides: Partial<UiSnapshotMessage> = {}): Promise<Fixture> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const parallelRequests: CreateRunRequest[] = [];
  const workflowRequests: CreateWorkflowRunRequest[] = [];
  fixtureSequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `new-run-${fixtureSequence}`,
    runtimeKey: `new-run-${fixtureSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const client = {
    ...api,
    workflowDefinitions: async () => [workflow],
    createRun: async (request: CreateRunRequest) => {
      parallelRequests.push(structuredClone(request));
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
          <DialogWhenReady />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => { socket.push(snapshot(snapshotOverrides)); });
  return { container, root, socket, parallelRequests, workflowRequests };
}

async function unmountFixture(fixture: Fixture): Promise<void> {
  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
}

function selectByLabel(container: HTMLDivElement, label: string, value: string): void {
  const field = [...container.querySelectorAll("label")].find((candidate) =>
    candidate.querySelector(":scope > span")?.textContent === label);
  const select = field?.querySelector("select") as HTMLSelectElement | null;
  assert.ok(select, `${label} select is rendered`);
  const valueSetter = Object.getOwnPropertyDescriptor(domWindow.HTMLSelectElement.prototype, "value")?.set;
  assert.ok(valueSetter);
  valueSetter.call(select, value);
  select.dispatchEvent(new domWindow.Event("change", { bubbles: true }) as never);
}

function enterTask(container: HTMLDivElement): void {
  const task = container.querySelector("textarea") as HTMLTextAreaElement | null;
  assert.ok(task);
  const valueSetter = Object.getOwnPropertyDescriptor(domWindow.HTMLTextAreaElement.prototype, "value")?.set;
  assert.ok(valueSetter);
  valueSetter.call(task, "Implement the Project flow");
  Simulate.change(task, { target: task });
}

function clickButton(container: HTMLDivElement, text: string): void {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim() === text || candidate.querySelector("strong")?.textContent?.trim() === text);
  assert.ok(button, `${text} button is rendered`);
  assert.equal(button.disabled, false, `${text} button is enabled: ${container.textContent}`);
  button.click();
}

test("run Project copy names every audience and the new transcript consequence", async () => {
  const expectations = [
    ["user", "Project Visibility: Only the Project Owner"],
    ["team", "Project Visibility: Everyone on the Owning Team"],
    ["organization", "Project Visibility: Everyone in Your Organization"],
  ] as const;
  for (const [audience, expected] of expectations) {
    const fixture = await mountFixture({ projects: [{ ...project, audience }] });
    try {
      await act(async () => { selectByLabel(fixture.container, "Project", project.id); });
      const copy = [...fixture.container.querySelectorAll("label")]
        .find((label) => label.querySelector(":scope > span")?.textContent === "Project")?.textContent ?? "";
      assert.equal(fixture.container.querySelector('select[aria-label="Project"]')?.getAttribute("aria-label"), "Project");
      assert.match(copy, new RegExp(expected));
      assert.match(copy, /New run session transcripts use the Project's visibility\./);
      assert.doesNotMatch(copy, /\bAccess:/);
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("run Project copy stays neutral before selection and fails closed when audience is missing", async () => {
  const fixture = await mountFixture({ projects: [{ ...project, audience: undefined }] });
  try {
    const copy = () => [...fixture.container.querySelectorAll("label")]
      .find((label) => label.querySelector(":scope > span")?.textContent === "Project")?.textContent ?? "";
    assert.match(copy(), /Choose a Project to organize related run sessions, or choose No Project./);
    assert.doesNotMatch(copy(), /transcripts use/);

    await act(async () => { selectByLabel(fixture.container, "Project", project.id); });
    assert.match(copy(), /This control plane does not report the Project's visibility./);
    assert.doesNotMatch(copy(), /transcripts use/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("workflow copy discloses the organization-visible conductor outside a narrower Project", async () => {
  const conductorRunner: RunnerView = {
    ...runner,
    agents: [
      ...runner.agents,
      { id: "conductor", name: "Conductor", command: "claude", args: [], env: {}, driver: "claude-code", available: true },
    ],
  };
  for (const audience of ["user", "team"] as const) {
    const fixture = await mountFixture({
      projects: [{ ...project, audience }],
      runners: [conductorRunner],
    });
    try {
      await act(async () => {
        selectByLabel(fixture.container, "Project", project.id);
        clickButton(fixture.container, "Build + Review Workflow");
      });
      const copy = [...fixture.container.querySelectorAll("label")]
        .find((label) => label.querySelector(":scope > span")?.textContent === "Project")?.textContent ?? "";
      assert.match(copy, /Worker session transcripts use the Project's visibility./);
      assert.match(copy, /The conductor session runs outside the Project with organization visibility./);
      assert.doesNotMatch(copy, /New run session transcripts use the Project's visibility./);
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("parallel run submission sends the selected exact Project identity", async () => {
  const fixture = await mountFixture();
  try {
    await act(async () => {
      selectByLabel(fixture.container, "Project", project.id);
      enterTask(fixture.container);
    });
    await act(async () => { clickButton(fixture.container, "Run 2 Agents"); });

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
  } finally {
    await unmountFixture(fixture);
  }
});

test("workflow run submission sends the selected exact Project identity", async () => {
  const fixture = await mountFixture();
  try {
    await act(async () => {
      selectByLabel(fixture.container, "Project", project.id);
      clickButton(fixture.container, "Build + Review Workflow");
      enterTask(fixture.container);
    });
    await act(async () => {});
    await act(async () => { clickButton(fixture.container, "Start Workflow"); });

    assert.equal(fixture.workflowRequests.length, 1);
    assert.equal(fixture.workflowRequests[0]?.runnerId, runner.runnerId);
    assert.equal(fixture.workflowRequests[0]?.workspaceId, "workspace-1");
    assert.equal(fixture.workflowRequests[0]?.projectId, project.id);
    assert.equal(fixture.workflowRequests[0]?.projectLocationId, "location-1");
  } finally {
    await unmountFixture(fixture);
  }
});

test("No Project submission sends explicit null Project identities", async () => {
  const fixture = await mountFixture();
  try {
    await act(async () => {
      selectByLabel(fixture.container, "Project", "__no_project__");
      enterTask(fixture.container);
    });
    await act(async () => { clickButton(fixture.container, "Run 2 Agents"); });

    assert.equal(fixture.parallelRequests.length, 1);
    assert.equal(fixture.parallelRequests[0]?.projectId, null);
    assert.equal(fixture.parallelRequests[0]?.projectLocationId, null);
    assert.equal(fixture.parallelRequests[0]?.runnerId, runner.runnerId);
    assert.equal(fixture.parallelRequests[0]?.workspaceId, "workspace-1");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Project-aware runs show one global no-runners state above the form", async () => {
  const fixture = await mountFixture({ runners: [] });
  try {
    const notices = [...fixture.container.querySelectorAll("p")].filter((candidate) =>
      candidate.textContent === "No runners online. Start a runner first.");
    assert.equal(notices.length, 1);
    assert.equal(fixture.container.querySelector(".modal-body")?.firstElementChild, notices[0]);
    assert.ok(fixture.container.querySelector("select"), "Project-aware form remains available for Project context");
  } finally {
    await unmountFixture(fixture);
  }
});
