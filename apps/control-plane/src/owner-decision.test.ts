import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, pendingRequests,
  type ControlPlaneToRunner, type RunnerMetadata, type WorkflowDecisionView } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { CAMPAIGN_CONTINUATION_COALESCE_MS, SessionsService } from "./sessions.js";
import { fakeScreenRuntime } from "./credential-screen-test-fixture.js";

/** Owner decisions (#4064): a Full Control root hands a decision its owner kept to that owner as a
 * typed request only a person can answer, without parking the root. */
function harness(options: { full?: boolean; runnerProtocol?: number } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {},
      driver: "claude-code", context: { kind: "native" }, available: true }] };
  db.registerRunner(metadata, 1, options.runnerProtocol ?? PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "team/repo", issueNumbers: [100], revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [100];
  for (const id of ["root", "child"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "claude", title: id, useWorktree: false, driver: "claude-code", now: 1, config: {},
      ...(id === "root" ? { role: "orchestrator", orchestratorPolicy: policy, parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } }
        : { parentSessionId: "root" }) });
    db.updateSessionStatus(id, "running", 2);
  }
  const hub = new Hub(db);
  const toRunner: ControlPlaneToRunner[] = [];
  hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {};
  hub.sendToRunner = (_runner, message) => { toRunner.push(message); return true; };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  // A fake Decision Model (#4104): `ask` only for request texts a test lists, `discusses` otherwise.
  const asking = new Set<string>();
  svc.setDecisionRuntime(fakeScreenRuntime(db, (request) =>
    [...asking].some((text) => JSON.stringify(request).includes(text)) ? { verdict: "ask" } : { verdict: "discusses" }).runtime);
  if (options.full !== false) {
    const enabled = svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #100",
      operations: ["implementation_question", "pr_merge", "question", "tool_approval", "policy_ask"], delegatablePolicyIds: [] }, 1, principal);
    assert.ok(enabled.ok, enabled.error ?? "Full Control enabled");
  }
  const owner = { kind: "human" as const, id: principal.userId };
  const ask = (requestId = "credential-design") => svc.createOwnerDecision("root", { requestId, resourceKey: requestId,
    question: "Which credential design should the provider bridge use?", material: "PR https://github.com/team/repo/pull/7 at head abc; both designs pass CI.",
    options: [{ optionId: "lease", label: "Short-Lived Lease" }, { optionId: "broker", label: "Broker Process", description: "Adds a helper" }],
    recommendedOptionId: "lease" });
  const merge = (requestId: string, resourceKey = "team/repo#7", sessionId = "child") => {
    const headSha = "a".repeat(40);
    return svc.createWorkflowDecision(sessionId, { requestId, resourceKey, resourceSnapshot: { category: "pr_merge", repository: "team/repo",
      pullRequest: 7, headSha, reviewResult: "merge_with_acknowledged_risk",
      requiredChecks: { headSha, status: "passed", checkedAt: 10, checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" }] } } });
  };
  const rootResolve = (sessionId: string, d: WorkflowDecisionView, selectedOptionId?: string) => svc.resolveDescendantRequest("root", sessionId,
    d.occurrenceId, { action: "resolve_workflow_decision", outcome: "approve", ...(selectedOptionId ? { selectedOptionId } : {}) }, () => true);
  /** Prompts sent to a session, directly or through the durable prompt outbox. */
  const prompts = (sessionId: string) => [
    ...toRunner.flatMap((message) => message.type === "prompt_session" && message.sessionId === sessionId ? [message.text] : []),
    ...(db.raw().prepare("SELECT payload_json FROM session_prompt_commands WHERE session_id=?").all(sessionId) as Array<{ payload_json: string }>)
      .map((row) => (JSON.parse(row.payload_json) as { text: string }).text),
  ];
  return { db, svc, principal, owner, ask, merge, rootResolve, prompts, asking, toRunner };
}

test("a Full Control root asks its owner a typed decision that only the owner can answer (#4064)", async () => {
  const h = harness();
  try {
    const asked = await h.ask();
    assert.ok(asked.ok && asked.data, asked.error ?? "created");
    const decision = asked.data;
    assert.equal(decision.category, "owner_decision");
    assert.equal(decision.authority, "human");
    assert.deepEqual([decision.authorityEvaluation?.owner, decision.authorityEvaluation?.reason], ["human", "owner_kept"]);
    // It is among the owner's pending human actions: the campaign's Waiting for You requests.
    const waiting = h.svc.descendantRequests("root", () => true, "human");
    assert.deepEqual(waiting.data?.requests.map((request) => [request.occurrenceId, request.responseOwner]), [[decision.occurrenceId, "human"]]);
    assert.equal(h.svc.descendantRequests("root", () => true, "orchestrator").data?.requests.length ?? 0, 0, "the Orchestrator owns none of it");
    assert.equal(h.db.getSession("root")!.orchestratorCampaign?.pendingRequests?.human, 1);
    // Nobody acting for the campaign can answer, approve, resolve or consume it.
    const byRoot = h.rootResolve("root", decision, "lease");
    assert.equal(byRoot.ok, false);
    assert.equal(h.svc.resolveWorkflowDecision("root", "root", decision.occurrenceId, { outcome: "approve", selectedOptionId: "lease" },
      "orchestrator", { kind: "agent", id: "root" }, () => true).status, 403);
    assert.equal(h.svc.resolveWorkflowDecision("root", "root", decision.occurrenceId, { outcome: "approve", selectedOptionId: "lease" },
      "human", { kind: "agent", id: "child" }, () => true).status, 403, "an agent cannot pass as a person");
    assert.equal(h.svc.approve("root", decision.occurrenceId, "lease", { kind: "agent", id: "root" }).status, 403);
    assert.equal(h.svc.resolveDescendantRequest("child", "root", decision.occurrenceId, { action: "resolve_workflow_decision", outcome: "approve" },
      () => true).ok, false, "a child is never its controller");
    assert.equal(h.svc.approve("root", decision.occurrenceId, "lease", { kind: "human", id: "someone-else" }).status, 403,
      "only the campaign's owner decides it");
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "pending");
    // The owner chooses, and the choice is delivered back to the root.
    const chosen = h.svc.approve("root", decision.occurrenceId, "broker", h.owner);
    assert.ok(chosen.ok, chosen.error ?? "approved");
    const resolved = h.db.workflowDecisionByOccurrence(decision.occurrenceId)!;
    assert.deepEqual([resolved.status, resolved.selectedOptionId], ["approved", "broker"]);
    const resume = h.prompts("root").find((text) => text.includes(decision.occurrenceId));
    assert.ok(resume, "the owner's choice reaches the root");
    assert.match(resume!, /Your campaign's owner approved your owner_decision .* with option "broker"/u);
    assert.equal(pendingRequests(h.db.getSession("root")!.pendingApproval).length, 0);
  } finally { h.db.close(); }
});

test("an owner decision does not park the root or hold other campaign work (#4064)", async () => {
  const h = harness();
  try {
    const asked = await h.ask();
    assert.ok(asked.ok && asked.data, asked.error ?? "created");
    const root = h.db.getSession("root")!;
    assert.equal(root.status, "running", "the root's turn keeps going");
    const card = pendingRequests(root.pendingApproval).find((request) => request.occurrenceId === asked.data!.occurrenceId)!;
    assert.equal(card.async, true, "its card does not hold the root");
    assert.equal(card.title, "Owner Decision Required");
    assert.deepEqual(card.options.map((option) => option.optionId), ["lease", "broker", "__workflow_deny__"]);
    // Runner status reports do not park it on the card, so continuations still reach it.
    h.svc.onSessionStatus("root", "running");
    assert.equal(h.db.getSession("root")!.status, "running");
    h.svc.onSessionStatus("root", "idle");
    assert.notEqual(h.db.getSession("root")!.status, "input_required");
    assert.equal(h.db.campaignContinuationLifecycle("root")?.hasPendingApproval, false);
    assert.notEqual(h.db.campaignContinuationAdmission("root").reason,
      "Automatic continuation is held by the campaign's current lifecycle or pending recovery.");
    // Campaign Status lists it as waiting on the owner.
    const projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "waiting_human");
    assert.equal(projection.pendingDecisions.human, 1);
    assert.deepEqual(projection.ownerDecisions?.items.map((item) => [item.occurrenceId, item.summary, item.handedOff]),
      [[asked.data.occurrenceId, "Which credential design should the provider bridge use?", false]]);
    // Unrelated work continues: a child's merge is still the Orchestrator's to decide.
    const merged = h.merge("merge-7");
    assert.ok(merged.ok && merged.data, merged.error ?? "requested");
    assert.equal(merged.data.authority, "orchestrator");
    assert.ok(h.rootResolve("child", merged.data).ok);
    // The root may withdraw its own pending owner decision; that grants nothing.
    const withdrawn = h.svc.withdrawWorkflowDecision("root", asked.data.occurrenceId, { reason: "Decided by the design doc" });
    assert.ok(withdrawn.ok, withdrawn.error ?? "withdrawn");
    assert.equal(withdrawn.data!.status, "revoked");
    assert.equal(pendingRequests(h.db.getSession("root")!.pendingApproval).length, 0);
  } finally { h.db.close(); }
});

test("handing an Orchestrator-owned occurrence to the owner is one way (#4064)", async () => {
  const h = harness();
  try {
    const twin = h.merge("merge-7-early", "pr-7-early");
    assert.ok(twin.ok && twin.data);
    const requested = h.merge("merge-7");
    assert.ok(requested.ok && requested.data);
    assert.equal(requested.data.authority, "orchestrator");
    // Only the root hands it, with a reason; a child cannot.
    assert.equal(h.svc.handWorkflowDecisionToOwner("child", requested.data.occurrenceId, { reason: "Owner kept it" }).ok, false);
    assert.equal(h.svc.handWorkflowDecisionToOwner("root", requested.data.occurrenceId, { reason: " ", sessionId: "child" }).status, 400);
    const handed = h.svc.handWorkflowDecisionToOwner("root", requested.data.occurrenceId,
      { reason: "The owner kept risk consent to merge #7", sessionId: "child" });
    assert.ok(handed.ok && handed.data, handed.error ?? "handed");
    assert.equal(handed.data.authority, "human");
    assert.equal(handed.data.ownerHandoff?.bySessionId, "root");
    assert.equal(handed.data.authorityEvaluation?.reason, "owner_kept");
    // The child's card now names the person as its owner; the child stays waiting on it.
    const childCard = pendingRequests(h.db.getSession("child")!.pendingApproval)
      .find((request) => request.occurrenceId === requested.data!.occurrenceId)!;
    assert.equal(childCard.workflowDecision?.authority, "human");
    assert.equal(h.db.getSession("child")!.pendingRequestOwners?.human, 2 - 1, "one card waits for the person");
    assert.deepEqual(h.db.campaignProjection("root")!.ownerDecisions?.items.map((item) => [item.sessionId, item.summary, item.handedOff]),
      [["child", "Merge team/repo#7", true]], "Campaign Status lists it as waiting on the owner");
    // Afterwards the root is refused, cannot hand it back, and cannot withdraw it.
    const refused = h.rootResolve("child", handed.data);
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /requires a human response/u);
    assert.equal(h.svc.handWorkflowDecisionToOwner("root", requested.data.occurrenceId, { reason: "again", sessionId: "child" }).status, 409);
    assert.equal(h.svc.withdrawWorkflowDecision("root", requested.data.occurrenceId, { reason: "mine", sessionId: "child" }).status, 403);
    // A twin requested before the handoff is no longer the Orchestrator's to approve.
    assert.equal(h.rootResolve("child", twin.data).ok, false);
    assert.equal(h.db.workflowDecisionByOccurrence(twin.data.occurrenceId)!.status, "revoked");
    // Withdrawing and asking again, under any key, stays with the person.
    assert.ok(h.svc.withdrawWorkflowDecision("child", requested.data.occurrenceId, { reason: "New head" }).ok);
    const again = h.merge("merge-7-again", "another-key");
    assert.ok(again.ok && again.data);
    assert.deepEqual([again.data.authority, again.data.authorityEvaluation?.reason], ["human", "owner_kept"]);
    assert.equal(h.rootResolve("child", again.data).ok, false);
    // The owner decides it.
    assert.ok(h.svc.approve("child", again.data.occurrenceId, "approve", h.owner).ok);
    assert.equal(h.db.workflowDecisionByOccurrence(again.data.occurrenceId)!.status, "approved");
  } finally { h.db.close(); }
});

test("a root's own handed decision stops holding the root (#4064)", async () => {
  const h = harness();
  try {
    const own = await h.svc.createWorkflowDecisionWithVideo("root", { requestId: "layout", resourceKey: "layout", resourceSnapshot: {
      category: "implementation_question", question: "Which layout should the status page use?",
      options: [{ optionId: "stacked", label: "Stacked" }, { optionId: "split", label: "Split" }] } });
    assert.ok(own.ok && own.data);
    assert.equal(own.data.authority, "orchestrator");
    assert.equal(h.db.getSession("root")!.status, "input_required");
    const handed = h.svc.handWorkflowDecisionToOwner("root", own.data.occurrenceId, { reason: "The owner kept the layout" });
    assert.ok(handed.ok, handed.error ?? "handed");
    const root = h.db.getSession("root")!;
    assert.notEqual(root.status, "input_required");
    assert.equal(pendingRequests(root.pendingApproval).find((request) => request.occurrenceId === own.data!.occurrenceId)?.async, true);
    assert.equal(h.rootResolve("root", own.data, "split").ok, false);
    assert.ok(h.svc.approve("root", own.data.occurrenceId, "split", h.owner).ok);
  } finally { h.db.close(); }
});

test("owner decisions exist only for a Full Control root on a current runner (#4064)", async () => {
  const custom = harness({ full: false });
  try {
    assert.equal((await custom.ask()).status, 409, "a Custom campaign is unchanged");
    const merge = custom.merge("merge-7");
    assert.ok(merge.ok && merge.data);
    assert.equal(custom.svc.handWorkflowDecisionToOwner("root", merge.data.occurrenceId, { reason: "x", sessionId: "child" }).status, 409);
  } finally { custom.db.close(); }
  const older = harness({ runnerProtocol: 280 });
  try {
    const refused = await older.ask();
    assert.equal(refused.status, 409);
    assert.match(refused.error!, /owner decisions/u);
  } finally { older.db.close(); }
  const h = harness();
  try {
    // A child cannot ask, and nobody can create one through the generic request route.
    assert.equal((await h.svc.createOwnerDecision("child", { requestId: "c", resourceKey: "c", question: "Q?",
      options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] })).status, 409);
    assert.equal(h.svc.createWorkflowDecision("root", { requestId: "g", resourceKey: "g", resourceSnapshot: { category: "owner_decision",
      question: "Q?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] } }).status, 403);
    // Full Control asks nobody for a credential value, the owner included.
    h.asking.add("Please paste your API key here");
    const secret = await h.svc.createOwnerDecision("root", { requestId: "s", resourceKey: "s", question: "Please paste your API key here",
      options: [{ optionId: "a", label: "Done" }, { optionId: "b", label: "Skip" }] });
    assert.equal(secret.status, 403);
  } finally { h.db.close(); }
});

test("a handed question recreated under a new key stays the owner's (#4064 review)", async () => {
  const h = harness();
  try {
    const snapshot = { category: "implementation_question" as const, question: "Which layout should the status page use?",
      options: [{ optionId: "stacked", label: "Stacked" }, { optionId: "split", label: "Split" }] };
    const own = await h.svc.createWorkflowDecisionWithVideo("root", { requestId: "layout-1", resourceKey: "layout", resourceSnapshot: snapshot });
    assert.ok(own.ok && own.data);
    assert.ok(h.svc.handWorkflowDecisionToOwner("root", own.data.occurrenceId, { reason: "The owner kept the layout" }).ok);
    assert.ok(h.svc.withdrawWorkflowDecision("root", own.data.occurrenceId, { reason: "Ask again" }).ok);
    for (const [requestId, resourceKey, question] of [["layout-2", "another-key", snapshot.question],
      ["layout-3", "third-key", "  which LAYOUT should the status page   use? "]] as const) {
      const again = await h.svc.createWorkflowDecisionWithVideo("root", { requestId, resourceKey, resourceSnapshot: { ...snapshot, question } });
      assert.ok(again.ok && again.data, again.error ?? "created");
      assert.deepEqual([again.data.authority, again.data.authorityEvaluation?.reason], ["human", "owner_kept"], resourceKey);
      assert.equal(h.rootResolve("root", again.data, "split").ok, false, "the root cannot decide it");
      // It waits for the owner without parking the root, like the occurrence it replaces.
      const card = pendingRequests(h.db.getSession("root")!.pendingApproval).find((request) => request.occurrenceId === again.data!.occurrenceId);
      assert.equal(card?.async, true, resourceKey);
      for (const reported of ["running", "idle"] as const) {
        h.svc.onSessionStatus("root", reported);
        assert.notEqual(h.db.getSession("root")!.status, "input_required", `${resourceKey} after ${reported}`);
      }
      assert.equal(h.db.campaignContinuationLifecycle("root")?.hasPendingApproval, false);
    }
  } finally { h.db.close(); }
});

test("handing a root's blocking decision to the owner clears the barrier while other owner cards wait (#4064 review)", async () => {
  const h = harness();
  try {
    const asked = await h.ask();
    assert.ok(asked.ok);
    const own = await h.svc.createWorkflowDecisionWithVideo("root", { requestId: "layout", resourceKey: "layout", resourceSnapshot: {
      category: "implementation_question", question: "Which layout should the status page use?",
      options: [{ optionId: "stacked", label: "Stacked" }, { optionId: "split", label: "Split" }] } });
    assert.ok(own.ok && own.data);
    h.svc.onSessionStatus("root", "idle");
    assert.equal(h.db.getSession("root")!.status, "input_required", "the root's own blocking card holds it");
    assert.ok(h.svc.handWorkflowDecisionToOwner("root", own.data.occurrenceId, { reason: "The owner kept the layout" }).ok);
    const root = h.db.getSession("root")!;
    assert.notEqual(root.status, "input_required");
    assert.deepEqual(pendingRequests(root.pendingApproval).map((request) => request.async), [true, true]);
    assert.equal(h.db.campaignContinuationLifecycle("root")?.hasPendingApproval, false);
    assert.notEqual(h.db.campaignContinuationAdmission("root").reason,
      "Automatic continuation is held by the campaign's current lifecycle or pending recovery.");
  } finally { h.db.close(); }
});

test("a root resolving its own blocking decision leaves the pause while an owner decision waits (#4064 review)", async () => {
  const h = harness();
  try {
    assert.ok((await h.ask()).ok);
    const own = await h.svc.createWorkflowDecisionWithVideo("root", { requestId: "layout", resourceKey: "layout", resourceSnapshot: {
      category: "implementation_question", question: "Which layout should the status page use?",
      options: [{ optionId: "stacked", label: "Stacked" }, { optionId: "split", label: "Split" }] } });
    assert.ok(own.ok && own.data);
    assert.equal(h.db.getSession("root")!.status, "input_required");
    assert.ok(h.svc.resolveWorkflowDecision("root", "root", own.data.occurrenceId, { outcome: "approve", selectedOptionId: "split" },
      "orchestrator", { kind: "agent", id: "root" }, () => true).ok);
    assert.notEqual(h.db.getSession("root")!.status, "input_required");
  } finally { h.db.close(); }
});

for (const kind of ["approval", "question"] as const) test(`pending root owner ${kind} delivers child continuations (#4536)`, async () => {
  const h = harness();
  try {
    const asked = await h.svc.createOwnerDecision("root", { requestId: "owner", resourceKey: "owner", kind,
      question: "Which design?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] });
    assert.ok(asked.ok && asked.data, asked.error ?? "owner request created");
    const at = Date.now();
    h.svc.onSessionStatus("root", "idle");
    const child = h.merge("child-merge");
    assert.ok(child.ok && child.data, child.error ?? "child request created");
    h.svc.onSessionStatus("child", "idle");
    h.db.recordCampaignContinuationEvent({ campaignSessionId: "root", eventId: "child-ready", kind: "child_ready",
      subjectSessionId: "child", subjectStatus: "idle", now: at });
    h.svc.retryDuePrompts(Date.now() + CAMPAIGN_CONTINUATION_COALESCE_MS + 1);
    const continuation = h.toRunner.find(m => m.type === "durable_session_command" &&
      m.command.type === "prompt_session" && m.command.campaignContinuation);
    assert.ok(continuation?.type === "durable_session_command" && continuation.command.type === "prompt_session",
      "the idle report must admit a durable continuation while the owner card waits");
    assert.match(continuation.command.text, /request_actionable/u);
    assert.match(continuation.command.text, /child_ready/u);
    assert.ok(h.db.campaignRecovery.projection("root").records.some(record =>
      record.resource.sessionId === "child" && record.state === "dispatched"), "recovery wakes also pass async cards");
    assert.equal(pendingRequests(h.db.getSession("root")!.pendingApproval)[0]!.occurrenceId, asked.data.occurrenceId);
    assert.equal(h.db.workflowDecisionByOccurrence(asked.data.occurrenceId)!.status, "pending");
    const answer = () => h.svc.approve("root", asked.data!.occurrenceId, "a", h.owner);
    assert.ok(answer().ok, "the unchanged owner card remains answerable");
    const resumes = () => h.prompts("root").filter(text => text.includes(asked.data!.occurrenceId) && !text.includes("Campaign Continuation"));
    const delivered = resumes().length;
    assert.equal(delivered, 1, "one durable answer notification is owed");
    assert.equal(answer().ok, false, "the answer cannot be delivered twice");
    assert.equal(resumes().length, delivered);
  } finally { h.db.close(); }
});
