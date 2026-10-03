/**
 * Campaign Status acceptance coverage for time, cost, and forge status (#2417 slice 9b).
 *
 * The companion of campaign-status-acceptance.integration.test.ts for the criteria slices 6 and 8
 * delivered. Each test names the #2417 acceptance criterion it proves and runs it through the
 * production wiring: a real `ControlPlaneDb`, the real `Hub` with a scripted runner socket,
 * `SessionsService` receiving usage the way a runner sends it (`onSessionEvent`), the
 * `CampaignWorkObservations` and `CampaignForgeObserver` that `index.ts` registers, and the browser
 * Read API routes with a principal chosen per request. `Date` is mocked, so durations are exact.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import {
  CAMPAIGN_FORGE_OBSERVATION,
  PROTOCOL_VERSION,
  type CampaignCostValue,
  type CampaignForgePullRequestObservation,
  type CampaignForgeRefreshResponse,
  type CampaignMetric,
  type CampaignWorkItemDetailResponse,
  type CampaignWorkItemsPage,
  type CampaignWorkSummaryResponse,
  type ControlPlaneToRunner,
  type RunnerMetadata,
  type SessionEventPayload,
} from "@wollipog/protocol";
import { CampaignForgeObserver } from "./campaign-forge-observations.js";
import { registerCampaignStatusRoutes } from "./campaign-status-routes.js";
import { CampaignWorkObservations } from "./campaign-work-observation.js";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { AuthPrincipal, HumanPrincipal } from "./identity.js";
import { SessionsService } from "./sessions.js";

const RUNNER_ID = "time-cost-forge-runner";
const WORKSPACE_ID = "time-cost-forge-workspace";
const ORG = "org_personal";
const REPO = "picoduck/wollipog";
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 3, 9, 0, 0);

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: WORKSPACE_ID, name: "Acceptance", path: "/tmp/campaign-time-cost-forge" }],
    agents: [
      { id: "child-agent", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code",
        available: true, context: { kind: "native" } },
      { id: "orchestrator-agent", name: "Planner", command: "claude", args: [], env: {}, driver: "claude-code",
        available: true, context: { kind: "native" },
        capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
          permissionModes: ["default", "orchestrator"] } },
    ],
  };
}

function human(userId: string): HumanPrincipal {
  return {
    kind: "human", actorId: userId, userId, userName: userId, organizationId: ORG, organizationName: "Personal",
    role: "operator", deviceId: null, localBootstrap: false,
  };
}

type ForgeAnswer = (refs: Array<{ repository: string; number: number }>) =>
  | { ok: true; results: Array<{ ref: { repository: string; number: number }; ok: true; observation: CampaignForgePullRequestObservation }
    | { ref: { repository: string; number: number }; ok: false; failure: "forge_unauthenticated" | "forge_not_found" }> }
  | { ok: false; failure: "forge_unauthenticated" | "forge_cli_missing" };

/** One control plane on a mocked clock. Every session belongs to "owner" unless a test says otherwise. */
async function stack(t: TestContext, options: { budgetUsd?: number } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: T0 });
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const warnings: string[] = [];
  const observations = new CampaignWorkObservations({
    db,
    refresh: (campaignSessionId) => svc.campaignWorkObserved(campaignSessionId),
    warn: (message) => warnings.push(message),
    delayMs: 10,
  });
  hub.observeSessions({
    changed: (sessionId) => observations.sessionChanged(sessionId),
    removed: (sessionId) => observations.sessionRemoved(sessionId),
  });

  // The runner answers forge reads as the test scripts them; everything else is only recorded.
  const sent: ControlPlaneToRunner[] = [];
  let forgeAnswer: ForgeAnswer | null = null;
  const runnerSocket = {
    send(data: string) {
      const message = JSON.parse(data) as ControlPlaneToRunner;
      sent.push(message);
      if (message.type !== "campaign_forge_observe" || !forgeAnswer) return;
      const answer = forgeAnswer(message.pullRequests);
      queueMicrotask(() => hub.resolveRunnerRequest({
        type: "campaign_forge_observe_result", requestId: message.requestId, sessionId: message.sessionId,
        observedAt: Date.now(), ...answer,
      }, RUNNER_ID));
    },
  };
  hub.attachRunner(RUNNER_ID, runnerSocket);
  let requestCounter = 0;
  const forge = new CampaignForgeObserver({
    observingRunner: (campaignId) => {
      const runner = db.campaignForgeObservingRunner(campaignId);
      return runner ? { ...runner, online: runner.online && hub.isRunnerOnline(runner.runnerId) } : null;
    },
    requestFromRunner: (runnerId, requestId, message, timeoutMs) => hub.requestFromRunner(runnerId, requestId, message, timeoutMs),
    store: db.campaignForgeObservations,
    backgroundTargets: (include) => db.campaignWorkLedger.forgeBackgroundTargets(include),
    changed: (campaignId) => observations.forgeChanged(campaignId),
    warn: (message) => warnings.push(message),
    newRequestId: () => `forge-${++requestCounter}`,
  });

  const principals: Record<string, AuthPrincipal> = { owner: human("owner"), viewer: human("viewer") };
  const app = Fastify();
  registerCampaignStatusRoutes(app, {
    db,
    requestPrincipal: (req) => principals[String(req.headers["x-test-principal"] ?? "owner")] ?? null,
    refreshForge: (campaignId, refs) => forge.refresh(campaignId, refs),
  });
  await app.ready();
  const call = async <T>(url: string, who = "owner", method: "GET" | "POST" = "GET") => {
    const response = await app.inject({ method, url, headers: { "x-test-principal": who } });
    assert.ok(response.statusCode < 500, response.body);
    return { status: response.statusCode, body: response.json() as T };
  };

  const ownBy = (table: "session_ownership" | "runner_ownership", id: string, userId: string) => {
    const column = table === "session_ownership" ? "session_id" : "runner_id";
    db.raw().prepare(
      `INSERT INTO ${table} (${column}, organization_id, owner_kind, owner_id, created_at, updated_at)
       VALUES (?, ?, 'user', ?, 1, 1)
       ON CONFLICT(${column}) DO UPDATE SET owner_kind='user', owner_id=excluded.owner_id`,
    ).run(id, ORG, userId);
  };
  ownBy("runner_ownership", RUNNER_ID, "owner");

  const decisions = {
    implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
    follow_up_issue_publication: "orchestrator", ui_evidence_approval: "orchestrator",
  } as const;
  const created = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "orchestrator-agent", title: "Time, Cost and Forge Campaign",
    config: { permissionMode: "orchestrator" }, prompt: "Orchestrate issues 201 and 202.",
    orchestrator: { behavior: { completion: "retain" } },
  }, undefined, undefined, false, false, false, {
    defaultOwnerUserId: "owner",
    orchestratorDefaults: {
      source: "user_default",
      defaults: {
        behavior: { childHarness: null, childModel: null, childEffort: null,
          maximumConcurrentChildren: 4, followUps: "execute_approved", completion: "retain" },
        delegation: { parentControl: "off", decisions: { ...decisions } },
        execution: { strictProjectIsolation: false, integrationIsolation: false },
      },
      capabilities: { models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available" },
    },
    validateOrchestratorDefaults: () => null,
  });
  assert.ok(created.ok && created.data, String(created.error));
  const root = created.data.id;
  ownBy("session_ownership", root, "owner");
  if (options.budgetUsd !== undefined) assert.ok(svc.setConfig(root, { costBudgetUsd: options.budgetUsd }).ok);
  svc.onSessionStatus(root, "running");

  let sequence = 0;
  const child = (parentSessionId: string, title: string, options: { orchestrator?: boolean; owner?: string } = {}) => {
    const id = `tcf-child-${++sequence}`;
    db.createSession({
      id, parentSessionId, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID,
      agentId: options.orchestrator ? "orchestrator-agent" : "child-agent", title, useWorktree: false, driver: "claude-code",
      config: options.orchestrator ? { permissionMode: "orchestrator" } : {}, now: Date.now(),
      ...(options.orchestrator ? { role: "orchestrator" as const, orchestratorPolicy: db.getSession(root)!.orchestratorPolicy! } : {}),
    });
    ownBy("session_ownership", id, options.owner ?? "owner");
    hub.sessionChangedById(id);
    svc.onSessionStatus(id, "running");
    return id;
  };
  /** Usage as the runner delivers it: a session event with the runner's own sequence number. */
  const runnerSeqs = new Map<string, number>();
  const usage = (sessionId: string, payload: Partial<SessionEventPayload> & { costUsd?: number }, runnerSeq?: number) => {
    const seq = runnerSeq ?? (runnerSeqs.get(sessionId) ?? 0) + 1;
    runnerSeqs.set(sessionId, Math.max(seq, runnerSeqs.get(sessionId) ?? 0));
    svc.onSessionEvent(sessionId, { kind: "token_usage", inputTokens: 100, outputTokens: 10, ...payload } as SessionEventPayload,
      seq, Date.now(), RUNNER_ID);
    return seq;
  };
  const report = (sessionId: string, text: string) =>
    db.appendEvent(sessionId, { kind: "agent_message", text, final: true }, Date.now()).seq;
  const deliver = (sessionId: string, workItemId: string, verifier = root) => {
    svc.onSessionStatus(sessionId, "idle");
    const verified = svc.verifyCampaignChild(verifier, {
      childSessionId: sessionId, reportEventSeq: report(sessionId, "Delivered."), followUpsAccounted: true,
      workItem: { id: workItemId, outcome: "delivered" },
    });
    assert.ok(verified.ok, String(verified.error));
  };
  const plan = (items: Array<{ key: string; dispatchState?: "planned" | "queued"; title?: string }>) => {
    const recorded = svc.recordCampaignPlan(root, { items, planComplete: true });
    assert.ok(recorded.ok && recorded.data, String(recorded.error));
    return Object.fromEntries(recorded.data.items.map((item) => [item.key, item.workItemId])) as Record<string, string>;
  };
  const assign = (workItemId: string, childSessionId: string, by = root) =>
    assert.ok(svc.assignCampaignWorkItem(by, { workItemId, childSessionId }).ok);
  const detail = async (workItemId: string, who = "owner") => {
    const response = await call<CampaignWorkItemDetailResponse>(`/api/sessions/${root}/campaign/work-items/${workItemId}`, who);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.item;
  };
  const summary = async (who = "owner", id = root) => {
    const response = await call<CampaignWorkSummaryResponse>(`/api/sessions/${id}/campaign/summary`, who);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.summary;
  };
  const tick = (ms: number) => t.mock.timers.tick(ms);
  const until = async (description: string, predicate: () => boolean) => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (predicate()) return;
      await delay(10);
    }
    assert.fail(`timed out waiting for ${description}`);
  };
  const close = async () => {
    forge.dispose();
    observations.dispose();
    await app.close();
    db.close();
    t.mock.timers.reset();
    assert.deepEqual(warnings, [], "no observation, forge read, or refresh failed");
  };
  return {
    db, hub, svc, forge, root, child, usage, report, deliver, plan, assign, detail, summary, call, ownBy, tick, until, close,
    sent, setForgeAnswer: (answer: ForgeAnswer | null) => { forgeAnswer = answer; },
    detachRunner: () => hub.detachRunner(RUNNER_ID, runnerSocket),
  };
}

/** A measured amount, rounded to the micro-dollar the ledger stores. */
function usd(metric: CampaignMetric<CampaignCostValue> | undefined): number {
  assert.ok(metric && metric.availability !== "unavailable", `expected a measured cost, got ${JSON.stringify(metric)}`);
  return Math.round(metric.value.usd * 1_000_000) / 1_000_000;
}

const OPEN_QUEUED: CampaignForgePullRequestObservation = {
  state: "open", draft: false, headSha: "a".repeat(40), baseRef: "main", reviewDecision: "approved",
  checks: { state: "passing", passing: 12, failing: 0, pending: 0 },
  requiredChecks: { state: "passing", passing: 1, failing: 0, pending: 0 },
  mergeQueue: { state: "awaiting_checks", position: 2 }, mergeCommitSha: null,
};

test("AC8: two concurrent ten-minute items show ten minutes of campaign elapsed, not twenty", async (t) => {
  const s = await stack(t);
  try {
    const ids = s.plan([{ key: "one", dispatchState: "queued" }, { key: "two", dispatchState: "queued" }]);
    const first = s.child(s.root, "One");
    const second = s.child(s.root, "Two");
    s.assign(ids.one!, first);
    s.assign(ids.two!, second);
    s.tick(10 * MINUTE);
    s.deliver(first, ids.one!);
    s.deliver(second, ids.two!);

    for (const key of ["one", "two"] as const) {
      const item = await s.detail(ids[key]!);
      assert.equal(item.primaryState, "delivered");
      assert.equal(item.times!.elapsed.endedAt! - item.times!.elapsed.startedAt!, 10 * MINUTE, `${key} took ten minutes`);
    }
    assert.equal(s.db.campaignProjection(s.root)?.status, "verified_complete");
    const elapsed = (await s.summary()).elapsed;
    assert.deepEqual(elapsed, { startedAt: T0, endedAt: T0 + 10 * MINUTE },
      "Campaign Elapsed is wall-clock from the root's creation to verified completion, never a sum of items");
    // After completion the clock stops: later time does not lengthen it.
    s.tick(30 * MINUTE);
    assert.deepEqual((await s.summary()).elapsed, elapsed);
  } finally {
    await s.close();
  }
});

test("AC9: queue, waiting, and active times come from recorded intervals, and missing history is unavailable, never zero", async (t) => {
  const s = await stack(t);
  try {
    const ids = s.plan([{ key: "measured", dispatchState: "queued" }, { key: "unstarted", dispatchState: "queued" }]);
    s.tick(3 * MINUTE); // Queued, waiting for capacity.
    const worker = s.child(s.root, "Measured Worker");
    s.assign(ids.measured!, worker);
    s.tick(4 * MINUTE); // Running.
    s.svc.onSessionStatus(worker, "input_required");
    s.tick(2 * MINUTE); // Waiting on a person.
    s.svc.onSessionStatus(worker, "running");
    s.tick(1 * MINUTE); // Running again.
    s.svc.onSessionStatus(worker, "idle");
    s.tick(1 * MINUTE); // Waiting for the Orchestrator's verification.
    s.deliver(worker, ids.measured!);
    s.tick(5 * MINUTE); // Nothing after delivery counts.

    const measured = await s.detail(ids.measured!);
    assert.deepEqual(measured.times!.queue, { availability: "known", value: 3 * MINUTE });
    assert.deepEqual(measured.times!.active, { availability: "known", value: 5 * MINUTE });
    assert.deepEqual(measured.times!.waiting, { availability: "known", value: 3 * MINUTE },
      "two minutes on input and one awaiting verification");
    assert.deepEqual(measured.times!.elapsed, { startedAt: T0 + 3 * MINUTE, endedAt: T0 + 11 * MINUTE });

    const unstarted = await s.detail(ids.unstarted!);
    assert.deepEqual(unstarted.times!.queue, { availability: "known", value: 16 * MINUTE }, "a queued item's wait is measured");
    assert.deepEqual(unstarted.times!.active, { availability: "unavailable", reason: "not_started" });
    assert.deepEqual(unstarted.times!.elapsed, { startedAt: null, endedAt: null }, "no attempt, so no Item Elapsed");

  } finally {
    await s.close();
  }
});

test("AC9 + AC10: a campaign from before recording began reads its gaps as unavailable or partial, never as zero", async (t) => {
  const s = await stack(t);
  try {
    const ids = s.plan([{ key: "legacy", dispatchState: "queued" }]);
    const worker = s.child(s.root, "Legacy Worker");
    s.assign(ids.legacy!, worker);
    s.usage(worker, { costUsd: 1 });
    s.tick(5 * MINUTE);
    // Simulate an upgrade five minutes in: nothing was recorded before it, and recording seeds the
    // state every item and open attempt is in at that moment.
    for (const table of ["campaign_work_item_transitions", "campaign_attempt_status_transitions", "campaign_work_accounting_meta"]) {
      s.db.raw().prepare(`DELETE FROM ${table}`).run();
    }
    s.db.campaignWorkLedger.accounting.startRecording(Date.now());
    s.tick(2 * MINUTE);
    s.svc.onSessionStatus(worker, "idle");
    s.tick(1 * MINUTE);

    const item = await s.detail(ids.legacy!);
    // The queued span was never recorded. The item has recorded spans since, so its Queue Time is a
    // lower bound ("at least"), as docs/campaign-work-ledger.md says, never a known zero.
    assert.deepEqual(item.times!.queue, { availability: "partial", reason: "history_unavailable", value: 0 });
    assert.deepEqual(item.times!.active, { availability: "partial", reason: "history_unavailable", value: 2 * MINUTE },
      "only activity after recording began is measured, marked as a lower bound");
    assert.deepEqual(item.times!.waiting, { availability: "partial", reason: "history_unavailable", value: 1 * MINUTE });
    const cost = (await s.summary()).cost!;
    for (const bucket of [cost.total, cost.workItems, cost.coordination, cost.unattributed]) {
      assert.equal(bucket.availability === "partial" && bucket.reason, "history_unavailable",
        "a campaign older than attribution has unsplit usage in every bucket");
    }
    assert.equal(cost.attributedSince, T0 + 5 * MINUTE);
  } finally {
    await s.close();
  }
});

test("AC10 + AC4/5 accounting: each usage record is counted once across replay, retries, reassignment, nested sessions, provider subagents, and event pruning", async (t) => {
  const s = await stack(t);
  try {
    const ids = s.plan([
      { key: "a", dispatchState: "queued" }, { key: "b", dispatchState: "queued" },
      { key: "retried", dispatchState: "queued" }, { key: "nested", dispatchState: "queued" },
      { key: "zero", dispatchState: "queued" }, { key: "unstarted" },
    ]);
    s.usage(s.root, { costUsd: 0.5 }); // Coordination: the root outside any attempt.
    const reused = s.child(s.root, "Reused Child");
    s.usage(reused, { costUsd: 0.25 }); // Unattributed: a child with no open attempt.

    // Item A: two records; a replayed record and a provider subagent's usage add nothing.
    s.assign(ids.a!, reused);
    const replayed = s.usage(reused, { costUsd: 1 });
    s.usage(reused, { costUsd: 1 }, replayed);
    s.usage(reused, { costUsd: 9, parentToolUseId: "toolu_subagent" });
    s.usage(reused, { costUsd: 2 });
    s.deliver(reused, ids.a!);

    // Reassigned to B: A keeps its cost (AC4); B accrues only what follows.
    s.svc.onSessionStatus(reused, "running");
    s.assign(ids.b!, reused);
    s.usage(reused, { costUsd: 4 });

    // A failed attempt and its retry on another child: one item, two attempt costs.
    const failing = s.child(s.root, "Fails First");
    s.assign(ids.retried!, failing);
    s.usage(failing, { costUsd: 0.75 });
    s.svc.onSessionStatus(failing, "failed");
    assert.ok(s.svc.updateCampaignWorkItem(s.root, { workItemId: ids.retried!, endAttempt: { reason: "failed" } }).ok);
    const retry = s.child(s.root, "Retry");
    s.assign(ids.retried!, retry);
    s.usage(retry, { costUsd: 1.25 });

    // A nested Orchestrator's own usage is coordination; its child's attempt usage is item cost.
    const nested = s.child(s.root, "Nested Orchestrator", { orchestrator: true });
    const grandchild = s.child(nested, "Grandchild");
    s.usage(nested, { costUsd: 0.125 });
    s.assign(ids.nested!, grandchild, nested);
    s.usage(grandchild, { costUsd: 3 });

    // An attempt that used nothing is a known zero; an item never started has no cost to show.
    const idle = s.child(s.root, "Uses Nothing");
    s.assign(ids.zero!, idle);

    // A session outside every campaign contributes nothing.
    s.db.createSession({ id: "outsider", runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "child-agent",
      title: "Outsider", useWorktree: false, driver: "claude-code", config: {}, now: Date.now() });
    s.usage("outsider", { costUsd: 50 });

    const a = await s.detail(ids.a!);
    assert.equal(usd(a.cost), 3, "A: two records, the replay and the subagent excluded");
    assert.equal(a.cost?.availability === "known" && a.cost.value.records, 2);
    assert.equal(usd((await s.detail(ids.b!)).cost), 4);
    const retried = await s.detail(ids.retried!);
    assert.equal(usd(retried.cost), 2);
    assert.deepEqual(retried.attemptCosts?.map((entry) => usd(entry.cost)), [0.75, 1.25], "each attempt keeps its own usage");
    assert.deepEqual(retried.attempts.map((attempt) => attempt.endReason), ["failed", null]);
    assert.equal(usd((await s.detail(ids.nested!)).cost), 3);
    assert.deepEqual((await s.detail(ids.zero!)).cost,
      { availability: "known", value: { usd: 0, source: "providerReported", unpricedRecords: 0, records: 0 } },
      "a known zero says no usage was recorded");
    assert.deepEqual((await s.detail(ids.unstarted!)).cost, { availability: "unavailable", reason: "not_started" },
      "missing attribution is not a zero");

    let cost = (await s.summary()).cost!;
    assert.deepEqual([usd(cost.workItems), usd(cost.coordination), usd(cost.unattributed), usd(cost.total)],
      [12, 0.625, 0.25, 12.875]);
    const members = [s.root, reused, failing, retry, nested, grandchild, idle];
    const ledger = members.reduce((sum, id) => sum + s.db.getSession(id)!.costUsd, 0);
    assert.equal(usd(cost.total), Math.round(ledger * 1_000_000) / 1_000_000,
      "the buckets reconcile exactly with the members' session totals");

    // Event pruning, archive, and deletion change nothing already attributed (AC5).
    s.db.raw().prepare("DELETE FROM session_events WHERE session_id IN (?, ?)").run(reused, grandchild);
    assert.ok(s.svc.setArchived(failing, true).ok);
    assert.ok(s.svc.delete(reused).ok);
    cost = (await s.summary()).cost!;
    assert.equal(usd(cost.total), 12.875);
    assert.equal(usd((await s.detail(ids.a!)).cost), 3, "A keeps its accounting after its child is deleted");
    assert.deepEqual((await s.detail(ids.retried!)).attemptCosts?.map((entry) => usd(entry.cost)), [0.75, 1.25]);
  } finally {
    await s.close();
  }
});

test("AC10: partially priced usage is a lower bound, cost is shown per principal, and the budget keeps its session scope", async (t) => {
  const s = await stack(t, { budgetUsd: 25 });
  try {
    const ids = s.plan([{ key: "priced", dispatchState: "queued" }, { key: "private", dispatchState: "queued" }]);
    const priced = s.child(s.root, "Priced", { owner: "viewer" });
    s.assign(ids.priced!, priced);
    s.usage(priced, { costUsd: 1.5 });
    s.usage(priced, { model: "model-without-a-rate" }); // No provider cost and no rate: unpriced.
    // Another person's child: its usage is real, but not every reader may see it.
    const hidden = s.child(s.root, "Someone Else's Child", { owner: "someone-else" });
    s.assign(ids.private!, hidden);
    s.usage(hidden, { costUsd: 2 });
    s.ownBy("session_ownership", s.root, "viewer");

    const item = await s.detail(ids.priced!, "viewer");
    assert.deepEqual(item.cost, { availability: "partial", reason: "unpriced_usage",
      value: { usd: 1.5, source: "unpriced", unpricedRecords: 1, records: 2 } }, "the weakest provenance wins");

    const viewer = (await s.summary("viewer")).cost!;
    assert.equal(viewer.workItems.availability === "unavailable" && viewer.workItems.reason, "not_authorized",
      "a bucket with a contributor the viewer may not read is hidden, not undercounted");
    assert.equal(viewer.total.availability === "unavailable" && viewer.total.reason, "not_authorized");
    assert.deepEqual((await s.detail(ids.private!, "viewer")).cost, { availability: "unavailable", reason: "not_authorized" });
    assert.ok(!JSON.stringify(await s.detail(ids.private!, "viewer")).includes("\"usd\":2"));

    // Once the reader may see every contributor, the same buckets are measured.
    for (const id of [s.root, priced, hidden]) s.ownBy("session_ownership", id, "owner");
    const owner = (await s.summary("owner")).cost!;
    assert.equal(owner.total.availability, "partial", "unpriced usage makes the total a lower bound");
    assert.equal(usd(owner.total), 3.5);
    assert.equal(usd((await s.detail(ids.private!, "owner")).cost), 2);

    // The configured budget is the Orchestrator session's own, never presented as campaign-wide.
    const projection = s.db.getSession(s.root)!.orchestratorCampaign!;
    assert.equal(projection.limits.costBudgetUsd, 25, "the projection names the root session's own budget");
    const summary = await s.summary("owner");
    assert.ok(!/budget/iu.test(JSON.stringify(summary)), "the campaign summary carries no campaign-wide budget");
  } finally {
    await s.close();
  }
});

test("AC7 + AC14 (merge-queue waits): observed forge facts are fresh, then stale, and unavailable or not_authorized never imply passing", async (t) => {
  const s = await stack(t);
  try {
    const ids = s.plan([{ key: `${REPO}#201`, dispatchState: "queued" }]);
    const itemId = ids[`${REPO}#201`]!;
    const worker = s.child(s.root, "Implements 201");
    s.assign(itemId, worker);
    const queued = { repository: REPO, number: 9201 };
    const neverRead = { repository: REPO, number: 9202 };
    assert.ok(s.svc.updateCampaignWorkItem(s.root, { workItemId: itemId,
      stage: { stage: "merge_queued", note: "Enqueued after approval.", pullRequests: [queued, neverRead] } }).ok);
    s.svc.onSessionStatus(worker, "idle");

    // Before any read: unavailable with a reason, not passing.
    let item = await s.detail(itemId);
    assert.deepEqual(item.observed.pullRequests!.map((entry) => entry.fact),
      [{ availability: "unavailable", reason: "not_observed" }, { availability: "unavailable", reason: "not_observed" }]);

    // The runner reads GitHub: the first pull request waits in the merge queue; the second is not found.
    s.setForgeAnswer((refs) => ({ ok: true, results: refs.map((ref) => ref.number === queued.number
      ? { ref, ok: true as const, observation: OPEN_QUEUED }
      : { ref, ok: false as const, failure: "forge_not_found" as const }) }));
    const refreshed = await s.call<CampaignForgeRefreshResponse>(
      `/api/sessions/${s.root}/campaign/work-items/${itemId}/forge-refresh`, "owner", "POST");
    assert.equal(refreshed.status, 200);
    assert.equal(s.sent.filter((message) => message.type === "campaign_forge_observe").length, 1);
    item = await s.detail(itemId);
    const [fact, missing] = item.observed.pullRequests!.map((entry) => entry.fact);
    assert.deepEqual(fact, { availability: "fresh", value: OPEN_QUEUED, observedAt: T0 });
    assert.deepEqual(missing, { availability: "unavailable", reason: "forge_not_found" });
    // Observed and reported stay apart, and a merge-queue wait is unfinished work.
    assert.deepEqual([item.stage?.stage, item.stage?.sourceSessionId], ["merge_queued", s.root]);
    assert.deepEqual([item.primaryState, item.stateCauses], ["waiting", ["attempt_awaiting_verification"]]);
    assert.equal((await s.summary()).counts.delivered, 0, "neither the queue nor the observation delivers it");

    // Past the documented age the last value is stale, with its observation time.
    s.tick(CAMPAIGN_FORGE_OBSERVATION.staleAfterMs + MINUTE);
    item = await s.detail(itemId);
    assert.deepEqual(item.observed.pullRequests![0]!.fact, { availability: "stale", value: OPEN_QUEUED, observedAt: T0 });

    // A failed read keeps the last value for display only and reads unavailable with its reason.
    s.setForgeAnswer(() => ({ ok: false, failure: "forge_unauthenticated" }));
    await s.call(`/api/sessions/${s.root}/campaign/work-items/${itemId}/forge-refresh`, "owner", "POST");
    item = await s.detail(itemId);
    assert.deepEqual(item.observed.pullRequests![0]!.fact, {
      availability: "unavailable", reason: "forge_unauthenticated", lastValue: OPEN_QUEUED, lastObservedAt: T0,
    });

    // A reader with the campaign but not the observing runner sees the reference, never the fact.
    s.ownBy("session_ownership", s.root, "viewer");
    const viewer = await s.detail(itemId, "viewer");
    assert.deepEqual(viewer.observed.pullRequests!.map((entry) => entry.fact),
      [{ availability: "unavailable", reason: "not_authorized" }, { availability: "unavailable", reason: "not_authorized" }]);
    assert.equal(viewer.stage?.stage, "merge_queued", "the reported stage stays visible");
    assert.equal((await s.call(`/api/sessions/${s.root}/campaign/work-items/${itemId}/forge-refresh`, "viewer", "POST")).status,
      403, "and cannot cause a read");
    s.ownBy("session_ownership", s.root, "owner");

    // Facts never ride the session views the hub broadcasts, nor the summary.
    assert.ok(!JSON.stringify(s.db.getSession(s.root)).includes(OPEN_QUEUED.headSha));
    assert.ok(!JSON.stringify(await s.summary()).includes(OPEN_QUEUED.headSha));

    // The runner disconnects, with the cleanup index.ts runs: a pull request never read says why,
    // and the stopped child blocks the item rather than letting a forge fact stand in for progress.
    s.db.raw().prepare("DELETE FROM campaign_forge_observations WHERE number=?").run(neverRead.number);
    s.detachRunner();
    s.db.markOffline(RUNNER_ID, Date.now());
    s.svc.failRunnerSessions(RUNNER_ID);
    item = await s.detail(itemId);
    assert.deepEqual(item.observed.pullRequests![1]!.fact, { availability: "unavailable", reason: "runner_disconnected" });
    assert.equal(item.observed.pullRequests![0]!.fact.availability, "unavailable",
      "the last read still failed; disconnecting makes nothing fresh");
    const page = await s.call<CampaignWorkItemsPage>(`/api/sessions/${s.root}/campaign/work-items?state=all`);
    assert.deepEqual([page.body.items[0]!.primaryState, page.body.items[0]!.stateCauses], ["blocked", ["attempt_session_stopped"]]);
  } finally {
    await s.close();
  }
});

test("AC9 + AC14 (merge-queue waits): time in the merge queue counts as waiting, and delivery stops every clock", async (t) => {
  const s = await stack(t);
  try {
    const ids = s.plan([{ key: `${REPO}#202`, dispatchState: "queued" }]);
    const itemId = ids[`${REPO}#202`]!;
    const worker = s.child(s.root, "Implements 202");
    s.assign(itemId, worker);
    s.tick(6 * MINUTE);
    s.svc.onSessionStatus(worker, "idle");
    assert.ok(s.svc.updateCampaignWorkItem(s.root, { workItemId: itemId,
      stage: { stage: "merge_queued", pullRequests: [{ repository: REPO, number: 9301 }] } }).ok);
    s.tick(25 * MINUTE); // The merge group re-runs the browser tests.
    let item = await s.detail(itemId);
    assert.deepEqual([item.primaryState, item.times!.active, item.times!.waiting],
      ["waiting", { availability: "known", value: 6 * MINUTE }, { availability: "known", value: 25 * MINUTE }]);
    assert.equal(item.times!.elapsed.endedAt, null, "unfinished: Item Elapsed runs to now");

    s.deliver(worker, itemId);
    s.tick(60 * MINUTE);
    item = await s.detail(itemId);
    assert.deepEqual(item.times!.elapsed, { startedAt: T0, endedAt: T0 + 31 * MINUTE });
    assert.deepEqual(item.times!.waiting, { availability: "known", value: 25 * MINUTE });
  } finally {
    await s.close();
  }
});
