import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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
import { campaignBoundaryCurrent } from "./campaign-authority.js";

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
    assert.equal(h.svc.resolveDescendantRequest("root", "child", "unknown", { action: "answer", answers: { approach: "A" } }, () => true).ok, false);
    assert.equal(h.db.getSession("child")!.pendingRequestOwners?.human, 1);
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
      title: "Inspect Repository", context: { toolName: "Bash", input: "cat src/implementation.ts", operation: { kind: "command", input: "cat src/implementation.ts", cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: "src/implementation.ts", resolvedPath: "/repos/test/src/implementation.ts" }] } } }, options: [
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
      assert.equal(session.pendingApproval!.options[0]!.name, "Allow for Session");
      assert.equal(session.pendingApproval!.options[0]!.kind, "allow_always");
      if (fullControl) assert.equal(session.pendingRequestOwners!.human, 1);
      else if (sessionId === "child") assert.equal(session.pendingRequestOwners!.orchestrator, 1, "Custom may delegate rejection, never a persistent grant");
      else assert.equal(session.pendingRequestOwners, undefined, "Custom root requests stay in the direct human request card");
      assert.equal(h.svc.resolveDescendantRequest("root", sessionId, session.pendingApproval!.occurrenceId!,
        { action: "approve", optionId: "allow" }, () => true).ok, false);
      assert.equal(h.sent.length, 0, "session grants never get standing root or delegated child admission");
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
        title: input, context: { toolName: "commandExecution", input, operation: { kind: "command", input, cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: input.split(" ").at(-1)!, resolvedPath: `/repos/test/${input.split(" ").at(-1)!}` }] } } },
        options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] });
      assert.equal(h.db.getSession("child")!.pendingRequestOwners?.orchestrator, 1);
      assert.equal(h.db.campaignRequestsForPrincipal(h.principal, "root")!.orchestrator, 1);
      assert.equal(h.db.listSessionsForPrincipal(h.principal).find((s) => s.id === "root")!.campaignRequests!.orchestrator, 1);
      assert.equal(h.svc.descendantRequests("root", () => true).data!.requests[0]!.authorityEvaluation!.owner, "orchestrator");
      assert.ok(h.svc.resolveDescendantRequest("root", "child", input, { action: "approve", optionId: "once" }, () => true).ok);
    }
  } finally { h.db.close(); }
});

test("root admission cannot settle a foreign effect, missing operation, credential request or persistent grant", () => {
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
        title: "Tool Request", requestSource: "provider_tool", context, options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }] });
      assert.equal(h.sent.filter((message) => (message as { type: string }).type === "resolve_permission").length, 0);
      assert.equal(h.db.getSession("root")!.pendingRequestOwners!.human, 1);
      assert.equal(h.db.campaignProjection("root")!.status, "waiting_human");
      assert.equal(h.svc.resolveDescendantRequest("root", "root", "root-tool", { action: "approve", optionId: "once" }, () => true).ok, false);
    } finally { h.db.close(); }
  }
});

test("generic Git requests remain reachable human exceptions in all projections without root callbacks", () => {
  for (const input of ["git status --short", "git diff -- src/implementation.ts",
    "git -c core.fsmonitor=false --no-pager diff --no-ext-diff --no-textconv -- src/implementation.ts"]) {
    const h = harness();
    try {
      assert.ok(h.enable().ok);
      for (const id of ["root", "child"]) h.svc.onSessionEvent(id, {
        kind: "permission_request", requestId: id, occurrenceId: id, requestSource: "provider_tool", title: "Inspect Repository",
        context: { toolName: "commandExecution", input, operation: { kind: "command", input, cwd: "/repos/test",
          filesystem: { cwd: "/repos/test", targets: input.includes("status") ? [] : [{ path: "src/implementation.ts", resolvedPath: "/repos/test/src/implementation.ts" }] } } },
        options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }],
      });
      assert.equal(h.sent.length, 0, "Full Control never settles generic Git execution");
      assert.equal(h.db.campaignProjection("root")!.status, "waiting_human");
      assert.equal(h.db.campaignRequestsForPrincipal(h.principal, "root")!.human, 2);
      assert.equal(h.db.listSessionsForPrincipal(h.principal).find((s) => s.id === "root")!.campaignRequests!.human, 2);
      const visible = h.svc.descendantRequests("root", () => true, "human").data!.requests;
      assert.equal(visible.length, 2);
      for (const id of ["root", "child"]) {
        assert.equal(h.db.getSession(id)!.pendingRequestOwners!.human, 1);
        assert.equal(visible.find((r) => r.sessionId === id)!.authorityEvaluation!.reason, "outside_boundary");
        assert.equal(h.svc.resolveDescendantRequest("root", id, id, { action: "approve", optionId: "once" }, () => true).ok, false);
      }
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
      assert.equal(h.db.getSession("root")!.pendingRequestOwners!.human, 1);
      assert.equal(h.sent.length, 0, "escaping source path never settles the parked root callback");
    }
  } finally { h.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("shell patterns cannot hide a source symlink escape in root or child admission", () => {
  const directory = mkdtempSync(join(tmpdir(), "campaign-glob-boundary-"));
  const repo = join(directory, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src/regular.ts"), "benign repository fixture\n");
  writeFileSync(join(directory, "outside.ts"), "benign outside fixture\n");
  symlinkSync(join(directory, "outside.ts"), join(repo, "src/link.ts"));
  try {
    for (const command of ["cat src/*.ts", "cat src/?ink.ts", `cat ${repo}/src/*.ts`, `cat ${repo}/src/?ink.ts`]) {
      const h = harness(PROTOCOL_VERSION, repo, "codex-app-server");
      try {
        assert.ok(h.enable().ok);
        const context = approvalContext("item/commandExecution/requestApproval", { command, cwd: repo }, false);
        for (const id of ["root", "child"]) h.svc.onSessionEvent(id, {
          kind: "permission_request", requestId: id, occurrenceId: id, requestSource: "provider_tool",
          title: "Inspect Source", context, options: [{ optionId: "once", name: "Allow Once", kind: "allow_once" }],
        });
        assert.equal(h.sent.length, 0, "a shell pattern never settles the parked root callback");
        assert.equal(h.db.campaignProjection("root")!.status, "waiting_human");
        assert.equal(h.db.campaignRequestsForPrincipal(h.principal, "root")!.human, 2);
        assert.equal(h.db.listSessionsForPrincipal(h.principal).find((s) => s.id === "root")!.campaignRequests!.human, 2);
        assert.equal(h.svc.descendantRequests("root", () => true, "human").data!.requests.length, 2);
        for (const id of ["root", "child"]) {
          assert.equal(h.db.getSession(id)!.pendingRequestOwners!.human, 1);
          assert.equal(h.svc.resolveDescendantRequest("root", id, id, { action: "approve", optionId: "once" }, () => true).ok, false);
        }
      } finally { h.db.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("pending root requests settle on human admission; unavailable delivery becomes a disclosed human exception", () => {
  for (const available of [true, false]) {
    const h = harness();
    try {
      h.generic("root", "already-parked");
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

test("live Human Required, deny and withdrawn asks have the same effective owner in every projection and resolution", () => {
  for (const change of ["human", "deny", "disabled"] as const) {
    const h = harness();
    try {
      const rule = { policyId: "delegated", name: "Delegate Inspection", effect: "ask" as const, priority: 1,
        enabled: true, scope: { toolName: "Bash" } };
      h.db.upsertGovernancePolicy(rule, Date.now());
      assert.ok(h.enable(["delegated"]).ok);
      h.svc.onSessionEvent("child", { kind: "permission_request", requestId: "live-rule", occurrenceId: "live-rule", requestSource: "provider_tool",
        title: "Inspect Repository", context: { toolName: "Bash", input: "cat src/implementation.ts", operation: { kind: "command", input: "cat src/implementation.ts", cwd: "/repos/test", filesystem: { cwd: "/repos/test", targets: [{ path: "src/implementation.ts", resolvedPath: "/repos/test/src/implementation.ts" }] } } },
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

test("ambiguous credential-value choices stay human even on trusted question and implementation routes without secret fields", () => {
  const h = harness();
  try {
    assert.ok(h.enable().ok);
    for (const question of ["Which password should I use?", "Which credentials should we use to implement the feature?"]) {
      h.svc.onSessionEvent("root", { kind: "question_request", requestId: question, occurrenceId: question,
        requestSource: "provider_question", questions: [{ id: "value", question, options: [{ label: "A" }, { label: "B" }] }] });
      assert.equal(h.db.getSession("root")!.pendingRequestOwners!.human, 1);
      assert.equal(h.sent.length, 0, "a planning source cannot authorize actual credential-value selection");
      const typed = h.svc.createWorkflowDecision("child", { requestId: question, resourceKey: question,
        resourceSnapshot: { ...h.snapshot, question } });
      assert.ok(typed.ok);
      assert.equal(typed.data!.authority, "human");
      assert.equal(typed.data!.authorityEvaluation!.reason, "protected_request");
    }
  } finally { h.db.close(); }
});

test("a real parked root NDJSON provider resumes after its question and one-time auth-file approval without another agent call", { timeout: 10_000 }, async () => {
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
    assert.equal(h.sent.filter((m) => (m as { type: string }).type === "answer_question").length, 1);
    assert.equal(h.sent.filter((m) => (m as { type: string }).type === "resolve_permission").length, 1);
    assert.ok(h.db.listGovernanceAudit("root").filter((a) => a.stage === "resolution").every((a) => a.actor.kind === "system"));
  } finally { driver.dispose(); h.db.close(); rmSync(root, { recursive: true, force: true }); }
});
