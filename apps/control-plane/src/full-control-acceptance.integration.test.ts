/** #2939 acceptance joins: real service/storage, synthetic runner/media, no model or forge effects.
 * A passing suite proves these contract joins, never complete unattended release readiness. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  type CampaignBudgetAuthority, type ControlPlaneToRunner, type RunnerMetadata,
  type WorkflowDecisionResourceSnapshot,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { hostingEvidenceAuthorityDisclosures } from "./hosting-evidence-disclosures.js";
import { composeHostingVideoEvidence } from "./hosting-video-evidence.js";
import { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";
import { SessionsService } from "./sessions.js";

const REPOSITORY = "fixture-owner/full-control-acceptance";
const question: WorkflowDecisionResourceSnapshot = {
  category: "implementation_question", question: "Which button placement meets the issue?",
  options: [{ optionId: "inline", label: "Inline" }, { optionId: "footer", label: "Footer" }],
};

/** `hostingVideo` composes the service exactly as hosting does, with its inert video evidence pieces. */
function stack(driver: "codex-app-server" | "claude-code", protocol = PROTOCOL_VERSION, hostingVideo = false) {
  const directory = mkdtempSync(join(tmpdir(), "full-control-acceptance-"));
  const path = join(directory, "control-plane.db");
  let db = ControlPlaneDb.open(path);
  const identity = db.localIdentityContext();
  const human: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const runner: RunnerMetadata = {
    runnerId: "fixture-runner", hostname: "fixture", os: "linux", version: "fixture",
    workspaces: [{ id: "workspace", name: "Acceptance", path: directory }],
    agents: [{ id: "fixture-agent", name: "Synthetic Provider", command: "never-launched", args: [], env: {},
      driver, available: true, context: { kind: "native" }, capabilities: {
        models: [{ id: "fixture-vision", default: true, inputModalities: ["text", "image"] }],
        effortLevels: [], slashCommands: [], supportsImages: true, supportsApprovals: true, imageToolResults: true,
      } }],
  };
  db.registerRunner(runner, Date.now(), protocol);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: REPOSITORY, issueNumbers: [1], revision: 1,
    authorizedByUserId: human.userId, authorizedAt: Date.now() };
  policy.issueNumbers = [1];
  const create = (id: string, parentSessionId?: string) => {
    db.createSession({ id, runnerId: runner.runnerId, workspaceId: "workspace", agentId: "fixture-agent",
      title: id, useWorktree: false, driver, now: Date.now(), parentSessionId, config: { model: "fixture-vision" },
      creationActor: parentSessionId ? "agent" : "human",
      scope: { organizationId: human.organizationId, owner: { kind: "user", userId: human.userId } },
      ...(!parentSessionId ? { role: "orchestrator", orchestratorPolicy: policy,
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } } : {}) });
    db.updateSessionStatus(id, "running", Date.now());
  };
  create("root"); create("worker", "root"); create("sibling", "root");
  const sent: ControlPlaneToRunner[] = [];
  let observeLaunch: ((message: ControlPlaneToRunner) => void) | undefined;
  const service = () => {
    const hub = new Hub(db);
    hub.isRunnerOnline = () => true;
    hub.sessionChangedById = () => {};
    hub.sendToRunner = (_runnerId, message) => { observeLaunch?.(message); sent.push(message); return true; };
    hub.requestFromRunner = async (_runnerId, requestId, message) => {
      // No forge is contacted: only scope metadata for the deterministic refusal case.
      if (message.type === "campaign_issue_scope") return { type: "campaign_issue_scope_result", requestId,
        sessionId: message.sessionId, ok: true, repository: REPOSITORY, candidates: [] };
      throw new Error("Unexpected synthetic runner request");
    };
    if (!hostingVideo) return new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
    const video = composeHostingVideoEvidence(db);
    const disclosures = hostingEvidenceAuthorityDisclosures({
      organizationExists: (organizationId) => db.listOrganizationIds().includes(organizationId), listRunners: () => db.listRunners() });
    return new SessionsService(db, hub, { info() {}, warn() {}, error() {} }, undefined, undefined, undefined, undefined, undefined,
      undefined, false, undefined, undefined, video.workflowVideoApprovals, disclosures, undefined, video.preparedMediaActiveStops);
  };
  let svc = service();
  const enable = (budgetAuthority?: CampaignBudgetAuthority) => svc.setCampaignControl("root", {
    mode: "full_control", objective: "Implement the fixture button interaction for issue 1",
    operations: ["implementation_question", "question", "tool_approval", "pr_merge", "merged_branch_deletion",
      "ui_evidence_approval", "follow_up_issue_publication", "campaign_issue_scope", "issue_closure"],
    delegatablePolicyIds: [],
    ...(budgetAuthority ? { budgetAuthority } : {}),
  }, 1, human);
  const ask = (sessionId: string, requestId: string) => svc.createWorkflowDecision(sessionId,
    { requestId, resourceKey: requestId, resourceSnapshot: question });
  const approve = (sessionId: string, occurrenceId: string) => svc.resolveDescendantRequest("root", sessionId,
    occurrenceId, { action: "resolve_workflow_decision", outcome: "approve", selectedOptionId: "inline" }, () => true);
  const inspection = (sessionId: string, occurrenceId: string) => svc.onSessionEvent(sessionId, {
    kind: "permission_request", requestId: occurrenceId, occurrenceId, requestSource: "provider_tool",
    title: "Inspect Fixture", context: {
      toolName: driver === "claude-code" ? "Bash" : "commandExecution", input: "cat implementation.ts",
      operation: { kind: "command", input: "cat implementation.ts", cwd: directory,
        filesystem: { cwd: directory, targets: [{ path: "implementation.ts", resolvedPath: join(directory, "implementation.ts") }],
          containment: { version: 1, root: directory, sessionRoot: directory } } },
    }, options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }],
  });
  return {
    get db() { return db; }, get svc() { return svc; }, human, sent, enable, ask, approve, inspection,
    setLaunchObserver(observer: (message: ControlPlaneToRunner) => void) { observeLaunch = observer; },
    createAssignedChild(campaignWorkItemId: string) {
      return svc.createSession({ runnerId: runner.runnerId, workspaceId: "workspace", agentId: "fixture-agent",
        config: { model: "fixture-vision" }, prompt: "Implement fixture issue 1", campaignWorkItemId },
      undefined, undefined, false, false, false, { parentSessionId: "root" });
    },
    reopen() { db.close(); db = ControlPlaneDb.open(path); svc = service(); },
    close() { db.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

for (const driver of ["codex-app-server", "claude-code"] as const) {
  test(`${driver}: bounded fixture authority, transactional child assignment and launch attribution survive ledger refusal`, async () => {
    const h = stack(driver);
    try {
      h.db.updateSessionStatus("worker", "completed", Date.now());
      h.db.updateSessionStatus("sibling", "completed", Date.now());
      const authority: CampaignBudgetAuthority = { version: 1, accounting: "managed_workers_only",
        unpriced: "stop", toolCalls: 120, concurrency: 2 };
      const enabled = h.enable(authority); assert.ok(enabled.ok, enabled.error ?? "bounded fixture admission failed");
      const recorded = h.svc.recordCampaignPlan("root", { planComplete: true,
        items: [{ key: `${REPOSITORY}#1`, issue: { repository: REPOSITORY, number: 1 } }] });
      assert.ok(recorded.ok && recorded.data, recorded.error ?? "plan refused");
      const workItemId = recorded.data.items[0]!.workItemId;
      const state = () => ({ budget: h.db.campaignBudgets.view("root"),
        members: h.db.campaignBudgets.members("root"),
        launches: h.sent.filter((m) => m.type === "start_session").length });
      const before = state();
      const ledger = h.db.campaignWorkLedger;
      const assign = ledger.assign;
      for (const replacement of [
        () => ({ ok: false as const, status: 409, error: "fixture ledger refusal" }),
        () => { throw new Error("fixture ledger transaction abort"); },
      ]) {
        ledger.assign = replacement as typeof assign;
        let result;
        try { result = h.createAssignedChild(workItemId); } finally { ledger.assign = assign; }
        assert.equal(result.ok, false);
        assert.match(result.error ?? "", /cannot record the child's attempt/u);
        assert.deepEqual(state(), before, "failed attribution cannot leave a reservation or launch");
      }
      h.setLaunchObserver((message) => {
        if (message.type !== "start_session") return;
        const child = h.db.getSession(message.spec.sessionId)!;
        assert.equal(child.campaignMembership?.currentWorkItemId, workItemId,
          "the durable work attempt exists before the runner receives launch");
        assert.equal(message.spec.campaignBudgetDispatch?.rootSessionId, "root");
      });
      const created = h.createAssignedChild(workItemId);
      assert.ok(created.ok && created.data, created.error ?? "retry launch refused");
      const childId = created.data.id;
      const decision = h.ask(childId, "assigned-implementation"); assert.ok(decision.ok && decision.data);
      assert.ok(h.approve(childId, decision.data.occurrenceId).ok);
      const allocation = h.db.campaignBudgets.allocation(childId);
      h.reopen();
      assert.equal(h.db.getSession(childId)!.campaignMembership?.currentWorkItemId, workItemId);
      assert.deepEqual(h.db.campaignBudgets.allocation(childId), allocation);
      assert.ok((await h.svc.consumeWorkflowDecision(childId, decision.data.occurrenceId, { resourceSnapshot: question })).ok);
      assert.equal(state().launches, before.launches + 1);
      assert.deepEqual(h.db.campaignBudgets.view("root")!.authority, authority,
        "retry and reopen preserve the original finite fixture envelope");
    } finally { h.close(); }
  });

  test(`${driver}: one fixture human admission joins root planning, generic permissions, exact child decisions and durable concurrent consumption`, async () => {
    const h = stack(driver);
    try {
      const enabled = h.enable(); assert.ok(enabled.ok, enabled.error ?? "admission failed");
      const boundary = h.db.getSession("root")!.orchestratorPolicy!.control!;
      assert.equal(boundary.mode, "full_control");
      assert.ok(boundary.mode === "full_control");
      assert.equal(boundary.boundary.authorizedByUserId, h.human.userId);
      h.svc.onSessionEvent("root", { kind: "question_request", requestId: "root-plan", occurrenceId: "root-plan",
        requestSource: "provider_question", questions: [{ id: "placement", question: question.question,
          options: [{ label: "Inline" }, { label: "Footer" }] }] });
      h.inspection("root", "root-inspection");
      assert.equal(h.db.getSession("root")!.pendingApproval, null);
      assert.equal(h.sent.filter((m) => m.type === "answer_question").length, 1);
      assert.equal(h.sent.filter((m) => m.type === "resolve_permission").length, 1);
      h.inspection("worker", "worker-inspection");
      assert.equal(h.db.getSession("worker")!.pendingRequestOwners!.orchestrator, 1);
      assert.ok(h.svc.resolveDescendantRequest("root", "worker", "worker-inspection",
        { action: "approve", optionId: "once" }, () => true).ok);
      const requested = h.ask("worker", "placement"); assert.ok(requested.ok, requested.error ?? "request failed");
      const decision = requested.data!;
      assert.ok(h.approve("worker", decision.occurrenceId).ok);
      h.reopen();
      const resumed = h.db.workflowDecisionByOccurrence(decision.occurrenceId)!;
      assert.deepEqual(resumed.resourceSnapshot, decision.resourceSnapshot);
      assert.equal(resumed.resourceDigest, decision.resourceDigest);
      const results = await Promise.all([0, 1].map(() => h.svc.consumeWorkflowDecision("worker", decision.occurrenceId,
        { resourceSnapshot: question })));
      assert.equal(results.filter((r) => r.ok).length, 1, "only one concurrent action consumes the grant");
      h.reopen();
      assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "consumed");
      assert.equal((await h.svc.consumeWorkflowDecision("worker", decision.occurrenceId,
        { resourceSnapshot: question })).ok, false);
      assert.deepEqual(h.db.getSession("root")!.orchestratorPolicy!.control, boundary,
        "reopening storage never creates a new authorization or boundary revision");
      h.svc.onSessionEvent("root", { kind: "permission_request", requestId: "git-inspection",
        occurrenceId: "git-inspection", requestSource: "provider_tool", title: "Inspect Git Status",
        context: { toolName: driver === "claude-code" ? "Bash" : "commandExecution",
          input: "git status --short", operation: { kind: "command", input: "git status --short",
            cwd: "/fixture/repository", filesystem: { cwd: "/fixture/repository", targets: [] } } },
        options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] });
      // Git is never a bounded effect, and a parked root cannot judge it: it declines its own once
      // and nobody is asked (#2940).
      assert.equal(h.db.getSession("root")!.pendingApproval, null);
      const settled = h.sent.filter((m) => m.type === "resolve_permission") as Array<{ requestId: string; optionId: string | null }>;
      assert.deepEqual(settled.filter((m) => m.requestId === "git-inspection").map((m) => m.optionId), [null]);
      assert.equal(h.svc.resolveDescendantRequest("root", "root", "git-inspection",
        { action: "approve", optionId: "once" }, () => true).ok, false);
    } finally { h.close(); }
  });

  test(`${driver}: synthetic screenshot rejection, corrected capture, exact receipt acknowledgement and consumption share one UI gate`, async () => {
    const h = stack(driver);
    try {
      assert.ok(h.enable().ok);
      // Fixture PNG, not an implementation capture or a model-visible quality verdict.
      const bytes = readFileSync(fileURLToPath(new URL("../../web/public/icons/icon-192.png", import.meta.url)));
      const artifact = h.svc.createWorkflowArtifact({ sessionId: "worker", kind: "screenshot", name: "fixture.png",
        mimeType: "image/png", encoding: "base64", data: bytes.toString("base64") }, { kind: "agent", id: "worker" });
      assert.ok(artifact.ok, artifact.error ?? "attachment failed");
      const evidence = { evidenceId: "fixture-capture", artifactId: artifact.data!.artifactId,
        mediaType: "image/png", sha256: artifact.data!.sha256 };
      let snapshot = { category: "ui_evidence_approval" as const, evidence: [evidence] };
      const request = (requestId: string) => h.svc.createWorkflowDecision("worker", { requestId,
        resourceKey: "interaction-capture", resourceSnapshot: snapshot });
      const first = request("before-repair"); assert.ok(first.ok, first.error ?? "request failed");
      const reject = h.svc.resolveDescendantRequest("root", "worker", first.data!.occurrenceId,
        { action: "resolve_workflow_decision", outcome: "deny", rationale: "Fixture feedback: repair the interaction." }, () => true);
      assert.ok(reject.ok, reject.error ?? "rejection failed");
      assert.equal(h.db.workflowDecisionByOccurrence(first.data!.occurrenceId)!.status, "denied");
      const repairedBytes = readFileSync(fileURLToPath(new URL("../../web/public/icons/icon-512.png", import.meta.url)));
      const repairedArtifact = h.svc.createWorkflowArtifact({ sessionId: "worker", kind: "screenshot", name: "fixture-repaired.png",
        mimeType: "image/png", encoding: "base64", data: repairedBytes.toString("base64") }, { kind: "agent", id: "worker" });
      assert.ok(repairedArtifact.ok, repairedArtifact.error ?? "repair attachment failed");
      snapshot = { category: "ui_evidence_approval", evidence: [{ ...evidence,
        artifactId: repairedArtifact.data!.artifactId, sha256: repairedArtifact.data!.sha256 }] };
      assert.notEqual(snapshot.evidence[0]!.sha256, evidence.sha256, "repair requires new immutable bytes");
      const second = request("after-repair"); assert.ok(second.ok, second.error ?? "request failed");
      assert.notEqual(second.data!.occurrenceId, first.data!.occurrenceId);
      const resolve = () => h.svc.resolveDescendantRequest("root", "worker", second.data!.occurrenceId,
        { action: "resolve_workflow_decision", outcome: "approve", evidenceReviewed: [evidence.evidenceId] }, () => true);
      assert.equal(resolve().ok, false, "repeating IDs is insufficient");
      const delivered = h.svc.reviewDescendantUiEvidence("root", "worker", second.data!.occurrenceId, evidence.evidenceId, () => true);
      assert.ok(delivered.ok, delivered.error ?? "delivery failed");
      assert.equal(createHash("sha256").update(Buffer.from(delivered.data!.data, "base64")).digest("hex"), snapshot.evidence[0]!.sha256);
      assert.equal(resolve().ok, false, "delivery without acknowledgement is insufficient");
      assert.equal(h.svc.acknowledgeDescendantUiEvidence("root", delivered.data!.receipt.receiptId, "0".repeat(64)).ok, false);
      h.reopen();
      assert.equal(h.svc.acknowledgeDescendantUiEvidence("root", delivered.data!.receipt.receiptId, evidence.sha256).ok, false,
        "a previous capture digest cannot acknowledge repaired bytes");
      assert.ok(h.svc.acknowledgeDescendantUiEvidence("root", delivered.data!.receipt.receiptId, snapshot.evidence[0]!.sha256).ok);
      assert.ok(resolve().ok);
      assert.ok((await h.svc.consumeWorkflowDecision("worker", second.data!.occurrenceId, { resourceSnapshot: snapshot })).ok);
      assert.equal(resolve().ok, false);
      assert.equal(h.svc.reviewDescendantUiEvidence("root", "worker", first.data!.occurrenceId, evidence.evidenceId, () => true).ok, false);
      const audit = JSON.stringify(h.db.listGovernanceAudit("worker"));
      assert.ok(audit.includes(snapshot.evidence[0]!.sha256));
      assert.ok(!audit.includes(repairedBytes.toString("base64")), "audit holds references rather than image bytes");
      assert.deepEqual(second.data!.resourceSnapshot, snapshot, "original artifact identity remains the UI gate snapshot");
    } finally { h.close(); }
  });

  test(`${driver}: one blocked credential decline remains while unrelated authorized work consumes once; restart revokes stale grants`, async () => {
    const h = stack(driver);
    try {
      assert.ok(h.enable().ok);
      const event = { kind: "question_request" as const, requestId: "credential-value", occurrenceId: "credential-value",
        requestSource: "provider_question" as const, questions: [{ id: "secret", question: "Which password should I use?",
          options: [{ label: "A" }, { label: "B" }] }] };
      for (let index = 0; index < 3; index++) h.svc.onSessionEvent("worker", event);
      const humanRequests = h.svc.descendantRequests("root", () => true, "human");
      assert.ok(humanRequests.ok);
      assert.equal(humanRequests.data!.requests.filter((r) => r.responseOwner === "human").length, 0, "Full Control asks nobody (#2940)");
      assert.ok(!h.sent.some((m) => m.type === "answer_question" && (m as { action?: string }).action !== "dismiss"),
        "the credential question is only ever dismissed, never answered");
      const blocked = h.db.campaignProjection("root")!.recovery!.records.filter((record) => record.reason === "request_declined");
      assert.equal(blocked.length, 1, "redelivery retains one blocked record, not repeated requests");
      assert.equal(blocked[0]!.state, "blocked");
      assert.deepEqual(h.db.campaignRecovery.declines("root", h.db.getSession("root")!.parentControlPolicy!.revision)
        .map((decline) => [decline.sessionId, decline.requestClass, decline.count]), [["worker", "secrets_and_sign_in", 1]]);
      assert.equal(h.svc.resolveDescendantRequest("root", "worker", event.occurrenceId,
        { action: "answer", answers: { secret: "A" } }, () => true).ok, false);
      const unrelated = h.ask("sibling", "sibling-placement").data!;
      assert.ok(h.approve("sibling", unrelated.occurrenceId).ok);
      assert.ok((await h.svc.consumeWorkflowDecision("sibling", unrelated.occurrenceId, { resourceSnapshot: question })).ok);
      const stale = h.ask("sibling", "pre-restart").data!;
      assert.ok(h.approve("sibling", stale.occurrenceId).ok);
      assert.ok(h.svc.restart("sibling").ok);
      h.reopen();
      assert.equal(h.db.workflowDecisionByOccurrence(stale.occurrenceId)!.status, "revoked");
      assert.equal((await h.svc.consumeWorkflowDecision("sibling", stale.occurrenceId, { resourceSnapshot: question })).ok, false);
      assert.equal(h.svc.descendantRequests("root", () => true, "human").data!.requests.filter((r) => r.responseOwner === "human").length, 0);
      assert.equal(h.db.campaignProjection("root")!.recovery!.records.filter((record) => record.reason === "request_declined").length, 1,
        "the decline stays visible as blocked work across reopen");
    } finally { h.close(); }
  });
}

for (const hostingVideo of [false, true]) test("foundation scope stays human and uncertified video can only be denied by the Orchestrator, never a synthetic complete positive campaign" +
  (hostingVideo ? " under the hosting video composition" : ""), async () => {
  const h = stack("codex-app-server", PROTOCOL_VERSION, hostingVideo);
  try {
    assert.ok(h.enable().ok);
    const scope = await h.svc.proposeCampaignIssueScope("root", { requestId: "fixture-scope", expectedRevision: 1,
      additions: [], removals: [{ repository: REPOSITORY, number: 1 }], explanation: "Fixture scope withdrawal" });
    assert.ok(scope.ok, scope.error ?? "scope request failed");
    assert.equal(scope.data!.authority, "human");
    assert.equal(h.svc.resolveDescendantRequest("root", "root", scope.data!.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve" }, () => true).ok, false);
    assert.equal((await h.svc.consumeWorkflowDecision("root", scope.data!.occurrenceId,
      { resourceSnapshot: scope.data!.resourceSnapshot })).ok, false);
    // A short fixture proves the current attached-video refusal; it supplies no normal-profile temporal proof.
    const bytes = readFileSync(fileURLToPath(new URL("../test-fixtures/video-review-one-frame-transient.webm", import.meta.url)));
    const video = h.svc.attachSessionVideo("worker", { name: "fixture.webm",
      mimeType: "video/webm", data: bytes.toString("base64") }, { kind: "agent", id: "worker" });
    assert.ok(video.ok, video.error ?? "video attachment failed");
    const decision = h.svc.createWorkflowDecision("worker", { requestId: "normal-video", resourceKey: "normal-video",
      resourceSnapshot: { category: "ui_evidence_approval", evidence: [{ evidenceId: "video", artifactId: video.data!.artifactId,
        mediaType: "video/webm", sha256: video.data!.sha256 }] } });
    assert.ok(decision.ok, decision.error ?? "video request failed");
    // Full Control never routes evidence to the Human (#2940). The Orchestrator owns the gate but
    // can neither receive the raw video nor approve it without a receipt: it can only deny.
    assert.equal(decision.data!.authority, "orchestrator");
    assert.equal(decision.data!.humanFallback, undefined);
    const delivery = h.svc.reviewDescendantUiEvidence("root", "worker", decision.data!.occurrenceId, "video", () => true);
    assert.equal(delivery.ok, false);
    assert.match(delivery.error!, /Ask the child for screenshots attached as Session artifacts, or deny the claim as unproven\./u);
    assert.equal(h.svc.resolveDescendantRequest("root", "worker", decision.data!.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve", evidenceReviewed: ["video"] }, () => true).ok, false);
    assert.notEqual(h.db.campaignProjection("root")!.status, "verified_complete");
    assert.ok(h.svc.resolveDescendantRequest("root", "worker", decision.data!.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "deny", childMessage: "Attach screenshots as Session artifacts." }, () => true).ok);
    assert.equal(h.db.workflowDecisionByOccurrence(decision.data!.occurrenceId)!.status, "denied");
  } finally { h.close(); }
});

test("Full Control owns evidence it cannot inspect, yet never delivers another Session's artifact; Custom still routes it to the Human", () => {
  for (const full of [true, false]) {
    const h = stack("codex-app-server");
    try {
      if (full) assert.ok(h.enable().ok);
      else assert.ok(h.svc.setParentControlPolicy("root", { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, ui_evidence_approval: "orchestrator" },
        h.db.getSession("root")!.parentControlPolicy?.revision).ok);
      const bytes = readFileSync(fileURLToPath(new URL("../../web/public/icons/icon-192.png", import.meta.url)));
      const foreign = h.svc.createWorkflowArtifact({ sessionId: "sibling", kind: "screenshot", name: "sibling.png",
        mimeType: "image/png", encoding: "base64", data: bytes.toString("base64") }, { kind: "agent", id: "sibling" });
      assert.ok(foreign.ok, foreign.error ?? "attachment failed");
      const decision = h.svc.createWorkflowDecision("worker", { requestId: "foreign", resourceKey: "foreign", resourceSnapshot: {
        category: "ui_evidence_approval", evidence: [{ evidenceId: "foreign", artifactId: foreign.data!.artifactId,
          mediaType: "image/png", sha256: foreign.data!.sha256 }] } });
      assert.ok(decision.ok, decision.error ?? "request failed");
      assert.equal(decision.data!.authority, full ? "orchestrator" : "human");
      if (full) assert.equal(decision.data!.humanFallback, undefined);
      else assert.equal(decision.data!.humanFallback?.code, "artifact_unavailable");
      const delivered = h.svc.reviewDescendantUiEvidence("root", "worker", decision.data!.occurrenceId, "foreign", () => true);
      assert.equal(delivered.ok, false, "another Session's bytes are never delivered");
      assert.equal(h.svc.resolveDescendantRequest("root", "worker", decision.data!.occurrenceId,
        { action: "resolve_workflow_decision", outcome: "approve", evidenceReviewed: ["foreign"] }, () => true).ok, false);
    } finally { h.close(); }
  }
});

test("older peers cannot admit the foundation even with fixture image capability", () => {
  const h = stack("codex-app-server", 214);
  try { assert.equal(h.enable().ok, false); assert.equal(h.db.getSession("root")!.orchestratorPolicy!.control, undefined); }
  finally { h.close(); }
});
