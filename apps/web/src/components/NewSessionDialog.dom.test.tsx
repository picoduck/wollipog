import { setExperimentFlag } from "../experiments.js";
import { LOCAL_INSTANCE_SCOPE } from "../instance-storage.js";
import assert from "node:assert/strict";
import test from "node:test";
import "./test-dom-events.js";
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
import { NO_PROJECT_SELECTION } from "../project-session-selection.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { NewSessionDialog, type NewSessionPreset } from "./NewSessionDialog.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { fireDomEvent } from "./test-dom-events.js";

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
  createSession?: (request: CreateSessionRequest) => Promise<{ id: string }>,
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
      if (createSession) return createSession(request);
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

function combobox(container: HTMLDivElement, label: string): HTMLInputElement {
  const input = container.querySelector(`input[role="combobox"][aria-label="${label}"]`) as HTMLInputElement | null;
  assert.ok(input, `${label} combobox is rendered`);
  return input;
}

function setComboboxQuery(input: HTMLInputElement, query: string): void {
  fireDomEvent.change(input, { target: { value: query } });
}

function pressComboboxKey(input: HTMLInputElement, key: string): void {
  input.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true }) as never);
}

function comboboxOptions(container: HTMLDivElement, label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(
    `[role="listbox"][aria-label="${label} Options"] [role="option"]`,
  )];
}

async function selectProject(container: HTMLDivElement, value: string): Promise<void> {
  const input = combobox(container, "Project");
  input.focus();
  await Promise.resolve();
  const expected = value === NO_PROJECT_SELECTION ? "No Project" : project.name;
  const option = [...container.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="Project Options"] [role="option"]')]
    .find((candidate) => candidate.querySelector(".ui-select-option-body > span")?.textContent?.startsWith(expected));
  assert.ok(option, `Project options include ${expected}`);
  option.click();
}

/**
 * Whether a ChoiceCard option is refused, by the attribute the primitive actually uses.
 *
 * `ChoiceCards` marks an unavailable option `aria-disabled` rather than setting the `disabled`
 * property, deliberately: the DOM property removes the control from the tab order, so a keyboard
 * user could not reach the option to hear why it is unavailable. The Harness group moved onto the
 * primitive, so its assertions moved onto the same contract.
 */
function cardRefused(card: Element | undefined): boolean {
  assert.ok(card, "the card is rendered even when it cannot be chosen");
  return card.getAttribute("aria-disabled") === "true";
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
  const form = container.querySelector("form.form") as HTMLFormElement | null;
  assert.ok(form, "dialog form is rendered");
  form.requestSubmit();
}

function pressFormShortcut(
  container: HTMLDivElement,
  init: { ctrlKey?: boolean; metaKey?: boolean; repeat?: boolean; isComposing?: boolean; keyCode?: number } = { ctrlKey: true },
): void {
  const form = container.querySelector("form.form") as HTMLFormElement | null;
  assert.ok(form, "dialog form is rendered");
  form.dispatchEvent(new domWindow.KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    ...init,
  } as never) as never);
}

test("New Session is a labelled form with Create Session as its default action", async () => {
  const fixture = await mountFixture();
  try {
    const form = fixture.container.querySelector("form.form") as HTMLFormElement | null;
    assert.ok(form, "the dialog body is a native form");
    const submit = createButton(fixture.container);
    assert.equal(submit.type, "submit");
    assert.equal(submit.getAttribute("form"), form.id,
      "the modal footer's default action owns the dialog form");
    for (const name of ["Project", "Agent"]) {
      const input = combobox(fixture.container, name);
      const label = fixture.container.querySelector(`label[for="${input.id}"]`);
      assert.equal(label?.textContent, name, `${name} has a pointer-associated visible label`);
    }
  } finally {
    await unmountFixture(fixture);
  }
});

test("modified Enter validates and focuses the first actionable problem", async () => {
  const fixture = await mountFixture();
  try {
    const projectInput = combobox(fixture.container, "Project");
    await act(async () => { pressFormShortcut(fixture.container); });
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.container.querySelector('[role="alert"]')?.textContent,
      "Choose a Project or No Project.");
    assert.equal((domWindow.document.activeElement as unknown) === projectInput, true,
      "validation moves focus to the first control that can fix the form");
  } finally {
    await unmountFixture(fixture);
  }
});

test("IME, held keys, and concurrent shortcuts cannot create duplicate sessions", async () => {
  let resolveCreate!: (session: { id: string }) => void;
  const pending = new Promise<{ id: string }>((resolve) => { resolveCreate = resolve; });
  const fixture = await mountFixture(
    {},
    { projectId: project.id, projectLocationId: project.locations[0]!.id },
    undefined,
    undefined,
    async () => pending,
  );
  try {
    await act(async () => {
      pressFormShortcut(fixture.container, { ctrlKey: true, repeat: true });
      pressFormShortcut(fixture.container, { metaKey: true, isComposing: true });
      pressFormShortcut(fixture.container, { ctrlKey: true, keyCode: 229 });
    });
    assert.equal(fixture.requests.length, 0, "repeat and composition are ignored before submission");

    await act(async () => {
      pressFormShortcut(fixture.container, { metaKey: true });
      pressFormShortcut(fixture.container, { ctrlKey: true });
    });
    assert.equal(fixture.requests.length, 1,
      "a synchronous ref closes the same-render gap before the busy state paints");
    await act(async () => { resolveCreate({ id: "session-delayed" }); await pending; });
  } finally {
    await unmountFixture(fixture);
  }
});

test("Project visibility copy names every audience and the new transcript consequence", async () => {
  const expectations = [
    ["user", "Project Visibility: Only the Project Owner"],
    ["team", "Project Visibility: Everyone on the Owning Team"],
    ["organization", "Project Visibility: Everyone in Your Organization"],
  ] as const;
  for (const [audience, expected] of expectations) {
    const fixture = await mountFixture({ projects: [{ ...project, audience }] });
    try {
      await act(async () => { await selectProject(fixture.container, project.id); });
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

    await act(async () => { await selectProject(fixture.container, project.id); });
    assert.match(copy(), /This control plane does not report the Project's visibility./);
    assert.doesNotMatch(copy(), /transcripts use/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("Project search uses visible location context to disambiguate duplicate names", async () => {
  const fork: ProjectView = {
    ...project,
    id: "project-2",
    locations: [{
      ...project.locations[0]!,
      id: "location-2",
      projectId: "project-2",
      workspaceId: "workspace-2",
      path: "/repos/wollipog-fork",
    }],
  };
  const duplicateRunner: RunnerView = {
    ...runner,
    workspaces: [
      ...runner.workspaces,
      { id: "workspace-2", name: "Wollipog Fork", path: "/repos/wollipog-fork" },
    ],
  };
  const fixture = await mountFixture({ runners: [duplicateRunner], projects: [project, fork] });
  try {
    const input = combobox(fixture.container, "Project");
    await act(async () => { input.focus(); });
    assert.equal(comboboxOptions(fixture.container, "Project").length, 3,
      "both same-named Projects and No Project are inspectable");

    await act(async () => { setComboboxQuery(input, "fork"); });
    const matches = comboboxOptions(fixture.container, "Project");
    assert.equal(matches.length, 1);
    assert.match(matches[0]?.textContent ?? "", /Wollipog — \/repos\/wollipog-fork · runner-1/);

    await act(async () => { pressComboboxKey(input, "Enter"); });
    assert.match(input.value, /wollipog-fork/);
    assert.equal(createButton(fixture.container).disabled, false);
  } finally {
    await unmountFixture(fixture);
  }
});

test("recommitting the selected Project preserves an explicit Location", async () => {
  const secondLocation = {
    ...project.locations[0]!,
    id: "location-2",
    workspaceId: "workspace-2",
    name: "Wollipog Fork",
    path: "/repos/wollipog-fork",
    isDefault: false,
  };
  const multiLocationProject = {
    ...project,
    locations: [{ ...project.locations[0]!, isDefault: false }, secondLocation],
  };
  const multiWorkspaceRunner = {
    ...runner,
    workspaces: [
      ...runner.workspaces,
      { id: "workspace-2", name: "Wollipog Fork", path: "/repos/wollipog-fork" },
    ],
  };
  const fixture = await mountFixture(
    { projects: [multiLocationProject], runners: [multiWorkspaceRunner] },
    { projectId: project.id, projectLocationId: secondLocation.id },
  );
  try {
    const selected = () => fixture.container.querySelector(
      '[role="radiogroup"][aria-label="Project Location"] [role="radio"][aria-checked="true"]',
    );
    assert.match(selected()?.textContent ?? "", /wollipog-fork/);

    const input = combobox(fixture.container, "Project");
    await act(async () => { input.focus(); pressComboboxKey(input, "Enter"); });

    assert.match(selected()?.textContent ?? "", /wollipog-fork/,
      "committing the same Project is not a dependent-selection reset");
    assert.equal(createButton(fixture.container).disabled, false);
  } finally {
    await unmountFixture(fixture);
  }
});

test("primary, Advanced, and unavailable Agents share one searchable flow", async () => {
  domWindow.localStorage.clear();
  const agentRunner: RunnerView = {
    ...runner,
    agents: [
      ...runner.agents,
      { id: "codex-app", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: false, authStatus: "unauthenticated" },
      { id: "codex-exec", name: "Codex", command: "codex", args: ["exec"], env: {}, driver: "codex", available: true },
    ],
  };
  const fixture = await mountFixture({ runners: [agentRunner] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const input = combobox(fixture.container, "Agent");
    assert.equal(input.value, "Claude Code", "the recommended primary Agent is selected initially");
    assert.equal(fixture.container.querySelector('select[aria-label="Agent"]'), null);
    assert.equal(fixture.container.querySelector('[aria-label="Advanced Agents"]'), null);

    await act(async () => { input.focus(); });
    assert.equal(input.getAttribute("aria-expanded"), "true");
    const allOptions = comboboxOptions(fixture.container, "Agent");
    assert.equal(allOptions.length, 3);
    assert.ok(allOptions.some((option) => /Advanced Agent/.test(option.textContent ?? "")),
      "the compatibility target is disclosed inside the same list");

    await act(async () => { setComboboxQuery(input, "non-interactive"); });
    assert.equal(comboboxOptions(fixture.container, "Agent").length, 1);
    await act(async () => { pressComboboxKey(input, "Enter"); });
    assert.match(input.value, /Non-Interactive/);
    assert.match(fixture.container.querySelector(".agent-meta")?.textContent ?? "", /Non-interactive via codex exec/);

    await act(async () => { input.click(); setComboboxQuery(input, "codex login"); });
    const unavailable = comboboxOptions(fixture.container, "Agent");
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0]?.getAttribute("aria-disabled"), "true");
    assert.match(unavailable[0]?.textContent ?? "", /Needs setup.*run `codex login`/);
    await act(async () => { pressComboboxKey(input, "Enter"); });
    assert.match(input.value, /codex login/,
      "refusing an unavailable result leaves the search intact instead of committing it");
  } finally {
    await unmountFixture(fixture);
    domWindow.localStorage.clear();
  }
});

test("an unavailable Advanced Agent keeps its marker, search term, and refusal reason", async () => {
  const fixture = await mountFixture({ runners: [{
    ...runner,
    agents: [
      ...runner.agents,
      {
        id: "codex-exec",
        name: "Codex",
        command: "codex",
        args: ["exec"],
        env: {},
        driver: "codex",
        available: false,
      },
    ],
  }] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const input = combobox(fixture.container, "Agent");
    await act(async () => { input.focus(); setComboboxQuery(input, "advanced"); });
    const options = comboboxOptions(fixture.container, "Agent");
    assert.equal(options.length, 1);
    assert.equal(options[0]?.getAttribute("aria-disabled"), "true");
    assert.match(options[0]?.textContent ?? "", /Advanced Agent.*Non-interactive via codex exec.*Needs setup/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("Additional Directories use shared multiple-choice cards without changing the request", async () => {
  const grant = "/shared/reference";
  const acpRunner: RunnerView = {
    ...runner,
    agents: [{ id: "gemini", name: "Gemini", command: "gemini", args: [], env: {}, driver: "acp", available: true }],
    workspaces: [{ ...runner.workspaces[0]!, additionalDirectoryGrants: [grant] }],
    executionTargets: [{
      id: "runner-1:in-place",
      runnerId: "runner-1",
      name: "Runner Host · in place",
      kind: "local",
      workspaceStrategy: "in_place",
      adapter: "host",
      boundaries: { filesystem: "host", network: "inherit", secrets: "runner_local", billing: "agent_account" },
      available: true,
    }],
  };
  const fixture = await mountFixture({ runners: [acpRunner] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const group = fixture.container.querySelector('[role="group"][aria-label="Additional Directories"]');
    assert.ok(group);
    const option = group.querySelector<HTMLButtonElement>('[role="checkbox"]');
    assert.ok(option);
    assert.equal(option.getAttribute("aria-checked"), "false");

    await act(async () => { option.click(); });
    assert.equal(option.getAttribute("aria-checked"), "true");
    await act(async () => { createButton(fixture.container).click(); });
    assert.deepEqual(fixture.requests[0]?.acpSessionContext, { additionalDirectories: [grant] });
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
    await act(async () => { await selectProject(fixture.container, project.id); });
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
      await act(async () => { await selectProject(fixture.container, project.id); });
      await choosePermissionPreset(fixture.container, "Orchestrator");
      const tui = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find((button) => button.textContent?.includes("Native TUI"))!;
      assert.ok(tui);
      assert.equal(cardRefused(tui), protocolVersion < 112);
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
    await act(async () => { await selectProject(ordinary.container, project.id); });
    const tui = [...ordinary.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI"))!;
    assert.ok(tui);
    assert.equal(cardRefused(tui), false, "ordinary WSL Native TUI remains available");
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
    await act(async () => { await selectProject(orchestrator.container, project.id); });
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
    await act(async () => { await selectProject(protocolOnly.container, project.id); });
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
    await act(async () => { await selectProject(providerMode.container, project.id); });
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
    await act(async () => { await selectProject(bridged.container, project.id); });
    assert.equal(createButton(bridged.container).disabled, false, "verified bridge enables Direct creation");
    const tui = [...bridged.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI"))!;
    assert.equal(cardRefused(tui), true, "WSL Orchestrator Native TUI stays fail-closed");
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
      await act(async () => { await selectProject(fixture.container, project.id); });
      assert.ok(permissionPresetCard(fixture.container, "Saved Default — Orchestrator"),
        "the saved default names itself on an always-visible card rather than inside a closed menu");
      const tui = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
        .find((button) => button.textContent?.includes("Native TUI"))!;
      assert.equal(cardRefused(tui), protocolVersion < 112);
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
    await act(async () => { await selectProject(fixture.container, project.id); });
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
    await act(async () => { await selectProject(legacy.container, project.id); });
    assert.equal(createButton(legacy.container).disabled, false);
    assert.match(legacy.container.textContent!, /Harness Default/);
  } finally { await unmountFixture(legacy); }
});

test("late saved-default response completes before enabling creation", async () => {
  let resolve!: (value: AgentHarnessDefaultsView) => void;
  const pending = new Promise<AgentHarnessDefaultsView>((done) => { resolve = done; });
  const fixture = await mountFixture({}, undefined, undefined, () => pending);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
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
    await act(async () => { await selectProject(fixture.container, project.id); });
    assert.match(fixture.container.textContent!, /runner is too old to orchestrate child sessions/);
    assert.equal(createButton(fixture.container).disabled, true);
    await act(async () => { submitWithEnter(fixture.container); });
    assert.equal(fixture.requests.length, 0);
  } finally { await unmountFixture(fixture); }
});

test("Projects mode requires an explicit Project choice and No Project sends exact null identities", async () => {
  const fixture = await mountFixture();
  try {
    assert.equal(combobox(fixture.container, "Project").value, "", "the only Project is not selected implicitly");
    assert.equal(createButton(fixture.container).disabled, true);

    await act(async () => { await selectProject(fixture.container, "__no_project__"); });
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
    assert.equal(combobox(fixture.container, "Project").value, "No Project");
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
    assert.equal(combobox(fixture.container, "Project").value, "");
    assert.equal(createButton(fixture.container).disabled, true);

    await act(async () => { fixture.socket.push(snapshot()); });

    assert.equal(combobox(fixture.container, "Project").value, "Wollipog");
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
    await act(async () => { await selectProject(fixture.container, "__no_project__"); });
    assert.equal(combobox(fixture.container, "Project").value, "No Project");

    await act(async () => { fixture.socket.push(snapshot()); });

    assert.equal(combobox(fixture.container, "Project").value, "No Project");
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
    await act(async () => { await selectProject(fixture.container, project.id); });
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
    await act(async () => { await selectProject(fixture.container, project.id); });
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
    await act(async () => { await selectProject(fixture.container, project.id); });
    const harness = fixture.container.querySelector('[role="radiogroup"][aria-label="Harness"]');
    assert.ok(harness);
    assert.match(harness.textContent ?? "", /Use structured chat, tool events, approval cards, and manager controls\./);
    assert.match(harness.textContent ?? "", /Usage accounting is unavailable\./);
    const native = [...harness.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLButtonElement | undefined;
    assert.ok(native);
    // `cardRefused`, not `.disabled`: ChoiceCards never sets the DOM property, so asserting it is
    // `false` would pass even for a refused card. The click below only means something if the
    // option is genuinely selectable.
    assert.equal(cardRefused(native), false);

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
    await act(async () => { await selectProject(fixture.container, project.id); });
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
    await act(async () => { await selectProject(fixture.container, project.id); });
    const native = [...fixture.container.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLButtonElement | undefined;
    assert.ok(native);
    assert.equal(cardRefused(native), true);
    // The reason now lives ON the refused card rather than in a sibling paragraph, so assert it
    // there — a sentence elsewhere in the dialog would satisfy the old container-wide match while
    // the control itself explained nothing.
    assert.match(native.textContent ?? "", /requires a newer control plane/);
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
    await act(async () => { await selectProject(fixture.container, project.id); });
    const native = [...fixture.container.querySelectorAll('button[role="radio"]')]
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLButtonElement | undefined;
    assert.ok(native);
    assert.equal(cardRefused(native), true);
    // The start-fence hint is the refused card's own reason now, not a sibling paragraph.
    assert.match(native.textContent ?? "", /Initial Native TUI launch requires protocol v67/);
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
    await act(async () => { await selectProject(fixture.container, project.id); });
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
    await act(async () => { await selectProject(fixture.container, project.id); });
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
    await act(async () => { await selectProject(fixture.container, project.id); });
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
    await act(async () => { await selectProject(fixture.container, project.id); });

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
    await act(async () => { await selectProject(fixture.container, project.id); });

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

test("an unavailable Project Location is refused with the availability as its reason", async () => {
  // The bespoke `.loc-pick` button used the DOM `disabled` property, which took the option out of
  // the tab order — so the availability badge explaining WHY it could not be chosen was reachable
  // by mouse and by nothing else. On ChoiceCards it is `aria-disabled`, and the reason is a
  // sentence on the card rather than a badge the user has to interpret.
  const offlineRunner: RunnerView = { ...runner, status: "offline" };
  const fixture = await mountFixture({
    runners: [offlineRunner],
    projects: [{
      ...project,
      locations: [{ ...project.locations[0]!, availability: "runner_offline" }],
    }],
  });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const group = fixture.container.querySelector('[role="radiogroup"][aria-label="Project Location"]');
    assert.ok(group, "Project Location renders as a choice group");

    const card = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')][0];
    assert.ok(card);
    assert.equal(card.getAttribute("aria-disabled"), "true");
    assert.match(card.textContent ?? "", /Runner Offline/);
    assert.match(card.textContent ?? "", /cannot host a session right now/);

    // Refused, not merely styled: clicking must not select it or enable creation.
    await act(async () => { card.click(); });
    assert.equal(card.getAttribute("aria-checked"), "false");
    assert.equal(createButton(fixture.container).disabled, true);
  } finally {
    await unmountFixture(fixture);
  }
});

test("the Location groups and Harness share one control family", async () => {
  // The point of #832: the same question asked the same way. Before this, the dialog answered
  // "pick one of N" with two bespoke `.loc-pick` grids, a `.workflow-preset` grid, a custom
  // listbox and a segmented control, inside one 520px form.
  const fixture = await mountFixture();
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    for (const label of ["Project Location", "Permission Preset", "Harness"]) {
      const group = fixture.container.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
      assert.ok(group, `${label} is a labelled radiogroup`);
      assert.ok(group.querySelector(".ui-choice-card"), `${label} uses the shared Choice Card`);
    }
    // And nothing bespoke is left from the families this PR retired.
    assert.equal(fixture.container.querySelector(".loc-pick"), null);
    assert.equal(fixture.container.querySelector(".workflow-preset"), null);
  } finally {
    await unmountFixture(fixture);
  }
});
