import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerDriver, approvalContext } from "../../runner/src/drivers/codex-app-server.js";
import {
  DEFAULT_ORCHESTRATOR_DEFAULTS, HUMAN_ONLY_PARENT_CONTROL_POLICY, PROTOCOL_VERSION,
  type PendingApproval, type RunnerMetadata, type WorkflowDecisionResourceSnapshot,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { Hub } from "./hub.js";
import { SessionsService, canonicalPrMergeEnqueueCommand } from "./sessions.js";
import { resolveOrchestratorCampaignPolicy, parseOrchestratorOverrides } from "./orchestrator-settings.js";
import type { HumanPrincipal } from "./identity.js";
import { campaignBoundaryCurrent, evaluateCampaignAuthority } from "./campaign-authority.js";
import { runnerCredentialRoots, setCampaignCredentialRoots } from "../../runner/src/campaign-operation-evidence.js";

/** A v230 runner's attestation that resolved targets are inside the fixture worktree `/repos/test`. */
const CONTAINED = { version: 1 as const, root: "/repos/test", sessionRoot: "/repos/test" };

function harness(protocol = PROTOCOL_VERSION, workspacePath = "/repos/test", driver: "claude-code" | "codex-app-server" = "claude-code") {
  const db = ControlPlaneDb.open(":memory:");
  const identity = db.localIdentityContext();
  const principal: HumanPrincipal = { ...identity, kind: "human", actorId: identity.userId };
  const metadata: RunnerMetadata = { runnerId: "r", hostname: "test", os: "linux", version: "test",
    workspaces: [{ id: "w", name: "Repo", path: workspacePath }],
    agents: [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver, context: { kind: "native" }, available: true }] };
  db.registerRunner(metadata, 1, protocol);
  const policy = resolveOrchestratorCampaignPolicy(DEFAULT_ORCHESTRATOR_DEFAULTS, "system_default");
  policy.issueScope = { repository: "picoduck/wollipog", issueNumbers: [2934], revision: 1,
    authorizedByUserId: principal.userId, authorizedAt: 1 };
  policy.issueNumbers = [2934];
  const make = (id: string, parentSessionId?: string) => {
    db.createSession({ id, runnerId: "r", workspaceId: "w", agentId: "claude", title: id, useWorktree: false,
      driver, now: 1, config: {}, parentSessionId,
      ...(!parentSessionId ? { role: "orchestrator", orchestratorPolicy: policy,
        parentControlPolicy: { decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY } } } : {}) });
    db.updateSessionStatus(id, "running", 2);
  };
  make("root"); make("child", "root");
  const hub = new Hub(db);
  hub.isRunnerOnline = () => true;
  hub.sessionChangedById = () => {};
  const sent: unknown[] = [];
  hub.sendToRunner = (_id, message) => { sent.push(message); return true; };
  // A GitHub merge's closing-reference read (#3713): these pull requests close no issue.
  const request = hub.requestFromRunner.bind(hub);
  hub.requestFromRunner = async (runnerId, requestId, message, timeoutMs) => message.type === "github_merge_preflight"
    ? { type: "github_merge_preflight_result", requestId, sessionId: message.sessionId, ok: true, check: { checkedAt: 1, closures: [] } }
    : request(runnerId, requestId, message, timeoutMs);
  const svc = new SessionsService(db, hub, { info() {}, warn() {}, error() {} });
  const enable = (delegatablePolicyIds: string[] = []) => svc.setCampaignControl("root", { mode: "full_control", objective: "Implement #2934",
    operations: ["implementation_question", "question", "tool_approval", "policy_ask", "pr_merge", "merged_branch_deletion"],
    delegatablePolicyIds }, 1, principal);
  const snapshot: WorkflowDecisionResourceSnapshot = { category: "implementation_question", question: "Which authentication library should we implement?",
    options: [{ optionId: "a", label: "Library A" }, { optionId: "b", label: "Library B" }] };
  const ask = (id: string, requestId: string) => svc.createWorkflowDecision(id, { requestId, resourceKey: requestId, resourceSnapshot: snapshot });
  const generic = (id: string, requestId: string, source: PendingApproval["requestSource"] = "provider_question") => svc.onSessionEvent(id, {
    kind: "question_request", requestId, occurrenceId: requestId, requestSource: source,
    questions: [{ id: "approach", question: snapshot.question, options: [{ label: "A" }, { label: "B" }] }],
  });
  return { db, svc, principal, sent, enable, ask, generic, snapshot, make };
}

test("pure media authority requires both participant contract inputs and never invents missing metadata", () => {
  const h = harness(223); try {
    assert.ok(h.enable().ok);
    const root = h.db.getSession("root")!, child = h.db.getSession("child")!;
    const control = root.orchestratorPolicy!.control!;
    assert.equal(control.mode, "full_control"); if (control.mode !== "full_control") assert.fail("fixture boundary missing");
    const b = control.boundary;
    // Local pure-input fixture only. No server evidence admission, runtime or provider grant.
    b.evidenceAuthority = { version: 1, revision: b.revision, authorizedByUserId: b.authorizedByUserId,
      authorizedAt: b.authorizedAt, campaignRootSessionId: "root", repository: b.repository, objective: b.objective,
      issueScopeRevision: b.issueScopeRevision, scope: "relevant_task_evidence_only",
      destination: { kind: "session_artifacts", configurationId: "synthetic", organizationId: "synthetic",
        privacy: "private", disclosureRevision: 1 }, providers: [{ providerId: "synthetic", disclosureRevision: 1,
        retentionDisclosure: "Synthetic source input only.", reviewers: [{ driver: "claude-code", modelId: "synthetic" }] }] };
    const metadata = { id: "wollipog-paced-video-review-v1", revision: 1 };
    for (const peers of [undefined, {}, { controller: metadata }, { requester: metadata },
      { controller: metadata, requester: { id: "other", revision: 1 } }]) {
      assert.equal(evaluateCampaignAuthority(root, child, 223, h.snapshot, root.parentControlPolicy, 223, peers).owner, "human");
    }
    assert.equal(evaluateCampaignAuthority(root, child, 223, h.snapshot, root.parentControlPolicy, 223,
      { controller: metadata, requester: metadata }).owner, "orchestrator", "compatibility source input, not a live media decision");
    assert.deepEqual(h.sent, []);
  } finally { h.db.close(); }
});

test("human admission preserves defaults, mode omission, scope and provider restrictions", () => {
  const h = harness();
  try {
    assert.equal(h.db.getSession("root")!.orchestratorPolicy?.control, undefined);
    assert.equal(h.ask("root", "custom-root").ok, false);
    assert.equal(parseOrchestratorOverrides({ control: { mode: "full_control" } }), null, "child overrides cannot mint a grant");
    const enabled = h.enable(); assert.ok(enabled.ok, enabled.error ?? "admission failed");
    const control = enabled.data!.orchestratorPolicy!.control!;
    assert.equal(control.mode, "full_control");
    assert.ok(control.mode === "full_control");
    assert.equal(control.boundary.authorizedByUserId, h.principal.userId);
    assert.equal(control.boundary.revision, 2);
    assert.equal(control.boundary.issueScopeRevision, 1);
    assert.equal(campaignBoundaryCurrent(enabled.data!), true);
    assert.equal(h.db.campaignProjection("root")!.decisionOwners.implementation_question, "orchestrator");
    assert.equal(h.db.campaignProjection("root")!.decisionOwners.pr_merge, "orchestrator");
    assert.equal(h.db.campaignProjection("root")!.decisionOwners.follow_up_issue_publication, "human", "unlisted operations stay human-owned");
    assert.equal(h.db.getSession("root")!.permissionMode, null, "mode does not broaden provider permissions");
    assert.equal(h.svc.setCampaignControl("root", { mode: "custom" }, 2, { ...h.principal, kind: "agent" } as unknown as HumanPrincipal).ok, false);
    assert.equal(h.svc.setCampaignControl("root", { mode: "custom" }, 1, h.principal).ok, false, "CAS refuses stale intent");
  } finally { h.db.close(); }
  const older = harness(214);
  try { assert.equal(older.enable().ok, false); assert.equal(older.db.getSession("root")!.orchestratorPolicy?.control, undefined); }
  finally { older.db.close(); }
});

test("root requests use standing authorization and child requests delegate; exact consume/replay/audience stay enforced", async () => {
  const h = harness();
  try {
    assert.ok(h.enable().ok);
    for (const id of ["root", "child"]) {
      const asked = h.ask(id, `ask-${id}`); assert.ok(asked.ok, asked.error ?? "request failed");
      const decision = asked.data!;
      assert.equal(decision.authority, "orchestrator");
      assert.equal(decision.authorityEvaluation?.basis, id === "root" ? "standing_authorization" : "campaign_delegation");
      assert.equal(h.db.getSession(id)!.pendingRequestOwners!.requests!.find((r) => r.occurrenceId === decision.occurrenceId)!.owner, decision.authority);
      assert.equal(h.svc.resolveWorkflowDecision("root", id, decision.occurrenceId,
        { outcome: "approve", selectedOptionId: "a" }, "orchestrator", { kind: "agent", id: "root" }, () => false).ok, false);
      assert.ok(h.svc.resolveDescendantRequest("root", id, decision.occurrenceId,
        { action: "resolve_workflow_decision", outcome: "approve", selectedOptionId: "a" }, () => true).ok);
      const consumed = await h.svc.consumeWorkflowDecision(id, decision.occurrenceId, { resourceSnapshot: h.snapshot });
      assert.ok(consumed.ok, consumed.error ?? "consume failed");
      assert.equal((await h.svc.consumeWorkflowDecision(id, decision.occurrenceId, { resourceSnapshot: h.snapshot })).ok, false);
    }
    const changed = h.ask("child", "changed").data!;
    assert.ok(h.svc.resolveDescendantRequest("root", "child", changed.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve", selectedOptionId: "a" }, () => true).ok);
    assert.equal((await h.svc.consumeWorkflowDecision("child", changed.occurrenceId, { resourceSnapshot: { ...h.snapshot, question: "changed" } })).ok, false);
    assert.equal(h.db.workflowDecisionByOccurrence(changed.occurrenceId)!.status, "revoked");
  } finally { h.db.close(); }
});

test("provider, parent and list projections share sensitive request ownership", () => {
  const h = harness();
  try {
    assert.ok(h.enable().ok);
    h.generic("child", "child-planning");
    h.generic("root", "root-planning");
    assert.equal(h.db.getSession("child")!.pendingRequestOwners?.orchestrator, 1);
    assert.equal(h.db.getSession("root")!.pendingApproval, null, "root provider is resumed from standing authorization");
    const requests = h.svc.descendantRequests("root", () => true).data!.requests;
    assert.equal(requests.length, 1);
    assert.ok(requests.every((r) => r.responseOwner === "orchestrator" && r.authorityEvaluation?.reason === "authorized_operation"));
    assert.equal(h.db.campaignRequestsForPrincipal(h.principal, "root")!.orchestrator, 1);
    assert.equal(h.db.listSessionsForPrincipal(h.principal).find((s) => s.id === "root")!.campaignRequests!.orchestrator, 1);
    assert.ok(h.sent.some((message) => (message as { type: string; sessionId: string }).type === "answer_question" && (message as { sessionId: string }).sessionId === "root"));
    assert.equal(h.svc.resolveDescendantRequest("root", "root", "root-planning", { action: "answer", answers: { approach: "A" } }, () => true).ok, false);
    h.generic("child", "unknown", undefined);
    // Explicitly remove provenance: default parameters otherwise select the trusted source.
    const pending = h.db.getSession("child")!.pendingApproval!; delete pending.requestSource;
    h.db.setPendingApproval("child", pending);
    // Unverified provenance about authentication is declined under Full Control (#2940): owned by
    // the Orchestrator so the Human is never asked, and only ever declined, never answered.
    assert.equal(h.svc.resolveDescendantRequest("root", "child", "unknown", { action: "answer", answers: { approach: "A" } }, () => true).ok, false);
    const owners = h.db.getSession("child")!.pendingRequestOwners!;
    assert.equal(owners.human, 0);
    assert.equal(owners.requests!.find((r) => r.occurrenceId === "unknown")!.authorityEvaluation!.disposition, "decline");
    assert.ok(h.svc.resolveDescendantRequest("root", "child", "unknown", { action: "dismiss" }, () => true).ok);
  } finally { h.db.close(); }
});

test("revocation invalidates pending and approved decisions durably and scope changes cannot preserve authority", async () => {
  const h = harness();
  try {
    assert.ok(h.enable().ok);
    const approved = h.ask("child", "approved").data!;
    assert.ok(h.svc.resolveDescendantRequest("root", "child", approved.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve", selectedOptionId: "a" }, () => true).ok);
    const pending = h.ask("root", "pending").data!;
    const revoke = h.svc.setCampaignControl("root", { mode: "custom" }, 2, h.principal);
    assert.ok(revoke.ok, revoke.error ?? "revocation failed");
    for (const decision of [approved, pending]) assert.equal(h.db.workflowDecisionByOccurrence(decision.occurrenceId)!.status, "revoked");
    assert.equal((await h.svc.consumeWorkflowDecision("child", approved.occurrenceId, { resourceSnapshot: h.snapshot })).ok, false);
    assert.equal(h.ask("root", "after-revoke").ok, false);
    assert.equal(h.db.getSession("root")!.parentControlPolicy!.revision, 3);
  } finally { h.db.close(); }
});

test("Full Control cannot delegate persistent grants or Human Required provider asks", () => {
  const h = harness();
  try {
    assert.ok(h.enable().ok);
    h.svc.onSessionEvent("child", { kind: "permission_request", requestId: "tool", occurrenceId: "tool", requestSource: "provider_tool",
      title: "Inspect Repository", context: { toolName: "Bash", input: "cat src/implementation.ts", operation: { kind: "command", input: "cat src/implementation.ts", cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: "src/implementation.ts", resolvedPath: "/repos/test/src/implementation.ts" }], containment: CONTAINED } } }, options: [
        { optionId: "once", name: "Allow Once", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" }] });
    assert.equal(h.svc.resolveDescendantRequest("root", "child", "tool", { action: "approve", optionId: "always" }, () => true).ok, false);
    assert.equal(h.svc.resolveDescendantRequest("root", "child", "tool", { action: "approve", optionId: "once" }, () => false).ok, false);
    assert.ok(h.svc.resolveDescendantRequest("root", "child", "tool", { action: "approve", optionId: "once" }, () => true).ok);
    assert.equal(h.sent.filter((m) => (m as { type: string }).type === "resolve_permission").length, 1);
  } finally { h.db.close(); }
});

test("Codex permission-profile grants cannot be approved by Custom or Full Control root and children", () => {
  for (const fullControl of [false, true]) {
  const h = harness(PROTOCOL_VERSION, "/repos/test", "codex-app-server");
  try {
    if (fullControl) assert.ok(h.enable().ok);
    else assert.ok(h.svc.setParentControl("root", "questions_and_approvals").ok);
    for (const sessionId of ["root", "child"]) {
      const driver = new CodexAppServerDriver({ command: "codex", args: [], cwd: "/repos/test", env: {}, context: { kind: "native" }, config: { permissionMode: "on-request" } }, {
        onEvent: (event) => h.svc.onSessionEvent(sessionId, event), onStderr() {}, onExit() {},
      });
      const requests = new Map<string, (params: unknown, id: string) => Promise<unknown>>();
      (driver as unknown as { registerHandlers(peer: unknown): void }).registerHandlers({
        onRequest: (method: string, handler: (params: unknown, id: string) => Promise<unknown>) => requests.set(method, handler),
        onNotification() {},
      });
      void requests.get("item/permissions/requestApproval")!({ permissions: { network: true } }, `grant-${sessionId}`);
      const session = h.db.getSession(sessionId)!;
      if (fullControl) {
        // Full Control declines the session-wide access grant itself (#2940) and asks nobody.
        assert.equal(session.pendingApproval, null);
        const declines = h.sent.filter((m) => (m as { type: string; sessionId: string }).type === "resolve_permission" &&
          (m as { sessionId: string }).sessionId === sessionId) as Array<{ optionId: string | null }>;
        assert.deepEqual(declines.map((m) => m.optionId), ["deny"], "only the one-time reject is ever delivered");
        assert.ok(h.db.campaignProjection("root")!.recovery!.records.some((record) => record.reason === "request_declined" &&
          record.resource.sessionId === sessionId), "recorded as blocked work");
      } else {
        assert.equal(session.pendingApproval!.options[0]!.name, "Allow for Session");
        assert.equal(session.pendingApproval!.options[0]!.kind, "allow_always");
        if (sessionId === "child") assert.equal(session.pendingRequestOwners!.orchestrator, 1, "Custom may delegate rejection, never a persistent grant");
        else assert.equal(session.pendingRequestOwners, undefined, "Custom root requests stay in the direct human request card");
        assert.equal(h.svc.resolveDescendantRequest("root", sessionId, session.pendingApproval!.occurrenceId ?? `grant-${sessionId}`,
          { action: "approve", optionId: "allow" }, () => true).ok, false);
        assert.equal(h.sent.length, 0, "session grants never get standing root or delegated child admission");
      }
      assert.ok(!h.sent.some((m) => (m as { optionId?: string }).optionId === "allow"), "a persistent grant is never delivered");
      driver.dispose();
    }
  } finally { h.db.close(); }
  }
});

test("trusted in-bound auth source inspection has the same owner in every server projection", () => {
  const h = harness();
  try {
    assert.ok(h.enable().ok);
    for (const input of ["cat apps/control-plane/src/auth.ts", "cat src/authentication.ts"]) {
      h.svc.onSessionEvent("child", { kind: "permission_request", requestId: input, occurrenceId: input, requestSource: "provider_tool",
        title: input, context: { toolName: "commandExecution", input, operation: { kind: "command", input, cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: input.split(" ").at(-1)!, resolvedPath: `/repos/test/${input.split(" ").at(-1)!}` }], containment: CONTAINED } } },
        options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] });
      assert.equal(h.db.getSession("child")!.pendingRequestOwners?.orchestrator, 1);
      assert.equal(h.db.campaignRequestsForPrincipal(h.principal, "root")!.orchestrator, 1);
      assert.equal(h.db.listSessionsForPrincipal(h.principal).find((s) => s.id === "root")!.campaignRequests!.orchestrator, 1);
      assert.equal(h.svc.descendantRequests("root", () => true).data!.requests[0]!.authorityEvaluation!.owner, "orchestrator");
      assert.ok(h.svc.resolveDescendantRequest("root", "child", input, { action: "approve", optionId: "once" }, () => true).ok);
    }
  } finally { h.db.close(); }
});

test("root admission never allows a foreign effect, missing operation, credential request or persistent grant; it declines each once", () => {
  const cases = [
    { toolName: "commandExecution", input: "cat /unrelated/repository/README.md", operation: { kind: "command" as const, input: "cat /unrelated/repository/README.md", cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: "/unrelated/repository/README.md", resolvedPath: "/unrelated/repository/README.md" }] } } },
    { toolName: "commandExecution", input: "pnpm test" },
    { toolName: "commandExecution", input: "pnpm test", operation: { kind: "command" as const, input: "pnpm test", cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [] } } },
    { toolName: "commandExecution", network: "requested", operation: { kind: "command" as const, input: "cat src/implementation.ts", cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: "src/implementation.ts", resolvedPath: "/repos/test/src/implementation.ts" }] } } },
    { toolName: "commandExecution", providerPermissionExpansion: true, operation: { kind: "command" as const, input: "cat src/implementation.ts", cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: "src/implementation.ts", resolvedPath: "/repos/test/src/implementation.ts" }] } } },
    { toolName: "UnknownTool", operation: { kind: "file" as const, path: "/repos/test/src/auth.ts" } },
    { toolName: "commandExecution", input: "cat .env", operation: { kind: "command" as const, input: "cat .env", cwd: "/repos/test" } },
    { toolName: "permissions", operation: { kind: "permission_grant" as const, lifetime: "session" as const } },
  ];
  for (const context of cases) {
    const h = harness();
    try {
      assert.ok(h.enable().ok);
      h.svc.onSessionEvent("root", { kind: "permission_request", requestId: "root-tool", occurrenceId: "root-tool",
        title: "Tool Request", requestSource: "provider_tool", context, options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" }] });
      const resolved = h.sent.filter((message) => (message as { type: string }).type === "resolve_permission") as Array<{ optionId: string | null }>;
      assert.deepEqual(resolved.map((m) => m.optionId), ["reject"], "a parked root declines what it cannot verify, once");
      assert.notEqual(h.db.campaignProjection("root")!.status, "waiting_human");
      assert.equal(h.db.campaignRequestsForPrincipal(h.principal, "root")!.human, 0);
      assert.equal(h.svc.resolveDescendantRequest("root", "root", "root-tool", { action: "approve", optionId: "once" }, () => true).ok, false);
    } finally { h.db.close(); }
  }
});

test("generic Git requests never reach the Human and are never allowed: root and child decline them once", () => {
  for (const input of ["git status --short", "git diff -- src/implementation.ts",
    "git -c core.fsmonitor=false --no-pager diff --no-ext-diff --no-textconv -- src/implementation.ts"]) {
    const h = harness();
    try {
      assert.ok(h.enable().ok);
      for (const id of ["root", "child"]) h.svc.onSessionEvent(id, {
        kind: "permission_request", requestId: id, occurrenceId: id, requestSource: "provider_tool", title: "Inspect Repository",
        context: { toolName: "commandExecution", input, operation: { kind: "command", input, cwd: "/repos/test",
          filesystem: { cwd: "/repos/test", targets: input.includes("status") ? [] : [{ path: "src/implementation.ts", resolvedPath: "/repos/test/src/implementation.ts" }] } } },
        options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
      });
      // Git can run configured helpers, so its effects never resolve to explicit targets (#2940 CR-1.1).
      const resolved = h.sent.filter((m) => (m as { type: string }).type === "resolve_permission") as Array<{ sessionId: string; optionId: string | null }>;
      assert.deepEqual(resolved.map((m) => [m.sessionId, m.optionId]), [["root", "reject"], ["child", "reject"]], "declined once each, never allowed");
      assert.notEqual(h.db.campaignProjection("root")!.status, "waiting_human");
      assert.equal(h.db.campaignRequestsForPrincipal(h.principal, "root")!.human, 0);
      assert.equal(h.db.listSessionsForPrincipal(h.principal).find((s) => s.id === "root")!.campaignRequests!.human, 0);
      assert.equal(h.db.campaignProjection("root")!.recovery!.records.filter((record) => record.reason === "request_declined").length, 0,
        "a plain decline, not credential blocked work");
    } finally { h.db.close(); }
  }
});

test("exact root workflow admission settles one tool approval; Human Required and deny rules supersede it", async () => {
  for (const effect of [undefined, "ask", "deny"] as const) {
    const h = harness();
    try {
      assert.ok(h.enable().ok);
      const snapshot = { category: "pr_merge" as const, repository: "picoduck/wollipog", pullRequest: 123,
        headSha: "a".repeat(40), reviewResult: "merge" as const, requiredChecks: { headSha: "a".repeat(40),
          status: "passed" as const, checkedAt: Date.now(), checks: [{ name: "CI", state: "passed" as const }] } };
      const asked = h.svc.createWorkflowDecision("root", { requestId: "merge", resourceKey: "merge", resourceSnapshot: snapshot });
      assert.ok(asked.ok, asked.error ?? "request failed");
      const decision = asked.data!;
      assert.ok(h.svc.resolveDescendantRequest("root", "root", decision.occurrenceId,
        { action: "resolve_workflow_decision", outcome: "approve" }, () => true).ok);
      const command = canonicalPrMergeEnqueueCommand(snapshot);
      assert.ok((await h.svc.consumeWorkflowDecision("root", decision.occurrenceId,
        { resourceSnapshot: snapshot, action: { kind: "pr_merge_enqueue", command } })).ok);
      if (effect) h.db.upsertGovernancePolicy({ policyId: "protected", name: "Protected", effect,
        priority: 1, enabled: true, scope: { toolName: "Bash" }, ...(effect === "ask" ? { conditions: { humanRequired: true } } : {}) }, Date.now());
      h.svc.onSessionEvent("root", { kind: "permission_request", requestId: "enqueue", occurrenceId: "enqueue", requestSource: "provider_tool",
        title: "Enqueue PR", context: { toolName: "Bash", input: command }, options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] });
      const after = h.db.workflowDecisionByOccurrence(decision.occurrenceId)!;
      assert.equal(after.status, effect ? "approved" : "consumed");
      if (effect === "ask") {
        assert.equal(h.db.getSession("root")!.pendingApproval!.humanRequired, true);
        assert.equal(h.svc.resolveDescendantRequest("root", "root", "enqueue", { action: "approve", optionId: "once" }, () => true).ok, false);
      }
      if (!effect) {
        assert.equal(h.db.getSession("root")!.pendingApproval, null);
        assert.equal(h.sent.filter((message) => (message as { type: string }).type === "resolve_permission").length, 1);
      }
    } finally { h.db.close(); }
  }
});

test("root admission follows physical targets and refuses source symlinks escaping to benign or protected fixtures", () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-symlink-boundary-"));
  const repo = join(directory, "repo"); mkdirSync(repo);
  mkdirSync(join(directory, ".codex"));
  writeFileSync(join(directory, "outside.ts"), "export const benign = true;\n");
  writeFileSync(join(directory, ".codex/auth.json"), "{\"fixture\":true}\n");
  symlinkSync(join(directory, "outside.ts"), join(repo, "outside.ts"));
  symlinkSync(join(directory, ".codex/auth.json"), join(repo, "authentication.ts"));
  const h = harness(PROTOCOL_VERSION, repo, "codex-app-server");
  try {
    assert.ok(h.enable().ok);
    for (const path of ["outside.ts", "authentication.ts"]) {
      const context = approvalContext("item/commandExecution/requestApproval", { command: `cat ${path}`, cwd: repo,
        operation: { filesystem: { targets: [{ path, resolvedPath: join(repo, path) }] } } }, false);
      assert.equal(context.operation?.filesystem?.targets[0]?.resolvedPath, path === "outside.ts" ? join(directory, path) : join(directory, ".codex/auth.json"), "runner resolves targets; provider claims cannot supply evidence");
      h.svc.onSessionEvent("root", { kind: "permission_request", requestId: path, occurrenceId: path, requestSource: "provider_tool",
        title: "Inspect Source", context, options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] });
      const evaluation = h.svc.descendantRequests("root", () => true).data!.requests.find((r) => r.occurrenceId === path)?.authorityEvaluation
        ?? h.db.getSession("root")!.pendingRequestOwners?.requests?.find((r) => r.occurrenceId === path)?.authorityEvaluation;
      const declined = h.sent.filter((m) => (m as { type: string; requestId: string }).type === "resolve_permission" &&
        (m as { requestId: string }).requestId === path) as Array<{ optionId: string | null }>;
      assert.deepEqual(declined.map((m) => m.optionId), [null], "an escaping source path is declined, never allowed");
      assert.ok(!evaluation || evaluation.disposition === "decline");
    }
    // A symlink into a credential store is declined as secrets, and recorded as blocked work.
    assert.ok(h.db.campaignProjection("root")!.recovery!.records.some((record) => record.reason === "request_declined" &&
      record.state === "blocked" && record.resource.sessionId === "root"));
  } finally { h.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("resolved symlinks into Wollipog's own provider homes and data directory are declined as secrets, not decided", () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-runner-roots-"));
  const dataDir = join(directory, "data"); const profileRoot = join(directory, "home/.agent-manager/profiles");
  const repo = join(dataDir, "worktrees/repo");
  for (const dir of [join(dataDir, "agent-control"), join(dataDir, "provider-accounts/acct"), join(profileRoot, "profile-1"), join(repo, "src")]) {
    mkdirSync(dir, { recursive: true });
  }
  // Names deliberately unlike any credential pattern: only the runner's known roots can catch them.
  const stores = { agentControl: join(dataDir, "agent-control/session.cli"), account: join(dataDir, "provider-accounts/acct/settings.toml"),
    profile: join(profileRoot, "profile-1/state.bin") };
  for (const file of Object.values(stores)) writeFileSync(file, "synthetic\n");
  writeFileSync(join(repo, "src/plain.ts"), "export const plain = true;\n");
  for (const [name, target] of Object.entries(stores)) symlinkSync(target, join(repo, `src/${name}.ts`));
  setCampaignCredentialRoots(() => runnerCredentialRoots({ dataDir, worktreeRoot: join(dataDir, "worktrees"), profileRoot,
    providerAccountDirectories: [join(dataDir, "provider-accounts/acct")], agentEnvs: [], workspacePaths: [repo], userHome: join(directory, "home") }));
  const h = harness(PROTOCOL_VERSION, repo, "codex-app-server");
  try {
    assert.ok(h.enable().ok);
    for (const name of Object.keys(stores)) {
      const context = approvalContext("item/commandExecution/requestApproval", { command: `cat src/${name}.ts`, cwd: repo }, false, undefined, repo);
      assert.equal(context.operation?.filesystem?.targets[0]?.credentialStore, true, `${name}: the runner marks the resolved target`);
      for (const id of ["root", "child"]) {
        const evaluation = evaluateCampaignAuthority(h.db.getSession("root")!, { ...h.db.getSession(id)!, repositoryRoot: repo }, PROTOCOL_VERSION,
          { requestId: name, occurrenceId: name, kind: "permission", title: "Inspect", requestSource: "provider_tool", context,
            options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] });
        assert.deepEqual([evaluation.disposition, evaluation.requestClass], ["decline", "secrets_and_sign_in"], `${name} for ${id}`);
      }
    }
    // A managed worktree inside the data directory still holds ordinary, decidable repository code.
    const plain = approvalContext("item/commandExecution/requestApproval", { command: "cat src/plain.ts", cwd: repo }, false, undefined, repo);
    assert.equal(plain.operation?.filesystem?.containment?.root, realpathSync(repo), "the runner attests worktree containment");
    assert.equal(plain.operation?.filesystem?.targets[0]?.credentialStore, undefined);
    assert.equal(evaluateCampaignAuthority(h.db.getSession("root")!, { ...h.db.getSession("child")!, repositoryRoot: repo }, PROTOCOL_VERSION,
      { requestId: "plain", occurrenceId: "plain", kind: "permission", title: "Inspect", requestSource: "provider_tool", context: plain,
        options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] }).disposition, undefined);
  } finally {
    setCampaignCredentialRoots(() => ({ roots: [], except: [] }));
    h.db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test("the worktree allowlist declines a repository alias to a credential file kept outside its directory (CR-3.2)", () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-allowlist-"));
  const repo = join(directory, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  const home = join(directory, "home"); mkdirSync(join(home, ".codex"), { recursive: true });
  const vault = join(directory, "vault"); mkdirSync(vault);
  // The credential file is itself a symlink to an external backing file no denylist names.
  writeFileSync(join(vault, "provider-state.bin"), "{\"synthetic\":true}\n");
  symlinkSync(join(vault, "provider-state.bin"), join(home, ".codex/auth.json"));
  symlinkSync(join(vault, "provider-state.bin"), join(repo, "src/alias.ts"));
  writeFileSync(join(repo, "src/plain.ts"), "export const plain = true;\n");
  const h = harness(PROTOCOL_VERSION, repo, "codex-app-server");
  try {
    assert.ok(h.enable().ok);
    const context = approvalContext("item/commandExecution/requestApproval", { command: "cat src/alias.ts", cwd: repo }, false, undefined, repo);
    assert.equal(context.operation?.filesystem?.targets[0]?.resolvedPath, realpathSync(join(vault, "provider-state.bin")));
    assert.equal(context.operation?.filesystem?.containment, undefined, "the real target leaves the worktree, so nothing is attested");
    h.svc.onSessionEvent("child", { kind: "permission_request", requestId: "alias", occurrenceId: "alias", requestSource: "provider_tool",
      title: "Inspect Source", context, options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] });
    const resolved = h.sent.filter((m) => (m as { type: string }).type === "resolve_permission") as Array<{ optionId: string | null }>;
    assert.deepEqual(resolved.map((m) => m.optionId), ["reject"], "declined once, never allowed");
    assert.equal(h.svc.resolveDescendantRequest("root", "child", "alias", { action: "approve", optionId: "once" }, () => true).ok, false);
  } finally { h.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("evidence from an older runner is unresolved and declined, even if it claims containment (CR-3.1)", () => {
  for (const protocol of [229, PROTOCOL_VERSION]) {
    const h = harness(protocol);
    try {
      assert.ok(h.enable().ok);
      h.svc.onSessionEvent("child", { kind: "permission_request", requestId: "tool", occurrenceId: "tool", requestSource: "provider_tool",
        title: "Inspect Repository", context: { toolName: "Bash", input: "cat src/implementation.ts", operation: { kind: "command", input: "cat src/implementation.ts",
          cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: "src/implementation.ts", resolvedPath: "/repos/test/src/implementation.ts" }],
            containment: CONTAINED } } },
        options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }] });
      const resolved = h.sent.filter((m) => (m as { type: string }).type === "resolve_permission") as Array<{ optionId: string | null }>;
      if (protocol === 229) {
        assert.deepEqual(resolved.map((m) => m.optionId), ["reject"], "a v229 runner cannot attest containment: declined, not approvable");
      } else {
        assert.equal(resolved.length, 0, "a v230 containment attestation leaves it for the Orchestrator");
        assert.ok(h.svc.resolveDescendantRequest("root", "child", "tool", { action: "approve", optionId: "once" }, () => true).ok);
      }
    } finally { h.db.close(); }
  }
});

test("credential roots cover default and configured provider homes, session homes, and a dedicated agent HOME whole", () => {
  const roots = runnerCredentialRoots({ dataDir: "/d", worktreeRoot: "/d/worktrees", profileRoot: "/u/.agent-manager/profiles",
    providerAccountDirectories: ["/d/provider-accounts/a"],
    // The runner's own env, an agent (indirections resolved), and a session launch env.
    agentEnvs: [{ CODEX_HOME: "/runner/codex" }, { HOME: "/accounts/codex-b" }, { HOME: "/u" }, { CLAUDE_CONFIG_DIR: "/cfg/claude" }],
    credentialHomes: ["/d/provider-homes/session-1", undefined, "relative/ignored"],
    workspacePaths: ["/u/src/repo"], userHome: "/u" });
  assert.deepEqual(roots.roots, ["/d", "/u/.agent-manager/profiles", "/d/provider-accounts/a",
    // An agent with no configured home uses these, so they are always screened.
    "/u/.claude", "/u/.claude.json", "/u/.codex", "/u/.pi", "/d/provider-homes/session-1",
    "/runner/codex", "/accounts/codex-b", "/u/.claude", "/u/.codex", "/u/.pi", "/cfg/claude"]);
  assert.deepEqual(roots.except, ["/d/worktrees"]);
});

test("a shell pattern that can reach a credential store through a symlink is declined for root and child, never approvable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-glob-boundary-"));
  const repo = join(directory, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(directory, ".codex"));
  writeFileSync(join(repo, "src/regular.ts"), "benign repository fixture\n");
  writeFileSync(join(directory, ".codex/auth.json"), "{\"synthetic\":true}\n");
  // The glob matches a symlink into a synthetic credential store the runner cannot see through it.
  symlinkSync(join(directory, ".codex/auth.json"), join(repo, "src/link.ts"));
  try {
    for (const command of ["cat src/*.ts", "cat src/?ink.ts", `cat ${repo}/src/*.ts`, `cat ${repo}/src/?ink.ts`]) {
      const h = harness(PROTOCOL_VERSION, repo, "codex-app-server");
      try {
        assert.ok(h.enable().ok);
        const context = approvalContext("item/commandExecution/requestApproval", { command, cwd: repo }, false);
        assert.equal(context.operation?.filesystem, undefined, "the runner cannot resolve a shell pattern");
        for (const id of ["root", "child"]) h.svc.onSessionEvent(id, {
          kind: "permission_request", requestId: id, occurrenceId: id, requestSource: "provider_tool",
          title: "Inspect Source", context, options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }],
        });
        const resolved = h.sent.filter((m) => (m as { type: string }).type === "resolve_permission") as Array<{ sessionId: string; optionId: string | null }>;
        assert.deepEqual(resolved.map((m) => [m.sessionId, m.optionId]), [["root", null], ["child", null]], "declined once each");
        assert.ok(!resolved.some((m) => m.optionId === "once"), "no allow ever reaches the runner");
        // Even if a decline had not been delivered, the Orchestrator could never approve it.
        h.svc.onSessionEvent("child", { kind: "permission_request", requestId: "again", occurrenceId: "again", requestSource: "provider_tool",
          title: "Inspect Source", context, options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] });
        assert.equal(h.svc.resolveDescendantRequest("root", "child", "again", { action: "approve", optionId: "once" }, () => true).ok, false);
        assert.notEqual(h.db.campaignProjection("root")!.status, "waiting_human");
        assert.equal(h.db.campaignRequestsForPrincipal(h.principal, "root")!.human, 0);
        assert.equal(h.db.campaignProjection("root")!.recovery!.records.filter((record) => record.reason === "request_declined").length, 0,
          "a plain decline, not credential blocked work");
        // The child is told once, content-safely, to retry with explicit paths; the root is not woken.
        await new Promise((resolve) => setImmediate(resolve));
        const guidance = h.sent.filter((m) => JSON.stringify(m).includes("could not resolve every file it would touch to a real path inside this session's worktree")) as Array<{ sessionId?: string }>;
        assert.equal(guidance.length, 1);
        assert.equal(JSON.stringify(guidance[0]).includes("src/"), false, "the guidance never repeats the command or path");
        assert.ok(!JSON.stringify(guidance[0]).includes("\"root\""), "the parked root is not prompted for its own decline");
      } finally { h.db.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("pending root requests settle on human admission; unavailable delivery becomes a disclosed human exception", () => {
  for (const available of [true, false]) {
    const h = harness();
    try {
      // A verified one-time effect: the allow path a root's standing authorization still answers.
      h.svc.onSessionEvent("root", { kind: "permission_request", requestId: "already-parked", occurrenceId: "already-parked", requestSource: "provider_tool",
        title: "Inspect Repository", context: { toolName: "Bash", input: "cat src/implementation.ts", operation: { kind: "command", input: "cat src/implementation.ts", cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: "src/implementation.ts", resolvedPath: "/repos/test/src/implementation.ts" }], containment: CONTAINED } } },
        options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] });
      assert.ok(h.db.getSession("root")!.pendingApproval);
      if (!available) (h.svc as unknown as { hub: Hub }).hub.sendToRunner = () => false;
      assert.ok(h.enable().ok);
      const root = h.db.getSession("root")!;
      if (available) assert.equal(root.pendingApproval, null);
      else {
        assert.equal(root.pendingApproval!.standingAdmissionFailure, "provider_delivery_unavailable");
        assert.equal(root.pendingRequestOwners!.human, 1);
        assert.equal(root.pendingRequestOwners!.requests![0]!.authorityEvaluation!.reason, "provider_delivery_unavailable");
        assert.equal(h.db.campaignProjection("root")!.status, "waiting_human");
        const { standingAdmissionFailure: _serverField, ...runnerPending } = root.pendingApproval!;
        h.db.setPendingApproval("root", runnerPending);
        assert.equal(h.db.getSession("root")!.pendingApproval!.standingAdmissionFailure, "provider_delivery_unavailable", "same-occurrence runner metadata cannot erase the server exception");
        h.db.setPendingApproval("root", { ...runnerPending, occurrenceId: "fresh-occurrence" });
        assert.equal(h.db.getSession("root")!.pendingApproval!.standingAdmissionFailure, undefined, "a fresh occurrence does not inherit an old delivery exception");
      }
    } finally { h.db.close(); }
  }
});

test("a root's own pending typed decision never blocks its standing allow of a verified effect (#2940)", () => {
  const h = harness();
  try {
    assert.ok(h.enable().ok);
    const own = h.ask("root", "own-decision");
    assert.ok(own.ok, own.error ?? "own decision");
    assert.equal(own.data!.status, "pending");
    assert.ok(h.db.getSession("root")!.pendingRequestOwners!.requests!.some((r) => r.occurrenceId === own.data!.occurrenceId), "the root holds its own typed decision");
    h.svc.onSessionEvent("root", { kind: "permission_request", requestId: "root-tool", occurrenceId: "root-tool", requestSource: "provider_tool",
      title: "Inspect Repository", context: { toolName: "Bash", input: "cat src/implementation.ts", operation: { kind: "command", input: "cat src/implementation.ts", cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: "src/implementation.ts", resolvedPath: "/repos/test/src/implementation.ts" }], containment: CONTAINED } } },
      options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] });
    const resolved = h.sent.filter((m) => (m as { type: string }).type === "resolve_permission") as Array<{ sessionId: string; requestId: string; optionId: string }>;
    assert.deepEqual(resolved.map((m) => [m.sessionId, m.requestId, m.optionId]), [["root", "root-tool", "once"]],
      "the parked root is allowed once instead of waiting on a request only it could answer");
    assert.equal(h.db.workflowDecisionByOccurrence(own.data!.occurrenceId)!.status, "pending", "its own typed decision is untouched");
  } finally { h.db.close(); }
});

test("live Human Required, deny and withdrawn asks have the same effective owner in every projection and resolution", () => {
  for (const change of ["human", "deny", "disabled"] as const) {
    const h = harness();
    try {
      const rule = { policyId: "delegated", name: "Delegate Inspection", effect: "ask" as const, priority: 1,
        enabled: true, scope: { toolName: "Bash" } };
      h.db.upsertGovernancePolicy(rule, Date.now());
      assert.ok(h.enable(["delegated"]).ok);
      h.svc.onSessionEvent("child", { kind: "permission_request", requestId: "live-rule", occurrenceId: "live-rule", requestSource: "provider_tool",
        title: "Inspect Repository", context: { toolName: "Bash", input: "cat src/implementation.ts", operation: { kind: "command", input: "cat src/implementation.ts", cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: "src/implementation.ts", resolvedPath: "/repos/test/src/implementation.ts" }], containment: CONTAINED } } },
        options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] });
      assert.equal(h.db.getSession("child")!.pendingRequestOwners!.orchestrator, 1);
      assert.equal(h.db.listSessionsForPrincipal(h.principal).find((s) => s.id === "root")!.campaignRequests!.orchestrator, 1, "seed the cached list before changing policy");
      h.db.upsertGovernancePolicy({ ...rule, ...(change === "human" ? { conditions: { humanRequired: true } }
        : change === "deny" ? { effect: "deny" } : { enabled: false }) }, Date.now());
      assert.equal(h.db.getSession("child")!.pendingRequestOwners!.human, 1);
      assert.equal(h.db.campaignRequestsForPrincipal(h.principal, "root")!.human, 1);
      assert.equal(h.db.listSessionsForPrincipal(h.principal).find((s) => s.id === "root")!.campaignRequests!.human, 1);
      assert.equal(h.db.campaignProjection("root")!.status, "waiting_human");
      const human = h.svc.descendantRequests("root", () => true, "human").data!.requests[0]!;
      assert.equal(human.authorityEvaluation!.reason, "human_required_rule");
      assert.equal(h.svc.resolveDescendantRequest("root", "child", "live-rule", { action: "approve", optionId: "once" }, () => true).ok, false);
      assert.equal(h.sent.length, 0);
    } finally { h.db.close(); }
  }
});

test("ambiguous credential-value choices are declined, never answered, even on trusted question and implementation routes", () => {
  const h = harness();
  try {
    assert.ok(h.enable().ok);
    for (const question of ["Which password should I use?", "Which credentials should we use to implement the feature?"]) {
      h.svc.onSessionEvent("root", { kind: "question_request", requestId: question, occurrenceId: question,
        requestSource: "provider_question", questions: [{ id: "value", question, options: [{ label: "A" }, { label: "B" }] }] });
      const delivered = h.sent.filter((m) => (m as { type: string; requestId: string }).type === "answer_question" &&
        (m as { requestId: string }).requestId === question) as Array<{ action: string; answers: Record<string, unknown> }>;
      assert.deepEqual(delivered.map((m) => [m.action, Object.keys(m.answers).length]), [["dismiss", 0]],
        "a planning source cannot authorize actual credential-value selection; the question is dismissed");
      const typed = h.svc.createWorkflowDecision("child", { requestId: question, resourceKey: question,
        resourceSnapshot: { ...h.snapshot, question } });
      assert.equal(typed.ok, false);
      assert.equal(typed.status, 403);
      assert.equal(h.db.pendingWorkflowDecisionsForController("root").length, 0, "no decision is created for anyone to answer");
    }
    const blocked = h.db.campaignProjection("root")!.recovery!.records.filter((record) => record.reason === "request_declined");
    assert.deepEqual(blocked.map((record) => [record.resource.sessionId, record.state, record.effectiveOwner]).sort(),
      [["child", "blocked", "orchestrator"], ["root", "blocked", "orchestrator"]], "one deduplicated blocked record per session and class");
    for (const record of blocked) assert.doesNotMatch(JSON.stringify(record), /password|credentials should/iu, "content-safe");
  } finally { h.db.close(); }
});

test("a typed credential-handling design question is decided by the Orchestrator; one seeking a credential, sign-in or access is declined (#3844)", async () => {
  const h = harness();
  try {
    assert.ok(h.enable().ok);
    const design: WorkflowDecisionResourceSnapshot = { category: "implementation_question",
      question: "Should importing a provider sign-in copy an API key, move an OAuth sign-in, or be unsupported?",
      options: [{ optionId: "copy", label: "Copy the API key" }, { optionId: "move", label: "Move the OAuth sign-in" },
        { optionId: "none", label: "Not supported" }], recommendedOptionId: "none" };
    // The service entry point the request_workflow_decision route calls.
    const ask = (requestId: string, resourceSnapshot: WorkflowDecisionResourceSnapshot, sessionId = "child") =>
      h.svc.createWorkflowDecisionWithVideo(sessionId, { requestId, resourceKey: requestId, resourceSnapshot }, () => true);
    // The root decides the same question through its own typed route, as its question notice says.
    const rootAsked = await ask("root-import-design", design, "root");
    assert.ok(rootAsked.ok, rootAsked.error ?? "root request failed");
    assert.equal(rootAsked.data!.authorityEvaluation?.basis, "standing_authorization");
    assert.equal(rootAsked.data!.authorityEvaluation?.disposition, undefined, "decided, not declined");
    assert.ok(h.svc.resolveDescendantRequest("root", "root", rootAsked.data!.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve", selectedOptionId: "none" }, () => true).ok);
    assert.ok((await h.svc.consumeWorkflowDecision("root", rootAsked.data!.occurrenceId, { resourceSnapshot: design })).ok);
    const asked = await ask("import-design", design);
    assert.ok(asked.ok, asked.error ?? "request failed");
    assert.equal(asked.data!.authority, "orchestrator");
    assert.equal(asked.data!.authorityEvaluation?.basis, "campaign_delegation");
    assert.equal(asked.data!.authorityEvaluation?.disposition, undefined, "decided, not declined");
    assert.ok(h.svc.resolveDescendantRequest("root", "child", asked.data!.occurrenceId,
      { action: "resolve_workflow_decision", outcome: "approve", selectedOptionId: "none" }, () => true).ok);
    const consumed = await h.svc.consumeWorkflowDecision("child", asked.data!.occurrenceId, { resourceSnapshot: design });
    assert.ok(consumed.ok, consumed.error ?? "consume failed");
    const option = (label: string): WorkflowDecisionResourceSnapshot => ({ ...design, options: [{ optionId: "none", label: "Not supported" }, { optionId: "b", label }] });
    for (const [requestId, snapshot] of [
      ["key-value", { ...design, question: "What API key value should the importer use?" }],
      ["email-value", option("Use dev@example.com for the profile")],
      ["sign-in", option("Sign in to the provider now")],
      ["grant", option("Grant the importer access to the provider account")],
      ["lasting", option("Always allow the importer to read provider sign-ins")],
      ["send-url", option("Send the API key to https://collector.example for the provider test")],
      ["upload-token", option("Upload the token to the shared bucket")],
      ["pr-description", option("Copy the API key into the PR description")],
      ["public-log", option("Use the token in the public log")],
      ["backticked-env", { ...design, question: "Should we load `.env` for the import feature?" }],
      // CR-2.1 to CR-2.3.
      ["tell-me", option("Tell me the API key")],
      ["live-key", option("Copy the live API key into the profile")],
      ["personal-key", option("Copy the personal API key into the profile")],
      ["bare-host", option("Copy the API key to metrics.example.test")],
      ["host-port", option("Copy the API key to metrics.example.test:9090")],
      ["localhost-port", option("Use the API key on localhost:8080")],
    ] satisfies Array<[string, WorkflowDecisionResourceSnapshot]>) for (const sessionId of ["child", "root"]) {
      const declined = await ask(`${sessionId}-${requestId}`, snapshot, sessionId);
      assert.equal(declined.ok, false, `${sessionId} ${requestId}`);
      assert.equal(declined.status, 403, `${sessionId} ${requestId}`);
    }
    assert.equal(h.db.pendingWorkflowDecisionsForController("root").length, 0, "no declined decision is left for anyone to answer");
    const blocked = h.db.campaignProjection("root")!.recovery!.records.filter((record) => record.reason === "request_declined");
    assert.deepEqual(blocked.map((record) => [record.resource.sessionId, record.state]).sort(), [["child", "blocked"], ["root", "blocked"]]);
  } finally { h.db.close(); }
});

test("a real parked root NDJSON provider resumes after its dismissed question and one-time auth-file approval without another agent call", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "campaign-root-authority-"));
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src/authentication.ts"), "export const implementation = true;\n");
  const h = harness(PROTOCOL_VERSION, root, "codex-app-server");
  const events: string[] = [];
  const stderr: string[] = [];
  const driver = new CodexAppServerDriver({ command: process.execPath,
    args: [fileURLToPath(new URL("../../runner/src/drivers/fixtures/fake-codex-app-server.mjs", import.meta.url)), "full-control-root"],
    cwd: root, env: {}, config: { permissionMode: "on-request" }, context: { kind: "native" } }, {
    onEvent: (payload) => {
      if (payload.kind === "agent_message") events.push(payload.text);
      if (payload.kind === "question_request" || payload.kind === "permission_request") {
        h.svc.onSessionEvent("root", { ...payload, occurrenceId: `occurrence-${payload.requestId}` });
      }
    }, onStderr: (text) => stderr.push(text), onExit() {},
  });
  const hub = (h.svc as unknown as { hub: Hub }).hub;
  hub.sendToRunner = (_runnerId, message) => {
    h.sent.push(message);
    if (message.type === "answer_question") return driver.answerQuestion(message.requestId, message.answers, message.action);
    if (message.type === "resolve_permission") return driver.resolvePermission(message.requestId, message.optionId);
    return true;
  };
  try {
    assert.ok(h.enable().ok);
    await driver.initialize(); await driver.newSession(root);
    assert.equal(await driver.prompt("Implement the approved authentication feature."), "end_turn", stderr.join("\n"));
    assert.ok(events.includes("Root continued autonomously."));
    assert.equal(h.db.getSession("root")!.pendingApproval, null);
    assert.deepEqual(h.sent.filter((m) => (m as { type: string }).type === "answer_question").map((m) => (m as { action: string }).action), ["dismiss"],
      "the root's own question is dismissed, never answered with its recommended option");
    assert.equal(h.sent.filter((m) => (m as { type: string }).type === "resolve_permission").length, 1);
    assert.ok(h.db.listGovernanceAudit("root").filter((a) => a.stage === "resolution").every((a) => a.actor.kind === "system"));
  } finally { driver.dispose(); h.db.close(); rmSync(root, { recursive: true, force: true }); }
});
