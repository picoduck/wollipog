import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  SESSION_WAIT_DEADLINE_GRACE_MS, SESSION_WAIT_LIMIT_PER_SESSION, SESSION_WAIT_TARGET_GRACE_MS,
  sessionWaitProgressBoundMs,
  type RunnerMetadata, type SessionStatus, type SessionWaitReport,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { parseSessionWaitReport, SessionWaits } from "./session-waits.js";
import { SessionsService } from "./sessions.js";

const MINUTE = 60_000;
const ONE_HOUR = 60 * MINUTE;

function childWait(overrides: Partial<SessionWaitReport> = {}): SessionWaitReport {
  return {
    waitId: "wait_children01", kind: "wait_session", state: "active",
    target: { kind: "session", sessionId: "child", states: ["idle", "completed", "failed", "stopped"] },
    elapsedMs: 15_000, remainingMs: ONE_HOUR - 15_000, intervalMs: 10_000, ...overrides,
  };
}

function prWait(overrides: Partial<SessionWaitReport> = {}): SessionWaitReport {
  return {
    waitId: "wait_pullreq01", kind: "wait_pull_request", state: "active",
    target: { kind: "pull_request", repository: "picoduck/wollipog", number: 1280 },
    elapsedMs: 15_000, remainingMs: 3 * ONE_HOUR, intervalMs: 30_000, ...overrides,
  };
}

/** A registry whose watched sessions' statuses the test sets. */
function registry(statuses: Record<string, SessionStatus | null> = { child: "running" }) {
  const waits = new SessionWaits((id) => statuses[id] ?? null);
  return { waits, statuses };
}

test("a wait_session on running children stays healthy for its whole hour while polls keep coming (#1280)", () => {
  const { waits } = registry();
  let now = 1_000_000;
  assert.deepEqual(waits.report("parent", childWait(), now, () => true), { changed: true });
  // Far past the old ten-minute silence threshold, with a successful poll reported every 15 seconds.
  for (let at = 15_000; at <= 59 * MINUTE; at += 15_000) {
    now = 1_000_000 + at;
    assert.equal(waits.sweep(now).length, 0, `no change at ${at} ms`);
    waits.report("parent", childWait({ elapsedMs: 15_000 + at, remainingMs: ONE_HOUR - 15_000 - at }), now, () => true);
  }
  const [view] = waits.views("parent")!;
  assert.equal(view!.health, "healthy");
  assert.deepEqual(view!.target, { kind: "session", child: true }, "the watched session is never named");
  assert.equal(view!.since, 1_000_000 - 15_000, "since is the control plane's receipt time minus the reported elapsed time");
  assert.equal(view!.deadlineAt, 1_000_000 + ONE_HOUR - 15_000);
  assert.equal(view!.stalledReason, undefined);
});

test("a wait whose polls stop becomes Stalled with progress_lost after its progress bound, and recovers", () => {
  const { waits } = registry();
  const start = 1_000_000;
  waits.report("parent", childWait(), start, () => true);
  const bound = sessionWaitProgressBoundMs(10_000);
  assert.equal(bound, 75_000);
  assert.deepEqual(waits.sweep(start + bound), [], "exactly at the bound the contract still holds");
  assert.deepEqual(waits.sweep(start + bound + 1), ["parent"]);
  const [stalled] = waits.views("parent")!;
  assert.equal(stalled!.health, "stalled");
  assert.equal(stalled!.stalledReason, "progress_lost");
  assert.equal(stalled!.stalledSince, start + bound + 1);
  // A poll that succeeds again restores the contract.
  assert.deepEqual(waits.report("parent", childWait(), start + bound + 5_000, () => true), { changed: true });
  assert.equal(waits.views("parent")![0]!.health, "healthy");
  assert.equal(waits.views("parent")![0]!.stalledSince, undefined);
});

test("the progress bound follows the call's own polling interval: a 10-minute PR poll is not lost after 2 minutes", () => {
  const { waits } = registry();
  const start = 0;
  waits.report("s", prWait({ intervalMs: 600_000 }), start, () => false);
  assert.deepEqual(waits.sweep(start + 20 * MINUTE), []);
  assert.equal(waits.views("s")![0]!.health, "healthy");
  assert.deepEqual(waits.sweep(start + sessionWaitProgressBoundMs(600_000) + 1), ["s"]);
  assert.equal(waits.views("s")![0]!.stalledReason, "progress_lost");
});

test("an inconsistent target breaks the contract: a missing session, or one sitting in a requested state", () => {
  const { waits, statuses } = registry({ child: "running" });
  const start = 0;
  waits.report("parent", childWait(), start, () => true);
  // The child reached a requested state: a working poll returns within one interval, so only a wait
  // that is still reported running past the grace is inconsistent.
  statuses.child = "idle";
  assert.deepEqual(waits.sweep(start + 5_000), []);
  waits.report("parent", childWait(), start + 15_000, () => true);
  assert.equal(waits.views("parent")![0]!.health, "healthy");
  assert.deepEqual(waits.sweep(start + 5_000 + SESSION_WAIT_TARGET_GRACE_MS + 1), ["parent"]);
  assert.equal(waits.views("parent")![0]!.stalledReason, "target_reached");
  // Running again resets the grace.
  statuses.child = "running";
  waits.report("parent", childWait(), start + 40_000, () => true);
  assert.equal(waits.views("parent")![0]!.health, "healthy");
  statuses.child = null;
  assert.deepEqual(waits.sweep(start + 45_000), ["parent"]);
  assert.equal(waits.views("parent")![0]!.stalledReason, "target_missing");
});

test("a wait still reported past its own timeout plus grace is Stalled with deadline_passed, and cannot extend it", () => {
  const { waits } = registry();
  const start = 0;
  waits.report("s", prWait({ remainingMs: 4 * MINUTE }), start, () => false);
  // A later report claiming more time does not move the deadline.
  waits.report("s", prWait({ remainingMs: ONE_HOUR }), start + 30_000, () => false);
  assert.equal(waits.views("s")![0]!.deadlineAt, start + 4 * MINUTE);
  const late = start + 4 * MINUTE + SESSION_WAIT_DEADLINE_GRACE_MS + 1;
  waits.report("s", prWait(), late - 1_000, () => false);
  assert.deepEqual(waits.sweep(late), ["s"]);
  assert.equal(waits.views("s")![0]!.stalledReason, "deadline_passed");
});

test("concurrent waits are classified independently, and an ended wait is removed at once", () => {
  const { waits } = registry();
  const start = 0;
  waits.report("s", childWait(), start, () => true);
  waits.report("s", prWait(), start, () => false);
  // Only the PR wait keeps polling.
  for (let at = 15_000; at <= 120_000; at += 15_000) waits.report("s", prWait(), start + at, () => false);
  assert.deepEqual(waits.sweep(start + 120_000), ["s"]);
  const views = waits.views("s")!;
  assert.deepEqual(views.map((view) => [view.kind, view.health]), [["wait_session", "stalled"], ["wait_pull_request", "healthy"]]);
  assert.deepEqual(waits.report("s", { ...childWait(), state: "ended" }, start + 121_000, () => true), { changed: true });
  assert.deepEqual(waits.views("s")!.map((view) => view.kind), ["wait_pull_request"]);
  assert.deepEqual(waits.report("s", { ...prWait(), state: "ended" }, start + 122_000, () => false), { changed: true });
  assert.equal(waits.views("s"), undefined);
  assert.equal(waits.has("s"), false);
  assert.deepEqual(waits.report("s", { ...prWait(), state: "ended" }, start + 123_000, () => false), { changed: false },
    "ending an unknown wait changes nothing");
});

test("a wait keeps its kind and target, and a session tracks a bounded number of waits", () => {
  const { waits } = registry();
  waits.report("s", childWait(), 0, () => true);
  const moved = waits.report("s", childWait({ target: { kind: "session", sessionId: "other", states: ["idle"] } }), 1, () => true);
  assert.equal("error" in moved && moved.status, 409);
  for (let index = 1; index < SESSION_WAIT_LIMIT_PER_SESSION; index++) {
    assert.ok(!("error" in waits.report("s", prWait({ waitId: `wait_pullreq0${index}` }), 2, () => false)));
  }
  const over = waits.report("s", prWait({ waitId: "wait_pullreq99" }), 3, () => false);
  assert.equal("error" in over && over.status, 409);
});

test("a report's shape is checked exactly", () => {
  assert.equal(typeof parseSessionWaitReport(childWait()), "object");
  assert.equal(typeof parseSessionWaitReport(prWait()), "object");
  for (const bad of [
    null, [], { ...childWait(), extra: 1 }, { ...childWait(), waitId: "nope" }, { ...childWait(), kind: "wait_job" },
    { ...childWait(), state: "paused" }, { ...childWait(), elapsedMs: -1 }, { ...childWait(), remainingMs: 1.5 },
    { ...childWait(), intervalMs: 600_001 }, { ...childWait(), target: { kind: "pull_request", repository: "a/b", number: 1 } },
    { ...childWait(), target: { kind: "session", sessionId: "child", states: [] } },
    { ...prWait(), target: { kind: "pull_request", repository: "a/../b", number: 1 } },
    { ...prWait(), target: { kind: "pull_request", repository: "a/b", number: 0 } },
  ]) {
    assert.equal(typeof parseSessionWaitReport(bad), "string", JSON.stringify(bad));
  }
});

/** An Orchestrator "parent" with a running child "child" and an unrelated running session "other". */
function harness() {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const scope = { organizationId: identity.organizationId, owner: { kind: "user" as const, userId: identity.userId } };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repo" }],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", available: true }],
    runtime: { dataDir: "/runner", worktreeRoot: "/runner/worktrees", maxConcurrentSessions: 4 } };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  db.createSession({ id: "parent", runnerId: "r", workspaceId: "w", agentId: "claude", title: "Parent", useWorktree: false,
    driver: "claude-code", config: {}, now: 2, role: "orchestrator", orchestratorPolicy: policy,
    parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } }, scope });
  for (const id of ["child", "other"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "claude", title: id, useWorktree: false,
      creationActor: "human", scope, driver: "claude-code", config: {}, now: 2, ...(id === "child" ? { parentSessionId: "parent" } : {}) });
  }
  for (const id of ["parent", "child", "other"]) db.updateSessionStatus(id, "running", 3);
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  const changed: string[] = [];
  hub.sessionChangedById = (id) => { changed.push(id); svc.sessionWaitLifecycleChanged(id); };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  return { db, svc, changed };
}

test("an Orchestrator waiting on its running child reads a healthy wait for an hour, on list and detail rows alike (#1280)", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
  const h = harness();
  try {
    const report = { ...childWait(), target: { kind: "session", sessionId: "child", states: ["idle", "completed"] } };
    const first = h.svc.reportSessionWait("parent", report);
    assert.equal(first.error, undefined);
    assert.deepEqual(h.changed, ["parent"], "a new wait is published");
    for (let at = 15_000; at <= 59 * MINUTE; at += 15_000) {
      t.mock.timers.tick(15_000);
      h.svc.maintainSessionWaits(Date.now());
      h.svc.reportSessionWait("parent", { ...report, elapsedMs: 15_000 + at, remainingMs: ONE_HOUR - 15_000 - at });
    }
    assert.deepEqual(h.changed, ["parent"], "progress alone publishes nothing");
    const detail = h.db.getSession("parent")!;
    assert.equal(detail.waits!.length, 1);
    assert.equal(detail.waits![0]!.health, "healthy");
    assert.deepEqual(detail.waits![0]!.target, { kind: "session", child: true });
    const listed = h.db.listSessions({}).find((session) => session.id === "parent")!;
    assert.deepEqual(listed.waits, detail.waits, "the Sessions list carries the same classification as the detail");
    // The child stops being polled: the sweep classifies and publishes the stall.
    t.mock.timers.tick(sessionWaitProgressBoundMs(10_000) + 1);
    h.svc.maintainSessionWaits(Date.now());
    assert.deepEqual(h.changed, ["parent", "parent"]);
    assert.equal(h.db.getSession("parent")!.waits![0]!.stalledReason, "progress_lost");
  } finally { h.db.close(); }
});

test("a turn that ends takes its waits along, and a session outside a turn cannot report one", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
  const h = harness();
  try {
    assert.equal(h.svc.reportSessionWait("other", prWait()).error, undefined);
    assert.equal(h.svc.reportSessionWait("other", { ...childWait(), waitId: "wait_children02" }).error, undefined);
    h.db.updateSessionStatus("other", "idle", Date.now());
    h.changed.length = 0;
    h.svc.sessionWaitLifecycleChanged("other");
    assert.equal(h.db.getSession("other")!.waits, undefined);
    assert.deepEqual(h.changed, ["other"]);
    const refused = h.svc.reportSessionWait("other", prWait());
    assert.equal(refused.status, 409);
    // An unreported end is cleaned by the sweep as well.
    h.db.updateSessionStatus("other", "running", Date.now());
    h.svc.reportSessionWait("other", prWait());
    h.db.updateSessionStatus("other", "completed", Date.now());
    h.changed.length = 0;
    h.svc.maintainSessionWaits(Date.now());
    assert.equal(h.db.sessionWaits.has("other"), false);
  } finally { h.db.close(); }
});

test("a wait report is refused for a malformed body, a missing session, self, or a session the caller cannot read", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10_000_000 });
  const h = harness();
  try {
    assert.equal(h.svc.reportSessionWait("parent", { ...prWait(), extra: true }).status, 400);
    assert.equal(h.svc.reportSessionWait("missing", prWait()).status, 404);
    const self = { ...childWait(), target: { kind: "session", sessionId: "parent", states: ["idle"] } };
    assert.equal(h.svc.reportSessionWait("parent", self).status, 404);
    const gone = { ...childWait(), target: { kind: "session", sessionId: "nobody", states: ["idle"] } };
    assert.equal(h.svc.reportSessionWait("parent", gone).status, 404);
    assert.equal(h.svc.reportSessionWait("parent", childWait(), (id) => id !== "child").status, 404);
    const unrelated = { ...childWait(), target: { kind: "session", sessionId: "other", states: ["idle"] } };
    assert.equal(h.svc.reportSessionWait("parent", unrelated).error, undefined);
    assert.deepEqual(h.db.getSession("parent")!.waits![0]!.target, { kind: "session", child: false });
  } finally { h.db.close(); }
});
