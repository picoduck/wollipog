import assert from "node:assert/strict";
import { test } from "node:test";
import {
  campaignAuthorityPreflight, campaignCodeOperationTargets, campaignWorkflowOwner, completeParentControlDecisions,
  resolveCampaignAuthority, validCampaignControl, credentialFormFloor, type CredentialScreenFact,
  fullControlStandingHumanRequired, humanRequiredRulesExist, FULL_CONTROL_DECLINED_CLASSES, type GovernancePolicy,
  fullControlAutomaticResponse, fullControlAutomaticResponseText, parseFullControlAutomaticResponse, FULL_CONTROL_ROOT_QUESTION_OWNER_ROUTE_MESSAGE,
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
/** A healthy Decision Model's screens (#4104), as the control plane attaches them. */
const discusses: CredentialScreenFact = { state: "discusses", occurrenceId: "dec_discusses", verdict: "discusses" };
const asks: CredentialScreenFact = { state: "ask", occurrenceId: "dec_ask", verdict: "ask" };
/** A provider question the Decision Model screened as only discussing its subject. Pass
 * `credentialScreen: undefined` for one not screened yet. */
const question = (text: string, extra: Partial<PendingApproval> = {}): PendingApproval => ({
  requestId: "q", kind: "question", title: text, options: [], requestSource: "provider_question",
  questions: [{ id: "choice", question: text, options: [{ label: "A" }, { label: "B" }] }], credentialScreen: discusses, ...extra,
});
/** A v230 runner's attestation that every resolved target is inside the session worktree `/repo`. */
const containment = { version: 1 as const, root: "/repo", sessionRoot: "/repo" };
const tool: PendingApproval = { requestId: "p", kind: "permission", title: "Inspect Repository", requestSource: "provider_tool",
  context: { toolName: "commandExecution", input: "cat src/implementation.ts", operation: { kind: "command", input: "cat src/implementation.ts", cwd: "/repo", filesystem: { cwd: "/repo", targets: [{ path: "src/implementation.ts", resolvedPath: "/repo/src/implementation.ts" }], containment } } }, options: [
    { optionId: "once", name: "Allow Once", kind: "allow_once" }, { optionId: "always", name: "Always", kind: "allow_always" },
  ], credentialScreen: discusses };
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

const typed = (snapshot: WorkflowDecisionResourceSnapshot, override: Partial<Parameters<typeof resolveCampaignAuthority>[0]> = {}) =>
  resolveCampaignAuthority({ ...base, snapshot, trustedSource: "workflow_route", ...override });
const form = (text: string, labels = ["Continue", "Stop"]): WorkflowDecisionResourceSnapshot => ({ category: "implementation_question",
  question: text, options: labels.map((label, index) => ({ optionId: `o${index}`, label })) });
/** Every question route with one screen: a child's provider question, the root's own question, and
 * the typed implementation question from a child and from the root. */
const onEveryRoute = (text: string, credentialScreen: CredentialScreenFact | undefined) => ({
  child: evaluate(question(text, { credentialScreen })),
  root: evaluate(question(text, { credentialScreen }), { root: true }),
  typed: typed(form(text), { credentialScreen }),
  rootTyped: typed(form(text), { root: true, credentialScreen }),
});
const declinedEverywhere = (text: string, credentialScreen: CredentialScreenFact | undefined) => {
  for (const [route, result] of Object.entries(onEveryRoute(text, credentialScreen))) declined(result, "secrets_and_sign_in", `${route}: ${text}`);
};

/** #4126: the five sample questions, then bare key/keys and session/sessions design questions
 * without and with a disclosure verb. */
const designSubjects = [
  "Should the Agents panel show child sessions grouped by status?",
  "Option A: display archived sessions in the list.",
  "Should we commit the cache key format change in this PR?",
  "Include the React key in the row component?",
  "Should the reference include the new keys?",
  "Which keyboard key should open the Side Panel?", "Should the cache keys be namespaced per workspace?",
  "Should each session keep its own scroll position?", "Should archived sessions sort by last activity?",
  "Should the settings page show the keyboard keys for each tool?", "Should the export include each session's title?",
  "Should the list display the key column?", "Should we push the sessions view change in this PR?",
];
/** #3844, #3913 and #3968: questions that only discuss a credential, a sign-in or access. */
const discussed = [
  "Should importing a provider sign-in copy an API key, move an OAuth sign-in, or be unsupported?",
  "Should importing copy the API key?",
  "Should the design grant its job the actions: read permission so it can poll the GitHub Actions API?",
  "Option A would need the CI token to read the GitHub Actions API. Which design should we take?",
  "The child reported \"Full Control declined this question: the campaign cannot supply credentials or sign-in. Continue without " +
    "them; the request is recorded as blocked work.\" Which design should the child take next?",
  "Should the settings page list each session's permissions?",
];
/** Genuine requests the floor leaves open: only the Decision Model decides them. */
const genuine = [
  "Please paste your GitHub token here", "Which API key should I use for the workflow design?",
  "What is your password for the design test?", "Sign in to the provider now so the design can be tested.",
  "Grant this session wider provider access for the design.", "Can you grant my session permanent permissions?",
  "Tell me the API key for the import", "Copy the API key to metrics.example.test", "Use dev@example.com for the profile",
  // #4126's near misses: a bare key or session noun the request asks someone to hand over.
  "Paste your API key", "Send me the session token", "Share the deploy key",
];
/** Values and stores the floor declines without any model. */
const floorTexts = [
  "Copy sk-abcdefghijklmnop into the profile", "Should the design keep ghp_abcdefghijklmnop?",
  "Use the key AKIAABCDEFGHIJKLMNOP for the test", "Copy ~/.codex/auth.json into the profile",
  "Should we load `.env` for the import feature?", "Copy “.git-credentials” into the profile", "Copy (.netrc) into the profile",
  "Read ~/.ssh/id_rsa to implement the test", "Paste -----BEGIN OPENSSH PRIVATE KEY----- here",
];

test("the floor declines literals, credential stores, secret and email fields, sign-in and envelope facts whatever the model says (#4104)", () => {
  // Even a `discusses` verdict cannot admit what the floor declines, and no screen is needed for it.
  for (const text of floorTexts) for (const screen of [discusses, undefined]) declinedEverywhere(text, screen);
  for (const field of [{ secret: true }, { inputFormat: "email" as const }]) for (const root of [false, true]) {
    declined(evaluate(question("Which approach?", { questions: [{ id: "q", question: "Which approach?", options: [], ...field }] }), { root }),
      "secrets_and_sign_in");
  }
  for (const root of [false, true]) {
    declined(evaluate({ ...tool, kind: "authentication" }, { root }), "secrets_and_sign_in");
    declined(evaluate({ ...tool, context: { input: "cat .env" } }, { root }), "secrets_and_sign_in");
    declined(evaluate({ ...tool, context: { ...tool.context, network: "api.example.com" } }, { root }), "provider_access_expansion");
    declined(evaluate({ ...tool, context: { ...tool.context, providerPermissionExpansion: true } }, { root }), "provider_access_expansion");
    declined(evaluate(question("Which design?", { context: { network: "api.example.com" } }), { root }), "provider_access_expansion");
  }
  declined(evaluate({ ...tool, context: { toolName: "permissions", operation: { kind: "permission_grant", lifetime: "session" } } }), "persistent_permissions");
  // Credential text wins over every other class, even with an escalation or a policy ask.
  declined(evaluate({ ...tool, governancePolicyId: "other", context: { input: "cat .env", escalatedBy: { kind: "agent", id: "guardian" } } }), "secrets_and_sign_in");
  assert.equal(evaluate({ ...tool, runnerGuardrail: { tripId: "t", kind: "max_tool_calls", threshold: 1, observed: 2 } }).owner, "human");
});

test("#4126's design questions and the #3844, #3913 and #3968 cases reach the Orchestrator with a healthy Decision Model", () => {
  for (const text of [...designSubjects, ...discussed]) {
    // Nothing in them is a floor fact: the Decision Model decides them.
    const unscreened = onEveryRoute(text, undefined);
    assert.equal(unscreened.child.reason, "credential_screen_pending", text);
    assert.equal(unscreened.root.reason, "credential_screen_pending", text);
    const routes = onEveryRoute(text, discusses);
    decided(routes.child, undefined, "campaign_delegation", `child: ${text}`);
    assert.deepEqual(routes.child.credentialScreen, discusses, "the verdict travels with the evaluation it affected");
    // A root's own question is dismissed as today; only its class depends on the verdict.
    declined(routes.root, "root_questions", `root: ${text}`);
    decided(routes.typed, undefined, "campaign_delegation", `typed: ${text}`);
    decided(routes.rootTyped, undefined, "standing_authorization", `root typed: ${text}`);
  }
});

test("model ask declines generic requests and holds typed questions for owner classification (#4542)", () => {
  for (const text of genuine) {
    const routes = onEveryRoute(text, undefined);
    assert.ok(routes.child.reason === "credential_screen_pending" && routes.child.disposition === undefined, `no word list declines: ${text}`);
    declined(evaluate(question(text, { credentialScreen: asks })), "secrets_and_sign_in");
    for (const root of [true, false]) {
      const held = typed(form(text), { root, credentialScreen: asks });
      assert.deepEqual([held.owner, held.reason, held.disposition], ["human", "credential_screen_review", undefined]);
      assert.equal(held.credentialScreen?.verdict, "ask");
    }
    assert.deepEqual(evaluate(question(text, { credentialScreen: asks })).credentialScreen, asks);
  }
  // A child's tool text that is not verified repository code is screened too; a root's is declined unscreened.
  const notes: PendingApproval = { ...tool, credentialScreen: undefined, context: { toolName: "commandExecution", input: "cat docs/notes.txt",
    operation: { kind: "command", input: "cat docs/notes.txt", cwd: "/repo", filesystem: { cwd: "/repo",
      targets: [{ path: "docs/notes.txt", resolvedPath: "/repo/docs/notes.txt" }], containment } } } };
  assert.equal(evaluate(notes).reason, "credential_screen_pending");
  declined(evaluate({ ...notes, credentialScreen: asks }), "secrets_and_sign_in");
  decided(evaluate({ ...notes, credentialScreen: discusses }), "script_execution_without_bounded_effect_proof");
  declined(evaluate(notes, { root: true }), "script_execution_without_bounded_effect_proof");
  // Verified repository code needs no screen at all.
  decided(evaluate({ ...tool, credentialScreen: undefined }), undefined);
});

test("nobody may answer a request before its screen settles; a failed or uncertain one is the owner's to classify (#4104)", () => {
  for (const text of [...genuine, ...designSubjects]) {
    const pending = evaluate(question(text, { credentialScreen: { state: "pending", occurrenceId: "dec_1" } }));
    assert.deepEqual([pending.owner, pending.reason, pending.disposition], ["orchestrator", "credential_screen_pending", undefined], text);
    for (const screen of [{ state: "review", occurrenceId: "dec_1", verdict: "uncertain" }, { state: "review", occurrenceId: "dec_1", failureClass: "timed_out" }] as CredentialScreenFact[]) {
      // Never a word list instead: a genuine request is not declined, and a design question is not admitted.
      const child = evaluate(question(text, { credentialScreen: screen }));
      assert.deepEqual([child.owner, child.basis, child.reason, child.disposition], ["human", "human_required", "credential_screen_review", undefined], text);
      assert.deepEqual(child.credentialScreen, screen);
      const typedReview = typed(form(text), { credentialScreen: screen });
      assert.deepEqual([typedReview.owner, typedReview.reason], ["human", "credential_screen_review"], text);
      // A root's question is dismissed without asking anyone, and never named a credential request.
      declined(evaluate(question(text, { credentialScreen: screen }), { root: true }), "root_questions", text);
    }
    // The owner's classification reads as the verdict it chose.
    declined(evaluate(question(text, { credentialScreen: { ...asks, classifiedBy: "owner" } })), "secrets_and_sign_in", text);
    decided(evaluate(question(text, { credentialScreen: { ...discusses, classifiedBy: "owner" } })), undefined, "campaign_delegation", text);
    // A typed question the route could not screen waits for its owner rather than reaching anyone.
    assert.equal(typed(form(text), { credentialScreen: { state: "pending" } }).owner, "human", text);
  }
  // Custom is unchanged: no screen, and its owner is the saved policy.
  assert.equal(typed(form(genuine[0]!), { control: { mode: "custom" } }).basis, "custom_policy");
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
  declined(evaluate(free, { root: true }), "root_questions");
  // A root's own question is dismissed even when it offers a choice: nobody else can answer it, and
  // applying an option would claim a decision no person made (#2940).
  declined(evaluate(question("Which architecture?"), { root: true }), "root_questions", "no option is applied for a root");
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
    // Outside the workspace it is no longer verified code, and no word screen stands in (#4104): its
    // unresolved effect is declined whatever it names.
    unresolved(evaluate(request, { repositoryRoot: "/other" }), "script_execution_without_bounded_effect_proof", input);
  }
  // A credential store is the floor's; every other unresolved command is declined as an unresolved effect.
  for (const input of ["cat .env", "cat ~/.ssh/id_rsa", "cat src/authentication.ts; cat .env"]) {
    for (const root of [false, true]) declined(evaluate({ ...tool, context: { toolName: "commandExecution", input,
      operation: { kind: "command", input, cwd: "/repo" } } }, { repositoryRoot: "/repo", root }), "secrets_and_sign_in", input);
  }
  for (const input of ["cat /outside/auth.ts", "cat ../auth.ts", "gh auth login", "cat $(cat src/authentication.ts)", "chmod 777 src/auth.ts"]) {
    for (const root of [false, true]) {
      const result = evaluate({ ...tool, context: { toolName: "commandExecution", input, operation: { kind: "command", input, cwd: "/repo" } } },
        { repositoryRoot: "/repo", root });
      assert.deepEqual([result.basis, result.reason, result.disposition], ["standing_decline", "unresolved_effects", "decline"], input);
    }
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
    assert.equal(campaignAuthorityPreflight(control, driver, null).supported, false);
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

test("Full Control owns extra review rounds within the server-enforced cap of a pull request, and only there (#4075)", () => {
  const snapshot: WorkflowDecisionResourceSnapshot = {
    category: "review_round_extension", repository: "picoduck/wollipog", pullRequest: 7, epoch: 1, headSha: "a".repeat(40),
    roundsUsed: 4, blockingFindings: 1, extraRounds: 1, reason: "One verified blocker, fixed.",
  };
  const resolve = (input: Partial<Parameters<typeof resolveCampaignAuthority>[0]>) => resolveCampaignAuthority({
    control, parentControl: "off", decisions: HUMAN_ONLY_PARENT_CONTROL_POLICY, root: false, supported: true, snapshot,
    trustedSource: "workflow_route", ...input,
  });
  const within = resolve({ reviewExtensionCap: "within" });
  assert.deepEqual([within.owner, within.basis, within.reason], ["orchestrator", "campaign_delegation", "authorized_operation"],
    "audited as the Orchestrator's own decision");
  assert.equal(within.boundaryRevision, control.boundary.revision);
  const past = resolve({ reviewExtensionCap: "exceeded" });
  assert.deepEqual([past.owner, past.reason], ["human", "review_extension_cap_reached"], "past the cap it is the person's");
  assert.equal(resolve({}).owner, "human", "without the server's cap fact (an older peer) it stays the person's");
  assert.equal(resolve({ reviewExtensionCap: "within", root: true }).owner, "human", "a root's own run stays the person's");
  assert.equal(resolve({ reviewExtensionCap: "within", control: { mode: "custom" } }).owner, "human", "Custom never takes it");
  assert.equal(resolve({ reviewExtensionCap: "within", supported: false }).owner, "human");
  assert.equal(resolve({ reviewExtensionCap: "within", trustedSource: undefined }).owner, "human");
  assert.equal(resolve({ reviewExtensionCap: "within", snapshot: { ...snapshot, repository: "other/repo" } }).owner, "human",
    "only the boundary's repository");
  // An explicit Parent Control grant keeps working, without the cap.
  assert.equal(resolve({ reviewExtensionCap: "exceeded", decisions: { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, review_round_extension: "orchestrator" } }).owner,
    "orchestrator");
  // The category projection follows the same rule: Orchestrator only when every peer supports the cap.
  assert.equal(campaignWorkflowOwner(control, HUMAN_ONLY_PARENT_CONTROL_POLICY, "review_round_extension", true, true), "orchestrator");
  assert.equal(campaignWorkflowOwner(control, HUMAN_ONLY_PARENT_CONTROL_POLICY, "review_round_extension", true, false), "human");
  assert.equal(campaignWorkflowOwner(control, HUMAN_ONLY_PARENT_CONTROL_POLICY, "review_round_extension", false, true), "human");
  assert.equal(campaignWorkflowOwner({ mode: "custom" }, HUMAN_ONLY_PARENT_CONTROL_POLICY, "review_round_extension", true, true), "human");
});

test("Full Control response attribution names only safe classes and never invents an automatic response (#4063)", () => {
  // A credential, access or lasting-grant decline gets the generic policy sentence, never its class.
  for (const requestClass of FULL_CONTROL_DECLINED_CLASSES) {
    const response = fullControlAutomaticResponse({ reason: "declined_request", requestClass });
    assert.deepEqual(response, { policy: "full_control" });
    for (const kind of ["question", "tool"] as const) {
      const text = fullControlAutomaticResponseText(kind, response);
      assert.match(text, /^\[Wollipog Full Control\] Wollipog (dismissed this question|declined this tool call) automatically under the campaign's Full Control policy\. No person saw it/);
      assert.doesNotMatch(text, /\buser\b|secret|sign-in|credential|access|grant/i);
    }
  }
  assert.deepEqual(fullControlAutomaticResponse({ reason: "authorized_operation", requestClass: "root_questions" }),
    { policy: "full_control", basis: "root_questions" });
  // The unresolved-effect rule refines whichever tool class it was declined under.
  assert.deepEqual(fullControlAutomaticResponse({ reason: "unresolved_effects", requestClass: "git_execution_without_bounded_effect_proof" }),
    { policy: "full_control", basis: "unresolved_effects" });
  assert.match(fullControlAutomaticResponseText("tool", { policy: "full_control", basis: "unresolved_effects" }),
    /could not resolve every file it would touch to a real path inside this session's worktree\. Retry with explicit file paths/);
  // A root's in-result text says Full Control dismissed it and names the owner-decision route (#4064):
  // only a runner new enough for the owner-decision tools receives the attribution.
  const rootText = fullControlAutomaticResponseText("question", { policy: "full_control", basis: "root_questions" });
  assert.match(rootText, /\(Root Questions\)\. No person saw it, and none of its options was chosen\. You own every Orchestrator-owned decision/);
  assert.match(rootText, /request_owner_decision/);
  assert.match(rootText, /hand_workflow_decision_to_owner/);
  assert.ok(rootText.endsWith(FULL_CONTROL_ROOT_QUESTION_OWNER_ROUTE_MESSAGE.slice(FULL_CONTROL_ROOT_QUESTION_OWNER_ROUTE_MESSAGE.indexOf("You own"))),
    "the in-result guidance is exactly the owner-route notice's guidance");
  // A runner claims an automatic response only as the server sent it.
  assert.equal(parseFullControlAutomaticResponse(undefined), undefined);
  assert.equal(parseFullControlAutomaticResponse({ policy: "person" }), undefined);
  assert.equal(parseFullControlAutomaticResponse([{ policy: "full_control" }]), undefined);
  assert.deepEqual(parseFullControlAutomaticResponse({ policy: "full_control", basis: "secrets_and_sign_in" }), { policy: "full_control" });
  assert.deepEqual(parseFullControlAutomaticResponse({ policy: "full_control", basis: "root_questions", extra: 1 }),
    { policy: "full_control", basis: "root_questions" });
});

test("an owner decision is the person's in every mode and to every requester (#4064)", () => {
  const snapshot: WorkflowDecisionResourceSnapshot = { category: "owner_decision", question: "Which merge order?",
    options: [{ optionId: "a", label: "A First" }, { optionId: "b", label: "B First" }] };
  for (const mode of [control, { mode: "custom" as const }, undefined]) for (const root of [true, false]) {
    for (const decisions of [HUMAN_ONLY_PARENT_CONTROL_POLICY, { ...HUMAN_ONLY_PARENT_CONTROL_POLICY, implementation_question: "orchestrator" as const }]) {
      const result = resolveCampaignAuthority({ ...base, control: mode, decisions, root, snapshot, trustedSource: "workflow_route" });
      assert.deepEqual([result.owner, result.basis, result.reason], ["human", "human_required", "owner_kept"]);
      assert.equal(campaignWorkflowOwner(mode, decisions, "owner_decision", true), "human");
    }
  }
});

test("an owner decision's floor declines a value or a credential store; the Decision Model decides the rest (#4064, #4104)", () => {
  const options = [{ optionId: "lease", label: "Short-Lived Lease" }, { optionId: "broker", label: "Broker Process" }];
  assert.equal(credentialFormFloor({ question: "Which credential design should the provider bridge use?", options,
    material: "PR https://github.com/picoduck/wollipog/pull/7 at head abc1234; both designs pass CI." }), false);
  assert.equal(credentialFormFloor({ question: "Please paste your API key here", options }), false, "the model's question, not the floor's");
  assert.equal(credentialFormFloor({ question: "Should the bridge keep sk-abcdefghijklmnop?", options }), true);
  assert.equal(credentialFormFloor({ question: "Which credential design should the provider bridge use?", options,
    material: "It reads ~/.codex/auth.json." }), true, "the material is floored too");
});

