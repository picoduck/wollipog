import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, PROTOCOL_VERSION, type OrchestratorSettingsView, type RunnerView } from "@wollipog/protocol";
import {
  childModelDisplayName,
  changesLabel,
  evaluateOrchestratorPolicy,
  policyDraftFromDefaults,
  policyOverrides,
  policySummaryFacts,
  resetField,
  withChildHarness,
  type OrchestratorPolicyContext,
  type OrchestratorPolicyDraft,
} from "./orchestrator-policy.js";

function view(): OrchestratorSettingsView {
  const defaults = structuredClone(DEFAULT_ORCHESTRATOR_DEFAULTS);
  defaults.behavior.followUps = "execute_approved";
  defaults.behavior.childModel = "sol";
  return {
    defaults,
    source: "user_default",
    capabilities: {
      harnesses: [{
        agentId: "pi", driver: "pi", context: { kind: "native" }, name: "Pi",
        models: [{ id: "sol", displayName: "Sol", efforts: ["low"] }], effortLevels: ["low"],
        supportedPairs: [{ modelId: "sol", effortLevels: ["low"] }], installations: 1,
      }],
      models: [{ id: "sol", displayName: "Sol", efforts: ["low"] }], effortLevels: ["low"],
      installations: 1, compatibleInstallations: 1, status: "available",
    },
  };
}

function context(settings = view()): OrchestratorPolicyContext {
  return {
    view: settings,
    machine: "Studio Mac",
    runnerProtocolVersion: PROTOCOL_VERSION,
    driver: "claude-code",
    hostExecutionTarget: true,
    agentOffersOrchestratorPreset: true,
    strictProjectBoundaryAvailable: true,
    providerExecutionAvailable: true,
    presetReason: () => undefined,
  };
}

const withFollowUps = (draft: OrchestratorPolicyDraft, followUps: "recommend_only" | "execute_approved"): OrchestratorPolicyDraft =>
  ({ ...draft, values: { ...draft.values, behavior: { ...draft.values.behavior, followUps } } });

test("a session overrides exactly the fields that differ from the saved defaults", () => {
  const settings = view();
  const draft = policyDraftFromDefaults(settings.defaults);
  assert.deepEqual([...policyOverrides(draft, settings.defaults)], [], "the defaults override nothing");
  const changed = withFollowUps(draft, "recommend_only");
  assert.deepEqual([...policyOverrides(changed, settings.defaults)], ["behavior.followUps"]);
  // Put back by hand, it is no longer a change, so its default's provenance is kept.
  assert.deepEqual([...policyOverrides(withFollowUps(changed, "execute_approved"), settings.defaults)], []);
  // An unreadable limit can never equal the default.
  assert.deepEqual([...policyOverrides({ ...draft, limitText: "" }, settings.defaults)], ["behavior.maximumConcurrentChildren"]);
  assert.deepEqual([...policyOverrides({ ...draft, limitText: " 4 " }, settings.defaults)], []);
});

test("a new Child Harness starts its model over, and Reset puts one field back", () => {
  const settings = view();
  const harnessKey = evaluateOrchestratorPolicy(context(settings), policyDraftFromDefaults(settings.defaults)).harness.options[1]!.value;
  const chosen = withChildHarness(policyDraftFromDefaults(settings.defaults), settings, harnessKey);
  assert.equal(chosen.values.behavior.childHarness?.agentId, "pi");
  assert.equal(chosen.values.behavior.childModel, null);
  assert.deepEqual([...policyOverrides(chosen, settings.defaults)].sort(), ["behavior.childHarness", "behavior.childModel"]);
  const reset = resetField(chosen, settings.defaults, "behavior.childModel");
  assert.equal(reset.values.behavior.childModel, "sol");
  assert.deepEqual([...policyOverrides(reset, settings.defaults)], ["behavior.childHarness"]);
});

test("the evaluation counts changes per tab and names capability gaps by machine, never by protocol", () => {
  const settings = view();
  const draft = withFollowUps(policyDraftFromDefaults(settings.defaults), "recommend_only");
  const current = evaluateOrchestratorPolicy(context(settings), { ...draft, controlMode: "full_control" });
  assert.deepEqual(current.changeCounts, { behavior: 1, permissions: 0, decisions: 1, total: 2 });
  assert.equal(current.changed("behavior.followUps"), true);
  assert.equal(current.limit.min, 1, "Full Control's concurrency is at least 1");

  const harness = evaluateOrchestratorPolicy(context(settings), policyDraftFromDefaults(settings.defaults)).harness.options[1]!.value;
  const fixed = withChildHarness(policyDraftFromDefaults(settings.defaults), settings, harness);
  const old = evaluateOrchestratorPolicy({ ...context(settings), runnerProtocolVersion: 67 }, fixed);
  assert.equal(old.problems[0]?.message, "Update Wollipog on Studio Mac to choose a fixed Child Harness.");
  for (const problem of old.problems) assert.doesNotMatch(problem.message, /protocol|runner/i);
});

test("the summary states five facts and counts changes in words", () => {
  const settings = view();
  const draft = policyDraftFromDefaults(settings.defaults);
  const facts = policySummaryFacts(draft, evaluateOrchestratorPolicy(context(settings), draft)).map((fact) => fact.label);
  assert.deepEqual(facts, ["Up to 4 Children", "Executes Approved Follow-Ups", "Keeps Finished Children", "No Isolation", "No Decisions Delegated"]);
  const paused = { ...draft, limitText: "0" };
  assert.equal(policySummaryFacts(paused, evaluateOrchestratorPolicy(context(settings), paused))[0]?.label, "New Children Paused");
  assert.equal(changesLabel(1), "1 change");
  assert.equal(changesLabel(3), "3 changes");
});

test("review policy fields track overrides, reset individually, and validate only on capable control planes", () => {
  const settings = view();
  settings.reviewPolicySupported = true;
  settings.capabilities.reviewers = [{ harness: "codex", name: "Codex", runnerId: "r", agentId: "codex",
    capabilities: { models: [{ id: "gpt-review", default: true }], effortLevels: ["high"], slashCommands: [], supportsImages: false, supportsApprovals: true } }];
  const original = policyDraftFromDefaults(settings.defaults);
  const draft = { ...original, values: { ...original.values, behavior: { ...original.values.behavior,
    reviewHarness: "codex" as const, reviewModel: "gpt-review", reviewEffort: "high", reviewRoundBudget: 2 } } };
  assert.deepEqual([...policyOverrides(draft, settings.defaults)], ["behavior.reviewHarness", "behavior.reviewModel", "behavior.reviewEffort", "behavior.reviewRoundBudget"]);
  assert.equal(evaluateOrchestratorPolicy(context(settings), draft).problems.some(p => p.path === "behavior.reviewHarness"), false);
  const missing = { ...draft, values: { ...draft.values, behavior: { ...draft.values.behavior, reviewModel: "missing" } } };
  assert.equal(evaluateOrchestratorPolicy(context(settings), missing).problems.some(p => p.path === "behavior.reviewHarness"), true);
  delete settings.reviewPolicySupported;
  assert.equal(evaluateOrchestratorPolicy(context(settings), missing).problems.some(p => p.path === "behavior.reviewHarness"), false);
  assert.equal(resetField(draft, settings.defaults, "behavior.reviewRoundBudget").values.behavior.reviewRoundBudget, null);
});

test("a child model reads as the selector names it, preferring the fixed harness, and its id only when nothing names it (#3580)", () => {
  const agent = (driver: "claude-code" | "codex-app-server", id: string, displayName?: string) => ({ id: driver, name: driver, command: driver,
    args: [], env: {}, driver, available: true, capabilities: { models: [{ id, ...(displayName ? { displayName } : {}) }], effortLevels: [],
      slashCommands: [], supportsImages: false, supportsApprovals: true } });
  const runners = [
    { runnerId: "a", agents: [agent("codex-app-server", "shared", "Shared via Codex"), agent("claude-code", "unnamed")] },
    { runnerId: "b", agents: [agent("claude-code", "shared", "Shared via Claude"), agent("claude-code", "claude-opus-5-5", "Claude Opus 5.5")] },
  ] as unknown as RunnerView[];
  assert.equal(childModelDisplayName(runners, "claude-opus-5-5"), "Claude Opus 5.5");
  assert.equal(childModelDisplayName(runners, "shared", { driver: "claude-code" }), "Shared via Claude", "the fixed harness's own name wins");
  assert.equal(childModelDisplayName(runners, "shared", { driver: "pi" }), "Shared via Codex", "another harness's name beats the raw id");
  assert.equal(childModelDisplayName(runners, "unnamed"), "unnamed");
  assert.equal(childModelDisplayName(runners, "gpt-6.1-sol"), "gpt-6.1-sol");
});
