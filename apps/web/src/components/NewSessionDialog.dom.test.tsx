import { setExperimentFlag } from "../experiments.js";
import { LOCAL_INSTANCE_SCOPE } from "../instance-storage.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  CreateSessionRequest,
  ProjectView,
  RunnerView,
  UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { NewSessionDialog, type NewSessionPreset } from "./NewSessionDialog.js";

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
  ],
  workspaces: [{ id: "workspace-1", name: "Wollipog", path: "/repos/wollipog" }],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 67,
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

function DialogWhenReady({ preset, onOpenTerminal }: { preset?: NewSessionPreset; onOpenTerminal: () => void }) {
  const ready = useStoreSelector((state) => state.snapshotLoaded);
  return ready ? <NewSessionDialog onClose={() => {}} onOpenTerminal={onOpenTerminal} preset={preset} /> : null;
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  socket: FakeSocket;
  requests: CreateSessionRequest[];
  terminalOpens: { count: number };
}

let fixtureSequence = 0;

async function mountFixture(
  snapshotOverrides: Partial<UiSnapshotMessage> = {},
  preset?: NewSessionPreset,
  createError?: string | Error,
): Promise<Fixture> {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const requests: CreateSessionRequest[] = [];
  const terminalOpens = { count: 0 };
  fixtureSequence += 1;
  const connection: UiConnectionRuntime = {
    instanceId: `new-session-${fixtureSequence}`,
    runtimeKey: `new-session-${fixtureSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const client = {
    ...api,
    createSession: async (request: CreateSessionRequest) => {
      requests.push(structuredClone(request));
      if (createError) throw typeof createError === "string" ? new Error(createError) : createError;
      return { id: "session-1" };
    },
  } as unknown as ApiClient;

  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <DialogWhenReady preset={preset} onOpenTerminal={() => { terminalOpens.count += 1; }} />
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => { socket.push(snapshot(snapshotOverrides)); });
  return { container, root, socket, requests, terminalOpens };
}

async function unmountFixture(fixture: Fixture): Promise<void> {
  await act(async () => { fixture.root.unmount(); });
  fixture.container.remove();
}

function projectSelect(container: HTMLDivElement): HTMLSelectElement {
  const select = container.querySelector('select[aria-label="Project"]') as HTMLSelectElement | null;
  assert.ok(select, "Project select is rendered");
  return select;
}

function selectProject(container: HTMLDivElement, value: string): void {
  const select = projectSelect(container);
  const valueSetter = Object.getOwnPropertyDescriptor(domWindow.HTMLSelectElement.prototype, "value")?.set;
  assert.ok(valueSetter);
  valueSetter.call(select, value);
  select.dispatchEvent(new domWindow.Event("change", { bubbles: true }) as never);
}

function createButton(container: HTMLDivElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim() === "Create Session");
  assert.ok(button, "Create Session button is rendered");
  return button;
}

function submitWithEnter(container: HTMLDivElement): void {
  const form = container.querySelector(".form");
  assert.ok(form, "dialog form is rendered");
  form.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as never);
}

test("Project visibility copy names every audience and the new transcript consequence", async () => {
  const expectations = [
    ["user", "Project Visibility: Only the Project Owner"],
    ["team", "Project Visibility: Everyone on the Owning Team"],
    ["organization", "Project Visibility: Everyone in Your Organization"],
  ] as const;
  for (const [audience, expected] of expectations) {
    const fixture = await mountFixture({ projects: [{ ...project, audience }] });
    try {
      await act(async () => { selectProject(fixture.container, project.id); });
      const copy = fixture.container.querySelector(".new-session-project-actions")?.textContent ?? "";
      assert.match(copy, new RegExp(expected));
      assert.match(copy, /New session transcripts use the Project's visibility\./);
      assert.doesNotMatch(copy, /\bAccess:/);
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("Project visibility copy stays neutral before selection and fails closed when audience is missing", async () => {
  const fixture = await mountFixture({ projects: [{ ...project, audience: undefined }] });
  try {
    const copy = () => fixture.container.querySelector(".new-session-project-actions")?.textContent ?? "";
    assert.match(copy(), /Choose a Project to organize the new session, or choose No Project./);
    assert.doesNotMatch(copy(), /transcripts use/);

    await act(async () => { selectProject(fixture.container, project.id); });
    assert.match(copy(), /This control plane does not report the Project's visibility./);
    assert.doesNotMatch(copy(), /transcripts use/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("Conductor-Led Work is disabled unless the runner advertises an available conductor", async () => {
  // The preset renders only behind the device-local experiment flag, which now defaults off;
  // this test is about runner availability, so it opts in first.
  setExperimentFlag("conductor", true, LOCAL_INSTANCE_SCOPE);
  const disabledFixture = await mountFixture();
  try {
    await act(async () => { selectProject(disabledFixture.container, project.id); });
    const conductor = [...disabledFixture.container.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Conductor-Led Work")) as HTMLButtonElement | undefined;
    assert.ok(conductor);
    assert.equal(conductor.disabled, true);
    assert.match(conductor.textContent ?? "", /Requires an available native Claude conductor\./);
  } finally {
    await unmountFixture(disabledFixture);
  }

  const enabledRunner: RunnerView = {
    ...runner,
    agents: [
      ...runner.agents,
      {
        id: "conductor",
        name: "Conductor (Agent Manager)",
        command: "claude",
        args: [],
        env: {},
        driver: "claude-code",
        available: true,
      },
    ],
  };
  const enabledFixture = await mountFixture({ runners: [enabledRunner] });
  try {
    await act(async () => { selectProject(enabledFixture.container, project.id); });
    const conductor = [...enabledFixture.container.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Conductor-Led Work")) as HTMLButtonElement | undefined;
    assert.ok(conductor);
    assert.equal(conductor.disabled, false);
  } finally {
    await unmountFixture(enabledFixture);
  }
});

test("Projects mode requires an explicit Project choice and No Project sends exact null identities", async () => {
  const fixture = await mountFixture();
  try {
    assert.equal(projectSelect(fixture.container).value, "", "the only Project is not selected implicitly");
    assert.equal(createButton(fixture.container).disabled, true);

    await act(async () => { selectProject(fixture.container, "__no_project__"); });
    assert.equal(createButton(fixture.container).disabled, false);

    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.requests[0], {
      runnerId: runner.runnerId,
      workspaceId: "workspace-1",
      projectId: null,
      projectLocationId: null,
      agentId: "claude",
      useWorktree: false,
      executionTargetId: undefined,
      config: undefined,
      workspacePath: undefined,
      acpSessionContext: undefined,
    });
  } finally {
    await unmountFixture(fixture);
  }
});

test("an explicit No Project preset is selected and launchable on mount", async () => {
  const fixture = await mountFixture({}, { projectId: null });
  try {
    assert.equal(projectSelect(fixture.container).value, "__no_project__");
    assert.equal(createButton(fixture.container).disabled, false);

    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.projectId, null);
    assert.equal(fixture.requests[0]?.projectLocationId, null);
    assert.equal(fixture.requests[0]?.runnerId, runner.runnerId);
    assert.equal(fixture.requests[0]?.workspaceId, "workspace-1");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a delayed Project preset hydrates once its exact Project and Location arrive", async () => {
  const fixture = await mountFixture(
    { projects: [] },
    { projectId: project.id, projectLocationId: "location-1" },
  );
  try {
    assert.equal(projectSelect(fixture.container).value, "");
    assert.equal(createButton(fixture.container).disabled, true);

    await act(async () => { fixture.socket.push(snapshot()); });

    assert.equal(projectSelect(fixture.container).value, project.id);
    const location = fixture.container.querySelector('[role="radio"][aria-checked="true"]');
    assert.equal(location?.textContent?.includes("/repos/wollipog"), true);
    assert.equal(createButton(fixture.container).disabled, false);
  } finally {
    await unmountFixture(fixture);
  }
});

test("delayed preset hydration never replaces an explicit user choice", async () => {
  const fixture = await mountFixture(
    { projects: [] },
    { projectId: project.id, projectLocationId: "location-1" },
  );
  try {
    await act(async () => { selectProject(fixture.container, "__no_project__"); });
    assert.equal(projectSelect(fixture.container).value, "__no_project__");

    await act(async () => { fixture.socket.push(snapshot()); });

    assert.equal(projectSelect(fixture.container).value, "__no_project__");
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.projectId, null);
    assert.equal(fixture.requests[0]?.projectLocationId, null);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a selected Location becoming unavailable disables submission and fails closed", async () => {
  const fixture = await mountFixture();
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    assert.equal(createButton(fixture.container).disabled, false);

    const unavailableProject: ProjectView = {
      ...project,
      locations: [{ ...project.locations[0]!, availability: "workspace_missing" }],
    };
    await act(async () => { fixture.socket.push(snapshot({ projects: [unavailableProject] })); });

    assert.equal(createButton(fixture.container).disabled, true);
    await act(async () => { submitWithEnter(fixture.container); });
    assert.equal(fixture.requests.length, 0);
    assert.equal(
      fixture.container.querySelector(".form-error")?.textContent,
      "Choose an available Project Location.",
    );
  } finally {
    await unmountFixture(fixture);
  }
});

test("removing the selected Project from the live inventory disables submission and fails closed", async () => {
  const fixture = await mountFixture();
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    assert.equal(createButton(fixture.container).disabled, false);

    await act(async () => { fixture.socket.push(snapshot({ projects: [] })); });

    assert.equal(createButton(fixture.container).disabled, true);
    await act(async () => { submitWithEnter(fixture.container); });
    assert.equal(fixture.requests.length, 0);
    assert.equal(
      fixture.container.querySelector(".form-error")?.textContent,
      "Choose an available Project Location.",
    );
  } finally {
    await unmountFixture(fixture);
  }
});

test("Native TUI is capability-gated, sends one-shot intent, and opens Terminal after success", async () => {
  const fixture = await mountFixture({
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      nativeTuiLaunch: true,
    },
  });
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    const harness = fixture.container.querySelector('[role="radiogroup"][aria-label="Harness"]');
    assert.ok(harness);
    assert.match(harness.textContent ?? "", /Use structured chat, tool events, approval cards, and manager controls\./);
    assert.match(harness.textContent ?? "", /Its activity does not appear in the structured transcript\./);
    const native = [...harness.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLButtonElement | undefined;
    assert.ok(native);
    assert.equal(native.disabled, false);

    await act(async () => { native.click(); });
    await act(async () => { createButton(fixture.container).click(); });

    assert.equal(fixture.requests[0]?.launchSurface, "native_tui");
    assert.equal(fixture.terminalOpens.count, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("Native TUI is disabled when the control plane does not advertise atomic launch", async () => {
  const fixture = await mountFixture();
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    const native = [...fixture.container.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLButtonElement | undefined;
    assert.ok(native);
    assert.equal(native.disabled, true);
    assert.match(fixture.container.textContent ?? "", /requires a newer control plane/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("Native TUI initial launch fails closed against a v66 runner", async () => {
  const fixture = await mountFixture({
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      nativeTuiLaunch: true,
    },
    runners: [{ ...runner, protocolVersion: 66 }],
  });
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    const native = [...fixture.container.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLButtonElement | undefined;
    assert.ok(native);
    assert.equal(native.disabled, true);
    assert.match(fixture.container.textContent ?? "", /Initial Native TUI launch requires protocol v67/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a failed atomic Native TUI launch leaves Terminal closed and surfaces the error", async () => {
  const fixture = await mountFixture({
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      nativeTuiLaunch: true,
    },
  }, undefined, "provider TUI exited");
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    const native = [...fixture.container.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLButtonElement | undefined;
    assert.ok(native);
    await act(async () => { native.click(); });
    await act(async () => { createButton(fixture.container).click(); });

    assert.equal(fixture.requests[0]?.launchSurface, "native_tui");
    assert.equal(fixture.terminalOpens.count, 0);
    assert.equal(fixture.container.querySelector(".form-error")?.textContent, "provider TUI exited");
  } finally {
    await unmountFixture(fixture);
  }
});

test("an ambiguous Native TUI launch retains one session and prevents duplicate creation", async () => {
  const retainedId = "session-retained";
  const fixture = await mountFixture({
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      nativeTuiLaunch: true,
    },
  }, undefined, new ApiError(
    `Session ${retainedId} was retained because the Native TUI launch outcome is unknown.`,
    504,
    "NATIVE_TUI_LAUNCH_AMBIGUOUS",
    { sessionId: retainedId },
  ));
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    const native = [...fixture.container.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLButtonElement | undefined;
    assert.ok(native);
    await act(async () => { native.click(); });
    await act(async () => { createButton(fixture.container).click(); });

    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.terminalOpens.count, 0);
    assert.equal(createButton(fixture.container).disabled, true);
    assert.match(fixture.container.querySelector(".form-error")?.textContent ?? "", /was retained/);
    assert.ok([...fixture.container.querySelectorAll("button")]
      .some((button) => button.textContent === "Open Retained Session"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("failed Native TUI compensation exposes the retained session and disables retry", async () => {
  const retainedId = "session-cleanup-failed";
  const fixture = await mountFixture({
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      nativeTuiLaunch: true,
    },
  }, undefined, new ApiError(
    `Native TUI open failed; session cleanup failed. Session ${retainedId} was retained.`,
    500,
    "NATIVE_TUI_COMPENSATION_FAILED",
    { sessionId: retainedId },
  ));
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    const native = [...fixture.container.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLButtonElement | undefined;
    assert.ok(native);
    await act(async () => { native.click(); });
    await act(async () => { createButton(fixture.container).click(); });

    assert.equal(fixture.requests.length, 1);
    assert.equal(createButton(fixture.container).disabled, true);
    assert.ok([...fixture.container.querySelectorAll("button")]
      .some((button) => button.textContent === "Open Retained Session"));
  } finally {
    await unmountFixture(fixture);
  }
});
