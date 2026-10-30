import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ORCHESTRATOR_DEFAULTS, type AgentHarnessIdentity, type OrchestratorCampaignBehavior } from "@wollipog/protocol";
import { applyCampaignBehavior, changedCampaignBehavior, inheritCampaignBehavior, parseCampaignBehaviorRequest } from "./campaign-behavior.js";
import { resolveOrchestratorCampaignPolicy } from "./orchestrator-settings.js";

const CODEX: AgentHarnessIdentity = { agentId: "codex-app-server", driver: "codex-app-server", context: { kind: "native" } };
const LAUNCHED: OrchestratorCampaignBehavior = { childHarness: CODEX, childModel: "gpt-5.5", childEffort: "high",
  followUps: "recommend_only", completion: "retain" };

function policy() {
  return resolveOrchestratorCampaignPolicy({ ...DEFAULT_ORCHESTRATOR_DEFAULTS,
    behavior: { ...DEFAULT_ORCHESTRATOR_DEFAULTS.behavior, ...structuredClone(LAUNCHED) } }, "user_default");
}

test("a request names exactly the five editable values and a revision", () => {
  const behavior = { ...LAUNCHED, childHarness: { agentId: "codex-local", driver: "codex-app-server", context: { kind: "native" } } };
  assert.deepEqual(parseCampaignBehaviorRequest({ expectedRevision: 2, behavior })?.behavior.childHarness, CODEX, "canonical, as saved defaults are");
  for (const invalid of [
    { behavior: LAUNCHED },
    { expectedRevision: -1, behavior: LAUNCHED },
    { expectedRevision: 0, behavior: { ...LAUNCHED, maximumConcurrentChildren: 3 } },
    { expectedRevision: 0, behavior: { ...LAUNCHED, followUps: "always" } },
    { expectedRevision: 0, behavior: (({ completion: _completion, ...rest }) => rest)(LAUNCHED) },
    { expectedRevision: 0, behavior: LAUNCHED, control: { mode: "full_control" } },
  ]) assert.equal(parseCampaignBehaviorRequest(invalid), null, JSON.stringify(invalid));
});

test("only changed values move to the active campaign source, and a new harness matches by harness", () => {
  const stored = policy();
  delete stored.childHarnessMatch;
  const next = { ...LAUNCHED, childHarness: { agentId: "claude-code", driver: "claude-code" as const, context: { kind: "native" as const } }, completion: "stop_and_archive" as const };
  assert.deepEqual(changedCampaignBehavior(stored, next), ["childHarness", "completion"]);
  applyCampaignBehavior(stored, next, 4);
  assert.equal(stored.sources.behavior.childHarness, "active_campaign");
  assert.equal(stored.sources.behavior.completion, "active_campaign");
  assert.equal(stored.sources.behavior.childModel, "user_default");
  assert.equal(stored.childHarnessMatch, "harness");
  assert.equal(stored.behaviorRevision, 4);
});

test("another row of the same harness is no change to a harness-matched campaign", () => {
  const sameHarness = { ...LAUNCHED, childHarness: { ...CODEX, agentId: "codex-second-row" } };
  assert.deepEqual(changedCampaignBehavior(policy(), sameHarness), []);
});

test("an unchanged harness on an exact-agent campaign round-trips: only Completion changes, its row and matching stay (CR-1.2)", () => {
  // A campaign from before #3247: its fixed Child Harness is a Machine-local row, matched exactly.
  const legacy = policy();
  delete legacy.childHarnessMatch;
  legacy.behavior.childHarness = { agentId: "codex-local", driver: "codex-app-server", context: { kind: "native" } };
  // The form sends the stored values back, which the request parser canonicalizes as it does defaults.
  const request = parseCampaignBehaviorRequest({ expectedRevision: 0, behavior: { ...LAUNCHED,
    childHarness: legacy.behavior.childHarness, completion: "stop_and_archive" } })!;
  assert.equal(request.behavior.childHarness!.agentId, "codex-app-server");
  assert.deepEqual(changedCampaignBehavior(legacy, request.behavior), ["completion"]);
  applyCampaignBehavior(legacy, request.behavior, 1);
  assert.deepEqual(legacy.behavior.childHarness, { agentId: "codex-local", driver: "codex-app-server", context: { kind: "native" } });
  assert.equal(legacy.sources.behavior.childHarness, "user_default");
  assert.equal("childHarnessMatch" in legacy, false, "other rows stay refused");
  // Another harness is a change, and it is chosen from the harness catalog, so it matches by harness.
  applyCampaignBehavior(legacy, { ...request.behavior, childHarness: { agentId: "claude-code", driver: "claude-code", context: { kind: "native" } } }, 2);
  assert.equal(legacy.childHarnessMatch, "harness");
});

test("changing Follow-Ups while the first message is being delivered keeps the authorized follow-up limit too (CR-1.1)", () => {
  const delivering = policy();
  delivering.firstMessageScope = { state: "delivering", messageDigest: "a".repeat(64), deliveryId: "first_message_x",
    derivedLimits: { acceptedFollowUps: true, maxIssues: true } };
  applyCampaignBehavior(delivering, { ...LAUNCHED, followUps: "execute_approved" }, 1);
  assert.deepEqual(delivering.firstMessageScope.derivedLimits, { acceptedFollowUps: false, maxIssues: true });
});

test("under Full Control, changing Follow-Ups before the first message keeps the follow-up limit the launch authorized", () => {
  const waiting = policy();
  waiting.firstMessageScope = { state: "pending", derivedLimits: { acceptedFollowUps: true, maxIssues: true } };
  applyCampaignBehavior(waiting, { ...LAUNCHED, followUps: "execute_approved" }, 1);
  assert.deepEqual(waiting.firstMessageScope, { state: "pending", derivedLimits: { acceptedFollowUps: false, maxIssues: true } },
    "the first message no longer derives a larger limit from the new Follow-Ups");
  const other = policy();
  other.firstMessageScope = { state: "pending", derivedLimits: { acceptedFollowUps: true, maxIssues: true } };
  applyCampaignBehavior(other, { ...LAUNCHED, childModel: "gpt-5.4" }, 1);
  assert.deepEqual(other.firstMessageScope, { state: "pending", derivedLimits: { acceptedFollowUps: true, maxIssues: true } },
    "a change that is not Follow-Ups leaves the derivation alone");
});

test("a nested Orchestrator takes the root's values, sources, matching and revision", () => {
  const root = policy();
  applyCampaignBehavior(root, { ...LAUNCHED, childModel: "gpt-5.4" }, 2);
  const nested = policy();
  nested.behavior.childModel = "stale";
  inheritCampaignBehavior(nested, root);
  assert.equal(nested.behavior.childModel, "gpt-5.4");
  assert.equal(nested.sources.behavior.childModel, "active_campaign");
  assert.equal(nested.behaviorRevision, 2);
  assert.equal(nested.behavior.maximumConcurrentChildren, root.behavior.maximumConcurrentChildren);
});
