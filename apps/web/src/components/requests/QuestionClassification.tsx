import { useEffect, useRef, useState } from "react";
import { isCampaignHandoffQuestion } from "@wollipog/protocol";
import type { PendingApproval, SessionView } from "@wollipog/protocol";
import { useApi } from "../../api-context.js";
import { Notice } from "../Notice.js";
import { BusyButton } from "../ui/BusyButton.js";

export const QUESTION_CLASSIFICATION_REASON = "The campaign owner must classify this question first on this card or in Campaign Status. Nobody can answer it until then.";
export const HANDOFF_CLASSIFICATION_REASON = "The credential check was inconclusive. The campaign owner can dismiss or classify this handoff.";

/** Reuses the screen occurrence and the existing owner-only classification route. */
export function QuestionClassification({ sessionId, request, onSessionUpdate }: {
  sessionId: string;
  request: PendingApproval;
  onSessionUpdate?: (session: SessionView) => void;
}) {
  const api = useApi();
  const decision = request.workflowDecision;
  const handoff = isCampaignHandoffQuestion(decision);
  const screenId = decision?.authorityEvaluation?.credentialScreen?.occurrenceId;
  const [canClassify, setCanClassify] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState<{ screenId: string; dismissed: boolean } | null>(null);
  const settledScreen = settled?.screenId === screenId ? settled : null;
  useEffect(() => {
    const controller = new AbortController();
    setCanClassify(false);
    api.campaignDecisions(sessionId, controller.signal).then((response) => {
      if (!controller.signal.aborted) setCanClassify(response.canClassify === true);
    }).catch(() => { /* Unknown ownership stays read-only. */ });
    return () => controller.abort();
  }, [api, sessionId, screenId]);

  const respond = async (action: "decline" | "orchestrator" | "dismiss") => {
    if (inFlight.current || settledScreen || !canClassify || !screenId) return;
    inFlight.current = true;
    setBusy(action);
    setError(null);
    try {
      if (action === "dismiss") {
        const session = await api.answerQuestion(sessionId, {
          requestId: request.requestId, occurrenceId: request.occurrenceId, answers: {}, action,
        });
        setSettled({ screenId, dismissed: true });
        onSessionUpdate?.(session);
        return;
      }
      await api.classifyCampaignDecision(sessionId, screenId, action);
      setSettled({ screenId, dismissed: false });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the question.");
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
    {error && <Notice tone="danger" compact role="alert" title={settledScreen ? "Couldn't Refresh the Request" : "Couldn't Update the Question"}>{error}</Notice>}
    {settledScreen && <div className="request-card-reasons">
      <p role="status">{settledScreen.dismissed ? "The handoff question was dismissed." : "The question was classified."} Waiting for the updated request.</p>
      <BusyButton className="btn" busy={busy === "refresh"} disabled={busy !== null} progress="Refreshing the request…"
        onClick={() => void refresh()}>Refresh Request</BusyButton>
    </div>}
    {canClassify && screenId && !settledScreen && <div className="campaign-screen-actions" role="group" aria-label="Question Classification">
      {handoff && <BusyButton className="btn" busy={busy === "dismiss"} disabled={busy !== null}
        progress="Dismissing the handoff question…" onClick={() => void respond("dismiss")}>Dismiss</BusyButton>}
      <BusyButton className="btn" busy={busy === "decline"} disabled={busy !== null}
        progress="Declining the question…" onClick={() => void respond("decline")}>{handoff ? "Decline Credentials Request" : "Decline"}</BusyButton>
      <BusyButton className="btn primary" busy={busy === "orchestrator"} disabled={busy !== null}
        progress="Allowing an answer…" onClick={() => void respond("orchestrator")}>
        {decision?.category === "owner_decision" || decision?.ownerRule ? "Let Me Answer" : "Let the Orchestrator Answer"}
      </BusyButton>
    </div>}
  </>;
}
