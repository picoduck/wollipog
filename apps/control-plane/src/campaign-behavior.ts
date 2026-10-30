import {
  DEFAULT_ORCHESTRATOR_DEFAULTS,
  ORCHESTRATOR_CAMPAIGN_BEHAVIOR_KEYS,
  agentHarnessIdentityKey,
  exactAgentHarnessIdentityKey,
  type OrchestratorCampaignBehavior,
  type OrchestratorCampaignBehaviorKey,
  type OrchestratorCampaignPolicy,
  type OrchestratorCampaignProjection,
  type OrchestratorPolicySource,
  type UpdateOrchestratorCampaignBehaviorRequest,
} from "@wollipog/protocol";
import { parseOrchestratorDefaults } from "./orchestrator-settings.js";

/**
 * A person's change to a running campaign's child behavior (#3580): Child Harness, Child Model,
 * Child Effort, Follow-Ups and Completion. Each governs only what happens next: the next child
 * creation, the next follow-up recorded, the next child verified. None of them is part of a Full
 * Control boundary, so a change never re-mints one or revokes a decision.
 */

/** The complete request, or null. The values pass the same validation as saved account defaults. */
export function parseCampaignBehaviorRequest(value: unknown): UpdateOrchestratorCampaignBehaviorRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "expectedRevision" && key !== "behavior")) return null;
  if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0) return null;
  const behavior = input.behavior;
  if (!behavior || typeof behavior !== "object" || Array.isArray(behavior)) return null;
  const keys = Object.keys(behavior);
  if (keys.length !== ORCHESTRATOR_CAMPAIGN_BEHAVIOR_KEYS.length ||
      !keys.every((key) => (ORCHESTRATOR_CAMPAIGN_BEHAVIOR_KEYS as readonly string[]).includes(key))) return null;
  const parsed = parseOrchestratorDefaults({
    behavior: { ...DEFAULT_ORCHESTRATOR_DEFAULTS.behavior, ...behavior },
    delegation: DEFAULT_ORCHESTRATOR_DEFAULTS.delegation,
    execution: DEFAULT_ORCHESTRATOR_DEFAULTS.execution,
  });
  if (!parsed) return null;
  const { childHarness, childModel, childEffort, followUps, completion } = parsed.behavior;
  return { expectedRevision: input.expectedRevision as number, behavior: { childHarness, childModel, childEffort, followUps, completion } };
}

/** Whether a policy's Child Harness already names `next`. A harness-matched campaign (#3247) admits
 * any row of the harness, so another row of the same harness is no change; an older campaign still
 * enforces the exact agent row it stored. */
function sameChildHarness(policy: OrchestratorCampaignPolicy, next: OrchestratorCampaignBehavior["childHarness"]): boolean {
  const current = policy.behavior.childHarness;
  if (!current || !next) return current === next;
  return policy.childHarnessMatch === "harness"
    ? agentHarnessIdentityKey(current) === agentHarnessIdentityKey(next)
    : exactAgentHarnessIdentityKey(current) === exactAgentHarnessIdentityKey(next);
}

/** The editable values `next` would change in `policy`. */
export function changedCampaignBehavior(policy: OrchestratorCampaignPolicy, next: OrchestratorCampaignBehavior): OrchestratorCampaignBehaviorKey[] {
  return ORCHESTRATOR_CAMPAIGN_BEHAVIOR_KEYS.filter((key) =>
    key === "childHarness" ? !sameChildHarness(policy, next.childHarness) : policy.behavior[key] !== next[key]);
}

/**
 * Writes `next` into the root campaign's stored policy, in place. Only the values that change move
 * to the `active_campaign` source. A newly chosen Child Harness came from the harness catalog, so it
 * matches by harness like any campaign created since #3247.
 *
 * Under Full Control, Follow-Ups never changes the boundary a person authorized: its issue limit,
 * follow-up limit and related-follow-up grant stay as they are. A campaign still waiting for its
 * first message would otherwise derive its follow-up limit from the new Follow-Ups when that message
 * arrives, so a change to Follow-Ups keeps the limit the launch authorized, as a limit the person set
 * does (#3826).
 */
export function applyCampaignBehavior(policy: OrchestratorCampaignPolicy, next: OrchestratorCampaignBehavior, revision: number,
  changed = changedCampaignBehavior(policy, next)): void {
  for (const key of changed) {
    (policy.behavior as Record<OrchestratorCampaignBehaviorKey, unknown>)[key] = structuredClone(next[key]);
    policy.sources.behavior[key] = "active_campaign";
  }
  if (changed.includes("childHarness")) policy.childHarnessMatch = "harness";
  const waiting = policy.firstMessageScope;
  if (changed.includes("followUps") && waiting?.state === "pending" && waiting.derivedLimits?.acceptedFollowUps) {
    waiting.derivedLimits = { ...waiting.derivedLimits, acceptedFollowUps: false };
  }
  policy.behaviorRevision = revision;
}

/** A nested Orchestrator inherits the root's values, sources and harness matching exactly. */
export function inheritCampaignBehavior(member: OrchestratorCampaignPolicy, root: OrchestratorCampaignPolicy): void {
  for (const key of ORCHESTRATOR_CAMPAIGN_BEHAVIOR_KEYS) {
    (member.behavior as Record<OrchestratorCampaignBehaviorKey, unknown>)[key] = structuredClone(root.behavior[key]);
    member.sources.behavior[key] = root.sources.behavior[key];
  }
  if (root.childHarnessMatch === "harness") member.childHarnessMatch = "harness";
  else delete member.childHarnessMatch;
  member.behaviorRevision = root.behaviorRevision;
}

export function campaignBehaviorSources(policy: OrchestratorCampaignPolicy): Record<OrchestratorCampaignBehaviorKey, OrchestratorPolicySource> {
  return Object.fromEntries(ORCHESTRATOR_CAMPAIGN_BEHAVIOR_KEYS.map((key) =>
    [key, policy.sources.behavior[key] ?? "legacy_session"])) as Record<OrchestratorCampaignBehaviorKey, OrchestratorPolicySource>;
}

export function campaignBehaviorValues(policy: OrchestratorCampaignPolicy): OrchestratorCampaignBehavior {
  const { childHarness, childModel, childEffort, followUps, completion } = policy.behavior;
  return { childHarness: structuredClone(childHarness), childModel, childEffort, followUps, completion };
}

/** What get_campaign reports: the values the next child creation enforces, and where each came from. */
export function campaignBehaviorProjection(policy: OrchestratorCampaignPolicy): NonNullable<OrchestratorCampaignProjection["behavior"]> {
  return { ...campaignBehaviorValues(policy), revision: policy.behaviorRevision ?? 0, sources: campaignBehaviorSources(policy) };
}
