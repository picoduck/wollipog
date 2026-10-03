/**
 * Campaign Status Read API (#2417 slice 5): the projection summary, membership, observed facts and
 * their invalidation, and the browser routes with their authorization and cost visibility.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  CAMPAIGN_WORK_REVISION_CHANGED,
  PROTOCOL_VERSION,
  type CampaignCostValue,
  type CampaignMetric,
  type CampaignWorkItemDetail,
  type CampaignWorkItemDetailResponse,
  type CampaignWorkItemsPage,
  type CampaignRecommendationsPage,
  type CampaignWorkSummary,
  type CampaignWorkSummaryResponse,
  type ControlPlaneToUi,
  type RunnerMetadata,
  type SessionView,
} from "@wollipog/protocol";
import { isAgentControlApiRouteAllowed } from "./auth.js";
import {
  campaignSummaryForPrincipal,
  registerCampaignStatusRoutes,
  workItemForPrincipal,
} from "./campaign-status-routes.js";
import { CampaignWorkObservations } from "./campaign-work-observation.js";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { AgentPrincipal, AuthPrincipal, HumanPrincipal } from "./identity.js";
import { withSessionCommandPermissions } from "./session-command-permissions.js";
import { SessionsService } from "./sessions.js";

const RUNNER_ID = "campaign-status-runner";
const WORKSPACE_ID = "campaign-status-workspace";
const ORG = "org_personal";

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID,
    hostname: "host",
    os: "linux",
    version: "1.0.0",
    workspaces: [{ id: WORKSPACE_ID, name: "Demo", path: "/tmp/campaign-status" }],
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

/** A real database and service behind a hub that records refreshes and forwards every upsert and
 * removal to its session observers, as the real hub does. */
function campaignFixture() {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const refreshed: string[] = [];
  const observers: Array<{ changed(id: string): void; removed(id: string): void }> = [];
  const hubImpl = {
    isRunnerOnline: () => true,
    sendToRunner: () => true,
    observeSessions: (observer: (typeof observers)[number]) => observers.push(observer),
    sessionChanged: (session: SessionView) => { for (const observer of observers) observer.changed(session.id); },
    sessionChangedById: (id: string) => {
      refreshed.push(id);
      for (const observer of observers) observer.changed(id);
    },
    sessionRemoved: (id: string) => { for (const observer of observers) observer.removed(id); },
  };
  const hub = new Proxy(hubImpl, {
    get(target, key: string) {
      return key in target ? target[key as keyof typeof target] : () => undefined;
    },
  }) as unknown as Hub;
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const decisions = {
    implementation_question: "human", pr_merge: "human", merged_branch_deletion: "human",
    follow_up_issue_publication: "human", ui_evidence_approval: "human",
  } as const;
  const createRoot = (title: string) => {
    const created = svc.createSession({
      runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "test-orchestrator", title,
      config: { permissionMode: "orchestrator" }, prompt: "Orchestrate.",
      orchestrator: { behavior: { completion: "retain" } },
    }, undefined, undefined, false, false, false, {
      defaultOwnerUserId: "owner",
      orchestratorDefaults: {
        source: "user_default",
        defaults: {
          behavior: {
            childHarness: null, childModel: null, childEffort: null,
            maximumConcurrentChildren: 4, followUps: "recommend_only", completion: "retain",
          },
          delegation: { parentControl: "off", decisions: { ...decisions } },
          execution: { strictProjectIsolation: false, integrationIsolation: false },
        },
        capabilities: { models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available" },
      },
      validateOrchestratorDefaults: () => null,
    });
    assert.ok(created.ok && created.data, String(created.error));
    db.updateSessionStatus(created.data.id, "running", Date.now());
    return created.data.id;
  };
  const root = createRoot("Campaign Root");
  let sequence = 0;
  const child = (parentSessionId: string, title: string, orchestrator = false) => {
    const id = `child-${++sequence}`;
    db.createSession({
      id, parentSessionId, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID,
      agentId: orchestrator ? "test-orchestrator" : "child-agent", title, useWorktree: false, driver: "claude-code",
      config: {}, now: Date.now() + sequence,
      ...(orchestrator ? { role: "orchestrator" as const, orchestratorPolicy: db.getSession(root)!.orchestratorPolicy! } : {}),
    });
    db.updateSessionStatus(id, "running", Date.now());
    return id;
  };
  /** Give a session to one user, so access can differ between sessions of one campaign. */
  const ownBy = (sessionId: string, userId: string) => {
    db.raw().prepare(
      `INSERT INTO session_ownership (session_id, organization_id, owner_kind, owner_id, created_at, updated_at)
       VALUES (?, ?, 'user', ?, 1, 1)
       ON CONFLICT(session_id) DO UPDATE SET organization_id=excluded.organization_id,
         owner_kind='user', owner_id=excluded.owner_id`,
    ).run(sessionId, ORG, userId);
  };
  return { db, svc, root, child, createRoot, ownBy, observers, refreshed };
}

function human(userId: string, role: HumanPrincipal["role"] = "operator"): HumanPrincipal {
  return {
    kind: "human", actorId: userId, userId, userName: userId, organizationId: ORG, organizationName: "Personal",
    role, deviceId: null, localBootstrap: false,
  };
}

function agent(credentialSessionId: string, orchestrator: boolean): AgentPrincipal {
  return {
    kind: "agent", actorId: `agent-${credentialSessionId}`, credentialSessionId, orchestrator,
    organizationId: ORG, delegatedScope: { organizationId: ORG, owner: { kind: "organization", organizationId: ORG } },
  };
}

/** The routes behind a principal chosen per request by the `x-test-principal` header. */
async function routes(db: ControlPlaneDb, principals: Record<string, AuthPrincipal>) {
  const app = Fastify();
  registerCampaignStatusRoutes(app, {
    db,
    requestPrincipal: (req) => principals[String(req.headers["x-test-principal"])] ?? null,
  });
  await app.ready();
  const get = async <T>(who: string, url: string) => {
    const response = await app.inject({ method: "GET", url, headers: { "x-test-principal": who } });
    return { status: response.statusCode, body: response.json() as T };
  };
  return { app, get };
}

const known = (usd: number): CampaignMetric<CampaignCostValue> =>
  ({ availability: "known", value: { usd, source: "providerReported", unpricedRecords: 0 } });

test("campaign views carry the ledger summary and descendants carry their membership (#2417)", () => {
  const { db, svc, root, child, refreshed } = campaignFixture();
  try {
    const plain = child(root, "Plain Child");
    const nested = child(root, "Nested Orchestrator", true);
    const grandchild = child(nested, "Grandchild");
    // A campaign that never recorded a plan still says so, with its children uncounted.
    let work = db.getSession(root)!.orchestratorCampaign!.work!;
    assert.equal(work.planState, "not_recorded");
    assert.equal(work.revision, 0);
    assert.deepEqual(work.coverage, { untrackedChildren: 3, predatesLedger: true });
    assert.equal(db.getSession(root)!.campaignMembership, undefined, "the root is not its own member");
    assert.deepEqual(db.getSession(plain)!.campaignMembership,
      { campaignSessionId: root, currentWorkItemId: null, currentAttemptId: null });
    assert.equal(db.getSession(nested)!.campaignMembership?.campaignSessionId, root, "a nested Orchestrator is a member");
    assert.ok(db.getSession(nested)!.orchestratorCampaign, "a nested Orchestrator still has its campaign projection");
    assert.equal(db.getSession(nested)!.orchestratorCampaign?.work, undefined,
      "but not the root's summary: its reader may not be allowed the root");
    assert.equal(db.getSession(grandchild)!.campaignMembership?.campaignSessionId, root, "membership resolves to the root");

    const plan = svc.recordCampaignPlan(root, { items: [{ key: "a" }, { key: "b" }], planComplete: true });
    assert.ok(plan.ok && plan.data, String(plan.error));
    const [a, b] = plan.data.items.map((item) => item.workItemId);
    refreshed.length = 0;
    const assigned = svc.assignCampaignWorkItem(nested, { workItemId: a!, childSessionId: grandchild });
    assert.ok(assigned.ok && assigned.data, String(assigned.error));
    assert.deepEqual(db.getSession(grandchild)!.campaignMembership,
      { campaignSessionId: root, currentWorkItemId: a, currentAttemptId: assigned.data.attempt.id });
    assert.ok(refreshed.includes(grandchild), "the assigned child's view is re-sent with its membership");
    assert.equal(refreshed.includes(plain), false, "a child whose attempt did not change is not re-sent");
    // Reassignment moves the membership with the open attempt.
    refreshed.length = 0;
    const moved = svc.assignCampaignWorkItem(nested, { workItemId: b!, childSessionId: grandchild });
    assert.ok(moved.ok && moved.data, String(moved.error));
    assert.equal(db.getSession(grandchild)!.campaignMembership?.currentWorkItemId, b);
    assert.ok(refreshed.includes(grandchild));
    work = db.getSession(root)!.orchestratorCampaign!.work!;
    assert.equal(work.planState, "recorded");
    assert.equal(work.revision, moved.data.revision);
    assert.deepEqual(work.coverage, { untrackedChildren: 2, predatesLedger: true });
    assert.deepEqual([work.counts.committed, work.counts.byState.running, work.counts.byState.planned], [2, 1, 1]);

    // An unrelated session belongs to no campaign.
    const outsider = db.createSession({
      id: "outsider", runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "child-agent", title: "Outsider",
      useWorktree: false, driver: "claude-code", config: {}, now: Date.now(),
    });
    assert.equal(db.getSession(outsider.id)!.campaignMembership, undefined);
    assert.equal(db.campaignRootForMember(outsider.id), null);
  } finally {
    db.close();
  }
});

test("the summary is cached under the revision and still follows observed status and deletion (#2417)", () => {
  const { db, svc, root, child } = campaignFixture();
  try {
    const worker = child(root, "Worker");
    const plan = svc.recordCampaignPlan(root, { items: [{ key: "only" }], planComplete: true });
    const itemId = plan.data!.items[0]!.workItemId;
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: itemId, childSessionId: worker }).ok);
    const summary = () => db.getSession(root)!.orchestratorCampaign!.work!;
    assert.equal(summary().counts.byState.running, 1);
    const revision = summary().revision;

    // No ledger write, but the observed status moved the item: the summary must not be stale.
    db.updateSessionStatus(worker, "idle", Date.now());
    assert.deepEqual([summary().counts.byState.waiting, summary().obligations.verification], [1, 1]);
    assert.equal(summary().revision, revision, "observation alone does not write the ledger");

    // Deleting the attempt's session is a new revision through the ledger's trigger, on any path.
    db.deleteSession(worker);
    assert.equal(summary().revision, revision + 1);
    assert.equal(summary().counts.byState.blocked, 1);
    const detail = db.campaignWorkLedger.detail(root, itemId, Date.now())!;
    assert.deepEqual(detail.stateCauses, ["attempt_session_unavailable"]);
    assert.deepEqual(detail.observed, {
      session: { availability: "unavailable", reason: "session_deleted" },
      cleanup: { availability: "unavailable", reason: "session_deleted" },
    });
  } finally {
    db.close();
  }
});

test("observed status changes are coalesced into one revision per campaign and re-send its views (#2417)", () => {
  const { db, svc, root, child, observers, refreshed } = campaignFixture();
  const observations = new CampaignWorkObservations({
    db,
    refresh: (campaignSessionId) => svc.campaignWorkObserved(campaignSessionId),
    warn: (message) => assert.fail(message),
    delayMs: 60_000,
  });
  observers.push({ changed: (id) => observations.sessionChanged(id), removed: (id) => observations.sessionRemoved(id) });
  try {
    const nested = child(root, "Nested", true);
    const first = child(nested, "First");
    const second = child(nested, "Second");
    const idle = child(root, "Unassigned");
    const plan = svc.recordCampaignPlan(root, { items: [{ key: "1" }, { key: "2" }], planComplete: true });
    const [one, two] = plan.data!.items.map((item) => item.workItemId);
    assert.ok(svc.assignCampaignWorkItem(nested, { workItemId: one!, childSessionId: first }).ok);
    assert.ok(svc.assignCampaignWorkItem(nested, { workItemId: two!, childSessionId: second }).ok);
    // Establish what this process has observed of each attempt session.
    observations.sessionChanged(first);
    observations.sessionChanged(second);
    observations.flush();
    const revision = db.campaignWorkLedger.revision(root);

    // A session without an attempt and an unchanged observation do nothing.
    observations.sessionChanged(idle);
    observations.sessionChanged(first);
    observations.flush();
    assert.equal(db.campaignWorkLedger.revision(root), revision);

    // Two children changing in one window cost one revision and one root refresh.
    db.updateSessionStatus(first, "idle", Date.now());
    observations.sessionChanged(first);
    db.updateSessionStatus(second, "failed", Date.now());
    observations.sessionChanged(second);
    db.updateSessionStatus(first, "input_required", Date.now());
    observations.sessionChanged(first);
    assert.equal(db.campaignWorkLedger.revision(root), revision, "the bump waits for the window");
    refreshed.length = 0;
    observations.flush();
    assert.equal(db.campaignWorkLedger.revision(root), revision + 1);
    assert.deepEqual(refreshed.filter((id) => id === root).length, 1, "the root is re-sent once");
    assert.equal(refreshed.includes(nested), false, "only the root carries the summary");
    assert.equal(db.getSession(root)!.orchestratorCampaign!.work!.revision, revision + 1);
    // Re-sending views does not feed back into another revision.
    observations.flush();
    assert.equal(db.campaignWorkLedger.revision(root), revision + 1);
  } finally {
    observations.dispose();
    db.close();
  }
});

test("deleting an attempt's session refreshes every view of its campaign, observed or not (#2417)", () => {
  const { db, svc, root, child, observers, refreshed } = campaignFixture();
  const observations = new CampaignWorkObservations({
    db,
    refresh: (campaignSessionId) => svc.campaignWorkObserved(campaignSessionId),
    warn: (message) => assert.fail(message),
    delayMs: 60_000,
  });
  observers.push({ changed: (id) => observations.sessionChanged(id), removed: (id) => observations.sessionRemoved(id) });
  try {
    const nested = child(root, "Nested", true);
    const deeper = child(nested, "Deeper", true);
    const worker = child(deeper, "Worker");
    const finished = child(root, "Finished");
    const plan = svc.recordCampaignPlan(root, { items: [{ key: "open" }, { key: "closed" }], planComplete: true });
    const [openId, closedId] = plan.data!.items.map((item) => item.workItemId);
    assert.ok(svc.assignCampaignWorkItem(deeper, { workItemId: openId!, childSessionId: worker }).ok);
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: closedId!, childSessionId: finished }).ok);
    assert.ok(svc.updateCampaignWorkItem(root, { workItemId: closedId!, endAttempt: { reason: "abandoned" } }).ok);
    observations.sessionChanged(worker);
    observations.flush();

    // An observed open attempt below two nested Orchestrators: the root carries the summary.
    let revision = db.campaignWorkLedger.revision(root);
    db.deleteSession(worker);
    observations.sessionRemoved(worker);
    refreshed.length = 0;
    observations.flush();
    assert.equal(db.campaignWorkLedger.revision(root), revision + 1, "the deletion is one revision, not two");
    assert.ok(refreshed.includes(root), "the root is re-sent");
    assert.equal(db.getSession(deeper)!.orchestratorCampaign?.work, undefined);

    // A closed attempt this process never observed, deleted on a path that publishes nothing else.
    revision = db.campaignWorkLedger.revision(root);
    db.deleteSession(finished);
    observations.sessionRemoved(finished);
    refreshed.length = 0;
    observations.flush();
    assert.equal(db.campaignWorkLedger.revision(root), revision + 1);
    assert.ok(refreshed.includes(root), "the surviving root is re-sent with its new revision");
    assert.equal(db.getSession(root)!.orchestratorCampaign!.work!.revision, revision + 1);
    // The queue is drained: an unrelated removal refreshes nothing.
    refreshed.length = 0;
    observations.sessionRemoved("unrelated");
    observations.flush();
    assert.deepEqual(refreshed, []);

    // Several attempt sessions of one campaign deleted before any drain queue it once.
    const first = child(root, "First Late");
    const second = child(root, "Second Late");
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: openId!, childSessionId: first }).ok);
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: closedId!, childSessionId: second }).ok);
    db.deleteSession(first);
    db.deleteSession(second);
    observations.sessionRemoved(second);
    refreshed.length = 0;
    observations.flush();
    assert.equal(refreshed.filter((id) => id === root).length, 1);
  } finally {
    observations.dispose();
    db.close();
  }
});

test("work-item pages stay stable within a revision and refuse a stale cursor with revision_changed (#2417)", async () => {
  const { db, svc, root, child, createRoot } = campaignFixture();
  const { app, get } = await routes(db, { owner: human("owner", "owner") });
  try {
    const member = child(root, "Member");
    const keys = ["k1", "k2", "k3", "k4", "k5"];
    svc.recordCampaignPlan(root, {
      items: keys.map((key, index) => ({ key, queuePosition: index, dispatchState: "queued" as const })),
      planComplete: true,
    });
    const base = `/api/sessions/${member}/campaign/work-items`;
    const walk = async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: { status: number; body: CampaignWorkItemsPage } =
          await get<CampaignWorkItemsPage>("owner", `${base}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        assert.equal(page.status, 200);
        seen.push(...page.body.items.map((item) => item.key));
        cursor = page.body.nextCursor;
      } while (cursor);
      return seen;
    };
    assert.deepEqual(await walk(), keys, "pages concatenate to the whole list, once each, in queue order");

    const first = await get<CampaignWorkItemsPage>("owner", `${base}?limit=2`);
    assert.equal(first.body.total, 5);
    // An insert into pages already read would shift every later page, so the cursor is refused.
    svc.recordCampaignPlan(root, { items: [{ key: "k0", queuePosition: 0, dispatchState: "queued" }], planComplete: true });
    const stale = await get<{ error: string; code: string; revision: number }>("owner",
      `${base}?limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, CAMPAIGN_WORK_REVISION_CHANGED);
    assert.equal(stale.body.revision, db.campaignWorkLedger.revision(root));
    assert.deepEqual((await walk()).sort(), ["k0", ...keys].sort(), "restarting reads the new revision whole");

    // An observed change is a revision too, so it also refuses an older cursor.
    const before = await get<CampaignWorkItemsPage>("owner", `${base}?limit=2`);
    db.campaignWorkLedger.observedChanged(root, Date.now());
    assert.equal((await get("owner", `${base}?limit=2&cursor=${encodeURIComponent(before.body.nextCursor!)}`)).status, 409);
    // Startup settlement stops mid-flight sessions without the hub; open attempts' campaigns move.
    const worker = child(root, "Worker");
    const firstItem = (await get<CampaignWorkItemsPage>("owner", `${base}?limit=1`)).body.items[0]!;
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: firstItem.id, childSessionId: worker }).ok);
    const quiet = createRoot("Quiet Campaign");
    svc.recordCampaignPlan(quiet, { items: [{ key: "idle" }], planComplete: true });
    const quietRevision = db.campaignWorkLedger.revision(quiet);
    const beforeRestart = await get<CampaignWorkItemsPage>("owner", `${base}?limit=2`);
    db.settleStartupState(Date.now());
    db.campaignWorkLedger.openAttemptsChanged(Date.now());
    assert.equal((await get("owner",
      `${base}?limit=2&cursor=${encodeURIComponent(beforeRestart.body.nextCursor!)}`)).status, 409);
    assert.equal(db.campaignWorkLedger.revision(quiet), quietRevision, "a campaign without open attempts keeps its revision");
    // A cursor is bound to its filter and sort as well as its revision.
    const current = await get<CampaignWorkItemsPage>("owner", `${base}?limit=2`);
    assert.equal((await get("owner", `${base}?limit=2&sort=activity&cursor=${encodeURIComponent(current.body.nextCursor!)}`)).status, 400);
    assert.equal((await get("owner", `${base}?limit=1000`)).status, 400);
  } finally {
    await app.close();
    db.close();
  }
});

test("Campaign Status routes authorize humans by the root and Orchestrators by their own campaign (#2417)", async () => {
  const { db, root, child, createRoot, ownBy } = campaignFixture();
  const otherRoot = createRoot("Other Campaign");
  const member = child(root, "Member");
  const orphanOwner = db.createSession({
    id: "lone", runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "child-agent", title: "Lone",
    useWorktree: false, driver: "claude-code", config: {}, now: Date.now(),
  }).id;
  for (const id of [root, member, otherRoot, orphanOwner]) ownBy(id, "alice");
  const { app, get } = await routes(db, {
    alice: human("alice"),
    bob: human("bob"),
    owner: human("owner", "owner"),
    orchestrator: agent(root, true),
    otherOrchestrator: agent(otherRoot, true),
    childAgent: agent(member, false),
  });
  try {
    const summaryOf = (id: string) => `/api/sessions/${id}/campaign/summary`;
    const ok = await get<CampaignWorkSummaryResponse>("alice", summaryOf(member));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.campaignSessionId, root, "a member resolves to its root campaign");
    assert.equal(ok.body.summary.planState, "not_recorded");
    assert.equal(ok.body.summary.cost, undefined, "cost is not collected until slice 6");
    assert.equal((await get("owner", summaryOf(root))).status, 200, "an organization owner can read every campaign");

    // Bob can open the child but not the campaign it belongs to.
    ownBy(member, "bob");
    assert.equal((await get("bob", summaryOf(member))).status, 403, "a member's reader also needs the root");
    assert.equal((await get("bob", summaryOf(root))).status, 404, "an inaccessible session is not revealed");
    assert.equal((await get("alice", summaryOf(orphanOwner))).status, 404, "a session outside every campaign has none");
    assert.equal((await get("nobody", summaryOf(root))).status, 401);

    assert.equal((await get("orchestrator", summaryOf(member))).status, 200, "an Orchestrator reads its own campaign");
    assert.equal((await get("orchestrator", `/api/sessions/${root}/campaign/work-items`)).status, 200);
    assert.equal((await get("orchestrator", `/api/sessions/${root}/campaign/recommendations`)).status, 200);
    assert.equal((await get("otherOrchestrator", summaryOf(root))).status, 403, "never another campaign");
    assert.equal((await get("childAgent", summaryOf(member))).status, 403, "a child has no ledger access");
    // Session reads and broadcasts project views per principal: the summary on the root's own view
    // follows the same rule as the routes, while the rest of the projection is unchanged.
    const rootView = db.getSession(root)!;
    assert.ok(rootView.orchestratorCampaign?.work);
    const viewFor = (principal: AuthPrincipal) => withSessionCommandPermissions(db, principal, rootView).orchestratorCampaign;
    assert.ok(viewFor(human("alice"))?.work, "a human reader of the root sees the summary");
    assert.ok(viewFor(agent(root, true))?.work, "the campaign's Orchestrator sees it");
    for (const who of [agent(member, false), agent(otherRoot, true)]) {
      const campaign = viewFor(who);
      assert.ok(campaign, "the projection itself is still served");
      assert.equal(campaign.work, undefined, "no other agent reads the ledger through a session view");
    }
    for (const path of ["summary", "work-items", "work-items/:itemId", "recommendations"]) {
      const route = `/api/sessions/:id/campaign/${path}`;
      assert.equal(isAgentControlApiRouteAllowed("GET", route, "orchestrator"), true, route);
      assert.equal(isAgentControlApiRouteAllowed("GET", route, "default"), false, route);
    }
  } finally {
    await app.close();
    db.close();
  }
});

test("live upserts never share one serialized root view between readers who may and may not see the summary (#2417)", () => {
  const { db, root, child, createRoot } = campaignFixture();
  try {
    const nested = child(root, "Nested", true);
    const otherRoot = createRoot("Other Campaign");
    // A real hub: it serializes a session upsert once per distinct permission verdict.
    const hub = new Hub(db);
    const observe = (principal: AuthPrincipal) => {
      const messages: ControlPlaneToUi[] = [];
      hub.addUiClient({ send: (data: string) => messages.push(JSON.parse(data) as ControlPlaneToUi) },
        { deviceId: null, principal, close: () => {} });
      return () => messages.filter((message) => message.type === "session_upsert" && message.session.id === root)
        .map((message) => message.type === "session_upsert" ? message.session.orchestratorCampaign?.work : undefined);
    };
    // Two Orchestrator credentials, neither able to command the root, so their verdicts on it match
    // and the hub could share one payload: one belongs to this campaign, the other does not.
    const reader = agent(nested, true);
    const outsider = agent(otherRoot, true);
    const verdict = (principal: AuthPrincipal) =>
      JSON.stringify(withSessionCommandPermissions(db, principal, db.getSession(root)!).commandPermissions);
    assert.equal(verdict(reader), verdict(outsider), "the two could share one serialized payload");
    // Either order: the first client's serialization must never be reused for the other.
    for (const order of [[reader, outsider], [outsider, reader]] as const) {
      const seen = order.map((principal) => observe(principal));
      hub.sessionChangedById(root);
      const [first, second] = seen.map((upserts) => upserts().at(-1));
      const readerWork = order[0] === reader ? first : second;
      const outsiderWork = order[0] === reader ? second : first;
      assert.ok(readerWork, "this campaign's nested Orchestrator receives the summary");
      assert.equal(outsiderWork, undefined, "another campaign's Orchestrator never receives it");
    }
  } finally {
    db.close();
  }
});

test("cost follows session access: hidden buckets and attempts read not_authorized (#2417)", async () => {
  const summary = {
    revision: 1, planState: "recorded", coverage: { untrackedChildren: 0, predatesLedger: false },
    counts: { committed: 0, delivered: 0, original: 0, followUp: 0, cancelled: 0, removed: 0,
      byState: { planned: 0, queued: 0, running: 0, waiting: 0, blocked: 0, delivered: 0, cancelled: 0, removed: 0 } },
    recommendations: { awaiting_adjudication: 0, accepted: 0, rejected: 0, deferred: 0, duplicate: 0 },
    obligations: { verification: 0, adjudication: 0, publication: 0, cleanup: 0 },
    elapsed: { startedAt: 1, endedAt: null },
    cost: { total: known(3), workItems: known(2), coordination: known(1), unattributed: known(0), attributedSince: 1 },
  } satisfies CampaignWorkSummary;
  assert.equal(campaignSummaryForPrincipal(summary, true), summary);
  const hidden = campaignSummaryForPrincipal(summary, false).cost!;
  assert.deepEqual([hidden.total, hidden.workItems, hidden.coordination, hidden.unattributed].map((metric) => metric.availability),
    ["unavailable", "unavailable", "unavailable", "unavailable"]);
  assert.equal(hidden.total.availability === "unavailable" && hidden.total.reason, "not_authorized");
  assert.equal(hidden.attributedSince, 1);

  // Through the route: Alice reads the campaign but not one attempt's session.
  const { db, svc, root, child, ownBy } = campaignFixture();
  const visible = child(root, "Visible");
  const secret = child(root, "Secret");
  for (const id of [root, visible]) ownBy(id, "alice");
  ownBy(secret, "carol");
  const plan = svc.recordCampaignPlan(root, { items: [{ key: "shared" }], planComplete: true });
  const itemId = plan.data!.items[0]!.workItemId;
  assert.ok(svc.assignCampaignWorkItem(root, { workItemId: itemId, childSessionId: visible }).ok);
  assert.ok(svc.assignCampaignWorkItem(root, { workItemId: itemId, childSessionId: secret }).ok);
  const ledger = db.campaignWorkLedger;
  const detail = ledger.detail.bind(ledger);
  // Slice 6 fills cost in; stand in for it so the visibility rule has something to hide.
  ledger.detail = (campaignId, id, now) => {
    const item = detail(campaignId, id, now)!;
    return { ...item, cost: known(5), attemptCosts: item.attempts.map((attempt) => ({ attemptId: attempt.id, cost: known(2.5) })) };
  };
  const { app, get } = await routes(db, { alice: human("alice"), owner: human("owner", "owner") });
  try {
    const url = `/api/sessions/${root}/campaign/work-items/${itemId}`;
    const alice = await get<CampaignWorkItemDetailResponse>("alice", url);
    assert.equal(alice.status, 200);
    assert.deepEqual(alice.body.item.cost, { availability: "unavailable", reason: "not_authorized" });
    assert.deepEqual(alice.body.item.attemptCosts!.map((entry) => entry.cost.availability), ["known", "unavailable"]);
    const owner = await get<CampaignWorkItemDetailResponse>("owner", url);
    assert.deepEqual(owner.body.item.cost, known(5));
    assert.equal(owner.body.revision, ledger.revision(root));
    // A deleted attempt session counts as visible to a reader of the root.
    const deleted = workItemForPrincipal({ ...owner.body.item }, [null], (id) => id === null);
    assert.deepEqual(deleted.cost, known(5));
  } finally {
    await app.close();
    db.close();
  }
});

test("summary counts exclude duplicate and rejected recommendations, and accepted blocked work stays unfinished (#2417)", async () => {
  const { db, svc, root, child } = campaignFixture();
  const { app, get } = await routes(db, { owner: human("owner", "owner") });
  try {
    const worker = child(root, "Worker");
    const plan = svc.recordCampaignPlan(root, { items: [{ key: "origin" }], planComplete: true });
    const originId = plan.data!.items[0]!.workItemId;
    const record = (title: string) => svc.recordCampaignFollowUp(root, {
      originSessionId: worker, repository: "picoduck/wollipog", title, originWorkItemIds: [originId],
    });
    const accepted = record("Needed Follow-Up");
    const duplicate = record("needed follow-up");
    const rejected = record("Speculative Idea");
    assert.equal(duplicate.data?.disposition, "duplicate");
    assert.ok(svc.adjudicateCampaignRecommendation(root, {
      recommendationId: rejected.data!.id, disposition: "rejected", reason: "Out of scope",
    }).ok);
    const acceptance = svc.adjudicateCampaignRecommendation(root, {
      recommendationId: accepted.data!.id, disposition: "accepted", reason: "Needed", resultingWorkItemKey: "followup:needed",
    });
    assert.ok(acceptance.ok && acceptance.data?.workItem, String(acceptance.error));
    const followUp = acceptance.data.workItem;
    assert.ok(svc.updateCampaignWorkItem(root, {
      workItemId: followUp.id, blocker: { reason: "Waits for a human merge decision.", responsibleActor: "human" },
    }).ok);

    const summary = (await get<CampaignWorkSummaryResponse>("owner", `/api/sessions/${root}/campaign/summary`)).body.summary;
    assert.deepEqual([summary.counts.committed, summary.counts.original, summary.counts.followUp, summary.counts.delivered],
      [2, 1, 1, 0], "only the accepted recommendation adds committed work");
    assert.deepEqual(summary.recommendations, { awaiting_adjudication: 0, accepted: 1, rejected: 1, deferred: 0, duplicate: 1 });
    assert.equal(summary.counts.byState.blocked, 1);
    assert.equal(summary.obligations.publication, 1);

    const unfinished = (await get<CampaignWorkItemsPage>("owner", `/api/sessions/${root}/campaign/work-items`)).body;
    const blocked = unfinished.items.find((item) => item.id === followUp.id);
    assert.deepEqual([blocked?.primaryState, blocked?.stateCauses], ["blocked", ["recorded_blocker"]],
      "accepted work that is blocked is listed as unfinished");
    const finished = (await get<CampaignWorkItemsPage>("owner", `/api/sessions/${root}/campaign/work-items?state=finished`)).body;
    assert.equal(finished.items.some((item) => item.id === followUp.id), false);

    const recommendations = (await get<CampaignRecommendationsPage>("owner",
      `/api/sessions/${worker}/campaign/recommendations?limit=2`)).body;
    assert.deepEqual([recommendations.total, recommendations.items.length], [3, 2]);
    assert.ok(recommendations.nextCursor);
    const rejectedOnly = (await get<CampaignRecommendationsPage>("owner",
      `/api/sessions/${root}/campaign/recommendations?disposition=rejected`)).body;
    assert.deepEqual(rejectedOnly.items.map((item) => item.id), [rejected.data!.id]);
    assert.equal((await get("owner", `/api/sessions/${root}/campaign/recommendations?disposition=bogus`)).status, 400);
  } finally {
    await app.close();
    db.close();
  }
});

test("item details keep archived and deleted children's history and report observed facts with freshness (#2417)", async () => {
  const { db, svc, root, child, refreshed } = campaignFixture();
  const { app, get } = await routes(db, { owner: human("owner", "owner") });
  try {
    const archived = child(root, "Archived Child");
    const deleted = child(root, "Deleted Child");
    const plan = svc.recordCampaignPlan(root, { items: [{ key: "kept" }, { key: "gone" }], planComplete: true });
    const [keptId, goneId] = plan.data!.items.map((item) => item.workItemId);
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: keptId!, childSessionId: archived }).ok);
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: goneId!, childSessionId: deleted }).ok);
    db.updateSessionStatus(archived, "idle", Date.now());
    const seq = db.appendEvent(archived, { kind: "agent_message", text: "Done", final: true }, Date.now()).seq;
    refreshed.length = 0;
    const verified = svc.verifyCampaignChild(root, {
      childSessionId: archived, reportEventSeq: seq, followUpsAccounted: true, workItem: { id: keptId!, outcome: "delivered" },
    });
    assert.ok(verified.ok, String(verified.error));
    assert.equal(db.getSession(archived)!.campaignMembership?.currentWorkItemId, null, "delivery closes the attempt");
    assert.ok(refreshed.includes(archived), "the child's view is re-sent without its finished assignment");

    // The delivered item still observes its closed attempt's session, including cleanup.
    const worktrees = [{ id: "wt-1", path: "/worktrees/kept", branch: "fix/kept", source: "created" as const }];
    db.raw().prepare("UPDATE sessions SET worktrees=? WHERE id=?").run(JSON.stringify(worktrees), archived);
    db.setSessionArchived(archived, true, Date.now());
    db.recordCampaignWorktreeCleanup(archived, "/worktrees/kept", "wt-1", "deferred", "the provider still holds it", Date.now());
    db.recordCampaignWorktreeCleanup(archived, "/worktrees/old", "wt-0", "pending", "earlier worktree", Date.now());
    const url = (id: string) => `/api/sessions/${root}/campaign/work-items/${id}`;
    let kept = (await get<CampaignWorkItemDetailResponse>("owner", url(keptId!))).body.item;
    assert.equal(kept.primaryState, "delivered");
    assert.equal(kept.observed.session?.availability, "fresh");
    assert.deepEqual(kept.observed.session?.availability === "fresh" && kept.observed.session.value,
      { sessionId: archived, status: "idle", archived: true, held: false, pendingRequests: 0 });
    assert.deepEqual(kept.observed.cleanup?.availability === "fresh" && kept.observed.cleanup.value.worktrees, [
      { path: "/worktrees/kept", status: "deferred", reason: "the provider still holds it" },
      { path: "/worktrees/old", status: "retired", reason: null },
    ]);
    assert.equal(kept.observed.pullRequests, undefined, "forge observations belong to slice 8");
    assert.equal(kept.times, undefined, "time metrics belong to slice 6");

    // Facts from a disconnected runner are the last known values, marked stale with their age.
    db.raw().prepare("UPDATE runners SET status='offline' WHERE runner_id=?").run(RUNNER_ID);
    kept = (await get<CampaignWorkItemDetailResponse>("owner", url(keptId!))).body.item;
    assert.equal(kept.observed.session?.availability, "stale");
    assert.equal(kept.observed.cleanup?.availability, "stale");
    db.raw().prepare("UPDATE runners SET status='online' WHERE runner_id=?").run(RUNNER_ID);

    db.deleteSession(deleted);
    const gone = (await get<CampaignWorkItemDetailResponse>("owner", url(goneId!))).body.item;
    assert.equal(gone.attempts[0]?.sessionId, null);
    assert.equal(gone.attempts[0]?.session.title, "Deleted Child", "the attempt keeps its session snapshot");
    assert.deepEqual([gone.primaryState, gone.stateCauses], ["blocked", ["attempt_session_unavailable"]]);
    assert.deepEqual(gone.observed.session, { availability: "unavailable", reason: "session_deleted" });
    kept = (await get<CampaignWorkItemDetailResponse>("owner", url(keptId!))).body.item;
    assert.deepEqual([kept.primaryState, kept.verifications[0]?.outcome], ["delivered", "delivered"],
      "archiving keeps the verification");
    assert.equal((await get("owner", url("cwi_missing"))).status, 404);
  } finally {
    await app.close();
    db.close();
  }
});
