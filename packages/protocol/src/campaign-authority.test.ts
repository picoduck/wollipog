import assert from "node:assert/strict";
import { test } from "node:test";
import {
  campaignAuthorityPreflight, campaignCodeOperationTargets, campaignWorkflowOwner, completeParentControlDecisions,
  resolveCampaignAuthority, validCampaignControl,
  fullControlStandingHumanRequired, humanRequiredRulesExist, FULL_CONTROL_DECLINED_CLASSES, type GovernancePolicy,
  HUMAN_ONLY_PARENT_CONTROL_POLICY, type CampaignControl, type ParentControlDecisionPolicy, type PendingApproval, type WorkflowDecisionResourceSnapshot,
} from "./index.js";

const control: CampaignControl = { mode: "full_control", boundary: {
  version: 1, revision: 2, issueScopeRevision: 1, repository: "picoduck/wollipog", objective: "Implement approved issues",
  authorizedByUserId: "human", authorizedAt: 1,
  operations: ["implementation_question", "question", "tool_approval", "policy_ask", "pr_merge"], delegatablePolicyIds: ["review-tools"],
} };
const base = { control, parentControl: "off" as const, decisions: HUMAN_ONLY_PARENT_CONTROL_POLICY, root: false, supported: true };
test("automation creation always stays human-owned even under Full Control or an unsupported peer", () => {
  for (const root of [true, false]) for (const supported of [true, false]) {
    const result = resolveCampaignAuthority({ ...base, root, supported, snapshot: {
      category: "automation_creation", spec: {} as never, targetDigest: "a".repeat(64), requestedSpecDigest: "b".repeat(64),
      effectiveTargets: [],
      nextFireAt: 1, expiresAt: 2,
    }, trustedSource: "workflow_route" });
    assert.equal(result.owner, "human");
    assert.equal(result.basis, "human_required");
  }
});
const question = (text: string, extra: Partial<PendingApproval> = {}): PendingApproval => ({
  requestId: "q", kind: "question", title: text, options: [], requestSource: "provider_question",
  questions: [{ id: "choice", question: text, options: [{ label: "A" }, { label: "B" }] }], ...extra,
});
/** A v230 runner's attestation that every resolved target is inside the session worktree `/repo`. */
const containment = { version: 1 as const, root: "/repo", sessionRoot: "/repo" };
const tool: PendingApproval = { requestId: "p", kind: "permission", title: "Inspect Repository", requestSource: "provider_tool",
  context: { toolName: "commandExecution", input: "cat src/implementation.ts", operation: { kind: "command", input: "cat src/implementation.ts", cwd: "/repo", filesystem: { cwd: "/repo", targets: [{ path: "src/implementation.ts", resolvedPath: "/repo/src/implementation.ts" }], containment } } }, options: [
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

test("older-runner preflight refusals use the shared sentence and return the versions beside it (#3803)", () => {
  const older = (error: string, requiredRunnerProtocolVersion: number, runnerProtocolVersion: number | null) =>
    ({ supported: false, reason: error, requirement: { error, requiredRunnerProtocolVersion, runnerProtocolVersion } });
  const evidence = "This machine needs a newer runner for production evidence authority. Update and restart the runner.";
  assert.deepEqual(campaignAuthorityPreflight(mediaControl, "codex-app-server", 222), older(evidence, 223, 222));
  assert.deepEqual(campaignAuthorityPreflight(mediaControl, "codex-app-server", null), older(evidence, 223, null));
  assert.deepEqual(campaignAuthorityPreflight(mediaControl, "codex-app-server", 223), { supported: false,
    reason: "Production evidence authority requires the exact private media contract; compatibility metadata does not establish runtime readiness." },
  "a current runner without the private contract is not told to update");
  const budgetControl: CampaignControl = { ...control, boundary: { ...control.boundary, budgetAuthority: { version: 1,
    accounting: "managed_workers_only", unpriced: "stop", toolCalls: 10, concurrency: 1 } } };
  assert.ok(validCampaignControl(budgetControl));
  assert.deepEqual(campaignAuthorityPreflight(budgetControl, "codex-app-server", 217),
    older("This machine needs a newer runner for campaign limits. Update and restart the runner.", 218, 217));
  assert.deepEqual(campaignAuthorityPreflight(budgetControl, "codex-app-server", 218), { supported: true });
});

test("Full Control planning uses trusted provenance; Custom preserves keyword-based protection", () => {
  for (const text of ["Which authentication library should we implement?", "Should the OAuth flow use PKCE?",
    "Which validation test should use sample@example.com?", "Which approach should the login component use?",
    "Which API key schema should the component implement?", "Which password hashing algorithm should the component use?"]) {
    assert.equal(evaluate(question(text)).owner, "orchestrator", text);
    const unverified = evaluate(question(text), { trustedSource: undefined });
    assert.ok(unverified.owner === "orchestrator" && (unverified.disposition === "decline" || unverified.requestClass === "unverified_tool_effects"), text);
  }
  assert.equal(evaluate(question("Which authentication library should we implement?"), {
    control: undefined, parentControl: "questions",
  }).owner, "human");
  assert.equal(evaluate(question("Which architecture?"), { control: undefined, parentControl: "questions" }).owner, "orchestrator");
  assert.equal(evaluate(question("Which architecture?"), { root: true, control: undefined, parentControl: "questions" }).owner, "human");
  assert.equal(evaluate(question("Which architecture?"), { root: true }).basis, "standing_authorization");
});

const declined = (result: ReturnType<typeof evaluate>, requestClass: string, label = requestClass) => {
  assert.equal(result.owner, "orchestrator", label);
  assert.equal(result.basis, "standing_decline", label);
  assert.equal(result.disposition, "decline", label);
  assert.equal(result.requestClass, requestClass, label);
};
/** A plain decline: the effect could not be resolved to explicit targets, so nothing is blocked work. */
const unresolved = (result: ReturnType<typeof evaluate>, requestClass: string | undefined, label = String(requestClass)) => {
  assert.equal(result.owner, "orchestrator", label);
  assert.equal(result.basis, "standing_decline", label);
  assert.equal(result.reason, "unresolved_effects", label);
  assert.equal(result.disposition, "decline", label);
  assert.equal(result.requestClass, requestClass, label);
  assert.ok(!FULL_CONTROL_DECLINED_CLASSES.has(result.requestClass as never), label);
};
const decided = (result: ReturnType<typeof evaluate>, requestClass: string | undefined, basis = "campaign_delegation", label = String(requestClass)) => {
  assert.equal(result.owner, "orchestrator", label);
  assert.equal(result.basis, basis, label);
  assert.equal(result.disposition, undefined, label);
  assert.equal(result.requestClass, requestClass, label);
};

test("Full Control declines credentials, sign-in and access enlargement; nobody is asked and nobody can approve them", () => {
  for (const text of ["Paste the API key for the implementation test", "What is your password for the mock feature?",
    "Which production access token should the design use?", "Should I sign in for the OAuth flow?",
    "Grant access to implement the feature", "Enter secret value here", "Please share database credentials for the test",
    "Which credentials?", "Read ~/.ssh/id_rsa to implement the test", "Which password should I use?",
    "Which API key should I use?", "Which credentials should we use to implement the feature?", "What password will the app use?"]) {
    for (const root of [false, true]) declined(evaluate(question(text), { root }), "secrets_and_sign_in", text);
  }
  declined(evaluate(question("Which approach?", { questions: [{ id: "q", question: "Which approach?", secret: true, options: [] }] })), "secrets_and_sign_in");
  declined(evaluate(question("Which validation?", { questions: [{ id: "q", question: "Which validation?", inputFormat: "email", options: [] }] })), "secrets_and_sign_in");
  declined(evaluate({ ...tool, kind: "authentication" }), "secrets_and_sign_in");
  declined(evaluate({ ...tool, context: { input: "cat .env" } }), "secrets_and_sign_in");
  declined(evaluate({ ...tool, context: { ...tool.context, network: "api.example.com" } }), "provider_access_expansion");
  declined(evaluate({ ...tool, context: { ...tool.context, providerPermissionExpansion: true } }), "provider_access_expansion");
  // Credential text wins over every other class, even with an escalation or a policy ask.
  declined(evaluate({ ...tool, governancePolicyId: "other", context: { input: "cat .env", escalatedBy: { kind: "agent", id: "guardian" } } }), "secrets_and_sign_in");
  // Typed implementation questions about credentials are declined too.
  const snapshot = { category: "implementation_question" as const, question: "Which API key should I use?", options: [{ optionId: "a", label: "A" }, { optionId: "b", label: "B" }] };
  declined(resolveCampaignAuthority({ ...base, snapshot, trustedSource: "workflow_route" }), "secrets_and_sign_in");
});

test("a persistent grant is never converted to anything but a one-time Orchestrator allow, and a grant offering none is declined", () => {
  decided(evaluate(tool), undefined);
  assert.ok(tool.options.some((o) => o.kind === "allow_always"), "the fixture offers a persistent option the Orchestrator cannot pick");
  declined(evaluate({ ...tool, options: tool.options.filter((o) => o.kind === "allow_always") }), "persistent_permissions");
  declined(evaluate({ ...tool, options: tool.options.filter((o) => o.kind === "allow_always") }, { root: true }), "persistent_permissions");
  declined(evaluate({ ...tool, context: { toolName: "permissions", operation: { kind: "permission_grant", lifetime: "session" } } }), "persistent_permissions");
});

test("the Orchestrator decides elicitations, unverified provenance, escalations and root forms; a parked root declines what it cannot verify", () => {
  decided(evaluate(question("Which design?"), { trustedSource: "provider_elicitation" }), "external_elicitation");
  declined(evaluate(question("Which design?"), { trustedSource: "provider_elicitation", root: true }), "external_elicitation");
  decided(evaluate(question("Which design?"), { trustedSource: "provider_tool" }), "unverified_tool_effects");
  decided(evaluate(question("Which design?"), { trustedSource: undefined }), "unverified_tool_effects");
  const escalated = { ...tool, context: { ...tool.context, escalatedBy: { kind: "agent" as const, id: "guardian" } } };
  decided(evaluate(escalated), "unverified_tool_effects");
  declined(evaluate(escalated, { root: true }), "unverified_tool_effects");
  const free = question("Which design?", { questions: [{ id: "q", question: "Which design?", options: [] }] });
  decided(evaluate(free), undefined);
  declined(evaluate(free, { root: true }), "root_forms_without_suggested_answers");
  assert.equal(evaluate(question("Which architecture?"), { root: true }).basis, "standing_authorization", "a suggested answer is still applied");
});

test("ordinary ask rules left undelegated go to the Orchestrator; Human Required and built-in rules and guardrails stay human", () => {
  decided(evaluate({ ...tool, governancePolicyId: "review-tools" }), undefined);
  decided(evaluate({ ...tool, governancePolicyId: "other" }), "undelegated_policy_asks");
  declined(evaluate({ ...tool, governancePolicyId: "other" }, { root: true }), "undelegated_policy_asks", "a parked root never self-approves an ask a person wanted checked");
  decided(evaluate({ ...tool, governancePolicyId: "review-tools" }, { root: true }), undefined, "standing_authorization", "an explicitly delegated ask on a verified effect is allowed once");
  declined(evaluate(question("Which design?", { context: { network: "api.example.com" } })), "provider_access_expansion", "envelope facts apply to forms too");
  decided(evaluate(question("Which design?", { context: { escalatedBy: { kind: "agent", id: "guardian" } } })), "unverified_tool_effects");
  const rule = evaluate({ ...tool, governancePolicyId: "review-tools" }, { humanRequired: true });
  assert.deepEqual([rule.owner, rule.reason, rule.requestClass], ["human", "human_required_rule", "human_required_rules"]);
  assert.equal(evaluate({ ...tool, kind: "cost_budget" }).owner, "human");
  assert.equal(evaluate({ ...tool, runnerGuardrail: { tripId: "t", kind: "max_tool_calls", threshold: 1, observed: 2 } }).owner, "human");
  const hook: PendingApproval = { requestId: "h", occurrenceId: "policy_hook_h", kind: "policy_hook", title: "Bash requires approval.", governancePolicyId: "other",
    context: { toolName: "Bash", operation: { kind: "command", input: "pnpm test", cwd: "/repo" } },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] };
  // A hook ask on a command with no resolved targets is declined for both; with targets it is decided.
  unresolved(evaluate(hook), "script_execution_without_bounded_effect_proof");
  unresolved(evaluate(hook, { root: true }), "script_execution_without_bounded_effect_proof");
  // A fully resolved target outside the session worktree is never approvable either.
  const resolvedHook: PendingApproval = { ...hook, context: { toolName: "Bash", operation: { kind: "command", input: "cat /notes/plan.md", cwd: "/repo",
    filesystem: { cwd: "/repo", targets: [{ path: "/notes/plan.md", resolvedPath: "/notes/plan.md" }] } } } };
  for (const root of [false, true]) unresolved(evaluate(resolvedHook, { root }), "script_execution_without_bounded_effect_proof");
});

test("verified repository code inspection is independent of authentication keywords; actual secret access is declined", () => {
  for (const input of ["cat apps/control-plane/src/auth.ts", "cat src/authentication.ts", "cat src/password.ts"]) {
    const request = { ...tool, context: { toolName: "commandExecution", input,
      operation: { kind: "command" as const, input, cwd: "/repo", filesystem: { cwd: "/repo", targets: [{ path: input.split(" ").at(-1)!, resolvedPath: `/repo/${input.split(" ").at(-1)!}` }], containment } } } };
    decided(evaluate(request, { repositoryRoot: "/repo" }), undefined, "campaign_delegation", input);
    // Outside the workspace the authentication word is no longer verified code: it is declined.
    declined(evaluate(request, { repositoryRoot: "/other" }), "secrets_and_sign_in", input);
  }
  for (const input of ["cat .env", "cat ~/.ssh/id_rsa", "cat /outside/auth.ts", "cat ../auth.ts", "gh auth login",
    "cat src/authentication.ts; cat .env", "cat $(cat src/authentication.ts)", "chmod 777 src/auth.ts"]) {
    for (const root of [false, true]) declined(evaluate({ ...tool, context: { toolName: "commandExecution", input,
      operation: { kind: "command", input, cwd: "/repo" } } }, { repositoryRoot: "/repo", root }), "secrets_and_sign_in", input);
  }
  decided(evaluate({ ...tool, context: { toolName: "Edit", path: "/repo/src/authentication.ts",
    operation: { kind: "file", path: "/repo/src/authentication.ts", filesystem: { targets: [{ path: "/repo/src/authentication.ts", resolvedPath: "/repo/src/authentication.ts" }], containment } } } }, { repositoryRoot: "/repo" }), undefined);
});

test("absent evidence is not evidence of absence: globs, scripts and missing operations are declined for root and child", () => {
  for (const path of ["src/*.ts", "src/?ink.ts", "src/[ab].ts", "src/{a,b}.ts", "~fixture.ts", "#fixture.ts", "!fixture.ts"]) {
    const input = `cat ${path}`;
    const operation = { kind: "command" as const, input, cwd: "/repo", filesystem: { cwd: "/repo", targets: [{ path, resolvedPath: `/repo/${path}` }] } };
    assert.equal(campaignCodeOperationTargets("commandExecution", operation), null, path);
    for (const root of [false, true]) unresolved(evaluate({ ...tool, context: { ...tool.context, input, operation } }, { root }), "script_execution_without_bounded_effect_proof", path);
  }
  unresolved(evaluate({ ...tool, context: { ...tool.context, operation: undefined } }), "unverified_tool_effects");
  unresolved(evaluate({ ...tool, context: { toolName: "Bash", input: "pnpm test", operation: { kind: "command", input: "pnpm test" } } }),
    "relative_shell_commands_without_verified_cwd");
  for (const input of ["python3 -c \"print(open('x').read())\"", "node scripts/build.mjs", "sh -c 'cat src/a.ts'", "pnpm test"]) {
    unresolved(evaluate({ ...tool, context: { toolName: "Bash", input, operation: { kind: "command", input, cwd: "/repo" } } }),
      "script_execution_without_bounded_effect_proof", input);
  }
  // A relative target needs the runner's matching cwd; a claimed target alone resolves nothing.
  unresolved(evaluate({ ...tool, context: { toolName: "commandExecution", input: "cat notes.md", operation: { kind: "command", input: "cat notes.md", cwd: "/elsewhere",
    filesystem: { cwd: "/repo", targets: [{ path: "notes.md", resolvedPath: "/repo/notes.md" }] } } } }), "script_execution_without_bounded_effect_proof");
});

test("Git commands are never bounded effects and never resolvable: declined for root and child", () => {
  for (const input of ["git status --short", "git diff -- src/implementation.ts", "git diff --cached -- src/implementation.ts",
    "git -C /repo status --porcelain", "git -c core.fsmonitor=false --no-pager diff --no-ext-diff --no-textconv -- src/implementation.ts",
    "git -c core.pager=cat status --short", "/usr/bin/git status --short", "env git status --short", "git show HEAD:src/implementation.ts"]) {
    const operation = { kind: "command" as const, input, cwd: "/repo", filesystem: { cwd: "/repo",
      targets: input.includes("status") ? [] : [{ path: "src/implementation.ts", resolvedPath: "/repo/src/implementation.ts" }] } };
    assert.equal(campaignCodeOperationTargets("commandExecution", operation), null, input);
    for (const root of [false, true]) unresolved(evaluate({ ...tool, context: { ...tool.context, input, operation } }, { root }), "git_execution_without_bounded_effect_proof", input);
  }
});

test("a benign name resolving into a credential store is declined for root and child, never decided", () => {
  for (const resolvedPath of ["/home/u/.codex/auth.json", "/home/u/.claude/.credentials.json", "/home/u/.ssh/id_ed25519", "/repo/.env.local", "/home/u/.aws/credentials",
    "/home/u/.config/gh/hosts.yml", "/home/u/.config/gcloud/application_default_credentials.json", "/home/u/.kube/config", "/home/u/.pgpass",
    "/home/u/.gnupg/private-keys-v1.d/key.key", "/home/u/.password-store/site.gpg", "/home/u/.azure/msal_token_cache.json",
    "/home/u/.terraform.d/credentials.tfrc.json", "/home/u/.config/op/config", "/home/u/.git-credentials", "/home/u/.netrc",
    "/home/u/.local/share/keyrings/login.keyring", "/Users/u/Library/Keychains/login.keychain-db", "/home/u/.docker/config.json",
    "/srv/accounts/codex-b/auth.json", "/srv/accounts/claude-a/.credentials.json", "/home/u/.claude.json"]) {
    const operation = { kind: "command" as const, input: "cat src/authentication.ts", cwd: "/repo",
      filesystem: { cwd: "/repo", targets: [{ path: "src/authentication.ts", resolvedPath }] } };
    for (const root of [false, true]) declined(evaluate({ ...tool, context: { ...tool.context, input: operation.input, operation } }, { root }), "secrets_and_sign_in", resolvedPath);
  }
  declined(evaluate({ ...tool, context: { toolName: "Bash", input: "less ~/.claude/settings.json", operation: { kind: "command", input: "less ~/.claude/settings.json", cwd: "/repo" } } }), "secrets_and_sign_in");
  // The review's exact case: a fully resolved GitHub CLI credential file is never decided.
  const gh = "/home/u/.config/gh/hosts.yml";
  declined(evaluate({ ...tool, context: { toolName: "commandExecution", input: `cat ${gh}`, operation: { kind: "command", input: `cat ${gh}`, cwd: "/repo",
    filesystem: { cwd: "/repo", targets: [{ path: gh, resolvedPath: gh }] } } } }), "secrets_and_sign_in");
  // A worktree file merely named like a store's contents is an ordinary decision.
  const view = "/repo/src/credentialsView.tsx";
  decided(evaluate({ ...tool, context: { toolName: "commandExecution", input: `cat ${view}`, operation: { kind: "command", input: `cat ${view}`, cwd: "/repo",
    filesystem: { cwd: "/repo", targets: [{ path: view, resolvedPath: view }], containment } } } }), undefined);
});

test("the worktree allowlist: only runner-attested containment in this session's worktree is approvable (#2940)", () => {
  const withEvidence = (filesystem: NonNullable<NonNullable<NonNullable<PendingApproval["context"]>["operation"]>["filesystem"]>) =>
    ({ ...tool, context: { ...tool.context, operation: { kind: "command" as const, input: "cat src/implementation.ts", cwd: "/repo", filesystem } } });
  const targets = [{ path: "src/implementation.ts", resolvedPath: "/repo/src/implementation.ts" }];
  decided(evaluate(withEvidence({ cwd: "/repo", targets, containment })), undefined);
  // v228-style evidence: complete and inside the repository, but with no containment attestation.
  for (const root of [false, true]) unresolved(evaluate(withEvidence({ cwd: "/repo", targets }), { root }), undefined, `v228 evidence, root=${root}`);
  // Another session's worktree, a claim that disagrees with its own targets, or a missing root fail.
  unresolved(evaluate(withEvidence({ cwd: "/repo", targets, containment: { ...containment, sessionRoot: "/other" } })), undefined, "another worktree");
  unresolved(evaluate(withEvidence({ cwd: "/repo", targets: [{ path: "src/implementation.ts", resolvedPath: "/vault/provider-state.bin" }], containment })),
    "script_execution_without_bounded_effect_proof");
  unresolved(evaluate(withEvidence({ cwd: "/repo", targets, containment }), { repositoryRoot: undefined }), "script_execution_without_bounded_effect_proof");
  unresolved(evaluate(withEvidence({ cwd: "/elsewhere", targets, containment })), "script_execution_without_bounded_effect_proof");
});

test("Custom is unchanged: every reclassified class keeps its Custom owner", () => {
  const custom = { control: { mode: "custom" as const } };
  for (const request of [question("Which API key should I use?"), { ...tool, kind: "authentication" as const },
    { ...tool, options: tool.options.filter((o) => o.kind === "allow_always") }, { ...tool, governancePolicyId: "other" },
    { ...tool, context: { ...tool.context, escalatedBy: { kind: "agent" as const, id: "guardian" } } }]) {
    const result = evaluate(request, custom);
    assert.equal(result.owner, "human");
    assert.equal(result.basis, "custom_policy");
    assert.equal(result.requestClass, undefined);
    assert.equal(result.disposition, undefined);
  }
  assert.equal(evaluate(question("Which architecture?"), { ...custom, parentControl: "questions" }).owner, "orchestrator");
});

test("only rules a person marked Human Required stay listed, and only while one exists", () => {
  assert.deepEqual(fullControlStandingHumanRequired(false), []);
  assert.deepEqual(fullControlStandingHumanRequired(true), ["human_required_rules"]);
  const rule = (extra: Partial<GovernancePolicy>): GovernancePolicy => ({ policyId: "p", name: "P", effect: "ask", priority: 1, enabled: true,
    scope: {}, createdAt: 1, updatedAt: 1, ...extra });
  assert.equal(humanRequiredRulesExist([rule({})]), false, "an ordinary ask is decided by the Orchestrator");
  assert.equal(humanRequiredRulesExist([rule({ conditions: { humanRequired: true } })]), true);
  assert.equal(humanRequiredRulesExist([rule({ conditions: { humanRequired: true }, enabled: false })]), false);
  assert.equal(humanRequiredRulesExist([rule({ conditions: { humanRequired: true }, builtin: true })]), false);
  assert.ok(FULL_CONTROL_DECLINED_CLASSES.has("secrets_and_sign_in") && FULL_CONTROL_DECLINED_CLASSES.has("provider_access_expansion") &&
    FULL_CONTROL_DECLINED_CLASSES.has("persistent_permissions") && FULL_CONTROL_DECLINED_CLASSES.size === 3);
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
  const resolve = (decisions: ParentControlDecisionPolicy, root = false) => resolveCampaignAuthority({
    control: everything, parentControl: "questions_and_approvals", decisions, root, supported: true, snapshot,
    trustedSource: "workflow_route",
  }).owner;
  assert.equal(resolve(HUMAN_ONLY_PARENT_CONTROL_POLICY), "human", "Full Control does not take it on its own");
  assert.equal(resolve(granted), "orchestrator", "an explicit grant delegates it");
  assert.equal(resolve(granted, true), "human", "a root's own request stays with a person");
});
