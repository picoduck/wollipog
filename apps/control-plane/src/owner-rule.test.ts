import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION, pendingRequests,
  type ControlPlaneToRunner, type RunnerMetadata, type SessionView, type WorkflowDecisionOwnerRule,
  type WorkflowDecisionView } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { pushDecision } from "./push-decision.js";
import { auditDigest, SessionsService } from "./sessions.js";
import { fakeScreenRuntime } from "./credential-screen-test-fixture.js";

/** Owner rules (#4137): a gate that an installed skill or user-authored instruction keeps for a
 * person is filed as the exact typed decision with `ownerRule`, and is the owner's from creation. */
const RULE: WorkflowDecisionOwnerRule = {
  source: "~/.claude/skills/issue-workflow/SKILL.md",
  quote: "Merging a pull request requires per-PR user authorization through the structured question tool.",
};
const HEAD = "a".repeat(40);

function harness(options: { mode?: "full_control" | "custom"; videoFrameReviewCandidate?: boolean } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: "/repos/test" }], agents: [{ id: "codex", name: "Codex", command: "codex", args: [], env: {},
      driver: "claude-code", context: { kind: "native" }, available: true }] };
  db.registerRunner(metadata, 1, PROTOCOL_VERSION);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "team/repo", issueNumbers: [100], revision: 1, authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [100];
  // Custom: the person delegated merges to the Orchestrator in the campaign's saved owners.
  const decisions = options.mode === "custom" ? { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, pr_merge: "orchestrator" as const }
    : { ...HUMAN_ONLY_PARENT_CONTROL_POLICY };
  for (const id of ["root", "child"]) {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "codex", title: id, useWorktree: false, driver: "claude-code", now: 1, config: {},
      ...(id === "root" ? { role: "orchestrator", orchestratorPolicy: policy, parentControlPolicy: { decisions } }
        : { parentSessionId: "root" }) });
    db.updateSessionStatus(id, "running", 2);
  }
  const hub = new Hub(db);
  const toRunner: ControlPlaneToRunner[] = [];
  hub.isRunnerOnline = () => true; hub.sessionChangedById = () => {};
  hub.sendToRunner = (_runner, message) => { toRunner.push(message); return true; };
  // The server's own push decision, so a test sees exactly what would reach the owner's devices.
  const pushes: Array<{ sessionId: string; title: string }> = [];
  const notify = (prev: SessionView, view: SessionView) => {
    const message = pushDecision(prev, view);
    if (message) pushes.push({ sessionId: view.id, title: message.title });
  };
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, notify, undefined, undefined, undefined, undefined, undefined,
    options.videoFrameReviewCandidate === true);
  svc.setDecisionRuntime(fakeScreenRuntime(db, () => ({ verdict: "discusses" })).runtime);
  if (options.mode !== "custom") {
    const enabled = svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #100",
      operations: ["implementation_question", "pr_merge", "question", "tool_approval", "policy_ask"], delegatablePolicyIds: [] }, 1, principal);
    assert.ok(enabled.ok, enabled.error ?? "Full Control enabled");
  }
  const owner = { kind: "human" as const, id: principal.userId };
  const snapshot = (headSha = HEAD, pullRequest = 7) => ({ category: "pr_merge" as const, repository: "team/repo", pullRequest, headSha,
    reviewResult: "merge_with_acknowledged_risk" as const,
    requiredChecks: { headSha, status: "passed" as const, checkedAt: 10, checks: [{ name: "Typecheck, Test & Sidecar Bundle", state: "passed" as const }] } });
  const merge = (requestId: string, extra: { resourceKey?: string; ownerRule?: unknown; sessionId?: string; headSha?: string; pullRequest?: number } = {}) =>
    svc.createWorkflowDecision(extra.sessionId ?? "child", { requestId, resourceKey: extra.resourceKey ?? `team/repo#${extra.pullRequest ?? 7}`,
      resourceSnapshot: snapshot(extra.headSha, extra.pullRequest), ...(extra.ownerRule !== undefined ? { ownerRule: extra.ownerRule as WorkflowDecisionOwnerRule } : {}) });
  const rootResolve = (sessionId: string, d: WorkflowDecisionView) => svc.resolveDescendantRequest("root", sessionId,
    d.occurrenceId, { action: "resolve_workflow_decision", outcome: "approve" }, () => true);
  const prompts = (sessionId: string) => [
    ...toRunner.flatMap((message) => message.type === "prompt_session" && message.sessionId === sessionId ? [message.text] : []),
    ...(db.raw().prepare("SELECT payload_json FROM session_prompt_commands WHERE session_id=?").all(sessionId) as Array<{ payload_json: string }>)
      .map((row) => (JSON.parse(row.payload_json) as { text: string }).text),
  ];
  return { db, svc, owner, merge, snapshot, rootResolve, prompts, pushes };
}

test("a child's ownerRule makes its merge the owner's even where Full Control gives merges to the Orchestrator (#4137)", () => {
  const h = harness();
  try {
    const requested = h.merge("merge-7", { ownerRule: RULE });
    assert.ok(requested.ok && requested.data, requested.error ?? "requested");
    const decision = requested.data;
    assert.deepEqual([decision.authority, decision.authorityEvaluation?.owner, decision.authorityEvaluation?.reason],
      ["human", "human", "owner_kept"]);
    assert.deepEqual(decision.ownerRule, RULE);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.ownerRule?.quote, RULE.quote, "stored with the occurrence");
    // It is the owner's pending request, not the Orchestrator's, and its card names the rule.
    assert.deepEqual(h.svc.descendantRequests("root", () => true, "human").data?.requests.map((request) => request.occurrenceId),
      [decision.occurrenceId]);
    assert.equal(h.svc.descendantRequests("root", () => true, "orchestrator").data?.requests.length ?? 0, 0);
    const card = pendingRequests(h.db.getSession("child")!.pendingApproval).find((request) => request.occurrenceId === decision.occurrenceId)!;
    assert.deepEqual(card.workflowDecision?.ownerRule, RULE);
    // Campaign Status lists it under Waiting for You with the rule.
    const projection = h.db.campaignProjection("root")!;
    assert.equal(projection.status, "waiting_human");
    assert.deepEqual(projection.ownerDecisions?.items.map((item) => [item.sessionId, item.summary, item.handedOff, item.ownerRule]),
      [["child", "Merge team/repo#7", false, RULE]]);
    // Nobody acting for the campaign can decide it, and the root cannot hand it over again.
    const refused = h.rootResolve("child", decision);
    assert.equal(refused.ok, false);
    assert.match(refused.error!, /requires a human response/u);
    assert.equal(h.svc.resolveWorkflowDecision("root", "child", decision.occurrenceId, { outcome: "approve" },
      "human", { kind: "agent", id: "root" }, () => true).status, 403, "an agent cannot pass as a person");
    assert.equal(h.svc.approve("child", decision.occurrenceId, "approve", { kind: "human", id: "someone-else" }).status, 403,
      "only the campaign's owner decides it");
    const again = h.svc.handWorkflowDecisionToOwner("root", decision.occurrenceId, { reason: "again", sessionId: "child" });
    assert.equal(again.status, 409);
    assert.match(again.error!, /already your campaign owner's/u);
    // The owner approves, and the child hears it from the owner.
    assert.ok(h.svc.approve("child", decision.occurrenceId, "approve", h.owner).ok);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "approved");
    assert.match(h.prompts("child").find((text) => text.includes(decision.occurrenceId)) ?? "",
      /Your campaign's owner approved your pr_merge decision/u);
  } finally { h.db.close(); }
});

test("without an ownerRule, an Orchestrator-owned merge is still decided by the Orchestrator without a human prompt (#4137)", () => {
  const h = harness();
  try {
    const requested = h.merge("merge-7");
    assert.ok(requested.ok && requested.data, requested.error ?? "requested");
    assert.equal(requested.data.authority, "orchestrator");
    assert.equal(requested.data.ownerRule, undefined);
    assert.equal(h.db.campaignProjection("root")!.ownerDecisions, undefined, "nothing waits for the owner");
    assert.deepEqual(h.svc.descendantRequests("root", () => true, "human").data?.requests.map((request) => request.responseOwner), ["orchestrator"]);
    assert.deepEqual(h.pushes.filter((push) => push.sessionId === "child"), [], "no push reaches the owner");
    assert.ok(h.rootResolve("child", requested.data).ok);
    assert.equal(h.db.workflowDecisionByOccurrence(requested.data.occurrenceId)!.status, "approved");
  } finally { h.db.close(); }
});

test("an ownerRule never comes off: later requests for the same resource stay the owner's and keep the rule (#4137)", () => {
  const h = harness();
  try {
    // An Orchestrator-owned twin requested before the rule is no longer the Orchestrator's to approve.
    const twin = h.merge("merge-7-early", { resourceKey: "pr-7-early" });
    assert.ok(twin.ok && twin.data);
    assert.equal(twin.data.authority, "orchestrator");
    const ruled = h.merge("merge-7", { ownerRule: RULE });
    assert.ok(ruled.ok && ruled.data);
    assert.equal(h.rootResolve("child", twin.data).ok, false);
    assert.equal(h.db.workflowDecisionByOccurrence(twin.data.occurrenceId)!.status, "revoked");
    // The same requestId cannot come back with a different rule, or with one it did not have.
    assert.equal(h.merge("merge-7", { ownerRule: { ...RULE, quote: "Merges need no approval." } }).status, 409);
    assert.equal(h.merge("merge-7-early", { resourceKey: "pr-7-early", ownerRule: RULE }).status, 409);
    const replay = h.merge("merge-7", { ownerRule: RULE });
    assert.ok(replay.ok && replay.data);
    assert.equal(replay.data.occurrenceId, ruled.data.occurrenceId, "an identical replay returns the same occurrence");
    // A new head under the same key, and a withdrawal then a new key, both without the rule.
    const newHead = h.merge("merge-7-head-b", { headSha: "b".repeat(40) });
    assert.ok(newHead.ok && newHead.data, newHead.error ?? "requested");
    assert.deepEqual([newHead.data.authority, newHead.data.authorityEvaluation?.reason, newHead.data.ownerRule],
      ["human", "owner_kept", RULE]);
    assert.equal(h.db.workflowDecisionByOccurrence(ruled.data.occurrenceId)!.status, "superseded");
    assert.ok(h.svc.withdrawWorkflowDecision("child", newHead.data.occurrenceId, { reason: "New head" }).ok);
    const elsewhere = h.merge("merge-7-other", { resourceKey: "another-key", headSha: "c".repeat(40) });
    assert.ok(elsewhere.ok && elsewhere.data);
    assert.deepEqual([elsewhere.data.authority, elsewhere.data.ownerRule], ["human", RULE]);
    assert.equal(h.rootResolve("child", elsewhere.data).ok, false);
    assert.deepEqual(h.db.campaignProjection("root")!.ownerDecisions?.items.map((item) => [item.occurrenceId, item.ownerRule]),
      [[elsewhere.data.occurrenceId, RULE]]);
  } finally { h.db.close(); }
});

test("an ownerRule narrows a Custom campaign's delegated merge too (#4137)", () => {
  const h = harness({ mode: "custom" });
  try {
    const plain = h.merge("merge-7");
    assert.ok(plain.ok && plain.data, plain.error ?? "requested");
    assert.equal(plain.data.authority, "orchestrator", "the saved owner is the Orchestrator");
    const ruled = h.merge("merge-8", { pullRequest: 8, ownerRule: RULE });
    assert.ok(ruled.ok && ruled.data, ruled.error ?? "requested");
    assert.deepEqual([ruled.data.authority, ruled.data.authorityEvaluation?.reason, ruled.data.ownerRule], ["human", "owner_kept", RULE]);
    assert.equal(h.rootResolve("child", ruled.data).ok, false);
    assert.ok(h.svc.approve("child", ruled.data.occurrenceId, "approve", h.owner).ok);
  } finally { h.db.close(); }
});

test("a root's own ruled decision waits for the owner without parking the root (#4137)", async () => {
  const h = harness();
  try {
    const own = await h.svc.createWorkflowDecisionWithVideo("root", { requestId: "layout", resourceKey: "layout", ownerRule: RULE,
      resourceSnapshot: { category: "implementation_question", question: "Which layout should the status page use?",
        options: [{ optionId: "stacked", label: "Stacked" }, { optionId: "split", label: "Split" }] } });
    assert.ok(own.ok && own.data, own.error ?? "requested");
    assert.deepEqual([own.data.authority, own.data.authorityEvaluation?.reason], ["human", "owner_kept"]);
    const root = h.db.getSession("root")!;
    assert.notEqual(root.status, "input_required");
    assert.equal(pendingRequests(root.pendingApproval).find((request) => request.occurrenceId === own.data!.occurrenceId)?.async, true);
    assert.equal(h.svc.resolveWorkflowDecision("root", "root", own.data.occurrenceId, { outcome: "approve", selectedOptionId: "split" },
      "orchestrator", { kind: "agent", id: "root" }, () => true).ok, false);
    assert.ok(h.svc.approve("root", own.data.occurrenceId, "split", h.owner).ok);
  } finally { h.db.close(); }
});

test("an ownerRule outside its bounds is refused whole and creates nothing (#4137)", async () => {
  const h = harness();
  try {
    for (const [label, ownerRule] of [
      ["oversize quote", { ...RULE, quote: "q".repeat(1001) }],
      ["oversize source", { ...RULE, source: `/${"s".repeat(256)}` }],
      ["source with a space", { ...RULE, source: "my skills/SKILL.md" }],
      ["multi-line quote", { ...RULE, quote: "Line one\nLine two" }],
      ["bidirectional override", { ...RULE, quote: "Merges need approval \u202e" }],
      ["blank quote", { ...RULE, quote: "   " }],
      ["extra key", { ...RULE, owner: "orchestrator" }],
      ["not an object", "AGENTS.md"],
    ] as const) {
      const refused = h.merge(`bad-${label}`, { ownerRule });
      assert.equal(refused.status, 400, label);
      assert.match(refused.error!, /^ownerRule /u, label);
      // The HTTP ingress refuses it before any GitHub read.
      const viaRoute = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: `route-${label}`, resourceKey: "team/repo#7",
        resourceSnapshot: h.snapshot(), ownerRule: ownerRule as WorkflowDecisionOwnerRule });
      assert.equal(viaRoute.status, 400, label);
    }
    assert.equal(h.db.pendingWorkflowDecisionsForSession("child").length, 0);
    // Exactly at the limits is accepted.
    const atLimit = h.merge("at-limit", { ownerRule: { source: `/${"s".repeat(255)}`, quote: "q".repeat(1000) } });
    assert.ok(atLimit.ok && atLimit.data, atLimit.error ?? "accepted");
    assert.equal(atLimit.data.authority, "human");
  } finally { h.db.close(); }
});

test("a video request's rule is compared before an earlier occurrence is replayed (#4137 review)", async () => {
  const h = harness({ videoFrameReviewCandidate: true });
  try {
    const snapshot = { category: "ui_evidence_approval" as const, evidence: [{ evidenceId: "clip", sha256: "c".repeat(64),
      uri: "https://evidence.example/clip.mp4", mediaType: "video/mp4" }] };
    // An unruled occurrence the delegated video route stored earlier under the same requestId.
    const earlier = h.db.createWorkflowDecision({ requestId: "video-1", occurrenceId: "workflow_video_1", sessionId: "child",
      controllingSessionId: "root", category: "ui_evidence_approval", resourceKey: "evidence", resourceSnapshot: snapshot,
      resourceDigest: auditDigest(snapshot)!, policyRevision: h.db.getSession("root")!.parentControlPolicy!.revision, authority: "orchestrator",
      createdAt: 5 });
    assert.equal(earlier?.decision.authority, "orchestrator");
    const replay = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "video-1", resourceKey: "evidence",
      resourceSnapshot: snapshot, ownerRule: RULE });
    assert.equal(replay.status, 409, "the rule is never silently dropped by returning the unruled occurrence");
    // A new ruled video request is the owner's, without any delegated frame review.
    const ruled = await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "video-2", resourceKey: "evidence-2",
      resourceSnapshot: { ...snapshot, evidence: [{ ...snapshot.evidence[0]!, evidenceId: "clip-2", sha256: "d".repeat(64) }] },
      ownerRule: RULE });
    assert.ok(ruled.ok && ruled.data, ruled.error ?? "requested");
    assert.deepEqual([ruled.data.authority, ruled.data.ownerRule], ["human", RULE]);
    // Replaying it with a different rule is refused too.
    assert.equal((await h.svc.createWorkflowDecisionWithVideo("child", { requestId: "video-2", resourceKey: "evidence-2",
      resourceSnapshot: ruled.data.resourceSnapshot, ownerRule: { ...RULE, quote: "Another rule." } })).status, 409);
  } finally { h.db.close(); }
});

test("a ruled video stored as its derived frames still keeps its source video for the owner (#4137 review)", () => {
  const h = harness();
  try {
    const source = "e".repeat(64);
    const frames = [0, 1].map((index) => ({ evidenceId: `frame-${index}`, artifactId: `art_frame_${index}`,
      sha256: String(index).repeat(64), mediaType: "image/png" }));
    const stored = { category: "ui_evidence_approval" as const, evidence: frames,
      videoReview: { sourceEvidenceId: "clip", sourceArtifactId: "art_clip", sourceSha256: source, originalRequestSha256: "f".repeat(64),
        profile: "short-silent-webm-vp9-v1" as const, manifestSha256: "a".repeat(64),
        frames: frames.map((frame, index) => ({ ...frame, index, ptsMs: index * 100 })) } };
    assert.ok(h.db.createWorkflowDecision({ requestId: "video-frames", occurrenceId: "workflow_video_frames", sessionId: "child",
      controllingSessionId: "root", category: "ui_evidence_approval", resourceKey: "evidence", resourceSnapshot: stored as never,
      resourceDigest: auditDigest(stored)!, policyRevision: h.db.getSession("root")!.parentControlPolicy!.revision, authority: "human",
      ownerRule: RULE, createdAt: 5 }));
    // The same source video, named by its own sha256 under a new key and without the rule.
    const again = h.svc.createWorkflowDecision("child", { requestId: "video-again", resourceKey: "another-key",
      resourceSnapshot: { category: "ui_evidence_approval", evidence: [{ evidenceId: "clip", sha256: source,
        uri: "https://evidence.example/clip.webm", mediaType: "video/webm" }] } });
    assert.ok(again.ok && again.data, again.error ?? "requested");
    assert.deepEqual([again.data.authority, again.data.ownerRule], ["human", RULE]);
  } finally { h.db.close(); }
});

test("a credential-screen classification never releases a ruled question to the Orchestrator (#4137)", () => {
  const h = harness();
  try {
    const held = h.db.createWorkflowDecision({ requestId: "q", occurrenceId: "workflow_q", sessionId: "child", controllingSessionId: "root",
      category: "implementation_question", resourceKey: "q", resourceDigest: "d", policyRevision: 1, authority: "human",
      resourceSnapshot: { category: "implementation_question", question: "Q?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] },
      authorityEvaluation: { owner: "human", basis: "human_required", reason: "credential_screen_review", operation: "implementation_question" },
      ownerRule: RULE, createdAt: 5 });
    assert.ok(held);
    assert.equal(h.db.releaseCredentialScreenReview("workflow_q", "orchestrator",
      { owner: "orchestrator", basis: "campaign_delegation", reason: "authorized_operation", operation: "implementation_question" }), null);
    const released = h.db.releaseCredentialScreenReview("workflow_q", "human",
      { owner: "human", basis: "human_required", reason: "owner_kept", operation: "implementation_question" });
    assert.deepEqual([released?.authority, released?.authorityEvaluation?.reason], ["human", "owner_kept"]);
    // A stored rule keeps the row the person's whatever authority a caller computed.
    const forced = h.db.createWorkflowDecision({ requestId: "m", occurrenceId: "workflow_m", sessionId: "child", controllingSessionId: "root",
      category: "pr_merge", resourceKey: "m", resourceDigest: "e", policyRevision: 1, authority: "orchestrator",
      resourceSnapshot: h.snapshot(), ownerRule: RULE, createdAt: 6 });
    assert.equal(forced?.decision.authority, "human");
  } finally { h.db.close(); }
});

test("the Codex example: a kept merge reaches the owner typed, bound to its head, and the root hands an unruled one over (#4137)", () => {
  // The issue's live repro (Codex root and child, an installed per-PR merge rule) cannot run inside
  // a campaign whose hosting stack is fixed, so this covers the same flow through the service.
  const h = harness();
  try {
    // Child path: the child files the exact pr_merge with the rule, instead of stopping in prose.
    const ruled = h.merge("merge-7", { ownerRule: RULE });
    assert.ok(ruled.ok && ruled.data, ruled.error ?? "requested");
    assert.equal(ruled.data.resourceSnapshot.category === "pr_merge" && ruled.data.resourceSnapshot.headSha, HEAD, "bound to the exact head");
    // It reaches the owner: a push for the waiting child, the root's human request count, and
    // Campaign Status's Waiting for You.
    assert.ok(h.pushes.some((push) => push.sessionId === "child"), "a push reaches the owner");
    assert.equal(h.db.getSession("root")!.orchestratorCampaign?.pendingRequests?.human, 1);
    assert.equal(h.db.campaignProjection("root")!.ownerDecisions?.total, 1);
    // The root is not left holding it: its own card list is empty and it keeps running.
    assert.equal(pendingRequests(h.db.getSession("root")!.pendingApproval).length, 0);
    assert.equal(h.db.getSession("root")!.status, "running");
    // Root handoff path: a merge filed without the rule is handed to the owner.
    const unruled = h.merge("merge-9", { pullRequest: 9, headSha: "d".repeat(40) });
    assert.ok(unruled.ok && unruled.data);
    assert.equal(unruled.data.authority, "orchestrator");
    const handed = h.svc.handWorkflowDecisionToOwner("root", unruled.data.occurrenceId,
      { reason: "The installed issue-workflow keeps per-PR merges for the owner", sessionId: "child" });
    assert.ok(handed.ok && handed.data, handed.error ?? "handed");
    assert.deepEqual([handed.data.authority, handed.data.authorityEvaluation?.reason], ["human", "owner_kept"]);
    assert.deepEqual(h.db.campaignProjection("root")!.ownerDecisions?.items.map((item) => [item.occurrenceId, item.handedOff, item.ownerRule ?? null]),
      [[ruled.data.occurrenceId, false, RULE], [unruled.data.occurrenceId, true, null]]);
    // The owner approves the kept merge; the child consumes it for exactly that head.
    assert.ok(h.svc.approve("child", ruled.data.occurrenceId, "approve", h.owner).ok);
    const approved = h.db.workflowDecisionByOccurrence(ruled.data.occurrenceId)!;
    assert.equal(approved.status, "approved");
    assert.equal(approved.ownerRule?.source, RULE.source);
  } finally { h.db.close(); }
});

/** A nested Orchestrator under the root with a worker of its own, and a second campaign beside them (#4337). */
function nestedCampaign() {
  const h = harness();
  const root = h.db.getSession("root")!;
  const make = (id: string, extra: Record<string, unknown>) => {
    h.db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "codex", title: id, useWorktree: false, driver: "claude-code",
      now: 1, config: {}, ...extra });
    h.db.updateSessionStatus(id, "running", 2);
  };
  make("nested", { role: "orchestrator", parentSessionId: "root", orchestratorPolicy: structuredClone(root.orchestratorPolicy!),
    parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } });
  make("worker", { parentSessionId: "nested" });
  make("other-root", { role: "orchestrator", orchestratorPolicy: structuredClone(root.orchestratorPolicy!),
    parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } });
  make("other-child", { parentSessionId: "other-root" });
  // After every occurrence the service records at the current time, so the order is fixed.
  let at = Date.now() + 60_000;
  // A stored occurrence with an exact controller: none of today's routes files an owner-kept one
  // under a nested Orchestrator, but Waiting for You must not depend on that.
  const stored = (id: string, sessionId: string, controllingSessionId: string,
    extra: { ownerRule?: WorkflowDecisionOwnerRule; authority?: "human" | "orchestrator"; snapshot?: WorkflowDecisionView["resourceSnapshot"] } = {}) =>
    h.db.createWorkflowDecision({ requestId: id, occurrenceId: `workflow_${id}`, sessionId, controllingSessionId,
      category: extra.snapshot?.category ?? "pr_merge", resourceKey: id, resourceDigest: id, policyRevision: 1,
      authority: extra.authority ?? "human", resourceSnapshot: extra.snapshot ?? h.snapshot(HEAD, 40 + at % 50),
      ...(extra.ownerRule ? { ownerRule: extra.ownerRule } : {}), createdAt: at++ })!.decision;
  const waiting = () => {
    const owner = h.db.campaignProjection("root")!.ownerDecisions;
    if (owner) assert.equal(owner.total, owner.items.length, "the count and the items read one predicate");
    return owner?.items.map((item) => [item.occurrenceId, item.sessionId, item.handedOff, item.ownerRule ?? null]) ?? [];
  };
  return { ...h, stored, waiting };
}

test("Waiting for You lists the owner's decisions from a nested Orchestrator's members, which the root controls (#4337)", () => {
  const h = nestedCampaign();
  try {
    // A worker under the nested Orchestrator, and the nested Orchestrator itself, file a ruled merge.
    const fromWorker = h.merge("worker-merge", { sessionId: "worker", ownerRule: RULE });
    assert.ok(fromWorker.ok && fromWorker.data, fromWorker.error ?? "requested");
    const fromNested = h.merge("nested-merge", { sessionId: "nested", pullRequest: 8, ownerRule: RULE });
    assert.ok(fromNested.ok && fromNested.data, fromNested.error ?? "requested");
    // Both are gates of the campaign's root, which lists them and hands the owner each request.
    assert.deepEqual([fromWorker.data.controllingSessionId, fromNested.data.controllingSessionId], ["root", "root"]);
    assert.deepEqual(h.waiting(), [[fromWorker.data.occurrenceId, "worker", false, RULE], [fromNested.data.occurrenceId, "nested", false, RULE]]);
    assert.deepEqual(h.svc.descendantRequests("root", () => true, "human").data?.requests.map((request) => request.occurrenceId).sort(),
      [fromNested.data.occurrenceId, fromWorker.data.occurrenceId].sort());
  } finally { h.db.close(); }
});

test("Waiting for You lists owner-kept decisions a nested Orchestrator controls, and only this campaign's (#4337)", () => {
  const h = nestedCampaign();
  try {
    const rootRuled = h.merge("root-member-merge", { ownerRule: RULE });
    assert.ok(rootRuled.ok && rootRuled.data, rootRuled.error ?? "requested");
    // Controlled by the nested Orchestrator: its own ruled decision, a worker's ruled decision, and one handed to the owner.
    const nestedRuled = h.stored("nested-ruled", "nested", "nested", { ownerRule: RULE });
    const workerRuled = h.stored("worker-ruled", "worker", "nested", { ownerRule: RULE });
    const handedOff = h.stored("worker-handed", "worker", "nested", { authority: "orchestrator" });
    assert.ok(h.db.handWorkflowDecisionToOwner(handedOff.occurrenceId, { bySessionId: "nested", at: Date.now(), reason: "Kept by the owner" },
      { owner: "human", basis: "human_required", reason: "owner_kept", operation: "pr_merge" }));
    // Never listed: another campaign's ruled decisions, one a nested Orchestrator controls for a
    // session outside this campaign, its Orchestrator-owned and unruled ones, and a nested scope
    // proposal, which stays the root's own.
    h.stored("other-ruled", "other-child", "other-root", { ownerRule: RULE });
    h.stored("other-own-ruled", "other-root", "other-root", { ownerRule: RULE });
    h.stored("outsider-ruled", "other-child", "nested", { ownerRule: RULE });
    h.stored("nested-plain", "worker", "nested", { authority: "orchestrator" });
    h.stored("nested-human-unruled", "worker", "nested");
    h.stored("nested-scope", "nested", "nested", { snapshot: { category: "campaign_issue_scope", repository: "team/repo",
      expectedRevision: 1, additions: [101], removals: [], explanation: "Asked in chat", ownerReview: { cause: "lineage_missing" } } as unknown as WorkflowDecisionView["resourceSnapshot"] });
    assert.deepEqual(h.waiting(), [
      [rootRuled.data.occurrenceId, "child", false, RULE],
      [nestedRuled.occurrenceId, "nested", false, RULE],
      [workerRuled.occurrenceId, "worker", false, RULE],
      [handedOff.occurrenceId, "worker", true, null],
    ]);
    // The other campaign's own Waiting for You holds only its own decision.
    assert.deepEqual(h.db.campaignOwnerDecisions("other-root")?.items.map((item) => item.occurrenceId), ["workflow_other-ruled", "workflow_other-own-ruled"]);
    // The owner resolves one where it waits, through its own controller, as the requester's card
    // does; an agent cannot, even the Orchestrator that controls it.
    assert.equal(h.svc.resolveWorkflowDecision("nested", "worker", workerRuled.occurrenceId, { outcome: "approve" }, "orchestrator",
      { kind: "agent", id: "nested" }, () => true).ok, false);
    const resolved = h.svc.resolveWorkflowDecision("nested", "worker", workerRuled.occurrenceId, { outcome: "approve" }, "human", h.owner, () => true);
    assert.ok(resolved.ok, resolved.error ?? "resolved");
    assert.equal(h.db.workflowDecisionByOccurrence(workerRuled.occurrenceId)!.status, "approved");
    assert.equal(h.waiting().some(([occurrenceId]) => occurrenceId === workerRuled.occurrenceId), false, "an answered decision no longer waits");
    assert.deepEqual(h.waiting().map(([occurrenceId]) => occurrenceId),
      [rootRuled.data.occurrenceId, nestedRuled.occurrenceId, handedOff.occurrenceId]);
    // A nested Orchestrator that leaves the campaign takes its decisions out of Waiting for You.
    h.db.raw().prepare("UPDATE sessions SET parent_session_id=NULL WHERE id='nested'").run();
    assert.deepEqual(h.waiting(), [[rootRuled.data.occurrenceId, "child", false, RULE]]);
  } finally { h.db.close(); }
});
