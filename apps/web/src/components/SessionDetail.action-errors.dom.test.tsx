/**
 * #2511: a composer action the server refuses says what failed and what to do in one sentence, under
 * a title of its own, and keeps the server's words behind Show Details (docs/design-system.md §17.2).
 */

import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { Window } from "happy-dom";
import type { ControlPlaneToUi, RunnerView, SessionEvent, SessionView } from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { chooseTranscriptAction } from "../dom-test-transcript-actions.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { ConfirmationFailure, FeedbackContext, type ConfirmationOptions } from "./FeedbackProvider.js";
import { SessionDetail } from "./SessionDetail.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 72, width: 800, height: 72, toJSON: () => ({}) };
  },
});
// The transcript renders only the rows that fit its viewport, so it needs a height to show any.
for (const [name, value] of [["clientHeight", 1_200], ["offsetHeight", 72]] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  Node: domWindow.Node,
  Event: domWindow.Event,
  MouseEvent: domWindow.MouseEvent,
  KeyboardEvent: domWindow.KeyboardEvent,
  MutationObserver: domWindow.MutationObserver,
  getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
})) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

const runner = {
  runnerId: "runner-1",
  hostname: "runner-host",
  displayName: "Build Box",
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: "codex", name: "Codex", command: "codex", args: [], env: {},
    driver: "codex-app-server", available: true,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 192,
} as RunnerView;

let fixtureSequence = 0;
function sessionView(overrides: Partial<SessionView>): SessionView {
  fixtureSequence += 1;
  return {
    id: `action-errors-${fixtureSequence}`, runnerId: runner.runnerId, workspaceId: null, workspaceName: null,
    projectId: null, agentId: "codex", agentName: "Codex", title: "Action Errors Fixture", status: "idle",
    column: "review", runId: null, useWorktree: true, worktreePath: "/repos/demo/wt",
    archived: false, createdAt: 1, updatedAt: 1, lastEventAt: null, messageCount: 0,
    eventEpoch: 0, preview: null, pendingApproval: null, driver: "codex-app-server",
    model: "gpt-5.6-sol", effort: "high", permissionMode: null, tokensIn: 0, tokensOut: 0,
    costUsd: 0, adopted: false,
    ...overrides,
  };
}

function EventSeeder({ sessionId, payloads }: { sessionId: string; payloads: SessionEvent["payload"][] }) {
  const ready = useStoreSelector((state) => state.sessions.has(sessionId));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    payloads.forEach((payload, index) => {
      dispatch({
        type: "msg",
        msg: { type: "session_event", event: { id: index + 1, sessionId, seq: index + 1, ts: index + 1, payload } },
      });
    });
  }, [dispatch, payloads, ready, sessionId]);
  return null;
}

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

async function mount(current: SessionView, { client: overrides = {}, events }: {
  client?: Partial<ApiClient>;
  events?: SessionEvent["payload"][];
} = {}) {
  const toasts: string[] = [];
  /** What a confirmation that runs its action would show as its failure. */
  const confirmationFailures: unknown[] = [];
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: current.id, runtimeKey: `${current.id}:1`, createSocket: () => socket, close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: current.id }), push() {}, listen: () => () => {},
  };
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    getSessionEventPage: () => new Promise<never>(() => {}),
    getSessionEventTailPage: () => new Promise<never>(() => {}),
    ...overrides,
  } as unknown as ApiClient;
  const rightPanel = {
    open: false, mode: "launcher" as const, width: 360, dragging: false, subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {}, setDragging() {},
    close() {}, selectSubagent() {}, showSubagent() {}, consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => root.render(
    <ApiProvider client={client}>
      <FeedbackContext.Provider value={{
        // Every confirmation is accepted; one that runs its own action keeps a failure, as its
        // dialog would.
        confirm: async (options: ConfirmationOptions) => {
          if (!options.onConfirm) return true;
          try {
            await options.onConfirm(new AbortController().signal);
            return true;
          } catch (cause) {
            confirmationFailures.push(cause);
            return false;
          }
        },
        showToast: (message: string) => { toasts.push(message); return 0; },
        showUndo: () => 0,
        dismissToast: () => {},
      } as never}>
        <StoreProvider connection={connection} navigation={navigation}>
          {events && <EventSeeder sessionId={current.id} payloads={events} />}
          <SessionDetail sessionId={current.id} mode="expanded" rightPanel={rightPanel}
            onOpenTerminal={() => {}} composerDraftLoader={async () => null} />
        </StoreProvider>
      </FeedbackContext.Provider>
    </ApiProvider>,
  ));
  await act(async () => socket.push({
    type: "snapshot",
    capabilities: { sessionSubscriptions: false, boundedDelivery: false, paginatedSessionHistory: false, projects: true },
    // The machine's agent reports what the session's own capabilities say, as a live runner does.
    runners: [current.agentCapabilities
      ? { ...runner, agents: runner.agents.map((agent) => ({
        ...agent, capabilities: current.agentCapabilities as RunnerView["agents"][number]["capabilities"],
      })) }
      : runner],
    boxes: [], projects: [], sessions: [current], runs: [], pods: [],
  }));
  await flush();
  const slot = () => container.querySelector(".session-notice-slot") as HTMLElement | null;
  return {
    container,
    toasts,
    confirmationFailures,
    slot,
    /** Clicks the control with this accessible name anywhere on the page. */
    click: async (label: string) => {
      const control = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
        [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === label);
      assert.ok(control, `${label} is rendered`);
      assert.equal(control.disabled, false, `${label} is enabled`);
      await act(async () => { fireDomEvent.click(control); });
      await flush();
    },
    unmount: async () => {
      await flush(1);
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

type Fixture = Awaited<ReturnType<typeof mount>>;

/** The slot's notice with this title, chosen from "+N More" when another one is showing. */
async function slotNotice(fixture: Fixture, title: string): Promise<HTMLElement> {
  const shown = () => fixture.slot()?.querySelector<HTMLElement>(`.notice[aria-label="${title}"]`) ?? null;
  if (!shown()) {
    const more = [...fixture.slot()?.querySelectorAll<HTMLButtonElement>("button") ?? []]
      .find((button) => /^\+\d+ More$/u.test(button.textContent ?? ""));
    assert.ok(more, `${title} is shown or listed behind +N More`);
    await act(async () => { more.click(); });
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [role="menuitem"]')]
      .find((candidate) => candidate.textContent === title);
    assert.ok(item, `+N More lists ${title} by its title`);
    await act(async () => { item.click(); });
    await flush();
  }
  const notice = shown();
  assert.ok(notice, `${title} is a notice of the slot`);
  return notice;
}

/**
 * The notice reads the sentence under its title, and the server's words appear only after Show
 * Details: not in the sentence, and nowhere on the page before then.
 */
async function assertPlainFailure(fixture: Fixture, title: string, sentence: string, serverText: string) {
  const notice = await slotNotice(fixture, title);
  assert.equal(notice.querySelector(".notice-title")?.textContent, title);
  assert.equal(notice.querySelector(".notice-body p")?.textContent, sentence);
  assert.ok(!fixture.container.textContent?.includes(serverText), "the server's words are not on the page");
  assert.doesNotMatch(notice.textContent ?? "", /Action Failed/u);
  const details = [...notice.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent === "Show Details");
  assert.ok(details, "the server's words wait behind Show Details");
  await act(async () => { details.click(); });
  assert.equal(notice.querySelector(".notice-details-body .code-well code")?.textContent, serverText);
}

const refuse = (text: string, status = 409) => () => Promise.reject(new ApiError(text, status));

const pendingPrompt = (patch: Partial<NonNullable<SessionView["pendingPrompts"]>[number]>) => ({
  commandId: "prompt-1", text: "Summarize the changes", state: "pending" as const, revision: 1,
  attemptCount: 1, createdAt: 1, updatedAt: 1, ...patch,
});

test("a pending message's Cancel, Dismiss and Retry each name what failed", async () => {
  const cases = [
    { label: "Cancel Pending Message", patch: { canCancel: true }, title: "Message Not Canceled",
      sentence: "Couldn't cancel this message. Try again.", server: "prompt delivery may already have started" },
    { label: "Dismiss Pending Message", patch: { state: "failed" as const, canDismiss: true }, title: "Message Not Dismissed",
      sentence: "Couldn't dismiss this message. Try again.", server: "only failed or uncertain prompts can be dismissed" },
    { label: "Retry Message", patch: { state: "failed" as const, canRetry: true }, title: "Message Not Retried",
      sentence: "Couldn't retry this message. Try again.", server: "the retained prompt belongs to a different runner generation" },
  ];
  for (const { label, patch, title, sentence, server } of cases) {
    // Receipts follow the transcript, so it has an earlier message.
    const fixture = await mount(sessionView({ pendingPrompts: [pendingPrompt(patch)] }), {
      client: { resolvePendingPrompt: refuse(server) } as Partial<ApiClient>,
      events: [{ kind: "user_message", text: "an earlier message", images: [] }],
    });
    try {
      await fixture.click(label);
      await assertPlainFailure(fixture, title, sentence, server);
    } finally {
      await fixture.unmount();
    }
  }
});

test("canceling a live queued message names what failed, from its receipt and from the queue tray", async () => {
  const server = "queued prompt cancellation failed in the runner";
  for (const surface of ["receipt", "tray"] as const) {
    const fixture = await mount(sessionView({
      status: "running", activeTurnId: "turn-1",
      queued: [{ id: "prompt-1", text: "Then run the tests", steerable: false, liveQueueObserved: true }],
      ...(surface === "receipt" ? { pendingPrompts: [pendingPrompt({ commandId: "prompt-1" })] } : {}),
    }), { client: { cancelQueuedPrompt: refuse(server) } as Partial<ApiClient> });
    try {
      const control = surface === "receipt"
        ? fixture.container.querySelector<HTMLButtonElement>('[data-testid="pending-prompt-prompt-1"] button[aria-label="Cancel Pending Message"]')
        : fixture.container.querySelector<HTMLButtonElement>('[data-testid="queued-prompt-prompt-1"] button[aria-label="Cancel Queued Message"]');
      assert.ok(control, `the ${surface} offers Cancel`);
      await act(async () => { fireDomEvent.click(control); });
      await flush();
      await assertPlainFailure(fixture, "Message Not Canceled", "Couldn't cancel this queued message. Try again.", server);
    } finally {
      await fixture.unmount();
    }
  }
});

test("Stop Turn's other failures say to try again or use Stop Session", async () => {
  const server = "the runner could not stop the active turn";
  const fixture = await mount(sessionView({ status: "running", activeTurnId: "turn-1" }), {
    client: { cancelTurn: refuse(server) } as Partial<ApiClient>,
  });
  try {
    await fixture.click("Stop Turn");
    await assertPlainFailure(fixture, "Turn Not Stopped", "Couldn't stop the turn. Try again or use Stop Session.", server);
  } finally {
    await fixture.unmount();
  }
});

const CHECKPOINTED_TURNS: SessionEvent["payload"][] = [
  { kind: "user_message", text: "first", images: [] },
  { kind: "checkpoint", turn: 1, tree: "a".repeat(40) },
  { kind: "agent_message", text: "one", final: true },
  { kind: "conversation_checkpoint", turn: 1 },
  { kind: "user_message", text: "second", images: [] },
  { kind: "checkpoint", turn: 2, tree: "b".repeat(40) },
  { kind: "agent_message", text: "two", final: true },
  { kind: "conversation_checkpoint", turn: 2 },
];

test("a failed rewind is Rewind Failed, and a turn without a checkpoint says so", async () => {
  const server = "rewind failed: git checkout exited with 128";
  const fixture = await mount(sessionView({}), {
    client: { rewind: refuse(server) } as Partial<ApiClient>,
    events: CHECKPOINTED_TURNS,
  });
  try {
    await chooseTranscriptAction(fixture.container, "More Message Actions", "Rewind Files to Before This Turn…", 1);
    await flush();
    await assertPlainFailure(fixture, "Rewind Failed", "Couldn't rewind the files to before this turn. Try again.", server);
  } finally {
    await fixture.unmount();
  }

  const missing = await mount(sessionView({}), {
    client: { rewind: refuse("no checkpoint exists for turn 2") } as Partial<ApiClient>,
    events: CHECKPOINTED_TURNS,
  });
  try {
    await chooseTranscriptAction(missing.container, "More Message Actions", "Rewind Files to Before This Turn…", 1);
    await flush();
    const notice = await slotNotice(missing, "Rewind Failed");
    assert.equal(notice.querySelector(".notice-body p")?.textContent,
      "Couldn't rewind the files to before this turn. This turn has no checkpoint to rewind to.");
    assert.doesNotMatch(notice.textContent ?? "", /Show Details/u, "a known cause says all there is to say");
  } finally {
    await missing.unmount();
  }
});

test("a failed fork is Fork Not Created, and an uncertain one says not to retry", async () => {
  const server = "this provider session does not support conversation fork";
  const fixture = await mount(sessionView({}), {
    client: { fork: refuse(server) } as Partial<ApiClient>,
    events: CHECKPOINTED_TURNS,
  });
  try {
    await chooseTranscriptAction(fixture.container, "More Turn Actions", "Fork After This Turn…", 0);
    await flush();
    await assertPlainFailure(fixture, "Fork Not Created", "Couldn't fork this conversation. Try again.", server);
  } finally {
    await fixture.unmount();
  }

  const uncertain = await mount(sessionView({}), {
    client: { fork: refuse("runner disconnected before the request completed", 502) } as Partial<ApiClient>,
    events: CHECKPOINTED_TURNS,
  });
  try {
    await chooseTranscriptAction(uncertain.container, "More Turn Actions", "Fork After This Turn…", 0);
    await flush();
    await assertPlainFailure(uncertain, "Fork Outcome Unknown",
      "The fork outcome is uncertain. Do not retry. Wait for the child to appear on the Board, and reload only after checking there.",
      "runner disconnected before the request completed");
  } finally {
    await uncertain.unmount();
  }
});

test("Edit in a Fork's failure is a plain sentence, with the server's words kept for Show Details", async () => {
  // Its confirmation shows the failure (#2185); FeedbackProvider.dom.test.tsx renders the details.
  const server = "conversation fork failed: provider refused";
  const fixture = await mount(sessionView({}), {
    client: { fork: refuse(server) } as Partial<ApiClient>,
    events: CHECKPOINTED_TURNS,
  });
  try {
    await chooseTranscriptAction(fixture.container, "More Message Actions", "Edit in a Fork…", 1);
    await flush();
    const [failure] = fixture.confirmationFailures as Array<Error & { detail?: string }>;
    assert.equal(failure?.message, "Couldn't create the fork. Try again.");
    assert.ok(failure instanceof ConfirmationFailure);
    assert.equal(failure.detail, server);
  } finally {
    await fixture.unmount();
  }

  const busy = await mount(sessionView({}), {
    client: { fork: refuse("the source session is busy — wait before forking") } as Partial<ApiClient>,
    events: CHECKPOINTED_TURNS,
  });
  try {
    await chooseTranscriptAction(busy.container, "More Message Actions", "Edit in a Fork…", 1);
    await flush();
    const [failure] = busy.confirmationFailures as Array<Error & { detail?: string }>;
    assert.equal(failure?.message, "Couldn't create the fork. This session is busy. Wait for it to settle, then try again.");
    assert.equal(failure?.detail, undefined);
  } finally {
    await busy.unmount();
  }
});

test("a failed quarantine recovery is Session Not Recovered", async () => {
  const server = "this quarantined conversation has no safe checkpoint to recover from";
  const fixture = await mount(sessionView({
    historyQuarantine: { reason: "oversized_tool_call", detectedAt: 5, recoveryTurn: 2, recovery: "fork" },
  }), { client: { recoverQuarantinedConversation: refuse(server) } as Partial<ApiClient> });
  try {
    await fixture.click("Recover Session");
    await assertPlainFailure(fixture, "Session Not Recovered",
      "Couldn't start a new conversation from the last checkpoint. Try again.", server);
  } finally {
    await fixture.unmount();
  }
});

test("a failed restart from the composer is Session Not Restarted", async () => {
  const server = "Selected target harness installation is unavailable; choose another installation in Machine settings";
  const fixture = await mount(sessionView({ status: "stopped" }), { client: { restart: refuse(server) } as Partial<ApiClient> });
  try {
    await fixture.click("Restart Session");
    await assertPlainFailure(fixture, "Session Not Restarted", "Couldn't restart this session. Try again.", server);
  } finally {
    await fixture.unmount();
  }
});

const setupFailure: NonNullable<SessionView["worktrees"]>[number] = {
  id: "worktree-one", path: "/repos/demo/wt", branch: "agent/setup", source: "created", baseCommit: "a".repeat(40),
  setup: {
    status: "failed", configHash: "b".repeat(64), attemptId: "attempt-one",
    environmentKeys: [], copies: [],
    steps: [{ name: "Install Dependencies", status: "failed", optional: false, startedAt: 1, durationMs: 902, error: "exited with 1" }],
    error: "Install Dependencies exited with 1",
  },
};

test("Retry Setup names which step failed: the retry, or the restart after it", async () => {
  const server = "worktree operation failed: lockfile is busy";
  const fixture = await mount(sessionView({ worktrees: [setupFailure] }), {
    client: { retryWorktreeSetup: refuse(server) } as Partial<ApiClient>,
  });
  try {
    await fixture.click("Retry Setup");
    await assertPlainFailure(fixture, "Setup Not Retried", "Couldn't retry worktree setup. Try again.", server);
  } finally {
    await fixture.unmount();
  }

  const restartServer = "unarchive the session before restarting it";
  let current: SessionView = sessionView({ status: "failed", worktrees: [setupFailure] });
  const restarted = await mount(current, {
    client: {
      retryWorktreeSetup: async () => {
        current = { ...current, updatedAt: 2, worktrees: [] };
        return { session: current };
      },
      restart: refuse(restartServer),
    } as Partial<ApiClient>,
  });
  try {
    await restarted.click("Retry Setup");
    await assertPlainFailure(restarted, "Session Not Restarted",
      "Worktree setup finished, but the session couldn't restart. Try restarting it.", restartServer);
  } finally {
    await restarted.unmount();
  }
});

test("a workspace reference that can't be added is Reference Not Added", async () => {
  const server = "could not attach that workspace target";
  const fixture = await mount(sessionView({}), {
    client: {
      searchWorkspaceReferences: async () => ({ results: [{ path: "src/index.ts", isDirectory: false }], truncated: false }),
      createWorkspaceReference: refuse(server),
    } as Partial<ApiClient>,
  });
  try {
    const composer = fixture.container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      composer.focus();
      composer.value = "@index";
      fireDomEvent.change(composer);
      composer.setSelectionRange(6, 6);
      fireDomEvent.select(composer);
    });
    await flush(200);
    const option = fixture.container.querySelector<HTMLButtonElement>('[role="listbox"][aria-label="Workspace Paths"] [role="option"]');
    assert.ok(option, "the @ picker lists the file");
    await act(async () => { option.click(); });
    await flush();
    await assertPlainFailure(fixture, "Reference Not Added", "Couldn't add this reference. Try again.", server);
  } finally {
    await fixture.unmount();
  }
});

const steerable = {
  status: "running" as const,
  activeTurnId: "turn-1",
  agentCapabilities: {
    models: [], effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: false, supportsSteering: true,
  },
};

test("a queued message that can't steer the turn says it is still queued", async () => {
  const server = "the active turn changed before it could be steered";
  const fixture = await mount(sessionView({
    ...steerable,
    queued: [{ id: "queue-1", text: "Use the staging database", steerable: true, liveQueueObserved: true }],
  }), { client: { steer: refuse(server) } as Partial<ApiClient> });
  try {
    await fixture.click("Steer Queued Message");
    await assertPlainFailure(fixture, "Message Not Steered",
      "Couldn't steer the turn with this queued message. It's still queued.", server);
  } finally {
    await fixture.unmount();
  }

  // A lost answer may follow a steer the machine took, which takes the message off the queue.
  const lost = await mount(sessionView({
    ...steerable,
    queued: [{ id: "queue-1", text: "Use the staging database", steerable: true, liveQueueObserved: true }],
  }), { client: { steer: refuse("Gateway Timeout", 504) } as Partial<ApiClient> });
  try {
    await lost.click("Steer Queued Message");
    await assertPlainFailure(lost, "Steer Not Confirmed",
      "Couldn't confirm whether the turn took this queued message. Check the transcript and the queue before steering it again.",
      "Gateway Timeout");
  } finally {
    await lost.unmount();
  }
});

test("an uncertain steer's Queue Again and Dismiss each name what failed", async () => {
  const server = "steering attempt resolution action conflicts with an in-flight request";
  for (const [label, title, sentence] of [
    ["Queue Again", "Message Not Queued", "Couldn't queue this message again. Try again."],
    ["Dismiss", "Message Not Dismissed", "Couldn't dismiss this message. Try again."],
  ] as const) {
    const fixture = await mount(sessionView({
      ...steerable,
      steeringAttempts: [{
        submissionId: "steer-1", turnId: "turn-1", source: "direct", text: "Prefer the smaller fix",
        state: "uncertain", reason: "transport_uncertain", createdAt: 1, updatedAt: 1,
      }],
    }), { client: { resolveSteeringAttempt: refuse(server) } as Partial<ApiClient> });
    try {
      const control = [...fixture.container.querySelectorAll<HTMLButtonElement>('[data-testid="steering-attempt-steer-1"] button')]
        .find((button) => button.textContent === label);
      assert.ok(control, `the uncertain steer offers ${label}`);
      await act(async () => { fireDomEvent.click(control); });
      await flush();
      await assertPlainFailure(fixture, title, sentence, server);
    } finally {
      await fixture.unmount();
    }
  }
});

test("an offline machine is named in the sentence, with nothing behind Show Details", async () => {
  const fixture = await mount(sessionView({ status: "stopped" }), {
    client: { restart: refuse("runner is offline") } as Partial<ApiClient>,
  });
  try {
    await fixture.click("Restart Session");
    const notice = await slotNotice(fixture, "Session Not Restarted");
    assert.equal(notice.querySelector(".notice-body p")?.textContent,
      "Couldn't restart this session. Build Box is offline. Try again once it reconnects.");
    assertNoDomNode(notice.querySelector(".notice-details-toggle"));
    assert.doesNotMatch(fixture.container.textContent ?? "", /runner is offline/u);
  } finally {
    await fixture.unmount();
  }
});
