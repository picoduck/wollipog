import assert from "node:assert/strict";
import test from "node:test";
import type { PullRequestWatchView, SessionView, SessionWaitView } from "@wollipog/protocol";
import { sessionRowStatus } from "./session-row-status.js";
import { sessionWaitConditions } from "./session-wait-status.js";
import { sessionStatusSummary } from "./status-meta.js";

const MINUTE = 60_000;
const session = (extra: Partial<SessionView> = {}): SessionView =>
  ({ id: "parent", status: "running", pendingApproval: null, role: "orchestrator", ...extra }) as unknown as SessionView;

const childWait = (extra: Partial<SessionWaitView> = {}): SessionWaitView => ({
  waitId: "wait_children01", kind: "wait_session", target: { kind: "session", child: true },
  since: 0, deadlineAt: 60 * MINUTE, health: "healthy", ...extra,
});
const prWait = (extra: Partial<SessionWaitView> = {}): SessionWaitView => ({
  waitId: "wait_pullreq01", kind: "wait_pull_request", target: { kind: "pull_request", repository: "picoduck/wollipog", number: 1280 },
  since: 0, deadlineAt: 180 * MINUTE, health: "healthy", ...extra,
});
const watch = (extra: Partial<PullRequestWatchView> = {}): PullRequestWatchView => ({
  watchId: "prw_1", repository: "picoduck/wollipog", number: 1280, headSha: "a".repeat(40),
  state: "watching", since: 0, continuation: "none", ...extra,
});

/** What every surface shows: the header's summary, and a list row's or Board card's badges. */
function surfaces(view: SessionView) {
  const summary = sessionStatusSummary(view);
  const row = sessionRowStatus(view);
  return {
    header: [summary.primary.meta.label, summary.secondary?.meta.label ?? null],
    row: [row.lifecycle.meta.label, row.badge?.meta.label ?? null],
    rowAria: row.badge?.ariaLabel ?? null,
    more: summary.more,
    others: row.others.length,
    needsYou: summary.conditions.some((condition) => condition.kind === "session_wait" && condition.needsYou),
  };
}

test("a running Orchestrator in a healthy wait_session reads Running and Waiting on Children everywhere, never Stalled (#1280)", () => {
  // Fifty-nine minutes into an hour-long wait, with no transcript event since it started.
  const shown = surfaces(session({ waits: [childWait({ since: 0 })], lastActivityAt: 0 } as Partial<SessionView>));
  assert.deepEqual(shown.header, ["Running", "Waiting on Children"]);
  assert.deepEqual(shown.row, shown.header, "list rows and Board cards agree with the detail header");
  assert.equal(shown.rowAria, "Status: Waiting on Children", "the accessible name matches the visible label");
  assert.equal(shown.more, 0);
  assert.equal(shown.others, 0);
  assert.equal(shown.needsYou, false, "a wait adds to no attention count");
  const description = sessionWaitConditions(session({ waits: [childWait()] }))[0]!.description;
  assert.match(description, /deliberately waiting on a child session/u);
});

test("each wait kind has its own Title Case label", () => {
  assert.equal(surfaces(session({ waits: [childWait({ target: { kind: "session", child: false } })] })).header[1], "Waiting on Session");
  assert.equal(surfaces(session({ role: "worker", waits: [prWait()] } as Partial<SessionView>)).header[1], "Waiting on Pull Request");
});

test("a broken liveness contract reads Wait Stalled and names the part that broke", () => {
  const cases: Array<[NonNullable<SessionWaitView["stalledReason"]>, RegExp]> = [
    ["progress_lost", /stopped making progress/u],
    ["target_missing", /no longer exists/u],
    ["target_reached", /already reached a state it waits for/u],
    ["deadline_passed", /past its own timeout/u],
  ];
  for (const [reason, sentence] of cases) {
    const view = session({ waits: [childWait({ health: "stalled", stalledReason: reason, stalledSince: 1 })] });
    const shown = surfaces(view);
    assert.deepEqual(shown.header, ["Running", "Wait Stalled"], reason);
    assert.deepEqual(shown.row, shown.header, reason);
    assert.equal(shown.more, 0, "a stalled wait is a warning, not a request");
    const condition = sessionStatusSummary(view).conditions.find((candidate) => candidate.meta.label === "Wait Stalled")!;
    assert.equal(condition.meta.tone, "warning");
    assert.match(condition.description, sentence, reason);
  }
});

test("one healthy wait cannot hide another that is stuck", () => {
  const view = session({ waits: [prWait(), childWait({ health: "stalled", stalledReason: "progress_lost", stalledSince: 1 })] });
  const summary = sessionStatusSummary(view);
  assert.equal(summary.secondary?.meta.label, "Wait Stalled");
  assert.deepEqual(summary.conditions.filter((condition) => condition.kind === "session_wait").map((condition) => condition.meta.label),
    ["Wait Stalled", "Waiting on Pull Request"], "both waits stay in the popover");
  assert.match(summary.secondary!.description, /1 other wait is still making progress/u);
});

test("a wait outside a turn, or no wait at all, shows the lifecycle as before", () => {
  for (const status of ["idle", "completed", "failed", "stopped"] as const) {
    assert.equal(sessionWaitConditions(session({ status, waits: [childWait()] })).length, 0, status);
  }
  // An older control plane sends no waits: the session reads exactly as it did.
  assert.deepEqual(surfaces(session()).header, ["Running", null]);
  assert.deepEqual(surfaces(session({ waits: [] })).header, ["Running", null]);
});

test("a healthy wait outranks background work, but not a request", () => {
  const busy = session({ waits: [childWait()], backgroundWorkState: "running" });
  assert.equal(sessionStatusSummary(busy).secondary?.meta.label, "Waiting on Children");
  assert.ok(sessionStatusSummary(busy).conditions.some((condition) => condition.meta.label === "Waiting on External Job"));
  const question = { requestId: "q", kind: "question" as const, title: "Choose", options: [] };
  const asking = session({ status: "input_required", waits: [childWait()], pendingApproval: question,
    attention: { version: 1, humanActions: [{ requestId: "q", rank: 3, requestedAt: 1 }], meaningfulAt: 1, result: null } } as Partial<SessionView>);
  assert.equal(sessionRowStatus(asking).badge?.meta.label, "Answer Required");
});

test("a parked merge-queue watch reads Waiting on Merge Queue, then its wake or loss (#4071)", () => {
  const parked = surfaces(session({ status: "idle", role: "worker", pullRequestWatch: watch() } as Partial<SessionView>));
  assert.deepEqual(parked.header, ["Awaiting Prompt", "Waiting on Merge Queue"]);
  assert.deepEqual(parked.row, parked.header);
  const pending = surfaces(session({ status: "idle", pullRequestWatch: watch({ state: "fired", outcome: "merged", continuation: "held" }) }));
  assert.deepEqual(pending.header, ["Awaiting Prompt", "Merge Queue Wake Pending"]);
  const lostView = session({ status: "idle", pullRequestWatch: watch({ state: "lost", reason: "the runner could not read GitHub" }) });
  const lost = surfaces(lostView);
  assert.deepEqual(lost.header, ["Awaiting Prompt", "Merge Queue Watch Lost"]);
  assert.equal(lost.more, 0);
  assert.equal(sessionWaitConditions(lostView)[0]!.description,
    "Wollipog stopped watching pull request picoduck/wollipog#1280 in the merge queue: the runner could not read GitHub.");
  assert.equal(surfaces(session({ status: "idle", pullRequestWatch: watch({ state: "fired", continuation: "delivered" }) })).header[1], null);
  assert.equal(surfaces(session({ status: "idle", pullRequestWatch: watch({ state: "cancelled" }) })).header[1], null);
  assert.equal(sessionWaitConditions(session({ status: "completed", pullRequestWatch: watch() })).length, 0);
});

test("a parent whose children are working still shows its own deliberate wait", () => {
  const row = sessionRowStatus(session({ status: "idle", pullRequestWatch: watch() }), { familyWorking: true });
  assert.equal(row.badge?.meta.label, "Waiting on Merge Queue");
});
