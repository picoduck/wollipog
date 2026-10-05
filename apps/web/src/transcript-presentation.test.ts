import assert from "node:assert/strict";
import { test } from "node:test";
import type { EventHistoryState } from "./store.js";
import { transcriptPresentation } from "./transcript-presentation.js";

const history = (overrides: Partial<EventHistoryState> = {}): EventHistoryState => ({
  eventEpoch: 0,
  recoveryGeneration: 1,
  recoveryRevision: 1,
  everComplete: false,
  refreshing: false,
  error: null,
  ...overrides,
});

test("an incomplete empty cache renders a skeleton, never an empty transcript", () => {
  assert.equal(transcriptPresentation({ itemCount: 0, hasOptimistic: false, working: false, history: history({ refreshing: true }), conn: "online" }).body, "skeleton");
  assert.equal(transcriptPresentation({ itemCount: 0, hasOptimistic: false, working: false, history: undefined, conn: "connecting" }).body, "skeleton");
});

test("only completed recovery makes an empty transcript authoritative", () => {
  const result = transcriptPresentation({ itemCount: 0, hasOptimistic: false, working: false, history: history({ everComplete: true, refreshing: true }), conn: "online" });
  assert.equal(result.body, "empty");
  assert.equal(result.notice, "refreshing");
  assert.equal(result.busy, true);
});

test("cached content remains visible through refresh, failure, and disconnect", () => {
  assert.deepEqual(
    transcriptPresentation({ itemCount: 2, hasOptimistic: false, working: false, history: history({ everComplete: true, refreshing: true }), conn: "online" }),
    { body: "timeline", busy: true, notice: "refreshing", error: null },
  );
  assert.equal(transcriptPresentation({ itemCount: 2, hasOptimistic: false, working: false, history: history({ everComplete: true, error: "failed" }), conn: "online" }).body, "timeline");
  assert.equal(transcriptPresentation({ itemCount: 2, hasOptimistic: false, working: false, history: history({ everComplete: true }), conn: "offline" }).notice, "stale");
});

test("first-load failure and disconnect render an unavailable state", () => {
  const failed = transcriptPresentation({ itemCount: 0, hasOptimistic: false, working: false, history: history({ error: "failed" }), conn: "online" });
  assert.deepEqual([failed.body, failed.notice, failed.error], ["unavailable", "error", "failed"]);
  const disconnected = transcriptPresentation({ itemCount: 0, hasOptimistic: false, working: false, history: undefined, conn: "unauthorized" });
  assert.deepEqual([disconnected.body, disconnected.notice, disconnected.error], ["unavailable", null, null]);
});

test("disconnect cancels busy/retrying copy while honestly labeling cached content stale", () => {
  const cached = transcriptPresentation({
    itemCount: 2,
    hasOptimistic: false,
    working: false,
    history: history({ everComplete: true, refreshing: true, error: "failed" }),
    conn: "offline",
  });
  assert.deepEqual([cached.body, cached.busy, cached.notice], ["timeline", false, "stale"]);
});
