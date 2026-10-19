import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { PROTOCOL_VERSION, type ProjectView, type RunnerView, type SessionView, type UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { ProjectsView } from "./ProjectsView.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

// The Projects page's three confirmations in the shared confirmation (#2964): Delete Project,
// the archive and Remove Location, each opened from a ⋯ and, on a phone, replacing its sheet.

const domWindow = new Window({ url: "http://localhost/", width: 1440, height: 900 });
/** The page a test mounted. Unmounted after the test and before the shared cleanup empties the
 * body, so no dialog or menu from an earlier test is still portalled into it. */
let mounted: Root | null = null;
afterEach(async () => {
  const root = mounted;
  mounted = null;
  if (root) await act(async () => { root.unmount(); });
});
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

const doc = domWindow.document as unknown as Document;

const runner: RunnerView = {
  runnerId: "runner-1",
  hostname: "runner-host",
  os: "linux",
  version: "1",
  status: "online",
  displayName: "Build Machine",
  agents: [],
  workspaces: [
    { id: "workspace-1", name: "Storefront", path: "/repos/acme/storefront" },
    { id: "workspace-2", name: "Checkout", path: "/repos/acme/checkout" },
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

/** Every route the store pushed or replaced, in order. */
const routes: Array<{ how: "push" | "replace"; view: View }> = [];
const navigation: ViewNavigation = {
  current: () => ({ name: "projects" }),
  push: (view) => { routes.push({ how: "push", view }); },
  replace: (view) => { routes.push({ how: "replace", view }); },
  listen: () => () => {},
};
/** The socket of the page mounted last, for messages the server sends while it is open. */
let socket: FakeSocket;

/** A project with one location, Storefront, and no sessions. */
function project(id: string, name: string, options: Partial<ProjectView> = {}): ProjectView {
  return {
    id,
    name,
    hidden: false,
    locations: [{
      id: `${id}-storefront`, projectId: id, runnerId: "runner-1", workspaceId: "workspace-1",
      name: "Storefront", path: "/repos/acme/storefront", source: "managed", availability: "available",
      isDefault: true, createdAt: 1, updatedAt: 1,
    }],
    activeSessionCount: 0,
    unarchivedSessionCount: 0,
    totalSessionCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...options,
  };
}

function session(index: number, projectId: string, status: SessionView["status"]): SessionView {
  return {
    id: `session-${index}`,
    runnerId: "runner-1",
    workspaceId: "workspace-1",
    workspaceName: "Storefront",
    projectId,
    title: `Session ${index}`,
    status,
    archived: false,
    updatedAt: 1,
    lastEventAt: 1,
    pendingApproval: null,
  } as SessionView;
}

let currentView: View = { name: "projects" };

function ProjectsRoute() {
  const view = useStoreSelector((state) => state.view);
  currentView = view;
  return <ProjectsView selectedProjectId={view.name === "projects" ? view.id : undefined}
    pane={view.name === "projects" ? view.pane : undefined} onNewSession={() => undefined} />;
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

/** Mounts the page with the real confirmation and opens the project named. */
async function renderSelected(projects: ProjectView[], name: string, client: ApiClient, snapshot: Partial<UiSnapshotMessage> = {}) {
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  mounted = root;
  socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "projects-confirm", runtimeKey: "projects-confirm:1", createSocket: () => socket, close() {},
  };
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <FeedbackProvider>
          <StoreProvider connection={connection} navigation={navigation}>
            <ProjectsRoute />
          </StoreProvider>
        </FeedbackProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true, stopBeforeArchive: true,
      },
      runners: [runner],
      boxes: [],
      sessions: [],
      runs: [],
      pods: [],
      projects,
      ...snapshot,
    } as UiSnapshotMessage);
  });
  await settle();
  const row = [...doc.querySelectorAll<HTMLButtonElement>(".master-detail-list-body .row")]
    .find((candidate) => text(candidate.querySelector(".row-title")) === name.trim());
  assert.ok(row, name);
  await act(async () => { row!.click(); });
  await settle();
  return doc.body as HTMLElement;
}

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

const menu = (label: string) => doc.querySelector<HTMLElement>(`[role="menu"][aria-label="${label}"]`);

/** Opens the ⋯ named `label` inside `scope` and chooses `item`. */
async function choose(scope: ParentNode, label: string, item: string) {
  const trigger = scope.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  assert.ok(trigger, label);
  await act(async () => { trigger!.click(); });
  const entry = [...(menu(label)?.querySelectorAll<HTMLButtonElement>(".menu-item") ?? [])]
    .find((candidate) => text(candidate.querySelector(".menu-text")) === item);
  assert.ok(entry, item);
  await act(async () => { entry!.click(); });
  await settle();
  const dialog = doc.querySelector<HTMLElement>('[role="dialog"]');
  assert.ok(dialog, `${item} opens a confirmation`);
  return dialog!;
}

const footButton = (dialog: HTMLElement, label: string) =>
  [...dialog.querySelectorAll<HTMLButtonElement>(".modal-foot button")].find((button) => text(button) === label)!;
const confirmDisabled = (button: HTMLButtonElement) => button.disabled || button.getAttribute("aria-disabled") === "true";

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

/** A client whose deletes are counted and held until `release` answers them, with `failure` or not. */
function deletingClient() {
  const deletes: string[] = [];
  let answer: ((failure: Error | null) => void) | null = null;
  const client = {
    ...api,
    deleteProject: (id: string) => {
      deletes.push(id);
      return new Promise<void>((resolve, reject) => {
        answer = (failure) => (failure ? reject(failure) : resolve());
      });
    },
  } as unknown as ApiClient;
  const release = async (failure: Error | null = null) => {
    await act(async () => { answer?.(failure); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await settle();
  };
  return { client, deletes, release };
}

// A name with trailing spaces: the match is exact, so they must be typed too.
const ACME = "Acme Storefront  ";

test("Delete Project… opens the shared confirmation: neutral message, the name field focused, a fixed label and the name in the helper", async () => {
  const { client } = deletingClient();
  const acme = project("acme", ACME, { totalSessionCount: 4 });
  const body = await renderSelected([acme, project("beta", "Beta")], ACME, client);
  const dialog = await choose(body.querySelector(".project-detail-title-row")!, "Project Actions", "Delete Project…");
  assert.equal(text(dialog.querySelector(".modal-title")), "Delete Project");
  const message = dialog.querySelector(".confirmation-message")!;
  assert.equal(message.textContent,
    "“Acme Storefront  ” is deleted for good, and its 4 sessions move to No Project. The sessions, their files and the location folders are kept.");
  assertNoDomNode(dialog.querySelector(".modal-body .notice"), "the message is plain text, not a red wash");

  const field = dialog.querySelector<HTMLInputElement>(".field input")!;
  assert.ok(doc.activeElement === field, "the name field has focus, not Cancel");
  const label = dialog.querySelector<HTMLLabelElement>(".field label")!;
  assert.equal(text(label), "Type the Project Name to Confirm");
  assert.equal(label.htmlFor, field.id);
  const helper = doc.getElementById(field.getAttribute("aria-describedby") ?? "")!;
  assert.equal(helper.textContent, `Enter ${ACME} exactly.`);
  assert.equal(helper.querySelector("code")?.textContent, ACME, "the name is an inline code chip, spaces and all");

  const confirm = footButton(dialog, "Delete Project");
  assert.ok(confirm.className.includes("danger"));
  assert.ok(confirmDisabled(confirm), "nothing is typed yet");
  for (const near of ["Acme Storefront", "Acme Storefront ", "acme storefront  ", `${ACME} `]) {
    await type(field, near);
    assert.ok(confirmDisabled(footButton(dialog, "Delete Project")), JSON.stringify(near));
  }
  await type(field, ACME);
  assert.equal(confirmDisabled(footButton(dialog, "Delete Project")), false, "an exact match enables it");
});

test("confirming deletes once with the button busy, then closes, moves to the next project and says so", async () => {
  const { client, deletes, release } = deletingClient();
  const body = await renderSelected([project("acme", ACME), project("beta", "Beta")], ACME, client);
  const dialog = await choose(body.querySelector(".project-detail-title-row")!, "Project Actions", "Delete Project…");
  await type(dialog.querySelector<HTMLInputElement>(".field input")!, ACME);
  const confirm = footButton(dialog, "Delete Project");
  await act(async () => { confirm.click(); });
  await act(async () => { confirm.click(); });
  const field = dialog.querySelector<HTMLInputElement>(".field input")!;
  await act(async () => {
    field.dispatchEvent(new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "Enter" }) as unknown as Event);
  });
  assert.deepEqual(deletes, ["acme"], "one request, however often it is confirmed");
  assert.equal(footButton(dialog, "Delete Project").getAttribute("aria-busy"), "true");
  assert.equal(footButton(dialog, "Cancel").disabled, true, "a sent delete can't be withdrawn");
  assert.ok(doc.contains(dialog), "the dialog stays open while it runs");

  await release();
  assertNoDomNode(doc.querySelector('[role="dialog"]'), "it closes once the delete succeeds");
  assert.deepEqual(currentView, { name: "projects", id: "beta" });
  assert.match(text(doc.querySelector(".toast-region")), /Project deleted\. Sessions moved to No Project\./);
});

test("a removal broadcast before the delete answers still lands on the deleted project's neighbour, in place of its route", async () => {
  const { client, release } = deletingClient();
  const projects = [project("alpha", "Alpha"), project("beta", "Beta"), project("gamma", "Gamma")];
  const body = await renderSelected(projects, "Beta", client);
  const dialog = await choose(body.querySelector(".project-detail-title-row")!, "Project Actions", "Delete Project…");
  await type(dialog.querySelector<HTMLInputElement>(".field input")!, "Beta");
  await act(async () => { footButton(dialog, "Delete Project").click(); });
  routes.length = 0;
  // The server broadcasts the removal before it answers the DELETE.
  await act(async () => { socket.push({ type: "project_removed", projectId: "beta" } as never); });
  await settle();
  assert.deepEqual(routes, [], "the missing route does not send the page elsewhere while the delete runs");
  assert.ok(doc.contains(dialog), "the dialog stays open until the request answers");

  await release();
  assertNoDomNode(doc.querySelector('[role="dialog"]'));
  assert.deepEqual(routes, [{ how: "replace", view: { name: "projects", id: "gamma" } }], "Beta's neighbour, not the first project");
  assert.deepEqual(currentView, { name: "projects", id: "gamma" });
});

test("a delete whose neighbour went away while it ran lands on a project that is still there", async () => {
  const { client, release } = deletingClient();
  const projects = [project("alpha", "Alpha"), project("beta", "Beta"), project("gamma", "Gamma")];
  const body = await renderSelected(projects, "Beta", client);
  const dialog = await choose(body.querySelector(".project-detail-title-row")!, "Project Actions", "Delete Project…");
  await type(dialog.querySelector<HTMLInputElement>(".field input")!, "Beta");
  await act(async () => { footButton(dialog, "Delete Project").click(); });
  await act(async () => { socket.push({ type: "project_removed", projectId: "gamma" } as never); });
  await act(async () => { socket.push({ type: "project_removed", projectId: "beta" } as never); });
  await release();
  assert.deepEqual(currentView, { name: "projects", id: "alpha" });
});

test("a failed delete stays in the dialog as its danger notice, with the typed name and the raw message behind Show Details", async () => {
  const { client, deletes, release } = deletingClient();
  const body = await renderSelected([project("acme", ACME), project("beta", "Beta")], ACME, client);
  const dialog = await choose(body.querySelector(".project-detail-title-row")!, "Project Actions", "Delete Project…");
  await type(dialog.querySelector<HTMLInputElement>(".field input")!, ACME);
  await act(async () => { footButton(dialog, "Delete Project").click(); });
  await release(new Error("HTTP 500: database is locked"));

  assert.ok(doc.contains(dialog), "the dialog stays open");
  const notice = dialog.querySelector(".notice.t-danger")!;
  assert.equal(notice.getAttribute("role"), "alert");
  assert.match(text(notice), /^Couldn't delete the project\. Nothing was changed\./);
  assert.doesNotMatch(text(notice), /database is locked/, "the raw message waits behind Show Details");
  const details = [...notice.querySelectorAll<HTMLButtonElement>("button")].find((button) => text(button) === "Show Details")!;
  await act(async () => { details.click(); });
  assert.match(text(notice), /HTTP 500: database is locked/);
  assert.equal(dialog.querySelector<HTMLInputElement>(".field input")!.value, ACME, "the typed name is kept");
  assert.equal(confirmDisabled(footButton(dialog, "Delete Project")), false, "so it can be tried again");
  assertNoDomNode(body.querySelector(".master-detail-detail .notice.t-danger"), "the failure is not repeated on the page");
  assert.deepEqual(currentView, { name: "projects", id: "acme" });
  assert.deepEqual(deletes, ["acme"]);
});

test("Archive and Stop counts every unarchived session in its title and lists five with status badges and and 2 more", async () => {
  const acme = project("acme", "Acme", { unarchivedSessionCount: 7, totalSessionCount: 9, activeSessionCount: 2 });
  // Seven unarchived sessions, five of them loaded here; an archived one is not listed.
  const sessions = [
    session(1, "acme", "running"),
    session(2, "acme", "idle"),
    session(3, "acme", "running"),
    session(4, "acme", "idle"),
    session(5, "acme", "idle"),
    { ...session(6, "acme", "idle"), archived: true },
    session(7, "beta", "running"),
  ];
  const body = await renderSelected([acme, project("beta", "Beta")], "Acme", api, { sessions });
  const dialog = await choose(body.querySelector(".project-detail-title-row")!, "Project Actions", "Archive and Stop Sessions…");
  assert.equal(text(dialog.querySelector(".modal-title")), "Archive and Stop 7 Sessions");
  assert.ok(footButton(dialog, "Archive and Stop").className.includes("danger"), "running work stops, so the tone is danger");
  const rows = [...dialog.querySelectorAll(".confirmation-rows .row")];
  assert.deepEqual(rows.map((row) => text(row.querySelector(".row-title"))), ["Session 1", "Session 2", "Session 3", "Session 4", "Session 5"]);
  assert.deepEqual(rows.map((row) => text(row.querySelector(".status"))), ["Running", "Awaiting Prompt", "Running", "Awaiting Prompt", "Awaiting Prompt"]);
  assert.equal(text(dialog.querySelector(".confirmation-rows-more")), "and 2 more", "the two the page has not loaded");
});

test("Archive without running work is not a danger confirmation and keeps the plain verb", async () => {
  const acme = project("acme", "Acme", { unarchivedSessionCount: 3, totalSessionCount: 3 });
  const sessions = [session(1, "acme", "completed"), session(2, "acme", "completed"), session(3, "acme", "completed")];
  const body = await renderSelected([acme], "Acme", api, { sessions });
  const dialog = await choose(body.querySelector(".project-detail-title-row")!, "Project Actions", "Archive Sessions…");
  assert.equal(text(dialog.querySelector(".modal-title")), "Archive 3 Sessions");
  assert.equal(footButton(dialog, "Archive Sessions").className.includes("danger"), false);
  assertNoDomNode(dialog.querySelector(".confirmation-rows-more"), "every session is listed");
});

test("Remove Location shows the path as a mono row, and the last location adds the no-locations sentence", async () => {
  const two = project("acme", "Acme");
  two.locations.push({
    ...two.locations[0]!, id: "acme-checkout", workspaceId: "workspace-2", name: "Checkout", path: "/repos/acme/checkout", isDefault: false,
  });
  const body = await renderSelected([two, project("solo", "Solo")], "Acme", api);
  let dialog = await choose(body.querySelector(".project-locations")!, "Checkout Actions", "Remove Location…");
  assert.equal(text(dialog.querySelector(".modal-title")), "Remove Location");
  assert.equal(dialog.querySelector(".confirmation-message")!.textContent,
    "New sessions in “Acme” stop using this folder on Build Machine. The folder, its sessions and other projects aren't affected.");
  const row = dialog.querySelector(".confirmation-rows .row-title")!;
  assert.equal(row.textContent, "/repos/acme/checkout");
  assert.ok(row.classList.contains("mono"));
  assert.equal(footButton(dialog, "Remove Location").className.includes("danger"), true);
  assertNoDomNode(dialog.querySelector(".confirmation-note"), "another location remains, so there is no note");
  await act(async () => { footButton(dialog, "Cancel").click(); });
  await settle();

  const solo = [...body.querySelectorAll<HTMLButtonElement>(".master-detail-list-body .row")]
    .find((candidate) => text(candidate.querySelector(".row-title")) === "Solo")!;
  await act(async () => { solo.click(); });
  await settle();
  dialog = await choose(body.querySelector(".project-locations")!, "Storefront Actions", "Remove Location…");
  assert.equal(dialog.querySelector(".confirmation-message")!.textContent,
    "New sessions in “Solo” stop using this folder on Build Machine. The folder, its sessions and other projects aren't affected.");
  // The body stays two sentences (§7.4), so the limit the removal leaves is the note under it.
  assert.equal(dialog.querySelector(".confirmation-note")!.textContent,
    "“Solo” will have no locations left, so it can't start sessions until you add one.");
  assert.ok((dialog.getAttribute("aria-describedby") ?? "").split(" ").length >= 3, "the note and the row are part of the description");
  assert.equal(dialog.querySelector(".confirmation-rows .row-title.mono")!.textContent, "/repos/acme/storefront");
});

test("on a phone each confirmation replaces the ⋯ sheet it came from, and Back to More Actions reopens that sheet", async () => {
  const restore = stubPhone();
  try {
    const acme = project("acme", "Acme", { unarchivedSessionCount: 1, totalSessionCount: 1 });
    const body = await renderSelected([acme], "Acme", api, { sessions: [session(1, "acme", "completed")] });
    const cases: Array<[scope: ParentNode, label: string, item: string, title: string]> = [
      [body.querySelector(".detail-bar")!, "Project Actions", "Delete Project…", "Delete Project"],
      [body.querySelector(".detail-bar")!, "Project Actions", "Archive Sessions…", "Archive 1 Session"],
      [body.querySelector(".project-locations")!, "Storefront Actions", "Remove Location…", "Remove Location"],
    ];
    for (const [scope, label, item, title] of cases) {
      const dialog = await choose(scope, label, item);
      assert.equal(text(dialog.querySelector(".modal-title")), title);
      assertNoDomNode(menu(label), `${title} does not stack on the ${label} sheet`);
      assert.equal(doc.querySelectorAll('[role="dialog"]').length, 1);
      assert.deepEqual([...dialog.querySelectorAll(".modal-foot .btn")].map(text).length, 2, "two footer buttons");
      const back = dialog.querySelector<HTMLButtonElement>(".modal-back")!;
      assert.equal(back.getAttribute("aria-label"), "Back to More Actions");
      await act(async () => { back.click(); });
      await settle();
      assertNoDomNode(doc.querySelector('[role="dialog"]'), "Back closes the confirmation");
      const reopened = menu(label);
      assert.ok(reopened, `Back brings the ${label} sheet back`);
      assert.equal(text(doc.activeElement?.querySelector(".menu-text")), item, "with focus on the item chosen");
      await act(async () => {
        reopened!.dispatchEvent(new domWindow.KeyboardEvent("keydown", { bubbles: true, key: "Escape" }) as unknown as Event);
      });
      await settle();
    }
  } finally {
    restore();
  }
});
