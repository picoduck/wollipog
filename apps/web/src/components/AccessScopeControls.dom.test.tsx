import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import {
  PROTOCOL_VERSION,
  type AccessScopeChangePreview,
  type IdentityAdministrationView,
  type ProjectView,
  type ResourceOwner,
  type ResourceScope,
  type RunnerView,
  type UiSnapshotMessage,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { AccessScopeSettings } from "./AccessScopeControls.js";
import { FeedbackContext } from "./FeedbackProvider.js";
import { ProjectsView } from "./ProjectsView.js";

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

const ORG = "org-1";
const scopeOf = (owner: ResourceOwner): ResourceScope => ({ organizationId: ORG, owner });
const organizationScope = scopeOf({ kind: "organization", organizationId: ORG });
const privateScope = scopeOf({ kind: "user", userId: "user-me" });
const buildersScope = scopeOf({ kind: "team", teamId: "team-builders" });

function identity(role: IdentityAdministrationView["context"]["role"] = "admin"): IdentityAdministrationView {
  return {
    context: {
      userId: "user-me", userName: "Me", organizationId: ORG, organizationName: "Org", role,
      deviceId: "device", localBootstrap: false,
    },
    organizations: [{ organizationId: ORG, name: "Org", createdAt: 1 }],
    memberships: [
      { organizationId: ORG, organizationName: "Org", userId: "user-me", userName: "Me", userStatus: "active", role, createdAt: 1 },
      { organizationId: ORG, organizationName: "Org", userId: "user-two", userName: "Two", userStatus: "active", role: "operator", createdAt: 1 },
    ],
    teams: [
      { teamId: "team-builders", organizationId: ORG, name: "Builders", memberUserIds: ["user-me", "user-two", "user-three"], createdAt: 1 },
      { teamId: "team-empty", organizationId: ORG, name: "Ghosts", memberUserIds: [], createdAt: 1 },
    ],
  };
}

function preview(target: ResourceScope, options: Partial<AccessScopeChangePreview> = {}): AccessScopeChangePreview {
  return {
    resource: "project",
    resourceId: "project-1",
    currentScope: organizationScope,
    targetScope: target,
    affectedProjects: [{ projectId: "project-1", name: "Alpha" }],
    activeSessionCount: 2,
    totalSessionCount: 5,
    sessionsToNarrow: 5,
    compatible: true,
    confirmationToken: "token-1",
    ...options,
  };
}

const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const body = () => domWindow.document.body as unknown as HTMLElement;
const buttonNamed = (name: string) => [...body().querySelectorAll<HTMLButtonElement>("button")]
  .find((button) => text(button) === name);
const dialog = () => body().querySelector<HTMLElement>("[role=dialog]");
const radio = (title: string) => [...(dialog()?.querySelectorAll<HTMLInputElement>("input[type=radio]") ?? [])]
  .find((input) => text(input.closest("label")?.querySelector(".choice-row-title")).startsWith(title));
const readoutParts = (readout: Element | null) => [".setting-row-title", ".setting-row-desc", ".setting-row-control button"]
  .map((selector) => readout?.querySelector(selector)).filter(Boolean).map((part) => text(part));
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Renders the project readout with a client whose previews the test answers by owner key. */
async function renderReadout({
  scope = organizationScope,
  who = identity(),
  previews = {},
  locations,
  update,
}: {
  scope?: ResourceScope;
  who?: IdentityAdministrationView;
  previews?: Record<string, () => Promise<AccessScopeChangePreview>>;
  locations?: ProjectView["locations"];
  update?: (owner: ResourceOwner, token: string) => Promise<void>;
} = {}) {
  const calls = { previews: [] as string[], updates: [] as Array<{ owner: ResourceOwner; token: string }>, refreshed: 0 };
  const key = (owner: ResourceOwner) => owner.kind === "organization" ? "organization"
    : owner.kind === "user" ? `user:${owner.userId}` : `team:${owner.teamId}`;
  const client = {
    ...api,
    previewProjectAccessScope: async (_id: string, owner: ResourceOwner) => {
      calls.previews.push(key(owner));
      const answer = previews[key(owner)];
      if (!answer) throw new Error(`no preview for ${key(owner)}`);
      return { preview: await answer() };
    },
    previewWorkspaceAccessScope: async (_runner: string, _workspace: string, owner: ResourceOwner) => {
      calls.previews.push(`workspace:${key(owner)}`);
      return { preview: preview(scopeOf(owner), { resource: "workspace", currentScope: privateScope }) };
    },
    updateProjectAccessScope: async (_id: string, owner: ResourceOwner, token: string) => {
      calls.updates.push({ owner, token });
      await update?.(owner, token);
      return {} as never;
    },
  } as ApiClient;
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <AccessScopeSettings
          resource={{ kind: "project", projectId: "project-1", name: "Alpha", locations }}
          scope={scope}
          identity={who}
          onUpdated={() => { calls.refreshed += 1; }}
        />
      </ApiProvider>,
    );
  });
  return calls;
}

async function openDialog() {
  const change = buttonNamed("Change…");
  assert.ok(change, "the readout offers Change…");
  await act(async () => { change.click(); });
  assert.ok(dialog(), "Change… opens the dialog");
}

async function choose(title: string) {
  const input = radio(title);
  assert.ok(input, `the dialog offers ${title}`);
  await act(async () => { input.click(); });
}

const changeAccess = () => [...(body().querySelectorAll<HTMLButtonElement>(".modal-foot button"))]
  .find((button) => text(button) === "Change Access");

test("the readout shows the saved access as text with Change…, and the dialog opens on it marked Current", async () => {
  await renderReadout();
  const readout = body().querySelector(".access-scope-readout");
  assert.ok(readout);
  assert.deepEqual(readoutParts(readout), ["Organization-Wide", "Everyone in your organization can see and use it.", "Change…"]);
  assert.equal(readout.querySelectorAll("[aria-haspopup=listbox]").length, 0, "no Select stands for the saved access");
  assert.equal(buttonNamed("Change…")?.getAttribute("aria-labelledby")?.split(" ").length, 2,
    "Change… is named with the access it changes");

  await openDialog();
  assert.equal(text(dialog()?.querySelector(".modal-title")), "Change Project Access");
  assert.equal(text(dialog()?.querySelector(".modal-desc")), "Alpha", "the description names the project");
  const current = radio("Organization-Wide");
  assert.equal(current?.checked, true, "the saved access is chosen on open");
  assert.match(text(current?.closest("label")), /Current/u, "and marked Current");
  assert.deepEqual(
    [...dialog()!.querySelectorAll(".choice-row-title")].map((title) => text(title)),
    ["Private to Me", "Team: Builders", "Team: Ghosts", "Organization-WideCurrent"],
  );
  assert.deepEqual(
    [...dialog()!.querySelectorAll(".choice-row-desc")].map((line) => text(line)),
    ["Only you and organization admins.", "Everyone on Builders (3 people).", "Everyone on Ghosts (no members yet).",
      "Everyone in your organization."],
  );
  const primary = changeAccess();
  assert.ok(primary?.disabled, "Change Access is off while the saved access is chosen");
  assert.equal(text(body().querySelector(".modal-foot .access-change-reason")), "Choose a different access level.");
  for (const banned of [/Access is never broadened/u, /Apply Access Change/u, /Project Memberships/u, /resource/iu]) {
    assert.doesNotMatch(text(body()), banned);
  }
});

test("choosing another access checks its impact before Change Access can apply it with the preview's token", async () => {
  const pending = deferred<AccessScopeChangePreview>();
  const calls = await renderReadout({ previews: { "user:user-me": () => pending.promise } });
  await openDialog();
  await choose("Private to Me");
  assert.deepEqual(calls.previews, ["user:user-me"]);
  assert.match(text(dialog()), /Checking which sessions this affects…/u);
  assert.ok(dialog()?.querySelector(".access-change-checking .spinner"), "the checking line carries a spinner");
  assert.ok(changeAccess()?.disabled, "Change Access waits for the preview");
  assertNoDomNode(body().querySelector(".access-change-reason"), "the footer reason is only for the saved access");

  await act(async () => { pending.resolve(preview(privateScope)); });
  await settle();
  assert.doesNotMatch(text(dialog()), /Checking which sessions/u);
  const notice = dialog()?.querySelector(".notice.t-warning");
  assert.equal(text(notice?.querySelector(".notice-title")), "5 Sessions Become Private to You");
  assert.equal(text(notice?.querySelector(".notice-body")),
    "That includes 2 active sessions. Others in your organization lose access to this project and its sessions.");
  assert.equal(dialog()?.querySelectorAll("dl").length, 0, "no tiles");
  assert.equal(changeAccess()?.disabled, false);

  await act(async () => { changeAccess()!.click(); });
  await settle();
  assert.deepEqual(calls.updates, [{ owner: { kind: "user", userId: "user-me" }, token: "token-1" }]);
  assert.equal(calls.refreshed, 1);
  assertNoDomNode(dialog(), "the dialog closes once the change is applied");
});

test("narrowing to a team names the team and its member count, and an empty team says so", async () => {
  await renderReadout({
    previews: {
      "team:team-builders": async () => preview(buildersScope),
      "team:team-empty": async () => preview(scopeOf({ kind: "team", teamId: "team-empty" })),
    },
  });
  await openDialog();
  await choose("Team: Builders");
  await settle();
  let notice = dialog()?.querySelector(".notice.t-warning");
  assert.equal(text(notice?.querySelector(".notice-title")), "Only Builders Keeps Access");
  assert.equal(text(notice?.querySelector(".notice-body")),
    "Everyone on Builders (3 people) keeps access. 5 sessions, 2 of them active, are narrowed to the team.");
  assert.doesNotMatch(text(dialog()), /\bTwo\b|\bMe\b/u, "no member is named");

  await choose("Team: Ghosts");
  await settle();
  notice = dialog()?.querySelector(".notice.t-warning");
  assert.equal(text(notice?.querySelector(".notice-title")), "Ghosts Has No Members");
  assert.equal(text(notice?.querySelector(".notice-body")),
    "Only organization admins would keep access to this project and its 5 sessions.");
});

test("broadening is one dim sentence, with no warning", async () => {
  await renderReadout({
    scope: privateScope,
    previews: { organization: async () => preview(organizationScope, { currentScope: privateScope, sessionsToNarrow: 0 }) },
  });
  await openDialog();
  await choose("Organization-Wide");
  await settle();
  assert.equal(dialog()?.querySelectorAll(".notice").length, 0);
  assert.equal(text(dialog()?.querySelector(".access-change-sentence")),
    "Everyone in your organization will see this project and its 5 sessions.");
  assert.equal(changeAccess()?.disabled, false);
});

test("an incompatible preview is a danger notice in plain words with Change Location Access…", async () => {
  const location: ProjectView["locations"][number] = {
    id: "location-1", projectId: "project-1", runnerId: "runner-1", workspaceId: "workspace-1", name: "Laptop Checkout",
    path: "/repos/alpha", source: "managed", availability: "available", isDefault: true, createdAt: 1, updatedAt: 1,
    scope: privateScope, canManage: true,
  };
  const calls = await renderReadout({
    scope: privateScope,
    locations: [location],
    previews: {
      organization: async () => preview(organizationScope, {
        currentScope: privateScope,
        compatible: false,
        confirmationToken: undefined,
        reason: "The requested Project access would expose a narrower Location. Change that Location first or choose a narrower Project scope.",
      }),
    },
  });
  await openDialog();
  await choose("Organization-Wide");
  await settle();
  const notice = dialog()?.querySelector(".notice.t-danger");
  assert.equal(text(notice?.querySelector(".notice-title")), "Can't Change Access");
  assert.equal(text(notice?.querySelector(".notice-body")),
    "A location in this project is more private than this choice. Change that location's access first, or choose a more private option.");
  assert.ok(changeAccess()?.disabled, "an incompatible change cannot be applied");

  const fix = buttonNamed("Change Location Access…");
  assert.ok(fix, "the blocking location's access can be changed from here");
  await act(async () => { fix.click(); });
  await settle();
  const dialogs = [...body().querySelectorAll("[role=dialog]")];
  assert.equal(dialogs.length, 2, "Change Location Access stacks on Change Project Access");
  assert.equal(text(dialogs[1]!.querySelector(".modal-title")), "Change Location Access");
  assert.equal(text(dialogs[1]!.querySelector(".modal-desc")), "Laptop Checkout");
  assert.ok(calls.previews.includes("workspace:organization"), "it opens with the project's new access already chosen");
});

test("a failed preview is a danger notice with the raw message behind Show Details", async () => {
  await renderReadout({ previews: { "user:user-me": async () => { throw new Error("upstream 503: preview store offline"); } } });
  await openDialog();
  await choose("Private to Me");
  await settle();
  const notice = dialog()?.querySelector(".notice.t-danger");
  assert.equal(text(notice?.querySelector(".notice-title")), "Couldn't Check This Change");
  assert.doesNotMatch(text(notice), /preview store offline/u, "the raw message waits behind Show Details");
  const details = [...(notice?.querySelectorAll("button") ?? [])].find((button) => /Show Details/u.test(text(button)));
  assert.ok(details);
  await act(async () => { details.click(); });
  assert.match(text(notice), /upstream 503: preview store offline/u);
  assert.ok(changeAccess()?.disabled);
});

test("a Viewer sees the readout without Change…", async () => {
  await renderReadout({ who: identity("viewer"), scope: buildersScope });
  assert.deepEqual(readoutParts(body().querySelector(".access-scope-readout")),
    ["Team: Builders", "Everyone on Builders (3 people) can see and use it."]);
  assert.equal(buttonNamed("Change…"), undefined);
});

/* The Projects page itself: every access row is a readout, never a Select. */

const runner: RunnerView = {
  runnerId: "runner-1", hostname: "runner-host", os: "linux", version: "1", status: "online",
  displayName: "Build Machine", agents: [], workspaces: [], connectedAt: 1, lastSeen: 1,
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
  push(message: UiSnapshotMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

function ProjectsRoute() {
  const view = useStoreSelector((state) => state.view);
  return <ProjectsView selectedProjectId={view.name === "projects" ? view.id : undefined} onNewSession={() => {}} />;
}

async function renderProjectsPage(who: IdentityAdministrationView) {
  const project: ProjectView = {
    id: "project-1", name: "Alpha", hidden: false, scope: organizationScope, canManage: true,
    locations: [{
      id: "location-1", projectId: "project-1", runnerId: "runner-1", workspaceId: "workspace-1", name: "Checkout",
      path: "/repos/alpha", source: "managed", availability: "available", isDefault: true, createdAt: 1, updatedAt: 1,
      scope: organizationScope, canManage: true,
    }],
    activeSessionCount: 0, unarchivedSessionCount: 0, totalSessionCount: 0, createdAt: 1, updatedAt: 1,
  };
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: "projects-access", runtimeKey: "projects-access:1", createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "projects", id: "project-1" }), push() {}, listen: () => () => {},
  };
  const feedback = { confirm: async () => true, showToast: () => -1, showUndo: () => -1, dismissToast: () => undefined };
  const mountPoint = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(mountPoint as never);
  const root = createRoot(mountPoint);
  await act(async () => {
    root.render(
      <ApiProvider client={{ ...api, getIdentity: async () => who } as ApiClient}>
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
        accessScopeManagement: true,
      },
      runners: [runner], boxes: [], sessions: [], runs: [], pods: [], projects: [project],
    } as UiSnapshotMessage);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

test("on the Projects page the project and its location show their saved access as readouts, never a Select", async () => {
  await renderProjectsPage(identity());
  const readouts = [...body().querySelectorAll(".access-scope-readout")];
  assert.equal(readouts.length, 2, "one readout for the project and one for its location");
  for (const readout of readouts) {
    assert.deepEqual(readoutParts(readout), ["Organization-Wide", "Everyone in your organization can see and use it.", "Change…"]);
  }
  const options = [...body().querySelectorAll("[aria-haspopup=listbox]")].map((trigger) => text(trigger));
  assert.ok(!options.some((label) => /Organization-Wide|Private to Me|Team:/u.test(label)),
    "no Select on the page holds an access level");
  assert.equal(buttonNamed("Review Access Change"), undefined);
  assert.doesNotMatch(text(body()), /resource/iu);
});

test("a Viewer on the Projects page sees each access readout without Change…", async () => {
  await renderProjectsPage(identity("viewer"));
  assert.equal(body().querySelectorAll(".access-scope-readout").length, 2);
  assert.equal(buttonNamed("Change…"), undefined);
});
