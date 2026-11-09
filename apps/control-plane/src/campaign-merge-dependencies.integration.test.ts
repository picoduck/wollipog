import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, type CampaignForgePullRequestObservation,
  type ControlPlaneToRunner, type RunnerMetadata, type WorkflowDecisionResourceSnapshot } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService, canonicalPrMergeEnqueueCommand } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { CampaignForgeObserver } from "./campaign-forge-observations.js";
import { CampaignWorkObservations } from "./campaign-work-observation.js";
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

async function fixture(options: { dependency?: "api" | "app-sibling" | null; single?: boolean } = {}) {
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
  policy.repositories = [{ repository: "owner/app", locationIds: [appLocation.id] },
    ...(options.single ? [] : [{ repository: "owner/api", locationIds: [apiLocation.id] }])];
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
  const sent: ControlPlaneToRunner[] = [];
  hub.sendToRunner = ((_runnerId: string, message: ControlPlaneToRunner) => { sent.push(message); return true; }) as Hub["sendToRunner"];
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
  return { db, hub, svc, observer, forge, reads, forgeActions, offline, sent, scope, item, stage, detail, approvedMerge, pausePreflight };
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

    // A cancelled prerequisite holds it for good too.
    h.forge.set("owner/api#7", pull("open"));
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("api"), commitment: { state: "cancelled", reason: "Not needed" } }).ok);
    const cancelled = await merge.arm();
    assert.equal(cancelled.status, 409);
    assert.match(cancelled.error!, /^Merge held: its prerequisite api in owner\/api was cancelled or removed/u);
    assert.deepEqual([h.detail("app").primaryState, h.detail("app").stateCauses], ["blocked", ["dependency_blocked"]]);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a merge armed before its prerequisite's pull request closed is held when Wollipog would perform it, spending no attempt (#4120)", async () => {
  const h = await fixture({ dependency: null });
  try {
    const merge = h.approvedMerge("app", "owner/app", 5);
    const armed = await merge.arm();
    assert.equal(armed.ok, true, armed.error ?? "armed");
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.actionAdmission?.kind, "pr_merge_enqueue");
    // The dependency reaches the ledger without the armed guard, as an older control plane could
    // have written it, and its prerequisite's pull request then closes without merging.
    h.db.raw().prepare("INSERT INTO campaign_work_item_dependencies (work_item_id, depends_on_id) VALUES (?, ?)").run(h.item("app"), h.item("api"));
    h.forge.set("owner/api#7", pull("closed"));
    const digest = h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.resourceDigest;
    const executed = await h.svc.executeWorkflowDecision("app", merge.occurrenceId, { resourceDigest: digest });
    assert.equal(executed.status, 409);
    assert.match(executed.error!, /^Merge held: prerequisite pull request owner\/api#7 \(api in owner\/api\) was closed without merging, so this merge is not attempted\./u);
    assert.deepEqual(h.forgeActions, [], "no enqueue was sent");
    const after = h.db.workflowDecisionByOccurrence(merge.occurrenceId)!;
    assert.equal(after.forgeAction, undefined, "no attempt was spent");
    assert.equal(after.status, "approved");
    assert.equal(after.actionAdmission?.kind, "pr_merge_enqueue", "still armed");
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

    // Wollipog's enqueue: armed with the prerequisite merged. Cancelling it now is refused, since
    // nothing could hold an armed merge; but its fact can still stop being fresh while GitHub is read
    // for the enqueue (here the owner/api read fails), and that holds the enqueue.
    h.forge.set("owner/api#7", pull("merged"));
    assert.equal((await merge.arm()).ok, true);
    const executing = (() => {
      const pausedAgain = h.pausePreflight();
      const run = h.svc.executeWorkflowDecision("app", merge.occurrenceId, { resourceDigest: h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.resourceDigest });
      return { run, ...pausedAgain };
    })();
    await executing.reached;
    assert.equal(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("api"), commitment: { state: "cancelled", reason: "Not needed" } }).status, 409);
    h.forge.delete("owner/api#7");
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    executing.release();
    const stopped = await executing.run;
    assert.equal(stopped.status, 409);
    assert.match(stopped.error!, /^Merge held until prerequisite pull request owner\/api#7 \(api in owner\/api\) is observed MERGED; it is not freshly observed\./u);
    assert.deepEqual(h.forgeActions, [], "no enqueue was sent");
    const refused = h.db.workflowDecisionByOccurrence(merge.occurrenceId)!;
    assert.deepEqual([refused.forgeAction?.outcome, refused.forgeAction?.refusal?.reason], ["refused", "merge_held"]);
    assert.equal(refused.status, "approved", "a hold never revokes the approval");
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
    const refusal = /^This change would add a hold to the merge of owner\/app#5 \(prerequisite api-field\), but that merge is already armed and nothing could hold it now\. Make the change after that merge settles\.$/u;
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
    assert.match(moved2.error!, /^This change would add a hold to the merge of owner\/app#5 \(prerequisite api\)/u);
    assert.equal(h.db.campaignWorkLedger.currentAssignment("app")?.workItemId, id("app-field"), "rolled back");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("the work list filters by repository and counts each repository's items by state (#4120)", async () => {
  const h = await fixture();
  try {
    const page = (query: Parameters<typeof h.db.campaignWorkLedger.page>[1]) => h.db.campaignWorkLedger.page("root", query, Date.now());
    const all = page({ state: "all" });
    assert.ok(all.ok);
    // The plan records all three in one call, so their order among equal times is not asserted.
    assert.deepEqual(all.data.items.map((item) => `${item.key} ${item.repository}`).sort(), ["api owner/api", "app owner/app", "app-sibling owner/app"]);
    // Each repository's counts cover all its items, whatever the list's filters.
    const counted = all.data.repositories!.map((entry) => [entry.repository, entry.total, Object.entries(entry.byState).filter(([, count]) => count > 0)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    assert.deepEqual(counted, [["owner/api", 1, [["running", 1]]], ["owner/app", 2, [["planned", 1], ["running", 1]]]]);
    const api = page({ state: "all", repository: "Owner/API" });
    assert.ok(api.ok);
    assert.deepEqual([api.data.items.map((item) => item.key), api.data.total], [["api"], 1]);
    assert.deepEqual(api.data.repositories, all.data.repositories, "counts don't follow the filter");
    // A cursor is bound to its repository filter, and a malformed repository is refused.
    const first = page({ state: "all", repository: "owner/app", limit: 1 });
    assert.ok(first.ok && first.data.nextCursor);
    assert.equal(page({ state: "all", repository: "owner/api", limit: 1, cursor: first.data.nextCursor! }).ok, false);
    const refused = page({ state: "all", repository: "not a repository" });
    assert.equal(refused.ok, false);
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

test("the hold follows the pull request being merged: a descendant worker, a child whose attempt ended, and the root are each held (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("open"));
    // The app item names owner/app#5, the pull request each of them will try to merge.
    h.stage("app", "owner/app", 5);
    const heldOn = /^Merge held until prerequisite pull request owner\/api#7 \(api in owner\/api\) is observed MERGED; it is not merged yet\./u;

    // The app child after its attempt was verified delivered and ended.
    h.db.updateSessionStatus("app", "idle", Date.now());
    const report = h.db.appendEvent("app", { kind: "agent_message", text: "Opened owner/app#5.", final: true }, Date.now()).seq;
    const verified = h.svc.verifyCampaignChild("root", { childSessionId: "app", reportEventSeq: report, followUpsAccounted: true,
      workItem: { id: h.item("app"), outcome: "delivered" } });
    assert.ok(verified.ok, verified.error ?? "verified");
    assert.equal(h.db.campaignWorkLedger.currentAssignment("app"), null, "its attempt ended");
    h.db.updateSessionStatus("app", "running", Date.now());
    const ended = await h.approvedMerge("app", "owner/app", 5).arm();
    assert.equal(ended.status, 409, ended.error ?? "armed");
    assert.match(ended.error!, heldOn);

    // A worker that child started, with no attempt of its own.
    h.db.createSession({ id: "worker", runnerId: "r", workspaceId: "w", agentId: "agent", title: "worker", useWorktree: false, driver: "claude-code",
      config: { model: "opus" }, now: Date.now(), scope: h.scope, parentSessionId: "app" });
    h.db.updateSessionStatus("worker", "running", Date.now());
    assert.equal(h.db.campaignWorkLedger.currentAssignment("worker"), null);
    const worker = await h.approvedMerge("worker", "owner/app", 5).arm();
    assert.equal(worker.status, 409, worker.error ?? "armed");
    assert.match(worker.error!, heldOn);

    // The root Orchestrator merging it itself, which it may under Full Control.
    const identity = h.db.localIdentityContext();
    const enabled = h.svc.setCampaignControl("root", { mode: "full_control", objective: "Deliver #1",
      operations: ["implementation_question", "question", "tool_approval", "pr_merge"], delegatablePolicyIds: [] },
    h.db.getSession("root")!.parentControlPolicy!.revision, { ...identity, kind: "human", actorId: identity.userId });
    assert.ok(enabled.ok, enabled.error ?? "admission failed");
    const root = await h.approvedMerge("root", "owner/app", 5).arm();
    assert.equal(root.status, 409, root.error ?? "armed");
    assert.match(root.error!, heldOn);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("while a merge is armed, changes that would alter its hold are refused, and its permission request is rejected once held (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("merged"));
    const merge = h.approvedMerge("app", "owner/app", 5);
    assert.equal((await merge.arm()).ok, true);
    const refusal = /^This change would add a hold to the merge of owner\/app#5 \(prerequisite api\), but that merge is already armed and nothing could hold it now\./u;
    // Naming another, still open, pull request on the prerequisite.
    const named = h.svc.updateCampaignWorkItem("root", { workItemId: h.item("api"), stage: { stage: "in_review",
      pullRequests: [{ repository: "owner/api", number: 7 }, { repository: "owner/api", number: 8 }] } });
    assert.equal(named.status, 409);
    assert.match(named.error!, refusal);
    // Cancelling it.
    const cancelled = h.svc.updateCampaignWorkItem("root", { workItemId: h.item("api"), commitment: { state: "cancelled", reason: "Not needed" } });
    assert.equal(cancelled.status, 409);
    assert.match(cancelled.error!, refusal);
    const api = h.detail("api");
    assert.deepEqual([api.commitment, api.stage?.pullRequests.length], ["committed", 1], "both rolled back");

    // The prerequisite's fact stops being fresh after arming (its read fails). When the provider asks
    // to run the armed command, the control plane rejects it and parks the child.
    h.forge.delete("owner/api#7");
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    const command = canonicalPrMergeEnqueueCommand(merge.snapshot);
    const ask = (requestId: string) => h.svc.onSessionEvent("app", { kind: "permission_request", requestId, occurrenceId: requestId,
      requestSource: "provider_tool", title: "Enqueue PR", context: { toolName: "Bash", input: command },
      options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] });
    const resolutions = () => h.sent.filter((message) => message.type === "resolve_permission")
      .map((message) => [(message as { requestId: string }).requestId, (message as { optionId: string | null }).optionId]);
    h.sent.length = 0;
    ask("enqueue-1");
    assert.deepEqual(resolutions(), [["enqueue-1", "reject"]]);
    const held = h.db.workflowDecisionByOccurrence(merge.occurrenceId)!;
    assert.deepEqual([held.status, held.actionAdmission?.kind], ["approved", "pr_merge_enqueue"], "still approved and armed");
    const watch = h.db.pullRequestWatches.visibleFor("app")!;
    assert.deepEqual([watch.repository, watch.number, watch.state], ["owner/api", 7, "watching"]);
    // Observed MERGED again, the same command is allowed and consumes the approval.
    h.forge.set("owner/api#7", pull("merged"));
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    ask("enqueue-2");
    assert.deepEqual(resolutions(), [["enqueue-1", "reject"], ["enqueue-2", "once"]]);
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.status, "consumed");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a prerequisite whose repository isn't known holds a merge in a campaign of several repositories, not in a campaign of one (#4120)", async () => {
  for (const single of [false, true]) {
    const h = await fixture({ dependency: null, single });
    try {
      const plan = h.svc.recordCampaignPlan("root", { planComplete: true, items: [
        { key: "schema", title: "Agree Account Schema" }, { key: "app", dependsOnKeys: ["schema"] }] });
      assert.ok(plan.ok, plan.error ?? "plan refused");
      const result = await h.approvedMerge("app", "owner/app", 5).arm();
      if (single) {
        assert.equal(result.ok, true, result.error ?? "armed");
        assert.equal(h.detail("app").mergeDependencies, undefined, "it works in the campaign's only repository");
      } else {
        assert.equal(result.status, 409, result.error ?? "armed");
        assert.match(result.error!, /^Merge held: prerequisite schema in an unknown repository names no pull request yet/u);
        assert.deepEqual(h.detail("app").mergeDependencies!.map((dependency) => [dependency.key, dependency.repository, dependency.status]),
          [["schema", null, "unmerged"]]);
      }
    } finally { h.observer.dispose(); h.db.close(); }
  }
});

test("a prerequisite's pull request counts in its own repository, and every pull request it names must merge (#4120)", async () => {
  const h = await fixture({ dependency: "app-sibling" });
  try {
    // app-sibling tracks an owner/app issue and names owner/app#6, but also owner/api#8.
    h.forge.set("owner/app#6", pull("merged"));
    h.forge.set("owner/api#8", pull("open"));
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("app-sibling"), stage: { stage: "merge_queued",
      pullRequests: [{ repository: "owner/app", number: 6 }, { repository: "owner/api", number: 8 }] } }).ok);
    assert.equal(h.detail("app-sibling").repository, "owner/app", "shown in its first repository");
    const merge = h.approvedMerge("app", "owner/app", 5);
    const held = await merge.arm();
    assert.equal(held.status, 409, held.error ?? "armed");
    assert.match(held.error!, /^Merge held until prerequisite pull request owner\/api#8 \(app-sibling in owner\/app\) is observed MERGED; it is not merged yet\./u);
    // Each was read through a runner of its own repository.
    assert.deepEqual(h.reads.map((read) => `${read.runnerId} ${read.refs.join(",")}`).sort(), ["r owner/app#6", "r2 owner/api#8"]);
    h.forge.set("owner/api#8", pull("merged"));
    const armed = await merge.arm();
    assert.equal(armed.ok, true, armed.error ?? "armed");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a prerequisite pull request outside the campaign's repositories never meets a hold, and is never read (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("merged"));
    h.forge.set("other/lib#3", pull("merged"));
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("api"), stage: { stage: "merge_queued",
      pullRequests: [{ repository: "owner/api", number: 7 }, { repository: "other/lib", number: 3 }] } }).ok);
    const merge = h.approvedMerge("app", "owner/app", 5);
    const held = await merge.arm();
    assert.equal(held.status, 409, held.error ?? "armed");
    assert.match(held.error!, /^Merge held: prerequisite pull request other\/lib#3 \(api in owner\/api\) is in a repository outside this campaign's repositories/u);
    assert.equal(h.db.pullRequestWatches.visibleFor("app"), undefined, "no Location could wake it");
    assert.ok(h.reads.length > 0 && h.reads.every((read) => !read.refs.includes("other/lib#3")), "the root's login never reads it");
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.status, "approved");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("removing the dependency ends a parked hold's watch as lost (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("open"));
    assert.equal((await h.approvedMerge("app", "owner/app", 5).arm()).status, 409);
    const watch = h.db.pullRequestWatches.visibleFor("app")!;
    assert.equal(watch.state, "watching");
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("app"), dependsOn: [] }).ok, "not armed, so it may change");
    h.svc.campaignWorkObserved("root");
    const lost = h.db.pullRequestWatches.view(watch.watchId)!;
    assert.equal(lost.state, "lost");
    assert.match(lost.reason!, /^no approved merge of yours waits on this pull request any more/u);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("the work-items route filters by repository and returns each repository's counts (#4120)", async () => {
  const h = await fixture();
  try {
    const identity = h.db.localIdentityContext();
    const human: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
    const status = Fastify();
    registerCampaignStatusRoutes(status, { db: h.db, requestPrincipal: () => human });
    await status.ready();
    const api = await status.inject({ method: "GET", url: "/api/sessions/root/campaign/work-items?state=all&repository=Owner%2FAPI" });
    assert.equal(api.statusCode, 200);
    const page = api.json() as { items: Array<{ key: string }>; total: number; repositories: Array<{ repository: string; total: number }> };
    assert.deepEqual([page.items.map((item) => item.key), page.total], [["api"], 1]);
    assert.deepEqual(page.repositories.map((entry) => [entry.repository, entry.total]).sort(), [["owner/api", 1], ["owner/app", 2]]);
    const refused = await status.inject({ method: "GET", url: "/api/sessions/root/campaign/work-items?state=all&repository=not%20a%20repository" });
    assert.equal(refused.statusCode, 400);
    await status.close();
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a prerequisite observed MERGED through its Location wakes the parked child through the observer's change alone (#4120)", async () => {
  const h = await fixture();
  // Wired as index.ts wires them: the observer's change bumps the campaign, whose refresh settles watches.
  const observations = new CampaignWorkObservations({ db: h.db, refresh: (id) => h.svc.campaignWorkObserved(id), warn: () => undefined, delayMs: 60_000 });
  let count = 0;
  const observer = new CampaignForgeObserver({
    observingRunner: (campaignId, repository) => h.db.campaignForgeObservingRunner(campaignId, repository, (runnerId) => h.hub.isRunnerOnline(runnerId)),
    requestFromRunner: (runnerId, requestId, message, timeout) => h.hub.requestFromRunner(runnerId, requestId, message, timeout),
    store: h.db.campaignForgeObservations, backgroundTargets: () => [], changed: (id) => observations.forgeChanged(id), warn: () => undefined,
    newRequestId: () => `wired_${++count}`,
  });
  try {
    h.forge.set("owner/api#7", pull("open"));
    assert.equal((await h.approvedMerge("app", "owner/app", 5).arm()).status, 409);
    const watch = h.db.pullRequestWatches.visibleFor("app")!;
    h.db.updateSessionStatus("app", "idle", Date.now());
    h.forge.set("owner/api#7", pull("merged"));
    await observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    assert.equal(h.db.pullRequestWatches.view(watch.watchId)!.state, "watching", "coalesced, not yet applied");
    observations.flush();
    const fired = h.db.pullRequestWatches.view(watch.watchId)!;
    assert.deepEqual([fired.state, fired.outcome], ["fired", "merged"]);
    assert.ok(h.reads.every((read) => read.runnerId === "r2"), "read through the owner/api Location");
  } finally { observations.dispose(); observer.dispose(); h.observer.dispose(); h.db.close(); }
});

test("a held armed merge's permission request is rejected even when a person must answer it, and a card asked earlier can't be allowed (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("merged"));
    const merge = h.approvedMerge("app", "owner/app", 5);
    assert.equal((await merge.arm()).ok, true);
    // A governance policy sends the command to a person instead of automatic admission.
    h.db.upsertGovernancePolicy({ policyId: "protected", name: "Protected", effect: "ask", priority: 1, enabled: true,
      scope: { toolName: "Bash" }, conditions: { humanRequired: true } }, Date.now());
    const command = canonicalPrMergeEnqueueCommand(merge.snapshot);
    const ask = (requestId: string) => h.svc.onSessionEvent("app", { kind: "permission_request", requestId, occurrenceId: requestId,
      requestSource: "provider_tool", title: "Enqueue PR", context: { toolName: "Bash", input: command },
      options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] });
    const resolutions = () => h.sent.filter((message) => message.type === "resolve_permission")
      .map((message) => [(message as { requestId: string }).requestId, (message as { optionId: string | null }).optionId]);
    const cards = () => (h.db.getSession("app")!.pendingApproval ? [h.db.getSession("app")!.pendingApproval!] : [])
      .flatMap((approval) => [approval, ...((approval as { queued?: Array<{ requestId: string }> }).queued ?? [])]).map((approval) => approval.requestId);

    // Not held: the person is asked, as the policy says.
    h.sent.length = 0;
    ask("asked-early");
    assert.deepEqual(resolutions(), [], "nothing settled it automatically");
    assert.ok(cards().includes("asked-early"));
    assert.equal(h.db.getSession("app")!.pendingApproval!.humanRequired, true);

    // The prerequisite's fact stops being fresh. The card asked earlier can't be allowed now, by anyone...
    h.forge.delete("owner/api#7");
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    const identity = h.db.localIdentityContext();
    const allowed = h.svc.approve("app", "asked-early", "once", { kind: "human", id: identity.userId });
    assert.equal(allowed.status, 409);
    assert.match(allowed.error!, /^Merge held until prerequisite pull request owner\/api#7 \(api in owner\/api\) is observed MERGED; it is not freshly observed\./u);
    assert.deepEqual(resolutions(), [], "no allow reached the runner");
    assert.ok(cards().includes("asked-early"), "the card stays for a rejection");
    // ...and a new request for the command is rejected at once, with no card to allow.
    ask("asked-late");
    assert.deepEqual(resolutions(), [["asked-late", "reject"]]);
    assert.ok(!cards().includes("asked-late"));
    const held = h.db.workflowDecisionByOccurrence(merge.occurrenceId)!;
    assert.deepEqual([held.status, held.actionAdmission?.kind], ["approved", "pr_merge_enqueue"], "still approved and armed");
    // Rejecting the early card still works.
    assert.equal(h.svc.approve("app", "asked-early", "reject", { kind: "human", id: identity.userId }).ok, true);
    assert.deepEqual(resolutions(), [["asked-late", "reject"], ["asked-early", "reject"]]);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a merge of a finished item's pull request parked on its prerequisite is woken by the background pass (#4120)", async () => {
  const h = await fixture();
  const observations = new CampaignWorkObservations({ db: h.db, refresh: (id) => h.svc.campaignWorkObserved(id), warn: () => undefined, delayMs: 60_000 });
  let count = 0, clock = Date.now();
  // Wired as index.ts wires the background pass: its targets are `campaignForgeBackgroundTargets`.
  const observer = new CampaignForgeObserver({
    observingRunner: (campaignId, repository) => h.db.campaignForgeObservingRunner(campaignId, repository, (runnerId) => h.hub.isRunnerOnline(runnerId)),
    requestFromRunner: (runnerId, requestId, message, timeout) => h.hub.requestFromRunner(runnerId, requestId, message, timeout),
    store: h.db.campaignForgeObservations, backgroundTargets: (include) => h.db.campaignForgeBackgroundTargets(include),
    changed: (id) => observations.forgeChanged(id), warn: () => undefined, newRequestId: () => `background_${++count}`, now: () => clock,
  });
  try {
    h.forge.set("owner/api#7", pull("open"));
    h.stage("app", "owner/app", 5);
    // The prerequisite is verified delivered while its pull request is still open, and the dependent
    // is cancelled while it still names owner/app#5: both are finished, so neither is read for itself.
    h.db.updateSessionStatus("api", "idle", Date.now());
    const report = h.db.appendEvent("api", { kind: "agent_message", text: "Delivered api.", final: true }, Date.now()).seq;
    const verified = h.svc.verifyCampaignChild("root", { childSessionId: "api", reportEventSeq: report, followUpsAccounted: true,
      workItem: { id: h.item("api"), outcome: "delivered" } });
    assert.ok(verified.ok, verified.error ?? "verified");
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("app"), commitment: { state: "cancelled", reason: "Superseded" } }).ok);
    assert.deepEqual([h.detail("api").primaryState, h.detail("app").primaryState], ["delivered", "cancelled"]);
    assert.ok(!h.db.campaignWorkLedger.forgeBackgroundTargets(() => true).some(({ refs }) => refs.some((ref) => ref.number === 7)),
      "no finished item's prerequisite is read for itself");
    h.db.updateSessionStatus("app", "running", Date.now());
    assert.equal((await h.approvedMerge("app", "owner/app", 5).arm()).status, 409);
    const watch = h.db.pullRequestWatches.visibleFor("app")!;
    assert.deepEqual([watch.repository, watch.number, watch.state], ["owner/api", 7, "watching"]);
    h.db.updateSessionStatus("app", "idle", Date.now());

    // It merges; nothing reads it on demand. The next background pass after the interval does.
    h.forge.set("owner/api#7", pull("merged"));
    h.reads.length = 0;
    clock += 10 * 60_000;
    await observer.backgroundPass();
    assert.ok(h.reads.some((read) => read.runnerId === "r2" && read.refs.includes("owner/api#7")), "read through the owner/api Location");
    observations.flush();
    const fired = h.db.pullRequestWatches.view(watch.watchId)!;
    assert.deepEqual([fired.state, fired.outcome], ["fired", "merged"]);
  } finally { observations.dispose(); observer.dispose(); h.observer.dispose(); h.db.close(); }
});

test("while a session's armed merge is held, Claude's policy hook denies its shell commands, which it can't tell apart (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("merged"));
    const merge = h.approvedMerge("app", "owner/app", 5);
    assert.equal((await merge.arm()).ok, true);
    const hook = (toolUseId: string, toolName: string) => h.svc.evaluatePolicyHook("app", { hookEventName: "PreToolUse", providerSessionId: "provider-app",
      permissionMode: "bypassPermissions", toolUseId, context: { toolName } });
    // Not held: the hook defers as before (no policy matches).
    assert.equal(hook("bash-1", "Bash").data?.decision, "defer");
    // The prerequisite's fact stops being fresh: a shell command, possibly the armed merge, is denied.
    h.forge.delete("owner/api#7");
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    const denied = hook("bash-2", "Bash");
    assert.equal(denied.data?.decision, "deny");
    assert.match(denied.data?.reason ?? "", /^Merge held until prerequisite pull request owner\/api#7 \(api in owner\/api\) is observed MERGED; it is not freshly observed\..* Command tools are blocked while this session.s armed merge is held/su);
    const watch = h.db.pullRequestWatches.visibleFor("app")!;
    assert.deepEqual([watch.repository, watch.number, watch.state], ["owner/api", 7, "watching"], "parked on the prerequisite");
    // Every tool that can run a command is denied too; other tools are not affected, and the approval stays armed.
    assert.deepEqual(["PowerShell", "Monitor"].map((tool) => hook(`${tool}-1`, tool).data?.decision), ["deny", "deny"]);
    assert.equal(hook("read-1", "Read").data?.decision, "defer");
    const held = h.db.workflowDecisionByOccurrence(merge.occurrenceId)!;
    assert.deepEqual([held.status, held.actionAdmission?.kind], ["approved", "pr_merge_enqueue"]);
    // Once observed MERGED again, shell commands pass the hook again.
    h.forge.set("owner/api#7", pull("merged"));
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    assert.equal(hook("bash-3", "Bash").data?.decision, "defer");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("an armed merge's prerequisite observed MERGED stays met as its observation ages, so nothing is blocked (#4120)", async () => {
  const h = await fixture();
  try {
    // Merged, and its head branch deleted, so the background pass reads it no more.
    const merged = pull("merged", { headBranch: { name: "api-field", tipSha: null } } as Partial<CampaignForgePullRequestObservation>);
    h.forge.set("owner/api#7", merged);
    const merge = h.approvedMerge("app", "owner/app", 5);
    assert.equal((await merge.arm()).ok, true);
    const ref = { repository: "owner/api", number: 7 };
    // The observation ages past the freshness window.
    h.db.campaignForgeObservations.record("root", "r2", [{ ref, observation: merged }], Date.now() - 11 * 60_000);
    assert.equal(h.db.campaignForgeObservations.facts("root", [ref], Date.now())[0]!.fact.availability, "stale");
    assert.equal(h.db.campaignForgeObservations.readState("root", [ref], true).get("owner/api#7")!.finished, true,
      "finished: the background pass won't read it again");
    // The policy hook lets the session's shell commands through...
    const hook = h.svc.evaluatePolicyHook("app", { hookEventName: "PreToolUse", providerSessionId: "provider-app",
      permissionMode: "bypassPermissions", toolUseId: "bash-stale", context: { toolName: "Bash" } });
    assert.equal(hook.data?.decision, "defer");
    assert.equal(h.db.pullRequestWatches.visibleFor("app"), undefined, "nothing parked");
    // ...and the armed command's permission request is admitted as usual.
    h.sent.length = 0;
    h.svc.onSessionEvent("app", { kind: "permission_request", requestId: "enqueue-stale", occurrenceId: "enqueue-stale",
      requestSource: "provider_tool", title: "Enqueue PR", context: { toolName: "Bash", input: canonicalPrMergeEnqueueCommand(merge.snapshot) },
      options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] });
    assert.deepEqual(h.sent.filter((message) => message.type === "resolve_permission").map((message) => (message as { optionId: string | null }).optionId), ["once"]);
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.status, "consumed");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a prerequisite added while arming reads, with only an aged MERGED stored, still holds the merge (#4120)", async () => {
  const h = await fixture({ dependency: null });
  try {
    // owner/api#7 was observed MERGED long ago, and its Location can't be asked now.
    const ref = { repository: "owner/api", number: 7 };
    h.db.campaignForgeObservations.record("root", "r2", [{ ref, observation: pull("merged") }], Date.now() - 11 * 60_000);
    assert.equal(h.db.campaignForgeObservations.facts("root", [ref], Date.now())[0]!.fact.availability, "stale");
    h.offline.add("r2");
    const merge = h.approvedMerge("app", "owner/app", 5);
    const paused = h.pausePreflight();
    const arming = merge.arm();
    await paused.reached;
    // Not armed yet, so the ledger accepts the dependency; the arming read never covered it.
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("app"), dependsOn: [h.item("api")] }).ok);
    paused.release();
    const held = await arming;
    assert.equal(held.status, 409, held.error ?? "armed");
    assert.match(held.error!, /^Merge held until prerequisite pull request owner\/api#7 \(api in owner\/api\) is observed MERGED; it is not freshly observed\./u);
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.actionAdmission, undefined, "nothing was armed");
    assert.deepEqual(h.reads, [], "nothing read it");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a dependent verified delivered while its own pull request is open waits on its prerequisite, and is blocked once that can never merge (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("open"));
    h.forge.set("owner/app#5", pull("open"));
    h.stage("app", "owner/app", 5);
    h.db.updateSessionStatus("app", "idle", Date.now());
    const report = h.db.appendEvent("app", { kind: "agent_message", text: "Opened owner/app#5.", final: true }, Date.now()).seq;
    const verified = h.svc.verifyCampaignChild("root", { childSessionId: "app", reportEventSeq: report, followUpsAccounted: true,
      workItem: { id: h.item("app"), outcome: "delivered" } });
    assert.ok(verified.ok, verified.error ?? "verified");
    const read = async () => { await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }, { repository: "owner/app", number: 5 }]); return h.detail("app"); };
    const unfinished = () => { const page = h.db.campaignWorkLedger.page("root", { state: "unfinished" }, Date.now()); assert.ok(page.ok); return page.data.items.map((item) => item.key); };
    // Its prerequisite hasn't merged: Waiting for Prerequisite Merge, naming the pull request, and unfinished.
    const waiting = await read();
    assert.deepEqual([waiting.primaryState, waiting.stateCauses], ["waiting", ["dependency_unmerged"]]);
    assert.deepEqual(waiting.mergeDependencies!.map((dependency) => [dependency.status, dependency.pullRequests.map(({ ref }) => `${ref.repository}#${ref.number}`)]),
      [["unmerged", ["owner/api#7"]]]);
    assert.ok(unfinished().includes("app"));
    // The wait after its verification counts as Waiting Time: an hour later, an hour more of it.
    const HOUR_MS = 60 * 60_000;
    const waitingAt = (at: number) => {
      const metric = h.db.campaignWorkLedger.detail("root", h.item("app"), at)!.times!.waiting;
      assert.notEqual(metric.availability, "unavailable");
      return "value" in metric ? metric.value : NaN;
    };
    const verifiedAt = Date.now();
    assert.equal(waitingAt(verifiedAt + HOUR_MS) - waitingAt(verifiedAt), HOUR_MS);
    // It closes without merging: blocked, and this item's merge is never attempted.
    h.forge.set("owner/api#7", pull("closed"));
    const blocked = await read();
    assert.deepEqual([blocked.primaryState, blocked.stateCauses], ["blocked", ["dependency_blocked"]]);
    // Blocked counts as Waiting Time too.
    const blockedAt = Date.now();
    assert.equal(waitingAt(blockedAt + HOUR_MS) - waitingAt(blockedAt), HOUR_MS);
    // Its own pull request merged (here despite the hold, say by a person on the forge): delivered,
    // finished, whatever the prerequisite does.
    h.forge.set("owner/app#5", pull("merged"));
    const delivered = await read();
    assert.deepEqual([delivered.primaryState, delivered.stateCauses], ["delivered", []]);
    assert.ok(!unfinished().includes("app"));
  } finally { h.observer.dispose(); h.db.close(); }
});

/** Read the forge, then how much Waiting Time the delivered dependent gained after its verification,
 * measured an hour from now so a hold still counting would show. */
async function heldFor(h: Awaited<ReturnType<typeof fixture>>, verifiedAt: number, ownNumbers = [5]): Promise<number> {
  await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }, ...ownNumbers.map((number) => ({ repository: "owner/app", number }))]);
  assert.equal(h.detail("app").primaryState, "delivered");
  const waitingAt = (at: number) => {
    const metric = h.db.campaignWorkLedger.detail("root", h.item("app"), at)!.times!.waiting;
    return "value" in metric ? metric.value : NaN;
  };
  return waitingAt(Date.now() + 60 * 60_000) - waitingAt(verifiedAt);
}

async function verifiedHolding(forgeOwn: CampaignForgePullRequestObservation) {
  const h = await fixture();
  h.forge.set("owner/api#7", pull("open"));
  h.forge.set("owner/app#5", forgeOwn);
  h.stage("app", "owner/app", 5);
  await verifyAppDelivered(h);
  const verifiedAt = h.detail("app").verifications.at(-1)!.verifiedAt;
  await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }, { repository: "owner/app", number: 5 }]);
  return { h, verifiedAt };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("a hold's end stays in Waiting Time after its own merge, from the forge's merge time (#4120)", async () => {
  const { h, verifiedAt } = await verifiedHolding(pull("open"));
  try {
    assert.deepEqual(h.detail("app").stateCauses, ["dependency_unmerged"]);
    await tick();
    const mergedAt = Date.now();
    await tick();
    h.forge.set("owner/app#5", pull("merged", { mergedAt }));
    assert.equal(await heldFor(h, verifiedAt), mergedAt - verifiedAt, "from verification to its own merge, and no further");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a dependent naming several pull requests is held until the last merges, and one closed unmerged is set aside (#4120)", async () => {
  const { h, verifiedAt } = await verifiedHolding(pull("open"));
  try {
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("app"), stage: { stage: "merged",
      pullRequests: [{ repository: "owner/app", number: 5 }, { repository: "owner/app", number: 6 }] } }).ok);
    await tick();
    const first = Date.now();
    await tick();
    const last = Date.now();
    await tick();
    h.forge.set("owner/app#5", pull("merged", { mergedAt: last }));
    h.forge.set("owner/app#6", pull("merged", { mergedAt: first }));
    assert.equal(await heldFor(h, verifiedAt, [5, 6]), last - verifiedAt, "the later merge, wherever it is named");
    h.forge.set("owner/app#5", pull("closed"));
    assert.equal(await heldFor(h, verifiedAt, [5, 6]), first - verifiedAt, "the closed one has no merge to wait for");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a hold ends at the prerequisite's merge, where the state turns delivered, not at the dependent's later one (#4120)", async () => {
  const { h, verifiedAt } = await verifiedHolding(pull("open"));
  try {
    await tick();
    const prerequisiteMergedAt = Date.now();
    await tick();
    h.forge.set("owner/api#7", pull("merged", { mergedAt: prerequisiteMergedAt }));
    assert.equal(await heldFor(h, verifiedAt), prerequisiteMergedAt - verifiedAt, "while its own pull request is still open");
    await tick();
    h.forge.set("owner/app#5", pull("merged", { mergedAt: Date.now() }));
    await tick();
    assert.equal(await heldFor(h, verifiedAt), prerequisiteMergedAt - verifiedAt, "and its own later merge doesn't extend it");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a dependent merged before its verification was never held, and a merge with no known time counts no hold (#4120)", async () => {
  const merged = await verifiedHolding(pull("merged", { mergedAt: 1 }));
  try {
    assert.equal(await heldFor(merged.h, merged.verifiedAt), 0, "merged before it was verified");
  } finally { merged.h.observer.dispose(); merged.h.db.close(); }
  const unknown = await verifiedHolding(pull("open"));
  try {
    await tick();
    unknown.h.forge.set("owner/app#5", pull("merged"));
    assert.equal(await heldFor(unknown.h, unknown.verifiedAt), 0, "an older runner's merge has no time");
  } finally { unknown.h.observer.dispose(); unknown.h.db.close(); }
  // One known time isn't enough when the other merge could have ended the hold first.
  const partial = await verifiedHolding(pull("open"));
  try {
    await tick();
    partial.h.forge.set("owner/api#7", pull("merged"));
    partial.h.forge.set("owner/app#5", pull("merged", { mergedAt: Date.now() }));
    assert.equal(await heldFor(partial.h, partial.verifiedAt), 0, "the prerequisite's merge, of unknown time, may have ended it earlier");
  } finally { partial.h.observer.dispose(); partial.h.db.close(); }
});

test("a merge time can't carry a hold past the read that saw the merge (#4120)", async () => {
  const { h, verifiedAt } = await verifiedHolding(pull("open"));
  try {
    await tick();
    const beforeRead = Date.now();
    h.forge.set("owner/app#5", pull("merged", { mergedAt: beforeRead + 24 * 60 * 60_000 }));
    const held = await heldFor(h, verifiedAt);
    assert.ok(held >= beforeRead - verifiedAt && held < 60_000, `bounded by the observation, got ${held}`);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("two items placed in one repository under another repository's issue keep a display-only dependency, unless one names a pull request elsewhere (#4120)", async () => {
  const setup = async () => {
    const h = await fixture({ dependency: null });
    // A second child in the owner/api Location.
    h.db.createSession({ id: "api2", runnerId: "r2", workspaceId: "a", agentId: "agent", title: "api2", useWorktree: false, driver: "claude-code",
      config: { model: "opus" }, now: Date.now(), scope: h.scope, parentSessionId: "root" });
    h.db.updateSessionStatus("api2", "running", Date.now());
    // Both track the owner/app feature issue; the second depends on the first.
    const plan = h.svc.recordCampaignPlan("root", { planComplete: true, items: [
      { key: "api-schema", title: "Add Account Schema", issue: { repository: "owner/app", number: 1 } },
      { key: "api-route", title: "Add Account Route", issue: { repository: "owner/app", number: 1 }, dependsOnKeys: ["api-schema"] },
    ] });
    assert.ok(plan.ok, plan.error ?? "plan refused");
    const id = (key: string) => plan.data!.items.find((entry) => entry.key === key)!.workItemId;
    h.db.appendEvent("api2", { kind: "user_message", text: "Deliver api-route" }, Date.now());
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: id("api-schema"), childSessionId: "api" }).ok);
    assert.ok(h.svc.assignCampaignWorkItem("root", { workItemId: id("api-route"), childSessionId: "api2" }).ok);
    return { h, id };
  };
  for (const order of [["api", "api2"], ["api2", "api"]] as const) {
    const { h, id } = await setup();
    try {
      h.forge.set("owner/api#8", pull("open"));
      h.forge.set("owner/api#9", pull("open"));
      assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: id("api-schema"), stage: { stage: "in_review", pullRequests: [{ repository: "owner/api", number: 8 }] } }).ok);
      assert.equal(h.db.campaignWorkLedger.detail("root", id("api-route"), Date.now())!.mergeDependencies, undefined, "both work in owner/api");
      const merges = { api: h.approvedMerge("api", "owner/api", 8), api2: h.approvedMerge("api2", "owner/api", 9) };
      for (const child of order) {
        const armed = await merges[child].arm();
        assert.equal(armed.ok, true, `${child}: ${armed.error ?? "armed"}`);
      }
      assert.deepEqual(h.reads, [], "no prerequisite to read");
    } finally { h.observer.dispose(); h.db.close(); }
  }
  // The prerequisite names a pull request in owner/app as well: that one must merge first.
  const { h, id } = await setup();
  try {
    h.forge.set("owner/api#8", pull("merged"));
    h.forge.set("owner/app#11", pull("open"));
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: id("api-schema"), stage: { stage: "in_review",
      pullRequests: [{ repository: "owner/api", number: 8 }, { repository: "owner/app", number: 11 }] } }).ok);
    const held = await h.approvedMerge("api2", "owner/api", 9).arm();
    assert.equal(held.status, 409, held.error ?? "armed");
    assert.match(held.error!, /^Merge held until prerequisite pull request owner\/app#11 \(api-schema in owner\/api\) is observed MERGED/u);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a campaign of one repository keeps dependencies display-only, even on a pull request elsewhere, until its boundary has two (#4120)", async () => {
  const h = await fixture({ single: true });
  try {
    // The prerequisite names owner/api#7, a repository this campaign doesn't have.
    h.forge.set("owner/api#7", pull("open"));
    const merge = h.approvedMerge("app", "owner/app", 5);
    const armed = await merge.arm();
    assert.equal(armed.ok, true, armed.error ?? "armed");
    assert.equal(h.detail("app").mergeDependencies, undefined, "display-only, as before #4120");
    assert.deepEqual(h.reads, []);
    // owner/api joins the boundary: the dependency holds again, and a new merge is held.
    const policy = h.db.getSession("root")!.orchestratorPolicy!;
    policy.repositories = [...(policy.repositories ?? []), { repository: "owner/api", locationIds: [] }];
    h.db.raw().prepare("UPDATE sessions SET orchestrator_policy=? WHERE id='root'").run(JSON.stringify(policy));
    assert.deepEqual(h.db.campaignRepositoriesOf("root"), ["owner/app", "owner/api"]);
    assert.deepEqual(h.detail("app").mergeDependencies?.map((dependency) => [dependency.key, dependency.status]), [["api", "unmerged"]]);
    const held = await h.approvedMerge("app", "owner/app", 6).arm();
    assert.equal(held.status, 409, held.error ?? "armed");
    assert.match(held.error!, /owner\/api#7/u);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a prerequisite removed from scope blocks its dependent through the real store, and its merge is not attempted (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("open"));
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("api"), commitment: { state: "scope_removed", reason: "Out of scope" } }).ok);
    assert.equal(h.detail("api").primaryState, "removed");
    const dependent = h.detail("app");
    assert.deepEqual([dependent.primaryState, dependent.stateCauses], ["blocked", ["dependency_blocked"]]);
    assert.deepEqual(dependent.mergeDependencies!.map((dependency) => [dependency.key, dependency.status]), [["api", "failed"]]);
    const held = await h.approvedMerge("app", "owner/app", 5).arm();
    assert.equal(held.status, 409, held.error ?? "armed");
    assert.match(held.error!, /^Merge held: its prerequisite api in owner\/api was cancelled or removed/u);
    assert.equal(h.db.pullRequestWatches.visibleFor("app"), undefined, "nothing to wait for");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a prerequisite whose pull request is named only by a recorded delivery holds the merge until that pull request is MERGED (#4120)", async () => {
  const h = await fixture({ dependency: null });
  try {
    // A prerequisite with no stage: its only pull request is the one its recorded delivery names.
    const plan = h.svc.recordCampaignPlan("root", { planComplete: true, items: [
      { key: "lib", title: "Publish Account Client", issue: { repository: "owner/api", number: 3 } }, { key: "app", dependsOnKeys: ["lib"] }] });
    assert.ok(plan.ok, plan.error ?? "plan refused");
    const lib = plan.data!.items.find((entry) => entry.key === "lib")!.workItemId;
    const recorded = h.db.campaignWorkLedger.recordDelivery("root", "root", { workItemId: lib,
      pullRequests: [{ repository: "owner/api", number: 9, mergeCommitSha: "f".repeat(40), baseRef: "main" }], report: null, note: "Delivered by the API team" }, Date.now());
    assert.ok(recorded.ok, recorded.ok ? "" : recorded.error);
    assert.equal(h.db.campaignWorkLedger.detail("root", lib, Date.now())!.stage, null, "no stage names it");
    // The forge doesn't read it MERGED (yet): the merge waits on it.
    h.forge.set("owner/api#9", pull("open"));
    const merge = h.approvedMerge("app", "owner/app", 5);
    const held = await merge.arm();
    assert.equal(held.status, 409, held.error ?? "armed");
    assert.match(held.error!, /^Merge held until prerequisite pull request owner\/api#9 \(lib in owner\/api\) is observed MERGED; it is not merged yet\./u);
    h.forge.set("owner/api#9", pull("merged"));
    const armed = await merge.arm();
    assert.equal(armed.ok, true, armed.error ?? "armed");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("an armed merge held for good denies the session's command tools, and a new merge request superseding it restores them (#4120)", async () => {
  const h = await fixture({ dependency: null });
  try {
    const merge = h.approvedMerge("app", "owner/app", 5);
    assert.equal((await merge.arm()).ok, true);
    // The dependency reaches the ledger without the armed guard (as an older control plane could have
    // written it), and the prerequisite's pull request closes without merging: held for good.
    h.db.raw().prepare("INSERT INTO campaign_work_item_dependencies (work_item_id, depends_on_id) VALUES (?, ?)").run(h.item("app"), h.item("api"));
    h.forge.set("owner/api#7", pull("closed"));
    await h.observer.readNow("root", [{ repository: "owner/api", number: 7 }]);
    const hook = (toolUseId: string) => h.svc.evaluatePolicyHook("app", { hookEventName: "PreToolUse", providerSessionId: "provider-app",
      permissionMode: "bypassPermissions", toolUseId, context: { toolName: "Bash" } });
    const denied = hook("bash-closed");
    assert.equal(denied.data?.decision, "deny");
    assert.match(denied.data?.reason ?? "", /^Merge held: prerequisite pull request owner\/api#7 \(api in owner\/api\) was closed without merging/u);
    // It names the way out, through the MCP tool, since the CLI would need the denied shell.
    assert.match(denied.data?.reason ?? "", /request a new pr_merge decision for the same pull request with the request_workflow_decision tool, which replaces the armed one\./u);
    assert.match(denied.data?.reason ?? "", /\(the CLI needs the shell\)/u);
    // An armed merge can't be withdrawn, since its command may already have run...
    const withdrawn = h.svc.withdrawWorkflowDecision("app", merge.occurrenceId, { reason: "Its prerequisite closed" });
    assert.equal(withdrawn.status, 409);
    assert.match(withdrawn.error!, /an armed pr_merge cannot be withdrawn/u);
    assert.equal(hook("bash-still").data?.decision, "deny");
    // ...but a new merge request for the same pull request supersedes it, and the shell is back.
    const snapshot = { ...merge.snapshot };
    const replacement = h.svc.createWorkflowDecision("app", { requestId: "merge-5-again", resourceKey: "owner/app#5", resourceSnapshot: snapshot });
    assert.ok(replacement.ok, replacement.error ?? "refused");
    assert.equal(h.db.workflowDecisionByOccurrence(merge.occurrenceId)!.status, "superseded");
    const after = hook("bash-after").data;
    assert.notEqual(after?.decision, "deny", "no longer held: ordinary governance decides again");
    assert.doesNotMatch(after?.reason ?? "", /Merge held/u);
  } finally { h.observer.dispose(); h.db.close(); }
});

/** #4120: verify the app child's delivery of its item, its report timed after `before` runs. */
async function verifyAppDelivered(h: Awaited<ReturnType<typeof fixture>>, before: () => void = () => undefined) {
  h.db.updateSessionStatus("app", "idle", Date.now());
  before();
  const report = h.db.appendEvent("app", { kind: "agent_message", text: "Merged.", final: true }, Date.now() + 1).seq;
  const verified = h.svc.verifyCampaignChild("root", { childSessionId: "app", reportEventSeq: report, followUpsAccounted: true,
    workItem: { id: h.item("app"), outcome: "delivered" } });
  assert.ok(verified.ok, verified.error ?? "verified");
}

test("a dependent merged through a consumed gate is delivered even when its stage names no pull request, as closure proof reads it (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("open"));
    h.forge.set("owner/app#5", pull("merged"));
    await verifyAppDelivered(h, () => {
      // The app child's merge of owner/app#5 went through a consumed gate inside its attempt.
      h.db.raw().prepare(`INSERT INTO workflow_decisions(request_id,occurrence_id,session_id,controlling_session_id,
        category,resource_key,resource_snapshot,resource_digest,policy_revision,authority,status,created_at,resolved_at,consumed_at)
        VALUES ('merge-5','merge-5','app','root','pr_merge','owner/app#5',?,'digest',1,'orchestrator','consumed',?,?,?)`)
        .run(JSON.stringify({ category: "pr_merge", repository: "owner/app", pullRequest: 5, headSha: "e".repeat(40), reviewResult: "merge",
          requiredChecks: { headSha: "e".repeat(40), status: "passed", checkedAt: Date.now(), checks: [{ name: "CI", state: "passed" }] } }),
        Date.now(), Date.now(), Date.now());
    });
    await h.observer.readNow("root", [{ repository: "owner/app", number: 5 }, { repository: "owner/api", number: 7 }]);
    assert.equal(h.detail("app").stage, null, "its stage names nothing");
    assert.deepEqual([h.detail("app").primaryState, h.detail("app").stateCauses], ["delivered", []]);
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a dependent's closed, unmerged pull request doesn't count against it when another merged; an open one still does (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("open"));
    h.forge.set("owner/app#5", pull("merged"));
    h.forge.set("owner/app#6", pull("closed"));
    assert.ok(h.svc.updateCampaignWorkItem("root", { workItemId: h.item("app"), stage: { stage: "merged",
      pullRequests: [{ repository: "owner/app", number: 5 }, { repository: "owner/app", number: 6 }] } }).ok);
    await verifyAppDelivered(h);
    const read = async () => { await h.observer.readNow("root", [{ repository: "owner/app", number: 5 }, { repository: "owner/app", number: 6 },
      { repository: "owner/api", number: 7 }]); return h.detail("app"); };
    assert.equal((await read()).primaryState, "delivered", "the closed one is set aside");
    h.forge.set("owner/app#6", pull("open"));
    const open = await read();
    assert.deepEqual([open.primaryState, open.stateCauses], ["waiting", ["dependency_unmerged"]], "an open one still waits");
  } finally { h.observer.dispose(); h.db.close(); }
});

test("a dependent's merge stays known when a later read fails, while a hold on an unreadable prerequisite still holds (#4120)", async () => {
  const h = await fixture();
  try {
    h.forge.set("owner/api#7", pull("merged"));
    h.forge.set("owner/app#5", pull("merged"));
    h.stage("app", "owner/app", 5);
    await verifyAppDelivered(h);
    const both = [{ repository: "owner/app", number: 5 }, { repository: "owner/api", number: 7 }];
    await h.observer.readNow("root", both);
    assert.equal(h.detail("app").primaryState, "delivered");
    // Both reads now fail: the stored merge of owner/app#5 still counts for the item...
    h.forge.delete("owner/app#5");
    h.forge.delete("owner/api#7");
    await h.observer.readNow("root", both);
    const [fact] = h.db.campaignForgeObservations.facts("root", [both[0]!], Date.now());
    assert.equal(fact!.fact.availability, "unavailable");
    assert.deepEqual([h.detail("app").primaryState, h.detail("app").stateCauses], ["delivered", []]);
    // ...while a merge held on the unreadable prerequisite still holds, failing closed.
    const held = await h.approvedMerge("app", "owner/app", 5).arm();
    assert.equal(held.status, 409, held.error ?? "armed");
    assert.match(held.error!, /owner\/api#7 \(api in owner\/api\) is observed MERGED; it is not freshly observed/u);
  } finally { h.observer.dispose(); h.db.close(); }
});
