import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type ProjectView, type RunnerView, type UiSnapshotMessage } from "@wollipog/protocol";
import { api } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { ProjectsView } from "./ProjectsView.js";
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
  workspaces: [],
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

/** The route is the view's only selection, so the harness renders the store's current route. */
function ProjectsRoute() {
  const view = useStoreSelector((state) => state.view);
  return <ProjectsView selectedProjectId={view.name === "projects" ? view.id : undefined} onNewSession={() => {}} />;
}

async function render(snapshot: Partial<UiSnapshotMessage> | null) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "projects-1", runtimeKey: "projects-1:1", createSocket: () => socket, close() {},
  };
  await act(async () => {
    root.render(
      <ApiProvider client={api}>
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

test("a search with no match is one inline row with Clear Search, and no Select a Project beside it", async () => {
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
