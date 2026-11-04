import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type ProjectLocationView,
  type ProjectView,
  type RunnerView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { FeedbackContext, type ToastOptions } from "./FeedbackProvider.js";
import { ProjectsView } from "./ProjectsView.js";

/**
 * New Project from the Projects page (#2965): the header's New Project opens the dialog of that name,
 * and creating selects the project and hands off to Add Location's onboarding form (#2966). A
 * starter setup file that fails after the location was added is a partial success: the dialog
 * closes, a warning says what failed, and the location's ⋯ offers the file again.
 */

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
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
  InputEvent: domWindow.InputEvent,
  MutationObserver: domWindow.MutationObserver,
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
  workspaces: [
    { id: "workspace-1", name: "Alpha Checkout", path: "/repos/alpha" },
    { id: "workspace-2", name: "Docs Checkout", path: "/repos/docs" },
  ],
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
const toasts: { message: string; options?: ToastOptions }[] = [];
const feedback = {
  confirm: async () => true,
  showToast: (message: string, options?: ToastOptions) => { toasts.push({ message, options }); return -1; },
  showUndo: () => -1,
  dismissToast: () => undefined,
};

const alpha: ProjectView = {
  id: "alpha", name: "Alpha", hidden: false,
  locations: [{
    id: "location-alpha", projectId: "alpha", runnerId: "runner-1", workspaceId: "workspace-1", name: "Alpha Checkout",
    path: "/repos/alpha", source: "managed", availability: "available", isDefault: true, createdAt: 1, updatedAt: 1,
  }],
  activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0, createdAt: 1, updatedAt: 1,
};

const docs = (locations: ProjectLocationView[] = [], updatedAt = 2): ProjectView => ({
  id: "project-docs", name: "Docs Site", hidden: false, locations,
  activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0, createdAt: 2, updatedAt,
});

const docsLocation = (options: Partial<ProjectLocationView>): ProjectLocationView => ({
  id: "location-docs", projectId: "project-docs", runnerId: "runner-1", workspaceId: "workspace-2", name: "Docs Checkout",
  path: "/repos/docs", source: "managed", availability: "available", isDefault: true, createdAt: 3, updatedAt: 3,
  ...options,
});

/** The store's route as of the last render. */
let currentView: View = { name: "projects" };

function ProjectsRoute() {
  const view = useStoreSelector((state) => state.view);
  currentView = view;
  return <ProjectsView selectedProjectId={view.name === "projects" ? view.id : undefined}
    pane={view.name === "projects" ? view.pane : undefined} onNewSession={() => {}} />;
}

interface Calls {
  generated: string[];
  dismissed: number;
}

async function render(client: Partial<ApiClient>): Promise<{ body: HTMLElement; calls: Calls; unmount: () => Promise<void> }> {
  toasts.length = 0;
  const calls: Calls = { generated: [], dismissed: 0 };
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "new-project-1", runtimeKey: "new-project-1:1", createSocket: () => socket, close() {},
  };
  const activeClient = {
    ...api,
    createProject: async () => ({ project: docs() }),
    // The location rows read each setup file; the new one has none, so its ⋯ offers one.
    projectLocationWorktreeSetup: async (_projectId: string, locationId: string) => ({ locationId, status: { status: "absent" } }),
    generateProjectLocationWorktreeSetup: async (_projectId: string, locationId: string) => {
      calls.generated.push(locationId);
      throw new ApiError("EACCES: permission denied", 422);
    },
    dismissWorktreeSetupNotice: async () => { calls.dismissed += 1; return { dismissed: true as const }; },
    listDirectory: async (_runnerId: string, path: string) => ({ path: path || "/home/ada/docs-site", parent: "/home/ada", entries: [] }),
    ...client,
  } as ApiClient;
  await act(async () => {
    root.render(
      <ApiProvider client={activeClient}>
        <FeedbackContext.Provider value={feedback as never}>
          <StoreProvider connection={connection} navigation={navigation}>
            <ProjectsRoute />
          </StoreProvider>
        </FeedbackContext.Provider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true,
        createProjectLocations: true, worktreeSetupConfig: true,
      },
      runners: [runner], boxes: [], sessions: [], runs: [], pods: [], projects: [alpha],
    } as UiSnapshotMessage);
  });
  await settle();
  return {
    body: domWindow.document.body as unknown as HTMLElement,
    calls,
    unmount: async () => {
      await act(async () => root.unmount());
      mountPoint.remove();
    },
  };
}

const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const dialogs = () => [...domWindow.document.querySelectorAll('[role="dialog"]')] as unknown as HTMLElement[];
const footerButtons = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLButtonElement>(".modal-foot button")];
const button = (dialog: HTMLElement, label: string) => footerButtons(dialog).find((candidate) => text(candidate) === label)!;

/** Opens New Project from the page header, names it Docs Site and creates it. */
async function createDocsSite(body: HTMLElement) {
  const newProject = [...body.querySelectorAll<HTMLButtonElement>(".page-header button")].find((candidate) => text(candidate) === "New Project")!;
  await act(async () => { newProject.click(); });
  const [dialog] = dialogs();
  assert.equal(text(dialog!.querySelector(".modal-title")), "New Project");
  assert.equal(text(dialog!.querySelector(".modal-desc")), "Groups sessions by repository. You'll add its folders next.");
  assert.deepEqual(footerButtons(dialog!).map(text), ["Cancel", "Create Project"]);
  await act(async () => { fireDomEvent.change(dialog!.querySelector("input")!, { target: { value: "Docs Site" } }); });
  await act(async () => { button(dialog!, "Create Project").click(); });
  await settle();
}

/** Turns on Create a Starter Setup File in the onboarding form. */
async function checkStarterSetup(dialog: HTMLElement) {
  const checkbox = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  assert.match(text(checkbox.closest(".checkbox")), /^Create a Starter Setup File/u);
  await act(async () => { checkbox.click(); });
}

async function assertSetupWarningAndRetry(body: HTMLElement, calls: Calls) {
  assert.equal(dialogs().length, 0, "Add Location closes: the location exists");
  assert.doesNotMatch(text(body), /Couldn't Add the Location/u);
  assert.deepEqual(calls.generated, ["location-docs"]);
  assert.equal(calls.dismissed, 0, "the setup suggestion stays while there is no file");
  assert.deepEqual(toasts.at(-1), {
    message: "Location added, but its starter setup file couldn't be created.",
    options: { tone: "warning", detail: "Try again from the location's ⋯ menu. EACCES: permission denied" },
  });
  // The retry the warning points at.
  const row = [...body.querySelectorAll<HTMLElement>(".project-location")]
    .find((candidate) => text(candidate.querySelector(".project-location-name")) === "Docs Checkout");
  assert.ok(row, "the added location is listed");
  await act(async () => { row!.querySelector<HTMLButtonElement>('button[aria-label="Docs Checkout Actions"]')!.click(); });
  const menu = domWindow.document.querySelector('[role="menu"][aria-label="Docs Checkout Actions"]') as unknown as HTMLElement | null;
  assert.ok([...(menu?.querySelectorAll(".menu-item") ?? [])].some((item) => text(item) === "Create Starter Setup File"));
}

test("Create Project selects the new project and opens Add Location's onboarding form", async () => {
  const view = await render({});
  try {
    await createDocsSite(view.body);
    assert.deepEqual(currentView, { name: "projects", id: "project-docs" }, "the new project is selected");
    assert.equal(text(view.body.querySelector(".project-detail-title")), "Docs Site");
    const [dialog] = dialogs();
    assert.equal(dialogs().length, 1, "Add Location replaces New Project");
    assert.equal(text(dialog!.querySelector(".modal-title")), "Add Location to Docs Site");
    assert.equal(text(dialog!.querySelector(".modal-body .notice")), "Docs Site was created. Add the folder where its sessions run.");
    assert.deepEqual(footerButtons(dialog!).map(text), ["Skip for Now", "Add Location"]);
    await act(async () => { button(dialog!, "Skip for Now").click(); });
    assert.equal(dialogs().length, 0);
    assert.deepEqual(currentView, { name: "projects", id: "project-docs" }, "skipping keeps the project selected");
  } finally {
    await view.unmount();
  }
});

test("adding an existing location whose starter setup file fails is a partial success, retried from its ⋯", async () => {
  const view = await render({
    addProjectLocation: async () => ({ project: docs([docsLocation({})], 4) }),
  });
  try {
    await createDocsSite(view.body);
    const [dialog] = dialogs();
    await checkStarterSetup(dialog!);
    const row = [...dialog!.querySelectorAll<HTMLElement>(".add-location-list .choice-row")]
      .find((candidate) => text(candidate.querySelector(".choice-row-title")).startsWith("Docs Checkout"));
    assert.ok(row, "the machine's unassigned checkout is offered");
    await act(async () => { row!.querySelector<HTMLInputElement>('input[type="radio"]')!.click(); });
    await act(async () => { button(dialog!, "Add Location").click(); });
    await settle();
    await assertSetupWarningAndRetry(view.body, view.calls);
  } finally {
    await view.unmount();
  }
});

test("adding a new folder whose starter setup file fails is a partial success, retried from its ⋯", async () => {
  const created: unknown[] = [];
  const view = await render({
    createProjectLocation: async (_projectId: string, location: unknown) => {
      created.push(location);
      return { project: docs([docsLocation({ path: "/home/ada/docs-site" })], 4) };
    },
  });
  try {
    await createDocsSite(view.body);
    const [dialog] = dialogs();
    const newFolder = [...dialog!.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) => text(radio) === "New Folder")!;
    await act(async () => { newFolder.click(); });
    await settle();
    await checkStarterSetup(dialog!);
    await act(async () => { button(dialog!, "Add Location").click(); });
    await settle();
    assert.deepEqual(created, [{ runnerId: "runner-1", name: "Docs Site", path: "/home/ada/docs-site" }]);
    await assertSetupWarningAndRetry(view.body, view.calls);
  } finally {
    await view.unmount();
  }
});

test("a starter setup file whose reply is lost says Wollipog couldn't confirm it, not that it failed", async () => {
  const view = await render({
    addProjectLocation: async () => ({ project: docs([docsLocation({})], 4) }),
    generateProjectLocationWorktreeSetup: async () => { throw new TypeError("Failed to fetch"); },
  });
  try {
    await createDocsSite(view.body);
    const [dialog] = dialogs();
    await checkStarterSetup(dialog!);
    const row = [...dialog!.querySelectorAll<HTMLElement>(".add-location-list .choice-row")]
      .find((candidate) => text(candidate.querySelector(".choice-row-title")).startsWith("Docs Checkout"))!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type="radio"]')!.click(); });
    await act(async () => { button(dialog!, "Add Location").click(); });
    await settle();
    assert.equal(dialogs().length, 0, "Add Location closes: the location exists");
    assert.doesNotMatch(text(view.body), /Couldn't Add the Location/u);
    assert.deepEqual(toasts.at(-1), {
      message: "Location added, but Wollipog couldn't confirm its starter setup file.",
      options: { tone: "warning", detail: "If the location has none, its ⋯ menu offers Create Starter Setup File. Failed to fetch" },
    });
  } finally {
    await view.unmount();
  }
});

test("a starter setup file that is created dismisses the setup suggestion and shows no warning", async () => {
  const view = await render({
    addProjectLocation: async () => ({ project: docs([docsLocation({})], 4) }),
    generateProjectLocationWorktreeSetup: async (_projectId: string, locationId: string) =>
      ({ locationId, status: { status: "absent" }, path: ".wollipog.json", detected: [] }),
  });
  try {
    await createDocsSite(view.body);
    const [dialog] = dialogs();
    await checkStarterSetup(dialog!);
    const row = [...dialog!.querySelectorAll<HTMLElement>(".add-location-list .choice-row")]
      .find((candidate) => text(candidate.querySelector(".choice-row-title")).startsWith("Docs Checkout"))!;
    await act(async () => { row.querySelector<HTMLInputElement>('input[type="radio"]')!.click(); });
    await act(async () => { button(dialog!, "Add Location").click(); });
    await settle();
    assert.equal(dialogs().length, 0);
    assert.equal(view.calls.dismissed, 1);
    assert.deepEqual(toasts, []);
    assertNoDomNode(view.body.querySelector(".project-detail .notice.t-danger"), "no failure notice");
  } finally {
    await view.unmount();
  }
});
