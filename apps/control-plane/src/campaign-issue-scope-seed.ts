import type { CampaignIssueScopeSeed, OrchestratorCampaignPolicy } from "@wollipog/protocol";
import type { ScopeGrantFields } from "./scope-grant.js";

/**
 * A Custom campaign's epic seed (#4104). The Decision Model reads the person's first message
 * (`scope_grant`) and the runner checks what it named; no word list decides whether a message
 * names an epic.
 */

/** Whether a Custom campaign's first message gets a seed at all: it writes a digit string, so it
 * can name an issue, and the explicit issue-list request (`orchestratorIssueNumbersFromInitialPrompt`)
 * found none. A message without digits names no issue number and makes no Decision call. */
export function needsCampaignIssueScopeSeed(text: string, explicitIssueNumbers: readonly number[]): boolean {
  return explicitIssueNumbers.length === 0 && /(?<![0-9])[1-9][0-9]{0,15}(?![0-9])/u.test(text);
}

/** The one issue a healthy reading names as the work, when that is all it names: no range and no
 * selection. The caller still applies the scope grant's floors and has the runner verify the
 * issue's members before it seeds anything. */
export function seedEpicCandidate(fields: Pick<ScopeGrantFields, "explicit" | "ranges" | "selectionRequested">): number | null {
  if (fields.ranges.length || fields.selectionRequested || fields.explicit.length !== 1) return null;
  return fields.explicit[0]!.number;
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
