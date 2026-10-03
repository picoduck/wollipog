/**
 * Campaign Status acceptance coverage (#2417 slice 9a).
 *
 * Each test names the #2417 acceptance criterion it proves and drives it through the production
 * wiring rather than a hub double: a real `ControlPlaneDb` with the ledger store, the real `Hub`
 * with connected dashboard clients and a scripted runner socket, `SessionsService`, the
 * `CampaignWorkObservations` invalidation exactly as `index.ts` registers it, and the browser Read
 * API routes. Assertions read what a person would see: the summary the hub broadcasts on the root
 * session, and the pages and details the routes serve.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import {
  CAMPAIGN_WORK_REVISION_CHANGED,
  PROTOCOL_VERSION,
  type CampaignWorkItemDetailResponse,
  type CampaignWorkItemPrimaryState,
  type CampaignWorkItemsPage,
  type CampaignWorkSummary,
  type CampaignWorkSummaryResponse,
  type ControlPlaneToRunner,
  type ControlPlaneToUi,
  type RunnerMetadata,
  type SessionView,
} from "@wollipog/protocol";
import { registerCampaignStatusRoutes } from "./campaign-status-routes.js";
import { CampaignWorkObservations } from "./campaign-work-observation.js";
import { ControlPlaneDb } from "./db.js";
import { Hub, type Socket } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import { SessionsService } from "./sessions.js";

const RUNNER_ID = "acceptance-runner";
const WORKSPACE_ID = "acceptance-workspace";
const ORG = "org_personal";
const REPO = "picoduck/wollipog";
const NOOP_LOG = { info() {}, warn() {}, error() {} };

function runnerMeta(): RunnerMetadata {
  return {
    runnerId: RUNNER_ID, hostname: "host", os: "linux", version: "1.0.0",
    workspaces: [{ id: WORKSPACE_ID, name: "Acceptance", path: "/tmp/campaign-acceptance" }],
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
    role: "owner", deviceId: null, localBootstrap: false,
  };
}

/** A connected dashboard: everything the hub sends it, decoded. */
class Dashboard implements Socket {
  readonly messages: ControlPlaneToUi[] = [];
  send(data: string): void {
    this.messages.push(JSON.parse(data) as ControlPlaneToUi);
  }
  /** The latest view of one session this dashboard received, from the snapshot or an upsert. */
  session(id: string): SessionView | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]!;
      if (message.type === "session_upsert" && message.session.id === id) return message.session;
      if (message.type === "snapshot") {
        const found = message.sessions.find((session) => session.id === id);
        if (found) return found;
      }
    }
    return undefined;
  }
  /** The campaign summary as this dashboard currently shows it. */
  work(rootId: string): CampaignWorkSummary {
    const work = this.session(rootId)?.orchestratorCampaign?.work;
    assert.ok(work, `the dashboard holds ${rootId}'s campaign summary`);
    return work;
  }
}

type RunnerReply = (message: ControlPlaneToRunner, hub: Hub) => void;

/**
 * One control plane: the real hub and service over an in-memory database, the observation wiring
 * from index.ts, the browser routes, a scripted runner socket, and a dashboard for the owner.
 */
async function acceptanceStack(options: { completion?: "retain" | "stop_and_archive"; prompt?: string } = {}) {
  const completion = options.completion ?? "retain";
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta(), Date.now(), PROTOCOL_VERSION);
  const hub = new Hub(db);
  const svc = new SessionsService(db, hub, NOOP_LOG);
  const warnings: string[] = [];
  const observations = new CampaignWorkObservations({
    db,
    refresh: (campaignSessionId) => svc.campaignWorkObserved(campaignSessionId),
    warn: (message) => warnings.push(message),
    delayMs: 20,
  });
  hub.observeSessions({
    changed: (sessionId) => observations.sessionChanged(sessionId),
    removed: (sessionId) => observations.sessionRemoved(sessionId),
  });

  // The runner answers only what a test scripts; everything sent is kept for inspection.
  const sentToRunner: ControlPlaneToRunner[] = [];
  let reply: RunnerReply | null = null;
  hub.attachRunner(RUNNER_ID, {
    send(data: string) {
      const message = JSON.parse(data) as ControlPlaneToRunner;
      sentToRunner.push(message);
      // requestFromRunner registers its pending entry after send() returns.
      queueMicrotask(() => reply?.(message, hub));
    },
  });

  const owner = new Dashboard();
  assert.ok(hub.addUiClient(owner, { deviceId: "device-owner", principal: human("owner"), close() {} }));

  const app = Fastify();
  registerCampaignStatusRoutes(app, { db, requestPrincipal: () => human("owner") });
  await app.ready();
  const get = async <T>(url: string) => {
    const response = await app.inject({ method: "GET", url });
    return { status: response.statusCode, body: response.json() as T };
  };

  const decisions = {
    implementation_question: "orchestrator", pr_merge: "orchestrator", merged_branch_deletion: "orchestrator",
    follow_up_issue_publication: "orchestrator", ui_evidence_approval: "orchestrator",
  } as const;
  const createRoot = (title: string) => {
    const created = svc.createSession({
      runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "orchestrator-agent", title,
      config: { permissionMode: "orchestrator" }, prompt: options.prompt ?? "Orchestrate issues 101 and 102.",
      orchestrator: { behavior: { completion } },
    }, undefined, undefined, false, false, false, {
      defaultOwnerUserId: "owner",
      orchestratorDefaults: {
        source: "user_default",
        defaults: {
          behavior: { childHarness: null, childModel: null, childEffort: null,
            maximumConcurrentChildren: 4, followUps: "execute_approved", completion },
          delegation: { parentControl: "off", decisions: { ...decisions } },
          execution: { strictProjectIsolation: false, integrationIsolation: false },
        },
        capabilities: { models: [], effortLevels: [], installations: 1, compatibleInstallations: 1, status: "available" },
      },
      validateOrchestratorDefaults: () => null,
    });
    assert.ok(created.ok && created.data, String(created.error));
    svc.onSessionStatus(created.data.id, "running");
    return created.data.id;
  };
  const root = createRoot("Acceptance Campaign");

  let sequence = 0;
  /** A child session as the runner reports it: created, then running, each through the hub. */
  const child = (parentSessionId: string, title: string, orchestrator = false) => {
    const id = `acceptance-child-${++sequence}`;
    db.createSession({
      id, parentSessionId, runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID,
      agentId: orchestrator ? "orchestrator-agent" : "child-agent", title, useWorktree: false, driver: "claude-code",
      config: orchestrator ? { permissionMode: "orchestrator" } : {}, now: Date.now() + sequence,
      ...(orchestrator ? { role: "orchestrator" as const, orchestratorPolicy: db.getSession(root)!.orchestratorPolicy! } : {}),
    });
    hub.sessionChangedById(id);
    svc.onSessionStatus(id, "running");
    return id;
  };
  /** A child's final report, as its provider appends it. */
  const report = (sessionId: string, text: string) =>
    db.appendEvent(sessionId, { kind: "agent_message", text, final: true }, Date.now()).seq;

  /** Every item of the campaign as the Read API lists it, across pages. */
  const listAll = async (id = root, query = "state=all") => {
    const items: CampaignWorkItemsPage["items"] = [];
    let cursor: string | null = null;
    let revision: number | null = null;
    do {
      const page: { status: number; body: CampaignWorkItemsPage } = await get<CampaignWorkItemsPage>(
        `/api/sessions/${id}/campaign/work-items?${query}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      assert.equal(page.status, 200, JSON.stringify(page.body));
      items.push(...page.body.items);
      revision ??= page.body.revision;
      assert.equal(page.body.revision, revision, "one walk reads one revision");
      cursor = page.body.nextCursor;
    } while (cursor);
    return { items, revision: revision! };
  };
  const byKey = async (key: string, id = root) => {
    const found = (await listAll(id)).items.find((item) => item.key === key);
    assert.ok(found, `work item ${key} is listed`);
    const detail = await get<CampaignWorkItemDetailResponse>(`/api/sessions/${id}/campaign/work-items/${found.id}`);
    assert.equal(detail.status, 200);
    return detail.body.item;
  };
  const summary = async (id = root) => {
    const response = await get<CampaignWorkSummaryResponse>(`/api/sessions/${id}/campaign/summary`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  /** Wait for the coalesced observation refresh, as a dashboard would. */
  const until = async (description: string, predicate: () => boolean) => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (predicate()) return;
      await delay(10);
    }
    assert.fail(`timed out waiting for ${description}`);
  };
  const close = async () => {
    observations.dispose();
    hub.removeUiClient(owner);
    await app.close();
    db.close();
    assert.deepEqual(warnings, [], "no observation refresh failed");
  };
  return {
    db, hub, svc, observations, owner, root, createRoot, child, report, get, listAll, byKey, summary, until, close,
    sentToRunner, setRunnerReply: (next: RunnerReply | null) => { reply = next; },
  };
}

/** The summary's per-state counts must equal what the list shows, item by item. */
function assertSummaryMatchesList(work: CampaignWorkSummary, items: readonly { primaryState: CampaignWorkItemPrimaryState }[]) {
  const counted: Partial<Record<CampaignWorkItemPrimaryState, number>> = {};
  for (const item of items) counted[item.primaryState] = (counted[item.primaryState] ?? 0) + 1;
  for (const [state, count] of Object.entries(work.counts.byState)) {
    assert.equal(counted[state as CampaignWorkItemPrimaryState] ?? 0, count, `summary and list agree on ${state}`);
  }
  const committed = items.filter((item) => item.primaryState !== "cancelled" && item.primaryState !== "removed").length;
  assert.equal(work.counts.committed, committed, "committed work is every item that was not withdrawn");
  assert.equal(work.counts.delivered, counted.delivered ?? 0);
}

test("AC1: original issues and recursive follow-ups appear before child creation, including work without a session or published issue", async () => {
  const stack = await acceptanceStack();
  const { svc, owner, root, child, byKey, listAll, close } = stack;
  try {
    // Before any child exists, the plan already lists the original scope.
    assert.equal(owner.work(root).planState, "not_recorded");
    const plan = svc.recordCampaignPlan(root, {
      items: [
        { key: `${REPO}#101`, title: "Original Issue", issue: { repository: REPO, number: 101 }, dispatchState: "queued", queuePosition: 1 },
        { key: `${REPO}#102`, title: "Second Original Issue", issue: { repository: REPO, number: 102 }, dispatchState: "queued",
          queuePosition: 2, dependsOnKeys: [`${REPO}#101`] },
        { key: "plan:design-notes", title: "Planned Slice Without an Issue", queuePosition: 3 },
      ],
      planComplete: true,
    });
    assert.ok(plan.ok && plan.data, String(plan.error));
    let work = owner.work(root);
    assert.deepEqual([work.planState, work.counts.committed, work.counts.original, work.counts.followUp], ["recorded", 3, 3, 0],
      "the dashboard shows the original scope as soon as it is recorded");
    assert.deepEqual([work.counts.byState.queued, work.counts.byState.planned], [2, 1]);
    const planned = await byKey("plan:design-notes");
    assert.deepEqual([planned.primaryState, planned.issue, planned.currentAttempt, planned.attempts.length],
      ["planned", null, null, 0], "planned work with no issue and no session is listed");

    // A child on the first issue recommends a follow-up; it is accepted (generation 1).
    const worker = child(root, "Issue 101");
    const sentBefore = stack.sentToRunner.length;
    const firstId = plan.data.items[0]!.workItemId;
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: firstId, childSessionId: worker }).ok);
    const recommend = (title: string, originWorkItemIds: string[]) => svc.recordCampaignFollowUp(root, {
      originSessionId: worker, repository: REPO, title, originWorkItemIds,
    });
    const generationOne = recommend("Generation One Follow-Up", [firstId]);
    assert.ok(generationOne.ok && generationOne.data, String(generationOne.error));
    const acceptedOne = svc.adjudicateCampaignRecommendation(root, {
      recommendationId: generationOne.data.id, disposition: "accepted", reason: "Needed", resultingWorkItemKey: "followup:one",
    });
    assert.ok(acceptedOne.ok && acceptedOne.data?.workItem, String(acceptedOne.error));
    // A follow-up of that follow-up, recorded before anything was dispatched for either (generation 2).
    const generationTwo = recommend("Generation Two Follow-Up", [acceptedOne.data.workItem.id]);
    const acceptedTwo = svc.adjudicateCampaignRecommendation(root, {
      recommendationId: generationTwo.data!.id, disposition: "accepted", reason: "Needed too", resultingWorkItemKey: "followup:two",
    });
    assert.ok(acceptedTwo.ok && acceptedTwo.data?.workItem, String(acceptedTwo.error));

    work = owner.work(root);
    assert.deepEqual([work.counts.committed, work.counts.original, work.counts.followUp], [5, 3, 2],
      "every generation of accepted follow-up counts as committed work on the live summary");
    assert.equal(work.obligations.publication, 2, "neither follow-up has a published issue yet");
    for (const [key, generation, originKey] of [["followup:one", 1, `${REPO}#101`], ["followup:two", 2, "followup:one"]] as const) {
      const item = await byKey(key);
      assert.deepEqual([item.origin, item.generation, item.primaryState], ["follow_up", generation, "planned"]);
      assert.deepEqual([item.issue, item.currentAttempt, item.attempts.length], [null, null, 0],
        `${key} is visible with no child session and no published issue`);
      assert.equal(item.sourceRecommendation?.publication, "awaiting_publication");
      assert.deepEqual(item.sourceRecommendation?.originWorkItemIds, [(await byKey(originKey)).id], "its lineage is recorded");
    }
    const { items } = await listAll();
    assertSummaryMatchesList(owner.work(root), items);
    assert.equal(stack.sentToRunner.length, sentBefore,
      "assigning, recommending, and accepting follow-ups sent the runner nothing: no child was dispatched");
  } finally {
    await close();
  }
});

test("AC2: a missing plan and partial historical coverage are explicit on the live summary and after a reconnect", async () => {
  const stack = await acceptanceStack();
  const { svc, hub, owner, root, child, db, close } = stack;
  try {
    const first = child(root, "Pre-Ledger Child");
    child(root, "Another Pre-Ledger Child");
    // A follow-up recorded the old way, before the campaign had any ledger state.
    db.raw().prepare(
      `INSERT INTO orchestrator_campaign_follow_ups
       (id, campaign_session_id, origin_session_id, repository, title, normalized_key, duplicate_of, created_at)
       VALUES ('followup_legacy', ?, ?, ?, 'Legacy Idea', 'legacy-idea', NULL, 1)`,
    ).run(root, first, REPO);
    hub.sessionChangedById(root);
    let work = owner.work(root);
    assert.deepEqual([work.planState, work.revision, work.counts.committed], ["not_recorded", 0, 0],
      "no plan reads Plan Not Recorded, never an empty plan");
    assert.deepEqual(work.coverage, { untrackedChildren: 2, predatesLedger: true });
    assert.equal(work.recommendations.awaiting_adjudication, 1, "earlier follow-ups still count");

    const partial = svc.recordCampaignPlan(root, { items: [{ key: "known" }], planComplete: false });
    assert.ok(partial.ok && partial.data);
    work = owner.work(root);
    assert.deepEqual([work.planState, work.coverage.untrackedChildren], ["partial", 2]);
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: partial.data.items[0]!.workItemId, childSessionId: first }).ok);
    assert.ok(svc.recordCampaignPlan(root, { items: [], planComplete: true }).ok);
    work = owner.work(root);
    assert.deepEqual([work.planState, work.coverage.untrackedChildren, work.coverage.predatesLedger], ["recorded", 1, true],
      "a recorded plan still says one child is outside it and history may predate the ledger");

    // A dashboard that reconnects receives the same facts in its snapshot.
    const reconnected = new Dashboard();
    assert.ok(hub.addUiClient(reconnected, { deviceId: "device-owner-2", principal: human("owner"), close() {} }));
    assert.deepEqual(reconnected.work(root), owner.work(root));
    hub.removeUiClient(reconnected);
    assert.deepEqual((await stack.summary(first)).summary, owner.work(root), "a member's summary route agrees");
  } finally {
    await close();
  }
});

test("AC3: duplicate, rejected, deferred, and unadjudicated recommendations leave committed totals unchanged; accepted blocked or waiting work stays unfinished", async () => {
  const stack = await acceptanceStack();
  const { svc, owner, root, child, byKey, listAll, get, close } = stack;
  try {
    const plan = svc.recordCampaignPlan(root, {
      items: [{ key: "origin", dispatchState: "queued" }, { key: "foundation", dispatchState: "queued" }], planComplete: true,
    });
    const [originId, foundationId] = plan.data!.items.map((item) => item.workItemId);
    const worker = child(root, "Origin Worker");
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: originId!, childSessionId: worker }).ok);
    const committedBefore = owner.work(root).counts.committed;
    const recommend = (title: string) => svc.recordCampaignFollowUp(root, {
      originSessionId: worker, repository: REPO, title, originWorkItemIds: [originId!],
    }).data!;
    const accepted = recommend("Needed Follow-Up");
    const waiting = recommend("Needs a Decision");
    const duplicate = recommend("needed follow-up");
    const rejected = recommend("Speculative Idea");
    const deferred = recommend("Later Idea");
    recommend("Not Yet Adjudicated");
    assert.equal(duplicate.disposition, "duplicate", "the server deduplicates by normalized title");
    assert.ok(svc.adjudicateCampaignRecommendation(root, { recommendationId: rejected.id, disposition: "rejected", reason: "Out of scope" }).ok);
    assert.ok(svc.adjudicateCampaignRecommendation(root, { recommendationId: deferred.id, disposition: "deferred", reason: "Next quarter" }).ok);
    let work = owner.work(root);
    assert.equal(work.counts.committed, committedBefore, "no unaccepted recommendation inflates committed work");
    assert.deepEqual(work.recommendations, { awaiting_adjudication: 3, accepted: 0, rejected: 1, deferred: 1, duplicate: 1 });
    assert.equal(work.obligations.adjudication, 3);

    // Accepted work blocked by a blocked dependency, and accepted work waiting on a decision.
    const blockedItem = svc.adjudicateCampaignRecommendation(root, {
      recommendationId: accepted.id, disposition: "accepted", reason: "Needed", resultingWorkItemKey: "followup:blocked",
    }).data!.workItem!;
    assert.ok(svc.updateCampaignWorkItem(root, { workItemId: foundationId!,
      blocker: { reason: "Waiting for the platform team.", responsibleActor: "external" } }).ok);
    assert.ok(svc.updateCampaignWorkItem(root, { workItemId: blockedItem.id, dependsOn: [foundationId!], dispatchState: "queued" }).ok);
    const waitingItem = svc.adjudicateCampaignRecommendation(root, {
      recommendationId: waiting.id, disposition: "accepted", reason: "Needed", resultingWorkItemKey: "followup:waiting",
    }).data!.workItem!;
    const asker = child(root, "Asks a Question");
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: waitingItem.id, childSessionId: asker }).ok);
    const question = svc.createWorkflowDecision(asker, {
      requestId: "which-approach", resourceKey: "which-approach",
      resourceSnapshot: { category: "implementation_question", question: "Which approach?",
        options: [{ optionId: "a", label: "Option A", description: "First." }, { optionId: "b", label: "Option B", description: "Second." }] },
    });
    assert.ok(question.ok, String(question.error));
    await stack.until("the decision moves the item to waiting", () => owner.work(root).counts.byState.waiting === 1);

    work = owner.work(root);
    assert.deepEqual([work.counts.committed, work.counts.followUp, work.counts.delivered], [committedBefore + 2, 2, 0]);
    const blocked = await byKey("followup:blocked");
    assert.deepEqual([blocked.primaryState, blocked.stateCauses], ["blocked", ["dependency_blocked"]]);
    const asking = await byKey("followup:waiting");
    // Raising the decision puts the child in input_required, which the derivation checks first.
    assert.deepEqual([asking.primaryState, asking.stateCauses], ["waiting", ["attempt_session_input_required"]]);
    const unfinished = (await get<CampaignWorkItemsPage>(`/api/sessions/${root}/campaign/work-items?limit=100`)).body.items;
    assert.ok([blocked.id, asking.id].every((id) => unfinished.some((item) => item.id === id)),
      "accepted blocked and waiting work is listed as unfinished");
    const finished = (await get<CampaignWorkItemsPage>(`/api/sessions/${root}/campaign/work-items?state=finished`)).body.items;
    assert.equal(finished.length, 0);
    assertSummaryMatchesList(work, (await listAll()).items);
  } finally {
    await close();
  }
});

test("AC4: a child delivers A and is reassigned to B; A keeps its verification and attempt, B gets its own, and later execution never invalidates A", async () => {
  const stack = await acceptanceStack();
  const { db, svc, owner, root, child, report, byKey, close } = stack;
  try {
    const plan = svc.recordCampaignPlan(root, {
      items: [{ key: "item:a", title: "Item A", dispatchState: "queued" }, { key: "item:b", title: "Item B", dispatchState: "queued" }],
      planComplete: true,
    });
    const [aId, bId] = plan.data!.items.map((item) => item.workItemId);
    const reused = child(root, "Reused Child");
    const attemptA = svc.assignCampaignWorkItem(root, { workItemId: aId!, childSessionId: reused });
    assert.ok(attemptA.ok && attemptA.data, String(attemptA.error));
    svc.onSessionStatus(reused, "idle");
    const reportA = report(reused, "A is delivered.");
    const verifiedA = svc.verifyCampaignChild(root, {
      childSessionId: reused, reportEventSeq: reportA, followUpsAccounted: true, workItem: { id: aId!, outcome: "delivered" },
    });
    assert.ok(verifiedA.ok, String(verifiedA.error));
    const deliveredA = await byKey("item:a");
    assert.equal(deliveredA.primaryState, "delivered");
    assert.equal(owner.work(root).counts.delivered, 1);

    // The same child runs again for B: a new turn, a new report, a separate attempt.
    db.appendEvent(reused, { kind: "user_message", text: "Now deliver item B." }, Date.now());
    svc.onSessionStatus(reused, "running");
    const attemptB = svc.assignCampaignWorkItem(root, { workItemId: bId!, childSessionId: reused });
    assert.ok(attemptB.ok && attemptB.data, String(attemptB.error));
    assert.notEqual(attemptB.data.attempt.id, attemptA.data.attempt.id);
    assert.equal(attemptB.data.attempt.ordinal, 1, "B's first attempt is its own, not A's second");
    assert.equal(db.getSession(reused)!.campaignMembership?.currentWorkItemId, bId);
    assert.equal(owner.session(reused)?.campaignMembership?.currentWorkItemId, bId, "the dashboard follows the reassignment");
    assert.equal(db.campaignChildReportVerified(root, reused), false,
      "the later execution invalidates the session-level verification, as it always has");
    let a = await byKey("item:a");
    assert.deepEqual([a.primaryState, a.attempts.length, a.attempts[0]?.endReason, a.verifications.length],
      ["delivered", 1, "delivered", 1], "but not A's work-item verification or attempt");
    assert.equal(a.verifications[0]?.report.seq, reportA);
    assert.equal(a.verifications[0]?.attemptId, attemptA.data.attempt.id);
    assert.equal((await byKey("item:b")).primaryState, "running");

    svc.onSessionStatus(reused, "idle");
    const reportB = report(reused, "B is delivered.");
    assert.ok(svc.verifyCampaignChild(root, {
      childSessionId: reused, reportEventSeq: reportB, followUpsAccounted: true, workItem: { id: bId!, outcome: "delivered" },
    }).ok);
    const b = await byKey("item:b");
    assert.deepEqual([b.primaryState, b.attempts.length, b.verifications[0]?.report.seq, b.verifications[0]?.attemptId],
      ["delivered", 1, reportB, attemptB.data.attempt.id]);
    a = await byKey("item:a");
    assert.deepEqual([a.verifications.length, a.verifications[0]?.report.seq], [1, reportA], "A's evidence is unchanged");
    await stack.until("the summary counts both deliveries", () => owner.work(root).counts.delivered === 2);
    assert.equal(owner.work(root).obligations.verification, 0);
  } finally {
    await close();
  }
});

test("AC5: archiving and deleting a child through the service preserves work-item history and refreshes the live summary", async () => {
  const stack = await acceptanceStack();
  const { db, svc, owner, root, child, report, byKey, close } = stack;
  try {
    const plan = svc.recordCampaignPlan(root, {
      items: [{ key: "archived", dispatchState: "queued" }, { key: "deleted", dispatchState: "queued" }], planComplete: true,
    });
    const [archivedItem, deletedItem] = plan.data!.items.map((item) => item.workItemId);
    const archivedChild = child(root, "Archived Child");
    const deletedChild = child(root, "Deleted Child");
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: archivedItem!, childSessionId: archivedChild }).ok);
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: deletedItem!, childSessionId: deletedChild }).ok);
    const followUp = svc.recordCampaignFollowUp(root, {
      originSessionId: deletedChild, repository: REPO, title: "Raised by the Deleted Child", originWorkItemIds: [deletedItem!],
    });
    assert.ok(followUp.ok);
    svc.onSessionStatus(archivedChild, "completed");
    const seq = report(archivedChild, "Delivered before archive.");
    assert.ok(svc.verifyCampaignChild(root, {
      childSessionId: archivedChild, reportEventSeq: seq, followUpsAccounted: true, workItem: { id: archivedItem!, outcome: "delivered" },
    }).ok);
    const archived = svc.setArchived(archivedChild, true);
    assert.ok(archived.ok && archived.data?.archived, String(archived.error));
    const kept = await byKey("archived");
    assert.deepEqual([kept.primaryState, kept.verifications[0]?.outcome, kept.attempts[0]?.sessionId], ["delivered", "delivered", archivedChild]);
    assert.equal(kept.observed.session?.availability === "fresh" && kept.observed.session.value.archived, true);

    const revision = owner.work(root).revision;
    const deleted = svc.delete(deletedChild);
    assert.ok(deleted.ok, String(deleted.error));
    assert.ok(!db.getSession(deletedChild));
    await stack.until("the deletion's revision reaches the dashboard", () => owner.work(root).revision > revision);
    const gone = await byKey("deleted");
    assert.deepEqual([gone.primaryState, gone.stateCauses], ["blocked", ["attempt_session_unavailable"]],
      "the item is not silently finished or erased");
    assert.deepEqual([gone.attempts[0]?.sessionId, gone.attempts[0]?.session.title], [null, "Deleted Child"],
      "the attempt keeps its session snapshot");
    assert.deepEqual(gone.observed.session, { availability: "unavailable", reason: "session_deleted" });
    assert.deepEqual(gone.recommendations.map((recommendation) => [recommendation.id, recommendation.originSessionId]),
      [[followUp.data!.id, null]], "its recommendation outlives it");
    const after = owner.work(root);
    assert.deepEqual([after.counts.committed, after.counts.delivered, after.counts.byState.blocked], [2, 1, 1]);
  } finally {
    await close();
  }
});

test("AC6: delivery requires work-item verification; idleness, completion, a merged or merge-queued stage, an approved merge, and a closed issue never satisfy it", async () => {
  const stack = await acceptanceStack({ prompt: "Orchestrate issue 101." });
  const { db, svc, owner, root, child, report, byKey, setRunnerReply, close } = stack;
  try {
    const plan = svc.recordCampaignPlan(root, {
      items: [{ key: `${REPO}#101`, issue: { repository: REPO, number: 101 }, dispatchState: "queued" }], planComplete: true,
    });
    const itemId = plan.data!.items[0]!.workItemId;
    const worker = child(root, "Implements 101");
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: itemId, childSessionId: worker }).ok);
    const state = async () => {
      const item = await byKey(`${REPO}#101`);
      return [item.primaryState, item.stateCauses];
    };

    svc.onSessionStatus(worker, "idle");
    assert.deepEqual(await state(), ["waiting", ["attempt_awaiting_verification"]], "idle is not delivered");
    await stack.until("the dashboard counts the owed verification", () => owner.work(root).obligations.verification === 1);

    // The child asks to merge, the Orchestrator approves, and the Orchestrator reports the queue.
    const headSha = "d".repeat(40);
    const merge = svc.createWorkflowDecision(worker, {
      requestId: "merge-101", resourceKey: `${REPO}#9101`,
      resourceSnapshot: { category: "pr_merge", repository: REPO, pullRequest: 9101, headSha, reviewResult: "merge",
        requiredChecks: { headSha, status: "passed", checkedAt: Date.now(),
          checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" }] } },
    });
    assert.ok(merge.ok && merge.data, String(merge.error));
    assert.equal(merge.data.authority, "orchestrator");
    const approved = svc.resolveWorkflowDecision(root, worker, merge.data.occurrenceId, { outcome: "approve" }, "orchestrator",
      { kind: "agent", id: root }, () => true);
    assert.ok(approved.ok, String(approved.error));
    for (const stage of ["merge_queued", "merged"] as const) {
      assert.ok(svc.updateCampaignWorkItem(root, { workItemId: itemId,
        stage: { stage, pullRequests: [{ repository: REPO, number: 9101 }] } }).ok);
      assert.notEqual((await state())[0], "delivered", `a reported ${stage} stage is not delivered`);
    }

    // A human closes the issue through the real closure flow; the runner reports it closed.
    setRunnerReply((message, hub) => {
      if (message.type !== "github_issue_closure") return;
      hub.resolveRunnerRequest(message.operation === "inspect"
        ? { type: "github_issue_closure_result", requestId: message.requestId, sessionId: root, ok: true,
          inspection: { repository: REPO, issue: message.issue, title: "Issue 101", url: `https://github.com/${REPO}/issues/101`,
            state: "OPEN", forgeDigest: "e".repeat(64), openPullRequests: [] } }
        : { type: "github_issue_closure_result", requestId: message.requestId, sessionId: root, ok: true,
          result: { outcome: "closed", completedAt: Date.now() } });
    });
    const closure = await svc.requestGithubIssueClosure(root, {
      requestId: "close-101", issue: 101, reason: "completed", explanation: "Implemented.", evidence: ["Merged in #9101."],
    });
    assert.ok(closure.ok && closure.data?.decision, String(closure.error));
    assert.ok(svc.approve(root, closure.data.decision.occurrenceId, "approve", { kind: "human", id: "owner" }).ok);
    const closed = await svc.executeGithubIssueClosure(root, closure.data.decision.occurrenceId, closure.data.decision.resourceDigest);
    assert.ok(closed.ok, String(closed.error));
    assert.equal(closed.data?.issueClosureResult?.outcome, "closed");
    assert.notEqual((await state())[0], "delivered", "a closed issue is not delivered");

    svc.onSessionStatus(worker, "completed");
    assert.deepEqual(await state(), ["waiting", ["attempt_awaiting_verification"]], "a completed session is not delivered");
    const seq = report(worker, "Issue 101 is done.");
    assert.ok(svc.verifyCampaignChild(root, { childSessionId: worker, reportEventSeq: seq, followUpsAccounted: true }).ok);
    assert.equal(db.campaignChildReportVerified(root, worker), true);
    assert.notEqual((await state())[0], "delivered", "a session-level verification alone delivers no work item");
    assert.equal(owner.work(root).counts.delivered, 0);

    const delivered = svc.verifyCampaignChild(root, {
      childSessionId: worker, reportEventSeq: seq, followUpsAccounted: true, workItem: { id: itemId, outcome: "delivered" },
    });
    assert.ok(delivered.ok, String(delivered.error));
    assert.deepEqual(await state(), ["delivered", []]);
    assert.deepEqual([owner.work(root).counts.delivered, owner.work(root).obligations.verification], [1, 0]);
  } finally {
    setRunnerReply(null);
    await close();
  }
});

test("AC14 (dependency waits): an unfinished dependency queues, a blocked one blocks, and delivery releases dependents", async () => {
  const stack = await acceptanceStack();
  const { svc, owner, root, child, report, byKey, close } = stack;
  try {
    const plan = svc.recordCampaignPlan(root, {
      items: [
        { key: "base", dispatchState: "queued", queuePosition: 1 },
        { key: "middle", dispatchState: "queued", queuePosition: 2, dependsOnKeys: ["base"] },
        { key: "top", queuePosition: 3, dependsOnKeys: ["middle"] },
      ],
      planComplete: true,
    });
    const baseId = plan.data!.items[0]!.workItemId;
    const cause = async (key: string) => {
      const item = await byKey(key);
      return [item.primaryState, item.stateCauses];
    };
    assert.deepEqual(await cause("middle"), ["queued", ["dependency_unfinished"]]);
    assert.deepEqual(await cause("top"), ["planned", ["dependency_unfinished"]], "a planned item stays planned while it waits");

    const worker = child(root, "Base Worker");
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: baseId, childSessionId: worker }).ok);
    svc.onSessionStatus(worker, "failed");
    await stack.until("the failure reaches the dashboard", () => owner.work(root).counts.byState.blocked === 3);
    assert.deepEqual(await cause("base"), ["blocked", ["attempt_session_failed"]]);
    assert.deepEqual(await cause("middle"), ["blocked", ["dependency_blocked"]]);
    assert.deepEqual(await cause("top"), ["blocked", ["dependency_blocked"]], "a blocked dependency blocks transitively");

    // The Orchestrator closes the failed attempt; the dependents wait again instead of staying blocked.
    assert.ok(svc.updateCampaignWorkItem(root, { workItemId: baseId, endAttempt: { reason: "failed" } }).ok);
    assert.deepEqual(await cause("base"), ["queued", []]);
    assert.deepEqual(await cause("middle"), ["queued", ["dependency_unfinished"]]);
    const retry = child(root, "Base Retry");
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: baseId, childSessionId: retry }).ok);
    svc.onSessionStatus(retry, "idle");
    const seq = report(retry, "Delivered on the second attempt.");
    const delivered = svc.verifyCampaignChild(root, {
      childSessionId: retry, reportEventSeq: seq, followUpsAccounted: true, workItem: { id: baseId, outcome: "delivered" },
    });
    assert.ok(delivered.ok, String(delivered.error));
    assert.deepEqual((await byKey("base")).attempts.map((attempt) => [attempt.ordinal, attempt.endReason]),
      [[1, "failed"], [2, "delivered"]]);
    assert.deepEqual(await cause("middle"), ["queued", []]);
    assert.deepEqual(await cause("top"), ["planned", ["dependency_unfinished"]], "top still waits on middle");
    await stack.until("the dashboard shows the released items", () => owner.work(root).counts.byState.blocked === 0);
    assert.deepEqual([owner.work(root).counts.delivered, owner.work(root).counts.byState.queued], [1, 1]);
  } finally {
    await close();
  }
});

test("AC14 (#1462): a nested Orchestrator's verification resolves to the root, and only the root's view carries the summary", async () => {
  const stack = await acceptanceStack();
  const { svc, owner, root, child, report, byKey, summary, close } = stack;
  try {
    const nested = child(root, "Nested Orchestrator", true);
    const grandchild = child(nested, "Grandchild");
    const plan = svc.recordCampaignPlan(nested, { items: [{ key: "nested:item", dispatchState: "queued" }], planComplete: true });
    assert.ok(plan.ok && plan.data, String(plan.error));
    assert.equal(owner.work(root).counts.committed, 1, "the nested plan lands in the root ledger");
    const itemId = plan.data.items[0]!.workItemId;
    assert.ok(svc.assignCampaignWorkItem(nested, { workItemId: itemId, childSessionId: grandchild }).ok);
    assert.deepEqual(owner.session(grandchild)?.campaignMembership,
      { campaignSessionId: root, currentWorkItemId: itemId, currentAttemptId: (await byKey("nested:item")).currentAttempt!.id });
    assert.equal(owner.session(nested)?.campaignMembership?.campaignSessionId, root);
    assert.equal(owner.session(nested)?.orchestratorCampaign?.work, undefined, "a nested Orchestrator's view omits the summary");

    svc.onSessionStatus(grandchild, "idle");
    const seq = report(grandchild, "Nested delivery.");
    assert.ok(svc.verifyCampaignChild(nested, {
      childSessionId: grandchild, reportEventSeq: seq, followUpsAccounted: true, workItem: { id: itemId, outcome: "delivered" },
    }).ok);
    const item = await byKey("nested:item");
    assert.deepEqual([item.primaryState, item.verifications[0]?.verifiedBySessionId], ["delivered", nested]);
    assert.equal(owner.work(root).counts.delivered, 1, "the root's live summary counts the nested delivery");
    const fromNested = await summary(nested);
    assert.equal(fromNested.campaignSessionId, root, "a nested member's summary route resolves to the root");
    assert.deepEqual(fromNested.summary, owner.work(root));
  } finally {
    await close();
  }
});

test("AC14 (#1352): a stalled continuation is reported at the root beside an unchanged work summary", async () => {
  const stack = await acceptanceStack();
  const { db, hub, svc, owner, root, child, close } = stack;
  try {
    const nested = child(root, "Nested Orchestrator", true);
    const worker = child(root, "Worker");
    const plan = svc.recordCampaignPlan(root, { items: [{ key: "running", dispatchState: "queued" }], planComplete: true });
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: plan.data!.items[0]!.workItemId, childSessionId: worker }).ok);
    svc.onSessionStatus(root, "idle");
    db.recordCampaignContinuationEvent({ eventId: `child-ready:${root}:${worker}`, campaignSessionId: root, kind: "child_ready", now: Date.now() });
    const [event] = db.campaignContinuationEvents(root, Date.now() + 1_000);
    assert.ok(db.stageCampaignContinuation({
      continuationId: "acceptance-continuation", commandId: "acceptance-continuation-cmd", campaignSessionId: root,
      runnerId: RUNNER_ID, eventFromSeq: event!.seq, eventThroughSeq: event!.seq, payloadJson: "{}",
      payloadSha256: "a".repeat(64), expiresAt: Date.now() + 60_000, attemptCount: 1, now: Date.now(),
    }));
    const before = owner.work(root);
    db.updateCampaignContinuationForCommand("acceptance-continuation-cmd", "failed", Date.now(), "provider refused the turn");
    hub.sessionChangedById(root);
    const campaign = owner.session(root)!.orchestratorCampaign!;
    assert.deepEqual([campaign.status, campaign.stalled], ["blocked", "continuation_failed"],
      "the dashboard sees the stalled continuation at the root");
    assert.deepEqual([campaign.work?.counts, campaign.work?.revision], [before.counts, before.revision],
      "the stall is a campaign fact; it moves no work item");
    assert.equal(owner.session(nested)?.orchestratorCampaign?.stalled, undefined, "only the root's view carries the stall");
  } finally {
    await close();
  }
});

test("AC11: live updates, reconnects, and pagination keep summaries and item details consistent across revisions", async () => {
  const stack = await acceptanceStack();
  const { svc, hub, owner, root, child, get, listAll, close } = stack;
  try {
    const keys = ["p1", "p2", "p3", "p4", "p5"];
    const plan = svc.recordCampaignPlan(root, {
      items: keys.map((key, index) => ({ key, queuePosition: index, dispatchState: "queued" as const })), planComplete: true,
    });
    const workers = [child(root, "Worker One"), child(root, "Worker Two")];
    for (const [index, worker] of workers.entries()) {
      assert.ok(svc.assignCampaignWorkItem(root, { workItemId: plan.data!.items[index]!.workItemId, childSessionId: worker }).ok);
    }
    let walk = await listAll();
    assert.deepEqual(walk.items.map((item) => item.key), keys, "pages concatenate to the whole list once, in queue order");
    assert.equal(walk.revision, owner.work(root).revision, "the dashboard and the list read the same revision");
    assertSummaryMatchesList(owner.work(root), walk.items);

    // Read the first page, then let two children change status in one coalescing window.
    const first = await get<CampaignWorkItemsPage>(`/api/sessions/${root}/campaign/work-items?state=all&limit=2`);
    const revision = owner.work(root).revision;
    const upserts = owner.messages.filter((message) => message.type === "session_upsert" && message.session.id === root).length;
    svc.onSessionStatus(workers[0]!, "idle");
    svc.onSessionStatus(workers[1]!, "input_required");
    await stack.until("the observed changes reach the dashboard", () => owner.work(root).revision > revision);
    assert.equal(owner.work(root).revision, revision + 1, "a burst of child status changes is one revision");
    assert.deepEqual([owner.work(root).counts.byState.waiting, owner.work(root).obligations.verification], [2, 1]);
    assert.ok(owner.messages.filter((message) => message.type === "session_upsert" && message.session.id === root).length > upserts,
      "the root view was re-sent without any ledger write");

    // The page read before the change cannot be continued: the browser restarts from the first page.
    const stale = await get<{ code: string; revision: number }>(
      `/api/sessions/${root}/campaign/work-items?state=all&limit=2&cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    assert.deepEqual([stale.status, stale.body.code, stale.body.revision], [409, CAMPAIGN_WORK_REVISION_CHANGED, revision + 1]);
    walk = await listAll();
    assertSummaryMatchesList(owner.work(root), walk.items);
    for (const item of walk.items) {
      const detail = (await get<CampaignWorkItemDetailResponse>(`/api/sessions/${root}/campaign/work-items/${item.id}`)).body.item;
      assert.deepEqual([detail.primaryState, detail.stateCauses, detail.currentAttempt?.id ?? null],
        [item.primaryState, item.stateCauses, item.currentAttempt?.id ?? null], `the details of ${item.key} match its row`);
    }

    // A ledger write moves the dashboard's summary in the same turn, without waiting for observation.
    assert.ok(svc.updateCampaignWorkItem(root, { workItemId: plan.data!.items[4]!.workItemId,
      commitment: { state: "cancelled", reason: "Superseded." } }).ok);
    assert.equal(owner.work(root).revision, revision + 2);
    assert.deepEqual([owner.work(root).counts.committed, owner.work(root).counts.cancelled], [4, 1]);

    // A dashboard that reconnects after missing all of this starts from the same summary.
    const reconnected = new Dashboard();
    assert.ok(hub.addUiClient(reconnected, { deviceId: "device-owner-reconnect", principal: human("owner"), close() {} }));
    assert.deepEqual(reconnected.work(root), owner.work(root));
    hub.removeUiClient(reconnected);
    assertSummaryMatchesList(owner.work(root), (await listAll()).items);
  } finally {
    await close();
  }
});

test("AC12: a session outside every campaign has no membership or Campaign Status routes; members resolve to their root", async () => {
  const stack = await acceptanceStack();
  const { db, hub, owner, root, child, get, close } = stack;
  try {
    const member = child(root, "Member");
    db.createSession({
      id: "unrelated", runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: "child-agent", title: "Unrelated",
      useWorktree: false, driver: "claude-code", config: {}, now: Date.now(),
    });
    hub.sessionChangedById("unrelated");
    const unrelated = owner.session("unrelated")!;
    assert.equal(unrelated.campaignMembership, undefined);
    assert.equal(unrelated.orchestratorCampaign, undefined);
    for (const route of ["summary", "work-items", "work-items/cwi_missing", "recommendations"]) {
      assert.equal((await get(`/api/sessions/unrelated/campaign/${route}`)).status, 404, `${route} is not served outside a campaign`);
    }
    assert.equal(owner.session(member)?.campaignMembership?.campaignSessionId, root);
    assert.equal(owner.session(root)?.campaignMembership, undefined, "the root is not its own member");
    assert.equal((await get<CampaignWorkSummaryResponse>(`/api/sessions/${member}/campaign/summary`)).body.campaignSessionId, root);
  } finally {
    await close();
  }
});

test("AC14 (pending cleanup): a verified child's refused worktree retirement is an outstanding cleanup obligation until it is retired", async () => {
  const stack = await acceptanceStack({ completion: "stop_and_archive" });
  const { db, svc, owner, root, child, report, byKey, setRunnerReply, sentToRunner, close } = stack;
  try {
    const plan = svc.recordCampaignPlan(root, { items: [{ key: "cleanup", dispatchState: "queued" }], planComplete: true });
    const itemId = plan.data!.items[0]!.workItemId;
    const worker = child(root, "Leaves a Worktree");
    const path = `/worktrees/${worker}/fix`;
    db.raw().prepare("UPDATE sessions SET worktrees=? WHERE id=?")
      .run(JSON.stringify([{ id: "wt-fix", path, branch: "fix/cleanup", source: "created" }]), worker);
    assert.ok(svc.assignCampaignWorkItem(root, { workItemId: itemId, childSessionId: worker }).ok);
    // The runner refuses to retire a dirty worktree, as it does for any safety condition.
    setRunnerReply((message, hub) => {
      if (message.type !== "session_worktree" || message.operation !== "discard") return;
      hub.resolveRunnerRequest({ type: "session_worktree_result", requestId: message.requestId, sessionId: message.sessionId,
        operation: "discard", ok: false, error: "worktree retained: the worktree has uncommitted changes" });
    });
    svc.onSessionStatus(worker, "completed");
    const seq = report(worker, "Delivered; the worktree is still here.");
    const verified = svc.verifyCampaignChild(root, {
      childSessionId: worker, reportEventSeq: seq, followUpsAccounted: true, workItem: { id: itemId, outcome: "delivered" },
    });
    assert.ok(verified.ok, String(verified.error));
    await stack.until("the refusal is recorded", () =>
      db.campaignWorktreeCleanup(worker).some((item) => item.status === "refused"));
    assert.ok(sentToRunner.some((message) => message.type === "session_worktree" && message.operation === "discard" &&
      message.path === path), "the runner was asked to retire the worktree");
    await stack.until("the dashboard shows the cleanup obligation", () => owner.work(root).obligations.cleanup === 1);
    let item = await byKey("cleanup");
    assert.equal(item.primaryState, "delivered", "delivery and cleanup are separate facts");
    assert.deepEqual(item.observed.cleanup?.availability === "fresh" && item.observed.cleanup.value.worktrees,
      [{ path, status: "refused", reason: "the worktree has uncommitted changes" }]);
    assert.notEqual(owner.session(root)?.orchestratorCampaign?.status, "verified_complete",
      "pending cleanup keeps the campaign from completing");

    // The operator resolves it and the runner reports the worktree gone.
    db.raw().prepare("UPDATE sessions SET worktrees='[]' WHERE id=?").run(worker);
    stack.hub.sessionChangedById(worker);
    stack.hub.sessionChangedById(root);
    await stack.until("the obligation clears", () => owner.work(root).obligations.cleanup === 0);
    item = await byKey("cleanup");
    assert.deepEqual(item.observed.cleanup?.availability === "fresh" && item.observed.cleanup.value.worktrees,
      [{ path, status: "retired", reason: null }]);
  } finally {
    setRunnerReply(null);
    await close();
  }
});
