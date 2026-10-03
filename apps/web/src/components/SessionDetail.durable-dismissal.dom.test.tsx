import { fireDomEvent } from "./test-dom-events.js";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import type {
  ControlPlaneToUi,
  RunnerView,
  SessionEvent,
  SessionView,
} from "@wollipog/protocol";
import { api, ApiError, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { chooseTranscriptAction, readTranscriptAction } from "../dom-test-transcript-actions.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "./SessionDetail.js";
import { FeedbackProvider } from "./FeedbackProvider.js";
import { assertNoDomNode } from "../dom-test-assertions.js";
import { installDomTestCleanup } from "../dom-test-cleanup.js";

const domWindow = new Window({ url: "http://localhost/" });
installDomTestCleanup(domWindow);
const VIEWPORT_HEIGHT = 1_200;
const ROW_HEIGHT = 72;
Object.defineProperty(domWindow.Element.prototype, "getBoundingClientRect", {
  configurable: true,
  value() {
    return {
      x: 0, y: 0, top: 0, left: 0,
      right: 800, bottom: ROW_HEIGHT, width: 800, height: ROW_HEIGHT,
      toJSON: () => ({}),
    };
  },
});
for (const [name, value] of [["clientHeight", VIEWPORT_HEIGHT], ["offsetHeight", ROW_HEIGHT]] as const) {
  Object.defineProperty(domWindow.HTMLElement.prototype, name, { configurable: true, get: () => value });
}
for (const [name, value] of Object.entries({
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  localStorage: domWindow.localStorage,
  Element: domWindow.Element,
  HTMLElement: domWindow.HTMLElement,
  HTMLButtonElement: domWindow.HTMLButtonElement,
  HTMLTextAreaElement: domWindow.HTMLTextAreaElement,
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
  os: "linux",
  version: "1",
  status: "online",
  agents: [{
    id: "codex",
    name: "Codex",
    command: "codex",
    args: [],
    env: {},
    driver: "codex-app-server",
    available: true,
  }],
  workspaces: [],
  connectedAt: 1,
  lastSeen: 1,
  protocolVersion: 99,
} as RunnerView;

function session(id: string): SessionView {
  return {
    id,
    runnerId: runner.runnerId,
    workspaceId: null,
    workspaceName: null,
    projectId: null,
    agentId: "codex",
    agentName: "Codex",
    title: "Durable Dismissal Fixture",
    status: "idle",
    column: "review",
    runId: null,
    useWorktree: false,
    worktreePath: null,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    lastEventAt: null,
    messageCount: 0,
    eventEpoch: 0,
    preview: null,
    pendingApproval: null,
    driver: "codex-app-server",
    model: null,
    effort: null,
    permissionMode: null,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    adopted: false,
  };
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

function EventSeeder({ sessionId, payloads }: { sessionId: string; payloads: SessionEvent["payload"][] }) {
  const ready = useStoreSelector((state) => state.sessions.has(sessionId));
  const { dispatch } = useStoreActions();
  React.useEffect(() => {
    if (!ready) return;
    payloads.forEach((payload, index) => {
      dispatch({
        type: "msg",
        msg: {
          type: "session_event",
          event: { id: index + 1, sessionId, seq: index + 1, ts: index + 1, payload },
        },
      });
    });
  }, [dispatch, payloads, ready, sessionId]);
  return null;
}

/** Every resolution the composer row can reach, so a test can prove which one a click took. */
interface ResolutionLog {
  resolvePendingPrompt: Array<{ sessionId: string; commandId: string; action: string }>;
  cancelQueuedPrompt: Array<{ sessionId: string; promptId: string }>;
  fork: Array<{ sessionId: string; turn: number }>;
  navigate: string[];
}

interface Fixture {
  container: HTMLDivElement;
  root: Root;
  sessionId: string;
  calls: ResolutionLog;
  pushSession: (patch: Partial<SessionView>) => Promise<void>;
}

let fixtureSequence = 0;

async function mountFixture(options: {
  sessionPatch?: Partial<SessionView>;
  eventPayloads?: SessionEvent["payload"][];
  /** Leaves every prompt resolution in flight, so busy state stays observable. */
  holdResolutions?: boolean;
  /** Renders the preview surface, which reports its fork availability through this callback. */
  onPreviewForkReady?: React.ComponentProps<typeof SessionDetail>["onPreviewForkReady"];
  /** Answers a conversation fork; by default it lands as a new session. */
  fork?: (sessionId: string, turn: number) => Promise<SessionView>;
} = {}): Promise<Fixture> {
  fixtureSequence += 1;
  const currentSession = session(`durable-dismissal-${fixtureSequence}`);
  if (options.sessionPatch) Object.assign(currentSession, options.sessionPatch);
  const calls: ResolutionLog = { resolvePendingPrompt: [], cancelQueuedPrompt: [], fork: [], navigate: [] };
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: `durable-dismissal-${fixtureSequence}`,
    runtimeKey: `durable-dismissal-${fixtureSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: currentSession.id }),
    push(view) {
      if (view.name === "session") calls.navigate.push(view.id);
    },
    listen: () => () => {},
  };
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
    fork: async (sessionId: string, turn: number) => {
      calls.fork.push({ sessionId, turn });
      return options.fork ? options.fork(sessionId, turn) : { ...currentSession, id: `${sessionId}-fork` };
    },
    resolvePendingPrompt: async (sessionId: string, commandId: string, action: string) => {
      calls.resolvePendingPrompt.push({ sessionId, commandId, action });
      if (options.holdResolutions) await new Promise(() => {});
      return {};
    },
    cancelQueuedPrompt: async (sessionId: string, promptId: string) => {
      calls.cancelQueuedPrompt.push({ sessionId, promptId });
      return {};
    },
  } as unknown as ApiClient;
  const rightPanel = {
    open: false,
    mode: "launcher" as const,
    width: 360,
    dragging: false,
    subagentTarget: null,
    toggle() {}, openMode() {}, show() {}, setMode() {}, setWidth() {},
    setDragging() {}, close() {}, selectSubagent() {}, showSubagent() {},
    consumeSubagentFocusRequest() {},
  };
  const container = domWindow.document.createElement("div") as unknown as HTMLDivElement;
  domWindow.document.body.append(container as never);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <ApiProvider client={client}>
        <StoreProvider connection={connection} navigation={navigation}>
          <FeedbackProvider>
            {options.eventPayloads && (
              <EventSeeder sessionId={currentSession.id} payloads={options.eventPayloads} />
            )}
            <SessionDetail
              sessionId={currentSession.id}
              rightPanel={rightPanel}
              onOpenTerminal={() => {}}
              composerFocusIntent="message"
              composerDraftLoader={async () => null}
              {...(options.onPreviewForkReady
                ? { mode: "preview" as const, onPreviewForkReady: options.onPreviewForkReady }
                : {})}
            />
          </FeedbackProvider>
        </StoreProvider>
      </ApiProvider>,
    );
  });
  await act(async () => {
    socket.push({
      type: "snapshot",
      capabilities: {
        sessionSubscriptions: false,
        boundedDelivery: false,
        paginatedSessionHistory: false,
        projects: true,
      },
      runners: [runner],
      boxes: [],
      projects: [],
      sessions: [currentSession],
      runs: [],
      pods: [],
    });
  });
  return {
    container,
    root,
    sessionId: currentSession.id,
    calls,
    pushSession: async (patch) => {
      Object.assign(currentSession, patch);
      await act(async () => { socket.push({ type: "session_upsert", session: { ...currentSession } }); });
    },
  };
}

async function unmountFixture(fixture: Fixture) {
  await act(async () => fixture.root.unmount());
  fixture.container.remove();
}

function button(fixture: Fixture, label: string): HTMLButtonElement | null {
  return fixture.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

const COMMAND_ID = "prompt-terminal-durable";
const TEXT = "message the composer would otherwise keep forever";

/** The control-plane queue projection for an undismissed terminal durable delivery. */
function terminalQueueEntry(state: "failed" | "uncertain"): SessionView["queued"] {
  return [{
    id: COMMAND_ID,
    text: TEXT,
    steerable: false,
    steerDisabledReason: "Durable delivery did not complete.",
    durableDeliveryState: state,
    durableDeliveryError: "provider canceled",
  }];
}

/** The matching durable receipt. `userEventSeq` is what suppresses the transcript recovery card. */
function terminalPendingPrompt(
  state: "failed" | "uncertain",
  userEventSeq: number | undefined,
): SessionView["pendingPrompts"] {
  return [{
    commandId: COMMAND_ID,
    text: TEXT,
    state,
    revision: 4,
    attemptCount: 4,
    error: "provider canceled",
    errorCode: "COMMAND_CANCELLED",
    ...(userEventSeq === undefined ? {} : { userEventSeq }),
    createdAt: 1,
    updatedAt: 2,
    canDismiss: true,
  }];
}

for (const { state, label } of [
  { state: "failed" as const, label: "Dismiss Failed Message" },
  { state: "uncertain" as const, label: "Dismiss Uncertain Message" },
]) {
  test(`a durable entry that ended ${state} with its recovery card suppressed still offers an enabled Dismiss`, async () => {
    const fixture = await mountFixture({
      sessionPatch: {
        queued: terminalQueueEntry(state),
        // A recorded transcript event filters this receipt out of PendingPromptBubbles, which is
        // where Dismiss used to live. The composer row is then the only surface left.
        pendingPrompts: terminalPendingPrompt(state, 1),
      },
      eventPayloads: [{ kind: "user_message", text: TEXT, images: [] }],
    });
    try {
      assertNoDomNode(
        fixture.container.querySelector(`[data-testid="pending-prompt-${COMMAND_ID}"]`),
        "the transcript recovery card is suppressed once the command has a transcript event",
      );
      const row = fixture.container.querySelector(`[data-testid="queued-prompt-${COMMAND_ID}"]`);
      assert.ok(row, "the terminal delivery entry is still visible above the composer");

      const dismiss = button(fixture, label);
      assert.ok(dismiss, "the visible terminal entry carries its own Dismiss action");
      assert.equal(dismiss.disabled, false);
      assert.equal(dismiss.textContent, "Dismiss");

      // A disabled cancellation control must never stand in as the only removal action, and the
      // two accessible names stay distinct so a terminal entry is never mistaken for a live one.
      assertNoDomNode(button(fixture, "Queued Message Cancellation Unavailable"));
      assertNoDomNode(button(fixture, "Cancel Queued Message"));

      await act(async () => fireDomEvent.click(dismiss));
      assert.deepEqual(fixture.calls.resolvePendingPrompt, [
        { sessionId: fixture.sessionId, commandId: COMMAND_ID, action: "dismiss" },
      ]);
      assert.deepEqual(fixture.calls.cancelQueuedPrompt, [],
        "dismissal never cancels, resends, reorders, or restarts provider work");
    } finally {
      await unmountFixture(fixture);
    }
  });

  test(`a durable entry that ended ${state} and kept its recovery card also offers Dismiss on the composer row`, async () => {
    const fixture = await mountFixture({
      sessionPatch: {
        queued: terminalQueueEntry(state),
        pendingPrompts: terminalPendingPrompt(state, undefined),
      },
      // Unrelated history, so the transcript body is loaded exactly as in the suppressed case. The
      // only difference from that test is the absent userEventSeq, which is what keeps the card.
      eventPayloads: [{ kind: "user_message", text: "an earlier message", images: [] }],
    });
    try {
      assert.ok(
        fixture.container.querySelector(`[data-testid="pending-prompt-${COMMAND_ID}"]`),
        "without a transcript event the recovery card is still rendered",
      );
      const dismiss = button(fixture, label);
      assert.ok(dismiss, "the composer row's Dismiss does not depend on the recovery card being hidden");
      assert.equal(dismiss.disabled, false);

      await act(async () => fireDomEvent.click(dismiss));
      assert.deepEqual(fixture.calls.resolvePendingPrompt, [
        { sessionId: fixture.sessionId, commandId: COMMAND_ID, action: "dismiss" },
      ]);
    } finally {
      await unmountFixture(fixture);
    }
  });
}

test("dismissing a terminal delivery entry removes only the receipt and survives session updates", async () => {
  const fixture = await mountFixture({
    sessionPatch: {
      queued: terminalQueueEntry("failed"),
      pendingPrompts: terminalPendingPrompt("failed", 1),
      messageCount: 1,
    },
    eventPayloads: [{ kind: "user_message", text: TEXT, images: [] }],
  });
  try {
    const transcript = [...fixture.container.querySelectorAll(".bubble-text")]
      .filter((node) => node.textContent === TEXT);
    assert.equal(transcript.length, 1, "the canonical transcript message is rendered before dismissal");

    const dismiss = button(fixture, "Dismiss Failed Message");
    assert.ok(dismiss);
    await act(async () => fireDomEvent.click(dismiss));

    // The control plane clears the receipt from both projections; the transcript event is untouched.
    await fixture.pushSession({ queued: undefined, pendingPrompts: undefined });
    assertNoDomNode(fixture.container.querySelector(`[data-testid="queued-prompt-${COMMAND_ID}"]`));
    assertNoDomNode(button(fixture, "Dismiss Failed Message"));
    assert.equal(
      [...fixture.container.querySelectorAll(".bubble-text")].filter((n) => n.textContent === TEXT).length,
      1,
      "dismissal removes the delivery receipt without touching the canonical transcript message",
    );

    // A later session update — a reconnect snapshot, a status change — cannot resurrect the row.
    await fixture.pushSession({ status: "running" });
    assertNoDomNode(fixture.container.querySelector(`[data-testid="queued-prompt-${COMMAND_ID}"]`));
    assert.deepEqual(fixture.calls.cancelQueuedPrompt, []);
  } finally {
    await unmountFixture(fixture);
  }
});

test("an in-flight Retry does not make the composer row's Dismiss claim to be dismissing", async () => {
  const fixture = await mountFixture({
    sessionPatch: {
      queued: terminalQueueEntry("failed"),
      // Retryable non-delivery: the recovery card keeps both Retry and Dismiss, and the composer
      // row carries its own Dismiss for the same commandId. They share `pendingPromptAction`.
      pendingPrompts: [{
        ...terminalPendingPrompt("failed", undefined)![0]!,
        errorCode: "PROVIDER_AUTHENTICATION_REQUIRED",
        error: "Provider authentication is required; this message was not sent.",
        canRetry: true,
      }],
    },
    eventPayloads: [{ kind: "user_message", text: "an earlier message", images: [] }],
    holdResolutions: true,
  });
  try {
    const retry = button(fixture, "Retry Message");
    assert.ok(retry, "the recovery card offers Retry for a known-undelivered failure");
    await act(async () => fireDomEvent.click(retry));
    assert.deepEqual(fixture.calls.resolvePendingPrompt, [
      { sessionId: fixture.sessionId, commandId: COMMAND_ID, action: "retry" },
    ]);

    const dismiss = fixture.container.querySelector<HTMLButtonElement>(".queued-dismiss");
    assert.ok(dismiss, "the composer row's Dismiss is still rendered while the retry is in flight");
    assert.equal(dismiss.textContent, "Dismiss",
      "a retry must not label an unrelated dismissal control as dismissing");
    assert.equal(dismiss.hasAttribute("aria-busy"), false,
      "busy state belongs to the control whose action is actually running");
    assert.equal(dismiss.disabled, true, "but it stays disabled while another action is in flight");
  } finally {
    await unmountFixture(fixture);
  }
});

test("a terminal receipt listed beside a held live queue stays dismissible and is not marked held", async () => {
  const HELD_TITLE = "Waiting for the active turn or control-plane decision to settle; resolve any visible prompt to continue";
  const fixture = await mountFixture({
    sessionPatch: {
      status: "running",
      queueHeld: true,
      activeTurnId: "turn-a",
      // The shape the control plane now broadcasts while the runner holds prompts: the undismissed
      // terminal receipt kept ahead of the live FIFO instead of being replaced by it.
      queued: [
        ...terminalQueueEntry("failed")!,
        { id: "queue-live", text: "still waiting behind the turn", steerable: true, liveQueueObserved: true },
      ],
      pendingPrompts: terminalPendingPrompt("failed", 1),
    },
    eventPayloads: [{ kind: "user_message", text: TEXT, images: [] }],
  });
  try {
    assertNoDomNode(
      fixture.container.querySelector(`[data-testid="pending-prompt-${COMMAND_ID}"]`),
      "the recovery card is suppressed, so the composer row is the receipt's only dismissal surface",
    );

    const receiptRow = fixture.container.querySelector<HTMLElement>(`[data-testid="queued-prompt-${COMMAND_ID}"]`);
    assert.ok(receiptRow, "the terminal receipt is listed while the live queue is shown");
    const receiptBadge = receiptRow.querySelector<HTMLElement>(".status");
    assert.equal(receiptBadge?.textContent, "Delivery Failed");
    assert.equal(receiptBadge?.classList.contains("t-danger"), true, "a settled receipt is not paused by the held FIFO");
    // Session-wide gates run before per-row state, so every surface that explains the row — badge,
    // Steer, its info popover, and Edit — must carry the receipt's own reason, never a wait.
    const RECEIPT_REASON = "Delivery attempts for this message have ended, so it cannot be steered or edited.";
    const receiptExplanations = {
      badge: receiptBadge?.getAttribute("title"),
      steer: receiptRow.querySelector('button[aria-label="Steer Queued Message"]')?.getAttribute("title"),
      steerInfo: receiptRow.querySelector('.queued-steer-info [role="status"]')?.textContent,
      edit: receiptRow.querySelector('button[aria-label="Edit Queued Message"]')?.getAttribute("title"),
    };
    assert.deepEqual(receiptExplanations, {
      badge: RECEIPT_REASON,
      steer: RECEIPT_REASON,
      steerInfo: RECEIPT_REASON,
      edit: RECEIPT_REASON,
    });
    for (const [surface, text] of Object.entries(receiptExplanations)) {
      assert.doesNotMatch(text ?? "", /active turn|settle|admission|wait/i,
        `the receipt's ${surface} explanation must not present it as waiting on the queue`);
    }
    const dismiss = receiptRow.querySelector<HTMLButtonElement>('button[aria-label="Dismiss Failed Message"]');
    assert.ok(dismiss);
    assert.equal(dismiss.disabled, false);
    assertNoDomNode(receiptRow.querySelector('button[aria-label="Cancel Queued Message"]'));

    const liveRow = fixture.container.querySelector<HTMLElement>('[data-testid="queued-prompt-queue-live"]');
    assert.ok(liveRow);
    const liveBadge = liveRow.querySelector<HTMLElement>(".status");
    assert.equal(liveBadge?.textContent, "Held", "the live entry keeps its held presentation");
    assert.equal(liveBadge?.classList.contains("t-warning"), true);
    assert.equal(liveBadge?.getAttribute("title"), HELD_TITLE);
    assert.notEqual(
      liveRow.querySelector('button[aria-label="Steer Queued Message"]')?.getAttribute("title"),
      RECEIPT_REASON,
      "live entries keep the session-wide steering explanation",
    );
    const cancel = liveRow.querySelector<HTMLButtonElement>('button[aria-label="Cancel Queued Message"]');
    assert.ok(cancel, "the live entry keeps its cancellation control");
    assert.equal(cancel.disabled, false);
    assertNoDomNode(liveRow.querySelector(".queued-dismiss"));

    await act(async () => fireDomEvent.click(dismiss));
    assert.deepEqual(fixture.calls.resolvePendingPrompt, [
      { sessionId: fixture.sessionId, commandId: COMMAND_ID, action: "dismiss" },
    ], "dismissal targets the durable command identity");
    assert.deepEqual(fixture.calls.cancelQueuedPrompt, [], "dismissing the receipt never touches the live queue");
  } finally {
    await unmountFixture(fixture);
  }
});

for (const { name, queued, available } of [
  { name: "only settled receipts", queued: [...terminalQueueEntry("failed")!], available: true },
  {
    name: "a receipt beside a live entry",
    queued: [
      ...terminalQueueEntry("failed")!,
      { id: "queue-live", text: "still waiting", steerable: true, liveQueueObserved: true },
    ],
    available: false,
  },
]) {
  test(`an idle forkable Session listing ${name} reports fork ${available ? "available" : "blocked"}`, async () => {
    const reported: Array<{ available: boolean; reason?: string }> = [];
    const fixture = await mountFixture({
      sessionPatch: {
        status: "idle",
        useWorktree: true,
        worktreePath: "/tmp/durable-dismissal-worktree",
        queued,
        pendingPrompts: terminalPendingPrompt("failed", 1),
      },
      // A completed provider checkpoint makes turn 1 forkable, so the queued-work gate is the only
      // one left to decide — without it an earlier gate would refuse and the test would prove nothing.
      eventPayloads: [
        { kind: "user_message", text: TEXT, images: [] },
        { kind: "agent_message", text: "done", final: true },
        { kind: "conversation_checkpoint", turn: 1 },
      ],
      onPreviewForkReady: (controls) => {
        if (controls) reported.push(controls.availability as { available: boolean; reason?: string });
      },
    });
    try {
      const latest = reported.at(-1);
      assert.ok(latest, "the preview surface reported its fork availability");
      if (available) {
        assert.deepEqual(latest, { available: true, forkTurn: 1 },
          "a settled receipt is not pending work, so it must not block the fork");
      } else {
        assert.equal(latest.available, false, "genuinely queued work still blocks the fork");
        assert.match(latest.reason ?? "", /queued messages/);
      }
    } finally {
      await unmountFixture(fixture);
    }
  });
}

test("a nonterminal durable entry keeps the existing pre-admission cancellation semantics", async () => {
  const fixture = await mountFixture({
    sessionPatch: {
      queued: [{
        id: COMMAND_ID,
        text: TEXT,
        steerable: false,
        steerDisabledReason: "Waiting for durable runner admission.",
        durableDeliveryState: "pending",
      }],
    },
  });
  try {
    assertNoDomNode(button(fixture, "Dismiss Failed Message"));
    assertNoDomNode(button(fixture, "Dismiss Uncertain Message"));
    const cancel = button(fixture, "Queued Message Cancellation Unavailable");
    assert.ok(cancel, "delivery that may still run keeps its disabled cancellation control");
    assert.equal(cancel.disabled, true);
    assert.equal(
      cancel.getAttribute("title"),
      "Durable delivery entries cannot be canceled before runner admission.",
    );
  } finally {
    await unmountFixture(fixture);
  }
});

test("a live runner queue entry keeps its enabled Cancel Queued Message control", async () => {
  const fixture = await mountFixture({
    sessionPatch: {
      queued: [{ id: "queue-live", text: "still waiting behind the turn", steerable: true, liveQueueObserved: true }],
    },
  });
  try {
    assertNoDomNode(button(fixture, "Dismiss Failed Message"));
    const cancel = button(fixture, "Cancel Queued Message");
    assert.ok(cancel);
    assert.equal(cancel.disabled, false);
    await act(async () => fireDomEvent.click(cancel));
    assert.deepEqual(fixture.calls.cancelQueuedPrompt, [
      { sessionId: fixture.sessionId, promptId: "queue-live" },
    ]);
    assert.deepEqual(fixture.calls.resolvePendingPrompt, []);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a person refused Fork gets that reason from the preview surface that drives the Inbox Fork and F key (#1864)", async () => {
  const reason = "Your Viewer role is read-only.";
  for (const [fork, expected] of [
    [{ allowed: false, reason }, { available: false, offered: true, reason }],
    [{ allowed: true }, { available: true, forkTurn: 1 }],
    [undefined, { available: true, forkTurn: 1 }],
  ] as const) {
    const reported: unknown[] = [];
    const fixture = await mountFixture({
      sessionPatch: {
        status: "idle",
        useWorktree: true,
        worktreePath: "/tmp/durable-dismissal-worktree",
        ...(fork ? { commandPermissions: {
          stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: true }, fork,
        } } : {}),
      },
      // A completed checkpoint makes turn 1 forkable, so only the verdict can refuse it.
      eventPayloads: [
        { kind: "user_message", text: TEXT, images: [] },
        { kind: "agent_message", text: "done", final: true },
        { kind: "conversation_checkpoint", turn: 1 },
      ],
      onPreviewForkReady: (controls) => { if (controls) reported.push(controls.availability); },
    });
    try {
      assert.deepEqual(reported.at(-1), expected, `fork verdict ${JSON.stringify(fork)}`);
    } finally {
      await unmountFixture(fixture);
    }
  }
});

test("a Viewer's per-turn Rewind, Fork and Hand Off are unavailable and say why (#1864)", async () => {
  const reason = "Your Viewer role is read-only.";
  const fixture = await mountFixture({
    sessionPatch: {
      status: "idle",
      useWorktree: true,
      worktreePath: "/tmp/durable-dismissal-worktree",
      commandPermissions: {
        stop: { allowed: false, reason }, restart: { allowed: false, reason }, stopBackgroundJob: { allowed: false, reason },
        fork: { allowed: false, reason }, rewind: { allowed: false, reason },
      },
    },
    eventPayloads: [
      { kind: "user_message", text: TEXT, images: [] },
      { kind: "checkpoint", turn: 1, tree: "a".repeat(40) },
      { kind: "agent_message", text: "done", final: true },
      { kind: "conversation_checkpoint", turn: 1 },
    ],
  });
  try {
    assertNoDomNode(button(fixture, "Fork After This Turn"), "no hover Fork for an action that cannot be used");
    for (const label of ["Rewind Files to Before This Turn…", "Fork After This Turn…", "Hand Off After This Turn…"]) {
      const action = await readTranscriptAction(fixture.container, "More Turn Actions", label);
      assert.ok(action, `${label} is listed`);
      assert.equal(action.disabled, true, `${label} is unavailable`);
      assert.match(action.reason ?? "", /Your Viewer role is read-only\./u, `${label} says why`);
    }
  } finally {
    await unmountFixture(fixture);
  }
});

const FORKABLE_TURNS: SessionEvent["payload"][] = [
  { kind: "user_message", text: "first", images: [] },
  { kind: "agent_message", text: "one", final: true },
  { kind: "conversation_checkpoint", turn: 1 },
  { kind: "user_message", text: "second", images: [] },
  { kind: "agent_message", text: "two", final: true },
  { kind: "conversation_checkpoint", turn: 2 },
];
const FORKABLE_SESSION: Partial<SessionView> = {
  status: "idle", useWorktree: true, worktreePath: "/tmp/durable-dismissal-worktree",
};

function openDialog(name: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((dialog) => dialog.querySelector(".modal-title, h2")?.textContent === name) ?? null;
}

function dialogButton(dialog: HTMLElement | null, label: string): HTMLButtonElement | undefined {
  return [...dialog?.querySelectorAll<HTMLButtonElement>(".modal-foot button") ?? []]
    .find((candidate) => candidate.textContent === label);
}

async function settleDialog() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test("Edit in a Fork confirms with the turn it continues from, then opens the fork with the message in its composer (#2185)", async () => {
  const fixture = await mountFixture({ sessionPatch: FORKABLE_SESSION, eventPayloads: FORKABLE_TURNS });
  try {
    await chooseTranscriptAction(fixture.container, "More Message Actions", "Edit in a Fork…", 1);
    await settleDialog();
    const dialog = openDialog("Edit in a Fork");
    assert.ok(dialog, "the action asks first, in a confirmation rather than an edit form");
    assert.equal(dialog.querySelector(".confirmation-message")?.textContent,
      "A new session continues from before Turn 2 in its own worktree, and this message opens in its composer for you to edit. This session stays as it is.");
    assertNoDomNode(dialog.querySelector("textarea"), "the message is edited in the fork's composer, not here");
    const confirm = dialogButton(dialog, "Edit in a Fork");
    assert.ok(confirm, "the confirm button repeats the title's verb");
    await act(async () => { confirm.click(); });
    await settleDialog();
    assert.deepEqual(fixture.calls.fork, [{ sessionId: fixture.sessionId, turn: 1 }], "the fork continues from before the message's turn");
    assert.deepEqual(fixture.calls.navigate, [`${fixture.sessionId}-fork`], "the new session opens");
    assertNoDomNode(openDialog("Edit in a Fork"), "the confirmation closes once the fork exists");
  } finally {
    await unmountFixture(fixture);
  }
});

test("an ambiguous Edit in a Fork failure stays in the confirmation as a danger notice (#2185)", async () => {
  const fixture = await mountFixture({
    sessionPatch: FORKABLE_SESSION,
    eventPayloads: FORKABLE_TURNS,
    fork: async () => { throw new ApiError("The control plane timed out.", 504); },
  });
  try {
    await chooseTranscriptAction(fixture.container, "More Message Actions", "Edit in a Fork…", 1);
    await settleDialog();
    await act(async () => { dialogButton(openDialog("Edit in a Fork"), "Edit in a Fork")?.click(); });
    await settleDialog();
    const dialog = openDialog("Edit in a Fork");
    assert.ok(dialog, "the confirmation stays open");
    assert.match(dialog.querySelector(".notice.t-danger")?.textContent ?? "", /The fork outcome is uncertain\. Do not retry\./u);
    assert.deepEqual(fixture.calls.navigate, [], "nothing opens");

    // Trying again does not create a second fork while the first one's outcome is unknown.
    await act(async () => { dialogButton(dialog, "Edit in a Fork")?.click(); });
    await settleDialog();
    assert.equal(fixture.calls.fork.length, 1);
    assert.match(openDialog("Edit in a Fork")?.querySelector(".notice.t-danger")?.textContent ?? "",
      /A conversation fork is already in progress for this session\./u);
  } finally {
    await unmountFixture(fixture);
  }
});

test("a refusal that arrives while Edit in a Fork is confirming stops it there and says why (#1864)", async () => {
  const reason = "Your Viewer role is read-only.";
  const fixture = await mountFixture({ sessionPatch: FORKABLE_SESSION, eventPayloads: FORKABLE_TURNS });
  try {
    const edit = await readTranscriptAction(fixture.container, "More Message Actions", "Edit in a Fork…", 1);
    assert.equal(edit?.disabled, false, "Edit in a Fork is offered while forking is allowed");
    await chooseTranscriptAction(fixture.container, "More Message Actions", "Edit in a Fork…", 1);
    await settleDialog();
    assert.ok(openDialog("Edit in a Fork"));
    await fixture.pushSession({ commandPermissions: {
      stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: true },
      fork: { allowed: false, reason },
    } });
    await act(async () => { dialogButton(openDialog("Edit in a Fork"), "Edit in a Fork")?.click(); });
    await settleDialog();
    const dialog = openDialog("Edit in a Fork");
    assert.ok(dialog, "the open confirmation stays open");
    assert.equal(dialog.querySelector(".notice.t-danger")?.textContent, reason);
    assert.deepEqual(fixture.calls.fork, [], "no fork is requested");
  } finally {
    await unmountFixture(fixture);
  }
});

test("an Edit in Fork that applies but is blocked stays listed and says why, and never applies elsewhere (#1869)", async () => {
  const reason = "Your Viewer role is read-only.";
  const edit = "Edit in a Fork…";
  const fixture = await mountFixture({
    sessionPatch: {
      status: "idle",
      useWorktree: true,
      worktreePath: "/tmp/durable-dismissal-worktree",
      commandPermissions: {
        stop: { allowed: false, reason }, restart: { allowed: false, reason }, stopBackgroundJob: { allowed: false, reason },
        fork: { allowed: false, reason },
      },
    },
    eventPayloads: [
      { kind: "user_message", text: "first", images: [] },
      { kind: "agent_message", text: "one", final: true },
      { kind: "conversation_checkpoint", turn: 1 },
      { kind: "user_message", text: "second", images: [] },
      { kind: "agent_message", text: "two", final: true },
      { kind: "conversation_checkpoint", turn: 2 },
    ],
  });
  // Each user message's own menu: the first has no earlier checkpoint to fork from.
  const read = (index: number) => readTranscriptAction(fixture.container, "More Message Actions", edit, index);
  try {
    assert.equal(await read(0), null, "the message with no earlier checkpoint does not list it");
    const blocked = await read(1);
    assert.equal(blocked?.disabled, true, "a Viewer gets no usable Edit in a Fork");
    assert.match(blocked?.reason ?? "", /Your Viewer role is read-only\./u);
    // The second turn's menu lists the same action for its own prompt, with the same reason.
    const fromTurn = await readTranscriptAction(fixture.container, "More Turn Actions", edit, 1);
    assert.equal(fromTurn?.disabled, true);
    assert.match(fromTurn?.reason ?? "", /Your Viewer role is read-only\./u);

    await fixture.pushSession({ commandPermissions: {
      stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: true }, fork: { allowed: true },
    } });
    assert.equal((await read(1))?.disabled, false, "an allowed person gets the working action back");

    await fixture.pushSession({ status: "running" });
    const running = await read(1);
    assert.equal(running?.disabled, true);
    assert.match(running?.reason ?? "", /Wait for the current turn or approval before creating a fork\./u);

    await fixture.pushSession({ status: "idle", driver: "claude-code", commandPermissions: {
      stop: { allowed: false, reason }, restart: { allowed: false, reason }, stopBackgroundJob: { allowed: false, reason },
      fork: { allowed: false, reason },
    } });
    assert.equal(await read(1), null, "a provider that cannot edit history never lists it, even to a Viewer");
  } finally {
    await unmountFixture(fixture);
  }
});

test("Edit as a New Turn stays listed and says why while the composer cannot send, and loads the composer without a dialog when it can (#1876, #2185)", async () => {
  const reason = "Your Viewer role is read-only.";
  const edit = "Edit as a New Turn";
  const fixture = await mountFixture({
    sessionPatch: {
      status: "idle",
      commandPermissions: {
        stop: { allowed: false, reason }, restart: { allowed: false, reason }, stopBackgroundJob: { allowed: false, reason },
        prompt: { allowed: false, reason },
      },
    },
    eventPayloads: [
      { kind: "user_message", text: "first", images: [] },
      { kind: "agent_message", text: "one", final: true },
      { kind: "user_message", text: "second", images: [] },
      { kind: "agent_message", text: "two", final: true },
    ],
  });
  const read = (index: number) => readTranscriptAction(fixture.container, "More Message Actions", edit, index);
  const dialog = () => document.querySelector('[role="dialog"]');
  const composer = () => fixture.container.querySelector<HTMLTextAreaElement>(".composer-input");
  try {
    assertNoDomNode(button(fixture, edit), "a Viewer gets no hover Edit as a New Turn");
    for (const index of [0, 1]) {
      const blocked = await read(index);
      assert.equal(blocked?.disabled, true, "every user message keeps the action, unavailable");
      assert.match(blocked?.reason ?? "", /Your Viewer role is read-only\./u);
    }
    assertNoDomNode(dialog(), "an unavailable action opens no dialog");

    await fixture.pushSession({ commandPermissions: {
      stop: { allowed: true }, restart: { allowed: true }, stopBackgroundJob: { allowed: true }, prompt: { allowed: true },
    } });
    assert.equal((await read(0))?.disabled, false);
    const working = button(fixture, edit);
    assert.ok(working, "an allowed person gets the hover button back");
    await act(async () => { working.click(); });
    await settleDialog();
    assertNoDomNode(dialog(), "an empty composer takes the copy without a dialog");
    assert.equal(composer()?.value, "first");

    await fixture.pushSession({ status: "stopped" });
    const stopped = await read(0);
    assert.equal(stopped?.disabled, true, "a stopped session keeps the action, unavailable");
    assert.match(stopped?.reason ?? "", /This session is stopped\. Restart it to send a message\./u, "it names the specific reason");
    assertNoDomNode(button(fixture, edit));
  } finally {
    await unmountFixture(fixture);
  }
});
