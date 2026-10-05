import React from "react";
import { governanceDecisionRecord } from "../decision-record.js";
import type { GovernanceDecision } from "../governance.js";
import { DecisionRecord } from "./requests/DecisionRecord.js";

/**
 * Consolidated governance history — a secondary review surface in the side panel (a full-screen
 * drawer on phones), not a persistent band above the transcript. The transcript remains the
 * primary chronological record; this lists every recorded outcome newest-first for review, as the
 * same Decision Record rows the transcript shows (#2204).
 */
export function GovernanceHistoryPanel({
  decisions,
  hasMore = false,
  loadingOlder = false,
  onLoadOlder,
}: {
  decisions: readonly GovernanceDecision[];
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}) {
  if (!decisions.length && !hasMore) {
    return <div className="hint">No governance decisions have been recorded for this session.</div>;
  }
  const newestFirst = [...decisions].reverse();
  return (
    <>
      {newestFirst.length ? (
        <ol className="governance-history" aria-label="Governance History">
          {newestFirst.map((decision) => (
            <li className="governance-history-row" key={decision.auditId}>
              <DecisionRecord record={governanceDecisionRecord(decision)} auditId={decision.auditId} />
            </li>
          ))}
        </ol>
      ) : (
        <div className="hint">No governance decisions are visible in this page yet.</div>
      )}
      {hasMore && (
        <button
          aria-busy={loadingOlder}
          aria-disabled={loadingOlder}
          className="btn governance-history-more"
          type="button"
          onClick={onLoadOlder}
        >
          {loadingOlder ? "Loading Older Decisions…" : "Load Older Decisions"}
        </button>
      )}
    </>
  );
}
