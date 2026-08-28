import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalForDecision,
  budgetDecision,
  conductorSafetyPolicy,
  evaluateApprovalPolicies,
  evaluateHookApprovalPolicies,
  evaluatePolicies,
  firstAsk,
  networkPatternMatches,
  pathPatternMatches,
  parsePolicyHookRequest,
  rulesFromSession,
  scopePatternMatches,
  validateGovernancePolicy,
  type PolicyInput,
} from "./policy-engine.js";
import type { GovernancePolicy } from "@wollipog/protocol";

const running = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  status: "running",
  costUsd: 0,
  toolCallCount: 0,
  ...over,
});

test("rulesFromSession: builds rules only for armed guardrails, in cost-first order", () => {
  assert.deepEqual(rulesFromSession({}), []);
  assert.deepEqual(rulesFromSession({ costBudgetUsd: null, maxToolCalls: null }), []);
  assert.deepEqual(rulesFromSession({ costBudgetUsd: 0, maxToolCalls: -1 }), []);
  assert.deepEqual(rulesFromSession({ costBudgetUsd: 5 }), [{ kind: "cost_budget", budgetUsd: 5 }]);
  assert.deepEqual(rulesFromSession({ maxToolCalls: 10 }), [{ kind: "max_tool_calls", maxCalls: 10 }]);
  assert.deepEqual(rulesFromSession({ costBudgetUsd: 5, maxToolCalls: 10 }), [
    { kind: "cost_budget", budgetUsd: 5 },
    { kind: "max_tool_calls", maxCalls: 10 },
  ]);
});

test("evaluatePolicies: cost_budget asks at/over the budget, ok below", () => {
  const rules = rulesFromSession({ costBudgetUsd: 5 });
  assert.equal(evaluatePolicies(running({ costUsd: 4.99 }), rules)[0]!.decision, "ok");
  assert.equal(evaluatePolicies(running({ costUsd: 5 }), rules)[0]!.decision, "ask"); // >= triggers
  const over = evaluatePolicies(running({ costUsd: 6 }), rules)[0]!;
  assert.equal(over.decision, "ask");
  assert.equal(over.title, "Cost budget reached — $6.00 of $5.00. Continue?"); // shipped Phase 7 copy, verbatim
});

test("evaluatePolicies: max_tool_calls asks at/over the limit, ok below", () => {
  const rules = rulesFromSession({ maxToolCalls: 3 });
  assert.equal(evaluatePolicies(running({ toolCallCount: 2 }), rules)[0]!.decision, "ok");
  const at = evaluatePolicies(running({ toolCallCount: 3 }), rules)[0]!;
  assert.equal(at.decision, "ask");
  assert.equal(at.title, "Tool-call limit reached — 3 of 3 tool calls. Continue?");
});

test("evaluatePolicies: terminal status never asks", () => {
  const rules = rulesFromSession({ costBudgetUsd: 5, maxToolCalls: 3 });
  const decisions = evaluatePolicies({ status: "completed", costUsd: 100, toolCallCount: 100 }, rules);
  assert.ok(decisions.every((d) => d.decision === "ok"));
});

test("budgetDecision delegate matches evaluatePolicies for the cost rule", () => {
  assert.equal(budgetDecision(6, 5, "running"), "ask");
  assert.equal(budgetDecision(5, 5, "running"), "ask");
  assert.equal(budgetDecision(4.99, 5, "running"), "ok");
  assert.equal(budgetDecision(100, null, "running"), "ok");
  assert.equal(budgetDecision(100, 0, "running"), "ok");
  assert.equal(budgetDecision(100, 5, "completed"), "ok");
});

test("firstAsk: ask beats ok; cost_budget wins the slot when both trip", () => {
  const rules = rulesFromSession({ costBudgetUsd: 5, maxToolCalls: 3 });
  const both = evaluatePolicies(running({ costUsd: 6, toolCallCount: 5 }), rules);
  assert.equal(firstAsk(both)!.rule.kind, "cost_budget");
  const onlyTools = evaluatePolicies(running({ costUsd: 1, toolCallCount: 5 }), rules);
  assert.equal(firstAsk(onlyTools)!.rule.kind, "max_tool_calls");
  const none = evaluatePolicies(running(), rules);
  assert.equal(firstAsk(none), null);
});

test("approvalForDecision: kind, requestId prefix, and the Continue/Stop options", () => {
  const [cost] = evaluatePolicies(running({ costUsd: 6 }), rulesFromSession({ costBudgetUsd: 5 }));
  const a = approvalForDecision(cost!, "s1", 123);
  assert.equal(a.kind, "cost_budget");
  assert.equal(a.requestId, "cost-budget:s1:123");
  assert.deepEqual(
    a.options.map((o) => [o.optionId, o.name, o.kind]),
    [
      ["continue", "Continue", "allow_once"],
      ["cancel", "Stop", "reject_once"],
    ],
  );
  const [tools] = evaluatePolicies(running({ toolCallCount: 3 }), rulesFromSession({ maxToolCalls: 3 }));
  const b = approvalForDecision(tools!, "s1", 456);
  assert.equal(b.kind, "max_tool_calls");
  assert.equal(b.requestId, "max-tool-calls:s1:456");
  assert.match(b.title, /Tool-call limit reached/);
});

const storedPolicy = (over: Partial<GovernancePolicy> = {}): GovernancePolicy => ({
  policyId: "policy-1",
  name: "Scoped policy",
  effect: "allow",
  priority: 10,
  enabled: true,
  scope: { organizationId: "local", agentId: "agent1" },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const approvalInput = (over: Partial<import("./policy-engine.js").ApprovalPolicyInput> = {}) => ({
  scope: {
    sessionId: "s1",
    organizationId: "local",
    runnerId: "r1",
    workspaceId: "w1",
    agentId: "agent1",
    toolName: "Bash",
    path: "/repo/src/a.ts",
    network: "api.example.com",
    branch: "feature/x",
  },
  status: "running" as const,
  costUsd: 4,
  toolCallCount: 3,
  escalated: true,
  ...over,
});

test("scoped approval policies match every governance dimension and stateful condition", () => {
  const policy = storedPolicy({
    scope: {
      organizationId: "local",
      runnerId: "r1",
      workspaceId: "w1",
      agentId: "agent1",
      toolName: "B*",
      path: "/repo/src/*",
      network: "*.example.com",
      branch: "feature/*",
    },
    conditions: { statuses: ["running"], minCostUsd: 2, maxCostUsd: 5, minToolCalls: 2, maxToolCalls: 4 },
  });
  assert.equal(evaluateApprovalPolicies(approvalInput(), [policy]).effect, "allow");
  assert.equal(evaluateApprovalPolicies(approvalInput({ costUsd: 6 }), [policy]).effect, "ask");
  assert.equal(evaluateApprovalPolicies(approvalInput({ scope: { ...approvalInput().scope, branch: "main" } }), [policy]).effect, "ask");
});

test("policy precedence is priority first, then deny > ask > allow, with stable match provenance", () => {
  const allow = storedPolicy({ policyId: "allow", effect: "allow", priority: 5 });
  const ask = storedPolicy({ policyId: "ask", effect: "ask", priority: 5 });
  const deny = storedPolicy({ policyId: "deny", effect: "deny", priority: 5 });
  let decision = evaluateApprovalPolicies(approvalInput(), [allow, ask, deny]);
  assert.equal(decision.policy?.policyId, "deny");
  assert.deepEqual(decision.matchedPolicyIds, ["deny", "ask", "allow"]);
  decision = evaluateApprovalPolicies(approvalInput(), [deny, storedPolicy({ policyId: "high-allow", priority: 6 })]);
  assert.equal(decision.policy?.policyId, "high-allow");
});

test("hook policy transport defers to provider on no match but preserves explicit policy effects", () => {
  assert.equal(evaluateApprovalPolicies(approvalInput(), []).effect, "ask", "interactive baseline is unchanged");
  assert.equal(evaluateHookApprovalPolicies(approvalInput(), []).effect, "defer");
  assert.equal(evaluateHookApprovalPolicies(
    approvalInput(),
    [storedPolicy({ policyId: "deny-hook", effect: "deny" })],
  ).effect, "deny");
});

test("hook request parser accepts only bounded content-minimized selector context", () => {
  assert.deepEqual(parsePolicyHookRequest({
    hookEventName: "PreToolUse",
    providerSessionId: "provider-1",
    permissionMode: "plan",
    toolUseId: "tool-1",
    context: { toolName: "Read", path: "/repo/a.ts" },
    transportRecoveredFrom: 123,
  }), {
    ok: true,
    value: {
      hookEventName: "PreToolUse",
      providerSessionId: "provider-1",
      permissionMode: "plan",
      toolUseId: "tool-1",
      context: { toolName: "Read", path: "/repo/a.ts" },
      transportRecoveredFrom: 123,
    },
  });
  assert.equal(parsePolicyHookRequest({
    hookEventName: "PreToolUse",
    providerSessionId: "provider-1",
    context: { toolName: "Read", rawInput: "secret" },
  }).ok, false);
  assert.equal(parsePolicyHookRequest({
    hookEventName: "Unknown",
    providerSessionId: "provider-1",
  }).ok, false);

  const valid = {
    hookEventName: "PreToolUse",
    providerSessionId: "provider-1",
  };
  for (const { name, input, error } of [
    {
      name: "non-object request",
      input: null,
      error: "policy hook request must be an object",
    },
    {
      name: "empty provider session id",
      input: { ...valid, providerSessionId: "" },
      error: "providerSessionId must be a bounded non-empty string",
    },
    {
      name: "257-character provider session id",
      input: { ...valid, providerSessionId: "p".repeat(257) },
      error: "providerSessionId must be a bounded non-empty string",
    },
    {
      name: "65-character permission mode",
      input: { ...valid, permissionMode: "p".repeat(65) },
      error: "permissionMode must be a bounded non-empty string",
    },
    {
      name: "negative recovery sequence",
      input: { ...valid, transportRecoveredFrom: -1 },
      error: "transportRecoveredFrom must be a non-negative safe integer",
    },
    {
      name: "non-integer recovery sequence",
      input: { ...valid, transportRecoveredFrom: 1.5 },
      error: "transportRecoveredFrom must be a non-negative safe integer",
    },
    {
      name: "non-object context",
      input: { ...valid, context: [] },
      error: "policy hook context must be an object",
    },
    {
      name: "4097-character context path",
      input: { ...valid, context: { path: "p".repeat(4097) } },
      error: "policy hook context path is invalid",
    },
    {
      name: "NUL-bearing context path",
      input: { ...valid, context: { path: "/repo/a\0b" } },
      error: "policy hook context path is invalid",
    },
  ] satisfies Array<{ name: string; input: unknown; error: string }>) {
    assert.deepEqual(parsePolicyHookRequest(input), { ok: false, error }, name);
  }
});

test("declarative conductor safety policy outranks mutable auto-allow policies", () => {
  const input = approvalInput({ scope: { ...approvalInput().scope, agentId: "conductor" } });
  const decision = evaluateApprovalPolicies(input, [storedPolicy({ priority: 100_000 }), conductorSafetyPolicy()]);
  assert.equal(decision.effect, "ask");
  assert.equal(decision.policy?.policyId, "builtin:conductor-human-gate");
});

test("scope matching is exact unless '*' is explicit; missing context fails closed", () => {
  assert.equal(scopePatternMatches("/repo-safe/file", "/repo-safe/*"), true);
  assert.equal(scopePatternMatches("/repo-safe-evil/file", "/repo-safe/*"), false);
  assert.equal(scopePatternMatches("main", "main"), true);
  assert.equal(scopePatternMatches(undefined, "*"), false);
});

test("path matching canonicalizes traversal and requires explicit recursive '**'", () => {
  assert.equal(pathPatternMatches("/repo/src/a.ts", "/repo/*"), false);
  assert.equal(pathPatternMatches("/repo/src/a.ts", "/repo/**"), true);
  assert.equal(pathPatternMatches("/repo/../../etc/shadow", "/repo/**"), false);
  assert.equal(pathPatternMatches("C:\\Repo\\src\\a.ts", "C:\\repo\\**"), true);
});

test("network matching parses host/userinfo instead of matching opaque URL text", () => {
  assert.equal(networkPatternMatches("https://api.example.com/v1", "*.example.com"), true);
  assert.equal(networkPatternMatches("https://api.example.com/v1", "https://api.example.com/*"), true);
  assert.equal(networkPatternMatches("https://api.example.com@evil.com/v1", "*.example.com"), false);
  assert.equal(networkPatternMatches("https://api.example.com@evil.com/v1", "evil.com"), false);
});

test("policy validation rejects typo-broadened scopes, unknown conditions, and builtin ids", () => {
  const valid = storedPolicy();
  const input = { ...valid, createdAt: undefined, updatedAt: undefined } as unknown as Parameters<typeof validateGovernancePolicy>[0];
  delete (input as unknown as Record<string, unknown>).createdAt;
  delete (input as unknown as Record<string, unknown>).updatedAt;
  assert.equal(validateGovernancePolicy(input), null);
  assert.match(validateGovernancePolicy({ ...input, scope: { workspaceID: "w1" } } as never)!, /scope contains/);
  assert.match(validateGovernancePolicy({ ...input, conditions: { minimumCost: 1 } } as never)!, /conditions contains/);
  assert.match(validateGovernancePolicy({ ...input, policyId: "builtin:escape" })!, /non-builtin/);
  assert.match(validateGovernancePolicy({ ...input, scope: { organizationId: "local" } })!, /narrower than organization/);
  assert.match(validateGovernancePolicy({ ...input, scope: { path: "/repo/../etc" } })!, /cannot contain/);
  assert.match(validateGovernancePolicy({ ...input, scope: { network: "https://good.example@evil.example/*" } })!, /credential-free/);
  assert.match(validateGovernancePolicy({ ...input, conditions: { escalated: true } })!, /runner-asserted/);
  assert.equal(validateGovernancePolicy({ ...input, effect: "ask", askTimeout: 30 }), null);
  assert.match(validateGovernancePolicy({ ...input, effect: "ask", askTimeout: 0 })!, /askTimeout/);
  assert.match(validateGovernancePolicy({ ...input, effect: "deny", askTimeout: 30 })!, /only valid/);
});
