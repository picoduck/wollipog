import React from "react";
import type { GovernanceDecision } from "../governance.js";

/**
 * The disclosure body shared by the transcript annotation and the consolidated history.
 *
 * Only content-safe audit fields appear here: the outcome, who decided, the policy that matched,
 * and the opaque request id that makes repeated decisions individually attributable. Raw tool
 * input, question answers, and credentials are never part of the audit record and are never read.
 */
export function GovernanceDecisionFacts({ decision }: { decision: GovernanceDecision }) {
  return (
    <div className="governance-decision-body">
      <p className="governance-decision-detail">{decision.detail}</p>
      <dl className="governance-decision-facts">
        <dt>Decided By</dt>
        <dd>{decision.decidedBy}</dd>
        {decision.policyId && (
          <>
            <dt>Policy</dt>
            <dd>{decision.policyId}</dd>
          </>
        )}
        <dt>Request</dt>
        <dd className="governance-decision-request">{decision.requestId}</dd>
      </dl>
    </div>
  );
}
