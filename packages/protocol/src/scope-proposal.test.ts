import assert from "node:assert/strict";
import test from "node:test";
import {
  PROTOCOL_VERSION, RUNNER_CAPABILITY_MIN_PROTOCOL, isOwnerQuestionRequest, normalizeCampaignIssueScopeSnapshot, normalizeScopeProposalInput,
  presentOwnerQuestionRequest, runnerSupportsProtocol, scopeProposalAnswer, scopeProposalChecks, validScopeProposal,
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

test("only owner-named issues with nothing else stated take the no-model fast path; ranking is never a check (#4282)", () => {
  const issue = (origin: "owner_named" | "orchestrator_chosen") => ({ repository: "owner/repo", number: 1, origin, rationale: "r" });
  const base = { issues: [issue("owner_named")], requestedCount: null, constraints: [], withheldOperations: [] };
  assert.deepEqual(scopeProposalChecks(base), []);
  assert.deepEqual(scopeProposalChecks({ ...base, requestedCount: 1 }), [], "a count that is exactly the named issues needs no check");
  assert.deepEqual(scopeProposalChecks({ ...base, requestedCount: 2 }), ["requested_count"]);
  assert.deepEqual(scopeProposalChecks({ ...base, issues: [issue("orchestrator_chosen")] }), ["chosen_issues"]);
  assert.deepEqual(scopeProposalChecks({ ...base, issues: [issue("orchestrator_chosen")], requestedCount: 1 }), ["chosen_issues", "requested_count"]);
  assert.deepEqual(scopeProposalChecks({ ...base, constraints: ["open"] }), ["constraints"]);
  assert.deepEqual(scopeProposalChecks({ ...base, withheldOperations: ["pr_merge"] }), ["withheld_operations"]);
  assert.deepEqual(scopeProposalChecks({ ...base, issues: [] }), [], "a task that needs no issues");
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
  assert.match(question!.context!, /\*\*Withheld operations:\*\* `pr_merge`/u);
  assert.match(question!.context!, /because it includes issues the Orchestrator chose, constraints it read from your message and operations your message rules out, which no Decision Model has checked\./u);
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
