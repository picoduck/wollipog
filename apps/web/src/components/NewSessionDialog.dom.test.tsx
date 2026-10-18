import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  OrchestratorSettingsView,
  SessionView,
} from "@wollipog/protocol";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { loadAgentDefaults, saveAgentDefault } from "../agent-defaults.js";
import { NO_PROJECT_SELECTION } from "../project-session-selection.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { NewSessionDialog, type NewSessionPreset } from "./NewSessionDialog.js";
import { ariaReferencedText, assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { fireDomEvent } from "./test-dom-events.js";

const SKILLS_UNAVAILABLE = /Managed skills from this Machine are unavailable on container and cloud targets/u;
/** System nouns docs/design-system.md §17.2 retires from user copy. */
const RETIRED_PROJECT_TERMS = /control plane|durable/iu;

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
  /** The document body: the dialog is portalled there, out of the element React renders into. */
  container: HTMLDivElement;
  mountPoint: HTMLDivElement;
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
  orchestratorDefaults: () => Promise<OrchestratorSettingsView> = async () => ({
    defaults: structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS),
    source: "system_default",
    capabilities: {
      models: [{ id: "test-model", efforts: ["high"] }], effortLevels: ["high"],
      installations: 1, compatibleInstallations: 1, status: "available",
    },
  }),
  additionalApi: Partial<ApiClient> = {},
): Promise<Fixture> {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const container = domWindow.document.body as unknown as HTMLDivElement;
  const root = createRoot(mountPoint);
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
    ...additionalApi,
    agentHarnessDefaults: defaults,
    orchestratorSettings: orchestratorDefaults,
    listDirectory: async (_runnerId: string, path: string) => ({
      path: path || "/repos",
      parent: "/",
      entries: [{ name: "scratch", path: "/repos/scratch", isDir: true }],
    }),
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
  return { container, mountPoint, root, socket, requests, terminalOpens };
}

async function strictOrchestratorDefaults(): Promise<OrchestratorSettingsView> {
  const defaults = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
  defaults.execution.strictProjectIsolation = true;
  return {
    defaults,
    source: "system_default",
    capabilities: {
      models: [{ id: "test-model", efforts: ["high"] }], effortLevels: ["high"],
      installations: 1, compatibleInstallations: 1, status: "available",
    },
  };
}

async function unmountFixture(fixture: Fixture): Promise<void> {
  await act(async () => { fixture.root.unmount(); });
  fixture.mountPoint.remove();
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
  // Project's list stays closed on focus (#2952); a click opens it.
  input.focus();
  if (input.getAttribute("aria-expanded") !== "true") input.click();
  await Promise.resolve();
  const expected = value === NO_PROJECT_SELECTION ? "No Project" : project.name;
  const option = [...container.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="Project Options"] [role="option"]')]
    .find((candidate) => candidate.querySelector(".ui-select-option-body > span")?.textContent?.startsWith(expected));
  assert.ok(option, `Project options include ${expected}`);
  option.click();
}

/**
 * Whether a ChoiceRow option is refused, by the attribute the primitive actually uses.
 *
 * `ChoiceRows` marks an unavailable option's input `aria-disabled` rather than setting `disabled`
 * property, deliberately: the DOM property removes the control from the tab order, so a keyboard
 * user could not reach the option to hear why it is unavailable. The Harness group moved onto the
 * primitive, so its assertions moved onto the same contract.
 */
function cardRefused(card: Element | undefined): boolean {
  assert.ok(card, "the card is rendered even when it cannot be chosen");
  return card.querySelector("input")?.getAttribute("aria-disabled") === "true";
}

function createButton(container: HTMLDivElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.trim() === "Create Session");
  assert.ok(button, "Create Session button is rendered");
  return button;
}

/**
 * Create Session refuses this state (#2952): disabled, with the reason in the footer, for what
 * nothing further down the form can fix; otherwise pressing it sends nothing and names the problem
 * under its field.
 */
async function assertCreateRefused(fixture: Pick<Fixture, "container" | "requests">, message?: string): Promise<void> {
  const button = createButton(fixture.container);
  if (button.disabled) {
    assert.ok(footerReason(fixture.container), message ?? "a disabled Create Session says why in the footer");
    return;
  }
  const before = fixture.requests.length;
  await act(async () => { button.click(); });
  await act(async () => { await Promise.resolve(); });
  assert.equal(fixture.requests.length, before, message ?? "Create Session sends nothing for this state");
}

/** The footer's reason a disabled Create Session gives (§7.3). */
function footerReason(container: HTMLDivElement): string | null {
  return container.querySelector(".modal-foot .new-session-reason")?.textContent ?? null;
}

/** The request failure's danger notice above the footer (§7.3, §13.2). */
function failureNotice(container: HTMLDivElement): HTMLElement {
  const notice = container.querySelector<HTMLElement>(".modal-body .notice.t-danger");
  assert.ok(notice, "the request failure is a danger notice in the body");
  return notice;
}

function buttonNamed(root: ParentNode, name: string, required = true): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === name);
  if (required) assert.ok(button, `${name} is rendered`);
  return button!;
}

/** The problem a submit names under a field (§8.5), or null. */
function fieldErrorText(container: HTMLDivElement): string | null {
  return container.querySelector(".modal-body .field-error")?.textContent ?? null;
}

function labelledNumberInput(container: HTMLDivElement, label: string): HTMLInputElement | null {
  const candidate = [...container.querySelectorAll<HTMLLabelElement>("label")]
    .find((item) => item.textContent?.trim().startsWith(label));
  return candidate?.htmlFor
    ? container.querySelector<HTMLInputElement>(`[id="${candidate.htmlFor}"]`)
    : null;
}

/**
 * No trigger to open any more, which is the point of #832: both presets are on screen, so choosing
 * one is a single click and there is no popup whose height could disagree with its touch targets.
 */
async function choosePermissionPreset(container: HTMLDivElement, label: string) {
  const option = permissionPresetCard(container, label);
  assert.ok(option, `Session Role offers ${label}`);
  await act(async () => { option.click(); });
}

async function chooseSelectOption(container: HTMLDivElement, label: string, optionLabel: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`);
  assert.ok(trigger, `${label} select is rendered`);
  await act(async () => { trigger.click(); });
  const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find((candidate) => candidate.textContent?.includes(optionLabel));
  assert.ok(option, `${label} offers ${optionLabel}`);
  await act(async () => { option.click(); });
}

function permissionPresetGroup(container: HTMLDivElement): Element {
  const group = container.querySelector('[role="radiogroup"][aria-label="Session Role"]');
  assert.ok(group, "Session Role renders an always-visible choice group");
  return group;
}

/** The ChoiceRow — the `<label>` that is the whole target — around each native radio in `scope`. */
function radioRows(scope: ParentNode): HTMLLabelElement[] {
  return [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
    .map((input) => input.closest("label"))
    .filter((row): row is HTMLLabelElement => row !== null);
}

function permissionPresetCard(container: HTMLDivElement, title: string): HTMLLabelElement | undefined {
  return radioRows(permissionPresetGroup(container))
    .find((row) => row.querySelector(".choice-row-title")?.textContent?.trim() === title);
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

function setTouchChoicePicker(enabled: boolean): () => void {
  const previous = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: enabled,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  })) as unknown as typeof domWindow.matchMedia;
  return () => { domWindow.matchMedia = previous; };
}

test("New Session is a labelled form with Create Session as its default action", async () => {
  const fixture = await mountFixture();
  try {
    const form = fixture.container.querySelector("form.form") as HTMLFormElement | null;
    assert.ok(form, "the dialog body is a native form");
    assert.equal(form.noValidate, true, "the dialog's fail-closed validation owns every error path");
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

test("touch Project selection opens a non-editable list without summoning a keyboard", async () => {
  const restoreMatchMedia = setTouchChoicePicker(true);
  try {
    const fixture = await mountFixture();
    try {
      assertNoDomNode(fixture.container.querySelector('input[aria-label="Project"]'),
        "touch layouts do not render an editable Project input");

      const trigger = fixture.container.querySelector<HTMLButtonElement>('button[aria-label^="Project:"]');
      assert.ok(trigger, "touch layouts render the shared button/listbox picker");
      await act(async () => { submitWithEnter(fixture.container); });
      assert.equal((domWindow.document.activeElement as unknown) === trigger, true,
        "mobile validation focuses the actionable Project picker");
      await act(async () => { trigger.click(); });

      const listbox = fixture.container.querySelector('[role="listbox"][aria-label="Project"]');
      assert.ok(listbox, "the Project choices open without focusing a text field");
      const option = [...listbox.querySelectorAll<HTMLButtonElement>('[role="option"]')]
        .find((candidate) => candidate.textContent?.startsWith(project.name));
      assert.ok(option);
      await act(async () => { option.click(); });
      assert.equal(trigger.getAttribute("aria-label"), `Project: ${project.name}`);
      assert.equal(createButton(fixture.container).disabled, false);
    } finally {
      await unmountFixture(fixture);
    }
  } finally {
    restoreMatchMedia();
  }
});

test("modified Enter validates and focuses the first actionable problem", async () => {
  const fixture = await mountFixture();
  try {
    const projectInput = combobox(fixture.container, "Project");
    assert.equal(createButton(fixture.container).disabled, false,
      "no project chosen yet is not a hard block: Create Session stays enabled (#2952)");
    await act(async () => { pressFormShortcut(fixture.container); });
    assert.equal(fixture.requests.length, 0);
    assert.equal(fieldErrorText(fixture.container), "Choose a project, or choose No Project.");
    assert.equal(projectInput.getAttribute("aria-invalid"), "true");
    assert.equal(ariaReferencedText(projectInput, "aria-describedby"), "Choose a project, or choose No Project.");
    assert.equal((domWindow.document.activeElement as unknown) === projectInput, true,
      "validation moves focus to the first control that can fix the form");
    assertNoDomNode(fixture.container.querySelector(".modal-foot .form-error"), "the footer carries no error (#2952)");
    await act(async () => { await selectProject(fixture.container, project.id); });
    assertNoDomNode(fixture.container.querySelector(".modal-body .field-error"),
      "correcting the reported problem clears its stale validation message");
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

test("Project has no helper paragraph and no Create Project button beside it (#2952)", async () => {
  for (const audience of ["user", "team", "organization", undefined] as const) {
    const fixture = await mountFixture({ projects: [{ ...project, audience }] });
    try {
      const body = () => fixture.container.querySelector(".modal-body")?.textContent ?? "";
      assert.doesNotMatch(body(), /Choose a Project to organize/);
      await act(async () => { await selectProject(fixture.container, project.id); });
      assert.doesNotMatch(body(), /keeps related sessions together|transcripts use|can't show who can see/);
      assert.doesNotMatch(body(), RETIRED_PROJECT_TERMS);
      assertNoDomNode(fixture.container.querySelector(".new-session-project-actions"));
      assert.equal([...fixture.container.querySelectorAll(".modal-body button")]
        .some((button) => /Create Project/.test(button.textContent ?? "")), false);
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("Project opens with its list closed, and a project from its own sessions opens selected (#2952)", async () => {
  const fixture = await mountFixture();
  try {
    const input = combobox(fixture.container, "Project");
    assert.equal((domWindow.document.activeElement as unknown) === input, true, "Project keeps initial focus (#1143)");
    assert.equal(input.getAttribute("aria-expanded"), "false", "focus leaves the list closed");
    assert.equal(input.value, "", "All Sessions chooses no project on the person's behalf");
    await act(async () => { setComboboxQuery(input, "Wol"); });
    assert.equal(input.getAttribute("aria-expanded"), "true", "typing opens the list at once");
    assert.deepEqual(comboboxOptions(fixture.container, "Project").slice(0, -1).map((option) => ariaReferencedText(option, "aria-labelledby")),
      ["Wollipog"]);
  } finally {
    await unmountFixture(fixture);
  }

  const preset = await mountFixture({}, { projectId: project.id });
  try {
    const input = combobox(preset.container, "Project");
    assert.equal((domWindow.document.activeElement as unknown) === input, true);
    assert.equal(input.value, "Wollipog");
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assert.equal(input.selectionStart, 0, "the prefilled name is selected from its start");
    assert.equal(input.selectionEnd, "Wollipog".length, "to its end, so typing replaces it");
    await act(async () => { setComboboxQuery(input, "No"); });
    assert.deepEqual(comboboxOptions(preset.container, "Project").slice(0, -1).map((option) => ariaReferencedText(option, "aria-labelledby")),
      ["No Project"], "the search is only what was typed");
  } finally {
    await unmountFixture(preset);
  }
});

test("two projects with one name keep the name in the list and add the machine to the closed field (#2952)", async () => {
  const docs: ProjectView = {
    ...project,
    id: "project-docs-1",
    name: "Docs Site",
    locations: [{ ...project.locations[0]!, id: "docs-1", projectId: "project-docs-1", path: "/home/me/src/docs-site" }],
  };
  const docsCopy: ProjectView = {
    ...project,
    id: "project-docs-2",
    name: "Docs Site",
    locations: [{
      ...project.locations[0]!, id: "docs-2", projectId: "project-docs-2", runnerId: "runner-2",
      workspaceId: "workspace-9", path: "/srv/build/docs-site",
    }],
  };
  const buildServer: RunnerView = {
    ...runner, runnerId: "runner-2", hostname: "build", displayName: "Build Server",
    workspaces: [{ id: "workspace-9", name: "Docs", path: "/srv/build/docs-site" }],
  };
  const fixture = await mountFixture({ runners: [{ ...runner, displayName: "Studio Mac" }, buildServer], projects: [docs, docsCopy] });
  try {
    const input = combobox(fixture.container, "Project");
    await act(async () => { input.click(); });
    const options = comboboxOptions(fixture.container, "Project").slice(0, -1);
    assert.deepEqual(optionNamesAndDescriptions(options), [
      { name: "Docs Site", description: "Studio Mac · 1 location" },
      { name: "Docs Site", description: "Build Server · 1 location" },
      { name: "No Project", description: "Run in any folder on a machine, outside a project." },
    ]);
    for (const option of options) {
      assert.doesNotMatch(ariaReferencedText(option, "aria-labelledby") ?? "", /\//, "no option label contains a path");
    }
    await act(async () => { options[1]!.click(); });
    assert.equal(input.value, "Docs Site · Build Server", "the closed field adds the machine after the name");

    await act(async () => { input.click(); });
    await act(async () => { setComboboxQuery(input, "srv"); });
    assert.deepEqual(comboboxOptions(fixture.container, "Project").slice(0, -1).map((option) => ariaReferencedText(option, "aria-describedby")),
      ["Build Server · 1 location"], "a search still reaches a project by its folder");
  } finally {
    await unmountFixture(fixture);
  }

  const unique = await mountFixture();
  try {
    await act(async () => { await selectProject(unique.container, project.id); });
    assert.equal(combobox(unique.container, "Project").value, "Wollipog", "a unique name stands alone");
  } finally {
    await unmountFixture(unique);
  }
});

test("same-named projects on one machine are told apart by folder, then path, then id (#2952)", async () => {
  const docsAt = (id: string, path: string): ProjectView => ({
    ...project,
    id,
    name: "Docs Site",
    locations: [{ ...project.locations[0]!, id: `${id}-location`, projectId: id, path }],
  });
  const describe = async (projects: ProjectView[]) => {
    const fixture = await mountFixture({ projects });
    try {
      const input = combobox(fixture.container, "Project");
      await act(async () => { input.click(); });
      const options = comboboxOptions(fixture.container, "Project").slice(0, -2);
      const lines = optionNamesAndDescriptions(options);
      for (const line of lines) assert.equal(line.name, "Docs Site", "the option is the name alone");
      const values: string[] = [];
      for (let index = 0; index < options.length; index += 1) {
        if (index > 0) await act(async () => { input.click(); });
        await act(async () => { comboboxOptions(fixture.container, "Project")[index]!.click(); });
        values.push(input.value);
      }
      return { descriptions: lines.map((line) => line.description), values };
    } finally {
      await unmountFixture(fixture);
    }
  };

  const byFolder = await describe([docsAt("p-a", "/home/me/src/docs-site"), docsAt("p-b", "/home/me/src/docs-site-v2")]);
  assert.deepEqual(byFolder.descriptions, ["runner-1 · docs-site · 1 location", "runner-1 · docs-site-v2 · 1 location"]);
  assert.deepEqual(byFolder.values, ["Docs Site · runner-1 · docs-site", "Docs Site · runner-1 · docs-site-v2"]);

  const byPath = await describe([docsAt("p-a", "/home/me/a/docs"), docsAt("p-b", "/home/me/b/docs")]);
  assert.deepEqual(byPath.descriptions, ["runner-1 · …/a/docs · 1 location", "runner-1 · …/b/docs · 1 location"]);
  assert.equal(new Set(byPath.values).size, 2);

  const byId = await describe([docsAt("project-aaaaaa", "/srv/docs"), docsAt("project-bbbbbb", "/srv/docs")]);
  assert.deepEqual(byId.descriptions, ["runner-1 · Project aaaaaa · 1 location", "runner-1 · Project bbbbbb · 1 location"]);
  assert.equal(new Set(byId.values).size, 2, "a unique visible fallback when everything else matches");
});

/**
 * What a person hears after pressing Create Session (#2952): focus is on a control in the dialog, never
 * left behind, and that control, or the choice group it is in, is described by `expected`.
 */
async function pressCreateAndHear(fixture: Fixture, expected: RegExp, label: string): Promise<HTMLElement> {
  const before = fixture.requests.length;
  await act(async () => { createButton(fixture.container).click(); });
  assert.equal(fixture.requests.length, before, `${label}: nothing is sent`);
  const focused = domWindow.document.activeElement as unknown as HTMLElement;
  const dialog = fixture.container.querySelector('[role="dialog"]');
  assert.ok(dialog?.contains(focused as never), `${label}: focus is in the dialog`);
  const described = [focused, focused.closest('[role="radiogroup"], [role="group"]')]
    .filter((element): element is HTMLElement => element !== null)
    .map((element) => ariaReferencedText(element, "aria-describedby") ?? "")
    .join(" ");
  assert.match(described, expected, `${label}: the focused control is described by why`);
  return focused;
}

test("every refused submit lands on a control described by its reason (#2952)", async () => {
  const orchestratorRunner: RunnerView = {
    ...runner, protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  };
  const cases: Array<{ label: string; run: () => Promise<void> }> = [
    { label: "no project chosen", run: async () => {
      const fixture = await mountFixture();
      try {
        const focused = await pressCreateAndHear(fixture, /Choose a project, or choose No Project\./, "no project");
        assert.equal(focused, combobox(fixture.container, "Project"));
      } finally { await unmountFixture(fixture); }
    } },
    { label: "no machines online", run: async () => {
      const fixture = await mountFixture({ runners: [{ ...runner, status: "offline" }] });
      try {
        await act(async () => { submitWithEnter(fixture.container); });
        const focused = domWindow.document.activeElement as unknown as HTMLElement;
        assert.equal(focused.textContent, "Open Connections");
        assert.equal(ariaReferencedText(focused, "aria-describedby"), "Start Wollipog on one of your machines, or connect a new one.");
      } finally { await unmountFixture(fixture); }
    } },
    { label: "a project with no locations", run: async () => {
      const fixture = await mountFixture({ projects: [{ ...project, locations: [] }] });
      try {
        await act(async () => { await selectProject(fixture.container, project.id); });
        await act(async () => { submitWithEnter(fixture.container); });
        const focused = domWindow.document.activeElement as unknown as HTMLElement;
        assert.equal(focused.textContent, "Add Location…");
        assert.match(ariaReferencedText(focused, "aria-describedby") ?? "", /This project has no locations yet/);
      } finally { await unmountFixture(fixture); }
    } },
    { label: "a project with no locations that you can't manage", run: async () => {
      const fixture = await mountFixture({ projects: [{ ...project, locations: [], canManage: false }] });
      try {
        await act(async () => { await selectProject(fixture.container, project.id); });
        await act(async () => { submitWithEnter(fixture.container); });
        const focused = domWindow.document.activeElement as unknown as HTMLElement;
        assert.equal(focused, combobox(fixture.container, "Project"));
        assert.equal(ariaReferencedText(focused, "aria-describedby"),
          "This project has no locations, and you can't add one. Choose another project.");
      } finally { await unmountFixture(fixture); }
    } },
    { label: "Orchestrator policy still loading", run: async () => {
      const fixture = await mountFixture({ runners: [orchestratorRunner] }, undefined, undefined, undefined, undefined,
        () => new Promise<OrchestratorSettingsView>(() => {}));
      try {
        await act(async () => { await selectProject(fixture.container, project.id); });
        await choosePermissionPreset(fixture.container, "Orchestrator");
        const focused = await pressCreateAndHear(fixture, /Wait for Orchestrator defaults to finish loading\./, "policy loading");
        assert.ok(focused.closest('[role="radiogroup"][aria-label="Session Role"]'), "Session Role answers while nothing else can");
        assert.equal(focused.closest('[role="radiogroup"]')?.getAttribute("aria-invalid"), "true");
      } finally { await unmountFixture(fixture); }
    } },
    { label: "Orchestrator policy failed to load", run: async () => {
      const fixture = await mountFixture({ runners: [orchestratorRunner] }, undefined, undefined, undefined, undefined,
        async () => { throw new Error("Policy service unavailable."); });
      try {
        await act(async () => { await selectProject(fixture.container, project.id); });
        await choosePermissionPreset(fixture.container, "Orchestrator");
        const focused = await pressCreateAndHear(fixture, /Policy service unavailable\./, "policy failed");
        assert.equal(focused.textContent, "Retry Orchestrator Defaults");
      } finally { await unmountFixture(fixture); }
    } },
    { label: "saved permission defaults still loading", run: async () => {
      const fixture = await mountFixture({}, undefined, undefined, () => new Promise<AgentHarnessDefaultsView>(() => {}));
      try {
        await act(async () => { await selectProject(fixture.container, project.id); });
        const focused = await pressCreateAndHear(fixture, /Wait for saved permission defaults to finish loading\./, "defaults loading");
        assert.ok(focused.closest('[role="radiogroup"][aria-label="Session Role"]'));
      } finally { await unmountFixture(fixture); }
    } },
    { label: "a missing saved account", run: async () => {
      const accountRunner: RunnerView = {
        ...runner,
        protocolVersion: PROTOCOL_VERSION,
        providerAccounts: [{ id: "work", label: "Work", provider: "claude", authStatus: "authenticated" }],
        providerAccountDefaults: [{ provider: "claude", accountId: "removed", revision: 1 }],
      };
      const fixture = await mountFixture({ runners: [accountRunner] }, { projectId: null });
      try {
        const focused = await pressCreateAndHear(fixture, /saved default account is no longer on this Machine/, "account");
        assert.match(focused.getAttribute("aria-label") ?? "", /^Account:/);
        assert.equal(focused.getAttribute("aria-invalid"), "true");
      } finally { await unmountFixture(fixture); }
    } },
  ];
  for (const { run } of cases) await run();
});

test("an invalid Cloud Cost Budget marks the focused input and describes it by its error (#2952)", async () => {
  const boundaries = { filesystem: "host", network: "inherit", secrets: "runner_local", billing: "agent_account" } as const;
  const cloudRunner: RunnerView = {
    ...runner,
    executionTargets: [
      { id: "runner-1:in-place", runnerId: "runner-1", name: "Host · In Place", kind: "local", workspaceStrategy: "in_place",
        adapter: "host", boundaries, available: true },
      { id: "runner-1:worktree", runnerId: "runner-1", name: "Host · Worktree", kind: "local", workspaceStrategy: "worktree",
        adapter: "host", boundaries, available: true },
      { id: "runner-1:cloud", runnerId: "runner-1", name: "Cloud Sandbox", kind: "cloud", workspaceStrategy: "worktree",
        adapter: "cloud", boundaries: { ...boundaries, filesystem: "isolated" } as never, available: true,
        policy: {
          cost: { currency: "USD", estimatedHourlyRateUsd: 2, minimumBudgetUsd: 1, maximumBudgetUsd: 20 },
          admission: { maxConcurrentSessions: 2, queue: "fifo" },
        } },
    ],
  };
  const fixture = await mountFixture({ runners: [cloudRunner] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const target = fixture.container.querySelector<HTMLButtonElement>('button[aria-label^="Execution Target:"]');
    assert.ok(target);
    await act(async () => { target.click(); });
    const cloud = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="Execution Target"] [role="option"]')]
      .find((option) => option.textContent?.includes("Cloud Sandbox"));
    assert.ok(cloud);
    await act(async () => { cloud.click(); });
    const budget = fixture.container.querySelector<HTMLInputElement>('input[type="number"][step="0.01"]');
    assert.ok(budget);
    assert.equal(budget.getAttribute("aria-invalid"), null);
    await act(async () => { fireDomEvent.change(budget, { target: { value: "50" } }); });

    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 0);
    assert.equal((domWindow.document.activeElement as unknown) === budget, true, "validation lands on the budget");
    assert.equal(budget.getAttribute("aria-invalid"), "true");
    assert.equal(ariaReferencedText(budget, "aria-describedby"), "Enter a Cloud Cost Budget within the allowed range.");
    assert.notEqual(fixture.container.querySelector(".field-error")?.getAttribute("role"), "alert",
      "a field error is not an alert; focusing its field announces it");

    await act(async () => { fireDomEvent.change(budget, { target: { value: "5" } }); });
    assert.equal(budget.getAttribute("aria-invalid"), null, "fixing the value clears the error");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Project describes hidden, empty and offline projects, and ends with No Project and New Project… (#2952)", async () => {
  const hidden: ProjectView = { ...project, id: "project-hidden", name: "Archive", hidden: true };
  const empty: ProjectView = { ...project, id: "project-empty", name: "Blank", locations: [] };
  const offline: ProjectView = {
    ...project,
    id: "project-offline",
    name: "Mobile",
    locations: [{ ...project.locations[0]!, id: "offline-1", projectId: "project-offline", runnerId: "runner-off" }],
  };
  const offlineRunner: RunnerView = { ...runner, runnerId: "runner-off", displayName: "Build Server 02", status: "offline" };
  const fixture = await mountFixture({ runners: [runner, offlineRunner], projects: [hidden, empty, offline] });
  try {
    const input = combobox(fixture.container, "Project");
    await act(async () => { input.click(); });
    const listbox = fixture.container.querySelector('[role="listbox"][aria-label="Project Options"]');
    assert.ok(listbox);
    const options = comboboxOptions(fixture.container, "Project");
    assert.deepEqual(optionNamesAndDescriptions(options.slice(0, -1)), [
      { name: "Archive", description: "Hidden · runner-1 · 1 location" },
      { name: "Blank", description: "No locations yet" },
      { name: "Mobile", description: "Build Server 02 · offline" },
      { name: "No Project", description: "Run in any folder on a machine, outside a project." },
    ]);
    assert.equal(options.at(-1)?.textContent, "New Project…");
    const rows = [...listbox.children];
    const noProject = rows.find((row) => row.textContent?.startsWith("No Project"));
    assert.ok(noProject?.previousElementSibling?.classList.contains("menu-sep"), "No Project follows a separator");
    assert.equal(rows.at(-1)?.textContent, "New Project…", "New Project… is the list's footer row");
    assert.ok(rows.at(-2)?.classList.contains("menu-sep"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("New Project… stacks its dialog over New Session, then selects the new project with focus on Project (#2952)", async () => {
  const created: ProjectView = { ...project, id: "project-new", name: "Payments", locations: [], createdAt: 5, updatedAt: 5 };
  const fixture = await mountFixture({}, undefined, undefined, undefined, undefined, undefined, {
    createProject: async () => ({ project: created }),
  } as Partial<ApiClient>);
  try {
    const input = combobox(fixture.container, "Project");
    await act(async () => { input.click(); });
    const footer = comboboxOptions(fixture.container, "Project").at(-1);
    assert.equal(footer?.textContent, "New Project…");
    await act(async () => { footer!.click(); });

    const dialogs = [...fixture.container.querySelectorAll<HTMLElement>('[role="dialog"]')];
    assert.equal(dialogs.length, 2, "New Session stays open under New Project");
    assert.match(dialogs[1]?.textContent ?? "", /Project Name/);
    assert.ok(dialogs[1]?.closest(".modal-backdrop.stacked"), "the child stacks over its parent under one dim");

    const name = dialogs[1]!.querySelector<HTMLInputElement>("input")!;
    await act(async () => { fireDomEvent.change(name, { target: { value: "Payments" } }); });
    await act(async () => {
      dialogs[1]!.querySelector("form")!.dispatchEvent(new domWindow.Event("submit", { bubbles: true, cancelable: true }) as never);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    assert.equal(fixture.container.querySelectorAll('[role="dialog"]').length, 1);
    assert.equal(combobox(fixture.container, "Project").value, "Payments", "the new project is selected");
    assert.equal((domWindow.document.activeElement as unknown) === combobox(fixture.container, "Project"), true,
      "focus returns to Project");
    assert.match(fixture.container.textContent ?? "", /This project has no locations yet/);
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
    const selected = () => fixture.container.querySelector('button[aria-label^="Location:"]')?.getAttribute("aria-label");
    assert.equal(selected(), "Location: runner-1 · wollipog-fork",
      "two locations on one machine add the folder to the closed field");

    const input = combobox(fixture.container, "Project");
    await act(async () => { input.click(); });
    await act(async () => { pressComboboxKey(input, "Enter"); });

    assert.equal(selected(), "Location: runner-1 · wollipog-fork",
      "committing the same Project is not a dependent-selection reset");
    assert.equal(createButton(fixture.container).disabled, false);
  } finally {
    await unmountFixture(fixture);
  }
});

test("available and unavailable Agents share one searchable flow, without the retired exec driver", async () => {
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
    assert.equal(input.value, "Claude Code", "the first usable Agent is selected initially");
    assertNoDomNode(fixture.container.querySelector('select[aria-label="Agent"]'));

    await act(async () => { input.focus(); });
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(comboboxOptions(fixture.container, "Agent").length, 2, "Claude Code and Codex App Server only (#3259)");

    await act(async () => { setComboboxQuery(input, "non-interactive"); });
    assert.equal(comboboxOptions(fixture.container, "Agent").length, 0);

    await act(async () => { setComboboxQuery(input, "codex login"); });
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

/** Each option's accessible name and description, from the elements its aria-*by attributes name. */
function optionNamesAndDescriptions(options: HTMLButtonElement[]) {
  return options.map((option) => ({
    name: ariaReferencedText(option, "aria-labelledby"),
    description: ariaReferencedText(option, "aria-describedby"),
  }));
}

test("Project and Agent options are named by their label and described by their second lines (#2369)", async () => {
  const agentRunner: RunnerView = {
    ...runner,
    agents: [
      ...runner.agents,
      { id: "codex-app", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: false },
    ],
  };
  const fixture = await mountFixture({ runners: [agentRunner] });
  try {
    const projectInput = combobox(fixture.container, "Project");
    await act(async () => { projectInput.click(); });
    const projectOptions = comboboxOptions(fixture.container, "Project").slice(0, -1);
    assert.deepEqual(optionNamesAndDescriptions(projectOptions), [
      { name: "Wollipog", description: "runner-1 · 1 location" },
      { name: "No Project", description: "Run in any folder on a machine, outside a project." },
    ]);
    for (const option of projectOptions) assert.equal(option.getAttribute("aria-label"), null);
    await act(async () => { projectOptions[0]!.click(); });

    const agent = combobox(fixture.container, "Agent");
    await act(async () => { agent.focus(); });
    const agentOptions = comboboxOptions(fixture.container, "Agent");
    // An unavailable Agent's reason follows its description, as Select's does.
    assert.deepEqual(optionNamesAndDescriptions(agentOptions), [
      { name: "Claude Code", description: "Runs on native host" },
      {
        name: "Codex App Server",
        description: "Needs setup. Interactive target unavailable · runs on native host",
      },
    ]);
    assert.equal(agentOptions[1]?.getAttribute("aria-disabled"), "true");
    for (const option of agentOptions) assert.equal(option.getAttribute("aria-label"), null);
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
    const option = group.querySelector('input[type="checkbox"]')?.closest("label");
    assert.ok(option);
    assert.equal(option.querySelector("input")?.checked.toString(), "false");

    await act(async () => { option.click(); });
    assert.equal(option.querySelector("input")?.checked.toString(), "true");
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
      ...runner.agents,
      { id: "codex-app", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: false },
    ],
  };
  const unavailableFixture = await mountFixture(
    { runners: [recoveryRunner] },
    { runnerId: runner.runnerId },
  );
  try {
    const action = [...unavailableFixture.container.querySelectorAll("button")].find((button) =>
      button.textContent?.trim() === "Use Claude Code") as HTMLLabelElement | undefined;
    assert.ok(action, "the recovery action names the usable agent it selects");
    await act(async () => { action.click(); });
    const saved = loadAgentDefaults()[runner.runnerId];
    assert.equal(typeof saved === "string" ? saved : saved?.agentId, "claude");
  } finally {
    await unmountFixture(unavailableFixture);
    domWindow.localStorage.clear();
  }

  saveAgentDefault({}, runner.runnerId, "missing-agent");
  const missingFixture = await mountFixture({}, { runnerId: runner.runnerId });
  try {
    const action = [...missingFixture.container.querySelectorAll("button")].find((button) =>
      button.textContent?.trim() === "Use Claude Code") as HTMLLabelElement | undefined;
    assert.ok(action, "the recovery action names Claude Code when that is the actual fallback");
  } finally {
    await unmountFixture(missingFixture);
    domWindow.localStorage.clear();
  }
});

test("a saved Codex exec default is not offered or started without a choice (#3224, #3259)", async () => {
  domWindow.localStorage.clear();
  saveAgentDefault({}, runner.runnerId, "codex-exec");
  const codexRunner: RunnerView = {
    ...runner,
    agents: [
      ...runner.agents,
      { id: "codex-app", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true, source: "discovered" },
      { id: "codex-exec", name: "Codex (Non-Interactive)", command: "codex", args: [], env: {}, driver: "codex", available: true, source: "discovered" },
    ],
  };
  const fixture = await mountFixture({ runners: [codexRunner] }, { runnerId: runner.runnerId });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const input = combobox(fixture.container, "Agent");
    assert.equal(input.value, "", "the saved exec default is not preselected");
    await assertCreateRefused(fixture);
    assert.match(fixture.container.querySelector(".agent-default-warning")?.textContent ?? "",
      /non-interactive mode, which is no longer supported/);

    await act(async () => { input.focus(); });
    assert.deepEqual(comboboxOptions(fixture.container, "Agent").map((option) => option.textContent?.match(/^Codex App Server|^Claude Code/)?.[0]),
      ["Claude Code", "Codex App Server"]);
    assert.doesNotMatch(comboboxOptions(fixture.container, "Agent").map((option) => option.textContent).join(" "), /Non-Interactive/);

    const action = [...fixture.container.querySelectorAll("button")].find((button) =>
      button.textContent?.trim() === "Use Codex App Server") as HTMLButtonElement | undefined;
    assert.ok(action, "the recovery action selects Codex App Server");
    await act(async () => { action.click(); });
    assert.equal(input.value, "Codex App Server");
    const saved = loadAgentDefaults()[runner.runnerId];
    assert.equal(typeof saved === "string" ? saved : saved?.agentId, "codex-app");
    assertNoDomNode(fixture.container.querySelector(".agent-default-warning"));
    assert.equal(createButton(fixture.container).disabled, false);
  } finally {
    await unmountFixture(fixture);
    domWindow.localStorage.clear();
  }
});

test("Codex App Server that failed its check needs setup with the runner's reason, not an exec fallback (#3224)", async () => {
  domWindow.localStorage.clear();
  const codexOnly: RunnerView = {
    ...runner,
    agents: [
      {
        id: "codex-app", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server",
        available: false, source: "discovered", authStatus: "authenticated",
        codexAppServer: {
          status: "unsupported",
          appServerAvailable: false,
          failure: {
            code: "probe_timeout",
            message: "Wollipog couldn't check this Codex installation in time. Rediscover to try again.",
            retryable: true,
          },
        },
      },
      { id: "codex-exec", name: "Codex (Non-Interactive)", command: "codex", args: [], env: {}, driver: "codex", available: true, source: "discovered" },
    ],
  };
  const fixture = await mountFixture({ runners: [codexOnly] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const input = combobox(fixture.container, "Agent");
    assert.equal(input.value, "");
    await act(async () => { input.focus(); });
    const options = comboboxOptions(fixture.container, "Agent");
    assert.deepEqual(optionNamesAndDescriptions(options), [{
      name: "Codex App Server",
      description: "Needs setup. Wollipog couldn't check this Codex installation in time. Rediscover to try again.",
    }]);
    assert.equal(options[0]?.getAttribute("aria-disabled"), "true");
    await assertCreateRefused(fixture);
  } finally {
    await unmountFixture(fixture);
  }
});

test("native orchestrator selection is sent at creation", async () => {
  const enabledRunner: RunnerView = {
    ...runner, protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  };
  const fixture = await mountFixture({ runners: [enabledRunner] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    assertNoDomNode(labelledNumberInput(fixture.container, "Maximum Concurrent Children"),
      "ordinary creation does not show an orchestration-only guardrail");
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const limit = labelledNumberInput(fixture.container, "Maximum Concurrent Children");
    assert.ok(limit);
    assert.equal(limit.value, "4", "the compatible effective default is visible rather than implicit");
    assert.equal(limit.min, "0");
    assert.equal(limit.max, "64");
    assert.equal(limit.step, "1");
    await act(async () => { fireDomEvent.change(limit, { target: { value: "9" } }); });
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.config?.permissionMode, "orchestrator");
    assert.equal(fixture.requests[0]?.orchestrator?.behavior?.maximumConcurrentChildren, 9);
  } finally { await unmountFixture(fixture); }
});

test("Maximum Concurrent Children rejects fractional and out-of-range creation values accessibly", async () => {
  const enabledRunner: RunnerView = {
    ...runner, protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  };
  const fixture = await mountFixture({ runners: [enabledRunner] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const limit = labelledNumberInput(fixture.container, "Maximum Concurrent Children");
    assert.ok(limit);

    for (const invalid of ["4.5", "-1", "65", ""]) {
      await act(async () => { fireDomEvent.change(limit, { target: { value: invalid } }); });
      assert.equal(limit.getAttribute("aria-invalid"), "true", invalid);
      await assertCreateRefused(fixture, invalid);
      assert.equal(fixture.container.querySelector(
        `[id="${limit.getAttribute("aria-describedby")?.split(" ")[0]}"]`,
      )?.getAttribute("role"), "alert");
      await act(async () => { submitWithEnter(fixture.container); });
      assert.equal(fixture.requests.length, 0, invalid);
      assert.equal((domWindow.document.activeElement as unknown) === limit, true, invalid);
      // The submit's field error is part of the focused input's description (#2952).
      assert.match(ariaReferencedText(limit, "aria-describedby") ?? "", /Enter a Live Child Limit from 0 to 64\./, invalid);
    }

    await act(async () => { fireDomEvent.change(limit, { target: { value: "0" } }); });
    assert.equal(limit.getAttribute("aria-invalid"), "false");
    assert.equal(createButton(fixture.container).disabled, false);
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.orchestrator?.behavior?.maximumConcurrentChildren, 0,
      "zero is persisted as a deliberate pause rather than treated as empty");
  } finally { await unmountFixture(fixture); }
});

test("Decision Delegation is Orchestrator-only and shows effective sources", async () => {
  const enabledRunner: RunnerView = {
    ...runner, protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  };
  const fixture = await mountFixture({ runners: [enabledRunner] }, undefined, undefined, undefined, undefined, async () => ({
    defaults: structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS),
    source: "user_default",
    capabilities: { models: [{ id: "test-model" }], effortLevels: ["high"], installations: 1, compatibleInstallations: 1, status: "available" },
  }));
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    assertNoDomNode(fixture.container.querySelector('[aria-label^="Descendant Requests:"]'));
    assert.match(fixture.container.textContent ?? "", /Delegate implementation by default/);
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const descendant = fixture.container.querySelector<HTMLButtonElement>('[aria-label^="Descendant Requests:"]');
    assert.match(descendant?.getAttribute("aria-label") ?? "", /Questions and Approvals/);
    assert.match(fixture.container.textContent ?? "", /User Default/);
    assert.match(fixture.container.textContent ?? "", /no read-only operating-system boundary is claimed/i);
    assert.ok(fixture.container.querySelector('[aria-label^="PR Merge Approval:"]'));
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.orchestrator?.delegation?.parentControl, undefined,
      "an inherited effective value is not mislabeled or sent as an explicit override");
    assert.equal(fixture.requests[0]?.config?.permissionMode, "orchestrator");
    assert.equal(fixture.requests[0]?.orchestrator?.behavior?.maximumConcurrentChildren, undefined);
  } finally {
    await unmountFixture(fixture);
  }
});

/** A launch preflight in the shape the server returns; readiness and budget source vary. */
function launchPreflight(ready: boolean, request: import("@wollipog/protocol").FullControlLaunchRequest): import("@wollipog/protocol").CampaignLaunchPreflight {
  const budget = request.overrides?.budget;
  const verified = (id: import("@wollipog/protocol").CampaignLaunchCapabilityId, capability: string) => ({ id, capability, state: "verified" as const, mandatory: true, reason: `${capability} is verified.` });
  return { ready, digest: (ready ? "b" : "a").repeat(64), inspectionCancellation: "supported",
    summary: { repository: "owner/repo", issueNumbers: request.issueNumbers ?? [], objective: request.task ?? "",
      root: { agentId: "claude", driver: "claude-code", model: "claude-opus-5-5", effort: null, isolation: { mode: "provider", network: "inherit" },
        strictProjectIsolation: false, integrationIsolation: false, completion: "retain" },
      budget: { costUsd: budget?.costUsd ?? null, toolCalls: budget?.toolCalls ?? null, concurrency: 4, acceptedFollowUps: 0,
        source: budget?.costUsd ? "override" : "unset", reviewIncluded: true },
      followUps: { policy: "recommend_only", relatedFollowUps: false, maxIssues: 1, closureReasons: ["completed"] },
      evidence: { statement: "The Orchestrator reviews screenshots. Video and external evidence need your review.",
        destination: { kind: "private_session_artifacts", configurationId: "session_artifacts:org", disclosureRevision: 1 }, provider: null, envelope: false },
      humanRequired: [{ exception: "Secrets and Sign-In", reason: "Always decided by the Human under Full Control." }],
      blockers: ready ? [] : [{ capability: "Campaign Accounting and Budget", reason: "No campaign budget yet: enter a cost limit and a tool-call limit." }] },
    capabilities: [verified("repository_scope", "Repository and Issue Scope"), ready ? verified("accounting_budget", "Campaign Accounting and Budget")
      : { id: "accounting_budget", capability: "Campaign Accounting and Budget", state: "unsupported", mandatory: true, reason: "No campaign budget yet: enter a cost limit and a tool-call limit." }],
    advanced: { proposal: null, plan: {} as never, humanRequiredRequests: [] } };
}
const settlePreflight = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
function authorizeButton(container: HTMLDivElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Authorize and Start");
  assert.ok(button, "Full Control has one footer action");
  return button;
}
const fullControlRunner = (): RunnerView => ({ ...runner, protocolVersion: PROTOCOL_VERSION,
  agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
    models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
    permissionModes: ["default", "orchestrator"],
  } })) });

test("Full Control never falls back to ordinary creation; Custom remains launchable", async () => {
  const fixture = await mountFixture({ runners: [fullControlRunner()] }, undefined, undefined, undefined, undefined, undefined, {
    fullControlLaunchPreflight: async (input) => ({ preflight: launchPreflight(false, input) }),
  });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    assert.equal(createButton(fixture.container).disabled, false);
    await act(async () => fixture.container.querySelector<HTMLInputElement>('[data-control-mode="full_control"]')!.click());
    await settlePreflight();
    assert.equal([...fixture.container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Create Session"), false,
      "no second create button");
    assert.equal(authorizeButton(fixture.container).disabled, true);
    await act(async () => submitWithEnter(fixture.container));
    assert.equal(fixture.requests.length, 0);
    assert.match(fixture.container.textContent ?? "", /Full Control isn't ready yet/);
    const providerPermissions = fixture.container.querySelector('[role="group"][aria-label="Provider Permissions"]')!;
    assert.match(providerPermissions.textContent!, /Orchestrator/, "effective coupled preset replaces the saved provider default");
    assert.doesNotMatch(fixture.container.textContent ?? "", /Activation Unavailable/);
    await act(async () => fixture.container.querySelector<HTMLInputElement>('[data-control-mode="custom"]')!.click());
    assert.equal(createButton(fixture.container).disabled, false);
    assert.equal([...fixture.container.querySelectorAll('[role="alert"]')]
      .find((node) => node.textContent?.includes("Full Control isn't ready yet")), undefined, "returning to Custom clears stale validation");
    await act(async () => createButton(fixture.container).click());
    assert.equal(fixture.requests.length, 1);
    assert.equal((fixture.requests[0]?.orchestrator as unknown as Record<string, unknown>).control, undefined);
  } finally { await unmountFixture(fixture); }
});

test("a saved Full Control preference opens the launch summary without granting authority", async () => {
  const fixture = await mountFixture({ runners: [fullControlRunner()] }, undefined, undefined, undefined, undefined,
    async () => ({ defaults: { ...structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS), controlMode: "full_control" },
      source: "user_default", controlModeSupported: true,
      capabilities: { models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available" } }),
    { fullControlLaunchPreflight: async (input) => ({ preflight: launchPreflight(false, input) }) });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    assert.equal(fixture.container.querySelector<HTMLInputElement>('[data-control-mode="full_control"]')!.checked, true);
    await settlePreflight();
    assert.equal(authorizeButton(fixture.container).disabled, true);
    await act(async () => submitWithEnter(fixture.container));
    assert.equal(fixture.requests.length, 0);
    await act(async () => fixture.container.querySelector<HTMLInputElement>('[data-control-mode="custom"]')!.click());
    await act(async () => createButton(fixture.container).click());
    assert.equal(fixture.requests.length, 1);
    assert.equal(Object.hasOwn(fixture.requests[0]!.orchestrator ?? {}, "controlMode"), false);
    assert.equal(Object.hasOwn(fixture.requests[0]!.orchestrator ?? {}, "control"), false);
  } finally { await unmountFixture(fixture); }
});

test("choosing Full Control checks readiness at once, asks only for the budget, and starts through one authorization", async () => {
  const preflights: import("@wollipog/protocol").FullControlLaunchRequest[] = [];
  const admissions: Array<Record<string, unknown>> = [];
  const saved: unknown[] = [];
  const order: string[] = [];
  const fixture = await mountFixture({ runners: [fullControlRunner()] }, undefined, undefined, undefined, undefined, undefined, {
    fullControlLaunchPreflight: async (input) => {
      preflights.push(structuredClone(input));
      return { preflight: launchPreflight(Boolean(input.overrides?.budget?.costUsd && input.overrides.budget.toolCalls && input.task !== "Full Control readiness check"), input) };
    },
    createFullControlCampaign: async (input) => { order.push("admit"); admissions.push(structuredClone(input) as unknown as Record<string, unknown>); return { id: "campaign-1" } as SessionView; },
    updateOrchestratorSettings: async (input) => { order.push("save"); saved.push(structuredClone(input)); return { defaults: input.defaults, source: "user_default", controlModeSupported: true,
      capabilities: { models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available" } }; },
  });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    await act(async () => fixture.container.querySelector<HTMLInputElement>('[data-control-mode="full_control"]')!.click());
    await settlePreflight();
    assert.equal(preflights.length, 1, "readiness is checked before anything is typed");
    assert.equal(preflights[0]!.overrides!.session!.config!.permissionMode, "orchestrator");
    assert.equal(preflights[0]!.projectId, project.id);
    assert.equal(Object.hasOwn(preflights[0]!, "repository"), false, "the server derives the repository");
    assert.match(fixture.container.textContent ?? "", /Can't Start Yet/);
    assert.match(fixture.container.textContent ?? "", /No campaign budget yet/);
    assert.equal(authorizeButton(fixture.container).disabled, true);
    const field = (label: string) => [...fixture.container.querySelectorAll<HTMLLabelElement>("label")]
      .find((node) => node.querySelector("span")?.textContent === label && !node.closest("details"))!.querySelector("input, textarea") as HTMLInputElement;
    await act(async () => fireDomEvent.change(field("Task"), { target: { value: "Deliver #12" } }));
    await act(async () => fireDomEvent.change(field("Issue Numbers"), { target: { value: "#12" } }));
    await act(async () => fireDomEvent.change(field("Cost Limit (USD)"), { target: { value: "20" } }));
    await act(async () => fireDomEvent.change(field("Tool Call Limit"), { target: { value: "200" } }));
    await settlePreflight();
    const latest = preflights.at(-1)!;
    assert.equal(latest.task, "Deliver #12");
    assert.deepEqual(latest.issueNumbers, [12]);
    assert.deepEqual(latest.overrides!.budget, { costUsd: 20, toolCalls: 200 });
    assert.match(fixture.container.textContent ?? "", /Ready to Authorize and Start/);
    assert.match(fixture.container.textContent ?? "", /owner\/repo · #12/);
    assert.equal(authorizeButton(fixture.container).disabled, false);
    assert.equal(admissions.length, 0);
    assert.equal(saved.length, 0, "nothing is saved while the person is still reviewing");
    await act(async () => authorizeButton(fixture.container).click());
    assert.equal(admissions.length, 1);
    assert.deepEqual(order, ["admit", "save"], "the first budget is saved only after the reviewed launch is admitted");
    assert.equal(admissions[0]!.preflightDigest, "b".repeat(64));
    assert.match(String(admissions[0]!.requestId), /^[a-f0-9]{32}$/);
    assert.deepEqual((saved[0] as { defaults: { campaignBudget: unknown } }).defaults.campaignBudget, { costUsd: 20, toolCalls: 200 },
      "Save as Default records the budget the person chose");
    assert.equal(fixture.requests.length, 0, "ordinary creation never runs");
  } finally { await unmountFixture(fixture); }
});

test("Full Control authorizes exactly what is shown: issue-only work, the derived follow-up switch, valid limits, and no default rewrite", async () => {
  const preflights: import("@wollipog/protocol").FullControlLaunchRequest[] = [];
  const admissions: Array<Record<string, unknown>> = [];
  const saved: unknown[] = [];
  const fixture = await mountFixture({ runners: [fullControlRunner()] }, undefined, undefined, undefined, undefined,
    async () => ({ defaults: { ...structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS), controlMode: "full_control", campaignBudget: { costUsd: 30, toolCalls: 300 } },
      source: "user_default", controlModeSupported: true,
      capabilities: { models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available" } }), {
      fullControlLaunchPreflight: async (input) => {
        preflights.push(structuredClone(input));
        const preflight = launchPreflight(input.task !== "Full Control readiness check", input);
        // The server derives related follow-ups from the campaign behavior when the person has not chosen.
        preflight.summary.followUps.relatedFollowUps = input.overrides?.issues?.relatedFollowUps ?? true;
        return { preflight };
      },
      createFullControlCampaign: async (input) => { admissions.push(structuredClone(input) as unknown as Record<string, unknown>); return { id: "campaign-1" } as SessionView; },
      updateOrchestratorSettings: async (input) => { saved.push(structuredClone(input)); throw new Error("a saved budget is never rewritten from launch"); },
    });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    await settlePreflight();
    const field = (label: string, advanced: boolean) => [...fixture.container.querySelectorAll<HTMLLabelElement>("label")]
      .find((node) => node.querySelector("span")?.textContent === label && Boolean(node.closest("details")) === advanced)!
      .querySelector("input, textarea") as HTMLInputElement;
    await act(async () => fireDomEvent.change(field("Issue Numbers", false), { target: { value: "12" } }));
    await settlePreflight();
    const issueOnly = preflights.at(-1)!;
    assert.deepEqual(issueOnly.issueNumbers, [12]);
    assert.equal(Object.hasOwn(issueOnly, "task"), false, "issue-only work never carries the readiness placeholder");
    assert.equal(authorizeButton(fixture.container).disabled, false);

    const related = fixture.container.querySelector<HTMLButtonElement>('details [role="switch"]')!;
    assert.equal(fixture.container.ownerDocument.getElementById(related.getAttribute("aria-labelledby")!)?.textContent, "Related Follow-Ups");
    assert.equal(related.getAttribute("aria-checked"), "true", "the switch shows the server-derived value that would be authorized");

    const before = preflights.length;
    await act(async () => fireDomEvent.change(field("Cost Limit (USD)", true), { target: { value: "-5" } }));
    await settlePreflight();
    assert.match(fixture.container.textContent ?? "", /Enter an amount above 0, up to 1,000,000\./);
    assert.match(fixture.container.textContent ?? "", /Correct the highlighted limits to check readiness\./);
    assert.equal(field("Cost Limit (USD)", true).getAttribute("aria-invalid"), "true");
    assert.equal(authorizeButton(fixture.container).disabled, true, "an invalid entry is never silently replaced by a default");
    assert.equal(preflights.length, before, "no readiness check runs for a launch the person did not enter");
    await act(async () => fireDomEvent.change(field("Maximum Issues", true), { target: { value: "1.5" } }));
    await act(async () => fireDomEvent.change(field("Cost Limit (USD)", true), { target: { value: "45" } }));
    await settlePreflight();
    assert.equal(authorizeButton(fixture.container).disabled, true);
    assert.match(fixture.container.textContent ?? "", /Enter a whole number from 1 to 100\./);
    await act(async () => fireDomEvent.change(field("Maximum Issues", true), { target: { value: "" } }));
    // Every limit is entered as text and read as plain digits: forms `Number` would accept, and text a
    // number input would report as empty, are entry errors rather than "use the derived value".
    for (const [label, text] of [["Cost Limit (USD)", "1e1"], ["Tool Call Limit", "2e2"],
      ["Accepted Follow-Ups", "0b1"], ["Maximum Issues", "0x10"], ["Accepted Follow-Ups", "1e"]] as const) {
      const input = field(label, true);
      assert.equal(input.type, "text", `${label} keeps the raw entry`);
      const before = input.value;
      await act(async () => fireDomEvent.change(input, { target: { value: text } }));
      await settlePreflight();
      assert.equal(input.getAttribute("aria-invalid"), "true", `${label} rejects ${text}`);
      assert.equal(authorizeButton(fixture.container).disabled, true, `${label}=${text} cannot be authorized`);
      await act(async () => fireDomEvent.change(input, { target: { value: before } }));
    }
    await act(async () => fireDomEvent.change(field("Tool Call Limit", true), { target: { value: "450" } }));
    await act(async () => related.click());
    await settlePreflight();
    const override = preflights.at(-1)!;
    assert.deepEqual(override.overrides!.budget, { costUsd: 45, toolCalls: 450 });
    assert.deepEqual(override.overrides!.issues, { relatedFollowUps: false });
    assert.equal(authorizeButton(fixture.container).disabled, false);
    await act(async () => authorizeButton(fixture.container).click());
    assert.equal(admissions.length, 1);
    assert.equal(Object.hasOwn(admissions[0]!, "task"), false);
    assert.deepEqual(saved, [], "an Advanced override applies to this campaign only and never replaces the saved budget");
  } finally { await unmountFixture(fixture); }
});

/** The limit-entry lifecycle (L1-L8 in the review brief): every Full Control limit is a text entry
 * whose typed text is its only state, so what is shown is what is checked and authorized. */
test("Full Control limits keep exactly what was typed through mount, remount, outside changes, edits, clearing, blur and submit", async () => {
  const preflights: import("@wollipog/protocol").FullControlLaunchRequest[] = [];
  const admissions: Array<Record<string, unknown>> = [];
  const fixture = await mountFixture({ runners: [fullControlRunner()] }, undefined, undefined, undefined, undefined, undefined, {
    fullControlLaunchPreflight: async (input) => {
      preflights.push(structuredClone(input));
      return { preflight: launchPreflight(input.task !== "Full Control readiness check", input) };
    },
    createFullControlCampaign: async (input) => { admissions.push(structuredClone(input) as unknown as Record<string, unknown>); return { id: "campaign-1" } as SessionView; },
  });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    await act(async () => fixture.container.querySelector<HTMLInputElement>('[data-control-mode="full_control"]')!.click());
    await settlePreflight();
    const field = (label: string, advanced: boolean) => [...fixture.container.querySelectorAll<HTMLLabelElement>("label")]
      .find((node) => node.querySelector("span")?.textContent === label && Boolean(node.closest("details")) === advanced)
      ?.querySelector("input, textarea") as HTMLInputElement | undefined;
    const type = (input: HTMLInputElement | undefined, value: string) => act(async () => fireDomEvent.change(input!, { target: { value } }));
    const advancedLabels = ["Accepted Follow-Ups", "Maximum Issues"];

    // L1 initial mount: every limit is an empty text entry that means "use the derived value".
    for (const input of [field("Cost Limit (USD)", false), field("Tool Call Limit", false), ...advancedLabels.map((label) => field(label, true))]) {
      assert.equal(input!.type, "text");
      assert.equal(input!.value, "");
      assert.equal(input!.getAttribute("aria-invalid"), "false");
    }
    await type(field("Task", false), "Deliver the fixture");
    await settlePreflight();
    assert.equal(authorizeButton(fixture.container).disabled, false, "empty limits are the derived values");

    // L4 typing invalid -> valid -> invalid.
    const followUps = () => field("Accepted Follow-Ups", true)!;
    await type(followUps(), "1e");
    await settlePreflight();
    assert.equal(followUps().getAttribute("aria-invalid"), "true");
    assert.equal(authorizeButton(fixture.container).disabled, true);
    await type(followUps(), "6");
    await settlePreflight();
    assert.equal(authorizeButton(fixture.container).disabled, false);
    assert.equal(preflights.at(-1)!.overrides!.budget!.acceptedFollowUps, 6);
    await type(followUps(), "6e");
    await settlePreflight();
    assert.equal(authorizeButton(fixture.container).disabled, true);
    const checked = preflights.length;

    // L2 remount within the panel: collapsing and expanding Advanced keeps the entry and its error.
    const details = fixture.container.querySelector<HTMLDetailsElement>("section[aria-label='Full Control Launch'] details")!;
    await act(async () => { details.open = true; details.open = false; });
    assert.match(fixture.container.textContent ?? "", /Correct the highlighted limits to check readiness\./, "the error shows with Advanced collapsed");
    await act(async () => { details.open = true; });
    assert.equal(followUps().value, "6e");
    assert.equal(followUps().getAttribute("aria-invalid"), "true");

    // L3 outside changes: a new readiness input never rewrites the entry. (New Session renders this
    // panel only after the saved defaults load, so they cannot change under it; campaign enable,
    // which can, is covered in the browser test.)
    await type(field("Task", false), "Deliver the fixture again");
    await settlePreflight();
    assert.equal(followUps().value, "6e");
    assert.equal(preflights.length, checked, "no readiness check runs while an entry is invalid");
    await type(field("Cost Limit (USD)", false), "20");
    await type(field("Tool Call Limit", false), "200");

    // L6 blur changes nothing.
    await act(async () => { followUps().focus(); followUps().blur(); });
    assert.equal(followUps().value, "6e");
    assert.equal(followUps().getAttribute("aria-invalid"), "true");

    // L8 submit with an invalid entry starts nothing, by the footer or by Enter.
    await act(async () => authorizeButton(fixture.container).click());
    await act(async () => submitWithEnter(fixture.container));
    assert.equal(admissions.length, 0);
    assert.equal(fixture.requests.length, 0);

    // L5 clearing and L7 reset to the default: an empty entry is the derived value again.
    await type(followUps(), "");
    await settlePreflight();
    assert.equal(followUps().getAttribute("aria-invalid"), "false");
    assert.equal(authorizeButton(fixture.container).disabled, false);
    const shown = preflights.at(-1)!;
    assert.equal(shown.overrides!.budget!.acceptedFollowUps, undefined);
    assert.deepEqual([shown.overrides!.budget!.costUsd, shown.overrides!.budget!.toolCalls], [20, 200]);
    assert.match(fixture.container.textContent ?? "", /\$20 · 200 tool calls/, "the summary shows the amounts that will be authorized");
    await act(async () => authorizeButton(fixture.container).click());
    assert.equal(admissions.length, 1);
    assert.deepEqual(admissions[0]!.overrides && (admissions[0]!.overrides as { budget: unknown }).budget, { costUsd: 20, toolCalls: 200 });
  } finally { await unmountFixture(fixture); }
});

test("switching away from Full Control and back starts its limits fresh", async () => {
  const fixture = await mountFixture({ runners: [fullControlRunner()] }, undefined, undefined, undefined, undefined, undefined, {
    fullControlLaunchPreflight: async (input) => ({ preflight: launchPreflight(false, input) }),
  });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const choose = (mode: string) => act(async () => fixture.container.querySelector<HTMLInputElement>(`[data-control-mode="${mode}"]`)!.click());
    const children = () => [...fixture.container.querySelectorAll<HTMLLabelElement>("details label")]
      .find((node) => node.querySelector("span")?.textContent === "Maximum Issues")!.querySelector("input")!;
    await choose("full_control");
    await act(async () => fireDomEvent.change(children(), { target: { value: "1e" } }));
    assert.equal(children().getAttribute("aria-invalid"), "true");
    // L2 remount through a surface switch: a new panel has no entries and no stale errors.
    await choose("custom");
    await choose("full_control");
    await settlePreflight();
    assert.equal(children().value, "");
    assert.equal(children().getAttribute("aria-invalid"), "false");
    assert.doesNotMatch(fixture.container.textContent ?? "", /Correct the highlighted limits/);
  } finally { await unmountFixture(fixture); }
});

test("Full Control shows one concurrency control, Maximum Concurrent Children, whose value the launch carries", async () => {
  const preflights: import("@wollipog/protocol").FullControlLaunchRequest[] = [];
  const fixture = await mountFixture({ runners: [fullControlRunner()] }, undefined, undefined, undefined, undefined, undefined, {
    fullControlLaunchPreflight: async (input) => {
      preflights.push(structuredClone(input));
      return { preflight: launchPreflight(false, input) };
    },
  });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const limit = () => labelledNumberInput(fixture.container, "Maximum Concurrent Children")!;
    const help = () => fixture.container.querySelector(`[id="${limit().getAttribute("aria-describedby")}"]`)!;
    // Custom: 0 pauses admission.
    await act(async () => { fireDomEvent.change(limit(), { target: { value: "0" } }); });
    assert.equal(limit().getAttribute("aria-invalid"), "false");
    assert.equal(limit().min, "0");
    await act(async () => fixture.container.querySelector<HTMLInputElement>('[data-control-mode="full_control"]')!.click());
    await settlePreflight();
    const concurrencyLabels = [...fixture.container.querySelectorAll("label span:first-child")]
      .map((node) => node.firstChild?.textContent?.trim() ?? "").filter((text) => /Concurren/.test(text));
    assert.deepEqual(concurrencyLabels, ["Maximum Concurrent Children"], "one concurrency control, not a second Campaign Limits entry");
    assert.ok(limit().closest("details"), "it stays under Advanced");
    // Full Control: the campaign's concurrency is this value, and a campaign cannot authorize 0.
    assert.equal(limit().getAttribute("aria-invalid"), "true");
    assert.equal(limit().min, "1");
    assert.equal(help().textContent, "Enter a whole number from 1 to 64.");
    assert.equal(help().getAttribute("role"), "alert");
    assert.equal(preflights.length, 0, "no readiness check runs for a launch that cannot be authorized");
    await act(async () => { fireDomEvent.change(limit(), { target: { value: "6" } }); });
    await settlePreflight();
    assert.equal(limit().getAttribute("aria-invalid"), "false");
    assert.match(help().textContent ?? "", /This is also the campaign's concurrency\./);
    const latest = preflights.at(-1)!;
    assert.equal(latest.overrides!.session!.orchestrator!.behavior!.maximumConcurrentChildren, 6);
    assert.equal(latest.overrides!.budget?.concurrency, undefined, "the server derives the budget concurrency from the one control");
    // Back to Custom: 0 is allowed again.
    await act(async () => fixture.container.querySelector<HTMLInputElement>('[data-control-mode="custom"]')!.click());
    await act(async () => { fireDomEvent.change(limit(), { target: { value: "0" } }); });
    assert.equal(limit().getAttribute("aria-invalid"), "false");
  } finally { await unmountFixture(fixture); }
});

test("new Orchestrator sessions send only explicit overrides after showing effective defaults", async () => {
  const enabledRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  };
  const effective = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
  effective.behavior.childModel = "test-model";
  effective.behavior.childEffort = "high";
  effective.behavior.maximumConcurrentChildren = 5;
  const fixture = await mountFixture({ runners: [enabledRunner] }, undefined, undefined, undefined, undefined, async () => ({
    defaults: effective,
    source: "user_default",
    capabilities: {
      harnesses: [
        {
          agentId: "codex", driver: "codex-app-server", context: { kind: "native" }, name: "Codex App Server",
          models: [{ id: "test-model", displayName: "Test Model", efforts: ["high"] },
            { id: "sol", displayName: "Sol", efforts: ["high"] }],
          effortLevels: ["high"],
          supportedPairs: [{ modelId: "test-model", effortLevels: ["high"] },
            { modelId: "sol", effortLevels: ["high"] }], installations: 1,
        },
        {
          agentId: "pi", driver: "pi", context: { kind: "native" }, name: "Pi",
          models: [{ id: "sol", displayName: "Sol", efforts: ["low"] }], effortLevels: ["low"],
          supportedPairs: [{ modelId: "sol", effortLevels: ["low"] }], installations: 1,
        },
      ],
      models: [{ id: "test-model", displayName: "Test Model", efforts: ["high"] }, { id: "sol", displayName: "Sol", efforts: ["high"] }],
      effortLevels: ["high"], installations: 1, compatibleInstallations: 1, status: "available",
    },
  }));
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    assert.match(fixture.container.querySelector('[aria-label^="Child Model:"]')?.getAttribute("aria-label") ?? "", /Test Model/);
    assert.equal(labelledNumberInput(fixture.container, "Maximum Concurrent Children")?.value, "5");
    assert.match(fixture.container.textContent ?? "", /These effective values are resolved and stored before the campaign's first turn/);
    await chooseSelectOption(fixture.container, "Child Harness", "Pi · Native");
    await chooseSelectOption(fixture.container, "Child Model", "Sol");
    await chooseSelectOption(fixture.container, "PR Merge Approval", "Orchestrator");
    assert.match(fixture.container.textContent ?? "", /Session Override/);
    await act(async () => { createButton(fixture.container).click(); });
    assert.deepEqual(fixture.requests[0]?.orchestrator, {
      behavior: {
        childHarness: { agentId: "pi", driver: "pi", context: { kind: "native" } },
        childModel: "sol",
        childEffort: null,
      },
      delegation: { decisions: { pr_merge: "orchestrator" } },
    });
  } finally {
    await unmountFixture(fixture);
  }
});

test("a fixed Child Harness on an older runner shows the server's refusal sentence", async () => {
  const olderRunner: RunnerView = {
    ...runner,
    protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorChildHarnessPolicy - 1,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [{ id: "test-model", efforts: ["high"] }], effortLevels: ["high"], slashCommands: [],
      supportsImages: false, supportsApprovals: true, permissionModes: ["default", "orchestrator"],
    } })),
  };
  const defaults = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
  defaults.behavior.childHarness = { agentId: "claude", driver: "claude-code", context: { kind: "native" } };
  const fixture = await mountFixture({ runners: [olderRunner] }, undefined, undefined, undefined, undefined, async () => ({
    defaults,
    source: "user_default",
    capabilities: {
      harnesses: [{
        agentId: "claude", driver: "claude-code", context: { kind: "native" }, name: "Claude",
        models: [{ id: "test-model", efforts: ["high"] }], effortLevels: ["high"],
        supportedPairs: [{ modelId: "test-model", effortLevels: ["high"] }], installations: 1,
      }],
      models: [{ id: "test-model", efforts: ["high"] }], effortLevels: ["high"],
      supportedPairs: [{ modelId: "test-model", effortLevels: ["high"] }],
      installations: 1, compatibleInstallations: 1, status: "available",
    },
  }));
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const alerts = [...fixture.container.querySelectorAll('[role="alert"]')]
      .map((node) => node.textContent ?? "").join(" ");
    assert.ok(alerts.includes(
      "This machine needs a newer runner for a fixed child harness. Update and restart the runner. To start now, choose Automatic for Child Harness.",
    ), alerts);
    assert.doesNotMatch(fixture.container.textContent!, /protocol-v/);
    assert.doesNotMatch(alerts, /saved Child Model or Child Effort is no longer advertised/i);
    await assertCreateRefused(fixture);
  } finally {
    await unmountFixture(fixture);
  }
});

test("Orchestrator defaults without Child Harness policy name Wollipog as the thing to update", async () => {
  const enabledRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  };
  // The default fixture's Orchestrator settings advertise no `harnesses`, which is the payload of
  // a server that predates fixed Child Harness policy.
  const fixture = await mountFixture({ runners: [enabledRunner] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const control = [...fixture.container.querySelectorAll(".orchestrator-policy-control")]
      .find((candidate) => candidate.querySelector(":scope > span")?.textContent?.startsWith("Child Harness"));
    assert.ok(control, "Child Harness is rendered");
    const note = control.querySelector(":scope > small.muted")?.textContent ?? "";
    assert.equal(note, "Update or restart Wollipog to configure fixed Child Harness policy.");
    assert.doesNotMatch(note, RETIRED_PROJECT_TERMS);

    // The Select is disabled in this state, so the Automatic option's description never opens and
    // the note above is what a person reads. Pin that the list stays shut, then pin the option's
    // own sentence in source, since no interaction can render it.
    const trigger = fixture.container.querySelector<HTMLButtonElement>('[aria-label^="Child Harness:"]');
    assert.ok(trigger, "Child Harness select is rendered");
    assert.equal(trigger.getAttribute("aria-disabled"), "true");
    await act(async () => { trigger.click(); });
    assertNoDomNode(fixture.container.querySelector('[role="listbox"][aria-label="Child Harness"]'),
      "the disabled Child Harness list does not open");
    const source = readFileSync(new URL("./NewSessionDialog.tsx", import.meta.url), "utf8");
    assert.ok(source.includes(': "Update Wollipog to configure a fixed Child Harness.",'),
      "the Automatic option names Wollipog when fixed Child Harness policy is unavailable");
    assert.doesNotMatch(source, /"Update the control plane to configure a fixed Child Harness\."/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("New Session copy names no runner protocol numbers", () => {
  // docs/design-system.md §17.2: refusals use the shared runner sentence; versions travel as fields.
  const source = readFileSync(new URL("./NewSessionDialog.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /protocol-v\d|protocol v\d/i);
});

test("unsupported control-plane combinations explain the upgrade and block Orchestrator creation", async () => {
  const enabledRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  };
  const fixture = await mountFixture(
    { runners: [enabledRunner] }, undefined, undefined, undefined, undefined,
    async () => { throw new ApiError("Missing", 404); },
  );
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const unavailable = fixture.container.querySelector(".orchestrator-policy-unavailable .form-error")?.textContent ?? "";
    assert.equal(unavailable,
      "This version of Wollipog does not support campaign policy. Update or restart Wollipog so it matches this dashboard.");
    assert.doesNotMatch(unavailable, RETIRED_PROJECT_TERMS);
    await assertCreateRefused(fixture);
    await act(async () => { submitWithEnter(fixture.container); });
    assert.equal(fixture.requests.length, 0);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a session override can repair drifted defaults without rewriting the account", async () => {
  const enabledRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  };
  const drifted = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
  drifted.behavior.childModel = "retired-model";
  const fixture = await mountFixture({ runners: [enabledRunner] }, undefined, undefined, undefined, undefined, async () => ({
    defaults: drifted,
    source: "user_default",
    capabilities: {
      models: [{ id: "sol", displayName: "Sol", efforts: ["high"] }],
      effortLevels: ["high"], supportedPairs: [{ modelId: "sol", effortLevels: ["high"] }],
      installations: 1, compatibleInstallations: 0, status: "unavailable",
      reason: "The saved Child Model is no longer advertised. Choose Automatic.",
    },
  }));
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    await assertCreateRefused(fixture);
    await chooseSelectOption(fixture.container, "Child Model", "Automatic");
    assert.equal(createButton(fixture.container).disabled, false,
      "a compatible explicit override repairs only this new campaign");
    await act(async () => { createButton(fixture.container).click(); });
    assert.deepEqual(fixture.requests[0]?.orchestrator, {
      behavior: { childModel: null }, delegation: {},
    });
  } finally {
    await unmountFixture(fixture);
  }
});

test("Parent Control opt-ins stay disabled on an older runner", async () => {
  const oldRunner: RunnerView = {
    ...runner, protocolVersion: 134,
    runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4,
      executionIsolation: { mode: "bwrap", network: "inherit" } },
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "dontAsk", "orchestrator"],
    } })),
  };
  const fixture = await mountFixture(
    { runners: [oldRunner] }, undefined, undefined, undefined, undefined, strictOrchestratorDefaults,
  );
  try {
    await act(async () => { selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const descendant = fixture.container.querySelector<HTMLButtonElement>('[aria-label^="Descendant Requests:"]')!;
    assert.match(descendant.getAttribute("aria-label") ?? "", /Human/);
    assert.match(descendant.parentElement?.parentElement?.textContent ?? "", /Compatibility Fallback/);
    assert.equal(createButton(fixture.container).disabled, false,
      "an inherited authority default safely downgrades without blocking an older supported runner");
    await act(async () => { descendant.click(); });
    const questions = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("Questions"));
    assert.equal(questions?.getAttribute("aria-disabled"), "true");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Native TUI orchestrator creation is gated by its own runner capability", async () => {
  for (const protocolVersion of [111, 112]) {
    const enabledRunner: RunnerView = {
      ...runner, protocolVersion,
      runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4,
        executionIsolation: { mode: "bwrap", network: "inherit" } },
      agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
        permissionModes: ["default", "dontAsk", "orchestrator"],
      } })),
    };
    const fixture = await mountFixture({ runners: [enabledRunner], capabilities: {
      sessionSubscriptions: false, nativeTuiLaunch: true,
    } }, undefined, undefined, undefined, undefined, strictOrchestratorDefaults);
    try {
      await act(async () => { await selectProject(fixture.container, project.id); });
      await choosePermissionPreset(fixture.container, "Orchestrator");
      const tui = radioRows(fixture.container)
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
    const tui = radioRows(ordinary.container)
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
  }] }), undefined, strictOrchestratorDefaults);
  try {
    await act(async () => { await selectProject(orchestrator.container, project.id); });
    assert.match(orchestrator.container.textContent ?? "",
      /verified Direct WSL bridge and a bubblewrap-isolated runner/u);
    await assertCreateRefused(orchestrator);
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
  }] }), undefined, strictOrchestratorDefaults);
  try {
    await act(async () => { await selectProject(protocolOnly.container, project.id); });
    await assertCreateRefused(protocolOnly,
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
  }] }), undefined, strictOrchestratorDefaults);
  try {
    await act(async () => { await selectProject(providerMode.container, project.id); });
    await assertCreateRefused(providerMode,
      "safe attestation cannot enable Direct WSL under provider isolation");
    assert.equal(providerMode.requests.length, 0);
  } finally { await unmountFixture(providerMode); }
  const bridged = await mountFixture({
    runners: [safeRunner],
    capabilities: { sessionSubscriptions: false, nativeTuiLaunch: true },
  }, undefined, undefined, async () => ({ defaults: [{
    agentId: "claude", driver: "claude-code", context: { kind: "wsl", distro: "Ubuntu-24.04" }, name: "Claude",
    installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" },
  }] }), undefined, strictOrchestratorDefaults);
  try {
    await act(async () => { await selectProject(bridged.container, project.id); });
    assert.equal(createButton(bridged.container).disabled, false, "verified bridge enables Direct creation");
    const tui = radioRows(bridged.container)
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
      runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4,
        executionIsolation: { mode: "bwrap", network: "inherit" } },
      agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
        permissionModes: ["default", "dontAsk", "orchestrator"],
      } })),
    };
    const fixture = await mountFixture({ runners: [enabledRunner], capabilities: {
      sessionSubscriptions: false, nativeTuiLaunch: true,
    } }, undefined, undefined, async () => ({ defaults: [{
      agentId: "claude", driver: "claude-code", context: { kind: "native" }, name: "Claude",
      installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" },
    }] }), undefined, strictOrchestratorDefaults);
    try {
      await act(async () => { await selectProject(fixture.container, project.id); });
      assert.equal(permissionPresetCard(fixture.container, "Orchestrator")?.querySelector("input")?.checked.toString(), "true",
        "a saved Orchestrator default selects the role without an explicit override");
      assert.match(fixture.container.textContent!, /Saved Default — Orchestrator/,
        "the saved default names itself in the always-visible Provider Permissions summary");
      const tui = radioRows(fixture.container)
        .find((button) => button.textContent?.includes("Native TUI"))!;
      assert.equal(cardRefused(tui), protocolVersion < 112);
      if (protocolVersion === 112) {
        await act(async () => { tui.click(); });
        assert.match(fixture.container.textContent!, /spending and tool calls are not included/);
      }
      await act(async () => { createButton(fixture.container).click(); });
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.requests[0]?.config?.permissionMode, undefined, "Default still delegates to the server");
      assert.equal(fixture.requests[0]?.orchestrator?.behavior?.maximumConcurrentChildren, undefined,
        "a visible inherited default is resolved by the server rather than mislabeled as an override");
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
    await assertCreateRefused(fixture);
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
    await assertCreateRefused(fixture);
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
    await assertCreateRefused(fixture);
    await act(async () => { submitWithEnter(fixture.container); });
    assert.equal(fixture.requests.length, 0);
  } finally { await unmountFixture(fixture); }
});

test("Projects mode requires an explicit Project choice and No Project sends exact null identities", async () => {
  const fixture = await mountFixture();
  try {
    assert.equal(combobox(fixture.container, "Project").value, "", "the only Project is not selected implicitly");
    await assertCreateRefused(fixture);

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

function dialogTitled(container: HTMLDivElement, title: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((candidate) => candidate.querySelector(".modal-title")?.textContent === title);
}

function buttonIn(scope: ParentNode, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
}

/** One click and the Modal's focus restore, which runs on a zero-delay timer after it unmounts. */
async function pressAndSettle(button: HTMLButtonElement | undefined): Promise<void> {
  assert.ok(button, "button exists");
  await act(async () => {
    fireDomEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test("Browse… stacks Choose Folder, fills a read-only Folder field, and Use a Workspace goes back (#2271)", async () => {
  const fixture = await mountFixture();
  try {
    await act(async () => { await selectProject(fixture.container, NO_PROJECT_SELECTION); });
    const form = fixture.container.querySelector("form.form")!;
    assert.ok(form.querySelector('[aria-label^="Workspace:"]'), "the workspace picker shows first");
    const browse = buttonIn(form, "Browse…");
    assert.ok(browse && !browse.disabled);
    assert.equal(browse.getAttribute("aria-describedby"), null, "a supported Browse… has no reason to point at");
    assert.equal(form.textContent?.includes("✕"), false);

    await pressAndSettle(browse);
    const chooser = dialogTitled(fixture.container, "Choose Folder");
    assert.ok(chooser, "Browse… stacks Choose Folder");
    assert.ok(dialogTitled(fixture.container, "New Session"), "New Session stays open under it");
    assert.deepEqual(
      [...chooser.querySelectorAll(".modal-foot button")].map((button) => button.textContent),
      ["Cancel", "Use This Folder"],
    );
    await pressAndSettle(buttonIn(chooser, "scratch"));
    await pressAndSettle(buttonIn(chooser, "Use This Folder"));
    assertNoDomNode(dialogTitled(fixture.container, "Choose Folder") ?? null, "Use This Folder closes Choose Folder");

    const folderLabel = [...form.querySelectorAll("label")].find((label) => label.textContent === "Folder");
    assert.ok(folderLabel, "the field is now labelled Folder");
    const folder = form.querySelector<HTMLInputElement>(`[id="${folderLabel.htmlFor}"]`);
    assert.ok(folder);
    assert.equal(folder.value, "/repos/scratch");
    assert.equal(folder.readOnly, true);
    assert.ok(folder.classList.contains("folder-field-path"), "the path uses the mono field style");
    assertNoDomNode(form.querySelector('[aria-label^="Workspace:"]'), "the picker gives way to the Folder field");
    assert.equal(buttonIn(form, "Browse…") === browse, true, "Browse… is the same control in both states");
    assert.equal(fixture.container.ownerDocument.activeElement === browse, true, "focus returns to Browse…");

    const useWorkspace = buttonIn(form, "Use a Workspace");
    assert.ok(useWorkspace, "a labelled text control goes back to a workspace");
    assert.equal(useWorkspace.getAttribute("aria-label"), null, "its name is its visible text");
    await pressAndSettle(useWorkspace);
    const trigger = form.querySelector<HTMLElement>('[aria-label^="Workspace:"]');
    assert.ok(trigger, "Use a Workspace restores the workspace picker");
    assertNoDomNode(form.querySelector(".folder-field-path"), "the Folder field is gone");
    assertNoDomNode(buttonIn(form, "Use a Workspace") ?? null, "Use a Workspace goes with it");
    assert.equal(fixture.container.ownerDocument.activeElement === trigger, true, "focus moves to the restored picker");
  } finally {
    await unmountFixture(fixture);
  }
});

test("creating a session from a browsed folder sends the folder as workspacePath (#2271)", async () => {
  const fixture = await mountFixture();
  try {
    await act(async () => { await selectProject(fixture.container, NO_PROJECT_SELECTION); });
    const form = fixture.container.querySelector("form.form")!;
    await pressAndSettle(buttonIn(form, "Browse…"));
    const chooser = dialogTitled(fixture.container, "Choose Folder")!;
    await pressAndSettle(buttonIn(chooser, "scratch"));
    await pressAndSettle(buttonIn(chooser, "Use This Folder"));

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
      workspacePath: "/repos/scratch",
      acpSessionContext: undefined,
    });
  } finally {
    await unmountFixture(fixture);
  }
});

test("Browse… on a runner without directory browsing is disabled with its reason as visible text (#2271)", async () => {
  const fixture = await mountFixture({ runners: [{ ...runner, protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.directoryListing - 1 }] });
  try {
    await act(async () => { await selectProject(fixture.container, NO_PROJECT_SELECTION); });
    const form = fixture.container.querySelector("form.form")!;
    const browse = buttonIn(form, "Browse…");
    assert.ok(browse);
    assert.equal(browse.disabled, true);
    assert.equal(browse.getAttribute("title"), null, "the reason is not only a tooltip");
    const reasonId = browse.getAttribute("aria-describedby");
    assert.ok(reasonId, "Browse… points at its reason");
    const reason = form.querySelector(`[id="${reasonId}"]`);
    assert.ok(reason, "the reason is rendered");
    assert.ok(reason.classList.contains("field-helper"), "the reason is helper text under the field");
    assert.equal(reason.textContent, "This machine needs a newer runner for directory browsing. Update and restart the runner.");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a late saved-default failure replaces stale loading validation", async () => {
  let reject!: (reason?: unknown) => void;
  const pending = new Promise<AgentHarnessDefaultsView>((_resolve, fail) => { reject = fail; });
  const fixture = await mountFixture({}, undefined, undefined, () => pending);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await act(async () => { submitWithEnter(fixture.container); });
    assert.equal(fieldErrorText(fixture.container), "Wait for saved permission defaults to finish loading.");

    await act(async () => { reject(new ApiError("Unavailable", 503)); });
    assertNoDomNode(fixture.container.querySelector(".modal-body .field-error"),
      "feedback for the superseded loading state is removed when loading becomes retryable");
    assert.match(fixture.container.textContent!, /Retry Defaults/);
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

test("multiple provider accounts expose a picker and submit the selected account", async () => {
  const accountRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, defaultProviderAccountId: "work" })),
    providerAccounts: [
      { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "claude", authStatus: "unauthenticated" },
    ],
  };
  const fixture = await mountFixture({ runners: [accountRunner] }, { projectId: null });
  try {
    assert.match(
      fixture.container.querySelector<HTMLButtonElement>('[aria-label^="Account:"]')?.getAttribute("aria-label") ?? "",
      /Account: Work/,
    );
    await chooseSelectOption(fixture.container, "Account", "Personal");
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.providerAccountId, "personal");
  } finally {
    await unmountFixture(fixture);
  }
});

test("New Session shows the saved default but leaves the server to resolve it when untouched", async () => {
  const accountRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, defaultProviderAccountId: "work" })),
    providerAccounts: [
      { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "claude", authStatus: "authenticated" },
    ],
    providerAccountDefaults: [{ provider: "claude", accountId: "personal", revision: 1 }],
  };
  const fixture = await mountFixture({ runners: [accountRunner] }, { projectId: null });
  try {
    assert.match(fixture.container.querySelector<HTMLButtonElement>('[aria-label^="Account:"]')?.getAttribute("aria-label") ?? "",
      /Account: Personal/u);
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.providerAccountId, undefined,
      "an untouched picker must not turn a displayed default into an explicit override");
  } finally {
    await unmountFixture(fixture);
  }
});

test("New Session sends a deliberately selected account as a one-session override", async () => {
  const accountRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    providerAccounts: [
      { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "claude", authStatus: "authenticated" },
    ],
    providerAccountDefaults: [{ provider: "claude", accountId: "personal", revision: 1 }],
  };
  const fixture = await mountFixture({ runners: [accountRunner] }, { projectId: null });
  try {
    await chooseSelectOption(fixture.container, "Account", "Work");
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.providerAccountId, "work");
  } finally {
    await unmountFixture(fixture);
  }
});

test("New Session drops an override when its account disappears", async () => {
  const accountRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    providerAccounts: [
      { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "claude", authStatus: "authenticated" },
    ],
    providerAccountDefaults: [{ provider: "claude", accountId: "personal", revision: 1 }],
  };
  const fixture = await mountFixture({ runners: [accountRunner] }, { projectId: null });
  try {
    await chooseSelectOption(fixture.container, "Account", "Work");
    await act(async () => {
      fixture.socket.push(snapshot({ runners: [{
        ...accountRunner,
        providerAccounts: accountRunner.providerAccounts?.filter((account) => account.id !== "work"),
      }] }));
    });
    assertNoDomNode(fixture.container.querySelector('[aria-label^="Account:"]'));
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.providerAccountId, undefined,
      "an automatic replacement must not become an explicit override");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a missing saved default requires an explicit account choice", async () => {
  const accountRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    providerAccounts: [{ id: "work", label: "Work", provider: "claude", authStatus: "authenticated" }],
    providerAccountDefaults: [{ provider: "claude", accountId: "removed", revision: 1 }],
  };
  const fixture = await mountFixture({ runners: [accountRunner] }, { projectId: null });
  try {
    await assertCreateRefused(fixture);
    assert.match(fixture.container.textContent ?? "", /saved default account is no longer on this Machine/u);
    await chooseSelectOption(fixture.container, "Account", "Work");
    assert.equal(createButton(fixture.container).disabled, false);
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.providerAccountId, "work");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a WSL agent does not submit an implicit runner-host provider account", async () => {
  const accountRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({
      ...agent,
      context: { kind: "wsl" as const, distro: "Ubuntu" },
      defaultProviderAccountId: undefined,
    })),
    providerAccounts: [
      { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
    ],
    providerAccountDefaults: [{ provider: "claude", accountId: "work", revision: 1 }],
  };
  const fixture = await mountFixture({ runners: [accountRunner] }, { projectId: null });
  try {
    assertNoDomNode(fixture.container.querySelector('[aria-label^="Account:"]'));
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.providerAccountId, undefined);
  } finally {
    await unmountFixture(fixture);
  }
});

test("container targets hide and omit runner-local provider accounts", async () => {
  const boundaries = {
    filesystem: "container" as const,
    network: "deny" as const,
    secrets: "none" as const,
    billing: "none" as const,
  };
  const accountRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, defaultProviderAccountId: "work" })),
    providerAccounts: [
      { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "claude", authStatus: "authenticated" },
    ],
    executionTargets: [
      {
        id: "host-in-place", runnerId: runner.runnerId, name: "Runner Host · in place",
        kind: "local", workspaceStrategy: "in_place", adapter: "host",
        boundaries: { filesystem: "host", network: "inherit", secrets: "runner_local", billing: "agent_account" },
        available: true,
      },
      {
        id: "host-worktree", runnerId: runner.runnerId, name: "Runner Host · worktree",
        kind: "local", workspaceStrategy: "worktree", adapter: "host",
        boundaries: { filesystem: "worktree", network: "inherit", secrets: "runner_local", billing: "agent_account" },
        available: true,
      },
      {
        id: "container", runnerId: runner.runnerId, name: "Offline Container",
        kind: "container", workspaceStrategy: "worktree", adapter: "container", boundaries,
        compatibleAgentIds: ["claude"], available: true,
      },
    ],
  };
  const fixture = await mountFixture({ runners: [accountRunner] }, { projectId: null });
  try {
    await chooseSelectOption(fixture.container, "Account", "Personal");
    await chooseSelectOption(fixture.container, "Execution Target", "Offline Container");
    assertNoDomNode(fixture.container.querySelector('[aria-label^="Account:"]'));
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.executionTargetId, "container");
    assert.equal(fixture.requests[0]?.providerAccountId, undefined);
  } finally {
    await unmountFixture(fixture);
  }
});

test("container targets say the Machine's managed skills are unavailable; host targets do not", async () => {
  const targetRunner: RunnerView = {
    ...runner,
    executionTargets: [
      {
        id: "host-in-place", runnerId: runner.runnerId, name: "Runner Host · in place",
        kind: "local", workspaceStrategy: "in_place", adapter: "host",
        boundaries: { filesystem: "host", network: "inherit", secrets: "runner_local", billing: "agent_account" },
        available: true,
      },
      {
        id: "host-worktree", runnerId: runner.runnerId, name: "Runner Host · worktree",
        kind: "local", workspaceStrategy: "worktree", adapter: "host",
        boundaries: { filesystem: "worktree", network: "inherit", secrets: "runner_local", billing: "agent_account" },
        available: true,
      },
      {
        id: "container", runnerId: runner.runnerId, name: "Offline Container",
        kind: "container", workspaceStrategy: "worktree", adapter: "container",
        boundaries: { filesystem: "container", network: "deny", secrets: "none", billing: "none" },
        available: true,
      },
    ],
  };
  const fixture = await mountFixture({ runners: [targetRunner] }, { projectId: null });
  try {
    assert.doesNotMatch(fixture.container.textContent ?? "", SKILLS_UNAVAILABLE);
    await chooseSelectOption(fixture.container, "Execution Target", "Offline Container");
    assert.match(fixture.container.textContent ?? "", SKILLS_UNAVAILABLE);
    await chooseSelectOption(fixture.container, "Execution Target", "Runner Host · worktree");
    assert.doesNotMatch(fixture.container.textContent ?? "", SKILLS_UNAVAILABLE);
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
    await assertCreateRefused(fixture);

    await act(async () => { fixture.socket.push(snapshot()); });

    assert.equal(combobox(fixture.container, "Project").value, "Wollipog");
    assert.equal(fixture.container.querySelector('button[aria-label^="Location:"]')?.getAttribute("aria-label"),
      "Location: runner-1");
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

    const unavailableSentence = "runner-1 no longer has this folder. Choose another location, or add the folder again.";
    assert.equal(createButton(fixture.container).disabled, true, "an unavailable location is a hard block");
    assert.equal(footerReason(fixture.container), "Choose an online location to continue.");
    assert.equal(fieldErrorText(fixture.container), unavailableSentence);
    await act(async () => { submitWithEnter(fixture.container); });
    assert.equal(fixture.requests.length, 0);
    const locationTrigger = fixture.container.querySelector<HTMLElement>('button[aria-label^="Location:"]');
    assert.equal(locationTrigger?.getAttribute("aria-invalid"), "true");
    assert.equal(ariaReferencedText(locationTrigger!, "aria-describedby"), unavailableSentence);
    assert.equal((domWindow.document.activeElement as unknown) === locationTrigger, true,
      "Enter lands on the Location that needs attention");

    const stillUnavailableProject: ProjectView = { ...unavailableProject, updatedAt: 2 };
    await act(async () => {
      fixture.socket.push(snapshot({ projects: [stillUnavailableProject] }));
    });
    assert.equal(fieldErrorText(fixture.container), unavailableSentence,
      "a validity-neutral inventory refresh preserves actionable feedback");

    await act(async () => { fixture.socket.push(snapshot()); });
    assertNoDomNode(fixture.container.querySelector(".modal-body .field-error"),
      "a validation-relevant live-state correction clears the stale diagnosis");
    assert.equal(footerReason(fixture.container), null);
    assert.equal(createButton(fixture.container).disabled, false);
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

    await assertCreateRefused(fixture);
    await act(async () => { submitWithEnter(fixture.container); });
    assert.equal(fixture.requests.length, 0);
    assert.equal(fieldErrorText(fixture.container), "This project is no longer available. Choose another project.");
    assert.equal((domWindow.document.activeElement as unknown) === combobox(fixture.container, "Project"), true);
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
    const native = radioRows(harness)
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLLabelElement | undefined;
    assert.ok(native);
    // `cardRefused`, not `.disabled`: ChoiceRows never sets the DOM property, so asserting it is
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
    const native = radioRows(fixture.container)
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLLabelElement | undefined;
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
    const native = radioRows(fixture.container)
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLLabelElement | undefined;
    assert.ok(native);
    assert.equal(cardRefused(native), true);
    // The reason now lives ON the refused card rather than in a sibling paragraph, so assert it
    // there — a sentence elsewhere in the dialog would satisfy the old container-wide match while
    // the control itself explained nothing.
    const reason = native.querySelector(".choice-row-reason")?.textContent ?? "";
    assert.equal(reason, "Native TUI launch requires a newer version of Wollipog. Update Wollipog to use it.");
    assert.doesNotMatch(reason, RETIRED_PROJECT_TERMS);
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
    const native = radioRows(fixture.container)
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLLabelElement | undefined;
    assert.ok(native);
    assert.equal(cardRefused(native), true);
    // The start-fence hint is the refused card's own reason now, not a sibling paragraph.
    assert.match(native.textContent ?? "", /This machine needs a newer runner for initial Native TUI launch\. Update and restart the runner\./);
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
    const native = radioRows(fixture.container)
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLLabelElement | undefined;
    assert.ok(native);
    await act(async () => { native.click(); });
    await act(async () => { createButton(fixture.container).click(); });

    assert.equal(fixture.requests[0]?.launchSurface, "native_tui");
    assert.equal(fixture.terminalOpens.count, 0);
    const notice = failureNotice(fixture.container);
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Start the Session");
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "Wollipog couldn't reach the server. Check your connection and try again.");
    assert.doesNotMatch(notice.textContent ?? "", /provider TUI exited/, "the raw error waits behind Show Details");
    await act(async () => { buttonNamed(notice, "Show Details").click(); });
    assert.match(notice.textContent ?? "", /provider TUI exited/);
    assert.equal(buttonNamed(notice, "Open Session", false), undefined, "no session was kept");
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
    const native = radioRows(fixture.container)
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLLabelElement | undefined;
    assert.ok(native);
    await act(async () => { native.click(); });
    await act(async () => { createButton(fixture.container).click(); });

    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.terminalOpens.count, 0);
    // A mocked create failure that kept a session: the notice above the footer, not the footer (#2952).
    const notice = failureNotice(fixture.container);
    assert.equal(notice.querySelector(".notice-title")?.textContent, "Couldn't Start the Session");
    assert.equal(notice.querySelector(".notice-body")?.textContent,
      "Wollipog kept the session, but its terminal may not have opened.");
    const openSession = buttonNamed(notice, "Open Session");
    assert.ok(buttonNamed(notice, "Show Details"));
    assert.equal(notice.closest(".modal-body") !== null, true, "the notice is in the body");
    assert.equal(notice.parentElement?.lastElementChild === notice, true, "at the body's end, above the footer");
    const footerButtons = [...fixture.container.querySelectorAll(".modal-foot button")].map((button) => button.textContent);
    assert.deepEqual(footerButtons, ["Cancel", "Create Session"], "the footer has only Cancel and Create Session");
    assertNoDomNode(fixture.container.querySelector(".modal-foot .form-error"));

    await assertCreateRefused(fixture);
    assert.equal((domWindow.document.activeElement as unknown) === openSession, true,
      "pressing Create Session again lands on Open Session");
    assert.ok(failureNotice(fixture.container), "the kept session's notice stays");
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
    const native = radioRows(fixture.container)
      .find((button) => button.textContent?.includes("Native TUI")) as HTMLLabelElement | undefined;
    assert.ok(native);
    await act(async () => { native.click(); });
    await act(async () => { createButton(fixture.container).click(); });

    assert.equal(fixture.requests.length, 1);
    await assertCreateRefused(fixture);
    assert.ok(buttonNamed(failureNotice(fixture.container), "Open Session"));
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

    const cards = radioRows(permissionPresetGroup(fixture.container));
    assert.equal(cards.length, 2, "both presets are rendered");
    // No trigger, so nothing can be behind one. This is the assertion that would have failed
    // before the migration, when the group was a closed listbox with a single visible button.
    assertNoDomNode(
      fixture.container.querySelector('button[aria-label^="Session Role:"]'),
      "the preset no longer hides behind a popover trigger",
    );
    assertNoDomNode(fixture.container.querySelector(".menu.listbox"), "and opens no list");

    assert.ok(permissionPresetCard(fixture.container, "Orchestrator"));
    assert.equal(permissionPresetCard(fixture.container, "Orchestrator")?.querySelector("input")?.getAttribute("aria-disabled"), null,
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
    assert.equal(orchestrator.querySelector("input")?.getAttribute("aria-disabled"), "true");
    assert.match(orchestrator.textContent ?? "", /runner is too old to orchestrate child sessions/);
    assert.doesNotMatch(orchestrator.textContent ?? "", /agent does not offer/,
      "an old runner cannot establish whether its missing capability is agent-specific");

    // Disabled, not merely styled: clicking must not select it, and the reason must be readable
    // rather than living in a `title` a touch user cannot reach.
    await act(async () => { orchestrator.click(); });
    assert.equal(orchestrator.querySelector("input")?.checked.toString(), "false");
    assert.ok(orchestrator.querySelector(".choice-row-reason"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("an old Codex on unverified WSL reports both independent Orchestrator blockers", async () => {
  const mixedConstraintRunner: RunnerView = {
    ...runner,
    os: "windows",
    protocolVersion: 124,
    agents: [{
      id: "codex",
      name: "Codex",
      command: "codex",
      args: [],
      env: {},
      driver: "codex-app-server",
      context: { kind: "wsl", distro: "Ubuntu-24.04" },
      available: true,
      capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
        permissionModes: ["default"],
      },
      codexAppServer: {
        status: "supported",
        appServerAvailable: true,
        orchestratorApproval: {
          status: "unsupported",
          failure: "Upgrade Codex to 0.154.0 or newer.",
        },
      },
    }],
  };
  const fixture = await mountFixture({ runners: [mixedConstraintRunner] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const orchestrator = permissionPresetCard(fixture.container, "Orchestrator");
    assert.ok(orchestrator);
    assert.equal(orchestrator.querySelector("input")?.getAttribute("aria-disabled"), "true");
    assert.match(orchestrator.textContent ?? "", /Upgrade Codex to 0\.154\.0 or newer/);
    assert.match(orchestrator.textContent ?? "", /verified Direct WSL bridge and a bubblewrap-isolated runner/);
    await act(async () => { orchestrator.click(); });
    assert.equal(orchestrator.querySelector("input")?.checked.toString(), "false", "mixed constraints remain fail closed");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Location is a Select of machines with status and folder, and an offline one can be read but not launched (#2952)", async () => {
  const offlineRunner: RunnerView = {
    ...runner, runnerId: "runner-2", hostname: "build-02", displayName: "Build Server 02", status: "offline",
    workspaces: [{ id: "workspace-2", name: "Wollipog", path: "/srv/checkouts/team/wollipog" }],
  };
  const twoLocations: ProjectView = {
    ...project,
    locations: [
      { ...project.locations[0]!, path: "/home/me/src/repos/wollipog" },
      {
        ...project.locations[0]!, id: "location-2", runnerId: "runner-2", workspaceId: "workspace-2",
        path: "/srv/checkouts/team/wollipog", availability: "runner_offline", isDefault: false,
      },
    ],
  };
  const fixture = await mountFixture({ runners: [runner, offlineRunner], projects: [twoLocations] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const trigger = () => fixture.container.querySelector<HTMLButtonElement>('button[aria-label^="Location:"]')!;
    assert.equal(trigger().getAttribute("aria-label"), "Location: runner-1", "the default location is preselected");
    assertNoDomNode(fixture.container.querySelector('[role="radiogroup"][aria-label="Project Location"]'));

    await act(async () => { trigger().click(); });
    const listbox = fixture.container.querySelector('[role="listbox"][aria-label="Location"]');
    assert.ok(listbox, "Location opens a listbox");
    const options = [...listbox.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    assert.deepEqual(optionNamesAndDescriptions(options.slice(0, -1)), [
      { name: "runner-1", description: "Available · …/repos/wollipog" },
      { name: "Build Server 02", description: "Runner Offline · …/team/wollipog" },
    ]);
    assert.equal(options.at(-1)?.textContent, "Add Location…", "Add Location… is the list's footer row");
    assert.equal(options[1]?.getAttribute("aria-disabled"), null, "an offline location stays choosable");

    await act(async () => { options[1]!.click(); });
    const offlineSentence = "Build Server 02 is offline. Start it, or add a location on another machine.";
    assert.equal(trigger().getAttribute("aria-label"), "Location: Build Server 02");
    assert.equal(trigger().getAttribute("aria-invalid"), "true");
    assert.equal(fieldErrorText(fixture.container), offlineSentence);
    assert.equal(ariaReferencedText(trigger(), "aria-describedby"), offlineSentence);
    assert.equal(footerReason(fixture.container), "Choose an online location to continue.");
    assert.equal(createButton(fixture.container).disabled, true);
    assert.equal(ariaReferencedText(createButton(fixture.container), "aria-describedby"),
      "Choose an online location to continue.");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a project without locations shows the No Locations notice in Location's place (#2952)", async () => {
  const empty: ProjectView = { ...project, locations: [] };
  const fixture = await mountFixture({ projects: [empty] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const notice = fixture.container.querySelector<HTMLElement>(".modal-body .notice.t-neutral.compact");
    assert.ok(notice, "a compact neutral notice");
    assert.match(notice.textContent ?? "", /This project has no locations yet\. Add the folder where its sessions run\./);
    assert.ok(buttonNamed(notice, "Add Location…"));
    assertNoDomNode(fixture.container.querySelector(".modal-body .project-manager-empty"));
    assert.equal(footerReason(fixture.container), "Add a location to continue.");
    assert.equal(createButton(fixture.container).disabled, true);
  } finally {
    await unmountFixture(fixture);
  }

  const viewer = await mountFixture({ projects: [{ ...project, canManage: false }] });
  try {
    await act(async () => { await selectProject(viewer.container, project.id); });
    const trigger = viewer.container.querySelector<HTMLButtonElement>('button[aria-label^="Location:"]')!;
    assert.equal(ariaReferencedText(trigger, "aria-describedby"), "You can't add locations to this project.");
    await act(async () => { trigger.click(); });
    const options = [...viewer.container.querySelectorAll('[role="listbox"][aria-label="Location"] [role="option"]')];
    assert.equal(options.some((option) => option.textContent === "Add Location…"), false,
      "no Add Location… without manage permission");
  } finally {
    await unmountFixture(viewer);
  }
});

test("no machine online shows the No Machines Online notice and the footer's reason (#2952)", async () => {
  const fixture = await mountFixture({ runners: [{ ...runner, status: "offline" }] });
  try {
    const notice = fixture.container.querySelector<HTMLElement>(".modal-body .notice.t-neutral");
    assert.ok(notice);
    assert.equal(notice.querySelector(".notice-title")?.textContent, "No Machines Online");
    assert.match(notice.textContent ?? "", /Start Wollipog on one of your machines, or connect a new one\./);
    assert.ok(buttonNamed(notice, "Open Connections"));
    assert.equal(fixture.container.querySelector(".modal-body")?.firstElementChild?.firstElementChild === notice, true,
      "at the top of the body");
    assert.equal(footerReason(fixture.container), "Connect a machine to continue.");
    assert.equal(createButton(fixture.container).disabled, true);
    assert.doesNotMatch(fixture.container.textContent ?? "", /No runners online/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("New Session's description replaces the closing hint, and retired pieces are gone (#2952)", async () => {
  const fixture = await mountFixture({}, { projectId: null });
  try {
    const dialog = fixture.container.querySelector<HTMLElement>('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(ariaReferencedText(dialog, "aria-describedby"), "Choose the model and write your first message once it opens.");
    assert.doesNotMatch(fixture.container.textContent ?? "", /Pick the model, effort/);
    for (const selector of [".static-pick", ".new-session-project-actions", ".new-session-hint", ".new-session-project-control"]) {
      assertNoDomNode(fixture.container.querySelector(selector), `${selector} is retired`);
    }
    assert.ok(fixture.container.querySelector('button[aria-label^="Machine:"]'),
      "with one machine online, Machine is still a Select");
    const row = fixture.container.querySelector(".modal-body .field-row");
    assert.ok(row?.contains(combobox(fixture.container, "Project")), "Project shares the row");
    assert.ok(row?.querySelector('button[aria-label^="Machine:"]'), "with Machine under No Project");
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
    for (const label of ["Session Role", "Harness"]) {
      const group = fixture.container.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
      assert.ok(group, `${label} is a labelled radiogroup`);
      assert.ok(group.querySelector(".choice-row"), `${label} uses the shared ChoiceRow`);
    }
    // And nothing bespoke is left from the families this PR retired.
    assertNoDomNode(fixture.container.querySelector(".loc-pick"));
    assertNoDomNode(fixture.container.querySelector(".workflow-preset"));
  } finally {
    await unmountFixture(fixture);
  }
});

test("Orchestrator is an additive role that keeps the harness's ordinary provider permissions", async () => {
  const claudeRunner: RunnerView = {
    ...runner, protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "acceptEdits", "orchestrator"],
    } })),
  };
  const savedAcceptEdits = async (): Promise<AgentHarnessDefaultsView> => ({ defaults: [{
    agentId: "claude", driver: "claude-code", context: { kind: "native" }, name: "Claude",
    installations: [], compatibleInstallations: 1, preference: { permissionMode: "acceptEdits" },
  }] });
  const fixture = await mountFixture({ runners: [claudeRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } }, undefined, undefined, savedAcceptEdits);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const providerPermissions = fixture.container.querySelector('[role="group"][aria-label="Provider Permissions"]');
    assert.ok(providerPermissions, "Provider Permissions is an independent, always-visible control");
    assert.match(providerPermissions.textContent!, /Saved Default — Auto-?Accept Edits/i);
    await choosePermissionPreset(fixture.container, "Orchestrator");
    assert.match(providerPermissions.textContent!, /Saved Default — Auto-?Accept Edits/i,
      "selecting Orchestrator does not consume the provider permission-mode selection");
    assert.match(providerPermissions.textContent!, /same permission modes, integrations, and credentials as a normal session/);
    assert.doesNotMatch(providerPermissions.textContent!, /Orchestrator Preset/);
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.role, "orchestrator");
    assert.equal(fixture.requests[0]?.config?.permissionMode, undefined,
      "the provider mode is resolved by the server exactly as for a normal session");
  } finally { await unmountFixture(fixture); }

  const strict = await mountFixture({ runners: [claudeRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } }, undefined, undefined, savedAcceptEdits, undefined, strictOrchestratorDefaults);
  try {
    await act(async () => { await selectProject(strict.container, project.id); });
    await choosePermissionPreset(strict.container, "Orchestrator");
    const providerPermissions = strict.container.querySelector('[role="group"][aria-label="Provider Permissions"]')!;
    assert.match(providerPermissions.textContent!, /Orchestrator Preset — Harness-Enforced/);
    assert.match(providerPermissions.textContent!, /Strict Project Isolation is enforced/,
      "the preset is disclosed with the policy that selects it rather than inferred from the role");
  } finally { await unmountFixture(strict); }

  const legacyControlPlane = await mountFixture({ runners: [claudeRunner] }, undefined, undefined, savedAcceptEdits);
  try {
    await act(async () => { await selectProject(legacyControlPlane.container, project.id); });
    await choosePermissionPreset(legacyControlPlane.container, "Orchestrator");
    const providerPermissions = legacyControlPlane.container.querySelector('[role="group"][aria-label="Provider Permissions"]')!;
    assert.match(providerPermissions.textContent!, /Update Wollipog to give an Orchestrator ordinary provider permissions\./);
    assert.doesNotMatch(providerPermissions.textContent!, RETIRED_PROJECT_TERMS);
    await act(async () => { createButton(legacyControlPlane.container).click(); });
    assert.equal(legacyControlPlane.requests[0]?.role, undefined, "older control planes never receive the field");
    assert.equal(legacyControlPlane.requests[0]?.config?.permissionMode, "orchestrator",
      "the coupled preset remains the only encoding an older control plane understands");
  } finally { await unmountFixture(legacyControlPlane); }
});

test("a non-strict Codex Orchestrator shows the saved harness default rather than the preset", async () => {
  const codexRunner: RunnerView = {
    ...runner, protocolVersion: PROTOCOL_VERSION,
    agents: [{
      id: "codex", name: "Codex App Server", command: "codex", args: [], env: {},
      driver: "codex-app-server", available: true, context: { kind: "native" },
      capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
        permissionModes: ["auto-review", "read-only", "on-request", "orchestrator"],
      },
    }],
  };
  const savedReadOnly = async (): Promise<AgentHarnessDefaultsView> => ({ defaults: [{
    agentId: "codex", driver: "codex-app-server", context: { kind: "native" }, name: "Codex App Server",
    installations: [], compatibleInstallations: 1, preference: { permissionMode: "read-only" },
  }] });
  const fixture = await mountFixture({ runners: [codexRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } }, undefined, undefined, savedReadOnly);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const providerPermissions = fixture.container.querySelector('[role="group"][aria-label="Provider Permissions"]')!;
    const normalSummary = providerPermissions.textContent!;
    assert.match(normalSummary, /Saved Default —/);
    await choosePermissionPreset(fixture.container, "Orchestrator");
    assert.match(providerPermissions.textContent!, /Saved Default —/,
      "a non-strict Codex Orchestrator shows the saved harness default");
    assert.match(providerPermissions.textContent!, /same permission modes, integrations, and credentials as a normal session/);
    assert.doesNotMatch(providerPermissions.textContent!, /Orchestrator Preset/);
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.role, "orchestrator");
    assert.equal(fixture.requests[0]?.config?.permissionMode, undefined,
      "the provider mode is resolved by the server exactly as for a normal session");
  } finally { await unmountFixture(fixture); }

  const strict = await mountFixture({ runners: [codexRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } }, undefined, undefined, savedReadOnly, undefined, strictOrchestratorDefaults);
  try {
    await act(async () => { await selectProject(strict.container, project.id); });
    await choosePermissionPreset(strict.container, "Orchestrator");
    const providerPermissions = strict.container.querySelector('[role="group"][aria-label="Provider Permissions"]')!;
    assert.match(providerPermissions.textContent!, /Orchestrator Preset — Harness-Enforced/);
    assert.match(providerPermissions.textContent!, /Strict Project Isolation is enforced/);
  } finally { await unmountFixture(strict); }

  const outdatedRunner = await mountFixture({
    runners: [{ ...codexRunner, protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditiveCodex - 1 }],
    capabilities: { sessionSubscriptions: false, projects: true, orchestratorRole: true },
  }, undefined, undefined, savedReadOnly);
  try {
    await act(async () => { await selectProject(outdatedRunner.container, project.id); });
    await choosePermissionPreset(outdatedRunner.container, "Orchestrator");
    const providerPermissions = outdatedRunner.container.querySelector('[role="group"][aria-label="Provider Permissions"]')!;
    assert.match(providerPermissions.textContent!, /Orchestrator Preset — Harness-Enforced/);
    // This version already satisfies the Claude gate, so the requirement shown is Codex's own.
    assert.ok(RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditiveCodex - 1 >= RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditiveRole);
    assert.match(providerPermissions.textContent!, /needs a newer runner for independent Orchestrator provider permissions\./,
      "the runner requirement names the Codex gate, not the Claude one");
  } finally { await unmountFixture(outdatedRunner); }
});

/**
 * A current Codex installation on a platform without Codex's audited sandbox (#1308). The runner
 * attests the additive role — the additive launch injects no sandbox, approval, or reviewer setting,
 * so it needs none — while correctly withholding the coupled preset's permission mode, whose forced
 * `sandbox_mode="workspace-write"` that sandbox is what enforces.
 */
const windowsCodexRunner: RunnerView = {
  ...runner, os: "windows", protocolVersion: PROTOCOL_VERSION,
  agents: [{
    id: "codex", name: "Codex App Server", command: "codex", args: [], env: {},
    driver: "codex-app-server", available: true, context: { kind: "native" },
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["auto-review", "read-only", "on-request"],
      orchestratorAdditive: true,
    },
  }],
};

test("an additive Codex Orchestrator is offered where the audited sandbox is unavailable, and Strict Project Isolation is not", async () => {
  const fixture = await mountFixture({ runners: [windowsCodexRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    assert.equal(permissionPresetCard(fixture.container, "Orchestrator")?.querySelector("input")?.getAttribute("aria-disabled"), null,
      "the role is offered wherever the runner advertises the additive launch");
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const providerPermissions = fixture.container.querySelector('[role="group"][aria-label="Provider Permissions"]')!;
    assert.doesNotMatch(providerPermissions.textContent!, /Orchestrator Preset/,
      "the launch keeps the permission mode a normal Codex session would use here");
    assert.match(providerPermissions.textContent!, /same permission modes, integrations, and credentials as a normal session/);
    for (const error of fixture.container.querySelectorAll('.form-error[role="alert"]')) {
      assert.doesNotMatch(error.textContent ?? "", /Provider-mode orchestration|sandbox/,
        "no platform reason is stated, because the additive launch has no platform condition");
    }
    assert.equal(createButton(fixture.container).disabled, false);
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.role, "orchestrator");
    assert.equal(fixture.requests[0]?.config?.permissionMode, undefined,
      "the provider mode is resolved by the server exactly as for a normal session");
  } finally { await unmountFixture(fixture); }

  // The preset's own precondition is untouched: without it there is no Strict Project Isolation
  // here, and the dialog says which advertisement is missing rather than refusing the whole role.
  const strict = await mountFixture({ runners: [windowsCodexRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } }, undefined, undefined, undefined, undefined, strictOrchestratorDefaults);
  try {
    await act(async () => { await selectProject(strict.container, project.id); });
    await choosePermissionPreset(strict.container, "Orchestrator");
    const errors = [...strict.container.querySelectorAll('.form-error[role="alert"]')]
      .map((error) => error.textContent ?? "").join(" ");
    assert.match(errors, /Strict Project Isolation is delivered by the Orchestrator preset/);
    await assertCreateRefused(strict);
  } finally { await unmountFixture(strict); }
});

/**
 * A native Linux Codex installation whose CLI predates granular approvals. Since #1308 the runner
 * advertises the additive role for it — the additive launch imposes no approval policy — while
 * `withOrchestratorPreset` still withholds the coupled preset's permission mode, which is exactly
 * what that approval capability is a precondition of.
 */
const approvalLessCodexRunner: RunnerView = {
  ...runner, protocolVersion: PROTOCOL_VERSION,
  agents: [{
    id: "codex", name: "Codex App Server", command: "codex", args: [], env: {},
    driver: "codex-app-server", available: true, context: { kind: "native" },
    codexAppServer: {
      status: "supported", appServerAvailable: true,
      orchestratorApproval: {
        status: "unsupported", failure: "Update the Codex CLI for granular approvals.",
      },
    },
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["auto-review", "read-only", "on-request"],
      orchestratorAdditive: true,
    },
  }],
};

test("an installation that offers only the additive role never submits the coupled preset it cannot launch", async () => {
  // A control plane too old to request the role forces every Orchestrator back onto the coupled
  // preset, which submits `permissionMode: "orchestrator"`. `capabilityConfigError` refuses that
  // mode from an installation that does not advertise it, so the dialog must block rather than
  // submit a request creation would answer with 409.
  const legacy = await mountFixture({ runners: [approvalLessCodexRunner] });
  try {
    await act(async () => { await selectProject(legacy.container, project.id); });
    await choosePermissionPreset(legacy.container, "Orchestrator");
    assert.match(legacy.container.textContent!, /Update Wollipog to give an Orchestrator ordinary provider permissions\./);
    await assertCreateRefused(legacy,
      "the coupled preset this control plane would force is not launchable by this installation");
    assert.equal(legacy.requests.length, 0);
  } finally { await unmountFixture(legacy); }

  // With nothing forcing the preset, the additive shape is offered and submitted. A saved
  // Orchestrator harness default cannot force the preset here either: the mode is absent from this
  // installation, so `savedSessionPermissionMode` discards the preference rather than selecting an
  // unlaunchable shape.
  const savedPreset = async (): Promise<AgentHarnessDefaultsView> => ({ defaults: [{
    agentId: "codex", driver: "codex-app-server", context: { kind: "native" },
    name: "Codex App Server", installations: [], compatibleInstallations: 1,
    preference: { permissionMode: "orchestrator" },
  }] });
  for (const [label, defaults] of [
    ["no saved default", undefined],
    ["a saved Orchestrator harness default this installation cannot honour", savedPreset],
  ] as const) {
    const additive = await mountFixture({ runners: [approvalLessCodexRunner], capabilities: {
      sessionSubscriptions: false, projects: true, orchestratorRole: true,
    } }, undefined, undefined, defaults);
    try {
      await act(async () => { await selectProject(additive.container, project.id); });
      await choosePermissionPreset(additive.container, "Orchestrator");
      assert.equal(createButton(additive.container).disabled, false, label);
      await act(async () => { createButton(additive.container).click(); });
      assert.equal(additive.requests[0]?.role, "orchestrator", label);
      assert.equal(additive.requests[0]?.config?.permissionMode, undefined,
        `${label}: granular approval support is the preset's precondition, not the additive launch's`);
    } finally { await unmountFixture(additive); }
  }
});

test("choosing Normal explicitly overrides a saved Orchestrator harness default on a current control plane", async () => {
  const claudeRunner: RunnerView = {
    ...runner, protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "acceptEdits", "orchestrator"],
    } })),
  };
  const fixture = await mountFixture({ runners: [claudeRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } }, undefined, undefined, async () => ({ defaults: [{
    agentId: "claude", driver: "claude-code", context: { kind: "native" }, name: "Claude",
    installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" },
  }] }));
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    assert.equal(permissionPresetCard(fixture.container, "Orchestrator")?.querySelector("input")?.checked.toString(), "true");
    assert.match(fixture.container.textContent!, /Choose Normal to ignore it for this session/);
    await choosePermissionPreset(fixture.container, "Normal");
    assert.equal(permissionPresetCard(fixture.container, "Normal")?.querySelector("input")?.checked.toString(), "true");
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.role, "normal");
    assert.equal(fixture.requests[0]?.config?.permissionMode, undefined);
    assert.equal(fixture.requests[0]?.orchestrator, undefined);
  } finally { await unmountFixture(fixture); }
});

/**
 * A Pi installation that offers ONLY the additive role: the runner attested `orchestratorAdditive`
 * from the verified Agent Control bridge, but cannot offer the coupled preset because it runs the
 * default `provider` execution isolation. This is the default configuration (#1294 finding 2), and
 * `piAgentControl` is deliberately absent because `agentsForControlPlane` clears it before
 * publishing and the control-plane database never persists it.
 */
const piAdditiveRunner: RunnerView = {
  ...runner, protocolVersion: PROTOCOL_VERSION,
  agents: [{
    id: "pi", name: "Pi", command: "pi", args: [], env: {},
    driver: "pi", available: true, context: { kind: "native" },
    capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
      permissionModes: ["default", "dontAsk", "bypassPermissions"],
      orchestratorAdditive: true,
    },
  }],
};

test("a Pi agent offering only the additive role can launch an Orchestrator", async () => {
  const fixture = await mountFixture({ runners: [piAdditiveRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    assert.equal(cardRefused(permissionPresetCard(fixture.container, "Orchestrator")), false,
      "the Orchestrator card is offered even though this installation has no coupled preset");
    await choosePermissionPreset(fixture.container, "Orchestrator");
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.role, "orchestrator");
    assert.equal(fixture.requests[0]?.config?.permissionMode, undefined,
      "the additive role never consumes the provider permission-mode selection");
  } finally { await unmountFixture(fixture); }
});

test("an additive-only Pi Orchestrator refuses Strict Project Isolation with a reason", async () => {
  const strict = await mountFixture({ runners: [piAdditiveRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } }, undefined, undefined, undefined, undefined, strictOrchestratorDefaults);
  try {
    await act(async () => { await selectProject(strict.container, project.id); });
    await choosePermissionPreset(strict.container, "Orchestrator");
    // Strict Project Isolation is delivered only by the coupled preset, which this installation
    // cannot launch. The dialog must say so and refuse, not submit a shape the server rejects.
    assert.match(strict.container.textContent!, /Strict Project Isolation is delivered by the Orchestrator preset/);
    await assertCreateRefused(strict,
      "a shape the control plane would refuse is never submittable");
    await act(async () => { createButton(strict.container).click(); });
    assert.equal(strict.requests.length, 0);
  } finally { await unmountFixture(strict); }
});

test("an agent offering neither Orchestrator advertisement still says the agent lacks the role", async () => {
  const plain: RunnerView = {
    ...piAdditiveRunner,
    agents: piAdditiveRunner.agents.map((agent) => ({
      ...agent, capabilities: { ...agent.capabilities!, orchestratorAdditive: undefined },
    })),
  };
  const fixture = await mountFixture({ runners: [plain], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    assert.equal(cardRefused(permissionPresetCard(fixture.container, "Orchestrator")), true);
    assert.match(fixture.container.textContent!, /does not offer the Orchestrator role/);
  } finally { await unmountFixture(fixture); }
});

test("Integration Isolation is an independent control that discloses what it removes", async () => {
  const fixture = await mountFixture({ runners: [piAdditiveRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    // Off by default, and the dialog says integrations load as they would for a normal session.
    assert.match(fixture.container.textContent!,
      /Hooks, plugins, extensions, skills, and configured MCP servers load exactly as they would/);
    await chooseSelectOption(fixture.container, "Integration Isolation", "Enabled");
    // The copy follows the SELECTED agent's harness, because the policy genuinely differs by
    // harness. This fixture is Pi.
    assert.match(fixture.container.textContent!,
      /Removes discovered extensions, skills, prompt templates, and ambient context files/);
    assert.doesNotMatch(fixture.container.textContent!, /cannot drop hooks/,
      "the Claude-specific caveat must not be shown for a Pi launch");
    assert.match(fixture.container.textContent!,
      /provider permission mode, built-in tool inventory, sandbox and approval behavior, and the project boundary are unchanged/);
    assert.equal(createButton(fixture.container).disabled, false);
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.orchestrator?.execution?.integrationIsolation, true);
    assert.equal(fixture.requests[0]?.orchestrator?.execution?.strictProjectIsolation, undefined,
      "an untouched project boundary keeps the provenance of the default it came from");
    assert.equal(fixture.requests[0]?.config?.permissionMode, undefined,
      "and without consuming the provider permission mode");
  } finally { await unmountFixture(fixture); }
});

test("an older runner blocks Integration Isolation rather than letting it be submitted", async () => {
  const oldPi: RunnerView = {
    ...piAdditiveRunner,
    protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorIntegrationIsolation - 1,
  };
  const fixture = await mountFixture({ runners: [oldPi], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    await chooseSelectOption(fixture.container, "Integration Isolation", "Enabled");
    const alerts = [...fixture.container.querySelectorAll('[role="alert"]')]
      .map((node) => node.textContent ?? "").join(" ");
    assert.ok(alerts.includes(
      "This machine needs a newer runner for integration isolation. Update and restart the runner. To start now, turn off Integration Isolation.",
    ), alerts);
    assert.doesNotMatch(fixture.container.textContent!, /protocol-v/);
    await assertCreateRefused(fixture,
      "the dialog never advertises a shape the control plane refuses");
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 0);
  } finally { await unmountFixture(fixture); }
});

test("an Orchestrator without Strict Project Isolation on an older runner shows the server's refusal sentence", async () => {
  const oldRunner: RunnerView = {
    ...runner,
    protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorExecutionPolicy - 1,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "dontAsk", "orchestrator"],
    } })),
  };
  const fixture = await mountFixture({ runners: [oldRunner] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const alerts = [...fixture.container.querySelectorAll('[role="alert"]')]
      .map((node) => node.textContent ?? "").join(" ");
    assert.ok(alerts.includes(
      "This machine needs a newer runner for an Orchestrator without strict project isolation. Update and restart the runner. To start now, turn on Strict Project Isolation.",
    ), alerts);
    assert.doesNotMatch(fixture.container.textContent!, /protocol-v/);
    await assertCreateRefused(fixture);
  } finally { await unmountFixture(fixture); }
});

test("Strict Project Isolation shows Integration Isolation as implied and not separately selectable", async () => {
  const fixture = await mountFixture({ runners: [piAdditiveRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } }, undefined, undefined, undefined, undefined, strictOrchestratorDefaults);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const trigger = fixture.container.querySelector<HTMLButtonElement>('[aria-label^="Integration Isolation:"]');
    assert.ok(trigger, "the control is still shown, so the effective value is visible");
    assert.equal(trigger.getAttribute("aria-disabled"), "true",
      "it is implied rather than independently selectable");
    assert.match(trigger.getAttribute("aria-label")!, /Enabled/);
    assert.match(fixture.container.textContent!,
      /already launches without provider integrations, so this policy is implied and cannot be disabled/);
    // A strict launch is a coupled preset, which fixes the tool inventory and approval behavior,
    // so the additive launch's "everything else is unchanged" promise must not appear here.
    assert.match(fixture.container.textContent!, /harness-owned Orchestrator preset replaces the provider surface/);
    assert.doesNotMatch(fixture.container.textContent!, /sandbox and approval behavior, and the project boundary are unchanged/);
  } finally { await unmountFixture(fixture); }
});

test("the Claude Integration Isolation copy says MCP servers go and hooks, plugins, and permission rules stay", async () => {
  const claudeAdditive: RunnerView = {
    ...runner, protocolVersion: PROTOCOL_VERSION,
    agents: [{
      id: "claude", name: "Claude Code", command: "claude", args: [], env: {},
      driver: "claude-code", available: true, context: { kind: "native" },
      capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true,
        permissionModes: ["default", "acceptEdits"],
        orchestratorAdditive: true,
      },
    }],
  };
  const fixture = await mountFixture({ runners: [claudeAdditive], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    await chooseSelectOption(fixture.container, "Integration Isolation", "Enabled");
    // Claude Code isolates MCP servers ONLY. The copy must under-promise exactly, and say why.
    assert.match(fixture.container.textContent!,
      /Removes configured MCP servers, so Wollipog's management tools are the only MCP integration/);
    assert.match(fixture.container.textContent!,
      /Hooks, plugins enabled in settings, skills, and your permission rules are all kept/);
    assert.match(fixture.container.textContent!,
      /cannot drop hooks without also dropping either your permission rules or Wollipog's own governance hooks/);
    assert.doesNotMatch(fixture.container.textContent!, /Removes .*apps, plugins, and hooks/,
      "the Codex wording must not leak into a Claude launch");
  } finally { await unmountFixture(fixture); }
});

/** An Orchestrator settings payload from a control plane that predates the policy: its own default
 * shape has no `execution.integrationIsolation`, and its override parser rejects the key. */
async function preIntegrationIsolationDefaults(): Promise<OrchestratorSettingsView> {
  const defaults = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
  delete (defaults.execution as Partial<typeof defaults.execution>).integrationIsolation;
  return {
    defaults,
    source: "system_default",
    capabilities: {
      models: [{ id: "test-model", efforts: ["high"] }], effortLevels: ["high"],
      installations: 1, compatibleInstallations: 1, status: "available",
    },
  };
}

test("an older control plane blocks Integration Isolation even when the runner supports it", async () => {
  // The peers upgrade independently: this runner is current, the control plane is not.
  const fixture = await mountFixture({ runners: [piAdditiveRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } }, undefined, undefined, undefined, undefined, preIntegrationIsolationDefaults);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const trigger = fixture.container.querySelector<HTMLButtonElement>('[aria-label^="Integration Isolation:"]');
    assert.ok(trigger, "the setting is still shown rather than hidden");
    assert.equal(trigger.getAttribute("aria-disabled"), "true");
    assert.match(fixture.container.textContent!, /Update Wollipog to configure Integration Isolation\./);
    assert.doesNotMatch(fixture.container.textContent!, /Update the control plane/);
    // An unrelated Orchestrator session must still be creatable, and the request must not carry a
    // key this control plane would reject as an unknown override.
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.role, "orchestrator");
    assert.equal(
      Object.hasOwn(fixture.requests[0]?.orchestrator?.execution ?? {}, "integrationIsolation"), false,
      "the field is never sent to a control plane that does not know it");
  } finally { await unmountFixture(fixture); }
});
