import type { CampaignIssueScopeSeed, OrchestratorCampaignPolicy } from "@wollipog/protocol";

/**
 * A Custom campaign's first-message seed (#4104, #4259), on propose-then-check since #4282: the
 * server reads nothing from the message. The Custom Orchestrator proposes the issues it names, the
 * floors and the typed constraint check run against the person's own message, and an admit grants
 * what the server reading did. No word list or grammar decides whether a message names an epic or
 * which issues it grants.
 */

/** Whether a Custom campaign's first message needs a proposal at all: it writes a digit string, so
 * it can name an issue. A message without digits names no issue number, so nothing waits; this is a
 * floor that only ever withholds a grant, never one that makes it. */
export function needsCampaignIssueScopeSeed(text: string): boolean {
  return /(?<![0-9])[1-9][0-9]{0,15}(?![0-9])/u.test(text);
}

/** What Campaign Status shows for one epic seed reading: the seed's state when that reading is the
 * campaign's current one, or `scoped` once the person approved a scope, which ends any hold the seed
 * placed (review round 2). Undefined for any other occurrence. */
export function campaignSeedSubjectState(policy: Pick<OrchestratorCampaignPolicy, "issueScope" | "issueScopeSeed"> | undefined,
  occurrenceId: string): CampaignIssueScopeSeed["state"] | "scoped" | undefined {
  const seed = policy?.issueScopeSeed;
  if (!seed || seed.occurrenceId !== occurrenceId) return undefined;
  return policy?.issueScope && seed.state !== "none" ? "scoped" : seed.state;
}

/** Whether delegation waits for the person to approve the campaign's issue scope: an epic was
 * seeded, the seed is still being read, or the reading failed or was uncertain. */
export function campaignSeedHoldsDelegation(policy: Pick<OrchestratorCampaignPolicy, "issueScope" | "issueScopeProposalEpic" | "issueScopeSeed"> | undefined): boolean {
  if (!policy || policy.issueScope) return false;
  const state: CampaignIssueScopeSeed["state"] | undefined = policy.issueScopeSeed?.state;
  return policy.issueScopeProposalEpic !== undefined || state === "pending" || state === "owner";
}
