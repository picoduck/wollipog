import assert from "node:assert/strict";
import { test } from "node:test";
import { flushProjectedOutbox, MAX_OUTBOX, Outbox } from "./outbox.js";

interface TestMessage {
  type: string;
  sessionId?: string;
  tag?: number;
}

test("outbox preserves enqueue order for distinct messages and drains once", () => {
  const outbox = new Outbox<TestMessage>();
  outbox.enqueue({ type: "session_event", sessionId: "a", tag: 1 });
  outbox.enqueue({ type: "session_event", sessionId: "a", tag: 2 });
  outbox.enqueue({ type: "session_status", sessionId: "b", tag: 3 });
  assert.equal(outbox.size, 3);

  assert.deepEqual(outbox.drain(), [
    { type: "session_event", sessionId: "a", tag: 1 },
    { type: "session_event", sessionId: "a", tag: 2 },
    { type: "session_status", sessionId: "b", tag: 3 },
  ]);
  // A drain empties the buffer, so a second drain yields nothing.
  assert.equal(outbox.size, 0);
  assert.deepEqual(outbox.drain(), []);
});

test("outbox coalesces session_status and session_queue by (type, sessionId) keeping the latest", () => {
  const outbox = new Outbox<TestMessage>();
  outbox.enqueue({ type: "session_status", sessionId: "a", tag: 1 });
  outbox.enqueue({ type: "session_queue", sessionId: "a", tag: 2 });
  outbox.enqueue({ type: "session_status", sessionId: "b", tag: 3 });
  // Supersede a's status and queue; b's status is a different key and untouched.
  outbox.enqueue({ type: "session_status", sessionId: "a", tag: 4 });
  outbox.enqueue({ type: "session_queue", sessionId: "a", tag: 5 });

  // Only the latest of each (type, sessionId) survives, re-appended at the tail in supersede order.
  assert.deepEqual(outbox.drain(), [
    { type: "session_status", sessionId: "b", tag: 3 },
    { type: "session_status", sessionId: "a", tag: 4 },
    { type: "session_queue", sessionId: "a", tag: 5 },
  ]);
});

test("outbox coalescing is keyed per session and never collapses across sessions or types", () => {
  const outbox = new Outbox<TestMessage>();
  outbox.enqueue({ type: "session_status", sessionId: "a", tag: 1 });
  outbox.enqueue({ type: "session_status", sessionId: "b", tag: 2 });
  outbox.enqueue({ type: "session_queue", sessionId: "a", tag: 3 });
  assert.equal(outbox.size, 3);
  assert.deepEqual(outbox.drain().map((m) => m.tag), [1, 2, 3]);
});

test("outbox never coalesces non-status/queue messages even for the same session", () => {
  const outbox = new Outbox<TestMessage>();
  outbox.enqueue({ type: "session_event", sessionId: "a", tag: 1 });
  outbox.enqueue({ type: "session_event", sessionId: "a", tag: 2 });
  assert.deepEqual(outbox.drain().map((m) => m.tag), [1, 2]);
});

test("outbox drops the oldest messages once it exceeds the cap", () => {
  const cap = 3;
  const outbox = new Outbox<TestMessage>(cap);
  for (let i = 0; i < 5; i++) outbox.enqueue({ type: "session_event", sessionId: "a", tag: i });
  // Oldest-drop keeps only the last `cap` entries, in order.
  assert.equal(outbox.size, cap);
  assert.deepEqual(outbox.drain().map((m) => m.tag), [2, 3, 4]);
});

test("outbox overflow retains a coalesced entry at its refreshed tail position", () => {
  const cap = 2;
  const outbox = new Outbox<TestMessage>(cap);
  outbox.enqueue({ type: "session_status", sessionId: "a", tag: 1 });
  outbox.enqueue({ type: "session_event", sessionId: "a", tag: 2 });
  // Coalescing a's status moves it to the tail (now [event#2, status#3]); still within the cap.
  outbox.enqueue({ type: "session_status", sessionId: "a", tag: 3 });
  assert.deepEqual(outbox.drain().map((m) => m.tag), [2, 3]);
});

test("the exported default cap matches the daemon's historical MAX_OUTBOX", () => {
  assert.equal(MAX_OUTBOX, 1000);
  const outbox = new Outbox<TestMessage>();
  for (let i = 0; i < MAX_OUTBOX + 5; i++) outbox.enqueue({ type: "session_event", sessionId: "a", tag: i });
  assert.equal(outbox.size, MAX_OUTBOX);
  const drained = outbox.drain();
  assert.equal(drained[0]?.tag, 5, "the five oldest events past the cap are dropped");
  assert.equal(drained.at(-1)?.tag, MAX_OUTBOX + 4);
});

test("projected flush drops one failed projection without discarding later critical messages", () => {
  const outbox = new Outbox<TestMessage>();
  outbox.enqueue({ type: "session_event", sessionId: "removed", tag: 1 });
  outbox.enqueue({ type: "session_status", sessionId: "live", tag: 2 });
  outbox.enqueue({ type: "permission_request", sessionId: "live", tag: 3 });
  const sent: number[] = [];
  const projectionErrors: number[] = [];

  flushProjectedOutbox(
    outbox,
    (message) => {
      if (message.tag === 1) throw new Error("removed session");
      return message;
    },
    (message) => sent.push(message.tag!),
    (_error, message) => projectionErrors.push(message.tag!),
    () => assert.fail("send should not fail"),
  );

  assert.deepEqual(projectionErrors, [1]);
  assert.deepEqual(sent, [2, 3]);
  assert.equal(outbox.size, 0);
});

test("projected flush restores the exact unsent suffix when socket send fails", () => {
  const outbox = new Outbox<TestMessage>();
  for (let tag = 1; tag <= 3; tag++) {
    outbox.enqueue({ type: "session_event", sessionId: "live", tag });
  }
  const sendErrors: number[] = [];

  flushProjectedOutbox(
    outbox,
    (message) => message,
    () => { throw new Error("socket closed"); },
    () => assert.fail("projection should not fail"),
    (_error, message) => sendErrors.push(message.tag!),
  );

  assert.deepEqual(sendErrors, [1]);
  assert.deepEqual(outbox.drain().map((message) => message.tag), [1, 2, 3]);
});
