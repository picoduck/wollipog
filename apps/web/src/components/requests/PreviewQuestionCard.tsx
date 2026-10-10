import React, { useEffect, useId, useRef, useState, type MutableRefObject, type ReactNode, type Ref } from "react";
import type { AgentQuestion, PendingApproval, SessionView } from "@wollipog/protocol";
import { useApi } from "../../api-context.js";
import { claimQuestionResponseOperation, clearQuestionDrafts, questionDraftIdentity } from "../../question-response.js";
import { useInstanceScope } from "../../instance-scope.js";
import { Notice } from "../Notice.js";
import { useSessionResponseRefusal } from "../SessionApproval.js";
import { QUESTION_CARD_COPY } from "./QuestionStep.js";
import { RequestCardHead, type RequestIntentHandler } from "./RequestCard.js";
import { RequestKindIcon, requestKindMeta } from "./request-meta.js";

/**
 * A question on the Sessions preview's request dock (#2210). A question is answered in its session,
 * where the transcript gives it its context (#2205), so the preview shows the question and one way
 * there: Answer in Session, whose keycap is the list's Enter, which opens the same session.
 *
 * The list's A and D act on this card, never on a request behind it, as they do on the session's own
 * question card: A opens this question in its session and D dismisses it.
 */
export function PreviewQuestionCard({
  sessionId,
  request,
  runnerOnline,
  questions,
  owner,
  createdAt,
  headTrailing,
  headingRef,
  showKeyHints = false,
  intentRef,
  onSessionUpdate,
  onAnswerInSession,
}: {
  sessionId: string;
  request: PendingApproval;
  /** Without its runner nobody can respond, so D does nothing and the card says why. */
  runnerOnline: boolean;
  questions: readonly AgentQuestion[];
  owner?: string;
  createdAt?: number;
  headTrailing?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  showKeyHints?: boolean;
  /** Receives the list's A and D while this card is the expanded request. */
  intentRef?: MutableRefObject<RequestIntentHandler | null>;
  onSessionUpdate?: (session: SessionView) => void;
  onAnswerInSession: (requestId: string) => void;
}) {
  const api = useApi();
  const titleId = `${useId().replace(/:/g, "")}-title`;
  const first = questions[0];
  const [failure, setFailure] = useState<string | null>(null);
  // A Viewer's refusal (#1857) or a disconnected runner leaves the card readable but unanswerable.
  const refusal = useSessionResponseRefusal(sessionId);
  const unavailable = !runnerOnline ? QUESTION_CARD_COPY.runnerOffline : refusal;
  // An asynchronous question's answer key is its occurrence, as on the session's question card.
  const answerKey = request.async && request.occurrenceId ? `${request.requestId}:${request.occurrenceId}` : request.requestId;
  const draftIdentity = questionDraftIdentity(request.requestId, questions, request.occurrenceId,
    request.requestedAt, useInstanceScope(), request.recoveryId);

  const dismiss = async () => {
    if (unavailable !== null) return;
    const release = claimQuestionResponseOperation(sessionId, answerKey);
    if (!release) return;
    setFailure(null);
    try {
      const updated = await api.answerQuestion(sessionId, {
        requestId: request.requestId,
        ...(request.occurrenceId ? { occurrenceId: request.occurrenceId } : {}),
        answers: {},
        action: "dismiss",
      });
      clearQuestionDrafts(sessionId, draftIdentity);
      onSessionUpdate?.(updated);
    } catch (cause) {
      setFailure((cause as Error).message);
    } finally {
      release();
    }
  };
  const actionsRef = useRef({ dismiss, open: () => onAnswerInSession(request.requestId) });
  actionsRef.current = { dismiss, open: () => onAnswerInSession(request.requestId) };
  useEffect(() => {
    if (!intentRef) return;
    const handler: RequestIntentHandler = (intent) => {
      if (intent === "deny") void actionsRef.current.dismiss();
      else actionsRef.current.open();
      return true;
    };
    intentRef.current = handler;
    return () => {
      if (intentRef.current === handler) intentRef.current = null;
    };
  }, [intentRef]);

  return (
    <section
      className="request-card"
      data-presentation="preview"
      data-request-kind="question"
      aria-labelledby={titleId}
    >
      <RequestCardHead
        kind={<><RequestKindIcon request={request} />{requestKindMeta(request).label}</>}
        owner={owner}
        time={createdAt}
        trailing={headTrailing}
      />
      <h3 className="request-card-title" id={titleId} ref={headingRef} tabIndex={-1} data-session-request-focus="">
        {first?.question ?? request.title}
      </h3>
      {questions.length > 1 && (
        <p className="request-card-policy">{`${questions.length - 1} more ${questions.length === 2 ? "question" : "questions"} in this request.`}</p>
      )}
      {unavailable !== null && (
        <div className="request-card-reasons">
          <p>{unavailable}</p>
        </div>
      )}
      {failure && (
        <Notice tone="danger" compact role="alert">
          Couldn't dismiss this question. {failure}
        </Notice>
      )}
      <div className="request-card-foot">
        <button type="button" className="btn primary" onClick={() => onAnswerInSession(request.requestId)}>
          Answer in Session
          {showKeyHints && <kbd aria-hidden="true">Enter</kbd>}
        </button>
      </div>
    </section>
  );
}
