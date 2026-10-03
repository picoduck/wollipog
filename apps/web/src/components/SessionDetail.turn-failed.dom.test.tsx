import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionEvent, SessionEventsResponse, SessionView } from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "./SessionDetail.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

/** Retry Turn on a failed turn's notice, wired to the session (#2169). */

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
for (const [name, value] of Object.entries({
  window: domWindow, document: domWindow.document, navigator: domWindow.navigator,
  localStorage: domWindow.localStorage, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement, Node: domWindow.Node, Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent, KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver, React, IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

// happy-dom has no layout: give each virtual row a height and the reader a tall viewport, so the
// transcript mounts its rows.
const isRow = (element: Element) => element.hasAttribute("data-virtual-row");
const heightOf = (element: Element) => isRow(element) ? 120 : 4_000;
const elementPrototype = domWindow.HTMLElement.prototype as unknown as HTMLElement;
Object.defineProperty(elementPrototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) { return heightOf(this); },
});
Object.defineProperty(elementPrototype, "offsetWidth", { configurable: true, get: () => 800 });
Object.defineProperty(elementPrototype, "clientHeight", {
  configurable: true,
  get(this: HTMLElement) { return heightOf(this); },
});
elementPrototype.getBoundingClientRect = function (this: HTMLElement) {
  const height = heightOf(this);
  return { top: 0, left: 0, right: 800, bottom: height, width: 800, height, x: 0, y: 0, toJSON() {} } as DOMRect;
};

const runner = {
  runnerId: "runner-1", hostname: "build-box.local", displayName: "Build Box", os: "linux", version: "1",
  status: "online",
  agents: [{ id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
  workspaces: [], connectedAt: 1, lastSeen: 1, protocolVersion: 200,
} as RunnerView;

class FakeSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
  push(message: ControlPlaneToUi) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

async function flush(delay = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await Promise.resolve();
  });
}

let sequence = 0;
interface FixtureOptions {
  status: SessionView["status"];
  runnerStatus?: RunnerView["status"];
  overrides?: Partial<SessionView>;
  /** Replaces the default restart, which resolves at once with a starting session. */
  restart?: (session: SessionView) => Promise<SessionView>;
}

async function withFailedTurn(
  { status, runnerStatus = "online", overrides = {}, restart }: FixtureOptions,
  check: (view: { id: string; container: HTMLElement; calls: string[]; retry: () => HTMLButtonElement | undefined }) => Promise<void>,
) {
  sequence += 1;
  const id = `turn-failed-${sequence}`;
  const session = {
    id, runnerId: runner.runnerId, workspaceId: null, workspaceName: "wollipog", projectId: null,
    agentId: "claude", agentName: "Claude Code", title: "Failed Turn", status, column: "review", runId: null,
    useWorktree: false, worktreePath: null, archived: false, createdAt: 1, updatedAt: 1, lastEventAt: null,
    messageCount: 2, eventEpoch: 0, preview: null, pendingApproval: null, driver: "claude-code", model: null,
    effort: null, permissionMode: null, tokensIn: 0, tokensOut: 0, costUsd: 0, adopted: false,
    ...overrides,
  } as SessionView;
  const events: SessionEvent[] = ([
    { kind: "user_message", text: "Summarize the release notes", images: [] },
    { kind: "error", message: "prompt failed: Rate limit reached" },
    { kind: "error", message: "Rate limit reached" },
  ] as SessionEvent["payload"][]).map((payload, index) =>
    ({ id: index + 1, sessionId: id, seq: index + 1, ts: Date.UTC(2026, 9, 2, 0, 25, index), payload }));
  const calls: string[] = [];
  const tail: Array<(value: SessionEventsResponse) => void> = [];
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<SessionEventsResponse>((resolve) => { tail.push(resolve); }),
    restart: async (sessionId: string) => {
      calls.push(`restart:${sessionId}`);
      return restart ? restart(session) : { ...session, status: "starting" as const };
    },
    prompt: async (sessionId: string, text: string, images: unknown[]) => {
      calls.push(`prompt:${sessionId}:${text}:${images.length}`);
      return { ...session, status: "queued" as const };
    },
  } as unknown as ApiClient;
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = { instanceId: id, runtimeKey: `${id}:1`, createSocket: () => socket, close() {} };
  const navigation: ViewNavigation = { current: () => ({ name: "session", id }), push() {}, listen: () => () => {} };
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {}, close() {},
    selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <SessionDetail sessionId={id} mode="expanded" rightPanel={rightPanel} onOpenTerminal={() => {}}
            composerDraftLoader={async () => null} />
        </StoreProvider>
      </ApiProvider>,
    ));
    await act(async () => socket.push({
      type: "snapshot",
      capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
      runners: [{ ...runner, status: runnerStatus }], boxes: [], projects: [], sessions: [session], runs: [], pods: [],
    }));
    await flush();
    const resolve = tail.shift();
    assert.ok(resolve, "the transcript's tail is requested");
    await act(async () => resolve({ events, eventEpoch: 0, nextBefore: 0, hasMoreOlder: false, cacheComplete: true }));
    await flush();
    await check({
      id,
      container,
      calls,
      retry: () => [...container.querySelectorAll<HTMLButtonElement>(".notice button")]
        .find((button) => button.textContent === "Retry Turn"),
    });
  } finally {
    await flush(1);
    await act(async () => root.unmount());
    container.remove();
  }
}

const resumable = { driver: "codex-app-server", agentId: "codex", agentName: "Codex" } as const;
const click = (button: HTMLButtonElement) =>
  act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 5)); });
const reasonOf = (button: HTMLButtonElement) =>
  domWindow.document.getElementById(button.getAttribute("aria-describedby") ?? "");

test("a failed session's tail is one Turn Failed notice, and Retry Turn restarts it and then submits the prompt", async () => {
  await withFailedTurn({ status: "failed", overrides: resumable }, async ({ id, container, calls, retry }) => {
    const titles = [...container.querySelectorAll(".notice-title")].map((title) => title.textContent);
    assert.deepEqual(titles.filter((title) => title === "Turn Failed"), ["Turn Failed"]);
    const rows = [...container.querySelectorAll(".timeline [data-virtual-row], .timeline [role='listitem']")];
    assert.equal(rows.at(-1)?.querySelector(".notice-title")?.textContent, "Turn Failed",
      "the last transcript row is the notice");
    const button = retry();
    assert.ok(button);
    assert.equal(button.disabled, false);
    await click(button);
    assert.deepEqual(calls, [`restart:${id}`, `prompt:${id}:Summarize the release notes:0`]);
  });
});

test("an idle session's Retry Turn submits the prompt without restarting", async () => {
  await withFailedTurn({ status: "idle" }, async ({ id, calls, retry }) => {
    await click(retry()!);
    assert.deepEqual(calls, [`prompt:${id}:Summarize the release notes:0`]);
  });
});

test("a refused restart shows its error in the notice and sends no prompt", async () => {
  await withFailedTurn({
    status: "failed",
    overrides: resumable,
    restart: async () => { throw new Error("the parent session has 0 remaining live child slots"); },
  }, async ({ id, container, calls, retry }) => {
    await click(retry()!);
    assert.deepEqual(calls, [`restart:${id}`], "the prompt is never sent after a failed restart");
    const notice = retry()!.closest(".notice")!;
    assert.equal(notice.querySelector('[role="alert"]')?.textContent,
      "Couldn't retry the turn: the parent session has 0 remaining live child slots");
    assert.equal(retry()!.disabled, false, "the person can try again");
    assert.doesNotMatch(container.querySelector(".composer")?.textContent ?? "", /live child slots/u,
      "the error belongs to the notice, not the composer");
  });
});

test("Retry Turn stays busy until restart and prompt both settle, and a second click submits nothing", async () => {
  let finishRestart: (() => void) | undefined;
  await withFailedTurn({
    status: "failed",
    overrides: resumable,
    restart: (session) => new Promise((resolve) => { finishRestart = () => resolve({ ...session, status: "starting" }); }),
  }, async ({ id, calls, retry }) => {
    const button = retry()!;
    await click(button);
    await click(button);
    assert.deepEqual(calls, [`restart:${id}`]);
    assert.equal(retry()!.getAttribute("aria-busy"), "true");
    assert.equal(retry()!.getAttribute("aria-disabled"), "true");
    await act(async () => { finishRestart!(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.deepEqual(calls, [`restart:${id}`, `prompt:${id}:Summarize the release notes:0`], "one restart, one prompt");
    assert.equal(retry()!.getAttribute("aria-busy"), null);
  });
});

const viewerReason = "Your Viewer role is read-only.";
const disabledCases: Array<{ name: string; options: FixtureOptions; reason: string }> = [
  { name: "the runner is offline", options: { status: "failed", runnerStatus: "offline", overrides: resumable }, reason: "Runner is offline." },
  {
    name: "a Viewer may not prompt",
    options: { status: "idle", overrides: { commandPermissions: { prompt: { allowed: false, reason: viewerReason } } as SessionView["commandPermissions"] } },
    reason: viewerReason,
  },
  {
    name: "a Viewer may not restart a failed session",
    options: { status: "failed", overrides: { ...resumable, commandPermissions: { restart: { allowed: false, reason: viewerReason } } as SessionView["commandPermissions"] } },
    reason: viewerReason,
  },
  {
    name: "the conversation is quarantined",
    options: { status: "idle", overrides: { historyQuarantine: { reason: "oversized_tool_call", detectedAt: 5, recoveryTurn: 2, recovery: "fork" } as SessionView["historyQuarantine"] } },
    reason: "Conversation quarantined. Recover this session to continue.",
  },
  {
    name: "the worktree needs recovery",
    options: { status: "idle", overrides: { worktreeRecovery: { recoveryId: "worktree-recovery:test", detectedAt: 2, selectedPath: "/repo/missing", detail: "The selected worktree is no longer registered." } as SessionView["worktreeRecovery"] } },
    reason: "Worktree recovery is required before sending another message.",
  },
  { name: "the session is archived", options: { status: "stopped", overrides: { ...resumable, archived: true } }, reason: "Unarchive the session to send a message." },
  {
    name: "a Stop failed",
    options: { status: "stopped", overrides: { ...resumable, stopOperation: { operationId: "stop-1", status: "stop_failed", requestedAt: 1, lastAttemptAt: 1, attemptCount: 1 } as SessionView["stopOperation"] } },
    reason: "Retry the failed Stop before retrying this turn.",
  },
  { name: "another turn is running", options: { status: "running" }, reason: "The agent is working on another turn." },
  {
    name: "a failed Claude Code session's restart would start a new conversation",
    options: { status: "failed", overrides: { driver: "claude-code" } },
    reason: "Restarting starts a new conversation. Restart the session, then send the message again.",
  },
  {
    name: "a stopped exec Codex session's restart would start a new conversation",
    options: { status: "stopped", overrides: { driver: "codex", agentId: "codex", agentName: "Codex" } },
    reason: "Restarting starts a new conversation. Restart the session, then send the message again.",
  },
];

test("a failed Pi session also restarts, resuming its conversation, before the prompt", async () => {
  await withFailedTurn({ status: "failed", overrides: { driver: "pi", agentId: "pi", agentName: "Pi" } }, async ({ id, calls, retry }) => {
    await click(retry()!);
    assert.deepEqual(calls, [`restart:${id}`, `prompt:${id}:Summarize the release notes:0`]);
  });
});

test("an accepted retry shows the session busy at once, so a second click cannot submit the prompt again", async () => {
  // No socket update follows here: only the prompt's own response says the session is now queued.
  await withFailedTurn({ status: "idle" }, async ({ id, calls, retry }) => {
    await click(retry()!);
    const button = retry()!;
    assert.equal(button.disabled, true);
    assert.equal(reasonOf(button)?.textContent, "The agent is working on another turn.");
    await click(button);
    assert.deepEqual(calls, [`prompt:${id}:Summarize the release notes:0`]);
  });
});

const composerRestart = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('.composer button[aria-label="Restart Session"], .composer button[aria-label="Restarting Session"]');

test("while Retry Turn restarts a stopped session, the composer's Restart Session waits", async () => {
  let finishRestart: (() => void) | undefined;
  await withFailedTurn({
    status: "stopped",
    overrides: resumable,
    restart: (session) => new Promise((resolve) => { finishRestart = () => resolve({ ...session, status: "starting" }); }),
  }, async ({ id, container, calls, retry }) => {
    const restart = composerRestart(container);
    assert.ok(restart, "a stopped session offers Restart Session in the composer");
    await click(retry()!);
    assert.equal(composerRestart(container)!.disabled, true);
    await click(composerRestart(container)!);
    assert.deepEqual(calls, [`restart:${id}`], "one restart");
    await act(async () => { finishRestart!(); await new Promise((resolve) => setTimeout(resolve, 5)); });
    assert.deepEqual(calls, [`restart:${id}`, `prompt:${id}:Summarize the release notes:0`]);
  });
});

test("while the composer's Restart Session runs, Retry Turn waits and says why", async () => {
  let finishRestart: (() => void) | undefined;
  await withFailedTurn({
    status: "stopped",
    overrides: resumable,
    restart: (session) => new Promise((resolve) => { finishRestart = () => resolve({ ...session, status: "starting" }); }),
  }, async ({ id, container, calls, retry }) => {
    await click(composerRestart(container)!);
    const button = retry()!;
    assert.equal(button.disabled, true);
    assert.equal(reasonOf(button)?.textContent, "The session is restarting.");
    await click(button);
    assert.deepEqual(calls, [`restart:${id}`], "Retry Turn neither restarts again nor prompts");
    await act(async () => { finishRestart!(); await new Promise((resolve) => setTimeout(resolve, 5)); });
  });
});

test("an idle Claude Code session's Retry Turn prompts directly", async () => {
  await withFailedTurn({ status: "idle", overrides: { driver: "claude-code" } }, async ({ id, calls, retry }) => {
    await click(retry()!);
    assert.deepEqual(calls, [`prompt:${id}:Summarize the release notes:0`]);
  });
});

for (const { name, options, reason } of disabledCases) {
  test(`Retry Turn is disabled with a visible reason when ${name}`, async () => {
    await withFailedTurn(options, async ({ calls, retry }) => {
      const button = retry();
      assert.ok(button, "the notice keeps Retry Turn, disabled");
      assert.equal(button.disabled, true);
      const line = reasonOf(button);
      assert.equal(line?.textContent, reason);
      assert.ok(line?.closest(".notice-body"), "the reason is a visible line in the notice");
      await act(async () => button.click());
      assert.deepEqual(calls, []);
    });
  });
}
