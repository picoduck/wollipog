import React, { useContext } from "react";
import { governanceDecidedBy, governanceDecisionLabel, type GovernanceDecision } from "../governance.js";
import { ViewerIdentityContext } from "../resolver-identity.js";

/** The decision's label, naming a member's decision relative to the viewer (#2527). */
export function GovernanceDecisionLabel({ decision }: { decision: GovernanceDecision }) {
  const viewer = useContext(ViewerIdentityContext);
  return <span className="governance-label">{governanceDecisionLabel(decision, viewer)}</span>;
}

/**
 * The disclosure body shared by the transcript annotation and the consolidated history.
 *
 * Only content-safe audit fields appear here: the outcome, who decided, the policy that matched,
 * and the opaque request id that makes repeated decisions individually attributable. Raw tool
 * input, question answers, and credentials are never part of the audit record and are never read.
 */
export function GovernanceDecisionFacts({ decision }: { decision: GovernanceDecision }) {
  const viewer = useContext(ViewerIdentityContext);
  return (
    <div className="governance-decision-body">
      <p className="governance-decision-detail">{decision.detail}</p>
      <dl className="governance-decision-facts">
        <dt>Decided By</dt>
        <dd>{governanceDecidedBy(decision, viewer)}</dd>
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
