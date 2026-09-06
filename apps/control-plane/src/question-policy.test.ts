import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentQuestion, GovernancePolicy, SessionView } from "@wollipog/protocol";
import { canMutateQuestionPolicy, questionPatternMatches, questionPolicyAnswers } from "./question-policy.js";
import { evaluateApprovalPolicies, validateGovernancePolicy } from "./policy-engine.js";

const owner = { userId: "alice", organizationId: "org" };
const session = { runnerId: "runner", workspaceId: "workspace", agentId: "agent" } as SessionView;
const question: AgentQuestion = { id: "q", header: "Review", question: "May I send this diff for review?", options: [{ label: "Yes" }, { label: "No" }], allowOther: true };
const policy: GovernancePolicy = { policyId: "review", name: "Review", ownerUserId: "alice", scope: { organizationId: "org" }, enabled: true, effect: "allow", priority: 0,
  questionRule: { questionPattern: "*send*diff*review?", answer: { option: "Yes" } }, createdAt: 1, updatedAt: 1 };

test("policy mutations require the owner and cannot be spoofed by changing the rule kind or owner", () => {
  assert.equal(canMutateQuestionPolicy(undefined, policy, "alice"), true);
  assert.equal(canMutateQuestionPolicy(undefined, policy, "bob"), false);
  assert.equal(canMutateQuestionPolicy(policy, { ...policy, ownerUserId: "bob" }, "bob"), false);
  assert.equal(canMutateQuestionPolicy(policy, { ...policy, questionRule: undefined }, "bob"), false);
  assert.equal(canMutateQuestionPolicy(policy, undefined, undefined), false);
  assert.equal(canMutateQuestionPolicy(policy, undefined, "bob"), false);
  assert.equal(canMutateQuestionPolicy(policy, undefined, "alice"), true);
});

test("question patterns are anchored, case-insensitive literals with bounded wildcard matching", () => {
  assert.equal(questionPatternMatches("Review?", "review?"), true);
  assert.equal(questionPatternMatches("ReviewX", "review?"), false);
  assert.equal(questionPatternMatches("May I send this diff for review?", "*send*diff*review?"), true);
  assert.equal(questionPatternMatches("a".repeat(32000), "*a*a*a*a*a*a*a*b"), false);
  assert.equal(questionPatternMatches("abc", "ab*bc"), false);
});

test("question policies resolve complete validated forms only for their owner", () => {
  assert.equal(questionPolicyAnswers([question], [policy], owner, session)?.answers.q, "Yes");
  for (const other of [{ ...owner, userId: "bob" }, { ...owner, organizationId: "other" }, null]) {
    assert.equal(questionPolicyAnswers([question], [policy], other, session), null);
  }
  for (const q of [{ ...question, question: "Merge now?" }, { ...question, secret: true }, { ...question, options: [] }]) {
    assert.equal(questionPolicyAnswers([q], [policy], owner, session), null);
  }
  assert.equal(questionPolicyAnswers([question, { ...question, id: "other", question: "Merge?" }], [policy], owner, session), null);
  assert.equal(questionPolicyAnswers([question], [{ ...policy, enabled: false }], owner, session), null);
  const text = { ...policy, questionRule: { headerPattern: "review", answer: { text: "Proceed" } } };
  assert.equal(questionPolicyAnswers([question], [text], owner, session)?.answers.q, "Proceed");
  assert.equal(questionPolicyAnswers([{ ...question, allowOther: false }], [text], owner, session), null);
  assert.deepEqual(questionPolicyAnswers([{ ...question, multiSelect: true, allowOther: false }], [policy], owner, session)?.answers.q, ["Yes"]);
});

test("starter categories cannot approve protected actions mixed into any question or option", () => {
  const starter = { ...policy, questionRule: { ...policy.questionRule!, starterCategory: "review" as const } };
  assert.ok(questionPolicyAnswers([question], [starter], owner, session));
  for (const suffix of ["and merge it", "and delete the branch", "and publish an issue", "and create a GitHub issue", "and deploy it"]) {
    const composite = { ...question, question: `May I send this diff for review ${suffix}?` };
    assert.equal(questionPolicyAnswers([composite], [starter], owner, session), null);
    assert.equal(questionPolicyAnswers([{ ...question, options: [{ label: "Yes", description: suffix }] }], [starter], owner, session), null);
  }
  assert.equal(questionPolicyAnswers([{ ...question, question: "May I send this diff for review?", context: "Merge afterward" }], [starter], owner, session), null);
});

test("question policy validation fails closed and question rules cannot grant command approvals", () => {
  const { createdAt, updatedAt, ...input } = policy;
  assert.equal(validateGovernancePolicy(input), null);
  assert.match(validateGovernancePolicy({ ...input, ownerUserId: undefined })!, /ownerUserId/);
  assert.match(validateGovernancePolicy({ ...input, questionRule: { questionPattern: "*", answer: { option: "Yes" } } })!, /literal/);
  assert.equal(evaluateApprovalPolicies({ scope: { organizationId: "org" }, status: "running", costUsd: 0, toolCallCount: 0, escalated: false }, [policy]).policy, null);
});
