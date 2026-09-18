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
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import type { ViewNavigation } from "../navigation.js";
import { StoreProvider, useStoreActions, useStoreSelector } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import { SessionDetail } from "./SessionDetail.js";
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
} = {}): Promise<Fixture> {
  fixtureSequence += 1;
  const currentSession = session(`durable-dismissal-${fixtureSequence}`);
  if (options.sessionPatch) Object.assign(currentSession, options.sessionPatch);
  const calls: ResolutionLog = { resolvePendingPrompt: [], cancelQueuedPrompt: [] };
  const socket = new FakeSocket();
  const connection: UiConnectionRuntime = {
    instanceId: `durable-dismissal-${fixtureSequence}`,
    runtimeKey: `durable-dismissal-${fixtureSequence}:1`,
    createSocket: () => socket,
    close() {},
  };
  const navigation: ViewNavigation = {
    current: () => ({ name: "session", id: currentSession.id }),
    push() {},
    listen: () => () => {},
  };
  const client = {
    ...api,
    session: () => new Promise<never>(() => {}),
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
          {options.eventPayloads && (
            <EventSeeder sessionId={currentSession.id} payloads={options.eventPayloads} />
          )}
          <SessionDetail
            sessionId={currentSession.id}
            rightPanel={rightPanel}
            onOpenTerminal={() => {}}
            pinnedOpen={false}
            composerFocusIntent="message"
            composerDraftLoader={async () => null}
          />
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
    durableDeliveryError: "provider cancelled",
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
    error: "provider cancelled",
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
      assert.equal(
        fixture.container.querySelector(`[data-testid="pending-prompt-${COMMAND_ID}"]`),
        null,
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
      assert.equal(button(fixture, "Queued Message Cancellation Unavailable"), null);
      assert.equal(button(fixture, "Cancel Queued Message"), null);

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
    assert.equal(fixture.container.querySelector(`[data-testid="queued-prompt-${COMMAND_ID}"]`), null);
    assert.equal(button(fixture, "Dismiss Failed Message"), null);
    assert.equal(
      [...fixture.container.querySelectorAll(".bubble-text")].filter((n) => n.textContent === TEXT).length,
      1,
      "dismissal removes the delivery receipt without touching the canonical transcript message",
    );

    // A later session update — a reconnect snapshot, a status change — cannot resurrect the row.
    await fixture.pushSession({ status: "running" });
    assert.equal(fixture.container.querySelector(`[data-testid="queued-prompt-${COMMAND_ID}"]`), null);
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
    assert.equal(
      fixture.container.querySelector(`[data-testid="pending-prompt-${COMMAND_ID}"]`),
      null,
      "the recovery card is suppressed, so the composer row is the receipt's only dismissal surface",
    );

    const receiptRow = fixture.container.querySelector<HTMLElement>(`[data-testid="queued-prompt-${COMMAND_ID}"]`);
    assert.ok(receiptRow, "the terminal receipt is listed while the live queue is shown");
    const receiptBadge = receiptRow.querySelector<HTMLElement>(".queued-badge");
    assert.equal(receiptBadge?.textContent, "Delivery Failed");
    assert.equal(receiptBadge?.classList.contains("held"), false, "a settled receipt is not paused by the held FIFO");
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
    assert.equal(receiptRow.querySelector('button[aria-label="Cancel Queued Message"]'), null);

    const liveRow = fixture.container.querySelector<HTMLElement>('[data-testid="queued-prompt-queue-live"]');
    assert.ok(liveRow);
    const liveBadge = liveRow.querySelector<HTMLElement>(".queued-badge");
    assert.equal(liveBadge?.textContent, "Held", "the live entry keeps its held presentation");
    assert.equal(liveBadge?.classList.contains("held"), true);
    assert.equal(liveBadge?.getAttribute("title"), HELD_TITLE);
    assert.notEqual(
      liveRow.querySelector('button[aria-label="Steer Queued Message"]')?.getAttribute("title"),
      RECEIPT_REASON,
      "live entries keep the session-wide steering explanation",
    );
    const cancel = liveRow.querySelector<HTMLButtonElement>('button[aria-label="Cancel Queued Message"]');
    assert.ok(cancel, "the live entry keeps its cancellation control");
    assert.equal(cancel.disabled, false);
    assert.equal(liveRow.querySelector(".queued-dismiss"), null);

    await act(async () => fireDomEvent.click(dismiss));
    assert.deepEqual(fixture.calls.resolvePendingPrompt, [
      { sessionId: fixture.sessionId, commandId: COMMAND_ID, action: "dismiss" },
    ], "dismissal targets the durable command identity");
    assert.deepEqual(fixture.calls.cancelQueuedPrompt, [], "dismissing the receipt never touches the live queue");
  } finally {
    await unmountFixture(fixture);
  }
});

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
    assert.equal(button(fixture, "Dismiss Failed Message"), null);
    assert.equal(button(fixture, "Dismiss Uncertain Message"), null);
    const cancel = button(fixture, "Queued Message Cancellation Unavailable");
    assert.ok(cancel, "delivery that may still run keeps its disabled cancellation control");
    assert.equal(cancel.disabled, true);
    assert.equal(
      cancel.getAttribute("title"),
      "Durable delivery entries cannot be cancelled before runner admission.",
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
    assert.equal(button(fixture, "Dismiss Failed Message"), null);
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
