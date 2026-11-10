import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, isOwnerQuestionRequest, normalizeCampaignIssueScopeSnapshot, normalizeScopeProposalInput,
  initialScopeRepositoryLimits, presentOwnerQuestionRequest, runnerSupportsProtocol, scopeProposalAnswer, scopeProposalChecks, scopeProposalRepositoryConstraints, scopeProposalRepositoryLimits, validScopeProposal,
  type CampaignScopeProposal, type PendingApproval, type WorkflowDecisionView,
} from "./index.js";

const additions = [{ repository: "Owner/Repo", number: 12 }, { repository: "owner/repo", number: 13 }];
const input = (overrides: Record<string, unknown> = {}) => ({
  issues: [{ repository: "owner/repo", number: 12, origin: "owner_named", rationale: " The owner\nnames #12. " },
    { repository: "OWNER/repo", number: 13, origin: "owner_named", rationale: "Named too." }],
  requestedCount: null, constraints: [], withheldOperations: [], ...overrides,
});

test("v308 adds structured scope proposals (#4282)", () => {
  assert.ok(PROTOCOL_VERSION >= 308);
  assert.equal(RUNNER_CAPABILITY_MIN_PROTOCOL.campaignScopeProposals, 308);
  assert.equal(runnerSupportsProtocol(307, "campaignScopeProposals"), false);
  assert.equal(runnerSupportsProtocol(308, "campaignScopeProposals"), true);
});

test("only server-derived exact owner-named limits may omit the repository judgment (#4402)", () => {
  const record = { initial: true, messageDigest: "a".repeat(64), issues: [{ number: 12, origin: "owner_named", rationale: "r", title: "" }],
    requestedCount: null, constraints: [], withheldOperations: [], checks: [], route: "admitted",
    repositoryConstraints: [{ name: "owner/repo", repository: "owner/repo" }], repositoryLimitVerified: true };
  assert.equal(validScopeProposal(record), true);
  for (const extra of [{ initial: false }, { repositoryLimitVerified: false }, { repositoryConstraints: [] },
    { repositoryConstraints: [{ name: "repo", repository: null }] }, { issues: [{ ...record.issues[0], origin: "orchestrator_chosen" }] }]) {
    assert.equal(validScopeProposal({ ...record, ...extra }), false);
  }
  assert.match(normalizeScopeProposalInput(input({ repositoryLimitVerified: true }), additions) as string, /unknown field/u);
  assert.equal(runnerSupportsProtocol(345, "exactNamedRepositoryScope"), false);
  assert.equal(runnerSupportsProtocol(346, "exactNamedRepositoryScope"), true);
});

test("a proposal must list exactly its additions, each once, with an origin and a rationale; text is only trimmed (#4282)", () => {
  const normalized = normalizeScopeProposalInput(input(), additions);
  assert.notEqual(typeof normalized, "string");
  assert.deepEqual(normalized, { issues: [
    { repository: "owner/repo", number: 12, origin: "owner_named", rationale: "The owner names #12." },
    { repository: "owner/repo", number: 13, origin: "owner_named", rationale: "Named too." }],
  requestedCount: null, constraints: [], withheldOperations: [] });
  for (const [bad, pattern] of [
    [input({ issues: [input().issues[0]] }), /exactly the additions/u],
    [input({ issues: [input().issues[0], input().issues[0]] }), /exactly the additions/u],
    [input({ issues: [{ ...input().issues[0], origin: "named" }, input().issues[1]] }), /origin/u],
    [input({ issues: [{ ...input().issues[0], rationale: " " }, input().issues[1]] }), /rationale/u],
    [input({ issues: [{ ...input().issues[0], rationale: "x".repeat(501) }, input().issues[1]] }), /rationale/u],
    [input({ requestedCount: 0 }), /requestedCount/u],
    [input({ constraints: Array.from({ length: 11 }, () => "open") }), /constraints/u],
    [input({ withheldOperations: ["deploy"] }), /withheldOperations/u],
    [input({ grantedOperations: ["pr_merge"] }), /unknown field/u],
  ] as const) assert.match(normalizeScopeProposalInput(bad, additions) as string, pattern);
});

test("a recorded repository name that resolved to nothing is always the owner's (#4118)", () => {
  const base = { initial: true, messageDigest: "a".repeat(64), issues: [{ repository: "owner/api", number: 1, origin: "orchestrator_chosen", rationale: "r", title: "" }],
    requestedCount: null, constraints: [], withheldOperations: [], ownerMessage: "Fix the top bug in the repo." };
  const unresolved = { ...base, repositoryConstraint: { name: "repo", repository: null }, checks: ["chosen_issues", "repository_name_unresolved"] };
  assert.equal(validScopeProposal({ ...unresolved, route: "owner", ownerCause: "repository_name_unresolved" }), true);
  assert.equal(validScopeProposal({ ...unresolved, route: "admitted", ownerMessage: undefined, ownerCause: undefined,
    constraintCheck: { occurrenceId: "dec_1", verdict: "admit" } }), false, "no check can admit a name that means nothing");
  assert.equal(validScopeProposal({ ...unresolved, checks: ["chosen_issues"], route: "owner", ownerCause: "constraint_check_unavailable" }), false, "the record and its check agree");
  assert.equal(validScopeProposal({ ...base, repositoryConstraint: { name: "the api repo", repository: "owner/api" }, checks: ["chosen_issues", "repository_limit"], route: "owner",
    ownerCause: "constraint_check_unavailable" }), true);
  assert.equal(validScopeProposal({ ...base, repositoryConstraint: { name: "the api repo", repository: "not a repository" }, checks: ["chosen_issues", "repository_limit"], route: "owner",
    ownerCause: "constraint_check_unavailable" }), false);
  // A name that matched one repository is the agent's claim of a limit, so it is always checked.
  const claimed = { ...base, repositoryConstraint: { name: "the api repo", repository: "owner/api" }, route: "admitted", ownerMessage: undefined };
  assert.equal(validScopeProposal({ ...claimed, checks: [] }), false, "never the no-model path");
  assert.equal(validScopeProposal({ ...claimed, checks: ["repository_limit"] }), false, "only a check's admit admits it");
  assert.equal(validScopeProposal({ ...claimed, checks: ["repository_limit"], constraintCheck: { occurrenceId: "dec_1", verdict: "admit" } }), true);
  assert.equal(validScopeProposal({ ...base, checks: ["chosen_issues", "repository_limit"], route: "owner", ownerCause: "constraint_check_unavailable" }), false, "the check needs a limit to judge");
  assert.equal(validScopeProposal({ ...base, issues: [{ ...base.issues[0], repository: "not a repository" }], checks: ["chosen_issues"], route: "owner", ownerCause: "constraint_check_unavailable" }), false);
  const additions = [{ repository: "owner/api", number: 1 }];
  const input = { issues: [{ repository: "OWNER/API", number: 1, origin: "owner_named", rationale: "r" }], requestedCount: null, constraints: [], withheldOperations: [] };
  assert.deepEqual((normalizeScopeProposalInput({ ...input, repositoryName: "  the  api repo " }, additions) as { repositoryNames: string[] }).repositoryNames, ["the api repo"], "an older runner's one name reads as a one-entry list");
  assert.match(normalizeScopeProposalInput({ ...input, repositoryName: " " }, additions) as string, /repositoryNames/u);
  assert.match(normalizeScopeProposalInput({ ...input, repositoryName: "x".repeat(201) }, additions) as string, /repositoryNames/u);
});

test("a repository limit is a list: a record with one name reads as one entry, and a partly resolved list limits nothing (#4117)", () => {
  const additions = [{ repository: "owner/api", number: 1 }];
  const input = { issues: [{ repository: "owner/api", number: 1, origin: "owner_named", rationale: "r" }], requestedCount: null, constraints: [], withheldOperations: [] };
  assert.deepEqual((normalizeScopeProposalInput({ ...input, repositoryNames: [" the  api repo", "web", "web"] }, additions) as { repositoryNames: string[] }).repositoryNames, ["the api repo", "web"]);
  for (const repositoryNames of [[], [" "], "web", Array.from({ length: 11 }, (_, index) => `repo ${index}`)]) {
    assert.match(normalizeScopeProposalInput({ ...input, repositoryNames }, additions) as string, /repositoryNames/u);
  }
  assert.match(normalizeScopeProposalInput({ ...input, repositoryName: "web", repositoryNames: ["web"] }, additions) as string, /repositoryNames/u);

  const one = { name: "the api repo", repository: "owner/api" };
  assert.deepEqual(scopeProposalRepositoryConstraints({ repositoryConstraint: one }), [one]);
  assert.deepEqual(scopeProposalRepositoryLimits({ repositoryConstraint: one }), ["owner/api"]);
  assert.deepEqual(scopeProposalRepositoryLimits({ repositoryConstraints: [one, { name: "api", repository: "owner/api" }, { name: "web", repository: "owner/web" }] }), ["owner/api", "owner/web"]);
  assert.deepEqual(scopeProposalRepositoryLimits({ repositoryConstraints: [one, { name: "web", repository: null }] }), [], "no part of it applies");
  assert.deepEqual(scopeProposalRepositoryLimits({}), []);
  assert.deepEqual(initialScopeRepositoryLimits({ repositoryLimit: "owner/api" }), ["owner/api"]);
  assert.deepEqual(initialScopeRepositoryLimits({ repositoryLimits: ["owner/api", "owner/web"] }), ["owner/api", "owner/web"]);
  assert.deepEqual(initialScopeRepositoryLimits(undefined), []);

  const base = { initial: true, messageDigest: "a".repeat(64), issues: [{ repository: "owner/api", number: 1, origin: "orchestrator_chosen", rationale: "r", title: "" }],
    requestedCount: null, constraints: [], withheldOperations: [], ownerMessage: "Fix the api and web repos." };
  const owner = { route: "owner", ownerCause: "constraint_check_unavailable" };
  assert.equal(validScopeProposal({ ...base, ...owner, repositoryConstraints: [one, { name: "web", repository: "owner/web" }], checks: ["chosen_issues", "repository_limit"] }), true);
  const partly = { ...base, repositoryConstraints: [one, { name: "web", repository: null }] };
  assert.equal(validScopeProposal({ ...partly, route: "owner", ownerCause: "repository_name_unresolved", checks: ["chosen_issues", "repository_name_unresolved"] }), true);
  assert.equal(validScopeProposal({ ...partly, ...owner, checks: ["chosen_issues", "repository_limit"] }), false, "a partly resolved list is never judged as a limit");
  assert.equal(validScopeProposal({ ...partly, route: "owner", ownerCause: "repository_name_unresolved", checks: ["chosen_issues", "repository_name_unresolved", "repository_limit"] }), false);
  assert.equal(validScopeProposal({ ...base, ...owner, repositoryConstraints: [], checks: ["chosen_issues"] }), false);
  assert.equal(validScopeProposal({ ...base, ...owner, repositoryConstraint: one, repositoryConstraints: [one], checks: ["chosen_issues", "repository_limit"] }), false, "one shape per record");
  assert.equal(validScopeProposal({ ...base, ...owner, checks: ["chosen_issues", "repository_mentioned"] }), true);
});

test("only owner-named issues with nothing else stated take the no-model fast path; ranking is never a check (#4282)", () => {
  const issue = (origin: "owner_named" | "orchestrator_chosen") => ({ repository: "owner/repo", number: 1, origin, rationale: "r" });
  const base = { issues: [issue("owner_named")], requestedCount: null, constraints: [], withheldOperations: [] };
  const reference = (number: number, repository = "owner/repo") => ({ repository, number });
  const referenced = [reference(1)];
  assert.deepEqual(scopeProposalChecks(base, referenced), []);
  // The same number in another repository is another issue (#4118).
  assert.deepEqual(scopeProposalChecks(base, [reference(1), reference(1, "owner/api")]), ["unproposed_references"]);
  assert.deepEqual(scopeProposalChecks(base, [reference(1, "owner/api")]), ["unreferenced_named_issues", "unproposed_references"]);
  assert.deepEqual(scopeProposalChecks({ ...base, issues: [{ ...issue("owner_named"), repository: "OWNER/API" }] }, [reference(1, "owner/api")]), []);
  assert.deepEqual(scopeProposalChecks({ ...base, requestedCount: 1 }, referenced), [], "a count that is exactly the named issues needs no check");
  assert.deepEqual(scopeProposalChecks({ ...base, requestedCount: 2 }, referenced), ["requested_count"]);
  // A referenced issue the proposal chose rather than marked owner-named still needs the named-or-mentioned check.
  assert.deepEqual(scopeProposalChecks({ ...base, issues: [issue("orchestrator_chosen")] }, referenced), ["chosen_issues", "unproposed_references"]);
  assert.deepEqual(scopeProposalChecks({ ...base, issues: [issue("orchestrator_chosen")], requestedCount: 1 }, referenced),
    ["chosen_issues", "unproposed_references", "requested_count"]);
  // "See #7 for background; fix #8": proposing only #8 leaves #7 to the check, which decides whether it was asked for.
  assert.deepEqual(scopeProposalChecks({ ...base, issues: [{ ...issue("owner_named"), number: 8 }] }, [reference(7), reference(8)]), ["unproposed_references"]);
  assert.deepEqual(scopeProposalChecks({ ...base, constraints: ["open"] }, referenced), ["constraints"]);
  assert.deepEqual(scopeProposalChecks({ ...base, withheldOperations: ["pr_merge"] }, referenced), ["withheld_operations"]);
  assert.deepEqual(scopeProposalChecks({ ...base, issues: [] }, []), [], "a task that needs no issues");
  // An owner-named number the message writes only as a plain number ("fix 1 bug") is not the fast path's.
  assert.deepEqual(scopeProposalChecks(base, []), ["unreferenced_named_issues"]);
  assert.deepEqual(scopeProposalChecks({ ...base, issues: [issue("orchestrator_chosen")] }, []), ["chosen_issues"],
    "the reference list only concerns issues marked owner-named");
});

const record: CampaignScopeProposal = { initial: true, messageDigest: "a".repeat(64), requestedCount: 2, constraints: ["open"],
  withheldOperations: ["pr_merge"], checks: ["chosen_issues", "constraints", "withheld_operations"], route: "owner",
  ownerCause: "constraint_check_unavailable", ownerMessage: "Fix #12 and one open bug, but don't merge.",
  issues: [{ number: 12, origin: "owner_named", rationale: "Named.", title: "Crash" }, { number: 31, origin: "orchestrator_chosen", rationale: "Top label.", title: "Sync" }] };

test("a recorded proposal is exact: only an admitted one carries an admission, and only an initial one may add nothing (#4282)", () => {
  assert.equal(validScopeProposal(record), true);
  assert.equal(validScopeProposal({ ...record, route: "admitted" }), false, "an admitted proposal has nothing left to check");
  assert.equal(validScopeProposal({ ...record, extra: true }), false);
  assert.equal(validScopeProposal({ ...record, ownerCause: undefined }), false);
  // A constraint check's admit is the only way past the floors for a proposal with anything checkable,
  // and an owner route names its check's outcome exactly.
  const admittedByCheck = { ...record, route: "admitted", ownerCause: undefined, ownerMessage: undefined,
    constraintCheck: { occurrenceId: "dec_1", verdict: "admit", reason: "Every answer is satisfied with at least 80% confidence." } };
  delete (admittedByCheck as Partial<CampaignScopeProposal>).ownerCause; delete (admittedByCheck as Partial<CampaignScopeProposal>).ownerMessage;
  assert.equal(validScopeProposal(admittedByCheck), true);
  assert.equal(validScopeProposal({ ...admittedByCheck, constraintCheck: { occurrenceId: "dec_1", verdict: "uncertain" } }), false);
  assert.equal(validScopeProposal({ ...record, ownerCause: "constraint_check_uncertain", constraintCheck: { occurrenceId: "dec_1", verdict: "uncertain" } }), true);
  assert.equal(validScopeProposal({ ...record, ownerCause: "constraint_check_uncertain" }), false, "an uncertain route names its check");
  assert.equal(validScopeProposal({ ...record, ownerCause: "constraint_check_failed", constraintCheck: { occurrenceId: "dec_1", verdict: "uncertain" } }), false);
  assert.equal(validScopeProposal({ ...record, constraintCheck: { occurrenceId: "dec_1", verdict: "failed" } }), false,
    "a check that never ran names no outcome");
  assert.equal(validScopeProposal({ ...record, ownerCause: "constraint_check_failed", constraintCheck: { occurrenceId: "dec 1", verdict: "failed" } }), false);
  const snapshot = { category: "campaign_issue_scope", repository: "owner/repo", expectedRevision: 2, before: [], additions: [12, 31], removals: [],
    explanation: "Why.", affectedAssignments: [], affectedDecisions: [], activeChildren: [], scopeProposal: record };
  assert.ok(normalizeCampaignIssueScopeSnapshot(snapshot));
  assert.equal(normalizeCampaignIssueScopeSnapshot({ ...snapshot, issueAdmission: { boundaryRevision: 2, evidenceDigest: "b".repeat(64) } }), null,
    "the owner's approval never carries an admission");
  assert.equal(normalizeCampaignIssueScopeSnapshot({ ...snapshot, additions: [12] }), null, "its issues are exactly the additions");
  const admitted = { ...record, checks: [], route: "admitted", ownerCause: undefined, ownerMessage: undefined, issues: [] };
  delete (admitted as Partial<CampaignScopeProposal>).ownerCause; delete (admitted as Partial<CampaignScopeProposal>).ownerMessage;
  const empty = { ...snapshot, additions: [], scopeProposal: admitted, issueAdmission: { boundaryRevision: 2, evidenceDigest: "b".repeat(64) } };
  assert.ok(normalizeCampaignIssueScopeSnapshot(empty), "an initial proposal may add nothing");
  assert.equal(normalizeCampaignIssueScopeSnapshot({ ...empty, scopeProposal: { ...admitted, initial: false } }), null);
});

test("the owner's approval is presented as an Owner Question: Approve Scope, Decline Scope or their own words (#4282)", () => {
  const card = { requestId: "wd_1", kind: "workflow_decision", title: "Campaign Issue Scope", occurrenceId: "wd_1",
    workflowDecision: { authority: "human", resourceSnapshot: { category: "campaign_issue_scope", repository: "owner/repo", expectedRevision: 2,
      before: [], additions: [12, 31], removals: [], explanation: "Ranked by label.", affectedAssignments: [], affectedDecisions: [], activeChildren: [],
      scopeProposal: record } } as unknown as WorkflowDecisionView } as unknown as PendingApproval;
  assert.equal(isOwnerQuestionRequest(card), true);
  const shown = presentOwnerQuestionRequest(card);
  assert.equal(shown.kind, "question");
  assert.equal(shown.async, true);
  const [question] = shown.questions!;
  assert.equal(question!.question, "Approve the Orchestrator's proposed initial scope?");
  assert.deepEqual(question!.options.map((option) => option.label), ["Approve Scope", "Decline Scope"]);
  assert.equal(question!.allowOther, true);
  assert.match(question!.context!, /> Fix \\#12 and one open bug, but don't merge\./u);
  assert.match(question!.context!, /owner\/repo#31 Sync \(the Orchestrator chose it\): Top label\./u);
  // Operations read as the labels Campaign Status shows, never raw tokens.
  assert.match(question!.context!, /\*\*Withheld operations:\*\* PR Merge\n/u);
  assert.doesNotMatch(question!.context!, /pr_merge/u);
  assert.match(question!.context!, /because it includes issues the Orchestrator chose, constraints it read from your message and operations your message rules out, which no Decision Model has checked\./u);
  // An uncertain constraint check says so, with the server's reason.
  const uncertainCard = { ...card, workflowDecision: { ...card.workflowDecision!, resourceSnapshot: { ...card.workflowDecision!.resourceSnapshot,
    scopeProposal: { ...record, ownerCause: "constraint_check_uncertain", constraintCheck: { occurrenceId: "dec_1", verdict: "uncertain",
      reason: "The answer on 'Count Matches Your Message' is below the 80% confidence threshold." } } } } } as unknown as PendingApproval;
  assert.match(presentOwnerQuestionRequest(uncertainCard).questions![0]!.context!,
    /and the Decision Model couldn't confirm them \(The answer on 'Count Matches Your Message' is below the 80% confidence threshold\)\./u);
  // An admitted (Orchestrator-owned) change is never presented to the owner.
  const admitted = { ...card, workflowDecision: { ...card.workflowDecision!, authority: "orchestrator" } } as PendingApproval;
  assert.equal(isOwnerQuestionRequest(admitted), false);
  assert.equal(presentOwnerQuestionRequest(admitted), admitted);
  assert.deepEqual(scopeProposalAnswer({ scope_proposal_answer: "Approve Scope" }), { approve: true });
  assert.deepEqual(scopeProposalAnswer({ scope_proposal_answer: "Decline Scope" }), { approve: false });
  assert.deepEqual(scopeProposalAnswer({ scope_proposal_answer: "Approve, and also #40" }), { approve: false, text: "Approve, and also #40" },
    "words never approve or change the proposal");
  assert.equal(scopeProposalAnswer({}), null);
});

test("a scope proposal's question states the Maximum Issues increase the server derived, and only then (#4334)", () => {
  const snapshot = { category: "campaign_issue_scope" as const, repository: "owner/repo", expectedRevision: 2, before: [], additions: [31], removals: [],
    explanation: "Ranked by priority.", affectedAssignments: [], affectedDecisions: [], activeChildren: [],
    scopeProposal: { initial: true, messageDigest: "a".repeat(64), requestedCount: null, constraints: ["open"], withheldOperations: [], checks: ["constraints" as const],
      route: "owner" as const, ownerCause: "constraint_check_failed" as const, ownerMessage: "Fix one bug.",
      issues: [{ number: 31, origin: "orchestrator_chosen" as const, rationale: "Oldest." }] } };
  const card = (extra = {}) => ({ requestId: "wd_1", occurrenceId: "wd_1", kind: "workflow_decision" as const, title: "Scope", options: [],
    workflowDecision: { occurrenceId: "wd_1", authority: "human", resourceSnapshot: snapshot }, ...extra }) as unknown as PendingApproval;
  const raised = presentOwnerQuestionRequest(card({ scopeMaxIssuesIncrease: { from: 5, increase: 3 } })).questions![0]!.context!;
  assert.match(raised, /\*\*Maximum Issues:\*\* 5 to 8/u);
  assert.match(raised, /Approving admits exactly these issues and raises Maximum Issues from 5 to 8\./u);
  const plain = presentOwnerQuestionRequest(card()).questions![0]!.context!;
  assert.doesNotMatch(plain, /Maximum Issues/u);
});
