import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEvent, SessionEventsResponse, SessionView } from "@wollipog/protocol";
import { Store } from "./store.js";
import {
  loadOlderSessionEvents,
  recoverSessionHistories,
  recoverSessionHistory,
  recoverSessionHistoryGap,
  recoverSessionHistoryWindow,
  recoverSessionTurnStartWindow,
  sessionHistoryEpochKey,
  shouldReadOpeningWindow,
} from "./history-recovery.js";

const event = (seq: number): SessionEvent => ({
  id: seq,
  sessionId: "s1",
  seq,
  ts: seq,
  payload: { kind: "agent_message", text: String(seq) },
});

test("provisional and acknowledged turn-start owners issue one opening request", async () => {
  const scope = {};
  let calls = 0;
  let release!: (page: SessionEventsResponse) => void;
  const pending = new Promise<SessionEventsResponse>(resolve => { release = resolve; });
  const applied: number[] = [];
  const options = { scope, readKey: "s1:3:generation1", fetchOpening: async () => { calls++; return pending; },
    fetchTailPage: async () => { throw new Error("must not read the tail"); },
    applyWindow: () => { throw new Error("must not apply the tail"); },
    applyOpening: (page: SessionEventsResponse) => { applied.push(page.turnStartSeq!); return true; }, isCurrent: () => true };
  const first = recoverSessionTurnStartWindow({ sessionId: "s1", eventEpoch: 3, recoveryRevision: -1 }, options);
  const second = recoverSessionTurnStartWindow({ sessionId: "s1", eventEpoch: 3, recoveryRevision: 7 }, options);
  release({ events: [event(501)], eventEpoch: 3, turnStartSeq: 501, tailSeq: 3_000,
    nextAfter: 501, hasMoreLater: true, cacheComplete: true });
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(applied, [501, 501]);
});

test("turn-start recovery waits for hydration, fences epochs, and falls back on old servers", async () => {
  let openingCalls = 0;
  let tailCalls = 0;
  let applied = 0;
  const options = { scope: {}, readKey: "s1:3", fetchOpening: async () => {
    openingCalls++;
    return { events: [event(10)], eventEpoch: 3, turnStartSeq: 10, tailSeq: 20,
      nextAfter: 10, hasMoreLater: true, cacheComplete: openingCalls > 1 };
  }, fetchTailPage: async () => { tailCalls++; return { events: [event(20)], eventEpoch: 3,
    nextBefore: 20, hasMoreOlder: true, cacheComplete: true }; },
  applyWindow: () => { applied++; }, applyOpening: () => { applied++; return true; },
  isCurrent: () => true, wait: async () => {} };
  await recoverSessionTurnStartWindow({ sessionId: "s1", eventEpoch: 3, recoveryRevision: 1 }, options);
  assert.equal(openingCalls, 2);
  assert.equal(applied, 1);
  assert.equal(tailCalls, 0);
  await recoverSessionTurnStartWindow({ sessionId: "s1", eventEpoch: 4, recoveryRevision: 1 },
    { ...options, scope: {}, readKey: "s1:4" });
  assert.equal(applied, 1, "a stale epoch never paints");
  await recoverSessionTurnStartWindow({ sessionId: "s1", eventEpoch: 3, recoveryRevision: 1 },
    { ...options, scope: {}, fetchOpening: async () => ({ events: [event(1)] }) });
  assert.equal(tailCalls, 1);
  assert.equal(applied, 2, "the existing aligned loader owns compatibility");
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
  const applied: Array<{ seqs: number[]; complete: boolean; hasOlder: boolean; turnAligned?: boolean }> = [];
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
          turnAligned: true,
          cacheComplete: true,
        };
      },
      applyWindow: (_id, events, _epoch, _revision, complete, hasOlder, turnAligned) =>
        applied.push({ seqs: events.map((entry) => entry.seq), complete, hasOlder, turnAligned }),
      isCurrent: () => true,
      wait: async () => {},
    },
  );
  assert.deepEqual(result, { supported: true, complete: true });
  // One request, no cursor: a 4,800-event history costs exactly the same open as an empty one.
  assert.deepEqual(requested, [undefined]);
  assert.deepEqual(applied, [{
    seqs: [4_801, 4_802],
    complete: true,
    hasOlder: true,
    turnAligned: true,
  }]);
});

test("a hydrating cache is never painted: its newest cached row is still an old prefix", async () => {
  // The control plane hydrates FORWARD from the runner, so an incomplete cache's "tail" can be the
  // START of a long log. Painting it would reproduce the oldest-first open this window removes.
  const pages: SessionEventsResponse[] = [
    { events: [event(1), event(2)], eventEpoch: 1, nextBefore: 1, hasMoreOlder: false, cacheComplete: false },
    { events: [event(4_801), event(4_802)], eventEpoch: 1, nextBefore: 4_801, hasMoreOlder: true, cacheComplete: true },
  ];
  const applied: Array<{ seqs: number[]; complete: boolean }> = [];
  const result = await recoverSessionHistoryWindow(
    { sessionId: "s1", eventEpoch: 1, recoveryRevision: 0 },
    {
      fetchTailPage: async () => pages.shift()!,
      applyWindow: (_id, events, _epoch, _revision, complete) =>
        applied.push({ seqs: events.map((entry) => entry.seq), complete }),
      isCurrent: () => true,
      wait: async () => {},
    },
  );
  assert.deepEqual(result, { supported: true, complete: true });
  assert.deepEqual(applied, [{ seqs: [4_801, 4_802], complete: true }],
    "only the complete tail reaches the transcript");
});

test("a cache that never catches up shows what it has rather than an empty reader", async () => {
  const applied: Array<{ seqs: number[]; complete: boolean }> = [];
  const result = await recoverSessionHistoryWindow(
    { sessionId: "s1", eventEpoch: 1, recoveryRevision: 0 },
    {
      fetchTailPage: async () => ({
        events: [event(1)], eventEpoch: 1, nextBefore: 1, hasMoreOlder: false, cacheComplete: false,
      }),
      applyWindow: (_id, events, _epoch, _revision, complete) =>
        applied.push({ seqs: events.map((entry) => entry.seq), complete }),
      isCurrent: () => true,
      wait: async () => {},
      maxIdlePolls: 3,
    },
  );
  assert.deepEqual(result, { supported: true, complete: false });
  assert.deepEqual(applied, [{ seqs: [1], complete: false }],
    "the budget expires into a visible, explicitly incomplete transcript");
});

test("a cache that cannot fill settles on its first answer, and one that can again keeps reading (#2773)", async () => {
  // The session's machine is offline: reading the window again cannot change it.
  let cannotFill = true;
  let requests = 0;
  const applied: Array<{ seqs: number[]; complete: boolean }> = [];
  const options = {
    fetchTailPage: async () => {
      requests += 1;
      return { events: [event(1)], eventEpoch: 1, nextBefore: 1, hasMoreOlder: false, cacheComplete: false };
    },
    applyWindow: (_id: string, events: SessionEvent[], _epoch: number, _revision: number, complete: boolean) =>
      applied.push({ seqs: events.map((entry) => entry.seq), complete }),
    isCurrent: () => true,
    cacheCannotFill: () => cannotFill,
    wait: async () => {},
  };
  const offline = await recoverSessionHistoryWindow({ sessionId: "s1", eventEpoch: 1, recoveryRevision: 0 }, options);
  assert.deepEqual(offline, { supported: true, complete: false });
  assert.equal(requests, 1, "one read, not the whole re-read budget");
  assert.deepEqual(applied, [{ seqs: [1], complete: false }]);

  // The machine reconnects during a later read: the cache can fill, so the window waits for it.
  requests = 0;
  applied.length = 0;
  cannotFill = false;
  const online = await recoverSessionHistoryWindow(
    { sessionId: "s1", eventEpoch: 1, recoveryRevision: 0 },
    { ...options, maxIdlePolls: 3 },
  );
  assert.deepEqual(online, { supported: true, complete: false });
  assert.equal(requests, 4, "the full budget while the cache can still fill");
});

test("a re-read window keeps polling the tail instead of walking the log forward", async () => {
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
  assert.deepEqual(requested, [undefined, undefined, undefined], "every re-read asks for the tail");
  assert.deepEqual(applied, [{ seqs: [2, 3], complete: true }]);
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

test("opening-fill pages request and preserve semantic turn alignment", async () => {
  const alignments: Array<boolean | undefined> = [];
  const page = await loadOlderSessionEvents(
    "s1",
    4_801,
    3,
    async (_id, _before, _epoch, _limit, alignToTurn) => {
      alignments.push(alignToTurn);
      return {
        events: [event(4_401), event(4_402)],
        eventEpoch: 3,
        nextBefore: 4_401,
        hasMoreOlder: true,
        turnAligned: false,
        cacheComplete: true,
      };
    },
    true,
  );
  assert.deepEqual(alignments, [true]);
  assert.equal(page?.turnAligned, false);
});

test("the opening window survives a live event that lands before the load starts", () => {
  const cold = { recoveryAfter: 0, hasSavedReadingPosition: false };
  assert.equal(shouldReadOpeningWindow(cold), true);
  // Live pre-ack rows provide no cursor proof, so a zero read cursor uses the tail. A completed
  // provisional REST window is resolved to its proven read cursor by the store before this call.
  // A reconnect gap belongs to the forward chain, whose frozen cursor cannot skip outage events.
  assert.equal(shouldReadOpeningWindow({ ...cold, recoveryAfter: 4_800 }), false);
  // A reader paused somewhere keeps the history their restore depends on.
  assert.equal(shouldReadOpeningWindow({ ...cold, hasSavedReadingPosition: true }), false);
});


test("a long reconnect gap follows at most four pages before replacing the tail window", async () => {
  const cursors: number[] = [];
  const windows: number[][] = [];
  const request = { sessionId: "s1", after: 10, eventEpoch: 3, recoveryRevision: 7 };
  const complete = await recoverSessionHistoryGap(request, {
    history: {
      fetchPage: async (_id, after) => {
        cursors.push(after);
        const nextAfter = Math.min(after + 200, 139_881);
        return { events: [event(nextAfter)], eventEpoch: 3, nextAfter,
          hasMoreCached: nextAfter < 139_881, cacheComplete: true };
      },
      applyPage: () => {},
      isCurrent: () => true,
    },
    window: {
      fetchTailPage: async () => ({ events: [event(139_880), event(139_881)],
        eventEpoch: 3, hasMoreOlder: true, cacheComplete: true }),
      applyWindow: (_id, events) => windows.push(events.map((entry) => entry.seq)),
      isCurrent: () => true,
    },
    canReplaceWithWindow: () => true,
  });
  assert.equal(complete, true);
  assert.deepEqual(cursors, [10, 210, 410, 610]);
  assert.deepEqual(windows, [[139_880, 139_881]]);
});

test("a short reconnect gap retains its earlier reading rows without a tail read", async () => {
  const applied: number[] = [];
  let tailReads = 0;
  assert.equal(await recoverSessionHistoryGap(
    { sessionId: "s1", after: 10, eventEpoch: 3, recoveryRevision: 7 },
    {
      history: {
        fetchPage: async (_id, after) => ({ events: [event(after + 1)], eventEpoch: 3,
          nextAfter: after + 1, hasMoreCached: after < 11, cacheComplete: true }),
        applyPage: (_id, events) => applied.push(...events.map((entry) => entry.seq)),
        isCurrent: () => true,
      },
      window: {
        fetchTailPage: async () => { tailReads += 1; throw new Error("unexpected tail read"); },
        applyWindow: () => {},
        isCurrent: () => true,
      },
      canReplaceWithWindow: () => true,
    },
  ), true);
  assert.deepEqual(applied, [11, 12]);
  assert.equal(tailReads, 0);
});

test("pausing during reconnect continues from the applied cursor and preserves the reader", async () => {
  const cursors: number[] = [];
  const applied: number[] = [];
  let paused = false;
  let tailReads = 0;
  assert.equal(await recoverSessionHistoryGap(
    { sessionId: "s1", after: 10, eventEpoch: 3, recoveryRevision: 7 },
    {
      history: {
        fetchPage: async (_id, after) => {
          cursors.push(after);
          if (after === 13) paused = true;
          return { events: [event(after + 1)], eventEpoch: 3, nextAfter: after + 1,
            hasMoreCached: after < 15, cacheComplete: true };
        },
        applyPage: (_id, events) => applied.push(...events.map((entry) => entry.seq)),
        isCurrent: () => true,
      },
      window: {
        fetchTailPage: async () => { tailReads += 1; throw new Error("unexpected tail read"); },
        applyWindow: () => {},
        isCurrent: () => true,
      },
      canReplaceWithWindow: () => !paused,
    },
  ), true);
  assert.deepEqual(cursors, [10, 11, 12, 13, 14, 15]);
  assert.deepEqual(applied, [11, 12, 13, 14, 15, 16]);
  assert.equal(tailReads, 0);
});

test("reconnect fallback resumes the applied forward cursor on an older control plane", async () => {
  const cursors: number[] = [];
  const applied: number[] = [];
  let tailReads = 0;
  assert.equal(await recoverSessionHistoryGap(
    { sessionId: "s1", after: 10, eventEpoch: 3, recoveryRevision: 7 },
    {
      history: {
        fetchPage: async (_id, after) => {
          cursors.push(after);
          return { events: [event(after + 1)], eventEpoch: 3, nextAfter: after + 1,
            hasMoreCached: after < 15, cacheComplete: true };
        },
        applyPage: (_id, events) => applied.push(...events.map((entry) => entry.seq)),
        isCurrent: () => true,
      },
      window: {
        fetchTailPage: async () => { tailReads += 1; return { events: [event(1)] }; },
        applyWindow: () => { throw new Error("legacy prefix must not replace the timeline"); },
        isCurrent: () => true,
      },
      canReplaceWithWindow: () => true,
    },
  ), true);
  assert.deepEqual(cursors, [10, 11, 12, 13, 14, 15]);
  assert.deepEqual(applied, [11, 12, 13, 14, 15, 16]);
  assert.equal(tailReads, 1);
});

test("an obsolete reconnect epoch never switches to a current tail window", async () => {
  let tailReads = 0;
  assert.equal(await recoverSessionHistoryGap(
    { sessionId: "s1", after: 10, eventEpoch: 3, recoveryRevision: 7 },
    {
      history: {
        fetchPage: async () => ({ events: [event(1)], eventEpoch: 4, nextAfter: 1,
          hasMoreCached: false, cacheComplete: true }),
        applyPage: () => { throw new Error("obsolete epoch must not apply"); },
        isCurrent: () => true,
      },
      window: {
        fetchTailPage: async () => { tailReads += 1; throw new Error("unexpected tail read"); },
        applyWindow: () => {},
        isCurrent: () => true,
      },
      canReplaceWithWindow: () => true,
    },
  ), false);
  assert.equal(tailReads, 0);
});


test("pausing while the replacement tail is in flight preserves the forward reading rows", async () => {
  let paused = false;
  const cursors: number[] = [];
  const applied: number[] = [];
  assert.equal(await recoverSessionHistoryGap(
    { sessionId: "s1", after: 10, eventEpoch: 3, recoveryRevision: 7 },
    {
      history: {
        fetchPage: async (_id, after) => {
          cursors.push(after);
          return { events: [event(after + 1)], eventEpoch: 3, nextAfter: after + 1,
            hasMoreCached: after < 15, cacheComplete: true };
        },
        applyPage: (_id, events) => applied.push(...events.map((entry) => entry.seq)),
        isCurrent: () => true,
      },
      window: {
        fetchTailPage: async () => {
          paused = true;
          return { events: [event(16)], eventEpoch: 3, hasMoreOlder: true, cacheComplete: true };
        },
        applyWindow: () => { throw new Error("paused reading rows must not be replaced"); },
        isCurrent: () => true,
      },
      canReplaceWithWindow: () => !paused,
    },
  ), true);
  assert.deepEqual(cursors, [10, 11, 12, 13, 14, 15]);
  assert.deepEqual(applied, [11, 12, 13, 14, 15, 16]);
});


test("reconnect tail replacement merges newer live rows and keeps omitted history reachable", async () => {
  const store = new Store();
  store.dispatch({ type: "msg", msg: {
    type: "snapshot", capabilities: { sessionSubscriptions: true, boundedDelivery: true },
    runners: [], boxes: [], sessions: [{ id: "s1", eventEpoch: 3 } as SessionView], runs: [], pods: [],
  } });
  store.navigate({ name: "session", id: "s1" });
  const generation = store.getState().snapshotRevision;
  store.prepareSubscriptionRecovery(1, ["s1"]);
  store.dispatch({ type: "msg", msg: {
    type: "session_subscriptions_applied", revision: 1, sessionIds: ["s1"], podIds: [],
  } });
  store.beginEventHistoryLoad("s1", 3, 1, generation);
  store.loadEvents("s1", [event(9), event(10)], 3, 1, true, generation, true);
  store.prepareSubscriptionRecovery(2, ["s1"]);
  store.dispatch({ type: "msg", msg: {
    type: "session_subscriptions_applied", revision: 2, sessionIds: ["s1"], podIds: [],
  } });
  store.beginEventHistoryLoad("s1", 3, 2, generation);
  assert.equal(await recoverSessionHistoryGap(
    { sessionId: "s1", after: store.recoveryAfter("s1"), eventEpoch: 3, recoveryRevision: 2 },
    {
      history: {
        fetchPage: async (_id, after) => ({ events: [event(after + 1)], eventEpoch: 3,
          nextAfter: after + 1, hasMoreCached: true, cacheComplete: true }),
        applyPage: (id, events, epoch, revision, complete) =>
          store.loadEvents(id, events, epoch, revision, complete, generation),
        isCurrent: () => true,
      },
      window: {
        fetchTailPage: async () => {
          store.dispatch({ type: "msg", msg: { type: "session_event", event: event(139_882) } });
          return { events: [event(139_880), event(139_881)], eventEpoch: 3,
            hasMoreOlder: true, cacheComplete: true };
        },
        applyWindow: (id, events, epoch, revision, complete, hasOlder, turnAligned) =>
          store.loadEvents(id, events, epoch, revision, complete, generation, hasOlder, turnAligned),
        isCurrent: () => true,
      },
      canReplaceWithWindow: () => true,
    },
  ), true);
  assert.deepEqual(store.getState().events.get("s1")?.map((entry) => entry.seq),
    [139_880, 139_881, 139_882]);
  assert.equal(store.recoveryAfter("s1"), 139_882);
  assert.equal(store.getState().eventWindows.get("s1")?.hasOlder, true);
  const before = store.eventWindowBase("s1");
  const older = await loadOlderSessionEvents("s1", before, 3, async (_id, cursor) => {
    assert.equal(cursor, 139_880);
    return { events: [event(139_878), event(139_879)], eventEpoch: 3,
      hasMoreOlder: true, cacheComplete: true };
  });
  assert.ok(older);
  store.loadOlderEvents("s1", older.events, older.hasOlder, before, older.eventEpoch);
  assert.deepEqual(store.getState().events.get("s1")?.map((entry) => entry.seq),
    [139_878, 139_879, 139_880, 139_881, 139_882]);
  assert.equal(store.recoveryAfter("s1"), 139_882, "older reads cannot rewind the recovered cursor");
});

for (const tailSeq of [10_000, 1_000_000]) for (const pauseAt of [0, 2, 5]) {
  test(`supported paused recovery stages one tail after four pages (gap ${tailSeq}, pause boundary ${pauseAt})`, async () => {
    let paused = pauseAt === 0;
    const afters: number[] = [];
    let tails = 0, staged = 0;
    const applied: number[] = [];
    const result = await recoverSessionHistoryGap({ sessionId: "s1", after: 10, eventEpoch: 3, recoveryRevision: 7 }, {
      history: {
        fetchPage: async (_id, after) => {
          afters.push(after);
          if (afters.length === pauseAt) paused = true;
          assert.ok(afters.length <= 4, "a paused reader must not drain the entire missing interval");
          return { events: [event(after + 1)], eventEpoch: 3, nextAfter: after + 1,
            hasMoreCached: true, cacheComplete: true };
        },
        applyPage: (_id, rows) => applied.push(...rows.map(row => row.seq)), isCurrent: () => true,
      },
      window: {
        fetchTailPage: async () => {
          tails++;
          if (pauseAt === 5) paused = true;
          return { events: [event(tailSeq)], eventEpoch: 3, hasMoreOlder: true, cacheComplete: true };
        },
        applyWindow: () => { throw new Error("paused reading rows must not be replaced"); }, isCurrent: () => true,
      },
      canReplaceWithWindow: () => !paused,
      deferWindow: (_id, rows, epoch, revision, complete, hasOlder) => {
        assert.deepEqual(rows.map(row => row.seq), [tailSeq]);
        assert.equal(epoch, 3); assert.equal(revision, 7); assert.equal(complete, true); assert.equal(hasOlder, true);
        staged++; return true;
      },
    });
    assert.equal(result, true);
    assert.deepEqual(afters, [10, 11, 12, 13]);
    assert.deepEqual(applied, [11, 12, 13, 14]);
    assert.equal(tails, 1); assert.equal(staged, 1);
  });
}

test("refused deferred staging stays incomplete without an unlimited paused fallback", async () => {
  let calls = 0;
  assert.equal(await recoverSessionHistoryGap({ sessionId: "s1", after: 10, eventEpoch: 3, recoveryRevision: 7 }, {
    history: { fetchPage: async (_id, after) => {
      assert.ok(++calls <= 4);
      return { events: [event(after + 1)], eventEpoch: 3, nextAfter: after + 1, hasMoreCached: true, cacheComplete: true };
    }, applyPage: () => {}, isCurrent: () => true },
    window: { fetchTailPage: async () => ({ events: [event(1000)], eventEpoch: 3, hasMoreOlder: true, cacheComplete: true }),
      applyWindow: () => { throw new Error("not following"); }, isCurrent: () => true },
    canReplaceWithWindow: () => false, deferWindow: () => false,
  }), false);
  assert.equal(calls, 4);
});

test("a deferred paused reader retains the explicit forward fallback on older control planes", async () => {
  const afters: number[] = [];
  let tails = 0;
  assert.equal(await recoverSessionHistoryGap({ sessionId: "s1", after: 10, eventEpoch: 3, recoveryRevision: 7 }, {
    history: { fetchPage: async (_id, after) => {
      afters.push(after);
      return { events: [event(after + 1)], eventEpoch: 3, nextAfter: after + 1,
        hasMoreCached: after < 15, cacheComplete: true };
    }, applyPage: () => {}, isCurrent: () => true },
    window: { fetchTailPage: async () => { tails++; return { events: [event(1)] }; },
      applyWindow: () => { throw new Error("legacy prefix must not replace a paused window"); }, isCurrent: () => true },
    canReplaceWithWindow: () => false, deferWindow: () => { throw new Error("unsupported tail must not stage"); },
  }), true);
  assert.deepEqual(afters, [10, 11, 12, 13, 14, 15]);
  assert.equal(tails, 1);
});

test("a cancelled deferred tail never calls its owner", async () => {
  let current = true;
  assert.equal(await recoverSessionHistoryGap({ sessionId: "s1", after: 10, eventEpoch: 3, recoveryRevision: 7 }, {
    history: { fetchPage: async (_id, after) => ({ events: [event(after + 1)], eventEpoch: 3,
      nextAfter: after + 1, hasMoreCached: true, cacheComplete: true }), applyPage: () => {}, isCurrent: () => current },
    window: { fetchTailPage: async () => {
      current = false; return { events: [event(1_000_000)], eventEpoch: 3, hasMoreOlder: true, cacheComplete: true };
    }, applyWindow: () => { throw new Error("cancelled replacement"); }, isCurrent: () => current },
    canReplaceWithWindow: () => false, deferWindow: () => { throw new Error("cancelled stage"); },
  }), false);
});
