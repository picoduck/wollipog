import assert from "node:assert/strict";
import { test } from "node:test";
import {
  campaignAuthorityPreflight, resolveCampaignAuthority, validCampaignControl,
  HUMAN_ONLY_PARENT_CONTROL_POLICY, type CampaignControl, type PendingApproval,
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
  context: { toolName: "commandExecution", input: "git status --short", operation: { kind: "command", input: "git status --short", cwd: "/repo", filesystem: { cwd: "/repo", targets: [] } } }, options: [
    { optionId: "once", name: "Allow Once", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" },
  ] };
const evaluate = (request: PendingApproval, override: Partial<Parameters<typeof resolveCampaignAuthority>[0]> = {}) =>
  resolveCampaignAuthority({ ...base, request, trustedSource: request.requestSource, repositoryRoot: "/repo", ...override });

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
  for (const input of ["git diff -- apps/control-plane/src/auth.ts", "cat src/authentication.ts", "git diff -- src/password.ts"]) {
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
  assert.equal(validCampaignControl(control), true);
  for (const invalid of [null, {}, { mode: "full_control" }, { mode: "custom", boundary: {} },
    { ...control, boundary: { ...control.boundary, authorizedByUserId: "" } },
    { ...control, boundary: { ...control.boundary, operations: ["tool_approval", "tool_approval"] } }]) assert.equal(validCampaignControl(invalid), false);
});
