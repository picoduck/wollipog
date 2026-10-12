import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, type SessionView } from "@wollipog/protocol";
import { fullControlPreflight } from "./full-control-preflight.js";

test("prepared mode cannot turn five delegated owners or an image declaration into readiness", () => {
  const defaults = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
  for (const category of Object.keys(defaults.delegation.decisions) as Array<keyof typeof defaults.delegation.decisions>) {
    defaults.delegation.decisions[category] = "orchestrator";
  }
  const session = { orchestratorCampaign: { uiEvidenceReview: { status: "available", effectiveOwner: "orchestrator" } } } as SessionView;
  for (const surface of ["defaults", "launch", "campaign"] as const) {
    const result = fullControlPreflight({ defaults, session, surface });
    assert.equal(result.supported, false);
    assert.equal(result.control, undefined);
    assert.match(result.blockers.join(" "), /actual media delivery or quality/);
    assert.equal(result.facts.find((fact) => fact.label === "Aggregate Allowance")?.value.startsWith("Not verified"), true);
  }
});

test("preflight retains the server-owned boundary and fixed choices without constructing authorization", () => {
  const defaults = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
  defaults.behavior.childHarness = { agentId: "codex-app", driver: "codex-app-server", context: { kind: "native" } };
  defaults.behavior.childModel = "gpt-6.1-sol";
  defaults.behavior.childEffort = "high";
  const control = { mode: "full_control" as const, boundary: {
    version: 1 as const, revision: 2, repository: "owner/repo", issueScopeRevision: 1,
    objective: "Implement #12", authorizedByUserId: "human", authorizedAt: 1,
    operations: ["pr_merge" as const], delegatablePolicyIds: [],
    // Evolving prerequisite subobjects must remain intact, never synthesized from display facts.
    issueAuthority: { marker: "original" }, budgetAuthority: { marker: "original" }, evidenceAuthority: { marker: "original" },
  } };
  const session = { driver: "codex-app-server", costBudgetUsd: 4, maxToolCalls: 80,
    orchestratorPolicy: { ...defaults, control, issueScope: { repository: "owner/repo", issueNumbers: [12], revision: 1 } },
  } as unknown as SessionView;
  const before = structuredClone(session);
  const result = fullControlPreflight({ defaults, session, surface: "campaign" });
  assert.equal(result.control, control);
  assert.deepEqual(session, before);
  const facts = Object.fromEntries(result.facts.map(({ label, value }) => [label, value]));
  assert.equal(facts.Repository, "owner/repo");
  assert.equal(facts.Objective, "Implement #12");
  assert.equal(facts["Issue Scope"], "#12 · Revision 1");
  assert.match(facts["Child Model and Effort"]!, /gpt-6.1-sol · High/);
  assert.match(facts["Session Ceilings"]!, /Cost: 4; tool calls: 80/);
  assert.match(facts["Permission Lifetime"]!, /for the session/);
  assert.equal(result.supported, false, "prepared subobjects are not readiness proof");
});

test("budget display separates immutable authority, original ceilings, generated allocation and reservations", () => {
  const budget = {
    authority: { costUsd: 100, toolCalls: 1000, concurrency: 4, acceptedFollowUps: 8 },
    sessionLimits: { costBudgetUsd: 5, maxToolCalls: 50 },
    rootAllocation: { costUsd: 30, toolCalls: 300 },
    actual: { costUsd: 12, toolCalls: 120 }, outstanding: { costUsd: 20, toolCalls: 200 },
    requiredNativeReview: { supported: true, reason: "Profile available" },
  };
  const before = structuredClone(budget);
  const result = fullControlPreflight({ surface: "campaign", defaults: DEFAULT_ORCHESTRATOR_DEFAULTS, budget });
  const facts = Object.fromEntries(result.facts.map(({ label, value }) => [label, value]));
  assert.match(facts["Aggregate Allowance"]!, /cost 100; tool calls 1000/);
  assert.match(facts["Session Ceilings"]!, /Original cost: 5; original tool calls: 50/);
  assert.match(facts["Root Allocation"]!, /cost 30; tool calls 300/);
  assert.match(facts["Spend and Reservations"]!, /Spent: 12 USD, 120 tool calls; reserved: 20 USD, 200 tool calls/);
  assert.match(facts["Native Reviewer Profile"]!, /Exact approved admission and live proof remain required/);
  assert.equal(result.supported, false, "an isolated capability fixture never authorizes live readiness");
  assert.deepEqual(budget, before);
});

test("legacy omitted isolation fields remain unknown instead of claiming they are disabled", () => {
  const defaults = { ...DEFAULT_ORCHESTRATOR_DEFAULTS, execution: { strictProjectIsolation: false } } as typeof DEFAULT_ORCHESTRATOR_DEFAULTS;
  const result = fullControlPreflight({ surface: "campaign", defaults });
  const facts = Object.fromEntries(result.facts.map(({ label, value }) => [label, value]));
  assert.equal(facts["Strict Project Isolation"], "Disabled");
  assert.equal(facts["Integration Isolation"], "Not reported by this campaign");
});
