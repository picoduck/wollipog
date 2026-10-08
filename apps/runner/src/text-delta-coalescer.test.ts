import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { SessionEventPayload } from "@wollipog/protocol";
import type { DriverCallbacks } from "./drivers/driver.js";
import {
  coalesceDriverTextDeltas,
  isCoalescibleTextDelta,
  TextDeltaCoalescer,
  TEXT_DELTA_WINDOW_MS,
} from "./text-delta-coalescer.js";

/** A manual clock and timer queue, so tests control exactly when the window elapses. */
function fakeTime() {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (id: unknown) => { timers.delete(id as number); },
    pendingTimers: () => timers.size,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = until;
    },
  };
}

function harness() {
  const time = fakeTime();
  const out: Array<{ at: number; payload: SessionEventPayload }> = [];
  const coalescer = new TextDeltaCoalescer((payload) => out.push({ at: time.now(), payload }), time);
  return { time, out, coalescer, payloads: () => out.map((entry) => entry.payload) };
}

const delta = (text: string, messageId = "m1", extra: Partial<Extract<SessionEventPayload, { kind: "agent_message" }>> = {}) =>
  ({ kind: "agent_message", text, messageId, ...extra }) as const;

test("the first delta after a quiet window is emitted immediately, so first text is not delayed", () => {
  const h = harness();
  h.coalescer.push(delta("Hel"));
  assert.deepEqual(h.payloads(), [delta("Hel")]);
  assert.equal(h.time.pendingTimers(), 0);
});

test("deltas inside the window merge into one event emitted when the window ends", () => {
  const h = harness();
  h.coalescer.push(delta("Hel"));
  h.time.advance(10);
  h.coalescer.push(delta("lo, "));
  h.time.advance(10);
  h.coalescer.push(delta("world"));
  assert.equal(h.out.length, 1, "later deltas wait for the window");
  h.time.advance(TEXT_DELTA_WINDOW_MS);
  assert.deepEqual(h.payloads(), [delta("Hel"), delta("lo, world")]);
  assert.equal(h.out[1]!.at - h.out[0]!.at, TEXT_DELTA_WINDOW_MS, "a pending delta waits at most one window");
});

test("a provider streaming 100 deltas per second yields at most one text event per window", () => {
  const h = harness();
  let text = "";
  for (let i = 0; i < 300; i++) {
    const chunk = `w${i} `;
    text += chunk;
    h.coalescer.push(delta(chunk));
    h.time.advance(10);
  }
  h.coalescer.flush();
  const seconds = 3;
  assert.ok(h.out.length <= Math.ceil((seconds * 1000) / TEXT_DELTA_WINDOW_MS) + 1, `${h.out.length} events in ${seconds}s`);
  assert.ok(h.out.length / seconds <= 20, "the issue bounds streamed text at 10–20 events per second");
  for (let i = 1; i < h.out.length; i++) {
    assert.ok(h.out[i]!.at - h.out[i - 1]!.at >= TEXT_DELTA_WINDOW_MS, "emissions are at least one window apart");
  }
  assert.equal(h.payloads().map((payload) => (payload as { text: string }).text).join(""), text);
});

test("an interleaved tool call flushes pending text first and keeps its place", () => {
  const h = harness();
  const toolCall: SessionEventPayload = { kind: "tool_call", toolCallId: "t1", title: "Read", status: "pending" };
  h.coalescer.push(delta("Let me "));
  h.coalescer.push(delta("check."));
  h.coalescer.push(toolCall);
  h.coalescer.push(delta("Done", "m2"));
  h.coalescer.flush();
  assert.deepEqual(h.payloads(), [delta("Let me "), delta("check."), toolCall, delta("Done", "m2")]);
});

test("a message boundary, a parent change, or a kind change starts a new event", () => {
  const h = harness();
  h.coalescer.push(delta("a"));
  h.coalescer.push(delta("b"));
  h.coalescer.push(delta("c"));
  h.coalescer.push(delta("d", "m2"));
  h.coalescer.push(delta("e", "m2", { parentToolUseId: "task-1" }));
  h.coalescer.push({ kind: "agent_thought", text: "f", messageId: "m2", parentToolUseId: "task-1" });
  h.coalescer.flush();
  assert.deepEqual(h.payloads(), [
    delta("a"),
    delta("bc"),
    delta("d", "m2"),
    delta("e", "m2", { parentToolUseId: "task-1" }),
    { kind: "agent_thought", text: "f", messageId: "m2", parentToolUseId: "task-1" },
  ]);
});

test("a final message flushes pending deltas and is never merged", () => {
  const h = harness();
  h.coalescer.push(delta("par"));
  h.coalescer.push(delta("tial"));
  h.coalescer.push(delta("partial", "m1", { final: true }));
  assert.deepEqual(h.payloads(), [delta("par"), delta("tial"), delta("partial", "m1", { final: true })]);
  assert.equal(h.time.pendingTimers(), 0);
});

test("a merge that would pass the size threshold flushes the pending text first", () => {
  const time = fakeTime();
  const out: SessionEventPayload[] = [];
  const coalescer = new TextDeltaCoalescer((payload) => out.push(payload), { ...time, maxPendingChars: 10 });
  coalescer.push(delta("first"));
  coalescer.push(delta("12345"));
  coalescer.push(delta("67890"));
  assert.deepEqual(out, [delta("first")], "exactly the threshold still merges");
  coalescer.push(delta("x"));
  assert.deepEqual(out, [delta("first"), delta("1234567890")], "no merged event exceeds the threshold");
  time.advance(TEXT_DELTA_WINDOW_MS);
  assert.deepEqual(out, [delta("first"), delta("1234567890"), delta("x")]);
});

test("property: a merged event never exceeds the size threshold unless one delta already did", () => {
  fc.assert(fc.property(
    fc.array(fc.tuple(fc.string({ maxLength: 12 }), fc.integer({ min: 0, max: 30 })), { maxLength: 80 }),
    fc.integer({ min: 1, max: 20 }),
    (deltas, maxPendingChars) => {
      const time = fakeTime();
      const out: SessionEventPayload[] = [];
      const coalescer = new TextDeltaCoalescer((payload) => out.push(payload), { ...time, maxPendingChars });
      for (const [text, gapMs] of deltas) {
        time.advance(gapMs);
        coalescer.push(delta(text));
      }
      coalescer.flush();
      const largestDelta = Math.max(0, ...deltas.map(([text]) => text.length));
      for (const payload of out) {
        assert.ok((payload as { text: string }).text.length <= Math.max(maxPendingChars, largestDelta));
      }
      assert.equal(out.map((payload) => (payload as { text: string }).text).join(""), deltas.map(([text]) => text).join(""));
    },
  ), { numRuns: 300 });
});

test("only the plain streaming delta shape is coalescible", () => {
  assert.equal(isCoalescibleTextDelta(delta("x")), true);
  assert.equal(isCoalescibleTextDelta({ kind: "agent_message", text: "x" }), true);
  assert.equal(isCoalescibleTextDelta({ kind: "agent_thought", text: "x", parentToolUseId: "p" }), true);
  assert.equal(isCoalescibleTextDelta(delta("x", "m1", { final: true })), false);
  assert.equal(isCoalescibleTextDelta({ kind: "user_message", text: "x" }), false);
  assert.equal(isCoalescibleTextDelta({ kind: "agent_message", text: "x", extra: 1 } as unknown as SessionEventPayload), false);
});

test("a flush that re-enters through its own emit does not duplicate or lose text", () => {
  const time = fakeTime();
  const out: SessionEventPayload[] = [];
  // Mirrors the session manager, whose event append flushes before every event it records.
  const coalescer: TextDeltaCoalescer = new TextDeltaCoalescer((payload) => {
    coalescer.flush();
    out.push(payload);
  }, time);
  coalescer.push(delta("a"));
  coalescer.push(delta("b"));
  coalescer.push(delta("c"));
  coalescer.push({ kind: "turn_interrupted" } as SessionEventPayload);
  assert.deepEqual(out, [delta("a"), delta("bc"), { kind: "turn_interrupted" }]);
});

test("a timer-driven flush reports an emit failure instead of throwing from the timer", () => {
  const time = fakeTime();
  const errors: unknown[] = [];
  let fail = false;
  const coalescer = new TextDeltaCoalescer(() => { if (fail) throw new Error("append failed"); }, {
    ...time,
    onError: (error) => errors.push(error),
  });
  coalescer.push(delta("a"));
  coalescer.push(delta("b"));
  fail = true;
  assert.doesNotThrow(() => time.advance(TEXT_DELTA_WINDOW_MS));
  assert.equal(errors.length, 1);
});

test("wrapped driver callbacks flush pending text before every other callback", () => {
  const order: string[] = [];
  const callbacks: DriverCallbacks = {
    supportsWorkerAttention: () => { order.push("query"); return true; },
    onEvent: (payload) => order.push(`event:${payload.kind}:${"text" in payload ? payload.text : ""}`),
    onStderr: (text) => order.push(`stderr:${text}`),
    onExit: (code) => order.push(`exit:${code}`),
  };
  const routed = coalesceDriverTextDeltas(callbacks, { windowMs: 60_000 });
  routed.callbacks.onEvent(delta("a"));
  routed.callbacks.onEvent(delta("b"));
  routed.callbacks.supportsWorkerAttention?.();
  routed.callbacks.onEvent(delta("c"));
  routed.callbacks.onStderr("warn");
  routed.callbacks.onEvent(delta("d"));
  routed.callbacks.onExit(1);
  assert.deepEqual(order, [
    "event:agent_message:a",
    "query",
    "event:agent_message:bc",
    "stderr:warn",
    "event:agent_message:d",
    "exit:1",
  ]);
});

// ---------------------------------------------------------------------------------------------
// Coalesced output against the uncoalesced stream, over random sequences.

/** Merge adjacent same-stream deltas: the one transformation coalescing is allowed to apply. */
function canonical(events: SessionEventPayload[]): SessionEventPayload[] {
  const result: SessionEventPayload[] = [];
  for (const event of events) {
    const last = result.at(-1);
    if (last && isCoalescibleTextDelta(last) && isCoalescibleTextDelta(event) && last.kind === event.kind &&
        (last.messageId ?? "") === (event.messageId ?? "") &&
        (last.parentToolUseId ?? "") === (event.parentToolUseId ?? "")) {
      result[result.length - 1] = { ...last, text: last.text + event.text };
    } else {
      result.push(event);
    }
  }
  return result;
}

type Step =
  | { type: "event"; payload: SessionEventPayload; gapMs: number }
  | { type: "flush"; gapMs: number };

const textChunk = fc.string({ minLength: 0, maxLength: 6 });
const streamId = fc.constantFrom(undefined, "m1", "m2");
const parent = fc.constantFrom(undefined, "task-1");
const textEvent = fc.record({
  kind: fc.constantFrom("agent_message" as const, "agent_thought" as const),
  text: textChunk,
  messageId: streamId,
  parentToolUseId: parent,
}).map((event) => Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) as SessionEventPayload);
const otherEvent = fc.oneof(
  fc.record({ kind: fc.constant("tool_call" as const), toolCallId: fc.constantFrom("t1", "t2"), title: fc.constant("Bash"), status: fc.constant("pending" as const) }),
  fc.record({ kind: fc.constant("stderr" as const), text: textChunk }),
  fc.record({ kind: fc.constant("agent_message" as const), text: textChunk, messageId: streamId, final: fc.constant(true) })
    .map((event) => Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined)) as SessionEventPayload),
  fc.constant({ kind: "turn_interrupted" } as SessionEventPayload),
);
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 8, arbitrary: fc.record({ type: fc.constant("event" as const), payload: textEvent, gapMs: fc.integer({ min: 0, max: 120 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("event" as const), payload: otherEvent, gapMs: fc.integer({ min: 0, max: 120 }) }) },
  // A forced flush: stop, interrupt, status change, turn settlement, provider exit, or shutdown.
  { weight: 1, arbitrary: fc.record({ type: fc.constant("flush" as const), gapMs: fc.integer({ min: 0, max: 120 }) }) },
);

test("property: coalesced output equals the uncoalesced stream with adjacent deltas merged", () => {
  fc.assert(fc.property(fc.array(step, { maxLength: 80 }), fc.integer({ min: 1, max: 200 }), (steps, windowMs) => {
    const time = fakeTime();
    const coalesced: Array<{ at: number; payload: SessionEventPayload; forced: boolean }> = [];
    // The push or flush in progress. An emission is forced when a boundary caused it: a flush, a
    // non-text event, or a delta of another stream. Only unforced emissions are rate limited.
    let current: SessionEventPayload | "flush" | null = null;
    const coalescer = new TextDeltaCoalescer((payload) => coalesced.push({
      at: time.now(),
      payload,
      forced: current === "flush" || (current !== null &&
        !(isCoalescibleTextDelta(current) && isCoalescibleTextDelta(payload) && canonical([current, payload]).length === 1)),
    }), { ...time, windowMs });
    const uncoalesced: SessionEventPayload[] = [];
    for (const item of steps) {
      time.advance(item.gapMs);
      if (item.type === "flush") {
        current = "flush";
        coalescer.flush();
        current = null;
        // Nothing may remain pending across a forced boundary.
        assert.equal(time.pendingTimers(), 0);
        continue;
      }
      uncoalesced.push(item.payload);
      current = item.payload;
      coalescer.push(item.payload);
      current = null;
    }
    current = "flush";
    coalescer.flush();
    const payloads = coalesced.map((entry) => entry.payload);
    // Identical event order and identical concatenated text, stream by stream.
    assert.deepEqual(canonical(payloads), canonical(uncoalesced));
    // Coalescing never splits or adds events.
    assert.ok(payloads.length <= uncoalesced.length);
    // Rate: an unforced text event follows the previous text event by at least one window.
    let lastTextAt = Number.NEGATIVE_INFINITY;
    for (const entry of coalesced) {
      if (!isCoalescibleTextDelta(entry.payload)) continue;
      if (!entry.forced) assert.ok(entry.at - lastTextAt >= windowMs, "an unforced text event respects the window");
      lastTextAt = entry.at;
    }
  }), { numRuns: 500 });
});

test("property: no streamed text is held longer than one window", () => {
  fc.assert(fc.property(fc.array(fc.tuple(textEvent, fc.integer({ min: 0, max: 40 })), { minLength: 1, maxLength: 60 }), (deltas) => {
    const time = fakeTime();
    let emittedChars = 0;
    const coalescer = new TextDeltaCoalescer((payload) => {
      if ("text" in payload && typeof payload.text === "string") emittedChars += payload.text.length;
    }, time);
    let pushedChars = 0;
    for (const [payload, gapMs] of deltas) {
      time.advance(gapMs);
      coalescer.push(payload);
      pushedChars += (payload as { text: string }).text.length;
    }
    time.advance(TEXT_DELTA_WINDOW_MS);
    assert.equal(emittedChars, pushedChars, "every delta lands within one window of the last one");
    assert.equal(time.pendingTimers(), 0);
  }), { numRuns: 300 });
});
