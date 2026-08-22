import type { GitStatusInfo, GitSummaryInfo } from "@wollipog/protocol";

export type SessionChangeKind = "no_changes" | "changes_present" | "ready_for_review";

export interface SessionChangeStatus {
  kind: SessionChangeKind;
  label: "No Changes" | "Changes Present" | "Ready for Review";
  description: string;
}

export interface SessionChangeEvidence {
  status?: GitStatusInfo | null;
  summary?: GitSummaryInfo | null;
  /** False while no authoritative Git read has completed. */
  settled: boolean;
  /** False when retained Git values cannot describe the repository current state. */
  available: boolean;
}

/**
 * Derive change state only from a completed Git observation. Workflow-column placement and idle
 * lifecycle are deliberately absent: neither proves a diff. An open PR plus confirmed commits ahead of
 * the comparison base is the currently defensible review-readiness signal.
 */
export function sessionChangeStatus(evidence: SessionChangeEvidence): SessionChangeStatus | null {
  if (!evidence.settled || evidence.available === false) return null;
  // Status owns the fresher local facts; summary contributes forge-only pull-request evidence.
  const facts = evidence.status ?? evidence.summary;
  if (!facts) return null;
  const changesPresent = facts.hasChanges || facts.ahead > 0;
  const summaryMatchesStatus = !evidence.status || (
    evidence.summary?.branch === evidence.status.branch &&
    evidence.summary?.baseRef === evidence.status.baseRef
  );
  const openPullRequest = summaryMatchesStatus && evidence.summary?.pr?.state.toUpperCase() === "OPEN";
  if (facts.ahead > 0 && openPullRequest) {
    return {
      kind: "ready_for_review",
      label: "Ready for Review",
      description: "Git confirms commits ahead of base with an open pull request.",
    };
  }
  if (changesPresent) {
    return {
      kind: "changes_present",
      label: "Changes Present",
      description: "Git confirms uncommitted or base-relative changes.",
    };
  }
  const baseComparisonKnown = Object.hasOwn(facts, "baseRef") && facts.baseRef != null;
  if (!baseComparisonKnown) return null;
  return {
    kind: "no_changes",
    label: "No Changes",
    description: "The latest Git observation found no uncommitted or base-relative changes.",
  };
}
