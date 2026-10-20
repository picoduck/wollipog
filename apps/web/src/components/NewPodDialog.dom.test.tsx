import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { CreatePodRequest, PodView, ProjectView, RunnerView, SessionView, UiSnapshotMessage } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { View, ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { NewPodDialog } from "./NewPodDialog.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";
import { assertNoDomNode } from "../dom-test-assertions.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLSelectElement: domWindow.HTMLSelectElement, HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Node: domWindow.Node, Event: domWindow.Event, MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent, MutationObserver: domWindow.MutationObserver,
  React, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const studio = {
  runnerId: "runner-studio-7f3a", hostname: "studio.local", displayName: "Studio Mac", os: "darwin", version: "1",
  status: "online", agents: [], workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 141,
} as unknown as RunnerView;
// No name of its own: it is named by its hostname, never by its id.
const buildBox = {
  runnerId: "runner-build-91c2", hostname: "build-box", os: "linux", version: "1",
  status: "online", agents: [], workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 141,
} as unknown as RunnerView;
const project = { id: "project-wollipog", name: "Wollipog" } as unknown as ProjectView;

function session(id: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id, runnerId: studio.runnerId, workspaceId: null, workspaceName: null, projectId: project.id,
    agentId: "codex", agentName: "Codex", title: `Session ${id}`, status: "idle", column: "review",
    runId: null, useWorktree: true, worktreePath: `/worktrees/${id}`, archived: false, createdAt: 1, updatedAt: 1,
    lastEventAt: null, messageCount: 0, eventEpoch: 0, preview: null, pendingApproval: null,
    driver: "acp", model: null, effort: null, permissionMode: null,
    tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    ...overrides,
  } as SessionView;
}

function pod(id: string, memberIds: string[], status: PodView["status"] = "active"): PodView {
  return {
    id, title: id, objective: "", status, createdAt: 1, updatedAt: 1,
    members: memberIds.map((sessionId) => ({ sessionId, joinedAt: 1, role: "worker", contextTokenBudget: null, lastContextSeq: 0 })),
  };
}

const SESSIONS = [
  session("plan", { title: "Plan the retry migration", agentId: "claude", agentName: "Claude Code", driver: "claude-code", updatedAt: 4 }),
  session("migrate", { title: "Migrate the call sites", updatedAt: 3 }),
  session("review", { title: "Review the migration", runnerId: buildBox.runnerId, worktreePath: undefined, updatedAt: 2 }),
  session("same", { title: "Migrate the call sites", agentId: "opencode", agentName: "OpenCode", driver: "acp", projectId: null, updatedAt: 1 }),
];

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

const snapshot = (sessions: SessionView[], pods: PodView[] = []): UiSnapshotMessage => ({
  type: "snapshot",
  capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
  runners: [studio, buildBox], boxes: [], projects: [project], sessions, runs: [], pods,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function mount(options: {
  sessions?: SessionView[];
  pods?: PodView[];
  createPod?: (request: CreatePodRequest) => Promise<{ pod: PodView }>;
  onNewSession?: () => void;
} = {}) {
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = { instanceId: "new-pod", runtimeKey: "new-pod:1", createSocket: () => socket, close() {} };
  const pushed: View[] = [];
  const closes: number[] = [];
  const navigation: ViewNavigation = { current: () => ({ name: "pods" }), push: (view) => { pushed.push(view); }, listen: () => () => {} };
  const client = { ...api, createPod: options.createPod ?? (() => new Promise<never>(() => {})) } as unknown as ApiClient;
  // StrictMode replays every effect once, as development does: the dialog's answers must survive it.
  await act(async () => root.render(
    <React.StrictMode>
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <NewPodDialog onClose={() => closes.push(1)} onNewSession={options.onNewSession} />
        </StoreProvider>
      </ApiProvider>
    </React.StrictMode>,
  ));
  await act(async () => socket.push(snapshot(options.sessions ?? SESSIONS, options.pods)));
  const dialog = () => domWindow.document.querySelector('[role="dialog"]') as unknown as HTMLElement;
  const body = () => dialog().querySelector(".modal-body") as HTMLElement;
  const foot = () => dialog().querySelector(".modal-foot") as HTMLElement;
  const button = (scope: ParentNode, name: string) =>
    [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === name) as HTMLButtonElement | undefined;
  const create = () => button(foot(), "Create Pod")!;
  const rows = () => [...dialog().querySelectorAll(".choice-row")] as HTMLElement[];
  const row = (title: string, agent?: string) => rows().find((candidate) =>
    candidate.querySelector(".choice-row-title")?.textContent === title &&
    (!agent || candidate.querySelector(".choice-row-desc")?.textContent?.startsWith(agent))) as HTMLElement;
  const check = (title: string, agent?: string) => act(async () => (row(title, agent).querySelector("input") as HTMLInputElement).click());
  const nameField = () => [...dialog().querySelectorAll("label.field")]
    .find((label) => label.querySelector("span")?.textContent === "Name")!.querySelector("input") as HTMLInputElement;
  const setName = (value: string) => act(async () => fireDomEvent.change(nameField(), { target: { value } }));
  const filter = () => dialog().querySelector('input[aria-label="Filter Sessions"]') as HTMLInputElement;
  const setFilter = (value: string) => act(async () => fireDomEvent.change(filter(), { target: { value } }));
  const reason = () => foot().querySelector(".new-pod-reason")?.textContent ?? null;
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { dialog, body, foot, button, create, rows, row, check, setName, filter, setFilter, reason, pushed, closes, unmount, socket };
}

test("New Pod names its fields and its rule once, and each row by title, agent, project and machine, never by an id", async () => {
  const view = await mount();
  try {
    assert.equal(view.dialog().querySelector(".modal-title")?.textContent, "New Pod");
    assert.equal(view.dialog().querySelector(".modal-desc")?.textContent, "Group sessions so their agents can share notes and merge work.");
    const labels = [...view.dialog().querySelectorAll(".field > span:first-child")].map((label) => label.textContent);
    assert.deepEqual(labels, ["Name", "Objective (Optional)", "Sessions"]);
    const text = view.dialog().textContent ?? "";
    assert.equal(text.split("Only sessions with their own worktree that aren't in another pod can join.").length, 2, "the rule is said once");

    assert.deepEqual(view.rows().map((candidate) => [
      candidate.querySelector(".choice-row-title")?.textContent,
      candidate.querySelector(".choice-row-desc")?.textContent,
    ]), [
      ["Plan the retry migration", "Claude Code · Wollipog · Studio Mac"],
      ["Migrate the call sites", "Codex · Wollipog · Studio Mac"],
      ["Review the migration", "Codex · Wollipog · build-box · Worktree starting…"],
      // Two sessions with one title differ by their agent.
      ["Migrate the call sites", "OpenCode · Studio Mac"],
    ]);
    for (const id of [studio.runnerId, buildBox.runnerId, ...SESSIONS.map((candidate) => candidate.id)]) {
      assert.doesNotMatch(view.dialog().innerHTML.replace(/ (?:id|for|aria-[a-z]+|name|value)="[^"]*"/gu, ""), new RegExp(id, "u"),
        `no row prints ${id}`);
    }
    assert.doesNotMatch(text, /Worktree Ready/u);
    assert.doesNotMatch(text, /runner/iu, "machine vocabulary");
    assert.equal(view.dialog().querySelectorAll(".form-error").length, 0);
  } finally {
    await view.unmount();
  }
});

test("Create Pod says why it is unavailable in the footer until two sessions and a name are chosen", async () => {
  const view = await mount();
  try {
    assert.equal(view.create().disabled, true);
    assert.equal(view.reason(), "Choose at least 2 sessions.");
    const reasonId = view.foot().querySelector(".new-pod-reason")!.id;
    assert.equal(view.create().getAttribute("aria-describedby"), reasonId);

    await view.setName("Retry Migration");
    await view.check("Plan the retry migration");
    assert.equal(view.create().disabled, true, "one chosen");
    assert.equal(view.reason(), "Choose at least 2 sessions.");

    await view.check("Migrate the call sites", "Codex");
    await view.setName("  ");
    assert.equal(view.create().disabled, true, "a blank name");
    assert.equal(view.reason(), "Enter a name.");

    await view.setName("Retry Migration");
    assert.equal(view.create().disabled, false);
    assert.equal(view.reason(), null);
    assert.equal(view.create().hasAttribute("aria-describedby"), false);
  } finally {
    await view.unmount();
  }
});

test("Filter Sessions narrows the rows by title and agent, keeps the choices, and offers Clear Filter when nothing matches", async () => {
  const view = await mount();
  try {
    await view.check("Plan the retry migration");
    await view.setFilter("migrate");
    assert.deepEqual(view.rows().map((candidate) => candidate.querySelector(".choice-row-desc")?.textContent),
      ["Codex · Wollipog · Studio Mac", "OpenCode · Studio Mac"], "by title");
    await view.setFilter("OPENCODE");
    assert.deepEqual(view.rows().map((candidate) => candidate.querySelector(".choice-row-desc")?.textContent), ["OpenCode · Studio Mac"], "by agent");
    await view.setFilter("claude retry");
    assert.equal(view.rows().length, 1, "every word, in title or agent");

    await view.setFilter("terraform");
    assert.equal(view.rows().length, 0);
    const noResults = view.dialog().querySelector(".pod-session-no-results") as HTMLElement;
    assert.equal(noResults.textContent?.includes("No sessions match “terraform”."), true);
    await act(async () => view.button(noResults, "Clear Filter")!.click());
    assert.equal(view.filter().value, "");
    assert.equal(view.rows().length, 4);
    assert.equal((view.row("Plan the retry migration").querySelector("input") as HTMLInputElement).checked, true, "the choice is kept");

    // Escape clears the filter first; the dialog stays open.
    await view.setFilter("plan");
    await act(async () => fireDomEvent.keyDown(view.filter(), { key: "Escape" }));
    assert.equal(view.filter().value, "");
    assert.equal(view.closes.length, 0);
  } finally {
    await view.unmount();
  }
});

test("a server error is a danger notice at the end of the body, with its detail behind Show Details, and the footer keeps two buttons", async () => {
  const request = deferred<{ pod: PodView }>();
  const view = await mount({ createPod: () => request.promise });
  try {
    await view.setName("Retry Migration");
    await view.check("Plan the retry migration");
    await view.check("Migrate the call sites", "Codex");
    await act(async () => view.create().click());
    await act(async () => request.reject(new Error("session migrate is already a member of pod pod-9")));

    const notice = view.body().lastElementChild as HTMLElement;
    assert.match(notice.className, /\bnotice\b.*\bt-danger\b/u);
    assert.equal(notice.getAttribute("role"), "alert");
    assert.match(notice.textContent ?? "", /The pod wasn't created\. Try again\./u);
    assert.doesNotMatch(notice.textContent ?? "", /pod-9/u, "the raw detail waits behind Show Details");
    await act(async () => view.button(notice, "Show Details")!.click());
    assert.match(notice.textContent ?? "", /already a member of pod pod-9/u);

    assert.deepEqual([...view.foot().querySelectorAll("button")].map((child) => child.textContent?.trim()), ["Cancel", "Create Pod"]);
    assert.equal(view.reason(), null);
    assertNoDomNode(view.foot().querySelector(".form-error"), "no footer error");
    assert.equal(view.create().disabled, false, "Create Pod can try again");
    assert.equal(view.pushed.length, 0);
  } finally {
    await view.unmount();
  }
});

test("with no eligible session the list's place says No Sessions Can Join and offers New Session…", async () => {
  let opened = 0;
  const view = await mount({
    onNewSession: () => { opened += 1; },
    sessions: [
      session("shared", { title: "Already in a pod" }),
      session("chat", { title: "No worktree", useWorktree: false, worktreePath: undefined }),
      session("done", { title: "Finished", status: "completed" }),
      session("other", { title: "In a pod" }),
    ],
    pods: [pod("pod-1", ["shared", "other"])],
  });
  try {
    const state = view.dialog().querySelector(".modal-body .state") as HTMLElement;
    assert.ok(state, "the empty state shows");
    assert.equal(state.querySelector(".state-title")?.textContent, "No Sessions Can Join");
    assert.equal(state.querySelector(".state-body")?.textContent, "Only sessions with their own worktree that aren't in another pod can join.");
    assert.equal(view.rows().length, 0);
    assertNoDomNode(view.filter(), "no filter over nothing");
    await act(async () => view.button(state, "New Session…")!.click());
    assert.equal(opened, 1);
    assert.equal(view.create().disabled, true);
    assert.equal(view.reason(), "Choose at least 2 sessions.");
  } finally {
    await view.unmount();
  }
});

test("a session in a closed pod can join, and one that joins another pod while chosen stops counting", async () => {
  const view = await mount({ pods: [pod("old", ["plan", "migrate"], "closed")] });
  try {
    assert.equal(view.rows().length, 4, "a closed pod holds no one");
    await view.setName("Retry Migration");
    await view.check("Plan the retry migration");
    await view.check("Migrate the call sites", "Codex");
    assert.equal(view.create().disabled, false);
    await act(async () => view.socket.push(snapshot(SESSIONS, [pod("elsewhere", ["plan", "same"])])));
    assert.equal(view.rows().length, 2);
    assert.equal(view.create().disabled, true);
    assert.equal(view.reason(), "Choose at least 2 sessions.");
  } finally {
    await view.unmount();
  }
});

test("while the pod is being created the dialog cannot be dismissed, and then opens the pod it made", async () => {
  const request = deferred<{ pod: PodView }>();
  const sent: CreatePodRequest[] = [];
  const view = await mount({ createPod: (body) => { sent.push(body); return request.promise; } });
  try {
    await view.setName("  Retry Migration ");
    await view.check("Plan the retry migration");
    await view.check("Migrate the call sites", "Codex");
    await act(async () => view.create().click());
    await act(async () => view.create().click());
    assert.equal(sent.length, 1, "one request");
    assert.deepEqual(sent[0], { title: "Retry Migration", objective: undefined, sessionIds: ["plan", "migrate"] });

    assert.equal(view.button(view.foot(), "Cancel")!.disabled, true);
    await act(async () => { domWindow.dispatchEvent(new domWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(view.closes.length, 0, "Escape waits for the answer");

    await act(async () => request.resolve({ pod: pod("pod-new", ["plan", "migrate"]) }));
    assert.deepEqual(view.pushed.at(-1), { name: "pod", id: "pod-new" });
    assert.equal(view.closes.length, 1);
  } finally {
    await view.unmount();
  }
});

test("an answer that arrives after the dialog unmounted neither navigates nor updates it", async () => {
  for (const outcome of ["resolve", "reject"] as const) {
    const request = deferred<{ pod: PodView }>();
    const view = await mount({ createPod: () => request.promise });
    await view.setName("Retry Migration");
    await view.check("Plan the retry migration");
    await view.check("Migrate the call sites", "Codex");
    await act(async () => view.create().click());
    await view.unmount();
    await act(async () => {
      if (outcome === "resolve") request.resolve({ pod: pod("pod-late", ["plan", "migrate"]) });
      else request.reject(new Error("late"));
    });
    assert.deepEqual(view.pushed, [], outcome);
    assert.deepEqual(view.closes, [], outcome);
  }
});
