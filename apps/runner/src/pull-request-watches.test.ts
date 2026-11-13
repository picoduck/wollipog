import assert from "node:assert/strict";
import { test } from "node:test";
import { PULL_REQUEST_WATCH_SUMMARY_LIMIT_BYTES, type PullRequestWatchUpdate } from "@wollipog/protocol";
import type { PullRequestWaitInput, PullRequestWaitResult, PullRequestWaitSummary } from "./pull-request-wait.js";
import { PULL_REQUEST_WATCH_MAX_FAILURES, PullRequestWatcher, serializedWatchSummary } from "./pull-request-watches.js";

const HEAD = "c".repeat(40);
const START = { type: "pull_request_watch_start" as const, watchId: "prw_1", sessionId: "s1",
  repository: "picoduck/wollipog", number: 4071, headSha: HEAD };

test("queue progress signals failed jobs and the duration bound, clearing on rebuild (#4543)", async () => {
  let clock = 1_000;
  const updates: PullRequestWatchUpdate[] = [];
  const group = (sha: string, failed = false) => summary("timeout", { mergeQueue: { state: "AWAITING_CHECKS", position: 1,
    enqueuedAt: null, checks: { sha, required: [{ name: "aggregator", state: "pending", reported: false }],
      other: { passed: 0, failed: failed ? 1 : 0, pending: 0 },
      failedJobs: failed ? [{ name: "unit tests", required: false, conclusion: "FAILURE" }] : [] } } });
  const watcher = new PullRequestWatcher({ gh: async () => { throw Error("unused"); }, now: () => clock,
    send: u => updates.push(u), wait: async (_, deps) => {
      deps.onSnapshot!(group(HEAD, true));
      deps.onSnapshot!(group("d".repeat(40)));
      clock += 60 * 60_000;
      deps.onSnapshot!(group("d".repeat(40)));
      deps.onSnapshot!(group("e".repeat(40)));
      return { ok: true, summary: summary("merged") };
    } });
  watcher.start(START);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates.filter(u => u.state === "progress").map(u => u.progress!.stalled), [true, false, true, false]);
  assert.deepEqual(updates.filter(u => u.state !== "progress").map(u => u.outcome), ["merged"]);
});

function summary(outcome: PullRequestWaitSummary["outcome"], extra: Partial<PullRequestWaitSummary> = {}): PullRequestWaitSummary {
  return {
    outcome, repository: "picoduck/wollipog", number: 4071, url: "https://github.com/picoduck/wollipog/pull/4071",
    state: outcome === "merged" ? "merged" : "open", merged: outcome === "merged", mergeCommitSha: null, isDraft: false,
    headSha: HEAD, baseRef: "main", defaultBranch: "main", mergeStateStatus: "CLEAN", requiredCheckNames: ["required"],
    checks: { sha: HEAD, required: [], other: { passed: 0, failed: 0, pending: 0 }, failedJobs: [] },
    mergeQueue: { state: "QUEUED", position: 4, enqueuedAt: null, checks: null }, mergeQueueRemoval: null,
    waitedMs: 1, polls: 1, ...extra,
  };
}

/** A watcher whose waits return the scripted results in order, then block until cancelled. */
function scripted(results: PullRequestWaitResult[]) {
  const updates: PullRequestWatchUpdate[] = [];
  const inputs: PullRequestWaitInput[] = [];
  const sleeps: number[] = [];
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const watcher = new PullRequestWatcher({
    gh: async () => { throw new Error("the scripted wait never reads GitHub"); },
    send: (update) => { updates.push(update); if (update.state !== "progress") settle(); },
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
    wait: async (input, deps) => {
      inputs.push(input);
      const next = results.shift();
      if (next) return next;
      settle();
      await new Promise<void>((resolve) => deps.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, error: "request cancelled" };
    },
  });
  return { watcher, updates, inputs, sleeps, settled };
}

test("a watch keeps waiting through timeouts and reports its first outcome once, with the bounded summary", async () => {
  const h = scripted([
    { ok: true, summary: summary("timeout") },
    { ok: true, summary: summary("timeout") },
    { ok: true, summary: summary("merged", { mergeCommitSha: "d".repeat(40), mergeQueue: null }) },
  ]);
  h.watcher.start(START);
  h.watcher.start(START);
  await h.settled;
  assert.equal(h.inputs.length, 3, "a duplicate start does not watch twice; timeouts only re-arm the wait");
  assert.deepEqual(h.inputs.map((input) => input.headSha), [HEAD, HEAD, HEAD], "every wait pins the parked head");
  assert.equal(h.updates.filter(u => u.state === "progress").length, 2);
  const terminal = h.updates.filter(u => u.state !== "progress");
  assert.equal(terminal.length, 1);
  const [update] = terminal;
  assert.equal(update!.state, "fired");
  assert.equal(update!.outcome, "merged");
  assert.equal(JSON.parse(update!.summary!).mergeCommitSha, "d".repeat(40));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.watcher.watching(), []);
  // A control plane that missed the report resends the start (a reconnect): it gets the same answer,
  // without another read.
  h.watcher.start(START);
  assert.equal(h.inputs.length, 3);
  assert.deepEqual(h.updates.slice(3), [update]);
});

test("every outcome but a timeout ends the watch, including a pull request that is not queued", async () => {
  for (const outcome of ["closed", "queue_failed", "queue_ejected", "head_changed", "checks_passed", "checks_failed", "no_required_checks"] as const) {
    const h = scripted([{ ok: true, summary: summary(outcome) }]);
    h.watcher.start({ ...START, watchId: `prw_${outcome}` });
    await h.settled;
    assert.deepEqual(h.updates.map((update) => [update.state, update.outcome]), [["fired", outcome]]);
  }
});

test("an unreadable pull request is retried, then reported lost rather than left silent", async () => {
  const failures = Array.from({ length: PULL_REQUEST_WATCH_MAX_FAILURES },
    (): PullRequestWaitResult => ({ ok: false, error: "could not read picoduck/wollipog#4071: HTTP 502" }));
  const h = scripted(failures);
  h.watcher.start(START);
  await h.settled;
  assert.equal(h.inputs.length, PULL_REQUEST_WATCH_MAX_FAILURES);
  assert.equal(h.sleeps.length, PULL_REQUEST_WATCH_MAX_FAILURES - 1, "it pauses between attempts");
  assert.equal(h.updates.length, 1);
  assert.equal(h.updates[0]!.state, "lost");
  assert.match(h.updates[0]!.reason!, /^GitHub could not be read: .*HTTP 502/u);
});

test("a success between failures resets the retry budget", async () => {
  const bad: PullRequestWaitResult = { ok: false, error: "transport" };
  const h = scripted([bad, bad, { ok: true, summary: summary("timeout") }, ...Array(PULL_REQUEST_WATCH_MAX_FAILURES - 1).fill(bad),
    { ok: true, summary: summary("queue_ejected") }]);
  h.watcher.start(START);
  await h.settled;
  assert.deepEqual(h.updates.filter(u => u.state !== "progress").map((update) => update.state), ["fired"]);
});

test("a cancelled watch stops polling and reports nothing", async () => {
  const h = scripted([]);
  h.watcher.start(START);
  await h.settled;
  assert.deepEqual(h.watcher.watching(), ["prw_1"]);
  h.watcher.cancel("prw_1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.watcher.watching(), []);
  assert.deepEqual(h.updates, []);
});

test("a serialized summary stays within the protocol's bound", () => {
  const long = "x".repeat(4_000);
  const huge = summary("queue_ejected", {
    requiredCheckNames: Array.from({ length: 20 }, () => long),
    checks: { sha: HEAD, required: Array.from({ length: 20 }, () => ({ name: long, state: "pending" as const, reported: false })),
      other: { passed: 0, failed: 0, pending: 0 }, failedJobs: [] },
  });
  const text = serializedWatchSummary(huge);
  assert.ok(Buffer.byteLength(text) <= PULL_REQUEST_WATCH_SUMMARY_LIMIT_BYTES);
  const parsed = JSON.parse(text);
  assert.equal(parsed.outcome, "queue_ejected");
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.headSha, HEAD);
  const small = serializedWatchSummary(summary("merged"));
  assert.deepEqual(JSON.parse(small), summary("merged"));
});

test("an oversized stall summary preserves group failures and unstarted required jobs (#4543)", () => {
  const long = "x".repeat(120);
  const group = { sha: HEAD, required: [{ name: "Typecheck, Test & Sidecar Bundle", state: "pending" as const, reported: false }],
    other: { passed: 0, failed: 1, pending: 0 },
    failedJobs: [{ name: "Unit Tests (2)", required: false, conclusion: "FAILURE", url: "https://example.com/job" }] };
  const oversized = summary("timeout", { requiredCheckNames: Array.from({length: 300}, () => long),
    mergeQueue: { state: "AWAITING_CHECKS", position: 1, enqueuedAt: null, checks: group } });
  const encoded = serializedWatchSummary(oversized);
  assert.ok(Buffer.byteLength(encoded) <= PULL_REQUEST_WATCH_SUMMARY_LIMIT_BYTES);
  const decoded = JSON.parse(encoded);
  assert.equal(decoded.mergeQueue.position, 1);
  assert.equal(decoded.mergeQueue.state, "AWAITING_CHECKS");
  assert.deepEqual(decoded.mergeQueue.checks.required, group.required);
  assert.deepEqual(decoded.mergeQueue.checks.failedJobs,
    [{ name: "Unit Tests (2)", required: false, conclusion: "FAILURE" }]);
  // Maximum forge list sizes and multibyte names still fit the wire limit after compaction.
  const worst = { ...group, required: Array.from({length:30}, () => ({ ...group.required[0]!, name: "漢".repeat(120) })),
    failedJobs: Array.from({length:20}, () => ({ ...group.failedJobs[0]!, name: "漢".repeat(120) })) };
  const compact = serializedWatchSummary({ ...oversized, mergeQueue: { ...oversized.mergeQueue!, checks: worst } });
  assert.ok(Buffer.byteLength(compact) <= PULL_REQUEST_WATCH_SUMMARY_LIMIT_BYTES);
});
