import type { GitStatusInfo, GitSummaryInfo, SessionStatus } from "@wollipog/protocol";

const CHANGE_UNAVAILABLE_STATUSES = new Set<SessionStatus>(["queued", "starting", "running", "input_required"]);

export function sessionMayShowChangeStatus(status: SessionStatus): boolean {
  return !CHANGE_UNAVAILABLE_STATUSES.has(status);
}

export interface SessionChangeSupplement {
  kind: "uncommitted_changes";
  label: "Uncommitted Changes";
  description: string;
}

export type SessionChangeStatus =
  | { kind: "no_changes"; label: "No Changes"; description: string }
  | { kind: "changes_present"; label: "Changes Present"; description: string }
  | {
    kind: "ready_for_review";
    label: "Ready for Review";
    description: string;
    supplement?: SessionChangeSupplement;
  };

export interface SessionChangeEvidence {
  status?: GitStatusInfo | null;
  summary?: GitSummaryInfo | null;
  /** False while no authoritative Git read has completed. */
  settled: boolean;
  /** False when retained Git values cannot describe the repository current state. */
  available: boolean;
}

export function isOpenReviewRequestState(state: unknown): boolean {
  if (typeof state !== "string") return false;
  const normalized = state.toUpperCase();
  return normalized === "OPEN" || normalized === "OPENED";
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
  const baseComparisonKnown = Object.hasOwn(facts, "baseRef") && facts.baseRef != null;
  const summaryMatchesStatus = !evidence.status || (
    evidence.summary?.branch === evidence.status.branch &&
    evidence.summary?.baseRef === evidence.status.baseRef
  );
  const prState = evidence.summary?.pr?.state;
  const requestName = evidence.summary?.pr?.kind === "merge_request" ? "merge request" : "pull request";
  const openPullRequest = summaryMatchesStatus && isOpenReviewRequestState(prState);
  if (baseComparisonKnown && facts.ahead > 0 && openPullRequest) {
    return {
      kind: "ready_for_review",
      label: "Ready for Review",
      description: `Git confirms commits ahead of base with an open ${requestName}.`,
      ...(facts.hasChanges ? {
        supplement: {
          kind: "uncommitted_changes" as const,
          label: "Uncommitted Changes" as const,
          description: `Git confirms additional uncommitted changes that are not included in the ${requestName}.`,
        },
      } : {}),
    };
  }
  if (changesPresent) {
    return {
      kind: "changes_present",
      label: "Changes Present",
      description: "Git confirms uncommitted or base-relative changes.",
    };
  }
  if (!baseComparisonKnown) return null;
  return {
    kind: "no_changes",
    label: "No Changes",
    description: "The latest Git observation found no uncommitted or base-relative changes.",
  };
}
