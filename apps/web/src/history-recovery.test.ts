import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent, SessionEventsResponse } from "@wollipog/protocol";
import {
  loadOlderSessionEvents,
  recoverSessionHistories,
  recoverSessionHistory,
  recoverSessionHistoryWindow,
  sessionHistoryEpochKey,
} from "./history-recovery.js";

const event = (seq: number): SessionEvent => ({
  id: seq,
  sessionId: "s1",
  seq,
  ts: seq,
  payload: { kind: "agent_message", text: String(seq) },
});

test("bounded recovery follows server cursors and completes only on the final cached page", async () => {
  const pages: SessionEventsResponse[] = [
    { events: [event(11), event(12)], eventEpoch: 3, nextAfter: 12, hasMoreCached: true, cacheComplete: false },
    { events: [event(13)], eventEpoch: 3, nextAfter: 13, hasMoreCached: false, cacheComplete: false },
    { events: [], eventEpoch: 3, nextAfter: 13, hasMoreCached: false, cacheComplete: true },
  ];
  const afters: number[] = [];
  const applied: Array<{ seqs: number[]; complete: boolean }> = [];
  const complete = await recoverSessionHistory(
    { sessionId: "s1", after: 10, eventEpoch: 3, recoveryRevision: 7 },
    {
      fetchPage: async (_id, after) => {
        afters.push(after);
        return pages.shift()!;
      },
      applyPage: (_id, events, _epoch, _revision, done) =>
        applied.push({ seqs: events.map((entry) => entry.seq), complete: done }),
      isCurrent: () => true,
      wait: async () => {},
    },
  );
  assert.equal(complete, true);
  assert.deepEqual(afters, [10, 12, 13]);
  assert.deepEqual(applied, [
    { seqs: [11, 12], complete: false },
    { seqs: [13], complete: true },
  ]);
});

test("long cold histories paint the first page immediately and coalesce the remaining pages", async () => {
  const pages = Array.from({ length: 50 }, (_, index): SessionEventsResponse => ({
    events: [event(index + 1)],
    eventEpoch: 1,
    nextAfter: index + 1,
    hasMoreCached: index < 49,
    cacheComplete: index === 49,
  }));
  const applied: Array<{ seqs: number[]; complete: boolean }> = [];
  assert.equal(await recoverSessionHistory(
    { sessionId: "s1", after: 0, eventEpoch: 1, recoveryRevision: 9 },
    {
      fetchPage: async () => pages.shift()!,
      applyPage: (_id, events, _epoch, _revision, complete) =>
        applied.push({ seqs: events.map((entry) => entry.seq), complete }),
      isCurrent: () => true,
      wait: async () => {},
    },
  ), true);
  assert.deepEqual(applied[0], { seqs: [1], complete: false });
  assert.deepEqual(applied[1], { seqs: Array.from({ length: 49 }, (_, index) => index + 2), complete: true });
  assert.equal(applied.length, 2, "49 later pages produce one store fold instead of 49 full-array replacements");
});

test("an empty terminal page still commits recovery completion", async () => {
  const pages: SessionEventsResponse[] = [
    { events: [event(1)], eventEpoch: 7, nextAfter: 1, hasMoreCached: false, cacheComplete: false },
    { events: [], eventEpoch: 7, nextAfter: 1, hasMoreCached: false, cacheComplete: true },
  ];
  const applied: Array<{ seqs: number[]; complete: boolean }> = [];
  assert.equal(await recoverSessionHistory(
    { sessionId: "s1", after: 0, eventEpoch: 7, recoveryRevision: 3 },
    {
      fetchPage: async () => pages.shift()!,
      applyPage: (_id, events, _epoch, _revision, complete) =>
        applied.push({ seqs: events.map((entry) => entry.seq), complete }),
      isCurrent: () => true,
      wait: async () => {},
    },
  ), true);
  assert.deepEqual(applied, [
    { seqs: [1], complete: false },
    { seqs: [], complete: true },
  ]);
});

test("legacy control planes remain a one-response compatibility path", async () => {
  const applied: boolean[] = [];
  assert.equal(await recoverSessionHistory(
    { sessionId: "s1", after: 0, eventEpoch: 0, recoveryRevision: 0 },
    {
      fetchPage: async () => ({ events: [event(1)] }),
      applyPage: (_id, _events, _epoch, _revision, complete) => applied.push(complete),
      isCurrent: () => true,
      wait: async () => {},
    },
  ), true);
  assert.deepEqual(applied, [true]);
});

test("current views retry after the idle budget while queued runner hydration makes no progress", async () => {
  let calls = 0;
  const waits: number[] = [];
  assert.equal(await recoverSessionHistory(
    { sessionId: "s1", after: 0, eventEpoch: 4, recoveryRevision: 2 },
    {
      fetchPage: async () => {
        calls += 1;
        return calls < 3
          ? { events: [], eventEpoch: 4, nextAfter: 0, hasMoreCached: false, cacheComplete: false }
          : { events: [event(1)], eventEpoch: 4, nextAfter: 1, hasMoreCached: false, cacheComplete: true };
      },
      applyPage: () => {},
      isCurrent: () => true,
      wait: async (ms) => { waits.push(ms); },
      maxIdlePolls: 1,
      retryOnIdleTimeout: true,
    },
  ), true);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [75, 1_000]);
});

test("current direct views retry a transient page failure without losing their frozen cursor", async () => {
  let calls = 0;
  const afters: number[] = [];
  const waits: number[] = [];
  const applied: number[][] = [];
  assert.equal(await recoverSessionHistory(
    { sessionId: "s1", after: 8, eventEpoch: 4, recoveryRevision: 2 },
    {
      fetchPage: async (_sessionId, after) => {
        calls += 1;
        afters.push(after);
        if (calls === 1) throw new Error("temporary 503");
        return {
          events: [event(9)],
          eventEpoch: 4,
          nextAfter: 9,
          hasMoreCached: false,
          cacheComplete: true,
        };
      },
      applyPage: (_id, events) => { applied.push(events.map((entry) => entry.seq)); },
      isCurrent: () => true,
      wait: async (ms) => { waits.push(ms); },
      retryOnIdleTimeout: true,
    },
  ), true);
  assert.deepEqual(afters, [8, 8], "the failed request cannot advance the frozen recovery cursor");
  assert.deepEqual(waits, [1_000]);
  assert.deepEqual(applied, [[9]]);
});

test("history epoch keys change for in-place resets without session-id collisions", () => {
  const epochs = new Map([["a", 1], ["b:c", 2]]);
  const first = sessionHistoryEpochKey(["a", "b:c"], (id) => epochs.get(id) ?? 0);
  epochs.set("b:c", 3);
  const reset = sessionHistoryEpochKey(["a", "b:c"], (id) => epochs.get(id) ?? 0);
  assert.notEqual(first, reset);
  assert.notEqual(
    sessionHistoryEpochKey(["a:b", "c"], () => 1),
    sessionHistoryEpochKey(["a", "b:c"], () => 1),
  );
});

test("a stale epoch or non-advancing cached cursor is rejected without consuming recovery", async () => {
  let applied = 0;
  assert.equal(await recoverSessionHistory(
    { sessionId: "s1", after: 5, eventEpoch: 2, recoveryRevision: 1 },
    {
      fetchPage: async () => ({ events: [], eventEpoch: 3, nextAfter: 5, hasMoreCached: false, cacheComplete: true }),
      applyPage: () => { applied += 1; },
      isCurrent: () => true,
      wait: async () => {},
    },
  ), false);
  assert.equal(applied, 0);

  assert.equal(await recoverSessionHistory(
    { sessionId: "s1", after: 5, eventEpoch: 2, recoveryRevision: 1 },
    {
      fetchPage: async () => ({ events: [], eventEpoch: 2, nextAfter: 5, hasMoreCached: true, cacheComplete: false }),
      applyPage: () => { applied += 1; },
      isCurrent: () => true,
      wait: async () => {},
    },
  ), false);
  assert.equal(applied, 1, "the page can merge, but the frozen cursor remains unconsumed");
});

test("fleet recovery enforces the requested concurrency ceiling", async () => {
  let active = 0;
  let peak = 0;
  await recoverSessionHistories(
    Array.from({ length: 12 }, (_, index) => ({
      sessionId: `s${index}`,
      after: 0,
      eventEpoch: 0,
      recoveryRevision: 1,
    })),
    {
      fetchPage: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        return { events: [] };
      },
      applyPage: () => {},
      isCurrent: () => true,
      wait: async () => {},
    },
    4,
  );
  assert.equal(peak, 4);
});

test("fleet recovery rotates stalled members so later requests get a fair worker turn", async () => {
  let active = 0;
  let peak = 0;
  let current = true;
  let releaseFirstPair!: () => void;
  const firstPair = new Promise<void>((resolve) => { releaseFirstPair = resolve; });
  const calls: string[] = [];

  await recoverSessionHistories(
    ["s1", "s2", "s3"].map((sessionId) => ({
      sessionId,
      after: 0,
      eventEpoch: 0,
      recoveryRevision: 1,
    })),
    {
      fetchPage: async (sessionId) => {
        calls.push(sessionId);
        active += 1;
        peak = Math.max(peak, active);
        if (sessionId === "s1" || sessionId === "s2") {
          if (active === 2) releaseFirstPair();
          await firstPair;
          active -= 1;
          return { events: [], eventEpoch: 0, nextAfter: 0, hasMoreCached: false, cacheComplete: false };
        }
        active -= 1;
        current = false;
        return { events: [] };
      },
      applyPage: () => {},
      isCurrent: () => current,
      wait: async () => {},
      maxIdlePolls: 0,
      retryOnIdleTimeout: true,
    },
    2,
  );

  assert.equal(peak, 2);
  assert.deepEqual(calls.slice(0, 2).sort(), ["s1", "s2"]);
  assert.ok(calls.includes("s3"), "the third member must run even though the first two never advance");
});

test("fleet recovery rotates continuously advancing histories after a fixed page budget", async () => {
  let current = true;
  const calls: string[] = [];
  await recoverSessionHistories(
    ["s1", "s2", "s3"].map((sessionId) => ({
      sessionId,
      after: 0,
      eventEpoch: 0,
      recoveryRevision: 1,
    })),
    {
      fetchPage: async (sessionId, after) => {
        calls.push(sessionId);
        if (sessionId === "s3") {
          current = false;
          return { events: [] };
        }
        const next = after + 1;
        return {
          events: [{ ...event(next), sessionId }],
          eventEpoch: 0,
          nextAfter: next,
          hasMoreCached: true,
          cacheComplete: false,
        };
      },
      applyPage: () => {},
      isCurrent: () => current,
      wait: async () => {},
      retryOnIdleTimeout: true,
      maxPagesPerTurn: 2,
    },
    2,
  );

  assert.ok(calls.includes("s3"), "a later member must start while earlier caches keep advancing");
  assert.equal(calls.filter((sessionId) => sessionId === "s1").length <= 2, true);
  assert.equal(calls.filter((sessionId) => sessionId === "s2").length <= 2, true);
});

test("fleet page-budget yields resume immediately even without persistent idle retries", async () => {
  let calls = 0;
  const waits: number[] = [];
  const applied: Array<{ seqs: number[]; complete: boolean }> = [];
  await recoverSessionHistories(
    [{ sessionId: "s1", after: 0, eventEpoch: 0, recoveryRevision: 1 }],
    {
      fetchPage: async (_sessionId, after) => {
        calls += 1;
        const next = after + 1;
        return {
          events: [event(next)],
          eventEpoch: 0,
          nextAfter: next,
          hasMoreCached: next < 10,
          cacheComplete: next === 10,
        };
      },
      applyPage: (_id, events, _epoch, _revision, complete) =>
        applied.push({ seqs: events.map((entry) => entry.seq), complete }),
      isCurrent: () => true,
      wait: async (ms) => { waits.push(ms); },
    },
    1,
  );

  assert.equal(calls, 10, "the default eight-page turn budget never truncates a healthy chain");
  assert.deepEqual(applied, [
    { seqs: [1], complete: false },
    { seqs: [2, 3, 4, 5, 6, 7, 8], complete: false },
    { seqs: [9, 10], complete: true },
  ], "only the initial paint is special; each later fair turn folds one batch");
  assert.deepEqual(waits, [], "cooperative advancing yields do not incur idle backoff");
});

test("fleet page-budget yields retain empty-page cursor progress across turns", async () => {
  const afters: number[] = [];
  const completions: boolean[] = [];
  await recoverSessionHistories(
    [{ sessionId: "s1", after: 0, eventEpoch: 1, recoveryRevision: 1 }],
    {
      fetchPage: async (_sessionId, after) => {
        afters.push(after);
        if (after < 4) {
          return {
            events: [],
            eventEpoch: 1,
            nextAfter: after + 1,
            hasMoreCached: true,
            cacheComplete: false,
          };
        }
        return {
          events: [],
          eventEpoch: 1,
          nextAfter: after,
          hasMoreCached: false,
          cacheComplete: true,
        };
      },
      applyPage: (_id, _events, _epoch, _revision, complete) => { completions.push(complete); },
      isCurrent: () => true,
      wait: async () => {},
      maxPagesPerTurn: 2,
    },
    1,
  );

  assert.deepEqual(afters, [0, 1, 2, 3, 4], "every cooperative turn resumes at its fetched cursor");
  assert.equal(completions.at(-1), true);
  assert.equal(afters.length, 5, "empty cached pages cannot trigger a repeated-cursor request storm");
});

test("a stalled poll is not misclassified as an immediate page-budget yield", async () => {
  let calls = 0;
  await recoverSessionHistories(
    [{ sessionId: "stalled", after: 0, eventEpoch: 0, recoveryRevision: 1 }],
    {
      fetchPage: async () => {
        calls += 1;
        return { events: [], eventEpoch: 0, nextAfter: 0, hasMoreCached: false, cacheComplete: false };
      },
      applyPage: () => {},
      isCurrent: () => true,
      wait: async () => {},
      maxIdlePolls: 0,
      maxPagesPerTurn: 1,
    },
    1,
  );
  assert.equal(calls, 1);
});

test("a stalled member's backoff does not delay a healthy advancing member", async () => {
  let current = true;
  let advancingCalls = 0;
  const advancingCallsAtWait: number[] = [];
  await recoverSessionHistories(
    ["advancing", "stalled"].map((sessionId) => ({
      sessionId,
      after: 0,
      eventEpoch: 0,
      recoveryRevision: 1,
    })),
    {
      fetchPage: async (sessionId, after) => {
        if (sessionId === "stalled") {
          return { events: [], eventEpoch: 0, nextAfter: 0, hasMoreCached: false, cacheComplete: false };
        }
        advancingCalls += 1;
        const next = after + 1;
        return {
          events: [{ ...event(next), sessionId }],
          eventEpoch: 0,
          nextAfter: next,
          hasMoreCached: next < 5,
          cacheComplete: next === 5,
        };
      },
      applyPage: () => {},
      isCurrent: () => current,
      wait: async () => {
        advancingCallsAtWait.push(advancingCalls);
        current = false;
      },
      retryOnIdleTimeout: true,
      maxIdlePolls: 0,
      maxPagesPerTurn: 2,
    },
    2,
  );
  assert.equal(advancingCalls, 5);
  assert.deepEqual(advancingCallsAtWait, [5], "idle backoff begins only after immediate advancing turns finish");
});

test("fleet recovery reports per-member starts and failures without aborting peers", async () => {
  const started: string[] = [];
  const failed: string[] = [];
  const applied: string[] = [];
  await recoverSessionHistories(
    ["bad", "good"].map((sessionId) => ({ sessionId, after: 0, eventEpoch: 4, recoveryRevision: 2 })),
    {
      fetchPage: async (sessionId) => {
        if (sessionId === "bad") throw new Error("offline");
        return { events: [], eventEpoch: 4, nextAfter: 0, hasMoreCached: false, cacheComplete: true };
      },
      applyPage: (sessionId) => { applied.push(sessionId); },
      isCurrent: () => true,
      onRequestStart: (request) => { started.push(request.sessionId); },
      onRequestError: (request) => { failed.push(request.sessionId); },
    },
  );
  assert.deepEqual(started.sort(), ["bad", "good"]);
  assert.deepEqual(failed, ["bad"]);
  assert.deepEqual(applied, ["good"]);
});

test("fleet recovery does not report an obsolete failure after its view is cancelled", async () => {
  let current = true;
  let failures = 0;
  await recoverSessionHistories(
    [{ sessionId: "old", after: 0, eventEpoch: 0, recoveryRevision: 1 }],
    {
      fetchPage: async () => {
        current = false;
        throw new Error("obsolete request failed");
      },
      applyPage: () => {},
      isCurrent: () => current,
      onRequestError: () => { failures += 1; },
    },
  );
  assert.equal(failures, 0);
});

test("the opening window paints the newest events in one request, whatever the session's length", async () => {
  const requested: Array<number | undefined> = [];
  const applied: Array<{ seqs: number[]; complete: boolean; hasOlder: boolean }> = [];
  const result = await recoverSessionHistoryWindow(
    { sessionId: "s1", eventEpoch: 3, recoveryRevision: 7 },
    {
      fetchTailPage: async (_id, before) => {
        requested.push(before);
        return {
          events: [event(4_801), event(4_802)],
          eventEpoch: 3,
          nextBefore: 4_801,
          hasMoreOlder: true,
          cacheComplete: true,
        };
      },
      applyWindow: (_id, events, _epoch, _revision, complete, hasOlder) =>
        applied.push({ seqs: events.map((entry) => entry.seq), complete, hasOlder }),
      isCurrent: () => true,
      wait: async () => {},
    },
  );
  assert.deepEqual(result, { supported: true, complete: true });
  // One request, no cursor: a 4,800-event history costs exactly the same open as an empty one.
  assert.deepEqual(requested, [undefined]);
  assert.deepEqual(applied, [{ seqs: [4_801, 4_802], complete: true, hasOlder: true }]);
});

test("a hydrating cache re-reads the same window instead of walking the log forward", async () => {
  const pages: SessionEventsResponse[] = [
    { events: [event(1)], eventEpoch: 1, nextBefore: 1, hasMoreOlder: false, cacheComplete: false },
    { events: [event(1), event(2)], eventEpoch: 1, nextBefore: 1, hasMoreOlder: false, cacheComplete: false },
    { events: [event(2), event(3)], eventEpoch: 1, nextBefore: 2, hasMoreOlder: true, cacheComplete: true },
  ];
  const requested: Array<number | undefined> = [];
  const applied: Array<{ seqs: number[]; complete: boolean }> = [];
  const result = await recoverSessionHistoryWindow(
    { sessionId: "s1", eventEpoch: 1, recoveryRevision: 0 },
    {
      fetchTailPage: async (_id, before) => {
        requested.push(before);
        return pages.shift()!;
      },
      applyWindow: (_id, events, _epoch, _revision, complete) =>
        applied.push({ seqs: events.map((entry) => entry.seq), complete }),
      isCurrent: () => true,
      wait: async () => {},
    },
  );
  assert.deepEqual(result, { supported: true, complete: true });
  assert.deepEqual(requested, [undefined, undefined, undefined]);
  assert.deepEqual(applied.at(-1), { seqs: [2, 3], complete: true });
});

test("a control plane without backward reads is detected before its forward page is applied", async () => {
  const applied: number[][] = [];
  const result = await recoverSessionHistoryWindow(
    { sessionId: "s1", eventEpoch: 0, recoveryRevision: 0 },
    {
      // An older control plane ignores `direction` and answers with the START of the log — exactly
      // the content the window exists to avoid painting.
      fetchTailPage: async () => ({
        events: [event(1), event(2)],
        eventEpoch: 0,
        nextAfter: 2,
        hasMoreCached: true,
        cacheComplete: false,
      }),
      applyWindow: (_id, events) => applied.push(events.map((entry) => entry.seq)),
      isCurrent: () => true,
      wait: async () => {},
    },
  );
  assert.deepEqual(result, { supported: false, complete: false });
  assert.deepEqual(applied, [], "an unsupported response must not reach the transcript");
});

test("a replaced event epoch abandons the window without applying its stale page", async () => {
  const applied: number[][] = [];
  const result = await recoverSessionHistoryWindow(
    { sessionId: "s1", eventEpoch: 4, recoveryRevision: 1 },
    {
      fetchTailPage: async () => ({
        events: [event(9)],
        eventEpoch: 5,
        nextBefore: 9,
        hasMoreOlder: false,
        cacheComplete: true,
      }),
      applyWindow: (_id, events) => applied.push(events.map((entry) => entry.seq)),
      isCurrent: () => true,
      wait: async () => {},
    },
  );
  assert.deepEqual(result, { supported: true, complete: false });
  assert.deepEqual(applied, []);
});

test("older pages carry the reader's cursor and stop at the start of the log", async () => {
  const requested: Array<number | undefined> = [];
  const page = await loadOlderSessionEvents("s1", 4_801, 3, async (_id, before) => {
    requested.push(before);
    return {
      events: [event(4_601), event(4_602)],
      eventEpoch: 3,
      nextBefore: 4_601,
      hasMoreOlder: false,
      cacheComplete: true,
    };
  });
  assert.deepEqual(requested, [4_801]);
  assert.deepEqual(page, {
    events: [event(4_601), event(4_602)],
    hasOlder: false,
    eventEpoch: 3,
  });
  // A stale epoch or an unsupporting control plane yields nothing to prepend.
  assert.equal(
    await loadOlderSessionEvents("s1", 10, 3, async () => ({
      events: [event(1)], eventEpoch: 4, nextBefore: 1, hasMoreOlder: false, cacheComplete: true,
    })),
    null,
  );
  assert.equal(
    await loadOlderSessionEvents("s1", 10, 3, async () => ({
      events: [event(1)], eventEpoch: 3, nextAfter: 1, hasMoreCached: false, cacheComplete: true,
    })),
    null,
  );
});
