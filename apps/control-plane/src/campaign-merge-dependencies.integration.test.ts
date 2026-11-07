import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, type CampaignForgePullRequestObservation,
  type ControlPlaneToRunner, type RunnerMetadata, type WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService, canonicalPrMergeEnqueueCommand } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { CampaignForgeObserver } from "./campaign-forge-observations.js";
import { PREREQUISITE_MERGE_WATCH_RUNNER } from "./pull-request-watches.js";
import Fastify from "fastify";
import { registerCampaignStatusRoutes } from "./campaign-status-routes.js";
import type { HumanPrincipal } from "./identity.js";

/**
 * #4120: cross-repository work-item dependencies hold a dependent's merge until every pull request of
 * its prerequisite is freshly observed MERGED on its forge. The real control plane, ledger, forge
 * observer and merge gate over a campaign of two repositories, `owner/app` (the launch repository,
 * on runner `r`) and `owner/api` (a Location on runner `r2`); only the runners are fakes.
 */
const rollup = { state: "passing" as const, passing: 1, failing: 0, pending: 0 };
const pull = (state: CampaignForgePullRequestObservation["state"], extra: Partial<CampaignForgePullRequestObservation> = {}): CampaignForgePullRequestObservation => ({
  state, draft: false, headSha: "e".repeat(40), baseRef: "main", reviewDecision: "approved", checks: rollup, requiredChecks: rollup,
  mergeQueue: null, mergeCommitSha: state === "merged" ? "f".repeat(40) : null, ...extra });

async function fixture(options: { dependency?: "api" | "app-sibling" | null } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const scope = { organizationId: identity.organizationId, owner: { kind: "user" as const, userId: identity.userId } };
  const agents: RunnerMetadata["agents"] = [{ id: "agent", name: "Agent", command: "claude", args: [], env: {}, driver: "claude-code", available: true }];
  db.registerRunner({ runnerId: "r", hostname: "r", os: "linux", version: "test", workspaces: [{ id: "w", name: "App", path: "/repos/app" }], agents }, 1, PROTOCOL_VERSION);
  db.registerRunner({ runnerId: "r2", hostname: "r2", os: "linux", version: "test", workspaces: [{ id: "a", name: "Api", path: "/repos/api" }], agents }, 1, PROTOCOL_VERSION);
  const project = db.createProject({ name: "Account", scope });
  const appLocation = db.addProjectLocation(project.id, { runnerId: "r", workspaceId: "w", addedByUserId: identity.userId });
  const apiLocation = db.addProjectLocation(project.id, { runnerId: "r2", workspaceId: "a", addedByUserId: identity.userId });
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "owner/app", issueNumbers: [1], revision: 1, authorizedByUserId: identity.userId, authorizedAt: 1 };
  policy.issueNumbers = [1];
  policy.repositories = [{ repository: "owner/app", locationIds: [appLocation.id] }, { repository: "owner/api", locationIds: [apiLocation.id] }];
  const place = { root: ["r", "w"], app: ["r", "w"], api: ["r2", "a"] } as const;
  for (const id of ["root", "app", "api"] as const) {
    db.createSession({ id, runnerId: place[id][0], workspaceId: place[id][1], agentId: "agent", title: id, useWorktree: false, driver: "claude-code",
      config: { model: "opus" }, now: 1, scope,
      ...(id === "root" ? { role: "orchestrator", orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } }
        : { parentSessionId: "root" }) });
    db.updateSessionStatus(id, "running", 2);
  }
  db.raw().prepare("UPDATE sessions SET project_id=? WHERE id='root'").run(project.id);

  const hub = new Hub(db);
  const offline = new Set<string>();
  hub.isRunnerOnline = (runnerId) => !offline.has(runnerId);
  hub.sessionChangedById = () => {};
  hub.sendToRunner = () => true;
  /** What the fake forge answers per pull request, and every read it was asked for. */
  const forge = new Map<string, CampaignForgePullRequestObservation>();
  const reads: Array<{ runnerId: string; refs: string[]; location: string | null }> = [];
  const forgeActions: string[] = [];
  /** While set, the merge preflight waits for it, so a test can change the ledger mid-request. */
  const preflight: { gate: Promise<void> | null; reached: () => void } = { gate: null, reached: () => undefined };
  hub.requestFromRunner = (async (runnerId: string, requestId: string, message: ControlPlaneToRunner) => {
    if (message.type === "github_merge_preflight") {
      if (preflight.gate) { preflight.reached(); await preflight.gate; }
      return { type: "github_merge_preflight_result", requestId, sessionId: message.sessionId, ok: true, check: { checkedAt: 1, closures: [] } };
    }
    if (message.type === "campaign_forge_observe") {
      reads.push({ runnerId, refs: message.pullRequests.map((ref) => `${ref.repository}#${ref.number}`), location: message.location?.repository ?? null });
      return { type: "campaign_forge_observe_result", requestId, sessionId: message.sessionId, observedAt: Date.now(), ok: true,
        results: message.pullRequests.map((ref) => {
          const value = forge.get(`${ref.repository}#${ref.number}`);
          return value ? { ref, ok: true as const, observation: value } : { ref, ok: false as const, failure: "forge_not_found" as const };
        }) };
    }
    if (message.type === "forge_decision_action") {
      forgeActions.push(message.occurrenceId);
      return { type: "forge_decision_action_result", requestId, sessionId: message.sessionId, occurrenceId: message.occurrenceId, outcome: "enqueued" };
    }
    throw new Error(`unexpected runner request ${message.type}`);
  }) as unknown as Hub["requestFromRunner"];
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  svc.hydrateHistory = async () => {};
  const decisions = db.getSession("root")!.parentControlPolicy!;
  assert.ok(svc.setParentControlPolicy("root", { ...decisions.decisions, pr_merge: "orchestrator" }, decisions.revision).ok);
  let count = 0;
  const observer = new CampaignForgeObserver({
    observingRunner: (campaignId, repository) => db.campaignForgeObservingRunner(campaignId, repository, (runnerId) => hub.isRunnerOnline(runnerId)),
    requestFromRunner: (runnerId, requestId, message, timeout) => hub.requestFromRunner(runnerId, requestId, message, timeout),
    store: db.campaignForgeObservations, backgroundTargets: () => [], changed: () => undefined, warn: () => undefined, newRequestId: () => `forge_${++count}`,
  });
  svc.campaignForgeRefresh = (campaignId, refs) => observer.refresh(campaignId, refs);
  svc.campaignForgeReadNow = (campaignId, refs) => observer.readNow(campaignId, refs);

  const dependency = options.dependency === undefined ? "api" : options.dependency;
  const plan = svc.recordCampaignPlan("root", { planComplete: true, items: [
    { key: "api", title: "Add Account Field", issue: { repository: "owner/api", number: 2 } },
    { key: "app-sibling", title: "Rename Settings Tab", issue: { repository: "owner/app", number: 1 } },
    { key: "app", title: "Show Account Field", issue: { repository: "owner/app", number: 1 }, ...(dependency ? { dependsOnKeys: [dependency] } : {}) },
  ] });
  assert.ok(plan.ok, plan.error ?? "plan refused");
  const item = (key: string) => plan.data!.items.find((entry) => entry.key === key)!.workItemId;
  for (const [child, key] of [["app", "app"], ["api", "api"]] as const) {
    db.appendEvent(child, { kind: "user_message", text: `Deliver ${key}` }, Date.now());
    assert.ok(svc.assignCampaignWorkItem("root", { workItemId: item(key), childSessionId: child }).ok);
  }
  const stage = (key: string, repository: string, number: number) =>
    assert.ok(svc.updateCampaignWorkItem("root", { workItemId: item(key), stage: { stage: "merge_queued", pullRequests: [{ repository, number }] } }).ok);
  stage("api", "owner/api", 7);
  stage("app-sibling", "owner/app", 6);

  /** A child's merge of its own pull request, approved by the Orchestrator. */
  const approvedMerge = (sessionId: string, repository: string, pullRequest: number) => {
    const headSha = String(pullRequest).padStart(40, "a");
    const snapshot: Extract<WorkflowDecisionResourceSnapshot, { category: "pr_merge" }> = { category: "pr_merge", repository, pullRequest, headSha, reviewResult: "merge",
      requiredChecks: { headSha, status: "passed", checkedAt: 10, checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" }] } };
    const created = svc.createWorkflowDecision(sessionId, { requestId: `merge-${pullRequest}`, resourceKey: `${repository}#${pullRequest}`, resourceSnapshot: snapshot });
    assert.ok(created.ok && created.data, created.error ?? "refused");
    assert.equal(created.data.authority, "orchestrator");
    const approved = svc.resolveDescendantRequest("root", sessionId, created.data.occurrenceId, { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
    assert.ok(approved.ok, approved.error ?? "refused");
    const command = canonicalPrMergeEnqueueCommand(snapshot);
    const arm = () => svc.consumeWorkflowDecision(sessionId, created.data!.occurrenceId, { resourceSnapshot: snapshot, action: { kind: "pr_merge_enqueue", command } });
    return { occurrenceId: created.data.occurrenceId, snapshot, arm };
  };
  const detail = (key: string) => db.campaignWorkLedger.detail("root", item(key), Date.now())!;
  /** Hold the next merge preflights until `release`; `reached` resolves once one is waiting. */
  const pausePreflight = () => {
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { preflight.reached = resolve; });
    preflight.gate = new Promise<void>((resolve) => { release = () => { preflight.gate = null; resolve(); }; });
    return { reached, release };
  };
  return { db, hub, svc, observer, forge, reads, forgeActions, offline, item, detail, approvedMerge, pausePreflight };
}

test("an owner/app merge is held while its owner/api prerequisite is open and proceeds on the same approval once it merges (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("open"));
    const merge = h.approvedMerge("app", "owner/app", 5);
    const held = await merge.arm();
    assert.equal(held.ok, false);
    assert.equal(held.status, 409);
    assert.match(held.error!, /^Merge held until prerequisite pull request owner\/api#7 \(api in owner\/api\) is observed MERGED; it is not merged yet\./u);
    // The approval stays valid, and nothing was armed.
    const decision = h.db.workflowDecisionByOccurrence(merge.occurrenceId)!;
    assert.equal(decision.status, "approved");
    assert.equal(decision.actionAdmission, undefined);
    // The prerequisite was read through the owner/api Location's runner, never the root's.
    assert.deepEqual(h.reads, [{ runnerId: "r2", refs: ["owner/api#7"], location: "owner/api" }]);
    // The child is parked on the prerequisite, which the control plane watches itself.
    const watch = h.db.pullRequestWatches.visibleFor("app")!;
    assert.deepEqual([watch.repository, watch.number, watch.state], ["owner/api", 7, "watching"]);
    assert.deepEqual(h.db.pullRequestWatches.watchingOn(PREREQUISITE_MERGE_WATCH_RUNNER).map((entry) => entry.sessionId), ["app"]);
    assert.equal(h.db.pullRequestWatches.isParked("app"), true);
    // Its item shows the hold, naming the prerequisite and its pull request.
    h.db.updateSessionStatus("app", "idle", Date.now());
    const waiting = h.detail("app");
    assert.equal(waiting.primaryState, "waiting");
    assert.deepEqual(waiting.stateCauses, ["dependency_unmerged", "attempt_awaiting_verification"]);
    assert.equal(waiting.repository, "owner/app");
    assert.deepEqual(waiting.mergeDependencies, [{ id: h.item("api"), key: "api", title: "Add Account Field", repository: "owner/api", status: "unmerged",
      pullRequests: [{ ref: { repository: "owner/api", number: 7 }, state: "open" }] }]);
    assert.equal(h.detail("api").repository, "owner/api");

    // Enqueued is not merged either.
    h.forge.set("owner/api#7", pull("open", { mergeQueue: { state: "queued", position: 1 } }));
    const queued = await merge.arm();
    assert.equal(queued.status, 409);
    assert.match(queued.error!, /owner\/api#7/u);
    // Asking again parks it again, replacing its earlier watch.
    assert.equal(h.db.pullRequestWatches.view(watch.watchId)!.state, "cancelled");
    const parked = h.db.pullRequestWatches.visibleFor("app")!;
    assert.deepEqual([parked.repository, parked.number, parked.state], ["owner/api", 7, "watching"]);

    // Once the prerequisite is observed MERGED, its watch fires and wakes the child...
    h.forge.set("owner/api#7", pull("merged"));
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    h.svc.campaignWorkObserved("root");
    const fired = h.db.pullRequestWatches.view(parked.watchId)!;
    assert.deepEqual([fired.state, fired.outcome], ["fired", "merged"]);
    assert.notEqual(fired.continuation, "held", "the wake went out to the idle child");
    h.db.updateSessionStatus("app", "idle", Date.now());
    assert.deepEqual(h.detail("app").stateCauses, ["attempt_awaiting_verification"]);
    assert.equal(h.detail("app").mergeDependencies![0]!.status, "merged");
    // ...and the merge proceeds on the same approval, without a new one.
    h.db.updateSessionStatus("app", "running", Date.now());
    const armed = await merge.arm();
    assert.equal(armed.ok, true, armed.error ?? "armed");
    assert.equal(armed.data!.occurrenceId, merge.occurrenceId);
    assert.equal(armed.data!.actionAdmission?.kind, "pr_merge_enqueue");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a delivered prerequisite whose pull request has not merged still holds the dependent's merge (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("open", { mergeQueue: { state: "awaiting_checks", position: 2 } }));
    h.db.updateSessionStatus("api", "idle", Date.now());
    const report = h.db.appendEvent("api", { kind: "agent_message", text: "Enqueued owner/api#7.", final: true }, Date.now()).seq;
    const verified = h.svc.verifyCampaignChild("root", { childSessionId: "api", reportEventSeq: report, followUpsAccounted: true,
      workItem: { id: h.item("api"), outcome: "delivered" } });
    assert.ok(verified.ok, verified.error ?? "verified");
    assert.equal(h.detail("api").primaryState, "delivered");
    const held = await h.approvedMerge("app", "owner/app", 5).arm();
    assert.equal(held.status, 409);
    assert.match(held.error!, /owner\/api#7/u);
    assert.equal(h.detail("app").mergeDependencies![0]!.status, "unmerged");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a prerequisite closed without merging, or cancelled, leaves the dependent blocked and its merge unattempted (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("closed"));
    const merge = h.approvedMerge("app", "owner/app", 5);
    const held = await merge.arm();
    assert.equal(held.status, 409);
    assert.match(held.error!, /^Merge held: prerequisite pull request owner\/api#7 \(api in owner\/api\) was closed without merging, so this merge is not attempted\./u);
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.status, "approved");
    assert.equal(h.db.pullRequestWatches.visibleFor("app"), undefined, "nothing to wait for");
    const blocked = h.detail("app");
    assert.deepEqual([blocked.primaryState, blocked.stateCauses], ["blocked", ["dependency_blocked"]]);
    assert.equal(blocked.mergeDependencies![0]!.status, "failed");

    // Wollipog doesn't perform it either, even once armed elsewhere: no attempt is spent.
    const executed = await h.svc.executeWorkflowDecision("app", merge.occurrenceId, { resourceDigest: h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.resourceDigest });
    assert.equal(executed.ok, false);
    assert.deepEqual(h.forgeActions, []);

    // A cancelled prerequisite holds it for good too.
    h.forge.set("owner/api#7", pull("open"));
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("api"), commitment: { state: "cancelled", reason: "Not needed" } }).ok);
    const cancelled = await merge.arm();
    assert.equal(cancelled.status, 409);
    assert.match(cancelled.error!, /^Merge held: its prerequisite api in owner\/api was cancelled or removed/u);
    assert.deepEqual([h.detail("app").primaryState, h.detail("app").stateCauses], ["blocked", ["dependency_blocked"]]);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a parked hold ends with a wake when its prerequisite closes or is cancelled (#4120)", async () => {
  for (const ending of ["closed", "cancelled"] as const) {
    const h = await fixture();
    try {
      h.forge.set("owner/api#7", pull("open"));
      assert.equal((await h.approvedMerge("app", "owner/app", 5).arm()).status, 409);
      const watch = h.db.pullRequestWatches.visibleFor("app")!;
      h.db.updateSessionStatus("app", "idle", Date.now());
      if (ending === "closed") {
        h.forge.set("owner/api#7", pull("closed"));
        await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
        h.svc.campaignWorkObserved("root");
        assert.deepEqual([h.db.pullRequestWatches.view(watch.watchId)!.state, h.db.pullRequestWatches.view(watch.watchId)!.outcome], ["fired", "closed"]);
      } else {
        assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("api"), commitment: { state: "cancelled", reason: "Not needed" } }).ok);
        const lost = h.db.pullRequestWatches.view(watch.watchId)!;
        assert.equal(lost.state, "lost");
        assert.match(lost.reason!, /prerequisite api was cancelled or removed/u);
      }
      assert.equal(h.detail("app").primaryState, "blocked");
    } finally { h.observer.dispose(); h.db.close(); }
  }
});

test("with every owner/api Location offline its facts read unavailable and the hold stays (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("merged"));
    h.offline.add("r2");
    h.db.markOffline("r2", Date.now());
    const merge = h.approvedMerge("app", "owner/app", 5);
    const held = await merge.arm();
    assert.equal(held.status, 409);
    assert.match(held.error!, /owner\/api#7 \(api in owner\/api\) is observed MERGED; it is not freshly observed\./u);
    // Nothing read it, and the root's runner never stood in for the Location.
    assert.deepEqual(h.reads, []);
    const [entry] = h.db.campaignForgeObservations.facts("root", [{ repository: "owner/api", number: 7 }], Date.now());
    assert.deepEqual(entry!.fact, { availability: "unavailable", reason: "runner_disconnected" });
    h.db.updateSessionStatus("app", "idle", Date.now());
    assert.equal(h.detail("app").stateCauses[0], "dependency_unmerged");
    // Back online, the same approval goes through.
    h.offline.delete("r2");
    h.db.registerRunner({ runnerId: "r2", hostname: "r2", os: "linux", version: "test", workspaces: [{ id: "a", name: "Api", path: "/repos/api" }],
      agents: [{ id: "agent", name: "Agent", command: "claude", args: [], env: {}, driver: "claude-code", available: true }] }, Date.now(), PROTOCOL_VERSION);
    const armed = await merge.arm();
    assert.equal(armed.ok, true, armed.error ?? "armed");
    assert.deepEqual(h.reads, [{ runnerId: "r2", refs: ["owner/api#7"], location: "owner/api" }]);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("items without a cross-repository dependency merge independently in any order, as before (#4120)", async () => {
  for (const order of [["app", "api"], ["api", "app"]] as const) {
    const h = await fixture({ dependency: null });
    try {
      h.forge.set("owner/api#7", pull("open"));
      const merges = { app: h.approvedMerge("app", "owner/app", 5), api: h.approvedMerge("api", "owner/api", 7) };
      for (const key of order) {
        const armed = await merges[key].arm();
        assert.equal(armed.ok, true, `${key}: ${armed.error ?? "armed"}`);
      }
      assert.deepEqual(h.reads, [], "no prerequisite to read");
      assert.equal(h.detail("app").mergeDependencies, undefined);
    } finally { h.observer.dispose(); h.db.close(); }
  }
  // A dependency within one repository keeps its earlier, display-only meaning: no merge hold.
  const h = await fixture({ dependency: "app-sibling" });
  try {
    h.forge.set("owner/app#6", pull("open"));
    const armed = await h.approvedMerge("app", "owner/app", 5).arm();
    assert.equal(armed.ok, true, armed.error ?? "armed");
    assert.equal(h.detail("app").mergeDependencies, undefined);
    assert.deepEqual(h.reads, []);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("an item works where its child is placed, so one feature issue can span two repositories (#4120)", async () => {
  const h = await fixture({ dependency: null });
  try {
    // Both items track the owner/app feature issue; neither names a pull request yet.
    const plan = h.svc.recordCampaignPlan("root", { planComplete: true, items: [
      { key: "api-field", title: "Add Account Field", issue: { repository: "owner/app", number: 1 } },
      { key: "app-field", title: "Show Account Field", issue: { repository: "owner/app", number: 1 }, dependsOnKeys: ["api-field"] },
    ] });
    assert.ok(plan.ok, plan.error ?? "plan refused");
    const id = (key: string) => plan.data!.items.find((entry) => entry.key === key)!.workItemId;
    const read = (key: string) => h.db.campaignWorkLedger.detail("root", id(key), Date.now())!;
    assert.equal(read("api-field").repository, "owner/app", "undispatched, it reads its issue's repository");
    assert.equal(read("app-field").mergeDependencies, undefined, "two items of one repository");
    // The child placed in the owner/api Location takes it there: a server fact, not the item's issue.
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: id("api-field"), childSessionId: "api" }).ok);
    assert.equal(read("api-field").repository, "owner/api");
    assert.deepEqual(read("app-field").mergeDependencies?.map((dependency) => [dependency.key, dependency.repository, dependency.status, dependency.pullRequests]),
      [["api-field", "owner/api", "unmerged", []]]);
    // Its merge is held, saying the prerequisite names no pull request yet.
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: id("app-field"), childSessionId: "app" }).ok);
    const held = await h.approvedMerge("app", "owner/app", 5).arm();
    assert.equal(held.status, 409);
    assert.match(held.error!, /^Merge held: prerequisite api-field in owner\/api names no pull request yet/u);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a hold the ledger gains while the merge's own forge reads are pending still stops arming and Wollipog's enqueue (#4120)", async () => {
  const h = await fixture({ dependency: null });
  try {
    h.forge.set("owner/api#7", pull("open"));
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    // Arming: the dependency arrives while the closing-reference preflight is out.
    const merge = h.approvedMerge("app", "owner/app", 5);
    const paused = h.pausePreflight();
    const arming = merge.arm();
    await paused.reached;
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("app"), dependsOn: [h.item("api")] }).ok, "not armed yet, so it may be added");
    paused.release();
    const held = await arming;
    assert.equal(held.status, 409);
    assert.match(held.error!, /owner\/api#7/u);
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.actionAdmission, undefined, "nothing was armed");
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.status, "approved");

    // Wollipog's enqueue: armed with the prerequisite merged, then the prerequisite is cancelled
    // while GitHub is read for the enqueue.
    h.forge.set("owner/api#7", pull("merged"));
    assert.equal((await merge.arm()).ok, true);
    const executing = (() => {
      const pausedAgain = h.pausePreflight();
      const run = h.svc.executeWorkflowDecision("app", merge.occurrenceId, { resourceDigest: h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.resourceDigest });
      return { run, ...pausedAgain };
    })();
    await executing.reached;
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("api"), commitment: { state: "cancelled", reason: "Not needed" } }).ok);
    executing.release();
    const stopped = await executing.run;
    assert.equal(stopped.status, 409);
    assert.match(stopped.error!, /^Merge held: its prerequisite api in owner\/api was cancelled or removed/u);
    assert.deepEqual(h.forgeActions, [], "no enqueue was sent");
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.forgeAction?.outcome, "refused");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a fresh MERGED already stored doesn't pass the gate when the authoritative read can't be made (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("merged"));
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    const [stored] = h.db.campaignForgeObservations.facts("root", [{ repository: "owner/api", number: 7 }], Date.now());
    assert.equal(stored!.fact.availability, "fresh");
    // r2 can't be asked now (its registration still reads online), so the read answers nothing.
    h.offline.add("r2");
    const merge = h.approvedMerge("app", "owner/app", 5);
    const held = await merge.arm();
    assert.equal(held.status, 409);
    assert.match(held.error!, /owner\/api#7 \(api in owner\/api\) is observed MERGED; it is not freshly observed\./u);
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.status, "approved");
    h.offline.delete("r2");
    assert.equal((await merge.arm()).ok, true);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a reader who can't reach the prerequisite's reading runner sees its merge state as unknown (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("closed"));
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    const identity = h.db.localIdentityContext();
    const human: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
    const status = Fastify();
    registerCampaignStatusRoutes(status, { db: h.db, requestPrincipal: () => human });
    await status.ready();
    const read = async () => {
      const page = (await status.inject({ method: "GET", url: "/api/sessions/root/campaign/work-items?state=all" })).json();
      const detail = (await status.inject({ method: "GET", url: `/api/sessions/root/campaign/work-items/${h.item("app")}` })).json();
      return [page.items.find((item: { key: string }) => item.key === "app").mergeDependencies[0], detail.item.mergeDependencies[0]];
    };
    for (const shown of await read()) {
      assert.deepEqual([shown.status, shown.pullRequests[0].state], ["failed", "closed"], "the reader reaches r2");
    }
    // Without access to r2, whose login supplied the fact, neither the state nor the status it decides is shown.
    const access = h.db.canAccessRunner.bind(h.db);
    h.db.canAccessRunner = (principal, runnerId) => runnerId !== "r2" && access(principal, runnerId);
    for (const shown of await read()) {
      assert.deepEqual([shown.key, shown.repository, shown.status, shown.pullRequests], ["api", "owner/api", "unknown",
        [{ ref: { repository: "owner/api", number: 7 }, state: "unknown" }]]);
    }
    // A cancelled prerequisite fails whatever the forge says, so its status stays shown.
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("api"), commitment: { state: "cancelled", reason: "Not needed" } }).ok);
    h.forge.set("owner/api#7", pull("open"));
    h.db.canAccessRunner = access;
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    h.db.canAccessRunner = (principal, runnerId) => runnerId !== "r2" && access(principal, runnerId);
    for (const shown of await read()) assert.deepEqual([shown.status, shown.pullRequests[0].state], ["failed", "unknown"]);
    await status.close();
  } finally { h.observer.dispose(); h.db.close(); }
});

test("once a merge is armed, no ledger change may move its prerequisite into another repository (#4120)", async () => {
  const h = await fixture({ dependency: null });
  try {
    // Both items track the owner/app issue, so the dependency is within one repository: no hold.
    const plan = h.svc.recordCampaignPlan("root", { planComplete: true, items: [
      { key: "api-field", title: "Add Account Field", issue: { repository: "owner/app", number: 1 } },
      { key: "app-field", title: "Show Account Field", issue: { repository: "owner/app", number: 1 }, dependsOnKeys: ["api-field"] },
    ] });
    assert.ok(plan.ok, plan.error ?? "plan refused");
    const id = (key: string) => plan.data!.items.find((entry) => entry.key === key)!.workItemId;
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: id("app-field"), childSessionId: "app" }).ok);
    assert.equal((await h.approvedMerge("app", "owner/app", 5).arm()).ok, true);
    const refusal = /^This change would give work item app-field a prerequisite in another repository \(api-field\), but its child has already armed its approved merge/u;
    // Placing the prerequisite's child in the owner/api Location would make it a merge dependency.
    const assigned = h.svc.assignCampaignWorkItem("root", { workItemId: id("api-field"), childSessionId: "api" });
    assert.equal(assigned.status, 409);
    assert.match(assigned.error!, refusal);
    assert.equal(h.db.campaignWorkLedger.detail("root", id("api-field"), Date.now())!.attemptCount, 0, "rolled back");
    // So would naming an owner/api pull request on its stage, or moving its issue there.
    const staged = h.svc.updateCampaignWorkItem("root", { workItemId: id("api-field"), stage: { stage: "in_review", pullRequests: [{ repository: "owner/api", number: 9 }] } });
    assert.equal(staged.status, 409);
    assert.match(staged.error!, refusal);
    const moved = h.svc.updateCampaignWorkItem("root", { workItemId: id("api-field"), issue: { repository: "owner/api", number: 2 } });
    assert.equal(moved.status, 409);
    // A change that keeps it in owner/app is fine.
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: id("api-field"), stage: { stage: "in_review", pullRequests: [{ repository: "owner/app", number: 9 }] } }).ok);
    // Nor may the armed child be moved onto another item that waits for owner/api.
    const waiting = h.svc.recordCampaignPlan("root", { planComplete: true, items: [
      { key: "app-other", title: "Show Account Badge", issue: { repository: "owner/app", number: 1 }, dependsOnKeys: ["api"] }] });
    assert.ok(waiting.ok, waiting.error ?? "plan refused");
    const moved2 = h.svc.assignCampaignWorkItem("root", { workItemId: waiting.data!.items[0]!.workItemId, childSessionId: "app" });
    assert.equal(moved2.status, 409);
    assert.match(moved2.error!, /^This change would give work item app-other a prerequisite in another repository \(api\)/u);
    assert.equal(h.db.campaignWorkLedger.currentAssignment("app")?.workItemId, id("app-field"), "rolled back");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a dependency can't be added once the merge is armed, and Wollipog's enqueue still holds on one that is there (#4120)", async () => {
  const h = await fixture({ dependency: null });
  try {
    const merge = h.approvedMerge("app", "owner/app", 5);
    assert.equal((await merge.arm()).ok, true);
    h.forge.set("owner/api#7", pull("open"));
    // The child's provider may run an armed command without asking again, so the promise to hold
    // it can't be made now: the ledger refuses it, in the plan and in an update alike.
    const refused = h.svc.updateCampaignWorkItem("root", { workItemId: h.item("app"), dependsOn: [h.item("api")] });
    assert.equal(refused.status, 409);
    assert.match(refused.error!, /its child has already armed its approved merge, which a new dependency could not hold/u);
    const planned = h.svc.recordCampaignPlan("root", { planComplete: true, items: [{ key: "app", dependsOnKeys: ["api"] }] });
    assert.equal(planned.status, 409);
    assert.equal(h.detail("app").dependsOn.length, 0);
    // Other items' dependencies are unaffected.
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("app-sibling"), dependsOn: [h.item("api")] }).ok);
    // A dependency already in the ledger (here written directly, as an older control plane could
    // have) still holds the enqueue Wollipog performs.
    h.db.raw().prepare("INSERT INTO campaign_work_item_dependencies (work_item_id, depends_on_id) VALUES (?, ?)").run(h.item("app"), h.item("api"));
    const digest = h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.resourceDigest;
    const executed = await h.svc.executeWorkflowDecision("app", merge.occurrenceId, { resourceDigest: digest });
    assert.equal(executed.status, 409);
    assert.match(executed.error!, /owner\/api#7/u);
    assert.deepEqual(h.forgeActions, []);
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.forgeAction, undefined);
    // Once it merges, Wollipog performs the enqueue.
    h.forge.set("owner/api#7", pull("merged"));
    const performed = await h.svc.executeWorkflowDecision("app", merge.occurrenceId, { resourceDigest: digest });
    assert.equal(performed.ok, true, performed.error ?? "performed");
    assert.deepEqual(h.forgeActions, [merge.occurrenceId]);
  } finally { h.observer.dispose(); h.db.close(); }
});
