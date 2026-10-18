import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type ProjectView, type RunnerView, type UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { ProjectsView } from "./ProjectsView.js";
import type { NewSessionPreset } from "./NewSessionDialog.js";
import { projectDetailMenu } from "./ProjectDetailHeader.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

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
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  InputEvent: domWindow.InputEvent,
  // For Memory Sharing's listbox (#2963).
  requestAnimationFrame: domWindow.requestAnimationFrame.bind(domWindow),
  cancelAnimationFrame: domWindow.cancelAnimationFrame.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  displayName: "Build Machine",
  agents: [],
  workspaces: Array.from({ length: 9 }, (_, index) => ({
    id: `workspace-${index + 1}`, name: `Location ${index + 1}`, path: `/repos/project-${index + 1}`,
  })),
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: PROTOCOL_VERSION,
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

const navigation: ViewNavigation = { current: () => ({ name: "projects" }), push() {}, listen: () => () => {} };
/** Every toast shown, newest last, and every confirmation asked, by title, with the answer each one gets. */
const toasts: string[] = [];
const confirmations: string[] = [];
let confirmAnswer = true;
const feedback = {
  confirm: async ({ title }: { title: string }) => { confirmations.push(title); return confirmAnswer; },
  showToast: (message: string) => { toasts.push(message); return -1; },
  showUndo: () => -1,
  dismissToast: () => undefined,
};

function project(index: number, options: Partial<ProjectView> = {}): ProjectView {
  return {
    id: `project-${index}`,
    name: `Project ${index}`,
    hidden: false,
    locations: [{
      id: `location-${index}`, projectId: `project-${index}`, runnerId: "runner-1", workspaceId: `workspace-${index}`,
      name: `Location ${index}`, path: `/repos/project-${index}`, source: "managed", availability: "available",
      isDefault: true, createdAt: 1, updatedAt: 1,
    }],
    activeSessionCount: 0,
    unarchivedSessionCount: index,
    totalSessionCount: index,
    createdAt: 1,
    updatedAt: 1,
    ...options,
  };
}

/** Every preset New Session was opened with, newest last. */
const newSessionPresets: (NewSessionPreset | undefined)[] = [];

/** The store's route as of the last render. */
let currentView: View = { name: "projects" };

/** The route is the view's only selection, so the harness renders the store's current route. */
function ProjectsRoute() {
  const view = useStoreSelector((state) => state.view);
  currentView = view;
  return <ProjectsView selectedProjectId={view.name === "projects" ? view.id : undefined}
    pane={view.name === "projects" ? view.pane : undefined}
    onNewSession={(preset) => { newSessionPresets.push(preset); }} />;
}

async function render(snapshot: Partial<UiSnapshotMessage> | null, client: ApiClient = api) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "projects-1", runtimeKey: "projects-1:1", createSocket: () => socket, close() {},
  };
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackContext.Provider value={feedback as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <ProjectsRoute />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  if (snapshot) {
    await act(async () => {
      socket.push({
        type: "snapshot",
        capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
        runners: [runner],
        boxes: [],
        sessions: [],
        runs: [],
        pods: [],
        ...snapshot,
      } as UiSnapshotMessage);
    });
  }
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return domWindow.document.body as unknown as HTMLElement;
}

const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const headerButtons = (body: HTMLElement) => [...body.querySelectorAll(".page-header button")].map((button) =>
  button.getAttribute("aria-label") ?? text(button));
const rows = (body: HTMLElement) => [...body.querySelectorAll<HTMLButtonElement>(".master-detail-list-body .row")];

test("with zero projects, one No Projects Yet state spans the content, and the header's New Project is hidden", async () => {
  const body = await render({ projects: [] });
  assertNoDomNode(body.querySelector(".master-detail"), "no empty list beside a void (§6.1)");
  const state = body.querySelector(".master-detail-state");
  assert.equal(text(state?.querySelector("h2")), "No Projects Yet");
  assert.match(text(state), /A project is a repository on one or more of your machines\. Sessions start inside a project\./);
  assert.deepEqual([...state!.querySelectorAll("button")].map(text), ["New Project", "Connect a Machine"]);
  assert.equal(headerButtons(body).includes("New Project"), false, "the header primary steps aside");
});

test("the filter counts All 9, Shown 8 and Hidden 1, and Hidden lists only the hidden project", async () => {
  const projects = Array.from({ length: 9 }, (_, index) => project(index + 1, index === 4 ? { hidden: true } : {}));
  const body = await render({ projects });
  const filter = body.querySelector('[role="radiogroup"][aria-label="Sessions Tabs"]');
  assert.deepEqual([...filter!.querySelectorAll('[role="radio"]')].map(text), ["All 9", "Shown 8", "Hidden 1"]);
  assert.equal(rows(body).length, 9);
  assert.deepEqual(headerButtons(body).filter((name) => name === "New Project"), ["New Project"]);

  await act(async () => { [...filter!.querySelectorAll<HTMLButtonElement>('[role="radio"]')][2]!.click(); });
  assert.deepEqual(rows(body).map((row) => text(row.querySelector(".row-title"))), ["Project 5"]);
  assert.equal(text(rows(body)[0]!.querySelector(".row-sub")), "Hidden tab · Build Machine");
});

test("a search with no match is one inline row with Clear Search, and the overview stays beside it", async () => {
  const body = await render({ projects: [project(1), project(2)] });
  const search = body.querySelector<HTMLInputElement>('input[aria-label="Search Projects"]')!;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!;
    search.focus();
    setValue.call(search, "zzz");
    search.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true, data: "zzz" }) as unknown as Event);
    search.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
  assert.equal(rows(body).length, 0);
  const noMatch = body.querySelectorAll(".master-detail-list-body .state");
  assert.equal(noMatch.length, 1);
  assert.match(text(noMatch[0]), /No projects match “zzz”\./);
  assert.doesNotMatch(text(body), /Select a Project/);
  assert.equal(text(body.querySelector(".master-detail-detail .projects-overview-summary")),
    "2 projects on 1 machine, with 3 sessions.", "a search changes only the list (#2957)");
  const clear = [...noMatch[0]!.querySelectorAll("button")].find((button) => text(button) === "Clear Search");
  assert.ok(clear, "Clear Search");
  await act(async () => { clear!.click(); });
  assert.equal(rows(body).length, 2);
});

test("an older server shows the Projects Need an Update warning, never Project Management Unavailable", async () => {
  const body = await render({
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: false },
  });
  const notice = body.querySelector(".master-detail-state .notice.t-warning");
  assert.equal(text(notice?.querySelector(".notice-title")), "Projects Need an Update");
  assert.match(text(notice), /Update Wollipog to manage projects and locations\. Your sessions aren’t affected\./);
  assert.doesNotMatch(text(body), /Project Management Unavailable/);
});

test("before the snapshot, the list shows skeleton rows and the detail its skeleton", async () => {
  const body = await render(null);
  assert.equal(body.querySelectorAll(".master-detail-list .row.row-2.project-row-skeleton").length, 5);
  assert.ok(body.querySelector(".master-detail-detail .detail-skeleton"));
  const primary = [...body.querySelectorAll<HTMLButtonElement>(".page-header button")].find((button) => text(button) === "New Project");
  assert.equal(primary?.disabled, true);
});

/** A phone viewport for useIsMobile (≤ 760px); every other width query stays false. */
function stubPhone(): () => void {
  const prior = domWindow.matchMedia;
  domWindow.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 760px"),
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as never;
  return () => { domWindow.matchMedia = prior; };
}

/** Renders the projects and opens the one named. */
async function renderSelected(projects: ProjectView[], name: string, snapshot: Partial<UiSnapshotMessage> = {}, client?: ApiClient) {
  const body = await render({ projects, ...snapshot }, client);
  const row = rows(body).find((candidate) => text(candidate.querySelector(".row-title")) === name);
  assert.ok(row, name);
  await act(async () => { row!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  return body;
}

async function openProjectActions(scope: Element) {
  const more = scope.querySelector<HTMLButtonElement>('button[aria-label="Project Actions"]');
  assert.ok(more, "⋯ is named for what it acts on");
  assert.equal(more!.title, "Project Actions");
  await act(async () => more!.click());
  const menu = domWindow.document.querySelector('[role="menu"][aria-label="Project Actions"]') as unknown as HTMLElement;
  assert.ok(menu, "Project Actions menu");
  return menu;
}

const menuItems = (menu: Element) => [...menu.querySelectorAll<HTMLButtonElement>(".menu-item")].map((item) => ({
  label: text(item.querySelector(".menu-text")),
  reason: item.querySelector(".menu-desc") ? text(item.querySelector(".menu-desc")) : null,
  disabled: item.disabled || item.getAttribute("aria-disabled") === "true",
  danger: item.classList.contains("danger"),
}));

/** A project with two locations on the build machine, the second one its default. */
function busyProject(): ProjectView {
  const base = project(1);
  return {
    ...base,
    activeSessionCount: 1,
    unarchivedSessionCount: 11,
    totalSessionCount: 14,
    locations: [
      { ...base.locations[0]!, isDefault: false },
      { ...base.locations[0]!, id: "location-1b", workspaceId: "workspace-2", name: "Second", path: "/repos/project-2", isDefault: true },
    ],
  };
}

test("the detail's first row is the name, New Session and ⋯; New Session opens with the project and its default location", async () => {
  newSessionPresets.length = 0;
  const body = await renderSelected([busyProject(), project(3)], "Project 1");
  const row = body.querySelector(".master-detail-detail .project-detail-title-row");
  assert.ok(row, "one title row");
  const title = row!.querySelector("h2");
  assert.equal(text(title), "Project 1");
  assert.equal(title!.getAttribute("title"), "Project 1", "a truncated name keeps its tooltip");
  const buttons = [...row!.querySelectorAll<HTMLButtonElement>("button")];
  assert.deepEqual(buttons.map((button) => button.getAttribute("aria-label") ?? text(button)), ["New Session", "Project Actions"]);
  assert.ok(buttons[0]!.classList.contains("primary"));
  assert.equal(buttons[0]!.disabled, false);
  assertNoDomNode(body.querySelector(".project-detail-blocker"), "a project that can start sessions gives no reason");
  await act(async () => { buttons[0]!.click(); });
  assert.deepEqual(newSessionPresets.at(-1), {
    runnerId: "runner-1", workspaceId: "workspace-2", projectId: "project-1", projectLocationId: "location-1b",
  });
});

test("the meta line shows locations and sessions with the running count, and no id, tiles, Session Actions or Danger Zone", async () => {
  const body = await renderSelected([busyProject()], "Project 1");
  const detail = body.querySelector(".master-detail-detail")!;
  const meta = detail.querySelector('.project-detail-meta[aria-label="Project Details"]');
  assert.deepEqual([...meta!.querySelectorAll("li")].map(text), ["2 Locations", "11 Sessions, 1 Running"]);
  assert.ok([...meta!.querySelectorAll("li")].every((fact) => fact.querySelector("svg")), "each fact has its icon");
  assert.doesNotMatch(text(detail), /Project ID/);
  assert.doesNotMatch(text(detail), /Shown in Sessions|Hidden from Sessions/);
  assertNoDomNode(detail.querySelector(".project-counts"), "no stat tiles");
  const headings = [...detail.querySelectorAll("h2, h3, h4")].map(text);
  assert.equal(headings.includes("Session Actions"), false);
  assert.equal(headings.includes("Danger Zone"), false);
});

test("the access fact is the saved scope, and names a team only once the identity directory has loaded", async () => {
  const identity = {
    context: { userId: "user-1", userName: "Ada", organizationId: "org-1", organizationName: "Org", role: "owner", deviceId: null, localBootstrap: false },
    organizations: [],
    memberships: [],
    teams: [{ teamId: "team-1", organizationId: "org-1", name: "Builders", memberUserIds: ["user-1"] }],
  };
  let release: (value: unknown) => void = () => {};
  const loaded = new Promise((resolve) => { release = resolve; });
  const client = { ...api, getIdentity: async () => { await loaded; return identity; } } as unknown as ApiClient;
  const scoped = { ...busyProject(), audience: "organization" as const, scope: { organizationId: "org-1", owner: { kind: "team" as const, teamId: "team-1" } } };
  const capabilities = { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true, accessScopeManagement: true };
  const body = await renderSelected([scoped], "Project 1", { capabilities } as Partial<UiSnapshotMessage>, client);
  const facts = () => [...body.querySelectorAll(".project-detail-meta li")].map(text);
  assert.deepEqual(facts(), ["2 Locations", "11 Sessions, 1 Running"], "no access fact while the team's name is unknown");
  assert.doesNotMatch(text(body.querySelector(".master-detail-detail")), /Unknown Team|Project Visibility/);
  await act(async () => { release(undefined); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.deepEqual(facts(), ["2 Locations", "11 Sessions, 1 Running", "Access: Team: Builders"],
    "the saved team scope, not the audience field (Everyone in Your Organization)");
});

test("an organization-wide scope shows before the identity directory loads", async () => {
  const client = { ...api, getIdentity: () => new Promise(() => {}) } as unknown as ApiClient;
  const scoped = { ...busyProject(), scope: { organizationId: "org-1", owner: { kind: "organization" as const, organizationId: "org-1" } } };
  const capabilities = { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true, accessScopeManagement: true };
  const body = await renderSelected([scoped], "Project 1", { capabilities } as Partial<UiSnapshotMessage>, client);
  assert.equal(text([...body.querySelectorAll(".project-detail-meta li")].at(-1)), "Access: Organization-Wide");
});

test("every section is the one recipe, in order, and no bare heading renders", async () => {
  const body = await renderSelected([{ ...busyProject(), childSessionDefaults: null, memorySharing: "separate" }], "Project 1");
  const detail = body.querySelector(".master-detail-detail")!;
  const sections = [...detail.querySelectorAll(":scope .project-detail > section")];
  assert.deepEqual(sections.map((section) => text(section.querySelector(":scope > .section-head > .section-title"))),
    ["Locations", "Settings", "Memory Sharing", "Child Session Defaults"]);
  for (const section of sections) {
    assert.ok(section.classList.contains("section"), text(section.querySelector("h3")));
    assert.equal(section.getAttribute("aria-labelledby"), section.querySelector(".section-title")!.id);
    assert.ok(section.querySelectorAll(":scope > .section-note").length <= 1, "at most one sentence under the title");
  }
  const headings = [...detail.querySelectorAll("h3")];
  assert.equal(headings.length, 4);
  assert.ok(headings.every((heading) => heading.classList.contains("section-title")), "every h3 is a section title");
  assert.deepEqual([...detail.querySelectorAll("h2")].map((heading) => heading.className), ["project-detail-title"]);
  // Settings and Child Session Defaults are each one surface of setting rows (#2962).
  const [, settings, , limits] = sections;
  assert.equal(settings!.querySelectorAll(".surface").length, 1);
  assert.deepEqual(rowTitles(settings!), ["Name", "Show as a Sessions Tab"]);
  assert.deepEqual(rowTitles(limits!), ["Cost Limit per Child", "Tool Calls per Child"]);
  assert.equal(text(limits!.querySelector(":scope > .section-note")),
    "Limits for child sessions that don't set their own. A parent's remaining budget always caps them.");
  assert.ok([settings!, limits!].every((section) => section.querySelector("form")?.noValidate), "no browser validation bubbles");
  assert.deepEqual([...detail.querySelectorAll("button")].map(text).filter((label) =>
    /Hide Project|Show Project|Save Changes|Save Child Defaults|Remove Child Defaults|Clear Limits/u.test(label)), [],
  "no per-form Save, no Hide Project, and no Clear Limits while no limits are set");
  assertNoDomNode(detail.querySelector(".project-name-form, .save-bar"), "no rename form, and no save bar while clean");
});

/** The setting rows' titles in `scope`, in order. */
const rowTitles = (scope: Element) => [...scope.querySelectorAll(".setting-row-title")].map(text);
/** The setting row titled `title`: the row itself, or its frame while it carries a Saved check or a failure. */
const settingRow = (body: HTMLElement, title: string) => {
  const titleNode = [...body.querySelectorAll(".project-detail .setting-row-title")].find((node) => text(node) === title);
  assert.ok(titleNode, title);
  return (titleNode!.closest(".setting-row-frame") ?? titleNode!.closest(".setting-row")) as HTMLElement;
};
const fieldOf = (body: HTMLElement, title: string) => settingRow(body, title).querySelector<HTMLInputElement>("input")!;
const saveBar = (body: HTMLElement) => body.querySelector<HTMLElement>(".project-detail > .save-bar");
const saveBarButton = (body: HTMLElement, label: string) =>
  [...(saveBar(body)?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => text(button) === label);
const describedByText = (element: Element) => (element.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean)
  .map((id) => text(domWindow.document.getElementById(id) as unknown as Element));

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new domWindow.InputEvent("input", { bubbles: true }) as unknown as Event);
    // react-dom decided at import, before these globals existed, that input events are
    // unsupported, so it reads value changes on keyup.
    input.dispatchEvent(new domWindow.KeyboardEvent("keyup", { bubbles: true }) as unknown as Event);
  });
}
const leave = (input: HTMLInputElement) => act(async () => { input.blur(); });

/** A client whose project updates are recorded and answered with the project they describe. */
function recordingClient(base: ProjectView, fail: () => Error | null = () => null) {
  const updates: unknown[] = [];
  let current = base;
  const client = {
    ...api,
    updateProject: async (_id: string, body: Record<string, unknown>) => {
      updates.push(body);
      const failure = fail();
      if (failure) throw failure;
      current = { ...current, ...body, updatedAt: current.updatedAt + 1 } as ProjectView;
      return { project: current };
    },
  } as unknown as ApiClient;
  return { client, updates };
}

test("turning Show as a Sessions Tab off saves at once, shows Saved and the toast, and the filter counts it Hidden", async () => {
  toasts.length = 0;
  const alpha = project(1, { name: "Alpha" });
  const { client, updates } = recordingClient(alpha);
  const body = await renderSelected([alpha, project(2)], "Alpha", {}, client);
  const control = () => settingRow(body, "Show as a Sessions Tab").querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.equal(control().getAttribute("aria-checked"), "true", "on while the project is not hidden");
  assert.deepEqual(describedByText(control()), ["Adds a tab for this project above the Sessions list. Its sessions stay in All either way."]);
  await act(async () => { control().click(); });
  await settle();
  assert.deepEqual(updates, [{ hidden: true }], "one instant request, and the Sessions tabs leave out hidden projects (inbox.ts)");
  assert.equal(control().getAttribute("aria-checked"), "false");
  assert.equal(text(settingRow(body, "Show as a Sessions Tab").querySelector(".setting-row-saved")), "Saved");
  assert.deepEqual(toasts, ["Sessions tab hidden."]);
  assertNoDomNode(saveBar(body), "an instant setting never shows the save bar");
  const filter = body.querySelector('[role="radiogroup"][aria-label="Sessions Tabs"]');
  assert.deepEqual([...filter!.querySelectorAll('[role="radio"]')].map(text), ["All 2", "Shown 1", "Hidden 1"]);
  assert.equal([...body.querySelectorAll("button")].some((button) => /Hide Project|Show Project/u.test(text(button))), false);
  await act(async () => { control().click(); });
  await settle();
  assert.deepEqual(updates, [{ hidden: true }, { hidden: false }]);
  assert.deepEqual(toasts, ["Sessions tab hidden.", "Sessions tab shown."]);
});

test("a Sessions tab change that fails says so in the row with Try Again, and the switch keeps the saved value", async () => {
  let failing = true;
  const alpha = project(1, { name: "Alpha" });
  const { client, updates } = recordingClient(alpha, () => failing ? new Error("HTTP 500: database is locked") : null);
  const body = await renderSelected([alpha], "Alpha", {}, client);
  const row = () => settingRow(body, "Show as a Sessions Tab");
  await act(async () => { row().querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
  await settle();
  assert.match(text(row().querySelector(".setting-row-failure")), /^Couldn't hide the Sessions tab\. Try Again$/u);
  assert.equal(row().querySelector('[role="switch"]')!.getAttribute("aria-checked"), "true");
  assertNoDomNode(body.querySelector(".master-detail-detail .notice.t-danger"), "the row says it; no page notice");
  failing = false;
  const retry = [...row().querySelectorAll<HTMLButtonElement>("button")].find((button) => text(button) === "Try Again")!;
  await act(async () => { retry.click(); });
  await settle();
  assert.deepEqual(updates, [{ hidden: true }, { hidden: true }]);
  assert.equal(row().querySelector('[role="switch"]')!.getAttribute("aria-checked"), "false");
  assertNoDomNode(row().querySelector(".setting-row-failure"));
});

test("a typed name shows the save bar; Discard restores it; Save sends only the name and hides the bar", async () => {
  const alpha = { ...project(1, { name: "Alpha" }), childSessionDefaults: { costBudgetUsd: 5, maxToolCalls: 100 } };
  const { client, updates } = recordingClient(alpha);
  const body = await renderSelected([alpha], "Alpha", {}, client);
  assertNoDomNode(saveBar(body), "no bar while clean");
  await type(fieldOf(body, "Name"), "Alpha Renamed");
  assert.equal(text(saveBar(body)?.querySelector(".save-bar-message")), "Unsaved changes");
  await act(async () => { saveBarButton(body, "Discard")!.click(); });
  assert.equal(fieldOf(body, "Name").value, "Alpha");
  assertNoDomNode(saveBar(body), "Discard hides the bar");
  await type(fieldOf(body, "Name"), "  Alpha Renamed ");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await settle();
  assert.deepEqual(updates, [{ name: "Alpha Renamed" }], "one request with only the changed field, trimmed");
  assert.equal(fieldOf(body, "Name").value, "Alpha Renamed");
  assertNoDomNode(saveBar(body), "the bar goes once it saved");
});

test("an empty name shows its error in the description's place on leaving it, and Save is blocked until it is fixed", async () => {
  const alpha = project(1, { name: "Alpha" });
  const { client, updates } = recordingClient(alpha);
  const body = await renderSelected([alpha], "Alpha", {}, client);
  const name = () => fieldOf(body, "Name");
  await type(name(), " ");
  assertNoDomNode(settingRow(body, "Name").querySelector(".field-error"), "not while typing");
  await leave(name());
  const error = settingRow(body, "Name").querySelector(".setting-row-desc-slot.is-failed .field-error");
  assert.equal(text(error), "Enter a name for the project.");
  assert.equal(name().getAttribute("aria-invalid"), "true");
  assert.deepEqual(describedByText(name()), ["Enter a name for the project."]);
  assert.equal(text(saveBar(body)?.querySelector(".save-bar-message")), "Fix 1 field to save");
  assert.equal(saveBarButton(body, "Save")!.getAttribute("aria-disabled"), "true");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await type(name(), "x".repeat(121));
  assert.equal(text(settingRow(body, "Name").querySelector(".field-error")), "Use 120 characters or fewer.");
  await type(name(), "Beta");
  assertNoDomNode(settingRow(body, "Name").querySelector(".field-error"), "the error clears as a valid name is typed");
  assert.equal(saveBarButton(body, "Save")!.getAttribute("aria-disabled"), null);
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await settle();
  assert.deepEqual(updates, [{ name: "Beta" }]);
});

test("the limit fields are 96px fields, the cost with USD inside, and -2 shows its error in the helper's place", async () => {
  const alpha = { ...project(1, { name: "Alpha" }), childSessionDefaults: null };
  const { client, updates } = recordingClient(alpha);
  const body = await renderSelected([alpha], "Alpha", {}, client);
  const cost = () => fieldOf(body, "Cost Limit per Child");
  const tools = () => fieldOf(body, "Tool Calls per Child");
  for (const field of [cost(), tools()]) {
    assert.ok(field.closest(".input-affix")!.classList.contains("w-xs"), "a 96px .w-xs field");
    assert.equal(field.placeholder, "No limit");
    assert.equal(field.type, "text", "text the field cannot read is an error, never an empty value");
  }
  assert.equal(text(settingRow(body, "Cost Limit per Child").querySelector(".input-affix-text")), "USD");
  assertNoDomNode(settingRow(body, "Tool Calls per Child").querySelector(".input-affix-text"), "no unit");
  assert.equal(text(settingRow(body, "Cost Limit per Child").querySelector(".setting-row-desc")), "Leave both empty for no limits.");
  assert.equal(text(settingRow(body, "Tool Calls per Child").querySelector(".setting-row-desc")), "A whole number.");
  await type(cost(), "-2");
  await leave(cost());
  const row = settingRow(body, "Cost Limit per Child");
  assert.equal(text(row.querySelector(".setting-row-desc-slot.is-failed .field-error")), "Enter an amount above 0.");
  assertNoDomNode(row.querySelector(".setting-row-control .field-error"), "in the helper's place, not under the field");
  assert.equal(cost().getAttribute("aria-invalid"), "true");
  assert.equal(saveBarButton(body, "Save")!.getAttribute("aria-disabled"), "true");
  assert.equal(text(saveBar(body)?.querySelector(".save-bar-message")), "Fix 1 field to save");
  await type(cost(), "2.5");
  assert.equal(saveBarButton(body, "Save")!.getAttribute("aria-disabled"), null, "fixed, Save is back");
  // The tool-call limit is still empty: Save shows its error and moves focus there.
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await settle();
  assert.deepEqual(updates, [], "nothing is sent while a field is invalid");
  assert.equal(text(settingRow(body, "Tool Calls per Child").querySelector(".field-error")),
    "Enter a tool-call limit too, or clear both for no limits.");
  assert.ok(domWindow.document.activeElement as unknown as Element === tools(), "focus moves to the first invalid field");
  await type(tools(), "1.5");
  assert.equal(text(settingRow(body, "Tool Calls per Child").querySelector(".field-error")), "Enter a whole number above 0.");
  await type(tools(), "30");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await settle();
  assert.deepEqual(updates, [{ childSessionDefaults: { costBudgetUsd: 2.5, maxToolCalls: 30 } }], "both limits in one request");
  assertNoDomNode(saveBar(body));
});

test("Clear Limits shows only while limits are set, empties both fields, and saving sends childSessionDefaults: null", async () => {
  const alpha = { ...project(1, { name: "Alpha" }), childSessionDefaults: { costBudgetUsd: 5, maxToolCalls: 100 } };
  const { client, updates } = recordingClient(alpha);
  const body = await renderSelected([alpha], "Alpha", {}, client);
  const limits = () => [...body.querySelectorAll(".project-detail > section")].find((section) =>
    text(section.querySelector(".section-title")) === "Child Session Defaults")!;
  const clear = () => [...limits().querySelectorAll<HTMLButtonElement>(".section-head button")].find((button) => text(button) === "Clear Limits");
  assert.ok(clear()?.classList.contains("ghost") && clear()!.classList.contains("sm"), "a .btn.sm.ghost in the section head");
  assert.equal(fieldOf(body, "Cost Limit per Child").value, "5");
  await act(async () => { clear()!.click(); });
  assert.equal(fieldOf(body, "Cost Limit per Child").value, "");
  assert.equal(fieldOf(body, "Tool Calls per Child").value, "");
  assert.equal(clear(), undefined, "no limits are set in the draft");
  assert.ok(domWindow.document.activeElement as unknown as Element === fieldOf(body, "Cost Limit per Child"),
    "focus goes to the first field it emptied");
  assert.equal(text(saveBar(body)?.querySelector(".save-bar-message")), "Unsaved changes");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await settle();
  assert.deepEqual(updates, [{ childSessionDefaults: null }]);
  assertNoDomNode(saveBar(body));
  assert.equal(clear(), undefined);
});

test("a failed save keeps the typed values and turns the bar into its error with Try Again", async () => {
  let failing = true;
  const alpha = { ...project(1, { name: "Alpha" }), childSessionDefaults: null };
  const { client, updates } = recordingClient(alpha, () => failing ? new Error("HTTP 500: database is locked") : null);
  const body = await renderSelected([alpha], "Alpha", {}, client);
  await type(fieldOf(body, "Name"), "Alpha Two");
  await type(fieldOf(body, "Cost Limit per Child"), "3");
  await type(fieldOf(body, "Tool Calls per Child"), "40");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await settle();
  assert.deepEqual(updates, [{ name: "Alpha Two", childSessionDefaults: { costBudgetUsd: 3, maxToolCalls: 40 } }],
    "one request for every changed field");
  const bar = saveBar(body)!;
  assert.ok(bar.classList.contains("is-error"));
  assert.equal(bar.getAttribute("role"), "alert");
  assert.equal(text(bar.querySelector(".save-bar-message")), "Couldn't save the changes. Nothing was changed.");
  assert.deepEqual([fieldOf(body, "Name").value, fieldOf(body, "Cost Limit per Child").value, fieldOf(body, "Tool Calls per Child").value],
    ["Alpha Two", "3", "40"]);
  assertNoDomNode(body.querySelector(".master-detail-detail .notice.t-danger"), "the bar says it; no page notice");
  failing = false;
  await act(async () => { saveBarButton(body, "Try Again")!.click(); });
  await settle();
  assert.equal(updates.length, 2);
  assertNoDomNode(saveBar(body));
});

test("leaving a project with unsaved settings asks first, and Keep Editing stays with the draft", async () => {
  confirmations.length = 0;
  const alpha = project(1, { name: "Alpha" });
  const body = await renderSelected([alpha, project(2)], "Alpha");
  await type(fieldOf(body, "Name"), "Alpha Draft");
  confirmAnswer = false;
  try {
    await act(async () => { rows(body).find((row) => text(row.querySelector(".row-title")) === "Project 2")!.click(); });
    await settle();
  } finally {
    confirmAnswer = true;
  }
  assert.deepEqual(confirmations, ["Discard Changes"]);
  assert.deepEqual(currentView, { name: "projects", id: "project-1" });
  assert.equal(fieldOf(body, "Name").value, "Alpha Draft");
  await act(async () => { rows(body).find((row) => text(row.querySelector(".row-title")) === "Project 2")!.click(); });
  await settle();
  assert.deepEqual(currentView, { name: "projects", id: "project-2" });
  assert.equal(fieldOf(body, "Name").value, "Project 2", "another project starts with no draft");
});

/** A client whose project updates wait until the test settles each one, in order. */
function heldClient(base: ProjectView) {
  const updates: unknown[] = [];
  const held: (() => void)[] = [];
  let current = base;
  const client = {
    ...api,
    updateProject: (_id: string, body: Record<string, unknown>) => {
      updates.push(body);
      return new Promise((resolve) => {
        held.push(() => {
          current = { ...current, ...body, updatedAt: current.updatedAt + 1 } as ProjectView;
          resolve({ project: current });
        });
      });
    },
  } as unknown as ApiClient;
  const settleNext = async () => {
    await act(async () => { held.shift()!(); });
    await settle();
  };
  return { client, updates, settleNext };
}
const projectRow = (body: HTMLElement, name: string) => rows(body).find((row) => text(row.querySelector(".row-title")) === name)!;

test("a save in flight keeps leaving guarded: a name typed back to the saved one is asked about once the save settles", async () => {
  confirmations.length = 0;
  const { client, updates, settleNext } = heldClient(project(1, { name: "Alpha" }));
  const body = await renderSelected([project(1, { name: "Alpha" }), project(2)], "Alpha", {}, client);
  await type(fieldOf(body, "Name"), "Beta");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  // Typed back to the saved name while the rename is on its way: the draft reads clean.
  await type(fieldOf(body, "Name"), "Alpha");
  assert.ok(saveBar(body), "the bar stays up while the save runs");
  await act(async () => { projectRow(body, "Project 2").click(); });
  await settle();
  assert.deepEqual(currentView, { name: "projects", id: "project-1" }, "leaving waits for the save");
  assert.deepEqual(confirmations, [], "nothing to ask about until the save settles");
  confirmAnswer = false;
  try {
    await settleNext();
  } finally {
    confirmAnswer = true;
  }
  assert.deepEqual(confirmations, ["Discard Changes"], "Alpha now differs from the saved Beta");
  assert.deepEqual(currentView, { name: "projects", id: "project-1" }, "Keep Editing stays");
  assert.equal(fieldOf(body, "Name").value, "Alpha");
  assert.equal(text(saveBar(body)?.querySelector(".save-bar-message")), "Unsaved changes");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await settleNext();
  assert.deepEqual(updates, [{ name: "Beta" }, { name: "Alpha" }], "the typed-back name is still savable");
  assertNoDomNode(saveBar(body));
});

test("leaving during a save that leaves nothing behind goes ahead once it settles, without asking", async () => {
  confirmations.length = 0;
  const { client, settleNext } = heldClient(project(1, { name: "Alpha" }));
  const body = await renderSelected([project(1, { name: "Alpha" }), project(2)], "Alpha", {}, client);
  await type(fieldOf(body, "Name"), "Beta");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await act(async () => { projectRow(body, "Project 2").click(); });
  await settle();
  assert.deepEqual(currentView, { name: "projects", id: "project-1" });
  await settleNext();
  assert.deepEqual(confirmations, []);
  assert.deepEqual(currentView, { name: "projects", id: "project-2" });
});

test("a field left invalid while a save ran keeps its error, aria-invalid and the blocked Save after it settles", async () => {
  const alpha = { ...project(1, { name: "Alpha" }), childSessionDefaults: null };
  const { client, updates, settleNext } = heldClient(alpha);
  const body = await renderSelected([alpha], "Alpha", {}, client);
  await type(fieldOf(body, "Name"), "Beta");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await type(fieldOf(body, "Cost Limit per Child"), "-2");
  await leave(fieldOf(body, "Cost Limit per Child"));
  await settleNext();
  assert.deepEqual(updates, [{ name: "Beta" }]);
  const cost = fieldOf(body, "Cost Limit per Child");
  assert.equal(cost.value, "-2", "the edit made during the save stays");
  assert.equal(text(settingRow(body, "Cost Limit per Child").querySelector(".field-error")), "Enter an amount above 0.");
  assert.equal(cost.getAttribute("aria-invalid"), "true");
  assert.equal(text(saveBar(body)?.querySelector(".save-bar-message")), "Fix 1 field to save",
    "the empty tool-call limit was never edited, so it waits for its own leave or the next Save");
  assert.equal(saveBarButton(body, "Save")!.getAttribute("aria-disabled"), "true");
  assertNoDomNode(settingRow(body, "Name").querySelector(".field-error"), "the saved name has nothing left to say");
});

test("Save pressed while a Sessions tab change runs saves once that change settles", async () => {
  const { client, updates, settleNext } = heldClient(project(1, { name: "Alpha" }));
  const body = await renderSelected([project(1, { name: "Alpha" })], "Alpha", {}, client);
  await act(async () => { settingRow(body, "Show as a Sessions Tab").querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
  await type(fieldOf(body, "Name"), "Beta");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  assert.deepEqual(updates, [{ hidden: true }], "one request at a time");
  await settleNext();
  assert.deepEqual(updates, [{ hidden: true }, { name: "Beta" }], "the press was kept, not dropped");
  await settleNext();
  assertNoDomNode(saveBar(body));
});

test("a viewer sees the rows read-only: no Clear Limits, and the switch disabled with its reason", async () => {
  const shared = { ...project(6, { name: "Shared", canManage: false }), childSessionDefaults: { costBudgetUsd: 5, maxToolCalls: 100 } };
  const body = await renderSelected([shared], "Shared");
  for (const title of ["Name", "Cost Limit per Child", "Tool Calls per Child"]) {
    const field = fieldOf(body, title);
    assert.equal(field.readOnly, true, title);
    assert.equal(field.disabled, false, `${title} stays in the tab order`);
    assert.ok(field.classList.contains("is-read-only"), `${title} has the read-only treatment`);
  }
  const control = settingRow(body, "Show as a Sessions Tab").querySelector<HTMLButtonElement>('[role="switch"]')!;
  assert.equal(control.disabled, true);
  assert.equal(text(settingRow(body, "Show as a Sessions Tab").querySelector(".setting-row-reason")), "You can't change this project.");
  assert.equal([...body.querySelectorAll("button")].some((button) => text(button) === "Clear Limits"), false);
});

test("⋯ lists Copy Project ID, the archive item, a separator and Delete Project… last in danger text", async () => {
  const body = await renderSelected([busyProject()], "Project 1");
  const menu = await openProjectActions(body.querySelector(".project-detail-title-row")!);
  assert.deepEqual(menuItems(menu), [
    { label: "Copy Project ID", reason: null, disabled: false, danger: false },
    { label: "Archive Sessions…", reason: null, disabled: false, danger: false },
    { label: "Delete Project…", reason: null, disabled: false, danger: true },
  ]);
  const children = [...menu.querySelectorAll(".menu-item, .menu-sep")].map((node) => node.classList.contains("menu-sep") ? "separator" : text(node.querySelector(".menu-text")));
  assert.deepEqual(children, ["Copy Project ID", "Archive Sessions…", "separator", "Delete Project…"]);
});

test("with no sessions, the archive item is disabled and says why", async () => {
  const body = await renderSelected([project(0, { name: "Quiet" })], "Quiet");
  const menu = await openProjectActions(body.querySelector(".project-detail-title-row")!);
  assert.deepEqual(menuItems(menu)[1], { label: "Archive Sessions…", reason: "No sessions to archive.", disabled: true, danger: false });
});

test("the archive item says it stops sessions when archiving would stop one", () => {
  const actions = { onCopyId() {}, onArchive() {}, onDelete() {} };
  assert.equal(projectDetailMenu(project(2), { stopsRuntime: true, busy: false }, actions)[1]!.label, "Archive and Stop Sessions…");
  assert.equal(projectDetailMenu(project(2), { stopsRuntime: false, busy: false }, actions)[1]!.label, "Archive Sessions…");
});

test("Copy Project ID copies the id and confirms it", async () => {
  const toasts: { message: string; detail?: string }[] = [];
  const prior = feedback.showToast;
  feedback.showToast = ((message: string, options?: { detail?: string }) => { toasts.push({ message, detail: options?.detail }); return 1; }) as never;
  const written: string[] = [];
  Object.defineProperty(domWindow.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { written.push(value); } } });
  try {
    const body = await renderSelected([busyProject()], "Project 1");
    const menu = await openProjectActions(body.querySelector(".project-detail-title-row")!);
    const copy = [...menu.querySelectorAll<HTMLButtonElement>(".menu-item")].find((item) => text(item) === "Copy Project ID")!;
    await act(async () => { copy.click(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(written, ["project-1"]);
    assert.deepEqual(toasts.at(-1), { message: "Project ID copied.", detail: "project-1" });
  } finally {
    feedback.showToast = prior;
  }
});

test("with no locations New Session is disabled and the reason shows under the title", async () => {
  const body = await renderSelected([project(4, { name: "Empty", locations: [] })], "Empty");
  const button = [...body.querySelectorAll<HTMLButtonElement>(".project-detail-title-row button")].find((candidate) => text(candidate) === "New Session")!;
  assert.equal(button.disabled, true);
  assert.equal(text(body.querySelector(".project-detail-head .project-detail-blocker")), "Add a location to start sessions.");
});

test("when its only location is offline the reason names the machine", async () => {
  const offline = project(5, {
    name: "Remote",
    locations: [{ ...project(5).locations[0]!, availability: "runner_offline" }],
  });
  const body = await renderSelected([offline], "Remote", { runners: [{ ...runner, status: "offline" }] });
  const button = [...body.querySelectorAll<HTMLButtonElement>(".project-detail-title-row button")].find((candidate) => text(candidate) === "New Session")!;
  assert.equal(button.disabled, true);
  assert.equal(text(body.querySelector(".project-detail-blocker")), "Build Machine is offline, so new sessions can't start.");
});

test("a viewer sees the neutral notice, New Session and only Copy Project ID", async () => {
  const body = await renderSelected([project(6, { name: "Shared", canManage: false })], "Shared");
  const notice = body.querySelector(".master-detail-detail .notice.t-neutral");
  assert.ok(notice?.classList.contains("compact"), "a compact notice");
  assert.equal(text(notice), "You can view this project, but you can't change it.");
  const button = [...body.querySelectorAll<HTMLButtonElement>(".project-detail-title-row button")].find((candidate) => text(candidate) === "New Session")!;
  assert.equal(button.disabled, false);
  const menu = await openProjectActions(body.querySelector(".project-detail-title-row")!);
  assert.deepEqual(menuItems(menu).map((item) => item.label), ["Copy Project ID"]);
});

test("a failed project action is a danger notice: the sentence first, the raw message behind Show Details", async () => {
  const client = { ...api, setDefaultProjectLocation: async () => { throw new Error("HTTP 500: database is locked"); } } as ApiClient;
  const body = await renderSelected([busyProject()], "Project 1", {}, client);
  await act(async () => { body.querySelector<HTMLButtonElement>('button[aria-label="Location 1 Actions"]')!.click(); });
  const makeDefault = [...(domWindow.document as unknown as Document).querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((item) => text(item.querySelector(".menu-text")) === "Make Default")!;
  await act(async () => { makeDefault.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assertNoDomNode(body.querySelector(".project-manager-error"), "no bare form error");
  const notice = body.querySelector(".master-detail-detail .notice.t-danger");
  assert.ok(notice, "a danger notice");
  assert.equal(notice!.getAttribute("role"), "alert");
  assert.match(text(notice), /^Couldn't make that location the default\./);
  assert.doesNotMatch(text(notice), /database is locked/, "the raw message waits behind Show Details");
  const toggle = [...notice!.querySelectorAll<HTMLButtonElement>("button")].find((button) => text(button) === "Show Details")!;
  await act(async () => { toggle.click(); });
  assert.match(text(notice), /HTTP 500: database is locked/);
});

test("on a phone the detail bar carries New Session and the same ⋯ items, and the title row is not repeated", async () => {
  const restore = stubPhone();
  try {
    newSessionPresets.length = 0;
    const body = await renderSelected([busyProject()], "Project 1");
    const bar = body.querySelector(".detail-bar")!;
    assert.equal(text(bar.querySelector("h1")), "Project 1");
    assertNoDomNode(body.querySelector(".project-detail-title-row"), "the body has no second title row");
    assert.ok(body.querySelector(".project-detail-meta"), "the meta line stays");
    const primary = bar.querySelector<HTMLButtonElement>(".detail-bar-action.primary")!;
    assert.equal(text(primary.querySelector(".detail-bar-action-label")), "New Session");
    await act(async () => { primary.click(); });
    assert.equal(newSessionPresets.at(-1)?.projectLocationId, "location-1b");
    const menu = await openProjectActions(bar);
    assert.deepEqual(menuItems(menu).map((item) => item.label), ["Copy Project ID", "Archive Sessions…", "Delete Project…"]);
  } finally {
    restore();
  }
});


/* --- The Projects Overview (#2958) --- */

const offlineRunner: RunnerView = {
  ...runner,
  runnerId: "runner-2",
  hostname: "studio-host",
  displayName: "Studio Mac",
  status: "offline",
  workspaces: [{ id: "workspace-docs", name: "Docs", path: "/repos/docs" }],
};

/** Docs Site only on the offline machine, Edge Proxy with no locations, and two projects named Field App. */
function attentionProjects(): ProjectView[] {
  return [
    project(1, { name: "Alpha" }),
    project(2, {
      id: "docs", name: "Docs Site",
      locations: [{ ...project(2).locations[0]!, id: "location-docs", projectId: "docs", runnerId: "runner-2", workspaceId: "workspace-docs", availability: "runner_offline" }],
    }),
    project(3, { id: "edge", name: "Edge Proxy", locations: [] }),
    project(4, { id: "field-1", name: "Field App" }),
    project(5, { id: "field-2", name: "Field App" }),
  ];
}

const overview = (body: HTMLElement) => body.querySelector(".master-detail-detail > .projects-overview");
const overviewSection = (body: HTMLElement, title: string) => [...body.querySelectorAll(".projects-overview > section")]
  .find((section) => text(section.querySelector(".section-title")).startsWith(title)) ?? null;
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };

test("at 1440px with no selection the detail is the Projects Overview with its count line, never Select a Project", async () => {
  const body = await render({
    projects: [busyProject(), project(2, { activeSessionCount: 1 }), project(3, { locations: [] })],
    runners: [runner, offlineRunner],
  });
  assert.ok(overview(body), "the overview is the default detail");
  assert.equal(text(body.querySelector(".projects-overview-title")), "Projects Overview");
  assert.equal(body.querySelector(".projects-overview-title")!.tagName, "H2");
  assert.equal(text(body.querySelector(".projects-overview-summary")), "3 projects on 1 machine, with 16 sessions. 2 are running now.");
  assert.doesNotMatch(text(body), /Select a Project/);
  assertNoDomNode(body.querySelector(".master-detail-detail .project-manager-empty"), "the placeholder is gone");
  assertNoDomNode(body.querySelector(".project-list-overview"), "only a phone's list leads with an overview row");
});

test("an offline project, a project with no locations and a shared name are each one Needs Attention row with its action", async () => {
  const body = await render({ projects: attentionProjects(), runners: [runner, offlineRunner] });
  const section = overviewSection(body, "Needs Attention")!;
  assert.equal(text(section.querySelector(".projects-overview-count")), "3", "a plain count");
  const surface = section.querySelector(":scope > .surface")!;
  const items = [...surface.querySelectorAll(":scope > .row.row-2")].map((row) => ({
    title: text(row.querySelector(".row-title")),
    badge: row.querySelector(".status") ? text(row.querySelector(".status")) : null,
    reason: text(row.querySelector(".row-sub")),
    action: [...row.querySelectorAll("button")].map((button) => `${text(button)} (${button.getAttribute("aria-label")})`),
  }));
  assert.deepEqual(items, [
    { title: "Docs Site", badge: "Runner Offline", reason: "Studio Mac is offline, so this project can't start sessions.", action: ["Open (Open Docs Site)"] },
    { title: "Edge Proxy", badge: null, reason: "No locations yet, so it can't start sessions.", action: ["Add Location… (Add Location to Edge Proxy)"] },
    { title: "2 Projects Named Field App", badge: null, reason: "Rename one so they're easy to tell apart in lists and pickers.", action: ["Rename… (Rename Field App)"] },
  ]);
  assertNoDomNode(section.querySelector(".projects-overview-ok"), "no all-clear beside problems");

  await act(async () => { surface.querySelector<HTMLButtonElement>('button[aria-label="Open Docs Site"]')!.click(); });
  await settle();
  assert.deepEqual(currentView, { name: "projects", id: "docs" });
  assert.equal(text(body.querySelector(".project-detail-title")), "Docs Site");
});

test("Add Location… opens Add Location for that project, over the overview", async () => {
  const body = await render({ projects: attentionProjects(), runners: [runner, offlineRunner] });
  await act(async () => { body.querySelector<HTMLButtonElement>('button[aria-label="Add Location to Edge Proxy"]')!.click(); });
  await settle();
  const dialog = domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  assert.ok(dialog, "Add Location is open");
  assert.equal(text(dialog!.querySelector(".modal-title, h2")), "Add Location to Edge Proxy");
  assert.deepEqual(currentView, { name: "projects" }, "the overview stays behind it");
});

test("Rename… opens the first project of a shared name with its Name field focused", async () => {
  const body = await render({ projects: attentionProjects(), runners: [runner, offlineRunner] });
  await act(async () => { body.querySelector<HTMLButtonElement>('button[aria-label="Rename Field App"]')!.click(); });
  await settle();
  assert.deepEqual(currentView, { name: "projects", id: "field-1" });
  const name = fieldOf(body, "Name");
  assert.equal(name?.value, "Field App");
  assert.ok(domWindow.document.activeElement as unknown as Element | null === name, "the Name field has focus");
});

test("a project the person can't change offers Open, not Add Location… or Rename…", async () => {
  const body = await render({ projects: [project(1, { name: "Shared", locations: [], canManage: false })] });
  const row = overviewSection(body, "Needs Attention")!.querySelector(".surface > .row")!;
  assert.deepEqual([...row.querySelectorAll("button")].map(text), ["Open"]);
});

test("with nothing needing attention, Needs Attention is the one green-dot line", async () => {
  const body = await render({ projects: [project(1), project(2), project(3)] });
  const section = overviewSection(body, "Needs Attention")!;
  assertNoDomNode(section.querySelector(".surface"), "no empty surface");
  assertNoDomNode(section.querySelector(".projects-overview-count"), "no count of zero");
  const ok = section.querySelector(".projects-overview-ok")!;
  assert.equal(text(ok), "Every project can start sessions.");
  assert.equal(ok.querySelector(".projects-overview-dot")?.getAttribute("aria-hidden"), "true");
});

test("Most Active lists at most five projects, most sessions first, each opening its project", async () => {
  const counts = [4, 0, 9, 2, 7, 1, 12];
  const projects = counts.map((count, index) => project(index + 1, { unarchivedSessionCount: count, activeSessionCount: index === 6 ? 2 : 0 }));
  const body = await render({ projects });
  const section = overviewSection(body, "Most Active")!;
  const items = [...section.querySelectorAll<HTMLButtonElement>(".surface > button.row.row-2")];
  assert.deepEqual(items.map((row) => [text(row.querySelector(".row-title")), text(row.querySelector(".row-trail")), text(row.querySelector(".row-sub"))]), [
    ["Project 7", "12 sessions, 2 running", "Build Machine"],
    ["Project 3", "9 sessions", "Build Machine"],
    ["Project 5", "7 sessions", "Build Machine"],
    ["Project 1", "4 sessions", "Build Machine"],
    ["Project 4", "2 sessions", "Build Machine"],
  ]);
  await act(async () => { items[1]!.click(); });
  await settle();
  assert.deepEqual(currentView, { name: "projects", id: "project-3" });
  assert.equal(text(body.querySelector(".project-detail-title")), "Project 3");
});

test("with two projects Get Started offers New Project and Connect a Machine as secondary buttons", async () => {
  const body = await render({ projects: [project(1), project(2)] });
  const section = overviewSection(body, "Get Started");
  assert.ok(section, "Get Started");
  const items = [...section!.querySelectorAll("li")];
  assert.deepEqual(items.map((item) => text(item.querySelector("button"))), ["New Project", "Connect a Machine"]);
  assert.ok(items.every((item) => text(item.querySelector(".projects-overview-hint")).length > 0), "one line each");
  assert.ok(items.every((item) => !item.querySelector("button")!.classList.contains("primary")), "secondary buttons");
  await act(async () => { items[0]!.querySelector<HTMLButtonElement>("button")!.click(); });
  assert.ok(domWindow.document.querySelector('[role="dialog"]'), "New Project opens its dialog");
});

test("with three projects there is no Get Started", async () => {
  const body = await render({ projects: [project(1), project(2), project(3)] });
  assert.ok(overview(body));
  assertNoDomNode(overviewSection(body, "Get Started"), "no Get Started from three projects");
});

test("on a phone the list's first row opens /projects/overview under a Projects Overview detail bar, and Back returns", async () => {
  const restore = stubPhone();
  try {
    const body = await render({ projects: attentionProjects(), runners: [runner, offlineRunner] });
    assert.equal(body.querySelector(".master-detail")?.hasAttribute("data-detail-open"), false, "the list is the screen");
    const first = body.querySelector<HTMLButtonElement>(".master-detail-list-body > .row")!;
    assert.ok(first.classList.contains("project-list-overview"));
    assert.equal(text(first.querySelector(".row-title")), "Projects Overview");
    assert.equal(text(first.querySelector(".count-badge")), "3", "the same count as Needs Attention");
    assert.equal(text(body.querySelector(`#${first.getAttribute("aria-describedby")}`)), "3 items need attention");

    await act(async () => { first.click(); });
    await settle();
    assert.deepEqual(currentView, { name: "projects", pane: "overview" });
    assert.equal(text(body.querySelector(".detail-bar h1#page-title")), "Projects Overview");
    assert.ok(body.querySelector(".master-detail[data-detail-open] .master-detail-detail > .projects-overview"));
    assertNoDomNode(body.querySelector(".projects-overview-title"), "the detail bar already names the route");
    assertNoDomNode(body.querySelector(".detail-bar .detail-bar-action.primary"), "no New Session on the overview");

    await act(async () => { body.querySelector<HTMLButtonElement>(".detail-bar-back")!.click(); });
    await settle();
    assert.deepEqual(currentView, { name: "projects" });
    assert.equal(body.querySelector(".master-detail")?.hasAttribute("data-detail-open"), false);
  } finally {
    restore();
  }
});


/* --- Memory Sharing (#2963) --- */

const claudeAgent = (version: string): RunnerView["agents"][number] => ({
  id: `claude-${version}`, name: "Claude", command: "claude", args: [], env: {},
  driver: "claude-code", context: { kind: "native" }, version, available: true,
});
/** Four machines, one in each of the policy's states. */
const memoryRunners: RunnerView[] = [
  { ...runner, runnerId: "runner-ready", displayName: "Ready Machine", agents: [claudeAgent("2.1.284")] },
  { ...runner, runnerId: "runner-old", displayName: "Old Machine", agents: [claudeAgent("2.1.284")], protocolVersion: 194 },
  { ...runner, runnerId: "runner-claude", displayName: "Old Claude Machine", agents: [claudeAgent("2.1.283")] },
  { ...runner, runnerId: "runner-away", displayName: "Away Machine", agents: [claudeAgent("2.1.284")], status: "offline" },
];
function memoryProject(options: Partial<ProjectView> = {}): ProjectView {
  const base = project(1, { name: "Alpha", memorySharing: "separate" });
  return {
    ...base,
    locations: memoryRunners.map((machine, index) => ({
      ...base.locations[0]!, id: `location-${machine.runnerId}`, runnerId: machine.runnerId, name: `Location ${index + 1}`,
      isDefault: index === 0,
    })),
    ...options,
  };
}
const memorySection = (body: HTMLElement) => [...body.querySelectorAll<HTMLElement>(".project-detail > section")]
  .find((section) => text(section.querySelector(".section-title")) === "Memory Sharing")!;
const memoryTrigger = (body: HTMLElement) =>
  memorySection(body).querySelector<HTMLButtonElement>('button[aria-label^="Memory Sharing:"]');
const consentNotice = (body: HTMLElement) => [...memorySection(body).querySelectorAll(".notice")]
  .find((notice) => text(notice).startsWith("A conversation keeps its history")) ?? null;
async function chooseMemorySharing(body: HTMLElement, label: string) {
  await act(async () => memoryTrigger(body)!.click());
  const option = [...domWindow.document.querySelectorAll('[role="option"]')]
    .find((node) => node.textContent?.startsWith(label)) as unknown as HTMLElement | undefined;
  assert.ok(option, `Memory Sharing offers ${label}`);
  await act(async () => option!.click());
}

test("Memory Sharing is one sentence, one row, the machine rows and a closed About, and no other paragraph", async () => {
  const body = await renderSelected([memoryProject()], "Alpha", { runners: memoryRunners });
  const section = memorySection(body);
  assert.equal(text(section.querySelector(":scope > .section-note")),
    "Whether this project's Claude accounts on the same machine share saved memory.");
  assert.deepEqual(rowTitles(section), ["Memory Sharing"]);
  assert.equal(memoryTrigger(body)!.getAttribute("aria-label"), "Memory Sharing: Keep Separate");
  assert.equal(section.querySelectorAll(".project-memory-machine").length, 4);
  const about = section.querySelector<HTMLDetailsElement>(":scope > details.disclosure")!;
  assert.equal(text(about.querySelector("summary")), "About Memory Sharing");
  assert.equal(about.open, false, "About starts closed");
  assert.deepEqual([...section.querySelectorAll("p")].filter((paragraph) => !about.contains(paragraph)).map(text),
    ["Whether this project's Claude accounts on the same machine share saved memory."],
    "the details are behind About; nothing else is a paragraph");
  assert.equal(section.querySelectorAll(".notice").length, 0, "no notice while the saved choice is shown");
  assert.doesNotMatch(text(body), /Saved Choice:|Save Memory Policy/u);
  assert.equal([...body.querySelectorAll("button")].some((button) => text(button) === "Save Memory Policy"), false);
  assertNoDomNode(saveBar(body), "no save bar while clean");
});

test("choosing Share Project Memory shows the consent notice and the save bar; Discard removes both", async () => {
  const alpha = memoryProject();
  const { client, updates } = recordingClient(alpha);
  const body = await renderSelected([alpha], "Alpha", { runners: memoryRunners }, client);
  await act(async () => memoryTrigger(body)!.click());
  const options = [...domWindow.document.querySelectorAll('[role="option"]')] as unknown as HTMLElement[];
  const labelledByText = (element: Element) => (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u).filter(Boolean)
    .map((id) => text(domWindow.document.getElementById(id) as unknown as Element)).join(" ");
  assert.deepEqual(options.map((option) => [labelledByText(option), describedByText(option)]), [
    ["Keep Account Memories Separate", ["Each account keeps its own saved memory."]],
    ["Share Project Memory", ["Accounts on the same machine use this project's shared memory."]],
  ], "the list names each choice in full, with its sentence");
  await act(async () => memoryTrigger(body)!.click());
  await chooseMemorySharing(body, "Share Project Memory");
  assert.equal(memoryTrigger(body)!.getAttribute("aria-label"), "Memory Sharing: Share Project Memory");
  assert.equal(text(consentNotice(body)),
    "A conversation keeps its history when it switches accounts, and that history may already contain memories. "
    + "Sharing can't remove it, or stop a provider learning from the conversation under its own settings.");
  assert.ok(consentNotice(body)!.classList.contains("t-info"));
  assert.equal(text(saveBar(body)?.querySelector(".save-bar-message")), "Unsaved changes");
  await act(async () => { saveBarButton(body, "Discard")!.click(); });
  assert.equal(memoryTrigger(body)!.getAttribute("aria-label"), "Memory Sharing: Keep Separate");
  assertNoDomNode(consentNotice(body), "Discard removes the consent notice");
  assertNoDomNode(saveBar(body), "and the save bar");
  // Chosen and chosen back reads clean.
  await chooseMemorySharing(body, "Share Project Memory");
  await chooseMemorySharing(body, "Keep Account Memories Separate");
  assertNoDomNode(saveBar(body));
  assert.deepEqual(updates, [], "nothing is saved without Save");
});

test("Save sends memorySharing: \"shared\" in the same request as the other changed fields, then the notice goes", async () => {
  const alpha = memoryProject();
  const { client, updates } = recordingClient(alpha);
  const body = await renderSelected([alpha], "Alpha", { runners: memoryRunners }, client);
  await type(fieldOf(body, "Name"), "Alpha Renamed");
  await chooseMemorySharing(body, "Share Project Memory");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await settle();
  assert.deepEqual(updates, [{ name: "Alpha Renamed", memorySharing: "shared" }], "one request");
  assert.equal(memoryTrigger(body)!.getAttribute("aria-label"), "Memory Sharing: Share Project Memory");
  assertNoDomNode(consentNotice(body), "shared is now the saved choice");
  assertNoDomNode(saveBar(body));
  // Back to separate needs no consent, and is saved on its own.
  await chooseMemorySharing(body, "Keep Account Memories Separate");
  assertNoDomNode(consentNotice(body));
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await settle();
  assert.deepEqual(updates, [{ name: "Alpha Renamed", memorySharing: "shared" }, { memorySharing: "separate" }]);
});

test("a failed save keeps Share Project Memory chosen with its consent notice, and Try Again saves it", async () => {
  let failing = true;
  const alpha = memoryProject();
  const { client, updates } = recordingClient(alpha, () => failing ? new Error("HTTP 500") : null);
  const body = await renderSelected([alpha], "Alpha", { runners: memoryRunners }, client);
  await chooseMemorySharing(body, "Share Project Memory");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await settle();
  assert.equal(text(saveBar(body)?.querySelector(".save-bar-message")), "Couldn't save the changes. Nothing was changed.");
  assert.equal(memoryTrigger(body)!.getAttribute("aria-label"), "Memory Sharing: Share Project Memory");
  assert.ok(consentNotice(body), "still unsaved, so the consent notice stays");
  failing = false;
  await act(async () => { saveBarButton(body, "Try Again")!.click(); });
  await settle();
  assert.deepEqual(updates, [{ memorySharing: "shared" }, { memorySharing: "shared" }]);
  assertNoDomNode(saveBar(body));
});

test("each machine is a row with its sentence, and with no locations one line shows", async () => {
  const body = await renderSelected([memoryProject(), project(2, { name: "Empty", memorySharing: "separate", locations: [] })],
    "Alpha", { runners: memoryRunners });
  const machines = [...memorySection(body).querySelectorAll(".project-memory-machine")].map((row) =>
    [text(row.querySelector(".row-title")), text(row.querySelector(".row-sub"))]);
  assert.deepEqual(machines, [
    ["Ready Machine", "Supported"],
    ["Old Machine", "Update Wollipog on this machine to use it"],
    ["Old Claude Machine", "Install Claude Code 2.1.284 or newer, then refresh agents"],
    ["Away Machine", "Offline. The saved choice applies when it reconnects."],
  ]);
  assert.equal(memorySection(body).querySelector(".project-memory-machines")!.tagName, "UL");
  await act(async () => { projectRow(body, "Empty").click(); });
  await settle();
  assert.equal(memorySection(body).querySelectorAll(".project-memory-machine").length, 0);
  assert.equal(text(memorySection(body).querySelector(".project-memory-empty")), "Add a location to use this setting.");
});

test("an older server shows Memory Sharing Needs an Update in the row's place", async () => {
  const body = await renderSelected([memoryProject({ memorySharing: undefined })], "Alpha", { runners: memoryRunners });
  const section = memorySection(body);
  const notice = section.querySelector(".notice.t-warning.compact");
  assert.equal(text(notice?.querySelector(".notice-title")), "Memory Sharing Needs an Update");
  assert.equal(text(notice?.querySelector(".notice-body")), "Update Wollipog to choose how accounts share memory.");
  assertNoDomNode(memoryTrigger(body), "no row");
  assert.deepEqual(rowTitles(section), []);
  assert.equal(section.querySelectorAll(".project-memory-machine").length, 0, "no saved choice for a machine to apply");
});

test("a viewer sees Memory Sharing read-only with the saved value", async () => {
  const body = await renderSelected([memoryProject({ canManage: false, memorySharing: "shared" })], "Alpha", { runners: memoryRunners });
  const row = settingRow(body, "Memory Sharing");
  assert.equal(text(row.querySelector(".setting-row-value-text")), "Share Project Memory");
  assertNoDomNode(memoryTrigger(body), "nothing to choose");
  assertNoDomNode(consentNotice(body));
});

test("a Save queued behind a Sessions tab change never sends Share Project Memory chosen after it was pressed", async () => {
  const alpha = memoryProject();
  const { client, updates, settleNext } = heldClient(alpha);
  const body = await renderSelected([alpha], "Alpha", { runners: memoryRunners }, client);
  await act(async () => { settingRow(body, "Show as a Sessions Tab").querySelector<HTMLButtonElement>('[role="switch"]')!.click(); });
  await type(fieldOf(body, "Name"), "Beta");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  assertNoDomNode(consentNotice(body), "no consent notice when Save was pressed");
  await chooseMemorySharing(body, "Share Project Memory");
  await settleNext();
  assert.deepEqual(updates, [{ hidden: true }, { name: "Beta" }], "the queued Save keeps the name, not the later choice");
  await settleNext();
  assert.equal(memoryTrigger(body)!.getAttribute("aria-label"), "Memory Sharing: Share Project Memory");
  assert.ok(consentNotice(body), "the choice waits, with its notice, for a Save of its own");
  assert.equal(text(saveBar(body)?.querySelector(".save-bar-message")), "Unsaved changes");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  assert.deepEqual(updates.at(-1), { memorySharing: "shared" });
  await settleNext();
  assertNoDomNode(saveBar(body));
});

test("a Save queued while the consent notice showed sends sharing, and a choice withdrawn before it runs is not sent", async () => {
  const alpha = memoryProject();
  const { client, updates, settleNext } = heldClient(alpha);
  const body = await renderSelected([alpha], "Alpha", { runners: memoryRunners }, client);
  const tab = () => settingRow(body, "Show as a Sessions Tab").querySelector<HTMLButtonElement>('[role="switch"]')!;
  await act(async () => { tab().click(); });
  await chooseMemorySharing(body, "Share Project Memory");
  assert.ok(consentNotice(body));
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await settleNext();
  assert.deepEqual(updates, [{ hidden: true }, { memorySharing: "shared" }], "pressed while the notice showed");
  await settleNext();
  assertNoDomNode(saveBar(body));

  await act(async () => { tab().click(); });
  await chooseMemorySharing(body, "Keep Account Memories Separate");
  await act(async () => { saveBarButton(body, "Save")!.click(); });
  await chooseMemorySharing(body, "Share Project Memory");
  await settleNext();
  assert.deepEqual(updates.slice(2), [{ hidden: false }], "the press asked for Keep Separate; the choice was taken back, so nothing is sent");
  assertNoDomNode(saveBar(body), "and the draft reads the saved choice again");
});
