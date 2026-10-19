import assert from "node:assert/strict";
import { test } from "node:test";
import {
  campaignAuthorityPreflight, campaignCodeOperationTargets, campaignWorkflowOwner, completeParentControlDecisions,
  resolveCampaignAuthority, validCampaignControl,
  HUMAN_ONLY_PARENT_CONTROL_POLICY, type CampaignControl, type PendingApproval, type WorkflowDecisionResourceSnapshot,
} from "./index.js";

const control: CampaignControl = { mode: "full_control", boundary: {
  version: 1, revision: 2, issueScopeRevision: 1, repository: "picoduck/wollipog", objective: "Implement approved issues",
  authorizedByUserId: "human", authorizedAt: 1,
  operations: ["implementation_question", "question", "tool_approval", "policy_ask", "pr_merge"], delegatablePolicyIds: ["review-tools"],
} };
const base = { control, parentControl: "off" as const, decisions: HUMAN_ONLY_PARENT_CONTROL_POLICY, root: false, supported: true };
const question = (text: string, extra: Partial<PendingApproval> = {}): PendingApproval => ({
  requestId: "q", kind: "question", title: text, options: [], requestSource: "provider_question",
  questions: [{ id: "choice", question: text, options: [{ label: "A" }, { label: "B" }] }], ...extra,
});
const tool: PendingApproval = { requestId: "p", kind: "permission", title: "Inspect Repository", requestSource: "provider_tool",
  context: { toolName: "commandExecution", input: "cat src/implementation.ts", operation: { kind: "command", input: "cat src/implementation.ts", cwd: "/repo", filesystem: { cwd: "/repo", targets: [{ path: "src/implementation.ts", resolvedPath: "/repo/src/implementation.ts" }] } } }, options: [
    { optionId: "once", name: "Allow Once", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" },
  ] };
const evaluate = (request: PendingApproval, override: Partial<Parameters<typeof resolveCampaignAuthority>[0]> = {}) =>
  resolveCampaignAuthority({ ...base, request, trustedSource: request.requestSource, repositoryRoot: "/repo", ...override });

// Static source-validator fixture, not a server mint or a live disclosure/runtime grant.
const mediaControl: CampaignControl = { ...control, boundary: { ...control.boundary, evidenceAuthority: {
  version: 1, revision: control.boundary.revision, authorizedByUserId: control.boundary.authorizedByUserId,
  authorizedAt: control.boundary.authorizedAt, campaignRootSessionId: "root", repository: control.boundary.repository,
  objective: control.boundary.objective, issueScopeRevision: control.boundary.issueScopeRevision,
  scope: "relevant_task_evidence_only", destination: { kind: "session_artifacts", configurationId: "synthetic-private",
    organizationId: "synthetic", privacy: "private", disclosureRevision: 1 },
  providers: [{ providerId: "synthetic-provider", disclosureRevision: 1, retentionDisclosure: "Synthetic source fixture only.",
    reviewers: [{ driver: "codex-app-server", modelId: "synthetic-model" }] }],
} } };
for (const [label, version, metadata] of [
  ["public221", 221, undefined], ["public222", 222, undefined],
  ["private number alone", 223, undefined], ["future number alone", 999, undefined],
  ["wrong identity", 223, { id: "other", revision: 1 }],
  ["wrong revision", 223, { id: "wollipog-paced-video-review-v1", revision: 2 }],
] as const) {
  test(`media authority preflight refuses ${label} without exact private compatibility`, () => {
    assert.ok(validCampaignControl(mediaControl), "exercise the actual guard with a valid source boundary");
    const result = Reflect.apply(campaignAuthorityPreflight, undefined, [mediaControl, "codex-app-server", version, metadata]);
    assert.equal(result.supported, false, "numeric public support is not private media compatibility");
  });
}

test("exact private metadata is only a compatibility condition and ordinary authority is unchanged", () => {
  const metadata = { id: "wollipog-paced-video-review-v1", revision: 1 };
  assert.equal(Reflect.apply(campaignAuthorityPreflight, undefined, [mediaControl, "codex-app-server", 223, metadata]).supported, true);
  assert.equal(campaignAuthorityPreflight(control, "codex-app-server", 215).supported, true);
  assert.equal(campaignAuthorityPreflight({ mode: "custom" }, "acp", 1).supported, true);
});

test("Full Control planning uses trusted provenance; Custom preserves keyword-based protection", () => {
  for (const text of ["Which authentication library should we implement?", "Should the OAuth flow use PKCE?",
    "Which validation test should use sample@example.com?", "Which approach should the login component use?",
    "Which API key schema should the component implement?", "Which password hashing algorithm should the component use?"]) {
    assert.equal(evaluate(question(text)).owner, "orchestrator", text);
    assert.equal(evaluate(question(text), { trustedSource: undefined }).reason, "unverified_intent");
  }
  assert.equal(evaluate(question("Which authentication library should we implement?"), {
    control: undefined, parentControl: "questions",
  }).owner, "human");
  assert.equal(evaluate(question("Which architecture?"), { control: undefined, parentControl: "questions" }).owner, "orchestrator");
  assert.equal(evaluate(question("Which architecture?"), { root: true, control: undefined, parentControl: "questions" }).owner, "human");
  assert.equal(evaluate(question("Which architecture?"), { root: true }).basis, "standing_authorization");
});

test("actual credentials, sign-in, access enlargement and missing or contradictory metadata stay protected", () => {
  for (const text of ["Paste the API key for the implementation test", "What is your password for the mock feature?",
    "Which production access token should the design use?", "Should I sign in for the OAuth flow?",
    "Grant access to implement the feature", "Enter secret value here", "Please share database credentials for the test",
    "Which credentials?", "Read ~/.ssh/id_rsa to implement the test", "Which password should I use?",
    "Which API key should I use?", "Which credentials should we use to implement the feature?", "What password will the app use?"]) {
    assert.equal(evaluate(question(text)).owner, "human", text);
  }
  assert.equal(evaluate(question("Which approach?", { questions: [{ id: "q", question: "Which approach?", secret: true, options: [] }] })).owner, "human");
  assert.equal(evaluate(question("Which validation?", { questions: [{ id: "q", question: "Which validation?", inputFormat: "email", options: [] }] })).owner, "human");
  assert.equal(evaluate(question("Which design?"), { trustedSource: "provider_tool" }).owner, "human");
  assert.equal(evaluate(question("Which design?"), { trustedSource: "provider_elicitation" }).owner, "human");
  assert.equal(evaluate({ ...tool, kind: "authentication" }).owner, "human");
  assert.equal(evaluate({ ...tool, context: { input: "cat .env" } }).owner, "human");
});

test("one-time approvals and specifically delegated asks cannot grant persistence or override human rules", () => {
  assert.equal(evaluate(tool).owner, "orchestrator");
  assert.equal(evaluate({ ...tool, options: tool.options.filter((o) => o.kind === "allow_always") }).owner, "human");
  assert.equal(evaluate({ ...tool, governancePolicyId: "review-tools" }).owner, "orchestrator");
  assert.equal(evaluate({ ...tool, governancePolicyId: "other" }).reason, "human_required_rule");
  assert.equal(evaluate({ ...tool, governancePolicyId: "review-tools" }, { humanRequired: true }).owner, "human");
  assert.equal(evaluate({ ...tool, context: { escalatedBy: { kind: "agent", id: "guardian" } } }).owner, "human");
  assert.equal(evaluate({ ...tool, kind: "cost_budget" }).owner, "human");
  assert.equal(evaluate({ ...tool, context: { toolName: "permissions", operation: { kind: "permission_grant", lifetime: "session" } } }).owner, "human");
});

test("verified repository code inspection is independent of authentication keywords; actual secret access stays protected", () => {
  for (const input of ["cat apps/control-plane/src/auth.ts", "cat src/authentication.ts", "cat src/password.ts"]) {
    const request = { ...tool, context: { toolName: "commandExecution", input,
      operation: { kind: "command" as const, input, cwd: "/repo", filesystem: { cwd: "/repo", targets: [{ path: input.split(" ").at(-1)!, resolvedPath: `/repo/${input.split(" ").at(-1)!}` }] } } } };
    assert.equal(evaluate(request, { repositoryRoot: "/repo" }).owner, "orchestrator", input);
    assert.equal(evaluate(request, { repositoryRoot: "/other" }).owner, "human", "outside workspace");
    assert.equal(evaluate({ ...request, context: { ...request.context, operation: undefined } }, { repositoryRoot: "/repo" }).owner, "human", "display-only text proves no operation");
  }
  for (const input of ["cat .env", "cat ~/.ssh/id_rsa", "cat /outside/auth.ts", "cat ../auth.ts", "gh auth login",
    "cat src/authentication.ts; cat .env", "cat $(cat src/authentication.ts)", "chmod 777 src/auth.ts"]) {
    assert.equal(evaluate({ ...tool, context: { toolName: "commandExecution", input,
      operation: { kind: "command", input, cwd: "/repo" } } }, { repositoryRoot: "/repo" }).owner, "human", input);
  }
  assert.equal(evaluate({ ...tool, context: { toolName: "Edit", path: "/repo/src/authentication.ts",
    operation: { kind: "file", path: "/repo/src/authentication.ts", filesystem: { targets: [{ path: "/repo/src/authentication.ts", resolvedPath: "/repo/src/authentication.ts" }] } } } }, { repositoryRoot: "/repo" }).owner, "orchestrator");
});

test("shell expansion and comment words cannot carry bounded read authority even with claimed evidence", () => {
  for (const path of ["src/*.ts", "src/?ink.ts", "src/[ab].ts", "src/{a,b}.ts", "~fixture.ts", "#fixture.ts", "!fixture.ts"]) {
    const input = `cat ${path}`;
    const operation = { kind: "command" as const, input, cwd: "/repo", filesystem: { cwd: "/repo", targets: [{ path, resolvedPath: `/repo/${path}` }] } };
    assert.equal(campaignCodeOperationTargets("commandExecution", operation), null, path);
    assert.equal(evaluate({ ...tool, context: { ...tool.context, input, operation } }).owner, "human", path);
  }
});

test("Git commands never qualify for automatic admission even with canonical evidence or helper flags", () => {
  for (const input of ["git status --short", "git diff -- src/implementation.ts", "git diff --cached -- src/implementation.ts",
    "git -C /repo status --porcelain", "git -c core.fsmonitor=false --no-pager diff --no-ext-diff --no-textconv -- src/implementation.ts",
    "git -c core.pager=cat status --short", "/usr/bin/git status --short", "env git status --short", "git show HEAD:src/implementation.ts"]) {
    const operation = { kind: "command" as const, input, cwd: "/repo", filesystem: { cwd: "/repo",
      targets: input.includes("status") ? [] : [{ path: "src/implementation.ts", resolvedPath: "/repo/src/implementation.ts" }] } };
    assert.equal(campaignCodeOperationTargets("commandExecution", operation), null, input);
    for (const root of [false, true]) {
      const result = evaluate({ ...tool, context: { ...tool.context, input, operation } }, { root });
      assert.equal(result.owner, "human", input);
      assert.equal(result.reason, "outside_boundary", input);
    }
  }
});

test("repository, operations and provider compatibility are bounded and disclosed", () => {
  const snapshot = { category: "merged_branch_deletion" as const, repository: "other/repo", branch: "feature", merged: true as const,
    mergeCommitSha: "a".repeat(40), dependentPullRequests: { checkedAt: 1, open: [] } };
  assert.equal(resolveCampaignAuthority({ ...base, snapshot, trustedSource: "workflow_route" }).owner, "human");
  assert.equal(evaluate(tool, { supported: false }).reason, "unsupported_provider");
  assert.deepEqual(campaignAuthorityPreflight(undefined, "acp", 100), { supported: true });
  for (const [driver, version] of [["codex-app-server", 214], ["codex", 215], ["pi", 215], ["acp", 215]] as const) {
    assert.equal(campaignAuthorityPreflight(control, driver, version).supported, false);
  }
  assert.equal(campaignAuthorityPreflight(control, "codex-app-server", 215).supported, true);
  assert.ok(campaignAuthorityPreflight(control, "codex-app-server", 215).humanRequiredRequests?.includes("git_execution_without_bounded_effect_proof"));
  assert.equal(validCampaignControl(control), true);
  for (const invalid of [null, {}, { mode: "full_control" }, { mode: "custom", boundary: {} },
    { ...control, boundary: { ...control.boundary, authorizedByUserId: "" } },
    { ...control, boundary: { ...control.boundary, operations: ["tool_approval", "tool_approval"] } }]) assert.equal(validCampaignControl(invalid), false);
});

test("bounded issue authority requires v217 while the foundation stays compatible with v215", () => {
  const bounded: CampaignControl = { mode: "full_control", boundary: { ...control.boundary,
    issueAuthority: { epics: [2935], relatedFollowUps: true, maxIssues: 3, closureReasons: ["completed"] },
  } };
  for (const driver of ["codex-app-server", "claude-code"]) {
    assert.equal(campaignAuthorityPreflight(control, driver, 215).supported, true);
    assert.equal(campaignAuthorityPreflight(bounded, driver, 216).supported, false,
      "live usage v216 does not prove bounded issue-write support");
    assert.equal(campaignAuthorityPreflight(bounded, driver, 217).supported, true);
  }
});

test("a policy stored before a later category reads it as human-owned; anything else malformed fails closed", () => {
  const { review_round_extension: _later, ...older } = { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, pr_merge: "orchestrator" as const };
  assert.deepEqual(completeParentControlDecisions(older), { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, pr_merge: "orchestrator" });
  assert.deepEqual(completeParentControlDecisions({ ...HUMAN_ONLY_PARENT_CONTROL_POLICY, review_round_extension: "orchestrator" }),
    { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, review_round_extension: "orchestrator" });
  const { pr_merge: _missing, ...incomplete } = HUMAN_ONLY_PARENT_CONTROL_POLICY;
  for (const malformed of [incomplete, { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, unknown: "human" },
    { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, review_round_extension: "anyone" }, [], null, "human"]) {
    assert.equal(completeParentControlDecisions(malformed), null, JSON.stringify(malformed));
  }
});

test("extra review rounds follow only an explicit Parent Control grant, never Full Control's own boundary", () => {
  const granted = { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, review_round_extension: "orchestrator" as const };
  const everything: CampaignControl = { ...control, boundary: { ...control.boundary, operations: [
    "implementation_question", "pr_merge", "merged_branch_deletion", "follow_up_issue_publication", "ui_evidence_approval",
    "question", "tool_approval", "policy_ask"] } };
  assert.equal(campaignWorkflowOwner(everything, HUMAN_ONLY_PARENT_CONTROL_POLICY, "review_round_extension", true), "human");
  assert.equal(campaignWorkflowOwner(everything, granted, "review_round_extension", true), "orchestrator");
  assert.equal(campaignWorkflowOwner(undefined, granted, "review_round_extension", true), "orchestrator");
  assert.equal(campaignWorkflowOwner(everything, granted, "review_round_extension", false), "human", "an unsupported provider stays human");
  const snapshot: WorkflowDecisionResourceSnapshot = {
    category: "review_round_extension", repository: "picoduck/wollipog", pullRequest: 7, epoch: 1, headSha: "a".repeat(40),
    roundsUsed: 4, blockingFindings: 2, extraRounds: 2, reason: "Two blockers left, both small.",
  };
  const resolve = (decisions: typeof granted, root = false) => resolveCampaignAuthority({
    control: everything, parentControl: "questions_and_approvals", decisions, root, supported: true, snapshot,
    trustedSource: "workflow_route",
  }).owner;
  assert.equal(resolve(HUMAN_ONLY_PARENT_CONTROL_POLICY), "human", "Full Control does not take it on its own");
  assert.equal(resolve(granted), "orchestrator", "an explicit grant delegates it");
  assert.equal(resolve(granted, true), "human", "a root's own request stays with a person");
});
