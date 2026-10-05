import assert from "node:assert/strict";
import { test } from "node:test";
import type { GovernancePolicy } from "@wollipog/protocol";
import {
  formatAskTimeout,
  policyConditionPhrases,
  policyScopePhrase,
  questionRuleDescription,
  toolPolicies,
  toolPolicyMeta,
} from "./governance-policies.js";

function policy(overrides: Partial<GovernancePolicy> & Pick<GovernancePolicy, "policyId">): GovernancePolicy {
  return { name: overrides.policyId, effect: "allow", priority: 0, enabled: true, scope: {}, createdAt: 0, updatedAt: 0, ...overrides };
}

test("tool policies are listed in the order the control plane evaluates them, without question policies", () => {
  const ordered = toolPolicies([
    policy({ policyId: "b-allow", priority: 5 }),
    policy({ policyId: "a-allow", priority: 5 }),
    policy({ policyId: "ask", priority: 5, effect: "ask" }),
    policy({ policyId: "deny", priority: 5, effect: "deny" }),
    policy({ policyId: "low", priority: -1, effect: "deny" }),
    policy({ policyId: "high", priority: 9 }),
    policy({ policyId: "question", priority: 99, questionRule: { answer: { text: "Yes" } } }),
  ]);
  assert.deepEqual(ordered.map((entry) => entry.policyId), ["high", "deny", "ask", "a-allow", "b-allow", "low"]);
});

test("scope, conditions and timeouts read as label-prefixed meta in sentence case", () => {
  assert.equal(policyScopePhrase({}), "every machine");
  assert.equal(policyScopePhrase({ runnerId: "r", workspaceId: "w", agentId: "codex", path: "src/*", branch: "main", network: "x.internal" }),
    "one machine, one workspace, agent codex, path src/*, branch main, network x.internal");
  assert.equal(policyScopePhrase({ organizationId: "org-a" }), "every machine, one organization");
  assert.deepEqual(policyConditionPhrases({
    statuses: ["running", "input_required"], minCostUsd: 5, maxCostUsd: 0, minToolCalls: 1, maxToolCalls: 20, escalated: true,
  }), ["status running or input required", "cost at least $5.00", "cost at most $0.00", "at least 1 tool call", "at most 20 tool calls", "escalated"]);
  assert.deepEqual(policyConditionPhrases(undefined), []);
  assert.deepEqual([45, 60, 600, 90, 3_600, 5_400].map(formatAskTimeout), ["45 s", "1 min", "10 min", "1 min 30 s", "1 h", "1 h 30 min"]);
  assert.deepEqual(toolPolicyMeta(policy({
    policyId: "p", enabled: false, effect: "ask", askTimeout: 600, scope: { toolName: "Bash" }, conditions: { escalated: false },
  })), [
    { label: "State", value: "off" },
    { label: "Tool", value: "Bash" },
    { label: "Scope", value: "every machine" },
    { label: "Conditions", value: "not escalated" },
    { label: "Timeout", value: "10 min" },
  ]);
});

test("a custom question rule is described in one sentence", () => {
  assert.equal(questionRuleDescription({ questionPattern: "May I deploy*", answer: { option: "Yes" } }),
    "Chooses “Yes” when the question matches “May I deploy*”.");
  assert.equal(questionRuleDescription({ headerPattern: "Push", questionPattern: "*", answer: { text: "Go ahead." } }),
    "Replies “Go ahead.” when the header matches “Push” and the question matches “*”.");
  assert.equal(questionRuleDescription({ answer: { text: "Yes" } }), "Replies “Yes” to every question.");
});
