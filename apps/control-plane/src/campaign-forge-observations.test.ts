/**
 * Campaign forge status (#2417 slice 8): stored GitHub observations with fresh, stale, and every
 * unavailable reason; the observer's rate limit, coalescing, bounded concurrency, and background
 * pass; and the routes' authorization, which needs access to the observing runner as well as the
 * campaign. A fake runner answers deterministically; nothing reaches GitHub.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  CAMPAIGN_FORGE_OBSERVATION,
  PROTOCOL_VERSION,
  type CampaignForgeObserveMessage,
  type CampaignForgeObserveResultMessage,
  type CampaignForgePullRequestObservation,
  type CampaignForgeRefreshResponse,
  type CampaignPullRequestRef,
  type CampaignWorkItemDetailResponse,
  type RunnerMetadata,
  type SessionView,
} from "@wollipog/protocol";
import { isAgentControlApiRouteAllowed } from "./auth.js";
import {
  CampaignForgeObserver,
  forgeFact,
  type CampaignForgeObserverDeps,
} from "./campaign-forge-observations.js";
import { registerCampaignStatusRoutes } from "./campaign-status-routes.js";
import { CampaignWorkObservations } from "./campaign-work-observation.js";
import { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { AgentPrincipal, AuthPrincipal, HumanPrincipal } from "./identity.js";
import { withSessionCommandPermissions } from "./session-command-permissions.js";
import { SessionsService } from "./sessions.js";

const RUNNER_ID = "forge-runner";
const WORKSPACE_ID = "forge-workspace";
const ORG = "org_personal";
const HEAD = "44579c6c25235598f1a28f8ccb0449cb8dbbc810";
const MINUTE = 60_000;
const PR: CampaignPullRequestRef = { repository: "picoduck/wollipog", number: 2462 };

function observation(overrides: Partial<CampaignForgePullRequestObservation> = {}): CampaignForgePullRequestObservation {
  return {
    state: "open", draft: false, headSha: HEAD, baseRef: "main", reviewDecision: "none",
    checks: { state: "pending", passing: 8, failing: 0, pending: 1 },
    requiredChecks: { state: "passing", passing: 1, failing: 0, pending: 0 },
    mergeQueue: { state: "awaiting_checks", position: 2 },
    mergeCommitSha: null,
    ...overrides,
  };
}

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: WORKSPACE_ID, name: "Demo", path: "/tmp/forge" }],
    agents: [
      { id: "child-agent", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code",
        available: true, context: { kind: "native" } },
      { id: "test-orchestrator", name: "Planner", command: "claude", args: [], env: {}, driver: "claude-code",
        available: true, context: { kind: "native" },
        capabilities: { models: [], effortLevels: [], slashCommands: [], supportsImages: false, supportsApprovals: true,
          permissionModes: ["default", "orchestrator"] } },
    ],
  };
}

/** A campaign with one item whose reported stage names `refs`, on a runner of `protocolVersion`. */
function forgeFixture(protocolVersion = PROTOCOL_VERSION, refs: CampaignPullRequestRef[] = [PR]) {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), protocolVersion);
  const hubImpl = {
    isRunnerOnline: () => true,
    sendToRunner: () => true,
    observeSessions: () => undefined,
    sessionChanged: () => undefined,
    sessionChangedById: () => undefined,
    sessionRemoved: () => undefined,
  };
  const hub = new Proxy(hubImpl, {
    get: (target, key: string) => key in target ? target[key as keyof typeof target] : () => undefined,
  }) as unknown as Hub;
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const decisions = {
    implementation_question: "human", pr_merge: "human", merged_branch_deletion: "human",
    follow_up_issue_publication: "human", ui_evidence_approval: "human",
  } as const;
  const created = svc.createSession({
    runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "test-orchestrator", title: "Campaign Root",
    config: { permissionMode: "orchestrator" }, prompt: "Orchestrate.",
    orchestrator: { behavior: { completion: "retain" } },
  }, undefined, undefined, false, false, false, {
    defaultOwnerUserId: "owner",
    orchestratorDefaults: {
      source: "user_default",
      defaults: {
        behavior: { childHarness: null, childModel: null, childEffort: null, maximumConcurrentChildren: 4,
          followUps: "recommend_only", completion: "retain" },
        delegation: { parentControl: "off", decisions: { ...decisions } },
        execution: { strictProjectIsolation: false, integrationIsolation: false },
      },
      capabilities: { models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available" },
    },
    validateOrchestratorDefaults: () => null,
  });
  assert.ok(created.ok && created.data, String(created.error));
  const root = created.data.id;
  db.updateSessionStatus(root, "running", Date.now());
  const plan = svc.recordCampaignPlan(root, { items: [{ key: "picoduck/wollipog#2417" }, { key: "done" }], planComplete: true });
  assert.ok(plan.ok && plan.data, String(plan.error));
  const [itemId, doneId] = plan.data.items.map((item) => item.workItemId) as [string, string];
  assert.ok(svc.updateCampaignWorkItem(root, { workItemId: itemId, stage: { stage: "merge_queued", pullRequests: refs } }).ok);
  const ownBy = (table: "session_ownership" | "runner_ownership", id: string, userId: string) => {
    const column = table === "session_ownership" ? "session_id" : "runner_id";
    db.raw().prepare(
      `INSERT INTO ${table} (${column}, organization_id, owner_kind, owner_id, created_at, updated_at)
       VALUES (?, ?, 'user', ?, 1, 1)
       ON CONFLICT(${column}) DO UPDATE SET owner_kind='user', owner_id=excluded.owner_id`,
    ).run(id, ORG, userId);
  };
  return { db, svc, root, itemId, doneId, ownBy };
}

function human(userId: string): HumanPrincipal {
  return {
    kind: "human", actorId: userId, userId, userName: userId, organizationId: ORG, organizationName: "Personal",
    role: "operator", deviceId: null, localBootstrap: false,
  };
}

function agent(credentialSessionId: string, orchestrator: boolean): AgentPrincipal {
  return {
    kind: "agent", actorId: `agent-${credentialSessionId}`, credentialSessionId, orchestrator,
    organizationId: ORG, delegatedScope: { organizationId: ORG, owner: { kind: "organization", organizationId: ORG } },
  };
}

/** A runner that answers forge reads from a script, records every request, and can be held. */
function fakeRunner(answer: (message: CampaignForgeObserveMessage) => Partial<CampaignForgeObserveResultMessage> | Error) {
  const requests: CampaignForgeObserveMessage[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let gate: Promise<void> = Promise.resolve();
  let open: () => void = () => undefined;
  return {
    requests,
    get maxInFlight() { return maxInFlight; },
    hold() { gate = new Promise((resolve) => { open = resolve; }); },
    release() { open(); },
    async request(_runnerId: string, requestId: string, message: CampaignForgeObserveMessage): Promise<unknown> {
      requests.push(message);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await gate;
        const result = answer(message);
        if (result instanceof Error) throw result;
        return { type: "campaign_forge_observe_result", requestId, sessionId: message.sessionId, observedAt: 0, ...result };
      } finally {
        inFlight--;
      }
    },
  };
}

const allOk = (value: CampaignForgePullRequestObservation = observation()) => (message: CampaignForgeObserveMessage) => ({
  ok: true,
  results: message.pullRequests.map((ref) => ({ ref, ok: true as const, observation: value })),
});

function observer(
  fixture: ReturnType<typeof forgeFixture>,
  runner: ReturnType<typeof fakeRunner>,
  options: { now?: () => number; online?: boolean; changed?: (id: string) => void; warn?: (message: string) => void } = {},
) {
  const deps: CampaignForgeObserverDeps = {
    observingRunner: (campaignId) => {
      const found = fixture.db.campaignForgeObservingRunner(campaignId);
      return found ? { ...found, online: options.online ?? found.online } : null;
    },
    requestFromRunner: (runnerId, requestId, message) => runner.request(runnerId, requestId, message),
    store: fixture.db.campaignForgeObservations,
    backgroundTargets: (include) => fixture.db.campaignWorkLedger.forgeBackgroundTargets(include),
    changed: options.changed ?? (() => undefined),
    warn: options.warn ?? (() => undefined),
    newRequestId: (() => { let n = 0; return () => `forge_${++n}`; })(),
    ...(options.now ? { now: options.now } : {}),
  };
  return new CampaignForgeObserver(deps);
}

const detailFacts = (fixture: ReturnType<typeof forgeFixture>, now = Date.now()) =>
  fixture.db.campaignWorkLedger.detail(fixture.root, fixture.itemId, now)!.observed.pullRequests!;

test("a fact is fresh, then stale after the documented age, and unavailable reasons never carry a current value", () => {
  const now = 1_000_000_000;
  const row = (overrides: Record<string, unknown>) => ({
    repository_key: "picoduck/wollipog", number: 1, value_json: JSON.stringify(observation()), observed_at: now - MINUTE,
    failure_reason: null, failed_at: null, ...overrides,
  }) as Parameters<typeof forgeFact>[0];
  assert.deepEqual(forgeFact(row({}), "online", now), { availability: "fresh", value: observation(), observedAt: now - MINUTE });
  const old = now - CAMPAIGN_FORGE_OBSERVATION.staleAfterMs - 1;
  assert.deepEqual(forgeFact(row({ observed_at: old }), "online", now), { availability: "stale", value: observation(), observedAt: old });
  assert.equal(forgeFact(row({ observed_at: now - CAMPAIGN_FORGE_OBSERVATION.staleAfterMs }), "online", now).availability, "fresh",
    "exactly the documented age is still fresh");
  // A failed latest read is unavailable; the last value is kept for display as history only.
  assert.deepEqual(forgeFact(row({ failure_reason: "forge_rate_limited", failed_at: now }), "online", now), {
    availability: "unavailable", reason: "forge_rate_limited", lastValue: observation(), lastObservedAt: now - MINUTE,
  });
  assert.deepEqual(forgeFact(row({ value_json: null, observed_at: null, failure_reason: "forge_cli_missing" }), "online", now),
    { availability: "unavailable", reason: "forge_cli_missing" });
  // Nothing stored: the reason comes from the observing runner.
  assert.deepEqual(forgeFact(undefined, "online", now), { availability: "unavailable", reason: "not_observed" });
  assert.deepEqual(forgeFact(undefined, "offline", now), { availability: "unavailable", reason: "runner_disconnected" });
  assert.deepEqual(forgeFact(undefined, "unsupported", now), { availability: "unavailable", reason: "runner_unsupported" });
});

test("every forge failure reason is stored per pull request and replaces nothing but availability", async () => {
  const reasons = ["forge_cli_missing", "forge_unauthenticated", "forge_unreachable", "forge_unsupported",
    "forge_not_found", "forge_rate_limited", "forge_error"] as const;
  for (const reason of reasons) {
    const fixture = forgeFixture();
    try {
      let now = Date.now();
      let fail = false;
      const runner = fakeRunner((message) => fail ? { ok: false, failure: reason } : allOk()(message));
      const forge = observer(fixture, runner, { now: () => now });
      await forge.refresh(fixture.root, [PR]);
      assert.equal(detailFacts(fixture, now)[0]!.fact.availability, "fresh");
      fail = true;
      now += CAMPAIGN_FORGE_OBSERVATION.minIntervalMs;
      await forge.refresh(fixture.root, [PR]);
      const fact = detailFacts(fixture, now)[0]!.fact;
      assert.equal(fact.availability, "unavailable", reason);
      assert.ok(fact.availability === "unavailable" && fact.reason === reason && fact.lastValue, reason);
      // A later success clears the failure.
      fail = false;
      now += CAMPAIGN_FORGE_OBSERVATION.minIntervalMs;
      await forge.refresh(fixture.root, [PR]);
      assert.equal(detailFacts(fixture, now)[0]!.fact.availability, "fresh", reason);
    } finally {
      fixture.db.close();
    }
  }
});

test("an older runner is never asked and its campaign reads runner_unsupported; a disconnected one runner_disconnected", async () => {
  const old = forgeFixture(197);
  try {
    const runner = fakeRunner(allOk());
    await observer(old, runner).refresh(old.root, [PR]);
    await observer(old, runner).backgroundPass();
    assert.equal(runner.requests.length, 0, "a runner before campaignForgeStatus gets no new message");
    assert.deepEqual(detailFacts(old)[0]!.fact, { availability: "unavailable", reason: "runner_unsupported" });
  } finally {
    old.db.close();
  }
  const offline = forgeFixture();
  try {
    offline.db.raw().prepare("UPDATE runners SET status='offline' WHERE runner_id=?").run(RUNNER_ID);
    const runner = fakeRunner(allOk());
    await observer(offline, runner).refresh(offline.root, [PR]);
    assert.equal(runner.requests.length, 0);
    assert.deepEqual(detailFacts(offline)[0]!.fact, { availability: "unavailable", reason: "runner_disconnected" });
  } finally {
    offline.db.close();
  }
});

test("reads are rate-limited per pull request, coalesced while in flight, batched, and bounded in concurrency", async () => {
  const many = Array.from({ length: 20 }, (_, index) => ({ repository: "picoduck/wollipog", number: index + 1 }));
  const fixture = forgeFixture(PROTOCOL_VERSION, many.slice(0, 16));
  try {
    let now = Date.now();
    const runner = fakeRunner(allOk());
    const forge = observer(fixture, runner, { now: () => now });
    runner.hold();
    const first = forge.refresh(fixture.root, many);
    const joined = forge.refresh(fixture.root, many.slice(0, 3));
    runner.release();
    await Promise.all([first, joined]);
    assert.deepEqual(runner.requests.map((request) => request.pullRequests.length), [16, 4],
      "twenty pull requests take two batched reads, and a concurrent caller joins them");
    await forge.refresh(fixture.root, many);
    assert.equal(runner.requests.length, 2, "nothing is re-read within the minimum interval");
    now += CAMPAIGN_FORGE_OBSERVATION.minIntervalMs;
    await forge.refresh(fixture.root, [many[0]!, { repository: "PicoDuck/Wollipog", number: 1 }]);
    assert.equal(runner.requests.length, 3);
    assert.equal(runner.requests[2]!.pullRequests.length, 1, "the repository compares case-insensitively");

    // Concurrency: many campaigns' reads never put more than the bound in flight at once.
    now += CAMPAIGN_FORGE_OBSERVATION.minIntervalMs;
    runner.hold();
    const reads = many.map((ref) => forge.refresh(fixture.root, [ref]));
    runner.release();
    await Promise.all(reads);
    assert.ok(runner.maxInFlight <= CAMPAIGN_FORGE_OBSERVATION.concurrentRequests, `max in flight ${runner.maxInFlight}`);
  } finally {
    fixture.db.close();
  }
});

test("only a visible change notifies, and malformed, mismatched, or timed-out answers store nothing", async () => {
  const fixture = forgeFixture();
  try {
    let now = Date.now();
    let next: Partial<CampaignForgeObserveResultMessage> | Error | null = null;
    const runner = fakeRunner((message) => next ?? allOk()(message));
    const changed: string[] = [];
    const warnings: string[] = [];
    const forge = observer(fixture, runner, { now: () => now, changed: (id) => changed.push(id), warn: (message) => warnings.push(message) });
    const again = async () => {
      now += CAMPAIGN_FORGE_OBSERVATION.minIntervalMs;
      await forge.refresh(fixture.root, [PR]);
    };
    await forge.refresh(fixture.root, [PR]);
    assert.deepEqual(changed, [fixture.root], "a first observation is a change");
    await again();
    assert.deepEqual(changed, [fixture.root], "the same answer again only moves its observation time");
    const renewed = detailFacts(fixture, now)[0]!.fact;
    assert.equal(renewed.availability === "fresh" ? renewed.observedAt : null, now, "the observation time still moves");

    const stored = () => JSON.stringify(fixture.db.campaignForgeObservations.facts(fixture.root, [PR], 0));
    const before = stored();
    for (const bad of [
      new Error("runner request timed out"),
      { ok: true, results: [] },
      { ok: true, results: [{ ref: { repository: "other/repo", number: 1 }, ok: true, observation: observation() }] },
      { ok: true, results: [{ ref: PR, ok: true, observation: { ...observation(), requiredChecks: "passing" } }] },
      { ok: true, results: [{ ref: PR, ok: false, failure: "made_up" }] },
      { ok: false, failure: "not_a_reason" },
      { ok: true, sessionId: "somebody-else", results: [{ ref: PR, ok: true, observation: observation() }] },
      // A non-string repository once threw during validation and rejected the refresh.
      { ok: true, results: [{ ref: { repository: 5, number: PR.number }, ok: true, observation: observation() }] },
      { ok: true, results: [null] },
    ] as unknown as Array<Partial<CampaignForgeObserveResultMessage> | Error>) {
      next = bad;
      await again();
      assert.equal(stored(), before, JSON.stringify(bad));
    }
    assert.equal(warnings.length, 9, "each rejected answer is logged, none stored, and refresh never rejects");
    assert.deepEqual(changed, [fixture.root]);

    next = { ok: true, results: [{ ref: PR, ok: true, observation: observation({ state: "merged", mergeQueue: null, mergeCommitSha: HEAD }) }] };
    await again();
    assert.deepEqual(changed, [fixture.root, fixture.root], "a new value is a change");
    // Extra fields a runner might send are never stored.
    next = { ok: true, results: [{ ref: PR, ok: true, observation: { ...observation(), token: "ghp_secret" } as CampaignForgePullRequestObservation }] };
    await again();
    assert.ok(!JSON.stringify(detailFacts(fixture, now)).includes("ghp_secret"));
  } finally {
    fixture.db.close();
  }
});

test("the background pass reads only unfinished items' pull requests that are due, oldest first, within its bound", async () => {
  const fixture = forgeFixture(PROTOCOL_VERSION, [PR, { ...PR, number: 1 }]);
  try {
    // The delivered item's pull request is never a background target.
    assert.ok(fixture.svc.updateCampaignWorkItem(fixture.root, {
      workItemId: fixture.doneId, stage: { stage: "merged", pullRequests: [{ ...PR, number: 99 }] },
      commitment: { state: "cancelled", reason: "Superseded by #2417." },
    }).ok);
    let now = Date.now();
    const runner = fakeRunner((message) => ({
      ok: true,
      results: message.pullRequests.map((ref) => ({ ref, ok: true as const,
        observation: ref.number === 1 ? observation({ state: "merged", mergeQueue: null }) : observation() })),
    }));
    const forge = observer(fixture, runner, { now: () => now });
    await forge.backgroundPass();
    assert.deepEqual(runner.requests.map((request) => request.pullRequests.map((ref) => ref.number)), [[2462, 1]]);
    now += CAMPAIGN_FORGE_OBSERVATION.minIntervalMs;
    await forge.backgroundPass();
    assert.equal(runner.requests.length, 1, "nothing is due before the background interval");
    now += CAMPAIGN_FORGE_OBSERVATION.backgroundIntervalMs;
    await forge.backgroundPass();
    assert.deepEqual(runner.requests.at(-1)!.pullRequests.map((ref) => ref.number), [2462],
      "a merged pull request is left to on-demand reads");
    // An item that is no longer unfinished drops out.
    assert.ok(fixture.svc.updateCampaignWorkItem(fixture.root, {
      workItemId: fixture.itemId, commitment: { state: "scope_removed", reason: "Out of scope." },
    }).ok);
    now += CAMPAIGN_FORGE_OBSERVATION.backgroundIntervalMs;
    await forge.backgroundPass();
    assert.equal(runner.requests.length, 2);
  } finally {
    fixture.db.close();
  }
  const crowded = forgeFixture(PROTOCOL_VERSION, Array.from({ length: 16 }, (_, index) => ({ ...PR, number: index + 1 })));
  try {
    const second = crowded.svc.recordCampaignPlan(crowded.root, { items: [{ key: "more" }, { key: "most" }], planComplete: true });
    for (const [offset, entry] of second.data!.items.entries()) {
      assert.ok(crowded.svc.updateCampaignWorkItem(crowded.root, {
        workItemId: entry.workItemId,
        stage: { stage: "in_review", pullRequests: Array.from({ length: 16 }, (_, index) => ({ ...PR, number: 100 * (offset + 1) + index })) },
      }).ok);
    }
    const runner = fakeRunner(allOk());
    await observer(crowded, runner).backgroundPass();
    const read = runner.requests.reduce((sum, request) => sum + request.pullRequests.length, 0);
    assert.equal(read, CAMPAIGN_FORGE_OBSERVATION.backgroundRefsPerTick, "one pass reads at most its bound");
  } finally {
    crowded.db.close();
  }
});

test("forge facts need campaign access and access to the observing runner, and never reach session views", async () => {
  const fixture = forgeFixture();
  const { db, root, itemId, ownBy } = fixture;
  ownBy("session_ownership", root, "alice");
  ownBy("runner_ownership", RUNNER_ID, "alice");
  const child = "forge-child";
  db.createSession({ id: child, parentSessionId: root, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "child-agent",
    title: "Child", useWorktree: false, driver: "claude-code", config: {}, now: Date.now() });
  const runner = fakeRunner(allOk(observation({ reviewDecision: "approved" })));
  const forge = observer(fixture, runner);
  const principals: Record<string, AuthPrincipal> = {
    alice: human("alice"), bob: human("bob"), orchestrator: agent(root, true), childAgent: agent(child, false),
  };
  const app = Fastify();
  registerCampaignStatusRoutes(app, {
    db,
    requestPrincipal: (req) => principals[String(req.headers["x-test-principal"])] ?? null,
    refreshForge: (campaignId, refs) => forge.refresh(campaignId, refs),
  });
  await app.ready();
  const call = async <T>(who: string, method: "GET" | "POST", url: string) => {
    const response = await app.inject({ method, url, headers: { "x-test-principal": who } });
    return { status: response.statusCode, body: response.json() as T };
  };
  const detailUrl = `/api/sessions/${root}/campaign/work-items/${itemId}`;
  const refreshUrl = `${detailUrl}/forge-refresh`;
  try {
    // Before any read: unavailable, not passing.
    let alice = await call<CampaignWorkItemDetailResponse>("alice", "GET", detailUrl);
    assert.deepEqual(alice.body.item.observed.pullRequests, [{ ref: PR, fact: { availability: "unavailable", reason: "not_observed" } }]);

    // Bob shares the campaign session but not the runner whose `gh` reads it.
    ownBy("session_ownership", root, "bob");
    assert.equal((await call("bob", "POST", refreshUrl)).status, 403, "no runner access, no forge read");
    assert.equal(runner.requests.length, 0, "a refused refresh never reaches the runner");
    ownBy("session_ownership", root, "alice");

    const refreshed = await call<CampaignForgeRefreshResponse>("alice", "POST", refreshUrl);
    assert.equal(refreshed.status, 200);
    assert.equal(runner.requests.length, 1);
    assert.equal(refreshed.body.pullRequests[0]!.fact.availability, "fresh");
    alice = await call<CampaignWorkItemDetailResponse>("alice", "GET", detailUrl);
    const fact = alice.body.item.observed.pullRequests![0]!.fact;
    assert.ok(fact.availability === "fresh" && fact.value.reviewDecision === "approved" && fact.value.headSha === HEAD);
    // Reported and observed stay separate fields: the stage is the Orchestrator's claim.
    assert.equal(alice.body.item.stage?.stage, "merge_queued");
    assert.equal(alice.body.item.stage?.sourceSessionId, root);
    assert.equal(alice.body.item.primaryState, "planned", "an observed merge-queue wait never delivers an item");

    ownBy("session_ownership", root, "bob");
    const bob = await call<CampaignWorkItemDetailResponse>("bob", "GET", detailUrl);
    assert.equal(bob.status, 200, "bob still reads the campaign");
    assert.deepEqual(bob.body.item.observed.pullRequests, [{ ref: PR, fact: { availability: "unavailable", reason: "not_authorized" } }],
      "the reference stays visible; the fact and any last value do not");
    assert.equal(bob.body.item.stage?.stage, "merge_queued", "reported stages stay visible to every campaign reader");
    assert.ok(!JSON.stringify(bob.body).includes(HEAD));
    ownBy("session_ownership", root, "alice");

    const orchestrator = await call<CampaignWorkItemDetailResponse>("orchestrator", "GET", detailUrl);
    assert.equal(orchestrator.body.item.observed.pullRequests![0]!.fact.availability, "fresh", "the campaign's Orchestrator sees them");
    assert.equal((await call("orchestrator", "POST", refreshUrl)).status, 200);
    assert.equal((await call("childAgent", "POST", refreshUrl)).status, 403);
    assert.equal((await call("childAgent", "GET", detailUrl)).status, 403);
    assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions/:id/campaign/work-items/:itemId/forge-refresh", "orchestrator"), true);
    assert.equal(isAgentControlApiRouteAllowed("POST", "/api/sessions/:id/campaign/work-items/:itemId/forge-refresh", "default"), false);

    // The Orchestrator's own ledger read carries them; session views and their per-principal
    // projections, which hub upserts and command responses share, never do.
    const own = fixture.svc.campaignWorkItems(root, { workItemId: itemId });
    assert.equal(own.data?.item?.observed.pullRequests?.[0]?.fact.availability, "fresh");
    const view = db.getSession(root)!;
    for (const principal of Object.values(principals)) {
      const projected: SessionView = withSessionCommandPermissions(db, principal, view);
      assert.ok(!JSON.stringify(projected).includes(HEAD), `no forge fact in ${principal.actorId}'s session view`);
    }
    assert.ok(!JSON.stringify(view).includes(HEAD));
    // A ledger write re-sends the root view; it still carries no forge fact.
    assert.ok(fixture.svc.updateCampaignWorkItem(root, { workItemId: itemId, nextAction: "Wait for the queue." }).ok);
    assert.ok(!JSON.stringify(db.getSession(root)).includes(HEAD));
  } finally {
    await app.close();
    db.close();
  }
});

test("a forge change moves the revision once per coalescing window and refreshes the root", async () => {
  const fixture = forgeFixture();
  try {
    const refreshed: string[] = [];
    const observations = new CampaignWorkObservations({
      db: fixture.db, refresh: (id) => refreshed.push(id), warn: () => undefined, delayMs: 60_000,
    });
    let now = Date.now();
    const runner = fakeRunner((message) => allOk(observation({ mergeQueue: { state: "queued", position: now % 7 } }))(message));
    const forge = observer(fixture, runner, { now: () => now, changed: (id) => observations.forgeChanged(id) });
    const revision = fixture.db.campaignWorkLedger.revision(fixture.root);
    await forge.refresh(fixture.root, [PR]);
    now += CAMPAIGN_FORGE_OBSERVATION.minIntervalMs + 1;
    await forge.refresh(fixture.root, [PR]);
    observations.flush();
    assert.equal(fixture.db.campaignWorkLedger.revision(fixture.root), revision + 1, "two changes, one revision");
    assert.deepEqual(refreshed, [fixture.root]);
    observations.dispose();
  } finally {
    fixture.db.close();
  }
});

test("a failed read waits the background interval like a successful one, and the refresh route is a read for viewers", async () => {
  const fixture = forgeFixture();
  try {
    let now = Date.now();
    const runner = fakeRunner(() => ({ ok: false, failure: "forge_rate_limited" }));
    const forge = observer(fixture, runner, { now: () => now });
    await forge.backgroundPass();
    assert.equal(runner.requests.length, 1);
    now += CAMPAIGN_FORGE_OBSERVATION.backgroundTickMs;
    await forge.backgroundPass();
    assert.equal(runner.requests.length, 1, "a rate-limited pull request is not retried every tick");
    now += CAMPAIGN_FORGE_OBSERVATION.backgroundIntervalMs;
    await forge.backgroundPass();
    assert.equal(runner.requests.length, 2);
  } finally {
    fixture.db.close();
  }
  const { mutationAuthorizationError } = await import("./identity.js");
  const viewer = { ...human("vera"), role: "viewer" as const };
  assert.equal(mutationAuthorizationError("POST", "/api/sessions/:id/campaign/work-items/:itemId/forge-refresh", viewer), null);
  assert.notEqual(mutationAuthorizationError("POST", "/api/sessions/:id/orchestrator-campaign/plan", viewer), null,
    "only the read-only refresh is exempt");
});
