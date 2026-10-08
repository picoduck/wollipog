/**
 * Issue #2762: the session manager coalesces streamed text deltas from every driver. Coalescing
 * may only merge adjacent deltas of one message; pending text must land before any other event,
 * status change, turn settlement, interruption, provider exit, or runner shutdown.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RunnerToControlPlane, SessionEventPayload } from "@wollipog/protocol";
import type { Driver, DriverCallbacks, StopReason } from "./drivers/driver.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { TEXT_DELTA_WINDOW_MS } from "./text-delta-coalescer.js";

const SESSION = "s_coalesce";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500 && !predicate(); attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true, message);
}

/** Launch through the manager's real callback registration with a provider turn held open. */
async function harness() {
  const root = mkdtempSync(join(tmpdir(), "wollipog-text-coalescing-"));
  const sent: RunnerToControlPlane[] = [];
  const store = new SessionStore(root);
  let turn = deferred<StopReason>();
  let callbacks!: DriverCallbacks;
  let promptStarted = false;
  let disposals = 0;
  const driver: Driver = {
    pid: undefined,
    initialize: async () => {},
    newSession: async () => "thread-1",
    agentSessionId: () => "thread-1",
    prompt: async () => { promptStarted = true; return turn.promise; },
    setConfig: () => {},
    cancel: () => { turn.resolve("cancelled"); },
    resolvePermission: () => false,
    dispose: () => { disposals++; turn.resolve("cancelled"); },
  };
  const manager = new SessionManager((message) => sent.push(message), () => {}, store, "runner-1", undefined,
    (_kind, _options, registered) => { callbacks = registered; return driver; });
  const cleanup = () => {
    manager.shutdownAll();
    turn.resolve("cancelled");
    rmSync(root, { recursive: true, force: true });
  };
  try {
    assert.equal(await manager.start({
      sessionId: SESSION, agentId: "acp", workspaceId: "repo", workspacePath: root,
      driver: "acp", command: "agent", args: [], env: {}, context: { kind: "native" },
      useWorktree: false,
    }, "stream something"), true);
    await waitFor(() => promptStarted, "the launch starts a provider turn");
  } catch (error) { cleanup(); throw error; }
  /** Persisted history after the prompt, in sequence order. */
  const history = () => {
    const events = store.readEvents(SESSION).map((event) => event.payload);
    const prompt = events.findIndex((payload) => payload.kind === "user_message");
    return events.slice(prompt + 1);
  };
  /** Live frames after the prompt: session events and status changes, in send order. */
  const frames = () => {
    const result: string[] = [];
    let afterPrompt = false;
    for (const message of sent) {
      if (message.type === "session_event") {
        if (message.payload.kind === "user_message") { afterPrompt = true; continue; }
        if (afterPrompt) result.push(describe(message.payload));
      } else if (message.type === "session_status" && afterPrompt) {
        result.push(`status:${message.status}`);
      }
    }
    return result;
  };
  return {
    manager, store, sent, history, frames, cleanup,
    emit: (payload: SessionEventPayload) => callbacks.onEvent(payload),
    callbacks: () => callbacks,
    disposals: () => disposals,
    settle: (stop: StopReason) => turn.resolve(stop),
    nextTurn: () => { turn = deferred<StopReason>(); },
    /** Private manager seams for lifecycle paths a driver cannot trigger on its own. */
    internals: () => manager as unknown as {
      deleteActiveSession(sessionId: string): boolean;
      emitEvent(sessionId: string, payload: SessionEventPayload): unknown;
      emitStatus(sessionId: string, status: string): void;
      appendAcceptedSteeringEvent(sessionId: string, turnId: string, submissionId: string, text: string, images: unknown[]): boolean;
    },
  };
}

function describe(payload: SessionEventPayload): string {
  if (payload.kind === "agent_message" || payload.kind === "agent_thought") {
    return `${payload.kind}:${payload.messageId ?? ""}:${payload.text}`;
  }
  if (payload.kind === "tool_call") return `tool_call:${payload.toolCallId}`;
  return payload.kind;
}

const delta = (text: string, messageId = "m1"): SessionEventPayload => ({ kind: "agent_message", text, messageId });

/** Every frame before the last text frame, except the launch's own running status, is text. */
function assertTextFirst(frames: string[], lastText: string): void {
  const index = frames.indexOf(lastText);
  assert.ok(index >= 0, `the pending text is sent: ${frames.join(", ")}`);
  assert.ok(frames.slice(0, index).every((frame) => frame === "status:running" || frame.startsWith("agent_message")),
    `nothing recorded later overtakes the text: ${frames.join(", ")}`);
}

function texts(history: SessionEventPayload[]): string {
  return history.map((payload) => payload.kind === "agent_message" ? payload.text : "").join("");
}

test("interleaved tool calls and message boundaries keep their order, and the turn settles after the text", async () => {
  const h = await harness();
  try {
    h.emit(delta("Let "));
    h.emit(delta("me "));
    h.emit(delta("look."));
    h.emit({ kind: "tool_call", toolCallId: "t1", title: "Read", status: "pending" });
    h.emit({ kind: "tool_call_update", toolCallId: "t1", status: "completed" });
    h.emit(delta("Found ", "m2"));
    h.emit(delta("it", "m2"));
    h.emit(delta(".", "m2"));
    h.settle("end_turn");
    await waitFor(() => h.frames().includes("status:idle"), "the turn settles");

    assert.deepEqual(h.history().map(describe).slice(0, 5), [
      "agent_message:m1:Let ",
      "agent_message:m1:me look.",
      "tool_call:t1",
      "tool_call_update",
      // The tool events flushed "me look." moments ago, so the next message waits one window.
      "agent_message:m2:Found it.",
    ]);
    const frames = h.frames();
    assert.ok(frames.indexOf("agent_message:m2:Found it.") < frames.indexOf("status:idle"),
      `pending text lands before the turn settles: ${frames.join(", ")}`);
  } finally { h.cleanup(); }
});

test("pending text lands after one window with nothing else to flush it", async () => {
  const h = await harness();
  try {
    h.emit(delta("a"));
    h.emit(delta("b"));
    h.emit(delta("c"));
    assert.equal(texts(h.history()), "a", "later deltas wait for the window");
    await new Promise<void>((resolve) => setTimeout(resolve, TEXT_DELTA_WINDOW_MS * 3));
    assert.deepEqual(h.history().map(describe), ["agent_message:m1:a", "agent_message:m1:bc"]);
  } finally { h.cleanup(); }
});

test("an interrupt mid-message keeps every streamed delta ahead of the interruption", async () => {
  const h = await harness();
  try {
    h.emit(delta("half "));
    h.emit(delta("a "));
    h.emit(delta("sentence"));
    h.manager.cancel(SESSION);
    await waitFor(() => !h.frames().at(-1)?.startsWith("status:running"), "the interrupt settles");
    assert.equal(texts(h.history()), "half a sentence");
    assertTextFirst(h.frames(), "agent_message:m1:a sentence");
  } finally { h.cleanup(); }
});

test("a stop mid-message keeps every streamed delta ahead of the stop", async () => {
  const h = await harness();
  try {
    h.emit(delta("stopped "));
    h.emit(delta("mid"));
    h.emit(delta("-word"));
    h.manager.stop(SESSION);
    assert.equal(texts(h.history()), "stopped mid-word");
    assertTextFirst(h.frames(), "agent_message:m1:mid-word");
  } finally { h.cleanup(); }
});

test("a provider exit mid-message lands the pending text before the exit is handled", async () => {
  const h = await harness();
  try {
    h.emit(delta("about "));
    h.emit(delta("to "));
    h.emit(delta("crash"));
    h.callbacks().onExit(1);
    assert.equal(texts(h.history()), "about to crash");
    assertTextFirst(h.frames(), "agent_message:m1:to crash");
  } finally { h.cleanup(); }
});

test("runner shutdown mid-message persists every streamed delta", async () => {
  const h = await harness();
  try {
    h.emit(delta("shutting "));
    h.emit(delta("down "));
    h.emit(delta("now"));
    assert.equal(texts(h.history()), "shutting ");
    h.manager.shutdownAll();
    assert.equal(texts(h.history()), "shutting down now");
    assert.deepEqual(h.history().map(describe), ["agent_message:m1:shutting ", "agent_message:m1:down now"]);
  } finally { h.cleanup(); }
});

test("a session-manager event appended mid-message follows the pending text", async () => {
  const h = await harness();
  try {
    h.emit(delta("one "));
    h.emit(delta("two"));
    h.callbacks().onStderr("provider warning");
    assert.deepEqual(h.history().map(describe), ["agent_message:m1:one ", "agent_message:m1:two", "stderr"]);
  } finally { h.cleanup(); }
});

test("a retired provider's late text passes straight through instead of waiting unflushed", async () => {
  const h = await harness();
  try {
    h.emit(delta("a"));
    h.emit(delta("b"));
    h.internals().deleteActiveSession(SESSION);
    assert.deepEqual(h.history().map(describe), ["agent_message:m1:a", "agent_message:m1:b"]);
    h.emit(delta("late "));
    h.emit(delta("words"));
    h.internals().emitEvent(SESSION, { kind: "error", message: "manager event" });
    assert.deepEqual(h.history().map(describe), [
      "agent_message:m1:a",
      "agent_message:m1:b",
      "agent_message:m1:late ",
      "agent_message:m1:words",
      "error",
    ]);
  } finally { h.cleanup(); }
});

/** Make the next history append throw, as a full or failing disk would. */
function failNextAppend(store: SessionStore): void {
  const append = store.appendEvent.bind(store);
  let failed = false;
  store.appendEvent = ((...args: Parameters<SessionStore["appendEvent"]>) => {
    if (!failed) { failed = true; throw new Error("disk full"); }
    return append(...args);
  }) as SessionStore["appendEvent"];
}

test("steering is refused when landing pending text latches a history failure", async () => {
  const h = await harness();
  try {
    h.emit(delta("a"));
    h.emit(delta("pending"));
    failNextAppend(h.store);
    assert.equal(h.internals().appendAcceptedSteeringEvent(SESSION, "turn-1", "submission-1", "steer", []), false);
    assert.equal(h.history().some((payload) => payload.kind === "user_message"), false);
  } finally { h.cleanup(); }
});

test("a status computed before a flush that latches a history failure does not overwrite failed", async () => {
  const h = await harness();
  try {
    h.emit(delta("a"));
    h.emit(delta("pending"));
    failNextAppend(h.store);
    h.internals().emitStatus(SESSION, "idle");
    const statuses = h.sent.flatMap((message) => message.type === "session_status" ? [message.status] : []);
    assert.equal(statuses.at(-1), "failed", `statuses: ${statuses.join(", ")}`);
    assert.equal(h.store.readMeta(SESSION)?.status, "failed");
  } finally { h.cleanup(); }
});

test("shutdown disposes every provider even when landing pending text fails", async () => {
  const h = await harness();
  try {
    h.emit(delta("a"));
    h.emit(delta("pending"));
    const append = h.store.appendEvent;
    const patch = h.store.patchMeta;
    h.store.appendEvent = (() => { throw new Error("disk full"); }) as SessionStore["appendEvent"];
    h.store.patchMeta = (() => { throw new Error("disk full"); }) as SessionStore["patchMeta"];
    try {
      assert.doesNotThrow(() => h.manager.shutdownAll());
    } finally {
      h.store.appendEvent = append;
      h.store.patchMeta = patch;
    }
    assert.equal(h.disposals(), 1);
  } finally { h.cleanup(); }
});
