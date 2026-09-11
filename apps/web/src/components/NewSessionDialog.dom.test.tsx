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
  AgentHarnessDefaultsView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { loadAgentDefaults, saveAgentDefault } from "../agent-defaults.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { NewSessionDialog, type NewSessionPreset } from "./NewSessionDialog.js";
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
  defaults: () => Promise<AgentHarnessDefaultsView> = async () => ({ defaults: [] }),
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
    agentHarnessDefaults: defaults,
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

/**
 * No trigger to open any more, which is the point of #832: both presets are on screen, so choosing
 * one is a single click and there is no popup whose height could disagree with its touch targets.
 */
async function choosePermissionPreset(container: HTMLDivElement, label: string) {
  const option = permissionPresetCard(container, label);
  assert.ok(option, `Permission Preset offers ${label}`);
  await act(async () => { option.click(); });
}

function permissionPresetGroup(container: HTMLDivElement): Element {
  const group = container.querySelector('[role="radiogroup"][aria-label="Permission Preset"]');
  assert.ok(group, "Permission Preset renders an always-visible choice group");
  return group;
}

function permissionPresetCard(container: HTMLDivElement, title: string): HTMLButtonElement | undefined {
  return [...permissionPresetGroup(container).querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    .find((button) => button.querySelector(".ui-choice-card-title")?.textContent?.trim() === title);
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

test("saved-default recovery buttons name the agent they actually select", async () => {
  domWindow.localStorage.clear();
  saveAgentDefault({}, runner.runnerId, "codex-app");
  const recoveryRunner: RunnerView = {
    ...runner,
    agents: [
      { id: "codex-app", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: false },
      { id: "codex-exec", name: "Codex", command: "codex", args: ["exec"], env: {}, driver: "codex", available: true },
    ],
  };
  const unavailableFixture = await mountFixture(
    { runners: [recoveryRunner] },
    { runnerId: runner.runnerId },
  );
  try {
    const action = [...unavailableFixture.container.querySelectorAll("button")].find((button) =>
      button.textContent?.trim() === "Use Codex — Non-Interactive (codex exec)") as HTMLButtonElement | undefined;
    assert.ok(action, "the recovery action names Codex Exec rather than App Server");
    await act(async () => { action.click(); });
    assert.equal(loadAgentDefaults()[runner.runnerId], "codex-exec");
  } finally {
    await unmountFixture(unavailableFixture);
    domWindow.localStorage.clear();
  }

  saveAgentDefault({}, runner.runnerId, "missing-agent");
  const missingFixture = await mountFixture({}, { runnerId: runner.runnerId });
  try {
    const action = [...missingFixture.container.querySelectorAll("button")].find((button) =>
      button.textContent?.trim() === "Use Claude Code") as HTMLButtonElement | undefined;
    assert.ok(action, "the recovery action names Claude Code when that is the actual fallback");
  } finally {
    await unmountFixture(missingFixture);
    domWindow.localStorage.clear();
  }
});

test("retired Conductor stays hidden and native orchestrator selection is sent at creation", async () => {
  setExperimentFlag("conductor", true, LOCAL_INSTANCE_SCOPE);
  const enabledRunner: RunnerView = {
    ...runner, protocolVersion: 109,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  };
  const fixture = await mountFixture({ runners: [enabledRunner] });
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    assert.equal(fixture.container.textContent?.includes("Conductor-Led Work"), false);
    await choosePermissionPreset(fixture.container, "Orchestrator");
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.config?.permissionMode, "orchestrator");
  } finally { await unmountFixture(fixture); }
});

test("Native TUI orchestrator creation is gated by its own runner capability", async () => {
  for (const protocolVersion of [111, 112]) {
    const enabledRunner: RunnerView = {
      ...runner, protocolVersion,
      agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
        permissionModes: ["default", "orchestrator"],
      } })),
    };
    const fixture = await mountFixture({ runners: [enabledRunner], capabilities: {
      sessionSubscriptions: false, nativeTuiLaunch: true,
    } });
    try {
      await act(async () => { selectProject(fixture.container, project.id); });
      await choosePermissionPreset(fixture.container, "Orchestrator");
      const tui = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find((button) => button.textContent?.includes("Native TUI"))!;
      assert.ok(tui);
      assert.equal(tui.disabled, protocolVersion < 112);
      if (protocolVersion === 112) {
        await act(async () => { tui.click(); });
        await act(async () => { createButton(fixture.container).click(); });
        assert.equal(fixture.requests[0]?.launchSurface, "native_tui");
        assert.equal(fixture.requests[0]?.config?.permissionMode, "orchestrator");
      }
    } finally { await unmountFixture(fixture); }
  }
});

test("WSL keeps ordinary Native TUI while Direct Orchestrator requires v124 and fresh launcher attestation", async () => {
  const wslRunner: RunnerView = {
    ...runner,
    os: "windows",
    protocolVersion: 122,
    agents: runner.agents.map((agent) => ({
      ...agent,
      context: { kind: "wsl" as const, distro: "Ubuntu-24.04" },
      capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
        permissionModes: ["default", "orchestrator"],
      },
    })),
  };
  const ordinary = await mountFixture({
    runners: [wslRunner],
    capabilities: { sessionSubscriptions: false, nativeTuiLaunch: true },
  });
  try {
    await act(async () => { selectProject(ordinary.container, project.id); });
    const tui = [...ordinary.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI"))!;
    assert.ok(tui);
    assert.equal(tui.disabled, false, "ordinary WSL Native TUI remains available");
    await act(async () => { tui.click(); });
    assert.equal(createButton(ordinary.container).disabled, false,
      "ordinary WSL Native TUI remains launchable rather than only selectable");
    await act(async () => { createButton(ordinary.container).click(); });
    assert.equal(ordinary.requests[0]?.launchSurface, "native_tui");
  } finally {
    await unmountFixture(ordinary);
  }

  const orchestrator = await mountFixture({
    runners: [wslRunner],
    capabilities: { sessionSubscriptions: false, nativeTuiLaunch: true },
  }, undefined, undefined, async () => ({ defaults: [{
    agentId: "claude", driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu-24.04" }, name: "Claude",
    installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" },
  }] }));
  try {
    await act(async () => { selectProject(orchestrator.container, project.id); });
    assert.match(orchestrator.container.textContent ?? "",
      /verified Direct WSL bridge and a bubblewrap-isolated runner/u);
    assert.equal(createButton(orchestrator.container).disabled, true);
    await act(async () => { submitWithEnter(orchestrator.container); });
    assert.equal(orchestrator.requests.length, 0);
  } finally {
    await unmountFixture(orchestrator);
  }

  const protocolOnly = await mountFixture({
    runners: [{ ...wslRunner, protocolVersion: 124 }],
    capabilities: { sessionSubscriptions: false, nativeTuiLaunch: true },
  }, undefined, undefined, async () => ({ defaults: [{
    agentId: "claude", driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu-24.04" }, name: "Claude",
    installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" },
  }] }));
  try {
    await act(async () => { selectProject(protocolOnly.container, project.id); });
    assert.equal(createButton(protocolOnly.container).disabled, true,
      "a v124 runner cannot replace fresh launcher attestation");
  } finally {
    await unmountFixture(protocolOnly);
  }

  const safeRunner: RunnerView = {
    ...wslRunner,
    protocolVersion: 124,
    runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4,
      executionIsolation: { mode: "bwrap", network: "deny" } },
    agents: wslRunner.agents.map((agent) => ({
      ...agent,
      wslAgentControl: { protocolVersion: 1, nodeRuntime: "/usr/bin/node",
        safeLauncherProtocolVersion: 1, bwrapRuntime: "/usr/bin/bwrap" },
    })),
  };
  const providerMode = await mountFixture({
    runners: [{ ...safeRunner, runtime: { ...safeRunner.runtime!,
      executionIsolation: { mode: "provider", network: "inherit" } } }],
    capabilities: { sessionSubscriptions: false, nativeTuiLaunch: true },
  }, undefined, undefined, async () => ({ defaults: [{
    agentId: "claude", driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu-24.04" }, name: "Claude",
    installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" },
  }] }));
  try {
    await act(async () => { selectProject(providerMode.container, project.id); });
    assert.equal(createButton(providerMode.container).disabled, true,
      "safe attestation cannot enable Direct WSL under provider isolation");
    assert.equal(providerMode.requests.length, 0);
  } finally { await unmountFixture(providerMode); }
  const bridged = await mountFixture({
    runners: [safeRunner],
    capabilities: { sessionSubscriptions: false, nativeTuiLaunch: true },
  }, undefined, undefined, async () => ({ defaults: [{
    agentId: "claude", driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu-24.04" }, name: "Claude",
    installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" },
  }] }));
  try {
    await act(async () => { selectProject(bridged.container, project.id); });
    assert.equal(createButton(bridged.container).disabled, false, "verified bridge enables Direct creation");
    const tui = [...bridged.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI"))!;
    assert.equal(tui.disabled, true, "WSL Orchestrator Native TUI stays fail-closed");
    await choosePermissionPreset(bridged.container, "Orchestrator");
    await act(async () => { createButton(bridged.container).click(); });
    assert.equal(bridged.requests[0]?.launchSurface, undefined, "the omitted field is the Direct launch default");
    assert.equal(bridged.requests[0]?.config?.permissionMode, "orchestrator");
  } finally { await unmountFixture(bridged); }
});

test("saved Orchestrator default is visible and gates Native TUI without requiring an override", async () => {
  for (const protocolVersion of [111, 112]) {
    const enabledRunner: RunnerView = { ...runner, protocolVersion,
      agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
        permissionModes: ["default", "orchestrator"],
      } })),
    };
    const fixture = await mountFixture({ runners: [enabledRunner], capabilities: {
      sessionSubscriptions: false, nativeTuiLaunch: true,
    } }, undefined, undefined, async () => ({ defaults: [{
      agentId: "claude", driver: "claude-code", context: { kind: "native" }, name: "Claude",
      installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" },
    }] }));
    try {
      await act(async () => { selectProject(fixture.container, project.id); });
      assert.ok(permissionPresetCard(fixture.container, "Saved Default — Orchestrator"),
        "the saved default names itself on an always-visible card rather than inside a closed menu");
      const tui = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find((button) => button.textContent?.includes("Native TUI"))!;
      assert.equal(tui.disabled, protocolVersion < 112);
      if (protocolVersion === 112) {
        await act(async () => { tui.click(); });
        assert.match(fixture.container.textContent!, /spending and tool calls are not included/);
      }
      await act(async () => { createButton(fixture.container).click(); });
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.requests[0]?.config?.permissionMode, undefined, "Default still delegates to the server");
      assert.equal(fixture.requests[0]?.launchSurface, protocolVersion === 112 ? "native_tui" : undefined);
    } finally { await unmountFixture(fixture); }
  }
});

test("default loading fails closed, retries, and allows old control planes without the endpoint", async () => {
  let calls = 0;
  const fixture = await mountFixture({}, undefined, undefined, async () => {
    if (++calls === 1) throw new ApiError("Unavailable", 503);
    return { defaults: [] };
  });
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    assert.equal(createButton(fixture.container).disabled, true);
    await act(async () => { submitWithEnter(fixture.container); });
    assert.equal(fixture.requests.length, 0);
    const retry = [...fixture.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Retry Defaults")!;
    await act(async () => { retry.click(); });
    assert.equal(calls, 2);
    assert.equal(createButton(fixture.container).disabled, false);
  } finally { await unmountFixture(fixture); }
  const legacy = await mountFixture({}, undefined, undefined, async () => { throw new ApiError("Not found", 404); });
  try {
    await act(async () => { selectProject(legacy.container, project.id); });
    assert.equal(createButton(legacy.container).disabled, false);
    assert.match(legacy.container.textContent!, /Harness Default/);
  } finally { await unmountFixture(legacy); }
});

test("late saved-default response completes before enabling creation", async () => {
  let resolve!: (value: AgentHarnessDefaultsView) => void;
  const pending = new Promise<AgentHarnessDefaultsView>((done) => { resolve = done; });
  const fixture = await mountFixture({}, undefined, undefined, () => pending);
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    assert.equal(createButton(fixture.container).disabled, true);
    assert.match(fixture.container.textContent!, /Loading saved permission defaults/);
    await act(async () => { resolve({ defaults: [] }); });
    assert.equal(createButton(fixture.container).disabled, false);
  } finally { await unmountFixture(fixture); }
});

test("saved Orchestrator cannot launch on an incompatible runner even through Direct", async () => {
  const fixture = await mountFixture({ runners: [{ ...runner, protocolVersion: 108,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  }] }, undefined, undefined, async () => ({ defaults: [{
    agentId: "claude", driver: "claude-code", context: { kind: "native" }, name: "Claude",
    installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" },
  }] }));
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    assert.match(fixture.container.textContent!, /runner is too old to orchestrate child sessions/);
    assert.equal(createButton(fixture.container).disabled, true);
    await act(async () => { submitWithEnter(fixture.container); });
    assert.equal(fixture.requests.length, 0);
  } finally { await unmountFixture(fixture); }
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
    assert.match(harness.textContent ?? "", /Usage accounting is unavailable\./);
    const native = [...harness.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLButtonElement | undefined;
    assert.ok(native);
    assert.equal(native.disabled, false);

    await act(async () => { native.click(); });
    assert.match(
      fixture.container.textContent ?? "",
      /Native TUI spending and tool calls are not included in session usage or parent remaining-budget calculations\./,
    );
    await act(async () => { createButton(fixture.container).click(); });

    assert.equal(fixture.requests[0]?.launchSurface, "native_tui");
    assert.equal(fixture.terminalOpens.count, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("Native TUI shows the content-free live provider accounting boundary", async () => {
  const fixture = await mountFixture({
    capabilities: {
      sessionSubscriptions: false,
      boundedDelivery: false,
      paginatedSessionHistory: false,
      projects: true,
      nativeTuiLaunch: true,
    },
    runners: [{
      ...runner,
      protocolVersion: 121,
      agents: [{
        ...runner.agents[0]!,
        nativeTuiAccounting: {
          status: "unavailable",
          provider: "claude-code",
          installedVersion: "2.1.261",
          verification: "live-cli-contract",
          nearestStructuredSurface: "print-mode-only",
          missingRequirements: [
            "authoritative_usage_events",
            "stable_event_identity",
            "replay_watermark",
            "gap_detection",
          ],
        },
      }],
    }],
  });
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    const native = [...fixture.container.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLButtonElement | undefined;
    assert.ok(native);
    await act(async () => { native.click(); });
    assert.match(
      fixture.container.textContent ?? "",
      /Provider Contract: Claude Code 2\.1\.261 exposes structured output only outside its interactive Native TUI/,
    );
    assert.match(fixture.container.textContent ?? "", /authoritative replay and gap detection are unavailable\./);
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

/**
 * #832: a two-option control must not hide part of either choice.
 *
 * The defect was a height disagreement — the Select asked for 76px over 98px of coarse-pointer
 * touch targets — but the fix is structural rather than arithmetic. Permission Preset has two
 * options that each need a sentence, which is what a Choice Card is for, so there is no popup left
 * to mis-measure. The arithmetic half is guarded separately in ChoiceControls.test.ts, for the
 * Selects that legitimately remain.
 */
test("both permission presets are on screen without opening anything", async () => {
  const orchestratorRunner: RunnerView = {
    ...runner,
    protocolVersion: 124,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  };
  const fixture = await mountFixture({ runners: [orchestratorRunner] });
  try {
    await act(async () => { selectProject(fixture.container, project.id); });

    const cards = [...permissionPresetGroup(fixture.container).querySelectorAll('[role="radio"]')];
    assert.equal(cards.length, 2, "both presets are rendered");
    // No trigger, so nothing can be behind one. This is the assertion that would have failed
    // before the migration, when the group was a closed listbox with a single visible button.
    assert.equal(
      fixture.container.querySelector('button[aria-label^="Permission Preset:"]'), null,
      "the preset no longer hides behind a popover trigger",
    );
    assert.equal(fixture.container.querySelector(".ui-select-list"), null, "and opens no list");

    assert.ok(permissionPresetCard(fixture.container, "Orchestrator"));
    assert.equal(permissionPresetCard(fixture.container, "Orchestrator")?.getAttribute("aria-disabled"), null,
      "a supported Orchestrator is selectable");
  } finally {
    await unmountFixture(fixture);
  }
});

test("an unsupported Orchestrator is disabled and says why, rather than vanishing", async () => {
  // It used to be dropped from the option list entirely, leaving a control with one choice and no
  // way to learn whether the runner, the agent, the context or the target was the reason — the one
  // thing §11.3 forbids. The sentence has to be the SPECIFIC cause, not the union of all four.
  const fixture = await mountFixture({ runners: [{ ...runner, protocolVersion: 67 }] });
  try {
    await act(async () => { selectProject(fixture.container, project.id); });

    const orchestrator = permissionPresetCard(fixture.container, "Orchestrator");
    assert.ok(orchestrator, "Orchestrator is rendered even where it cannot be chosen");
    assert.equal(orchestrator.getAttribute("aria-disabled"), "true");
    assert.match(orchestrator.textContent ?? "", /runner is too old to orchestrate child sessions/);

    // Disabled, not merely styled: clicking must not select it, and the reason must be readable
    // rather than living in a `title` a touch user cannot reach.
    await act(async () => { orchestrator.click(); });
    assert.equal(orchestrator.getAttribute("aria-checked"), "false");
    assert.ok(orchestrator.querySelector(".ui-choice-card-reason"));
  } finally {
    await unmountFixture(fixture);
  }
});
