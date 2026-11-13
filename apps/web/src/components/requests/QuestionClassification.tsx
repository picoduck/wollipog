import { useEffect, useRef, useState } from "react";
import type { PendingApproval, SessionView } from "@wollipog/protocol";
import { useApi } from "../../api-context.js";
import { Notice } from "../Notice.js";
import { BusyButton } from "../ui/BusyButton.js";

export const QUESTION_CLASSIFICATION_REASON = "The campaign owner must classify this question first on this card or in Campaign Status. Nobody can answer it until then.";

/** Reuses the screen occurrence and the existing owner-only classification route. */
export function QuestionClassification({ sessionId, request, onSessionUpdate }: {
  sessionId: string;
  request: PendingApproval;
  onSessionUpdate?: (session: SessionView) => void;
}) {
  const api = useApi();
  const decision = request.workflowDecision;
  const screenId = decision?.authorityEvaluation?.credentialScreen?.occurrenceId;
  const [canClassify, setCanClassify] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [classifiedScreen, setClassifiedScreen] = useState<string | null>(null);
  const classified = screenId !== undefined && classifiedScreen === screenId;
  useEffect(() => {
    const controller = new AbortController();
    setCanClassify(false);
    api.campaignDecisions(sessionId, controller.signal).then((response) => {
      if (!controller.signal.aborted) setCanClassify(response.canClassify === true);
    }).catch(() => { /* Unknown ownership stays read-only. */ });
    return () => controller.abort();
  }, [api, sessionId, screenId]);

  const classify = async (classification: "decline" | "orchestrator") => {
    if (inFlight.current || classified || !canClassify || !screenId) return;
    inFlight.current = true;
    setBusy(classification);
    setError(null);
    try {
      await api.classifyCampaignDecision(sessionId, screenId, classification);
      setClassifiedScreen(screenId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not classify the question.");
      return;
    } finally { inFlight.current = false; setBusy(null); }
    await refresh();
  };
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy("refresh");
    setError(null);
    try {
      // Classification never grants local answer permission; only the authoritative card does.
      const updated = await api.session(sessionId);
      onSessionUpdate?.(updated.session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not refresh the request.");
    } finally { inFlight.current = false; setBusy(null); }
  };
  return <>
    {error && <Notice tone="danger" compact role="alert" title={classified ? "Couldn't Refresh the Request" : "Couldn't Classify the Question"}>{error}</Notice>}
    {classified && <div className="request-card-reasons">
      <p role="status">The question was classified. Waiting for the updated request.</p>
      <BusyButton className="btn" busy={busy === "refresh"} disabled={busy !== null} progress="Refreshing the request…"
        onClick={() => void refresh()}>Refresh Request</BusyButton>
    </div>}
    {canClassify && screenId && !classified && <div className="campaign-screen-actions" role="group" aria-label="Question Classification">
      <BusyButton className="btn" busy={busy === "decline"} disabled={busy !== null}
        progress="Declining the question…" onClick={() => void classify("decline")}>Decline</BusyButton>
      <BusyButton className="btn primary" busy={busy === "orchestrator"} disabled={busy !== null}
        progress="Allowing an answer…" onClick={() => void classify("orchestrator")}>
        {decision?.category === "owner_decision" || decision?.ownerRule ? "Let Me Answer" : "Let the Orchestrator Answer"}
      </BusyButton>
    </div>}
  </>;
}
