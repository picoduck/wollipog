import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { SessionStatus } from "@wollipog/protocol";
import {
  deriveCampaignWorkItemState,
  deriveCampaignWorkItemStates,
  type CampaignAttemptSessionObservation,
  type CampaignWorkItemStateRecord,
} from "./campaign-work-state.js";

const SESSION: CampaignAttemptSessionObservation = { status: "running", archived: false, held: false, pendingRequests: 0 };

function item(overrides: Partial<CampaignWorkItemStateRecord> = {}): CampaignWorkItemStateRecord {
  return {
    id: "a", commitment: "committed", dispatchState: "planned", hasBlocker: false, dependsOn: [],
    latestAttempt: null, openAttemptSession: null, ...overrides,
  };
}

function open(session: Partial<CampaignAttemptSessionObservation> | null = {}): Partial<CampaignWorkItemStateRecord> {
  return {
    latestAttempt: { open: true, delivered: false },
    openAttemptSession: session === null ? null : { ...SESSION, ...session },
  };
}

test("commitment wins over every other fact", () => {
  for (const extra of [{}, open({ status: "running" }), { latestAttempt: { open: false, delivered: true } }]) {
    assert.equal(deriveCampaignWorkItemState(item({ commitment: "cancelled", ...extra }), []).state, "cancelled");
    assert.equal(deriveCampaignWorkItemState(item({ commitment: "scope_removed", ...extra }), []).state, "removed");
  }
});

test("delivered requires a delivered verification on the latest attempt", () => {
  assert.equal(deriveCampaignWorkItemState(item({ latestAttempt: { open: false, delivered: true } }), []).state,
    "delivered");
  // A closed, unverified attempt (reassigned, superseded, abandoned, failed) leaves the item undispatched.
  assert.equal(deriveCampaignWorkItemState(item({ latestAttempt: { open: false, delivered: false } }), []).state,
    "planned");
});

test("an idle or completed child awaits verification rather than counting as delivered", () => {
  for (const status of ["idle", "completed"] as const) {
    assert.deepEqual(deriveCampaignWorkItemState(item(open({ status })), []),
      { state: "waiting", causes: ["attempt_awaiting_verification"] });
  }
});

test("open attempts map observed session status to running, waiting, or blocked", () => {
  const cases: Array<[Partial<CampaignAttemptSessionObservation> | null, string, string?]> = [
    [{ status: "running" }, "running"],
    [{ status: "starting" }, "running"],
    [{ status: "queued" }, "running"],
    [{ status: "input_required" }, "waiting", "attempt_session_input_required"],
    [{ status: "running", pendingRequests: 1 }, "waiting", "attempt_session_pending_decision"],
    [{ status: "running", held: true }, "blocked", "attempt_session_held"],
    [{ status: "failed" }, "blocked", "attempt_session_failed"],
    [{ status: "stopped" }, "blocked", "attempt_session_stopped"],
    [{ status: "idle", archived: true }, "blocked", "attempt_session_archived"],
    [{ status: "completed", archived: true }, "blocked", "attempt_session_archived"],
    [{ status: "stopped", archived: true }, "blocked", "attempt_session_stopped"],
    [null, "blocked", "attempt_session_unavailable"],
  ];
  for (const [session, state, cause] of cases) {
    const derived = deriveCampaignWorkItemState(item(open(session)), []);
    assert.equal(derived.state, state, JSON.stringify(session));
    assert.deepEqual(derived.causes, cause ? [cause] : []);
  }
  assert.deepEqual(deriveCampaignWorkItemState(item({ ...open(), hasBlocker: true }), []),
    { state: "blocked", causes: ["recorded_blocker"] });
});

test("undispatched items follow the recorded dispatch state and dependencies", () => {
  assert.equal(deriveCampaignWorkItemState(item(), []).state, "planned");
  assert.equal(deriveCampaignWorkItemState(item({ dispatchState: "queued" }), []).state, "queued");
  assert.deepEqual(deriveCampaignWorkItemState(item({ dispatchState: "queued" }), ["running"]),
    { state: "queued", causes: ["dependency_unfinished"] }, "an unfinished dependency is a wait, not a block");
  assert.deepEqual(deriveCampaignWorkItemState(item({ dispatchState: "queued" }), ["delivered", "cancelled"]),
    { state: "blocked", causes: ["dependency_blocked"] });
  assert.equal(deriveCampaignWorkItemState(item(), ["blocked"]).state, "blocked");
  assert.equal(deriveCampaignWorkItemState(item(), ["unresolvable"]).state, "blocked");
  assert.equal(deriveCampaignWorkItemState(item({ dispatchState: "queued" }), ["delivered"]).state, "queued");
  assert.deepEqual(deriveCampaignWorkItemState(item({ hasBlocker: true }), []),
    { state: "blocked", causes: ["recorded_blocker"] });
});

test("campaign derivation resolves dependency chains and blocks cycles and missing items", () => {
  const states = deriveCampaignWorkItemStates([
    item({ id: "c", dependsOn: ["b"], dispatchState: "queued" }),
    item({ id: "b", dependsOn: ["a"], dispatchState: "queued" }),
    item({ id: "a", ...open({ status: "failed" }) }),
    item({ id: "x", dependsOn: ["y"] }),
    item({ id: "y", dependsOn: ["x"] }),
    item({ id: "m", dependsOn: ["missing"] }),
    item({ id: "d", dependsOn: ["e"], dispatchState: "queued" }),
    item({ id: "e", latestAttempt: { open: false, delivered: true } }),
  ]);
  assert.equal(states.get("a")?.state, "blocked");
  assert.equal(states.get("b")?.state, "blocked", "a blocked dependency propagates");
  assert.equal(states.get("c")?.state, "blocked");
  assert.equal(states.get("x")?.state, "blocked");
  assert.equal(states.get("y")?.state, "blocked");
  assert.equal(states.get("m")?.state, "blocked");
  assert.equal(states.get("d")?.state, "queued");
  assert.equal(states.size, 8);
});

const sessionStatus = fc.constantFrom<SessionStatus>(
  "queued", "starting", "running", "input_required", "idle", "completed", "failed", "stopped");
const recordArbitrary = fc.record({
  id: fc.constant("a"),
  commitment: fc.constantFrom("committed" as const, "cancelled" as const, "scope_removed" as const),
  dispatchState: fc.constantFrom("planned" as const, "queued" as const),
  hasBlocker: fc.boolean(),
  dependsOn: fc.constant([] as string[]),
  latestAttempt: fc.option(fc.record({ open: fc.boolean(), delivered: fc.boolean() }), { nil: null })
    // A delivered verification closes its attempt, so an open delivered attempt cannot exist.
    .map((attempt) => attempt && attempt.open ? { open: true, delivered: false } : attempt),
  openAttemptSession: fc.option(fc.record({
    status: sessionStatus, archived: fc.boolean(), held: fc.boolean(), pendingRequests: fc.nat(3),
  }), { nil: null }),
});
const dependencyStates = fc.array(fc.constantFrom(
  "planned", "queued", "running", "waiting", "blocked", "delivered", "cancelled", "removed", "unresolvable",
) as fc.Arbitrary<never>, { maxLength: 4 });

test("property: only a delivered verification on a committed item yields delivered", () => {
  fc.assert(fc.property(recordArbitrary, dependencyStates, (record, dependencies) => {
    const { state } = deriveCampaignWorkItemState(record, dependencies);
    assert.equal(state === "delivered",
      record.commitment === "committed" && record.latestAttempt?.delivered === true);
    // Idleness, issue closure, reported stages, and merge enqueueing are not inputs at all, so no
    // session observation can make an unverified item delivered.
    if (record.commitment === "cancelled") assert.equal(state, "cancelled");
    if (record.commitment === "scope_removed") assert.equal(state, "removed");
  }));
});

test("property: every committed, undelivered item is unfinished", () => {
  fc.assert(fc.property(recordArbitrary, dependencyStates, (record, dependencies) => {
    const { state } = deriveCampaignWorkItemState(record, dependencies);
    if (record.commitment === "committed" && !record.latestAttempt?.delivered) {
      assert.ok(["planned", "queued", "running", "waiting", "blocked"].includes(state), state);
    }
  }));
});
