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
const feedback = {
  confirm: async () => true,
  showToast: () => -1,
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
  // Settings holds the rename form, Hide Project and access unchanged until #2962.
  const settings = sections[1]!;
  assert.ok(settings.querySelector("input[maxlength='120']"));
  assert.ok([...settings.querySelectorAll("button")].some((button) => text(button) === "Hide Project"));
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
  const client = { ...api, updateProject: async () => { throw new Error("HTTP 500: database is locked"); } } as ApiClient;
  const body = await renderSelected([busyProject()], "Project 1", {}, client);
  const settings = [...body.querySelectorAll(".project-detail > section")][1]!;
  const hide = [...settings.querySelectorAll<HTMLButtonElement>("button")].find((button) => text(button) === "Hide Project")!;
  await act(async () => { hide.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  assertNoDomNode(body.querySelector(".project-manager-error"), "no bare form error");
  const notice = body.querySelector(".master-detail-detail .notice.t-danger");
  assert.ok(notice, "a danger notice");
  assert.equal(notice!.getAttribute("role"), "alert");
  assert.match(text(notice), /^Couldn't hide the project from Sessions\./);
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
  const name = body.querySelector<HTMLInputElement>(".project-name-form input");
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
