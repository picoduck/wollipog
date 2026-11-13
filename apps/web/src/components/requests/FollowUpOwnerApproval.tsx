import { useRef, useState } from "react";
import type { PendingApproval, SessionView } from "@wollipog/protocol";
import { useApi } from "../../api-context.js";
import { sessionCommandRefusal } from "../../session-command-permissions.js";
import { Modal } from "../common.js";
import { Notice } from "../Notice.js";
import { BusyButton } from "../ui/BusyButton.js";
import { WorkflowDecisionSummary } from "./WorkflowDecisionSummary.js";

/** One review of several exact human-owned payloads. Each existing typed occurrence is approved
 * through its ordinary endpoint and remains individually consumable. No generic batch grant is
 * created. Freeze the displayed set: requests arriving during review are never silently included. */
export function FollowUpOwnerApproval({ session, requests, onSessionUpdate }: {
  session: SessionView;
  requests: readonly PendingApproval[];
  onSessionUpdate?: (session: SessionView) => void;
}) {
  const api = useApi();
  const button = useRef<HTMLButtonElement>(null);
  const flight = useRef(false);
  const [review, setReview] = useState<PendingApproval[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const eligible = requests.filter((request) => {
    const decision = request.workflowDecision;
    return request.kind === "workflow_decision" && decision?.authority === "human" && decision.status === "pending" &&
      decision.controllingSessionId === session.id && decision.sessionId === session.id &&
      (decision.category === "campaign_follow_up_admission" || decision.category === "follow_up_issue_publication");
  });
  const refusal = sessionCommandRefusal(session, "respond");
  const approve = async () => {
    if (!review || refusal || flight.current || attempted) return;
    flight.current = true;
    setBusy(true); setAttempted(true);
    let approved = 0;
    try {
      // Confirm each result before dispatching the next exact approval.
      for (const request of review) {
        const updated = await api.approve(session.id, { requestId: request.requestId, optionId: "approve" });
        approved++;
        onSessionUpdate?.(updated);
      }
      setReview(null);
    } catch {
      // A lost HTTP response can follow a durable approval. Do not replay or claim rollback.
      setFailure(`${approved} of ${review.length} approvals were confirmed. The next approval could not be confirmed. Close this review and refresh the requests before continuing; earlier approvals remain in effect.`);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  if (eligible.length < 2 && !review) return null;
  return <>
    <div><button ref={button} type="button" className="btn sm" disabled={refusal !== null}
      title={refusal ?? undefined} onClick={() => { setReview([...eligible]); setFailure(null); setAttempted(false); }}>
      Review {eligible.length} Follow-Up Approvals
    </button></div>
    {review && <Modal title="Owner Approval" returnFocusRef={button} onClose={() => { if (!busy) setReview(null); }} footer={<>
      <button type="button" className="btn" disabled={busy} onClick={() => setReview(null)}>Close</button>
      <BusyButton className="btn primary" busy={busy} disabled={attempted || refusal !== null}
        progress="Approving follow-ups…" onClick={() => void approve()}>Approve All {review.length} Payloads</BusyButton>
    </>}>
      <p>Review every exact payload below. This review approves each payload shown. Each publication uses its own approval once.</p>
      {refusal && <Notice tone="warning">{refusal}</Notice>}
      {review.map((request, index) => <section className="field" key={request.requestId}>
        <h3>{index + 1}. {request.workflowDecision!.category === "campaign_follow_up_admission" ? "Follow-Up Admission" : "Issue Publication"}</h3>
        <WorkflowDecisionSummary snapshot={request.workflowDecision!.resourceSnapshot} />
      </section>)}
      {failure && <Notice tone="danger" role="alert" title="Approval Results Need Review">{failure}</Notice>}
    </Modal>}
  </>;
}
