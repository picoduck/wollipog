import React from "react";
import type { GovernanceDecision } from "../governance.js";
import { formatRecordedTimestamp } from "../format.js";
import { GovernanceDecisionFacts } from "./GovernanceDecision.js";

/**
 * Consolidated governance history — a secondary review surface in the side panel (a full-screen
 * drawer on phones), not a persistent band above the transcript. The transcript remains the
 * primary chronological record; this lists every recorded outcome newest-first for review.
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
          {newestFirst.map((decision) => {
            const recorded = formatRecordedTimestamp(decision.timestamp);
            return (
              <li className={`governance-history-row ${decision.tone}`} data-audit-id={decision.auditId} key={decision.auditId}>
                <details className="governance-decision">
                  <summary className="tl-governance-head">
                    <span className="governance-icon" aria-hidden="true">⚖️</span>
                    <span className="sr-only">Governance Decision: </span>
                    <span className="governance-label">{decision.label}</span>
                    {recorded && (
                      <time className="governance-history-time" dateTime={recorded.dateTime} title={recorded.title}>
                        {recorded.label}
                      </time>
                    )}
                  </summary>
                  <GovernanceDecisionFacts decision={decision} />
                </details>
              </li>
            );
          })}
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
