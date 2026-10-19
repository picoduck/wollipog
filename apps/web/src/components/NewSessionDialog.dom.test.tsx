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
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { NewSessionDialog, type NewSessionPreset } from "./NewSessionDialog.js";
import { describeBoundaries } from "./SessionOptions.js";
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

/** Views the dialog asked the app to show, and how often it asked to close, newest last. */
const navigated: View[] = [];
const dialogCloses = { count: 0 };
const navigation: ViewNavigation = {
  current: () => ({ name: "inbox" }),
  push(view) { navigated.push(view); },
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
  return ready
    ? <NewSessionDialog onClose={() => { dialogCloses.count += 1; }} onOpenTerminal={onOpenTerminal} preset={preset} />
    : null;
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

/** A list's options without its footer action row ("Set Up Agents in Connections"), which is an
 * option to assistive technology but never a value. */
function choiceOptions(container: HTMLDivElement, label: string): HTMLButtonElement[] {
  return comboboxOptions(container, label).filter((option) => !option.id.endsWith("-footer"));
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
 * Whether a segmented option is refused, by the attribute the primitive actually uses.
 *
 * `SegmentedControl` marks an unavailable option `aria-disabled` rather than setting `disabled`,
 * deliberately: the DOM property removes the control from the arrow order, so a keyboard user could
 * not reach the option to hear why it is unavailable (#2954 moved Role and Harness onto it).
 */
function cardRefused(card: Element | undefined): boolean {
  assert.ok(card, "the option is rendered even when it cannot be chosen");
  return card.getAttribute("aria-disabled") === "true";
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
  const group = container.querySelector('[role="radiogroup"][aria-label="Role"]');
  assert.ok(group, "Role renders a segmented choice in Options");
  return group;
}

/** Every segmented option (a `role="radio"` button) in `scope`. */
function radioRows(scope: ParentNode): HTMLButtonElement[] {
  return [...scope.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

function permissionPresetCard(container: HTMLDivElement, title: string): HTMLButtonElement | undefined {
  return radioRows(permissionPresetGroup(container))
    .find((option) => option.textContent?.trim() === title);
}

/** The setting row a control sits in, whose description says what it does or why it can't (#2954). */
function settingRowOf(element: Element): HTMLElement {
  const row = element.closest<HTMLElement>(".setting-row");
  assert.ok(row, "the control sits in a setting row");
  return row;
}

/**
 * The Permissions row in Options and the notices under it that say why or that its saved value
 * could not load (#2954), as one text.
 */
function permissionsSummary(container: ParentNode): { readonly textContent: string } {
  const title = [...container.querySelectorAll(".setting-row-title")].find((node) => node.textContent === "Permissions");
  assert.ok(title, "Options has a Permissions row, always");
  return {
    // Read live, so one summary can be asserted before and after a choice.
    get textContent() {
      const row = [...container.querySelectorAll(".setting-row-title")]
        .find((node) => node.textContent === "Permissions")?.closest(".setting-row");
      const notices = [...container.querySelectorAll(".session-options-body > .notice")];
      return [row?.textContent ?? "", ...notices.map((notice) => notice.textContent)].join(" ");
    },
  };
}

/** The Options disclosure's head button (#2954). */
function optionsHead(container: HTMLDivElement): HTMLButtonElement {
  const head = container.querySelector<HTMLButtonElement>(".session-options-head");
  assert.ok(head, "New Session renders one Options row");
  return head;
}

/** The Orchestrator Policy row's Customize… (#2955), or null while there is no policy to show. */
function customizeButton(container: ParentNode): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('button[data-validation-target="orchestrator-policy"]');
}

/** The Orchestrator Policy row under Role (#2955). */
function policyRow(container: ParentNode): HTMLElement {
  const button = customizeButton(container);
  assert.ok(button, "an Orchestrator shows its policy row with Customize…");
  return settingRowOf(button);
}

/** The open Orchestrator Policy dialog (#2955). */
function policyDialog(container: ParentNode): HTMLElement {
  const dialog = [...container.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((candidate) => candidate.querySelector(".modal-title")?.textContent === "Orchestrator Policy");
  assert.ok(dialog, "Orchestrator Policy is open");
  return dialog;
}

const POLICY_TABS = { behavior: "Behavior", permissions: "Permissions", decisions: "Decisions" } as const;

/** Customize… opens Orchestrator Policy, on `tab` when given. */
async function openPolicy(container: HTMLDivElement, tab?: keyof typeof POLICY_TABS): Promise<HTMLElement> {
  const button = customizeButton(container);
  assert.ok(button, "Customize… is rendered");
  await act(async () => { button.click(); });
  const dialog = policyDialog(container);
  if (tab) await choosePolicyTab(container, tab);
  return dialog;
}

async function choosePolicyTab(container: HTMLDivElement, tab: keyof typeof POLICY_TABS): Promise<void> {
  const button = [...policyDialog(container).querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((candidate) => candidate.firstChild?.textContent === POLICY_TABS[tab]);
  assert.ok(button, `Orchestrator Policy has a ${POLICY_TABS[tab]} tab`);
  await act(async () => { button.click(); });
}

async function applyPolicy(container: HTMLDivElement): Promise<void> {
  const apply = buttonNamed(policyDialog(container), "Apply Policy");
  assert.equal(apply.disabled, false, "Apply Policy is enabled");
  await act(async () => { apply.click(); });
}

/** Opens Orchestrator Policy, lets `edit` change it, and applies it. */
async function editPolicy(container: HTMLDivElement, tab: keyof typeof POLICY_TABS, edit: (dialog: HTMLElement) => Promise<void>): Promise<void> {
  const dialog = await openPolicy(container, tab);
  await edit(dialog);
  await applyPolicy(container);
}

/** Custom or Full Control, chosen on Orchestrator Policy's Decisions tab and applied (#2955). */
async function chooseControlMode(container: HTMLDivElement, mode: "Custom" | "Full Control"): Promise<void> {
  await editPolicy(container, "decisions", (dialog) => chooseSegment(dialog, "Orchestrator Control", mode));
}

/** A segmented row's option by group and label, such as Strict Project Isolation's On. */
function segment(scope: ParentNode, group: string, label: string): HTMLButtonElement {
  const option = radioRows(scope.querySelector(`[role="radiogroup"][aria-label="${group}"]`) ?? scope)
    .find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(option, `${group} offers ${label}`);
  return option;
}

async function chooseSegment(scope: ParentNode, group: string, label: string): Promise<void> {
  const option = segment(scope, group, label);
  await act(async () => { option.click(); });
}

/** The number field a setting row names by its title, as Maximum Concurrent Children is. */
function rowNumberInput(scope: ParentNode, title: string): HTMLInputElement | null {
  return [...scope.querySelectorAll<HTMLInputElement>(".setting-row-number input")]
    .find((input) => ariaReferencedText(input, "aria-labelledby") === title) ?? null;
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
        const focused = await pressCreateAndHear(fixture, /Wait for your Orchestrator defaults to finish loading\./, "policy loading");
        assert.ok(focused.closest('[role="radiogroup"][aria-label="Role"]'), "Role answers while nothing else can");
        assert.equal(focused.closest('[role="radiogroup"]')?.getAttribute("aria-invalid"), "true");
      } finally { await unmountFixture(fixture); }
    } },
    { label: "Orchestrator policy failed to load", run: async () => {
      const fixture = await mountFixture({ runners: [orchestratorRunner] }, undefined, undefined, undefined, undefined,
        async () => { throw new Error("Policy service unavailable."); });
      try {
        await act(async () => { await selectProject(fixture.container, project.id); });
        await choosePermissionPreset(fixture.container, "Orchestrator");
        // The raw error never reaches the person (#2955): one sentence in user words, then Retry.
        const focused = await pressCreateAndHear(fixture, /Couldn't load your Orchestrator defaults\./, "policy failed");
        assert.equal(focused.textContent, "Retry");
        assert.doesNotMatch(fixture.container.textContent ?? "", /Policy service unavailable/);
        assert.ok(focused.closest(".notice.t-danger"), "a compact danger notice holds Retry");
      } finally { await unmountFixture(fixture); }
    } },
    { label: "saved permission defaults still loading", run: async () => {
      const fixture = await mountFixture({}, undefined, undefined, () => new Promise<AgentHarnessDefaultsView>(() => {}));
      try {
        await act(async () => { await selectProject(fixture.container, project.id); });
        const focused = await pressCreateAndHear(fixture, /Wait for saved permission defaults to finish loading\./, "defaults loading");
        assert.ok(focused.closest('[role="radiogroup"][aria-label="Role"]'));
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
        const focused = await pressCreateAndHear(fixture, /The saved default account isn't on this machine anymore\. Choose an account, or change the default in Machine Settings\./, "account");
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
    const target = fixture.container.querySelector<HTMLButtonElement>('button[aria-label^="Run On:"]');
    assert.ok(target);
    await act(async () => { target.click(); });
    const cloud = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="Run On"] [role="option"]')]
      .find((option) => option.textContent?.includes("Cloud Sandbox"));
    assert.ok(cloud);
    await act(async () => { cloud.click(); });
    const budget = fixture.container.querySelector<HTMLInputElement>('input[type="number"][step="0.01"]');
    assert.ok(budget);
    assert.equal(budget.getAttribute("aria-invalid"), null);
    assert.ok(budget.closest(".input-affix.w-xs"), "the budget is a 96px field");
    assert.equal(budget.parentElement?.querySelector(".input-affix-text")?.textContent, "USD", "with its unit inside it");
    assert.match(settingRowOf(budget).textContent ?? "", /Stops the session at this amount\. Between \$1 and \$20/);
    // 0 is out of range: the field says so as soon as it holds it.
    await act(async () => { fireDomEvent.change(budget, { target: { value: "0" } }); });
    assert.equal(budget.getAttribute("aria-invalid"), "true");
    assert.match(ariaReferencedText(budget, "aria-describedby") ?? "", /^Enter an amount from \$1 to \$20\./);
    await act(async () => { fireDomEvent.change(budget, { target: { value: "50" } }); });

    // Pressed with Options closed, Create Session opens them and lands on the budget. (A cloud
    // target opened them by itself: its notice says the machine's skills can't be used there.)
    assert.equal(optionsHead(fixture.container).getAttribute("aria-expanded"), "true");
    await act(async () => { optionsHead(fixture.container).click(); });
    assert.equal(optionsHead(fixture.container).getAttribute("aria-expanded"), "false");
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 0);
    assert.equal(optionsHead(fixture.container).getAttribute("aria-expanded"), "true");
    assert.equal((domWindow.document.activeElement as unknown) === budget, true, "validation lands on the budget");
    assert.equal(budget.getAttribute("aria-invalid"), "true");
    assert.equal(ariaReferencedText(budget, "aria-describedby"), "Enter an amount from $1 to $20. Stops the session at this amount. Between $1 and $20, at about $2 an hour.");
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
    // #2965: the trigger's name is the title; the one-line description says where the project goes.
    assert.equal(dialogs[1]!.querySelector(".modal-title")?.textContent, "New Project");
    assert.equal(dialogs[1]!.querySelector(".modal-desc")?.textContent, "It's selected for this session once it's created.");
    assert.deepEqual([...dialogs[1]!.querySelectorAll(".modal-foot button")].map((button) => button.textContent?.trim()),
      ["Cancel", "Create Project"]);

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
    protocolVersion: PROTOCOL_VERSION,
  };
  const fixture = await mountFixture({ runners: [agentRunner] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const input = combobox(fixture.container, "Agent");
    assert.equal(input.value, "Claude Code", "the first usable Agent is selected initially");
    assertNoDomNode(fixture.container.querySelector('select[aria-label="Agent"]'));

    await act(async () => { input.focus(); });
    assert.equal(input.getAttribute("aria-expanded"), "true");
    assert.equal(choiceOptions(fixture.container, "Agent").length, 2, "Claude Code and Codex App Server only (#3259)");

    await act(async () => { setComboboxQuery(input, "non-interactive"); });
    assert.equal(choiceOptions(fixture.container, "Agent").length, 0);

    await act(async () => { setComboboxQuery(input, "sign in"); });
    const unavailable = choiceOptions(fixture.container, "Agent");
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0]?.getAttribute("aria-disabled"), "true");
    assert.match(unavailable[0]?.textContent ?? "", /Codex App Server.*Sign in before the session can start\./);
    await act(async () => { pressComboboxKey(input, "Enter"); });
    assert.match(input.value, /sign in/,
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
  domWindow.localStorage.clear();
  const agentRunner: RunnerView = {
    ...runner,
    agents: [
      ...runner.agents,
      { id: "codex-app", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: false },
    ],
    protocolVersion: PROTOCOL_VERSION,
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
    const agentOptions = choiceOptions(fixture.container, "Agent");
    // A ready agent with nothing that changes the choice has no second line; one that needs setup
    // is described by its fix (#2953).
    assert.deepEqual(optionNamesAndDescriptions(agentOptions), [
      { name: "Claude Code", description: null },
      { name: "Codex App Server", description: "Not installed on runner-1." },
    ]);
    assert.equal(agentOptions[1]?.getAttribute("aria-disabled"), "true");
    for (const option of agentOptions) assert.equal(option.getAttribute("aria-label"), null);
  } finally {
    await unmountFixture(fixture);
  }
});

test("Extra Folders are checkbox rows in Options without changing the request (#2954)", async () => {
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
    const group = fixture.container.querySelector('[role="group"][aria-label="Extra Folders"]');
    assert.ok(group);
    const row = settingRowOf(group);
    assert.equal(row.querySelector(".setting-row-title")?.textContent, "Extra Folders (Preview)");
    assert.equal(row.querySelector(".setting-row-desc")?.textContent, "Also let this agent use these folders, for this session only.");
    const option = group.querySelector('input[type="checkbox"]')?.closest("label");
    assert.ok(option);
    assert.equal(option.querySelector(".checkbox-label")?.textContent, grant, "each folder is its whole path");
    assert.ok(option.matches(".session-options-folder"), "drawn in the mono face");
    assert.equal(option.querySelector("input")?.checked, false);

    await act(async () => { option.click(); });
    assert.equal(option.querySelector("input")?.checked, true);
    await act(async () => { createButton(fixture.container).click(); });
    assert.deepEqual(fixture.requests[0]?.acpSessionContext, { additionalDirectories: [grant] });
  } finally {
    await unmountFixture(fixture);
  }
});

test("a saved default this machine can't start is an error under Agent naming it and the machine (#2953)", async () => {
  domWindow.localStorage.clear();
  saveAgentDefault({}, runner.runnerId, "codex-app");
  const recoveryRunner: RunnerView = {
    ...runner,
    agents: [
      ...runner.agents,
      { id: "codex-app", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: false },
    ],
    protocolVersion: PROTOCOL_VERSION,
  };
  const unavailableFixture = await mountFixture({ runners: [recoveryRunner] });
  try {
    await act(async () => { await selectProject(unavailableFixture.container, project.id); });
    const input = combobox(unavailableFixture.container, "Agent");
    assert.equal(fieldErrorText(unavailableFixture.container),
      "Codex App Server isn't installed on runner-1. Choose another agent, or set it up in Connections.");
    assert.equal(input.getAttribute("aria-invalid"), "true");
    assert.match(ariaReferencedText(input, "aria-describedby") ?? "", /isn't installed on runner-1/);
    assert.equal(createButton(unavailableFixture.container).disabled, true);
    assert.equal(footerReason(unavailableFixture.container), "Choose an installed agent to continue.");
    assertNoDomNode(unavailableFixture.container.querySelector(".agent-default-warning"));
    assertNoDomNode(unavailableFixture.container.querySelector(".agent-meta"));

    await act(async () => { input.focus(); });
    const claude = choiceOptions(unavailableFixture.container, "Agent")
      .find((option) => option.textContent?.startsWith("Claude Code"));
    assert.ok(claude);
    await act(async () => { claude.click(); });
    assertNoDomNode(unavailableFixture.container.querySelector(".modal-body .field-error"),
      "choosing an agent that can start clears the error");
    const saved = loadAgentDefaults()[runner.runnerId];
    assert.equal(typeof saved === "string" ? saved : saved?.agentId, "claude");
  } finally {
    await unmountFixture(unavailableFixture);
    domWindow.localStorage.clear();
  }

  // A saved installation this machine no longer lists is named by its harness.
  saveAgentDefault({}, runner.runnerId, "claude-old", undefined, {
    id: "claude-old", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code",
    installation: { id: "installation-old", path: "/opt/claude-old", via: "path" },
  });
  const missingFixture = await mountFixture({ runners: [{ ...runner, protocolVersion: PROTOCOL_VERSION }] });
  try {
    await act(async () => { await selectProject(missingFixture.container, project.id); });
    assert.equal(combobox(missingFixture.container, "Agent").value, "", "nothing is chosen for the person");
    assert.equal(fieldErrorText(missingFixture.container),
      "Claude Code isn't installed on runner-1. Choose another agent, or set it up in Connections.");
    assert.equal(footerReason(missingFixture.container), "Choose an installed agent to continue.");
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
    const warning = fixture.container.querySelector(".modal-body .field-warn");
    assert.match(warning?.textContent ?? "", /non-interactive mode, which is no longer supported/);
    assert.match(ariaReferencedText(input, "aria-describedby") ?? "", /non-interactive mode/,
      "Agent is described by the warning's words");
    assert.doesNotMatch(ariaReferencedText(input, "aria-describedby") ?? "", /Use Codex App Server/,
      "the fix's button is not part of the description");

    await act(async () => { input.focus(); });
    assert.deepEqual(choiceOptions(fixture.container, "Agent").map((option) => option.textContent?.match(/^Codex App Server|^Claude Code/)?.[0]),
      ["Claude Code", "Codex App Server"]);
    assert.doesNotMatch(comboboxOptions(fixture.container, "Agent").map((option) => option.textContent).join(" "), /Non-Interactive/);

    const action = [...(warning?.querySelectorAll("button.btn.sm") ?? [])].find((button) =>
      button.textContent?.trim() === "Use Codex App Server") as HTMLButtonElement | undefined;
    assert.ok(action, "the warning's one action selects Codex App Server");
    await act(async () => { action.click(); });
    assert.equal(input.value, "Codex App Server");
    const saved = loadAgentDefaults()[runner.runnerId];
    assert.equal(typeof saved === "string" ? saved : saved?.agentId, "codex-app");
    assertNoDomNode(fixture.container.querySelector(".modal-body .field-warn"));
    assert.equal(createButton(fixture.container).disabled, false);
  } finally {
    await unmountFixture(fixture);
    domWindow.localStorage.clear();
  }
});

test("Codex App Server that failed its check needs setup with a plain reason, not an exec fallback (#3224, #2953)", async () => {
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
    protocolVersion: PROTOCOL_VERSION,
  };
  const fixture = await mountFixture({ runners: [codexOnly] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const input = combobox(fixture.container, "Agent");
    assert.equal(input.value, "");
    await act(async () => { input.focus(); });
    const options = choiceOptions(fixture.container, "Agent");
    assert.deepEqual(optionNamesAndDescriptions(options), [{
      name: "Codex App Server",
      description: "Wollipog couldn't check it on runner-1. Check it again in Connections.",
    }]);
    assert.equal(options[0]?.getAttribute("aria-disabled"), "true");
    await assertCreateRefused(fixture);
  } finally {
    await unmountFixture(fixture);
  }
});

/** An Agent list's groups as they read: each section label and the names of its options. */
function agentGroups(listbox: Element): Array<{ label: string; options: string[] }> {
  return [...listbox.querySelectorAll('[role="group"]')].map((group) => ({
    label: ariaReferencedText(group as HTMLElement, "aria-labelledby") ?? "",
    options: [...group.querySelectorAll<HTMLElement>('[role="option"]')]
      .map((option) => ariaReferencedText(option, "aria-labelledby") ?? ""),
  }));
}

/** Three agents that can start and two that need setup, with Pi saved as this machine's default. */
const setupRunner: RunnerView = {
  ...runner,
  protocolVersion: PROTOCOL_VERSION,
  agents: [
    ...runner.agents,
    { id: "codex-app", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: true },
    {
      id: "pi", name: "Pi", command: "pi", args: [], env: {}, driver: "pi", available: true,
      capabilities: {
        models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: false, permissionModes: [],
      },
    },
    { id: "gemini", name: "Gemini", command: "gemini", args: [], env: {}, driver: "acp", available: false },
    { id: "opencode", name: "OpenCode", command: "opencode", args: [], env: {}, driver: "acp", available: false, authStatus: "unauthenticated" },
  ],
};
const SETUP_GROUPS = [
  { label: "Ready on runner-1", options: ["Pi RPC", "Claude Code", "Codex App Server"] },
  { label: "Needs Setup", options: ["Gemini", "OpenCode"] },
];

test("Agent waits for a location: disabled, says so, and opens by neither click nor keyboard (#2953)", async () => {
  domWindow.localStorage.clear();
  const fixture = await mountFixture({ runners: [setupRunner] });
  try {
    const input = combobox(fixture.container, "Agent");
    assert.equal(input.getAttribute("aria-disabled"), "true");
    assert.equal(input.placeholder, "Choose a Location First");
    assert.equal(input.value, "");
    await act(async () => { input.click(); });
    await act(async () => { input.focus(); pressComboboxKey(input, "ArrowDown"); });
    await act(async () => {
      input.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }) as never);
    });
    await act(async () => { setComboboxQuery(input, "claude"); });
    assert.equal(input.getAttribute("aria-expanded"), "false");
    assertNoDomNode(fixture.container.querySelector('[role="listbox"][aria-label="Agent Options"]'));

    await act(async () => { await selectProject(fixture.container, project.id); });
    assert.equal(input.getAttribute("aria-disabled"), null, "a chosen location enables Agent");
    assert.equal(input.value, "Claude Code");
  } finally {
    await unmountFixture(fixture);
  }

  const restoreMatchMedia = setTouchChoicePicker(true);
  try {
    const touch = await mountFixture({ runners: [setupRunner] });
    try {
      const trigger = touch.container.querySelector<HTMLButtonElement>('button[aria-label^="Agent:"]');
      assert.ok(trigger);
      assert.equal(trigger.getAttribute("aria-disabled"), "true");
      assert.match(trigger.textContent ?? "", /Choose a Location First/);
      await act(async () => { trigger.click(); });
      await act(async () => {
        trigger.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }) as never);
      });
      assertNoDomNode(touch.container.querySelector('[role="listbox"][aria-label="Agent"]'));
    } finally {
      await unmountFixture(touch);
    }
  } finally {
    restoreMatchMedia();
  }

  // A chosen location whose machine is offline asks for an online one.
  const offline = await mountFixture(
    { runners: [{ ...setupRunner, status: "offline" }] },
    { projectId: project.id, projectLocationId: "location-1" },
  );
  try {
    const input = combobox(offline.container, "Agent");
    assert.equal(input.getAttribute("aria-disabled"), "true");
    assert.equal(input.placeholder, "Choose an Online Location First");
  } finally {
    await unmountFixture(offline);
  }
});

test("Agent lists Ready on the machine first, led by the saved default, then Needs Setup with each fix (#2953)", async () => {
  domWindow.localStorage.clear();
  saveAgentDefault({}, runner.runnerId, "pi");
  const fixture = await mountFixture({ runners: [setupRunner] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const input = combobox(fixture.container, "Agent");
    assert.equal(input.value, "Pi RPC", "the saved default is chosen");
    await act(async () => { input.focus(); });
    const listbox = fixture.container.querySelector('[role="listbox"][aria-label="Agent Options"]');
    assert.ok(listbox);
    assert.deepEqual(agentGroups(listbox), SETUP_GROUPS);
    const options = choiceOptions(fixture.container, "Agent");
    assert.deepEqual(optionNamesAndDescriptions(options), [
      { name: "Pi RPC", description: "Your default on this machine · No approval cards" },
      { name: "Claude Code", description: null },
      { name: "Codex App Server", description: null },
      { name: "Gemini", description: "Not installed on runner-1." },
      { name: "OpenCode", description: "Sign in before the session can start." },
    ]);
    // The reasons are visible text, not only accessible descriptions.
    assert.match(options[3]!.textContent ?? "", /Not installed on runner-1\./);
    assert.deepEqual(options.map((option) => option.getAttribute("aria-disabled")), [null, null, null, "true", "true"]);
    const footer = comboboxOptions(fixture.container, "Agent").at(-1)!;
    assert.equal(footer.textContent, "Set Up Agents in Connections", "the footer action is the list's last row");

    const active = () => input.getAttribute("aria-activedescendant");
    for (let step = 0; step < 3; step += 1) await act(async () => { pressComboboxKey(input, "ArrowDown"); });
    assert.equal(active(), options[3]!.id, "the arrows reach a Needs Setup option");
    await act(async () => { pressComboboxKey(input, "Enter"); });
    assert.equal(input.getAttribute("aria-expanded"), "true", "Enter does not choose it");
    await act(async () => { pressComboboxKey(input, "ArrowDown"); });
    assert.equal(active(), options[4]!.id);
    await act(async () => { pressComboboxKey(input, "Enter"); });
    await act(async () => { pressComboboxKey(input, "Escape"); });
    assert.equal(input.value, "Pi RPC");
    const saved = loadAgentDefaults()[runner.runnerId];
    assert.equal(typeof saved === "string" ? saved : saved?.agentId, "pi", "nothing unavailable was saved");
  } finally {
    await unmountFixture(fixture);
    domWindow.localStorage.clear();
  }
});

test("on a coarse pointer the Agent sheet shows the same groups, and arrows reach what Enter refuses (#2953)", async () => {
  domWindow.localStorage.clear();
  saveAgentDefault({}, runner.runnerId, "pi");
  const restoreMatchMedia = setTouchChoicePicker(true);
  try {
    const fixture = await mountFixture({ runners: [setupRunner] }, { projectId: project.id });
    try {
      const trigger = fixture.container.querySelector<HTMLButtonElement>('button[aria-label^="Agent:"]');
      assert.ok(trigger);
      assert.equal(trigger.getAttribute("aria-label"), "Agent: Pi RPC");
      await act(async () => { trigger.click(); });
      const listbox = fixture.container.querySelector('[role="listbox"][aria-label="Agent"]');
      assert.ok(listbox);
      assert.deepEqual(agentGroups(listbox), SETUP_GROUPS);
      const rows = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
      assert.equal(rows.at(-1)?.textContent, "Set Up Agents in Connections");
      const filter = fixture.container.querySelector<HTMLInputElement>('input[role="combobox"][aria-label="Search Agent Options"]');
      assert.ok(filter);
      const press = async (key: string) => act(async () => {
        filter.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key, bubbles: true }) as never);
      });
      for (let step = 0; step < 3; step += 1) await press("ArrowDown");
      assert.equal(filter.getAttribute("aria-activedescendant"), rows[3]!.id, "the arrows reach a Needs Setup option");
      assert.equal(rows[3]!.getAttribute("aria-disabled"), "true");
      await press("Enter");
      assert.equal(trigger.getAttribute("aria-label"), "Agent: Pi RPC", "Enter does not choose it");
      assert.ok(fixture.container.querySelector('[role="listbox"][aria-label="Agent"]'), "and the sheet stays open");
    } finally {
      await unmountFixture(fixture);
    }
  } finally {
    restoreMatchMedia();
    domWindow.localStorage.clear();
  }
});

test("two installations of one agent name their folder on the second line, not in the label (#2953)", async () => {
  domWindow.localStorage.clear();
  const installed = (id: string, path: string) => ({
    id, name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code" as const, available: true,
    installation: { id, path, via: "path" as const },
  });
  const fixture = await mountFixture({ runners: [{
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    agents: [installed("system", "/usr/local/bin/claude"), installed("local", "/home/me/.local/bin/claude")],
  }] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const input = combobox(fixture.container, "Agent");
    await act(async () => { input.focus(); });
    const options = optionNamesAndDescriptions(choiceOptions(fixture.container, "Agent"));
    assert.deepEqual(options.map((option) => option.name), ["Claude Code — Native", "Claude Code — Native"]);
    assert.deepEqual(options.map((option) => option.description).sort(), ["…/.local/bin", "…/local/bin"]);
    assert.ok(options.every((option) => !option.name?.includes("/")), "no path in an option's label");
    await act(async () => { pressComboboxKey(input, "Escape"); });
    assert.match(input.value, /^Claude Code — Native · …\/\.?local\/bin$/,
      "the chosen one is told apart by its folder");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Set Up Agents in Connections closes New Session and opens the machines in Connections (#2953)", async () => {
  domWindow.localStorage.clear();
  const fixture = await mountFixture({ runners: [setupRunner] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const input = combobox(fixture.container, "Agent");
    await act(async () => { input.focus(); });
    const closesBefore = dialogCloses.count;
    navigated.length = 0;
    await act(async () => { pressComboboxKey(input, "End"); });
    const footer = comboboxOptions(fixture.container, "Agent").at(-1)!;
    assert.equal(input.getAttribute("aria-activedescendant"), footer.id, "End reaches the footer action");
    await act(async () => { pressComboboxKey(input, "Enter"); });
    assert.equal(dialogCloses.count, closesBefore + 1, "New Session is asked to close");
    assert.deepEqual(navigated, [{ name: "runners", section: "machines" }]);
  } finally {
    await unmountFixture(fixture);
  }
});

test("no agent text in New Session names the mechanism (#2953)", async () => {
  domWindow.localStorage.clear();
  const mechanism = /native host|ACP stdio|stdio|rediscover|runner host/iu;
  const fixture = await mountFixture({ runners: [{
    ...setupRunner,
    agents: [
      ...setupRunner.agents,
      {
        id: "codex-wsl", name: "Codex", command: "codex", args: [], env: {}, driver: "codex-app-server", available: false,
        context: { kind: "wsl", distro: "Ubuntu" }, authStatus: "unauthenticated",
      },
      {
        id: "registry", name: "Registry Agent", command: "npx", args: [], env: {}, driver: "acp", available: false,
        acpTransport: "stdio",
        registry: { installStatus: "approval-required", transport: "stdio", adapterVersion: "1.0.0" } as NonNullable<RunnerView["agents"][number]["registry"]>,
      },
    ],
  }] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const input = combobox(fixture.container, "Agent");
    await act(async () => { input.focus(); });
    assert.ok(comboboxOptions(fixture.container, "Agent").length > 5);
    assert.doesNotMatch(fixture.container.textContent ?? "", mechanism);
    for (const option of comboboxOptions(fixture.container, "Agent")) {
      assert.doesNotMatch(ariaReferencedText(option, "aria-describedby") ?? "", mechanism);
    }
  } finally {
    await unmountFixture(fixture);
  }
});

test("Account options read Signed In, Sign-In Required or Status Unknown, never Logged In (#2953)", async () => {
  const accountRunner: RunnerView = {
    ...runner,
    protocolVersion: PROTOCOL_VERSION,
    agents: runner.agents.map((agent) => ({ ...agent, defaultProviderAccountId: "work" })),
    providerAccounts: [
      { id: "work", label: "Work", provider: "claude", authStatus: "authenticated" },
      { id: "personal", label: "Personal", provider: "claude", authStatus: "unauthenticated" },
      { id: "spare", label: "Spare", provider: "claude", authStatus: "unknown" },
    ],
  };
  const fixture = await mountFixture({ runners: [accountRunner] }, { projectId: null });
  try {
    const trigger = fixture.container.querySelector<HTMLButtonElement>('[aria-label^="Account:"]');
    assert.ok(trigger);
    await act(async () => { trigger.click(); });
    const options = [...fixture.container.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="Account"] [role="option"]')];
    assert.deepEqual(optionNamesAndDescriptions(options), [
      { name: "Work", description: "Signed In" },
      { name: "Personal", description: "Sign-In Required · Sign in again before using it." },
      { name: "Spare", description: "Status Unknown" },
    ]);
    assert.doesNotMatch(fixture.container.textContent ?? "", /Logged In|Login Required|Login Unknown/u);
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
    assertNoDomNode(customizeButton(fixture.container), "ordinary creation does not show an orchestration-only policy");
    await choosePermissionPreset(fixture.container, "Orchestrator");
    assert.match(policyRow(fixture.container).textContent ?? "", /Up to 4 Children/,
      "the compatible effective default is visible rather than implicit");
    const dialog = await openPolicy(fixture.container);
    const limit = rowNumberInput(dialog, "Maximum Concurrent Children");
    assert.ok(limit);
    assert.equal(limit.value, "4");
    assert.equal(limit.min, "0");
    assert.equal(limit.max, "64");
    assert.equal(limit.step, "1");
    await act(async () => { fireDomEvent.change(limit, { target: { value: "9" } }); });
    await applyPolicy(fixture.container);
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.config?.permissionMode, "orchestrator");
    assert.equal(fixture.requests[0]?.orchestrator?.behavior?.maximumConcurrentChildren, 9);
  } finally { await unmountFixture(fixture); }
});

test("Maximum Concurrent Children is a 96px row field whose invalid values block Apply Policy with the reason (#2955)", async () => {
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
    const dialog = await openPolicy(fixture.container);
    const limit = rowNumberInput(dialog, "Maximum Concurrent Children");
    assert.ok(limit);
    assert.ok(limit.closest(".input-affix.w-xs"), "the limit is a 96px field in its row");
    assert.equal(ariaReferencedText(limit, "aria-describedby"), "0 pauses new children. Up to 64.");
    const apply = () => buttonNamed(policyDialog(fixture.container), "Apply Policy");

    for (const invalid of ["4.5", "-1", "65", ""]) {
      await act(async () => { fireDomEvent.change(limit, { target: { value: invalid } }); });
      assert.equal(limit.getAttribute("aria-invalid"), "true", invalid);
      // The error replaces the description (§8.5), in the row, and is what the field is described by.
      assert.equal(ariaReferencedText(limit, "aria-describedby"), "Enter a whole number from 0 to 64.", invalid);
      assert.doesNotMatch(settingRowOf(limit).textContent ?? "", /0 pauses new children/, invalid);
      assert.equal(apply().disabled, true, invalid);
      assert.equal(ariaReferencedText(apply(), "aria-describedby"), "Enter a whole number from 0 to 64.", invalid);
      assert.equal(policyDialog(fixture.container).querySelector(".modal-foot .orchestrator-policy-reason")?.textContent,
        "Enter a whole number from 0 to 64.", `${invalid}: the footer says why Apply Policy is disabled`);
    }

    await act(async () => { fireDomEvent.change(limit, { target: { value: "0" } }); });
    assert.equal(limit.getAttribute("aria-invalid"), null);
    await applyPolicy(fixture.container);
    assert.match(policyRow(fixture.container).textContent ?? "", /New Children Paused/);
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.orchestrator?.behavior?.maximumConcurrentChildren, 0,
      "zero is persisted as a deliberate pause rather than treated as empty");
  } finally { await unmountFixture(fixture); }
});

test("Decisions is Orchestrator-only, shows no source labels, and sends nothing it did not change", async () => {
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
    assertNoDomNode(customizeButton(fixture.container));
    assert.match(fixture.container.textContent ?? "", /An Orchestrator delegates work to child sessions\./);
    await choosePermissionPreset(fixture.container, "Orchestrator");
    assert.match(policyRow(fixture.container).textContent ?? "", /From your Orchestrator defaults in Settings\./);
    const dialog = await openPolicy(fixture.container, "decisions");
    const descendant = dialog.querySelector<HTMLButtonElement>('[aria-label^="Descendant Requests:"]');
    assert.match(descendant?.getAttribute("aria-label") ?? "", /Questions and Approvals/);
    assert.ok(dialog.querySelector('[role="radiogroup"][aria-label="PR Merge Approval"]'));
    assert.match(dialog.textContent ?? "", /Secrets, sign-in, permission grants, governance changes, budgets and guardrails always stay with you\./);
    for (const tab of ["behavior", "permissions", "decisions"] as const) {
      await choosePolicyTab(fixture.container, tab);
      assert.doesNotMatch(policyDialog(fixture.container).textContent ?? "", /User Default|Session Override|Wollipog Default|Compatibility Fallback/, tab);
    }
    assert.doesNotMatch(fixture.container.textContent ?? "", /User Default|Session Override/);
    await act(async () => { buttonNamed(policyDialog(fixture.container), "Cancel").click(); });
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.orchestrator?.delegation?.parentControl, undefined,
      "an inherited effective value is not sent as an explicit override");
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
    await chooseControlMode(fixture.container, "Full Control");
    await settlePreflight();
    assert.equal([...fixture.container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Create Session"), false,
      "no second create button");
    assert.equal(authorizeButton(fixture.container).disabled, true);
    await act(async () => submitWithEnter(fixture.container));
    assert.equal(fixture.requests.length, 0);
    assert.match(fixture.container.textContent ?? "", /Full Control isn't ready yet/);
    const providerPermissions = permissionsSummary(fixture.container);
    assert.match(providerPermissions.textContent!, /Orchestrator/, "effective coupled preset replaces the saved provider default");
    assert.doesNotMatch(fixture.container.textContent ?? "", /Activation Unavailable/);
    await chooseControlMode(fixture.container, "Custom");
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
    assert.match(policyRow(fixture.container).textContent ?? "", /Full Control/, "the saved preference is the policy's choice");
    assert.ok(fixture.container.querySelector('section[aria-label="Full Control Launch"]'), "and its launch summary shows");
    await settlePreflight();
    assert.equal(authorizeButton(fixture.container).disabled, true);
    await act(async () => submitWithEnter(fixture.container));
    assert.equal(fixture.requests.length, 0);
    await chooseControlMode(fixture.container, "Custom");
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
    await chooseControlMode(fixture.container, "Full Control");
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
    await chooseControlMode(fixture.container, "Full Control");
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
    const choose = (mode: string) => chooseControlMode(fixture.container, mode === "full_control" ? "Full Control" : "Custom");
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
    const limit = () => rowNumberInput(policyDialog(fixture.container), "Maximum Concurrent Children")!;
    // Custom: 0 pauses admission.
    await editPolicy(fixture.container, "behavior", async () => {
      assert.equal(limit().min, "0");
      await act(async () => { fireDomEvent.change(limit(), { target: { value: "0" } }); });
      assert.equal(limit().getAttribute("aria-invalid"), null);
    });
    // Full Control: the campaign's concurrency is this value, and a campaign cannot authorize 0.
    await openPolicy(fixture.container, "decisions");
    await chooseSegment(policyDialog(fixture.container), "Orchestrator Control", "Full Control");
    await choosePolicyTab(fixture.container, "behavior");
    assert.equal(limit().getAttribute("aria-invalid"), "true");
    assert.equal(limit().min, "1");
    assert.equal(ariaReferencedText(limit(), "aria-describedby"), "Enter a whole number from 1 to 64.");
    assert.equal(buttonNamed(policyDialog(fixture.container), "Apply Policy").disabled, true);
    await act(async () => { fireDomEvent.change(limit(), { target: { value: "6" } }); });
    assert.equal(limit().getAttribute("aria-invalid"), null);
    assert.match(ariaReferencedText(limit(), "aria-describedby") ?? "", /This is also the campaign's concurrency\./);
    await applyPolicy(fixture.container);
    await settlePreflight();
    const concurrencyLabels = [...fixture.container.querySelectorAll("label span:first-child")]
      .map((node) => node.firstChild?.textContent?.trim() ?? "").filter((text) => /Concurren/.test(text));
    assert.deepEqual(concurrencyLabels, [], "Full Control's launch has no second concurrency entry");
    const latest = preflights.at(-1)!;
    assert.equal(latest.overrides!.session!.orchestrator!.behavior!.maximumConcurrentChildren, 6);
    assert.equal(latest.overrides!.budget?.concurrency, undefined, "the server derives the budget concurrency from the one control");
    // Back to Custom: 0 is allowed again.
    await openPolicy(fixture.container, "decisions");
    await chooseSegment(policyDialog(fixture.container), "Orchestrator Control", "Custom");
    await choosePolicyTab(fixture.container, "behavior");
    await act(async () => { fireDomEvent.change(limit(), { target: { value: "0" } }); });
    assert.equal(limit().getAttribute("aria-invalid"), null);
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
    const dialog = await openPolicy(fixture.container);
    assert.match(dialog.querySelector('[aria-label^="Child Model:"]')?.getAttribute("aria-label") ?? "", /Test Model/);
    assert.equal(rowNumberInput(dialog, "Maximum Concurrent Children")?.value, "5");
    await chooseSelectOption(fixture.container, "Child Harness", "Pi · Native");
    await chooseSelectOption(fixture.container, "Child Model", "Sol");
    // A new harness starts its model and effort over: three Behavior rows differ from the defaults.
    assert.match(policyDialog(fixture.container).querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "", /^Behavior3 Changed$/);
    await choosePolicyTab(fixture.container, "decisions");
    await chooseSegment(policyDialog(fixture.container), "PR Merge Approval", "Orchestrator");
    assert.doesNotMatch(policyDialog(fixture.container).textContent ?? "", /Session Override|User Default/);
    await applyPolicy(fixture.container);
    assert.match(policyRow(fixture.container).textContent ?? "", /4 changes/);
    assert.match(policyRow(fixture.container).textContent ?? "", /1 Decision Delegated/);
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

test("a fixed Child Harness on an older runner names the machine to update, in the row and in the footer (#2955)", async () => {
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
    const sentence = "Update Wollipog on runner-1 to choose a fixed Child Harness.";
    assert.match(policyRow(fixture.container).querySelector(".field-error")?.textContent ?? "", new RegExp(sentence.replaceAll(".", "\\.")));
    assert.ok(ariaReferencedText(customizeButton(fixture.container)!, "aria-describedby")?.includes(sentence),
      "Customize… is described by the problem");
    assert.equal(createButton(fixture.container).disabled, true);
    assert.equal(footerReason(fixture.container), sentence, "the footer says why Create Session is disabled");
    const dialog = await openPolicy(fixture.container);
    const harness = dialog.querySelector<HTMLButtonElement>('[aria-label^="Child Harness:"]')!;
    assert.equal(ariaReferencedText(harness, "aria-describedby")?.startsWith(sentence), true, "the row says it too");
    assert.doesNotMatch(fixture.container.textContent!, /protocol-v|newer runner/);
    assert.doesNotMatch(fixture.container.textContent!, /saved Child Model or Child Effort is no longer advertised/i);
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
    const dialog = await openPolicy(fixture.container);
    const control = [...dialog.querySelectorAll(".setting-row")]
      .find((candidate) => candidate.querySelector(".setting-row-title")?.textContent === "Child Harness");
    assert.ok(control, "Child Harness is rendered");
    const note = control.querySelector(".setting-row-reason")?.textContent ?? "";
    assert.equal(note, "Update Wollipog to choose a fixed Child Harness.");
    assert.doesNotMatch(note, RETIRED_PROJECT_TERMS);

    // The Select is disabled in this state, so the Automatic option's description never opens and
    // the note above is what a person reads. Pin that the list stays shut, then pin the option's
    // own sentence in source, since no interaction can render it.
    const trigger = dialog.querySelector<HTMLButtonElement>('[aria-label^="Child Harness:"]');
    assert.ok(trigger, "Child Harness select is rendered");
    assert.equal(trigger.getAttribute("aria-disabled"), "true");
    await act(async () => { trigger.click(); });
    assertNoDomNode(fixture.container.querySelector('[role="listbox"][aria-label="Child Harness"]'),
      "the disabled Child Harness list does not open");
    const source = readFileSync(new URL("../orchestrator-policy.ts", import.meta.url), "utf8");
    assert.ok(source.includes(': "Update Wollipog to configure a fixed Child Harness.",'),
      "the Automatic option names Wollipog when fixed Child Harness policy is unavailable");
    assert.doesNotMatch(source, /"Update the control plane to configure a fixed Child Harness\."/);
  } finally {
    await unmountFixture(fixture);
  }
});

test("New Session copy names no runner protocol numbers", () => {
  // docs/design-system.md §17.2: refusals use the shared runner sentence; versions travel as fields.
  for (const file of ["./NewSessionDialog.tsx", "./OrchestratorPolicyDialog.tsx", "../orchestrator-policy.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /protocol-v\d|protocol v\d/i, file);
  }
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
    // A compact danger notice with Retry in the policy row's place (#2955), never the raw error.
    const notice = fixture.container.querySelector(".session-options-body .notice.t-danger");
    assert.ok(notice, "the failure is a danger notice");
    assert.ok(notice.classList.contains("compact"), "a compact one");
    assert.equal(notice.querySelector(".notice-body, span[id]")?.textContent, "Couldn't load your Orchestrator defaults.");
    assert.ok(buttonNamed(notice, "Retry"));
    assertNoDomNode(customizeButton(fixture.container), "there is no policy to customize");
    assert.doesNotMatch(notice.textContent ?? "", RETIRED_PROJECT_TERMS);
    assert.doesNotMatch(notice.textContent ?? "", /Missing|404/);
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
    await openPolicy(fixture.container);
    await chooseSelectOption(fixture.container, "Child Model", "Automatic");
    await applyPolicy(fixture.container);
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
    assert.equal(createButton(fixture.container).disabled, false,
      "an inherited authority default safely downgrades without blocking an older supported runner");
    const dialog = await openPolicy(fixture.container, "decisions");
    const descendant = dialog.querySelector<HTMLButtonElement>('[aria-label^="Descendant Requests:"]')!;
    assert.match(descendant.getAttribute("aria-label") ?? "", /Human/);
    assert.doesNotMatch(settingRowOf(descendant).textContent ?? "", /Compatibility Fallback|Changed/,
      "the downgrade is not a change this session made");
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
      assert.equal(permissionPresetCard(fixture.container, "Orchestrator")?.getAttribute("aria-checked"), "true",
        "a saved Orchestrator default selects the role without an explicit override");
      assert.match(fixture.container.textContent!, /Saved Default — Orchestrator/,
        "the saved default names itself in the Permissions row");
      const tui = radioRows(fixture.container)
        .find((button) => button.textContent?.includes("Native TUI"))!;
      assert.equal(cardRefused(tui), protocolVersion < 112);
      if (protocolVersion === 112) {
        await act(async () => { tui.click(); });
        assert.match(settingRowOf(tui).textContent!, /Native TUI opens the provider's own terminal UI\./);
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
    // A defaults load error needs attention: Options opens by itself and its head names it.
    assert.equal(optionsHead(fixture.container).getAttribute("aria-expanded"), "true");
    assert.match(permissionsSummary(fixture.container).textContent, /Couldn't load your saved permissions\./);
    await act(async () => { optionsHead(fixture.container).click(); });
    assert.match(optionsHead(fixture.container).textContent ?? "", /Permissions Not Loaded/);
    await act(async () => { submitWithEnter(fixture.container); });
    assert.equal(fixture.requests.length, 0);
    assert.equal(optionsHead(fixture.container).getAttribute("aria-expanded"), "true", "the refused submit opens Options");
    const retry = [...fixture.container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Retry")!;
    assert.ok((domWindow.document.activeElement as unknown) === retry, "focus lands on Retry");
    assert.match(ariaReferencedText(retry, "aria-describedby") ?? "", /Couldn't load your saved permissions\./);
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
    assert.match(permissionsSummary(fixture.container).textContent, /Loading…/);
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
    assert.match(permissionsSummary(fixture.container).textContent, /Couldn't load your saved permissions\./);
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
    assert.match(fixture.container.textContent ?? "", /The saved default account isn't on this machine anymore\. Choose an account, or change the default in Machine Settings\./u);
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
    await chooseSelectOption(fixture.container, "Run On", "Offline Container");
    assertNoDomNode(fixture.container.querySelector('[aria-label^="Account:"]'));
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.executionTargetId, "container");
    assert.equal(fixture.requests[0]?.providerAccountId, undefined);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a container target opens Options, names the skills it can't see under Run On, and marks the head (#2954)", async () => {
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
  const skillRequests: string[] = [];
  const fixture = await mountFixture({ runners: [targetRunner] }, { projectId: null }, undefined, undefined, undefined, undefined, {
    runnerSkills: async (runnerId: string) => {
      skillRequests.push(runnerId);
      return {
        desired: [
          { name: "review", versionDigest: "a", targets: [{ agentId: "claude" }] },
          { name: "deploy", versionDigest: "b", targets: [{ agentId: "claude" }] },
          { name: "elsewhere", versionDigest: "c", targets: [{ agentId: "codex" }] },
        ],
        reported: null,
      } as never;
    },
  });
  const notice = () => fixture.container.querySelector<HTMLElement>('[aria-label="Skills Unavailable"]');
  try {
    assert.equal(optionsHead(fixture.container).getAttribute("aria-expanded"), "false", "defaults keep Options closed");
    assertNoDomNode(notice());
    assert.deepEqual(skillRequests, [], "a host target never asks for the machine's skills");
    await chooseSelectOption(fixture.container, "Run On", "Offline Container");
    await act(async () => { await Promise.resolve(); });
    assert.equal(optionsHead(fixture.container).getAttribute("aria-expanded"), "true", "Options opens by itself");
    const shown = notice();
    assert.ok(shown, "the session view's skills notice shows before creation");
    assert.equal(shown.textContent?.includes("Skills from runner-1 aren’t available in container sessions, so deploy and review can’t be used here."), true);
    const runOn = fixture.container.querySelector('button[aria-label^="Run On:"]')!;
    assert.ok(settingRowOf(runOn).nextElementSibling?.contains(shown), "the notice sits directly under Run On");
    assert.doesNotMatch(fixture.container.textContent ?? "", SKILLS_UNAVAILABLE, "the muted line is gone");
    await act(async () => { optionsHead(fixture.container).click(); });
    const warning = optionsHead(fixture.container).querySelector(".status.t-warning");
    assert.equal(warning?.textContent, "Skills Unavailable", "the closed head names it in the warning tone");
    await act(async () => { optionsHead(fixture.container).click(); });
    await chooseSelectOption(fixture.container, "Run On", "Runner Host · worktree");
    assertNoDomNode(notice());
    await act(async () => { optionsHead(fixture.container).click(); });
    assertNoDomNode(optionsHead(fixture.container).querySelector(".status.t-warning"));
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
    const description = () => settingRowOf(harness).querySelector(".setting-row-desc")?.textContent;
    assert.equal(description(), "Direct gives structured chat, approval cards and usage tracking.");
    const native = radioRows(harness)
      .find((button) => button.textContent?.includes("Native TUI"));
    assert.ok(native);
    // `cardRefused`, not `.disabled`: the segmented option never sets the DOM property, so asserting
    // it is `false` would pass even for a refused option. The click below only means something if
    // the option is genuinely selectable.
    assert.equal(cardRefused(native), false);

    await act(async () => { native.click(); });
    assert.equal(description(),
      "Native TUI opens the provider's own terminal UI. It doesn't track usage or show approval cards, so sessions with budgets must use Direct.");
    assert.doesNotMatch(fixture.container.textContent ?? "", /Usage Accounting: Unavailable/);
    await act(async () => { createButton(fixture.container).click(); });

    assert.equal(fixture.requests[0]?.launchSurface, "native_tui");
    assert.equal(fixture.terminalOpens.count, 1);
  } finally {
    await unmountFixture(fixture);
  }
});

test("Native TUI says one sentence, without the accounting paragraph, whatever the runner reports (#2954)", async () => {
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
      .find((button) => button.textContent?.includes("Native TUI"));
    assert.ok(native);
    await act(async () => { native.click(); });
    assert.match(settingRowOf(native).textContent ?? "", /Native TUI opens the provider's own terminal UI\./);
    for (const retired of [/Provider Contract/, /Usage Accounting/, /Manager policy hook status/, /remaining-budget calculations/]) {
      assert.doesNotMatch(fixture.container.textContent ?? "", retired);
    }
  } finally {
    await unmountFixture(fixture);
  }
});

test("Native TUI is disabled when the control plane does not advertise atomic launch", async () => {
  const fixture = await mountFixture();
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const native = radioRows(fixture.container)
      .find((button) => button.textContent?.includes("Native TUI"));
    assert.ok(native);
    assert.equal(cardRefused(native), true);
    // The reason replaces the row's description, and the refused option is described by it, so a
    // sentence elsewhere in the dialog cannot satisfy this while the control explains nothing.
    const reason = settingRowOf(native).querySelector(".setting-row-desc")?.textContent ?? "";
    assert.equal(reason, "Native TUI launch requires a newer version of Wollipog. Update Wollipog to use it.");
    assert.equal(ariaReferencedText(native, "aria-describedby"), reason);
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
      .find((button) => button.textContent?.includes("Native TUI"));
    assert.ok(native);
    assert.equal(cardRefused(native), true);
    // The start-fence hint is the refused option's own reason, in its row's description.
    assert.match(settingRowOf(native).textContent ?? "", /This machine needs a newer runner for initial Native TUI launch\. Update and restart the runner\./);
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
      .find((button) => button.textContent?.includes("Native TUI"));
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
      .find((button) => button.textContent?.includes("Native TUI"));
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
      .find((button) => button.textContent?.includes("Native TUI"));
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
    assert.match(settingRowOf(orchestrator).textContent ?? "", /runner is too old to orchestrate child sessions/);
    assert.doesNotMatch(settingRowOf(orchestrator).textContent ?? "", /doesn't offer the Orchestrator role/,
      "an old runner cannot establish whether its missing capability is agent-specific");

    // Disabled, not merely styled: clicking must not select it, and the reason must be readable
    // rather than living in a `title` a touch user cannot reach.
    await act(async () => { orchestrator.click(); });
    assert.equal(orchestrator.getAttribute("aria-checked"), "false");
    assert.equal(ariaReferencedText(orchestrator, "aria-describedby"),
      settingRowOf(orchestrator).querySelector(".setting-row-desc")?.textContent,
      "its reason replaces the row's description, and arrowing onto it says the same");
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
    assert.equal(orchestrator.getAttribute("aria-disabled"), "true");
    assert.match(settingRowOf(orchestrator).textContent ?? "", /Upgrade Codex to 0\.154\.0 or newer/);
    assert.match(settingRowOf(orchestrator).textContent ?? "", /verified Direct WSL bridge and a bubblewrap-isolated runner/);
    await act(async () => { orchestrator.click(); });
    assert.equal(orchestrator.getAttribute("aria-checked"), "false", "mixed constraints remain fail closed");
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
    for (const label of ["Role", "Harness", "Working Copy"]) {
      const group = fixture.container.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
      assert.ok(group, `${label} is a labelled radiogroup`);
      assert.ok(group.matches(".seg.block"), `${label} is the shared full-width segmented control`);
      assert.equal(settingRowOf(group).querySelector(".setting-row-title")?.textContent, label,
        `${label}'s visible title is its accessible name`);
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
    const providerPermissions = permissionsSummary(fixture.container);
    assert.ok(providerPermissions, "Provider Permissions is an independent, always-visible control");
    assert.match(providerPermissions.textContent!, /Saved Default — Auto-?Accept Edits/i);
    await choosePermissionPreset(fixture.container, "Orchestrator");
    assert.match(providerPermissions.textContent!, /Saved Default — Auto-?Accept Edits/i,
      "selecting Orchestrator does not consume the provider permission-mode selection");
    assert.match(providerPermissions.textContent!, /An Orchestrator keeps them and its integrations/);
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
    const providerPermissions = permissionsSummary(strict.container);
    assert.match(providerPermissions.textContent!, /Orchestrator Preset/);
    assert.match(providerPermissions.textContent!, /Strict Project Isolation is enforced/,
      "the preset is disclosed with the policy that selects it rather than inferred from the role");
  } finally { await unmountFixture(strict); }

  const legacyControlPlane = await mountFixture({ runners: [claudeRunner] }, undefined, undefined, savedAcceptEdits);
  try {
    await act(async () => { await selectProject(legacyControlPlane.container, project.id); });
    await choosePermissionPreset(legacyControlPlane.container, "Orchestrator");
    const providerPermissions = permissionsSummary(legacyControlPlane.container);
    assert.match(providerPermissions.textContent!, /can't give an Orchestrator normal permissions, so the preset sets them\. Update Wollipog to change that\./);
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
    const providerPermissions = permissionsSummary(fixture.container);
    const normalSummary = providerPermissions.textContent!;
    assert.match(normalSummary, /Saved Default —/);
    await choosePermissionPreset(fixture.container, "Orchestrator");
    assert.match(providerPermissions.textContent!, /Saved Default —/,
      "a non-strict Codex Orchestrator shows the saved harness default");
    assert.match(providerPermissions.textContent!, /An Orchestrator keeps them and its integrations/);
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
    const providerPermissions = permissionsSummary(strict.container);
    assert.match(providerPermissions.textContent!, /Orchestrator Preset/);
    assert.match(providerPermissions.textContent!, /Strict Project Isolation is enforced/);
  } finally { await unmountFixture(strict); }

  const outdatedRunner = await mountFixture({
    runners: [{ ...codexRunner, protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.orchestratorAdditiveCodex - 1 }],
    capabilities: { sessionSubscriptions: false, projects: true, orchestratorRole: true },
  }, undefined, undefined, savedReadOnly);
  try {
    await act(async () => { await selectProject(outdatedRunner.container, project.id); });
    await choosePermissionPreset(outdatedRunner.container, "Orchestrator");
    const providerPermissions = permissionsSummary(outdatedRunner.container);
    assert.match(providerPermissions.textContent!, /Orchestrator Preset/);
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
    assert.equal(permissionPresetCard(fixture.container, "Orchestrator")?.getAttribute("aria-disabled"), null,
      "the role is offered wherever the runner advertises the additive launch");
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const providerPermissions = permissionsSummary(fixture.container);
    assert.doesNotMatch(providerPermissions.textContent!, /Orchestrator Preset/,
      "the launch keeps the permission mode a normal Codex session would use here");
    assert.match(providerPermissions.textContent!, /An Orchestrator keeps them and its integrations/);
    assertNoDomNode(policyRow(fixture.container).querySelector(".field-error"),
      "no platform reason is stated, because the additive launch has no platform condition");
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
    assert.match(policyRow(strict.container).textContent ?? "", /This agent can't run with Strict Project Isolation\. To start now, turn it off\./);
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
    assert.match(permissionsSummary(legacy.container).textContent, /Update Wollipog to change that\./);
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
    assert.equal(permissionPresetCard(fixture.container, "Orchestrator")?.getAttribute("aria-checked"), "true");
    assert.match(fixture.container.textContent!, /Choose Normal to ignore it for this session/);
    await choosePermissionPreset(fixture.container, "Normal");
    assert.equal(permissionPresetCard(fixture.container, "Normal")?.getAttribute("aria-checked"), "true");
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
    assert.match(policyRow(strict.container).textContent!, /This agent can't run with Strict Project Isolation\. To start now, turn it off\./);
    // The dialog names it under the row it is about.
    const dialog = await openPolicy(strict.container);
    assert.equal(dialog.querySelector('[role="tab"][aria-selected="true"]')?.firstChild?.textContent, "Permissions",
      "Customize… opens on the tab with the problem");
    assert.match(settingRowOf(segment(dialog, "Strict Project Isolation", "On")).textContent ?? "", /This agent can't run with Strict Project Isolation/);
    await act(async () => { buttonNamed(dialog, "Cancel").click(); });
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
    assert.match(settingRowOf(permissionPresetCard(fixture.container, "Orchestrator")!).textContent!, /Pi RPC doesn't offer the Orchestrator role\./,
      "the reason names the agent and replaces the row's description");
  } finally { await unmountFixture(fixture); }
});

test("Integration Isolation is an independent control that discloses what it removes", async () => {
  const fixture = await mountFixture({ runners: [piAdditiveRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const dialog = await openPolicy(fixture.container, "permissions");
    // Off by default, and About Integration Isolation says integrations load as for a normal session.
    const about = () => policyDialog(fixture.container).querySelector("details.orchestrator-about")?.textContent ?? "";
    assert.match(about(), /^About Integration Isolation/);
    assert.match(about(), /Hooks, plugins, extensions, skills, and configured MCP servers load exactly as they would/);
    await chooseSegment(dialog, "Integration Isolation", "On");
    // The row says what it does in one sentence; the full explanation is behind About.
    assert.equal(settingRowOf(segment(dialog, "Integration Isolation", "On")).querySelector(".setting-row-desc")?.textContent,
      "The Orchestrator gets Wollipog's management tools and no other integration.");
    // The copy follows the SELECTED agent's harness, because the policy genuinely differs by
    // harness. This fixture is Pi.
    assert.match(about(), /Removes discovered extensions, skills, prompt templates, and ambient context files/);
    assert.doesNotMatch(about(), /cannot drop hooks/, "the Claude-specific caveat must not be shown for a Pi launch");
    assert.match(about(),
      /provider permission mode, built-in tool inventory, sandbox and approval behavior, and the project boundary are unchanged/);
    await applyPolicy(fixture.container);
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
    await editPolicy(fixture.container, "permissions", async (dialog) => {
      await chooseSegment(dialog, "Integration Isolation", "On");
      const group = dialog.querySelector('[role="radiogroup"][aria-label="Integration Isolation"]')!;
      assert.equal(group.getAttribute("aria-invalid"), "true");
      assert.match(ariaReferencedText(group as HTMLElement, "aria-describedby") ?? "",
        /^Update Wollipog on .+ to turn on Integration Isolation\. To start now, turn it off\.$/);
    });
    assert.match(policyRow(fixture.container).textContent ?? "", /Update Wollipog on .+ to turn on Integration Isolation\./);
    assert.doesNotMatch(fixture.container.textContent!, /protocol-v|newer runner/);
    await assertCreateRefused(fixture,
      "the dialog never advertises a shape the control plane refuses");
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests.length, 0);
  } finally { await unmountFixture(fixture); }
});

test("an Orchestrator without Strict Project Isolation on an older runner says which machine to update", async () => {
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
    const sentence = "Update Wollipog on runner-1 to run an Orchestrator without Strict Project Isolation. To start now, turn it on.";
    assert.equal(policyRow(fixture.container).querySelector(".field-error")?.textContent, sentence);
    assert.equal(footerReason(fixture.container), sentence);
    assert.doesNotMatch(fixture.container.textContent!, /protocol-v|newer runner/);
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
    const dialog = await openPolicy(fixture.container, "permissions");
    const on = segment(dialog, "Integration Isolation", "On");
    assert.equal(on.getAttribute("aria-checked"), "true", "the control is still shown, so the effective value is visible");
    assert.equal(on.getAttribute("aria-disabled"), "true", "it is implied rather than independently selectable");
    assert.equal(segment(dialog, "Integration Isolation", "Off").getAttribute("aria-disabled"), "true");
    assert.match(settingRowOf(on).textContent ?? "", /Implied by Strict Project Isolation, so it can't be turned off\./);
    assert.match(fixture.container.textContent!,
      /already launches without provider integrations, so Integration Isolation is implied/);
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
    await chooseSegment(await openPolicy(fixture.container, "permissions"), "Integration Isolation", "On");
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
    const dialog = await openPolicy(fixture.container, "permissions");
    const off = segment(dialog, "Integration Isolation", "Off");
    assert.equal(off.getAttribute("aria-disabled"), "true", "the setting is still shown rather than hidden");
    assert.match(settingRowOf(off).textContent!, /Update Wollipog to configure Integration Isolation\./);
    assert.doesNotMatch(fixture.container.textContent!, /Update the control plane/);
    await act(async () => { buttonNamed(dialog, "Cancel").click(); });
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

/* ------------------------------------------------------------------------------------------------
 * Options (#2954): one row below Agent that opens itself when something in it needs attention.
 * ---------------------------------------------------------------------------------------------- */

const HOST_BOUNDARIES = { filesystem: "host", network: "inherit", secrets: "runner_local", billing: "agent_account" } as const;

function hostTargets(): NonNullable<RunnerView["executionTargets"]> {
  return [
    { id: "host-in-place", runnerId: runner.runnerId, name: "Runner Host · in place", kind: "local",
      workspaceStrategy: "in_place", adapter: "host", boundaries: HOST_BOUNDARIES, available: true },
    { id: "host-worktree", runnerId: runner.runnerId, name: "Runner Host · worktree", kind: "local",
      workspaceStrategy: "worktree", adapter: "host", boundaries: { ...HOST_BOUNDARIES, filesystem: "worktree" }, available: true },
  ];
}

function optionsMeta(container: HTMLDivElement): string[] {
  return [...optionsHead(container).querySelectorAll(".session-options-meta-item")].map((item) => item.textContent ?? "");
}

test("with every option at its default, Options is one closed row listing Normal, Direct, In Place and the permissions (#2954)", async () => {
  const fixture = await mountFixture({ runners: [{ ...runner, executionTargets: hostTargets() }] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const head = optionsHead(fixture.container);
    assert.equal(head.getAttribute("aria-expanded"), "false");
    assert.deepEqual(optionsMeta(fixture.container), ["Normal", "Direct", "In Place", "Harness Default"],
      "Run On is listed only when there is a choice");
    assert.equal(fixture.container.querySelector<HTMLElement>(".session-options-body")?.hidden, true);
    assertNoDomNode(fixture.container.querySelector('button[aria-label^="Run On:"]'), "two host targets offer no choice");
    // Every retired line and class is gone, as are the old controls' names.
    for (const retired of [".new-session-provider-permissions", ".new-session-provider-permissions-value", ".new-session-mode"]) {
      assertNoDomNode(fixture.container.querySelector(retired));
    }
    for (const name of ["Session Role", "Session Mode", "Execution Target", "Provider Permissions"]) {
      assertNoDomNode(fixture.container.querySelector(`[aria-label="${name}"], [aria-label^="${name}:"]`));
    }
    await act(async () => { head.click(); });
    const titles = [...fixture.container.querySelectorAll(".session-options-body .setting-row-title")].map((title) => title.textContent);
    assert.deepEqual(titles, ["Role", "Harness", "Working Copy", "Permissions"]);
    const workingCopy = fixture.container.querySelector('[role="radiogroup"][aria-label="Working Copy"]')!;
    assert.equal(settingRowOf(workingCopy).querySelector(".setting-row-desc")?.textContent,
      "A worktree keeps your checkout untouched. Recommended for code changes.");
    await act(async () => { radioRows(workingCopy).find((radio) => radio.textContent === "Worktree")!.click(); });
    await act(async () => { head.click(); });
    assert.deepEqual(optionsMeta(fixture.container), ["Normal", "Direct", "Worktree", "Harness Default"]);
    await act(async () => { createButton(fixture.container).click(); });
    assert.equal(fixture.requests[0]?.useWorktree, true);
    assert.equal(fixture.requests[0]?.executionTargetId, "host-worktree", "the same request as before");
  } finally { await unmountFixture(fixture); }
});

test("Run On describes each target in words, and nothing in the dialog prints a raw boundary enum (#2954)", async () => {
  const values = {
    filesystem: ["host", "worktree", "container", "snapshot"],
    network: ["inherit", "deny", "policy"],
    secrets: ["runner_local", "references", "none"],
    billing: ["agent_account", "target_metered", "none", "unknown"],
  } as const;
  const base = { filesystem: "container", network: "deny", secrets: "none", billing: "none" } as const;
  const targets = Object.entries(values).flatMap(([key, options]) => options.map((value) => ({
    id: `${key}-${value}`, runnerId: runner.runnerId, name: `Target ${key} ${value.replace(/_/g, " ")}`, kind: "container" as const,
    workspaceStrategy: "worktree" as const, adapter: "container" as const,
    boundaries: { ...base, [key]: value } as RunnerView["executionTargets"] extends (infer T)[] | undefined ? T extends { boundaries: infer B } ? B : never : never,
    available: true,
  })));
  const fixture = await mountFixture({ runners: [{ ...runner, executionTargets: [...hostTargets(), ...targets] }] }, undefined,
    undefined, undefined, undefined, undefined, { runnerSkills: async () => ({ desired: [], reported: null }) as never });
  const rawEnum = /runner_local|agent_account|target_metered|Network (?:inherit|deny|policy)|Secrets (?:runner|references|none)|Billing (?:agent|target|none|unknown)|Target: /u;
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await act(async () => { optionsHead(fixture.container).click(); });
    for (const target of targets) {
      await chooseSelectOption(fixture.container, "Run On", target.name);
      const runOn = fixture.container.querySelector('button[aria-label^="Run On:"]')!;
      assert.equal(settingRowOf(runOn).querySelector(".setting-row-desc")?.textContent, describeBoundaries(target.boundaries),
        `${target.name} is described by its boundaries in words`);
      assert.doesNotMatch(fixture.container.querySelector('[role="dialog"]')?.textContent ?? "", rawEnum,
        `${target.name}: no raw boundary enum renders`);
    }
    await act(async () => { optionsHead(fixture.container).click(); });
    assert.ok(optionsMeta(fixture.container).includes(targets.at(-1)!.name), "with a choice, the head lists where it runs");
  } finally { await unmountFixture(fixture); }
});

test("a disabled Orchestrator keeps its place, says why in the row, and is reachable with the arrow keys (#2954)", async () => {
  const fixture = await mountFixture({ runners: [{ ...runner, protocolVersion: 67 }] });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    const normal = permissionPresetCard(fixture.container, "Normal")!;
    const orchestrator = permissionPresetCard(fixture.container, "Orchestrator")!;
    assert.equal(cardRefused(orchestrator), true);
    assert.equal(settingRowOf(orchestrator).querySelector(".setting-row-desc")?.textContent,
      "This runner is too old to orchestrate child sessions.");
    await act(async () => { optionsHead(fixture.container).click(); });
    normal.focus();
    await act(async () => {
      normal.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as never);
    });
    assert.ok((domWindow.document.activeElement as unknown) === orchestrator, "the arrow lands on the refused option");
    assert.equal(ariaReferencedText(orchestrator, "aria-describedby"), "This runner is too old to orchestrate child sessions.");
    await act(async () => { orchestrator.click(); });
    assert.equal(orchestrator.getAttribute("aria-checked"), "false", "and it cannot be chosen");
    assert.equal(optionsHead(fixture.container).getAttribute("aria-expanded"), "true",
      "a refused option the person has not chosen needs no attention of its own");
  } finally { await unmountFixture(fixture); }
});

/* ------------------------------------------------------------------------------------------------
 * Orchestrator Policy (#2955): a summary row under Role, and a stacked dialog with three tabs.
 * ---------------------------------------------------------------------------------------------- */

const policyRunner = (): RunnerView => ({
  ...runner, protocolVersion: PROTOCOL_VERSION,
  agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
    models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
    permissionModes: ["default", "orchestrator"],
  } })),
});

/** A bubblewrap runner whose Claude Code can enforce Strict Project Isolation. */
const strictPolicyRunner = (protocolVersion = PROTOCOL_VERSION): RunnerView => ({
  ...runner, protocolVersion,
  runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4,
    executionIsolation: { mode: "bwrap", network: "inherit" } },
  agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
    models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
    permissionModes: ["default", "dontAsk", "orchestrator"],
  } })),
});

/** Saved defaults that execute approved follow-ups and run up to six children. */
async function executeApprovedDefaults(): Promise<OrchestratorSettingsView> {
  const defaults = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
  defaults.behavior.followUps = "execute_approved";
  defaults.behavior.maximumConcurrentChildren = 6;
  return {
    defaults,
    source: "user_default",
    capabilities: {
      models: [{ id: "test-model", efforts: ["high"] }], effortLevels: ["high"],
      installations: 1, compatibleInstallations: 1, status: "available",
    },
  };
}

function selectedTab(dialog: ParentNode): HTMLElement {
  const tab = dialog.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  assert.ok(tab, "a tab is selected");
  return tab;
}

test("the policy row states five facts with Customize…, and Customize… opens Orchestrator Policy over New Session (#2955)", async () => {
  const fixture = await mountFixture({ runners: [policyRunner()] }, undefined, undefined, undefined, undefined, executeApprovedDefaults);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    const row = policyRow(fixture.container);
    assert.deepEqual([...row.querySelectorAll(".orchestrator-policy-facts > span")].map((fact) => fact.textContent), [
      "Up to 6 Children", "Executes Approved Follow-Ups", "Keeps Finished Children", "Integration Isolation", "No Decisions Delegated",
    ]);
    assert.match(row.textContent ?? "", /From your Orchestrator defaults in Settings\./);
    assert.doesNotMatch(row.textContent ?? "", /change/, "nothing differs from the defaults yet");
    assert.equal(customizeButton(fixture.container)?.textContent, "Customize…");
    assert.equal(customizeButton(fixture.container)?.getAttribute("aria-haspopup"), "dialog");
    assert.match(ariaReferencedText(customizeButton(fixture.container)!, "aria-describedby") ?? "", /^Up to 6 Children/,
      "Customize… is described by what it would change");

    const dialog = await openPolicy(fixture.container);
    assert.equal(fixture.container.querySelectorAll('[role="dialog"]').length, 2, "New Session stays open under it");
    assert.equal(dialog.querySelector(".modal-desc")?.textContent, "For this session only. Your defaults live in Settings.");
    assert.deepEqual([...dialog.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent), ["Behavior", "Permissions", "Decisions"]);
    assert.equal(selectedTab(dialog).textContent, "Behavior");
    assert.deepEqual([...dialog.querySelectorAll(".modal-foot button")].map((button) => button.textContent),
      ["Reset to Defaults", "Cancel", "Apply Policy"], "Reset to Defaults is a ghost button before Cancel (§7.3)");
    assert.ok(buttonNamed(dialog, "Reset to Defaults").classList.contains("ghost"));
    assert.equal(buttonNamed(dialog, "Reset to Defaults").disabled, true, "nothing to reset yet");
    assert.deepEqual([...dialog.querySelectorAll('[role="tabpanel"] .setting-row-title')].map((title) => title.textContent),
      ["Child Harness", "Child Model", "Child Effort", "Maximum Concurrent Children", "Follow-Ups", "Completion"]);
    await choosePolicyTab(fixture.container, "permissions");
    assert.deepEqual([...policyDialog(fixture.container).querySelectorAll('[role="tabpanel"] .setting-row-title')].map((title) => title.textContent),
      ["Strict Project Isolation", "Integration Isolation", "Effective Boundary"]);
    // Off | On segments, as in Settings.
    for (const group of ["Strict Project Isolation", "Integration Isolation"]) {
      assert.deepEqual(radioRows(policyDialog(fixture.container).querySelector(`[role="radiogroup"][aria-label="${group}"]`)!)
        .map((option) => option.textContent), ["Off", "On"], group);
    }
    await choosePolicyTab(fixture.container, "decisions");
    assert.deepEqual([...policyDialog(fixture.container).querySelectorAll('[role="tabpanel"] .setting-row-title')].map((title) => title.textContent), [
      "Orchestrator Control", "Descendant Requests", "Implementation Questions", "PR Merge Approval", "Merged Branch Deletion",
      "Follow-Up Issue Publication", "UI Evidence Approval",
    ]);
  } finally { await unmountFixture(fixture); }
});

test("a changed row says Changed with Reset to its default, its tab counts it, Apply Policy counts it in the summary, and Cancel discards it (#2955)", async () => {
  const fixture = await mountFixture({ runners: [policyRunner()] }, undefined, undefined, undefined, undefined, executeApprovedDefaults);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    let dialog = await openPolicy(fixture.container);
    const followUps = () => policyDialog(fixture.container).querySelector<HTMLButtonElement>('[aria-label^="Follow-Ups:"]')!;
    assertNoDomNode(policyDialog(fixture.container).querySelector(".changed-mark"), "no row is marked before a change");
    await chooseSelectOption(fixture.container, "Follow-Ups", "Recommend Only");
    const mark = settingRowOf(followUps()).querySelector(".changed-mark");
    assert.ok(mark, "the row is marked");
    assert.equal(mark.textContent, "ChangedReset to Execute Approved");
    assert.equal(selectedTab(policyDialog(fixture.container)).textContent, "Behavior1 Changed");
    assert.equal(selectedTab(policyDialog(fixture.container)).querySelector(".count")?.textContent, "1 Changed", "a plain count");
    assert.equal(buttonNamed(policyDialog(fixture.container), "Reset to Defaults").disabled, false);

    // Reset to <value> puts the row back.
    await act(async () => { buttonNamed(policyDialog(fixture.container), "Reset to Execute Approved").click(); });
    assert.match(followUps().getAttribute("aria-label") ?? "", /Execute Approved/);
    assertNoDomNode(policyDialog(fixture.container).querySelector(".changed-mark"));
    assert.equal(selectedTab(policyDialog(fixture.container)).textContent, "Behavior");

    // Apply Policy carries the change to the summary.
    await chooseSelectOption(fixture.container, "Follow-Ups", "Recommend Only");
    await applyPolicy(fixture.container);
    assertNoDomNode(fixture.container.querySelector('[role="dialog"] .modal-title:not(:first-child)'));
    assert.equal(fixture.container.querySelectorAll('[role="dialog"]').length, 1, "Apply Policy closes the dialog");
    assert.match(policyRow(fixture.container).textContent ?? "", /Recommends Follow-Ups/);
    assert.match(policyRow(fixture.container).textContent ?? "", /1 change(?!s)/);

    // Cancel discards what changed since: the applied change stays, the new one does not.
    dialog = await openPolicy(fixture.container);
    await chooseSegment(dialog, "Completion", "Stop and Archive");
    assert.equal(selectedTab(policyDialog(fixture.container)).textContent, "Behavior2 Changed");
    await act(async () => { buttonNamed(policyDialog(fixture.container), "Cancel").click(); });
    assert.equal(fixture.container.querySelectorAll('[role="dialog"]').length, 1);
    assert.match(policyRow(fixture.container).textContent ?? "", /1 change(?!s)/);
    assert.match(policyRow(fixture.container).textContent ?? "", /Keeps Finished Children/);

    // Reset to Defaults clears every override, and nothing is sent once applied.
    dialog = await openPolicy(fixture.container);
    await act(async () => { buttonNamed(dialog, "Reset to Defaults").click(); });
    assertNoDomNode(policyDialog(fixture.container).querySelector(".changed-mark"));
    await applyPolicy(fixture.container);
    assert.doesNotMatch(policyRow(fixture.container).textContent ?? "", /change/);
    await act(async () => { createButton(fixture.container).click(); });
    assert.deepEqual(fixture.requests[0]?.orchestrator, { behavior: {}, delegation: {} });
  } finally { await unmountFixture(fixture); }
});

test("each tab's changes reach the create request as the same overrides as before (#2955)", async () => {
  const fixture = await mountFixture({ runners: [strictPolicyRunner()] }, undefined, undefined, undefined, undefined, executeApprovedDefaults);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    await editPolicy(fixture.container, "behavior", async (dialog) => {
      await chooseSelectOption(fixture.container, "Follow-Ups", "Recommend Only");
      await chooseSegment(dialog, "Completion", "Stop and Archive");
      await act(async () => { fireDomEvent.change(rowNumberInput(dialog, "Maximum Concurrent Children")!, { target: { value: "3" } }); });
    });
    await editPolicy(fixture.container, "permissions", (dialog) => chooseSegment(dialog, "Strict Project Isolation", "On"));
    await editPolicy(fixture.container, "decisions", async (dialog) => {
      await chooseSelectOption(fixture.container, "Descendant Requests", "Questions");
      await chooseSegment(dialog, "Merged Branch Deletion", "Orchestrator");
    });
    const row = policyRow(fixture.container).textContent ?? "";
    assert.match(row, /Up to 3 Children/);
    assert.match(row, /Strict Project Isolation/);
    assert.match(row, /1 Decision Delegated/);
    assert.match(row, /6 changes/);
    await act(async () => { createButton(fixture.container).click(); });
    assert.deepEqual(fixture.requests[0]?.orchestrator, {
      behavior: { maximumConcurrentChildren: 3, followUps: "recommend_only", completion: "stop_and_archive" },
      delegation: { parentControl: "questions", decisions: { merged_branch_deletion: "orchestrator" } },
      execution: { strictProjectIsolation: true },
    });
  } finally { await unmountFixture(fixture); }
});

test("an older runner keeps an inherited delegation human and says which machine to update to delegate (#2955)", async () => {
  const oldRunner = strictPolicyRunner(RUNNER_CAPABILITY_MIN_PROTOCOL.typedWorkflowDecisionDelegation - 1);
  const delegated = async (): Promise<OrchestratorSettingsView> => {
    const view = await executeApprovedDefaults();
    view.defaults.delegation.parentControl = "off";
    view.defaults.execution.strictProjectIsolation = true;
    return view;
  };
  const fixture = await mountFixture({ runners: [oldRunner] }, undefined, undefined, undefined, undefined, delegated);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    assertNoDomNode(policyRow(fixture.container).querySelector(".field-error"), "an inherited default downgrades quietly");
    const dialog = await openPolicy(fixture.container, "decisions");
    const orchestrator = segment(dialog, "PR Merge Approval", "Orchestrator");
    assert.equal(orchestrator.getAttribute("aria-disabled"), "true");
    assert.equal(orchestrator.title, "Update Wollipog on runner-1 to delegate decisions to the Orchestrator.");
    await act(async () => { buttonNamed(dialog, "Cancel").click(); });
    assert.equal(createButton(fixture.container).disabled, false);
  } finally { await unmountFixture(fixture); }
});

test("an ACP Orchestrator's permissions come from the preset, and a warning notice says why in user words (#2954, #1360)", async () => {
  const acpRunner: RunnerView = {
    ...runner, protocolVersion: PROTOCOL_VERSION,
    runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4,
      executionIsolation: { mode: "bwrap", network: "inherit" } },
    agents: [{ id: "gemini", name: "Gemini", command: "gemini", args: [], env: {}, driver: "acp", available: true,
      capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
        permissionModes: ["default", "orchestrator"] } }],
  };
  const fixture = await mountFixture({ runners: [acpRunner], capabilities: {
    sessionSubscriptions: false, projects: true, orchestratorRole: true,
  } }, undefined, undefined, undefined, undefined, strictOrchestratorDefaults);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    assertNoDomNode(fixture.container.querySelector(".session-options-body > .notice.t-warning"));
    await choosePermissionPreset(fixture.container, "Orchestrator");
    // Non-strict is the case the ACP sentence is for; Strict Project Isolation names itself instead.
    await editPolicy(fixture.container, "permissions", (dialog) => chooseSegment(dialog, "Strict Project Isolation", "Off"));
    const notice = fixture.container.querySelector<HTMLElement>(".session-options-body > .notice.t-warning");
    assert.ok(notice, "the preset is a warning notice under Permissions");
    assert.match(notice.textContent ?? "", /Permissions Set by the Orchestrator Preset/);
    assert.match(notice.textContent ?? "",
      /This agent's adapter can't run an Orchestrator with normal permissions, so the preset sets them\./);
    assert.match(permissionsSummary(fixture.container).textContent, /Orchestrator Preset/);
    await act(async () => { optionsHead(fixture.container).click(); });
    assert.deepEqual(optionsMeta(fixture.container).slice(0, 1), ["Orchestrator"]);
    assert.ok(optionsMeta(fixture.container).includes("Orchestrator Preset"));
  } finally { await unmountFixture(fixture); }
});

test("a saved Orchestrator default this runner can't honor opens Options and names it (#2954)", async () => {
  const oldRunner: RunnerView = {
    ...runner, protocolVersion: 67,
    agents: runner.agents.map((agent) => ({ ...agent, capabilities: {
      models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
      permissionModes: ["default", "orchestrator"],
    } })),
  };
  const fixture = await mountFixture({ runners: [oldRunner] }, undefined, undefined, async () => ({
    defaults: [{ agentId: "claude", driver: "claude-code", context: { kind: "native" }, name: "Claude",
      installations: [], compatibleInstallations: 1, preference: { permissionMode: "orchestrator" } }],
  }));
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    assert.equal(optionsHead(fixture.container).getAttribute("aria-expanded"), "true");
    const roleRow = settingRowOf(permissionPresetGroup(fixture.container));
    assert.match(roleRow.querySelector(".field-error")?.textContent ?? "",
      /The saved Orchestrator preset is unavailable here\. This runner is too old to orchestrate child sessions\./);
    await act(async () => { optionsHead(fixture.container).click(); });
    assert.equal(optionsHead(fixture.container).querySelector(".status.t-warning")?.textContent, "Orchestrator Unavailable");
    await assertCreateRefused(fixture);
  } finally { await unmountFixture(fixture); }
});

test("a Full Control launch that fails with Options closed opens Options and shows why; one not ready names itself in the head (#2954)", async () => {
  const fixture = await mountFixture({ runners: [fullControlRunner()] }, undefined, undefined, undefined, undefined, undefined, {
    fullControlLaunchPreflight: async (input) => ({
      preflight: launchPreflight(Boolean(input.overrides?.budget?.costUsd && input.overrides.budget.toolCalls && input.task !== "Full Control readiness check"), input),
    }),
    createFullControlCampaign: async () => { throw new ApiError("The campaign budget is above your remaining allowance.", 409); },
  });
  const head = () => optionsHead(fixture.container);
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await choosePermissionPreset(fixture.container, "Orchestrator");
    await chooseControlMode(fixture.container, "Full Control");
    await settlePreflight();
    assert.equal(authorizeButton(fixture.container).disabled, true);
    // Closed while it can't start, the head says so: the disabled footer action has no reason of its own.
    await act(async () => { head().click(); });
    assert.equal(head().getAttribute("aria-expanded"), "false");
    assert.match(head().textContent ?? "", /Full Control Not Ready/);
    await act(async () => { head().click(); });
    const field = (label: string) => [...fixture.container.querySelectorAll<HTMLLabelElement>("label")]
      .find((node) => node.querySelector("span")?.textContent === label && !node.closest("details"))!.querySelector("input, textarea") as HTMLInputElement;
    await act(async () => fireDomEvent.change(field("Task"), { target: { value: "Deliver #12" } }));
    await act(async () => fireDomEvent.change(field("Issue Numbers"), { target: { value: "#12" } }));
    await act(async () => fireDomEvent.change(field("Cost Limit (USD)"), { target: { value: "20" } }));
    await act(async () => fireDomEvent.change(field("Tool Call Limit"), { target: { value: "200" } }));
    await settlePreflight();
    assert.equal(authorizeButton(fixture.container).disabled, false);
    await act(async () => { head().click(); });
    assert.equal(head().getAttribute("aria-expanded"), "false", "a ready launch needs no attention");
    assertNoDomNode(head().querySelector(".status.t-warning"));

    await act(async () => authorizeButton(fixture.container).click());
    await act(async () => { await Promise.resolve(); });
    assert.equal(head().getAttribute("aria-expanded"), "true", "the failure is never left inside closed Options");
    const alert = [...fixture.container.querySelectorAll<HTMLElement>('.session-options-body [role="alert"]')]
      .find((node) => node.textContent?.includes("The campaign budget is above your remaining allowance."));
    assert.ok(alert, "the panel's failure is shown and announced");
    assertNoDomNode(alert.closest<HTMLElement>("[hidden]"), "and not inside a hidden region");
  } finally { await unmountFixture(fixture); }
});

test("an out-of-range Cloud Budget left behind closed Options is named in the head (#2954)", async () => {
  const boundaries = { filesystem: "snapshot", network: "policy", secrets: "references", billing: "target_metered" } as const;
  const fixture = await mountFixture({ runners: [{ ...runner, executionTargets: [...hostTargets(), {
    id: "cloud", runnerId: runner.runnerId, name: "Cloud Sandbox", kind: "cloud", workspaceStrategy: "snapshot", adapter: "cloud",
    boundaries, available: true,
    policy: { cost: { currency: "USD", estimatedHourlyRateUsd: 0.4, minimumBudgetUsd: 1, maximumBudgetUsd: 20.5 }, admission: { maxConcurrentSessions: 2, queue: "fifo" } },
  }] }] }, undefined, undefined, undefined, undefined, undefined, { runnerSkills: async () => ({ desired: [], reported: null }) as never });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await act(async () => { optionsHead(fixture.container).click(); });
    await chooseSelectOption(fixture.container, "Run On", "Cloud Sandbox");
    const budget = fixture.container.querySelector<HTMLInputElement>('input[step="0.01"]')!;
    // Amounts read as people write them: whole dollars bare, cents with two digits.
    assert.equal(settingRowOf(budget).querySelector(".setting-row-desc")?.textContent,
      "Stops the session at this amount. Between $1 and $20.50, at about $0.40 an hour.");
    await act(async () => { fireDomEvent.change(budget, { target: { value: "0" } }); });
    assert.match(ariaReferencedText(budget, "aria-describedby") ?? "", /^Enter an amount from \$1 to \$20\.50\./);
    await act(async () => { optionsHead(fixture.container).click(); });
    assert.equal(optionsHead(fixture.container).getAttribute("aria-expanded"), "false");
    assert.equal(optionsHead(fixture.container).querySelector(".status.t-warning")?.textContent, "Budget Out of Range");
  } finally { await unmountFixture(fixture); }
});

test("Cloud Budget limits are never rounded into values the field refuses (#2954)", async () => {
  const boundaries = { filesystem: "snapshot", network: "policy", secrets: "references", billing: "target_metered" } as const;
  const fixture = await mountFixture({ runners: [{ ...runner, executionTargets: [...hostTargets(), {
    id: "cloud", runnerId: runner.runnerId, name: "Cloud Sandbox", kind: "cloud", workspaceStrategy: "snapshot", adapter: "cloud",
    boundaries, available: true,
    policy: { cost: { currency: "USD", estimatedHourlyRateUsd: 0.125, minimumBudgetUsd: 1.004, maximumBudgetUsd: 20.006 }, admission: { maxConcurrentSessions: 2, queue: "fifo" } },
  }] }] }, undefined, undefined, undefined, undefined, undefined, { runnerSkills: async () => ({ desired: [], reported: null }) as never });
  try {
    await act(async () => { await selectProject(fixture.container, project.id); });
    await act(async () => { optionsHead(fixture.container).click(); });
    await chooseSelectOption(fixture.container, "Run On", "Cloud Sandbox");
    const budget = fixture.container.querySelector<HTMLInputElement>('input[step="0.01"]')!;
    assert.equal(settingRowOf(budget).querySelector(".setting-row-desc")?.textContent,
      "Stops the session at this amount. Between $1.004 and $20.006, at about $0.125 an hour.");
    await act(async () => { fireDomEvent.change(budget, { target: { value: "0" } }); });
    assert.match(ariaReferencedText(budget, "aria-describedby") ?? "", /^Enter an amount from \$1\.004 to \$20\.006\./);
    // Each endpoint the sentence names is one the field accepts.
    for (const endpoint of ["1.004", "20.006"]) {
      await act(async () => { fireDomEvent.change(budget, { target: { value: endpoint } }); });
      assert.equal(budget.getAttribute("aria-invalid"), null, `${endpoint} is accepted`);
    }
  } finally { await unmountFixture(fixture); }
});
