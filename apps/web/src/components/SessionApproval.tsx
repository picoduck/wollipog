import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH,
  type AgentQuestion,
  type PendingApproval,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useOptionalStoreSelector } from "../store.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import {
  clearQuestionDrafts,
  claimQuestionResponseOperation,
  isAnswerableAgentQuestion,
  questionDraftAnswers,
  questionDraftSelections,
  questionDraftText,
  storedQuestionDrafts,
  storeQuestionDrafts,
  type QuestionResponseDraft,
} from "../question-response.js";
import { useQuestionResponseStyle } from "../question-response-style.js";
import { useInstanceScope } from "../instance-scope.js";
import { clearEvidenceReviewDraft } from "../evidence-review-drafts.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";
import { StructuredQuestionText } from "./StructuredQuestionText.js";
import { revealDockedRequest } from "./requests/request-reveal.js";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface QuestionSelectionState {
  requestId: string;
  picked: Record<string, string[]>;
}

export function questionSelectionForRequest(state: QuestionSelectionState, requestId: string): Record<string, string[]> {
  return state.requestId === requestId ? state.picked : {};
}

export function approvalFocusDestination(
  previousRequestId: string | null,
  nextRequestId: string | null,
  focusOwned: boolean,
): "request" | "fallback" | null {
  if (!focusOwned || previousRequestId === nextRequestId) return null;
  return nextRequestId ? "request" : "fallback";
}

/** Why the signed-in person may not answer or decide this session's requests (#1857), from the
 * session's view in the store. Without a store or a view it is `fallback`: a caller that knows the
 * requester's verdict from another view passes it, and otherwise the server still decides. */
export function useSessionResponseRefusal(sessionId: string, fallback: string | null = null): string | null {
  const stored = useOptionalStoreSelector((state) => {
    const session = state.sessions.get(sessionId);
    return session ? sessionCommandRefusal(session, "respond") : undefined;
  });
  return stored === undefined ? fallback : stored;
}

/** Stable focus/live boundary across coalesced approval replacement and final resolution. The
 * session's own non-question requests are answered on the request dock above the composer (#2179);
 * this region keeps a pending question in its current place until #2205 docks questions too. */
export function SessionApprovalRegion({
  session,
  runnerOnline,
  fallbackFocusRef,
  alternateFallbackFocusRef,
  onFallbackFocus,
  onSessionUpdate,
  showKeyHints = true,
  questionInTimeline = false,
}: {
  session: SessionView;
  runnerOnline: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  alternateFallbackFocusRef?: RefObject<HTMLElement | null>;
  onFallbackFocus?: () => boolean;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
  /** Whether the pending question already has an authoritative transcript row. */
  questionInTimeline?: boolean;
}) {
  const approval = session.pendingApproval;
  const questionFallback = approval?.kind === "question" && !questionInTimeline;
  const requestPresentation = questionFallback ? "fallback" : approval?.kind === "question"
    ? "timeline" : approval ? "dock" : "none";
  return (
    <>
      <SessionRequestCoordinator
        sessionId={session.id}
        requestId={approval?.requestId ?? null}
        requestIsQuestion={approval?.kind === "question"}
        requestPresentation={requestPresentation}
        runnerOnline={runnerOnline}
        fallbackFocusRef={fallbackFocusRef}
        alternateFallbackFocusRef={alternateFallbackFocusRef}
        onFallbackFocus={onFallbackFocus}
      />
      {questionFallback && (
        <div data-session-request-id={approval.requestId} data-session-request-session={session.id}>
          <SessionQuestionBanner
            key={`${approval.requestId}:${approval.occurrenceId ?? ""}`}
            sessionId={session.id}
            requestId={approval.requestId}
            occurrenceId={approval.occurrenceId}
            questions={approval.questions ?? []}
            isAsync={approval.async}
            recoveryReason={approval.recoveryReason}
            recoveryAction={approval.recoveryAction}
            runnerOnline={runnerOnline}
            onSessionUpdate={onSessionUpdate}
            showKeyHints={showKeyHints}
          />
        </div>
      )}
    </>
  );
}

/** Clears the saved review of a UI evidence decision once it is no longer pending, wherever it was
 * resolved: on this card, on another device, or replaced by a new occurrence (#1107). */
export function useEvidenceDraftRetirement(sessionId: string, requests: readonly PendingApproval[]): void {
  const instanceScope = useInstanceScope();
  const identities = requests.flatMap((request) => {
    const decision = request.kind === "workflow_decision" ? request.workflowDecision : undefined;
    return decision?.resourceSnapshot.category === "ui_evidence_approval"
      ? [JSON.stringify([sessionId, request.requestId, decision.resourceDigest])]
      : [];
  });
  const signature = identities.join("\n");
  const previousRef = useRef<string[]>(identities);
  useEffect(() => {
    for (const previous of previousRef.current) {
      if (identities.includes(previous)) continue;
      const [previousSession, requestId, resourceDigest] = JSON.parse(previous) as [string, string, string];
      clearEvidenceReviewDraft(instanceScope, previousSession, requestId, resourceDigest);
    }
    previousRef.current = identities;
  // The signature is the set of identities.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceScope, signature]);
}

/** Keep one question representation at its event's timeline position while the request is live. */
export function SessionTimelineQuestionRegion({
  sessionId,
  pendingQuestion,
  eventRequestId,
  eventQuestions,
  eventResolved,
  runnerOnline,
  onSessionUpdate,
  showKeyHints = true,
  children,
}: {
  sessionId: string;
  pendingQuestion: {
    requestId: string;
    occurrenceId?: string;
    questions: AgentQuestion[];
    async?: boolean;
    recoveryReason?: "provider_restart";
    recoveryAction?: "resume_answer";
  } | null;
  eventRequestId: string;
  eventQuestions: AgentQuestion[];
  eventResolved: boolean;
  runnerOnline: boolean;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
  children: ReactNode;
}) {
  const approval = !eventResolved && pendingQuestion?.requestId === eventRequestId
    ? pendingQuestion
    : null;
  return (
    <div data-session-request-id={approval?.requestId} data-session-request-session={approval ? sessionId : undefined}>
      {approval ? (
        <SessionQuestionBanner
          sessionId={sessionId}
          requestId={approval.requestId}
          occurrenceId={approval.occurrenceId}
          questions={approval.questions.length > 0 ? approval.questions : eventQuestions}
          isAsync={approval.async}
          recoveryReason={approval.recoveryReason}
          recoveryAction={approval.recoveryAction}
          runnerOnline={runnerOnline}
          onSessionUpdate={onSessionUpdate}
          showKeyHints={showKeyHints}
        />
      ) : children}
    </div>
  );
}

function requestRegionFor(element: Element | null): HTMLElement | null {
  return element?.closest<HTMLElement>("[data-session-request-id]") ?? null;
}

/** Navigate to an existing request without making a response button the implicit Enter target.
 * False when no mounted surface renders the request, so the caller can route elsewhere. */
export function focusSessionRequest(sessionId: string, requestId: string): boolean {
  if (revealDockedRequest(sessionId, requestId)) return true;
  const region = [...document.querySelectorAll<HTMLElement>("[data-session-request-id]")]
    .find((candidate) => candidate.dataset.sessionRequestId === requestId &&
      candidate.dataset.sessionRequestSession === sessionId);
  if (!region) return false;
  region.tabIndex = -1;
  region.scrollIntoView?.({ block: "nearest" });
  region.focus();
  return true;
}

function enabledRequestControl(
  sessionId: string,
  requestId: string,
  preferredControl: string | null = null,
): HTMLElement | null {
  const regions = document.querySelectorAll<HTMLElement>("[data-session-request-id]");
  const region = [...regions].find((candidate) => candidate.dataset.sessionRequestId === requestId &&
    candidate.dataset.sessionRequestSession === sessionId);
  const controls = [...region?.querySelectorAll<HTMLElement>(
    'button:not(:disabled):not([aria-disabled="true"]), [role="radio"][tabindex="0"]:not(:disabled):not([aria-disabled="true"]), [role="checkbox"]:not(:disabled):not([aria-disabled="true"]), input:not(:disabled)',
  ) ?? []];
  // Composer Response owns entry outside this request region. On replacement, do not turn the
  // card's destructive Dismiss action into the implicit focus target for the user's next Enter.
  const eligible = region?.querySelector(".question-style-composer")
    ? controls.filter((control) => control.dataset.sessionRequestControl !== "dismiss")
    : controls;
  // A Request Card names its heading as the landing place: a new request is read before it is
  // answered, and its first button is not the one to press by default.
  return eligible.find((control) => control.dataset.sessionRequestControl === preferredControl) ??
    region?.querySelector<HTMLElement>("[data-session-request-focus]") ?? eligible[0] ?? null;
}

/** Persistent focus and live-announcement owner for approvals in either presentation. */
function SessionRequestCoordinator({
  sessionId,
  requestId,
  requestIsQuestion,
  requestPresentation,
  runnerOnline,
  fallbackFocusRef,
  alternateFallbackFocusRef,
  onFallbackFocus,
}: {
  sessionId: string;
  requestId: string | null;
  requestIsQuestion: boolean;
  requestPresentation: "fallback" | "timeline" | "dock" | "none";
  runnerOnline: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  alternateFallbackFocusRef?: RefObject<HTMLElement | null>;
  onFallbackFocus?: () => boolean;
}) {
  const previousRequestRef = useRef<string | null>(null);
  const previousRequestWasQuestionRef = useRef(false);
  const announcedRequestRef = useRef<string | null>(null);
  const previousRunnerOnlineRef = useRef(runnerOnline);
  const [announcement, setAnnouncement] = useState("");
  const requestWasUnchangedBeforeRender = previousRequestRef.current === requestId;
  const focusedElementBeforeRender = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
    ? document.activeElement : null;
  const focusedRequestBeforeRender = requestRegionFor(focusedElementBeforeRender)?.dataset.sessionRequestId ?? null;
  const focusedRequestSessionBeforeRender = requestRegionFor(focusedElementBeforeRender)?.dataset.sessionRequestSession ?? null;
  const focusedControlBeforeRender = focusedElementBeforeRender?.dataset.sessionRequestControl ?? null;
  const ownedFocusBeforeRender = previousRequestRef.current !== null &&
    focusedRequestBeforeRender === previousRequestRef.current && focusedRequestSessionBeforeRender === sessionId;
  const focusFallback = () => {
    if (onFallbackFocus?.()) return;
    const primary = fallbackFocusRef.current;
    const target = primary && !primary.matches(":disabled") ? primary : alternateFallbackFocusRef?.current;
    target?.focus();
  };

  useIsomorphicLayoutEffect(() => {
    const requestChanged = previousRequestRef.current !== requestId;
    if (requestChanged && previousRequestWasQuestionRef.current && previousRequestRef.current) {
      clearQuestionDrafts(sessionId, previousRequestRef.current);
    }
    const focusDestination = approvalFocusDestination(previousRequestRef.current, requestId, ownedFocusBeforeRender);
    previousRequestRef.current = requestId;
    previousRequestWasQuestionRef.current = requestIsQuestion;
    const activeRegion = requestRegionFor(document.activeElement);
    const representationMoved = !requestChanged && ownedFocusBeforeRender &&
      (activeRegion?.dataset.sessionRequestId !== requestId || activeRegion?.dataset.sessionRequestSession !== sessionId);
    if (focusDestination === "request" || representationMoved) {
      const target = requestId ? enabledRequestControl(
        sessionId,
        requestId,
        representationMoved ? focusedControlBeforeRender : null,
      ) : null;
      if (target) target.focus();
      else focusFallback();
      return;
    }
    if (focusDestination === "fallback") focusFallback();
  }, [alternateFallbackFocusRef, fallbackFocusRef, onFallbackFocus, ownedFocusBeforeRender, requestId,
    requestIsQuestion, requestPresentation, sessionId]);

  useEffect(() => {
    if (announcedRequestRef.current === requestId) return;
    const hadRequest = announcedRequestRef.current !== null;
    announcedRequestRef.current = requestId;
    setAnnouncement(requestId ? (hadRequest ? "Agent request updated" : "Agent response required") : "Agent request resolved");
  }, [requestId]);

  useIsomorphicLayoutEffect(() => {
    const wentOffline = previousRunnerOnlineRef.current && !runnerOnline;
    previousRunnerOnlineRef.current = runnerOnline;
    if (!wentOffline || !requestWasUnchangedBeforeRender || !ownedFocusBeforeRender ||
      requestId === null || !focusedElementBeforeRender) return;
    if (!focusedElementBeforeRender.matches(":disabled")
      && focusedElementBeforeRender.getAttribute("aria-disabled") !== "true") return;
    focusFallback();
  }, [alternateFallbackFocusRef, fallbackFocusRef, focusedElementBeforeRender, onFallbackFocus,
    ownedFocusBeforeRender, requestId, requestWasUnchangedBeforeRender, runnerOnline]);

  return <span className="sr-only" role="status" aria-live="polite">{announcement}</span>;
}

/** Structured agent questions with two presentations over one request-keyed canonical draft. */
export function SessionQuestionBanner({
  sessionId,
  requestId,
  occurrenceId,
  questions,
  isAsync,
  recoveryReason,
  recoveryAction,
  runnerOnline,
  responseRefusal: responseRefusalOverride,
  onSessionUpdate,
  showKeyHints = true,
}: {
  sessionId: string;
  requestId: string;
  occurrenceId?: string;
  questions: AgentQuestion[];
  isAsync?: boolean;
  recoveryReason?: "provider_restart";
  recoveryAction?: "resume_answer";
  runnerOnline: boolean;
  /** Why the signed-in person may not answer (#1857); read from the session's view by default. */
  responseRefusal?: string | null;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
}) {
  const api = useApi();
  const storedRefusal = useSessionResponseRefusal(sessionId);
  const responseRefusal = responseRefusalOverride === undefined ? storedRefusal : responseRefusalOverride;
  // A refused person reads the question like one whose runner is offline: every response control
  // is unavailable and the availability line says why. Runner Offline itself stays the runner's.
  const responsesAvailable = runnerOnline && responseRefusal === null;
  const responseStyle = useQuestionResponseStyle();
  const answerKey = isAsync && occurrenceId ? `${requestId}:${occurrenceId}` : requestId;
  const [busy, setBusy] = useState<"submit" | "dismiss" | null>(null);
  const [drafts, setDrafts] = useState<{
    requestId: string;
    values: Record<string, QuestionResponseDraft>;
  }>(() => ({
    requestId: answerKey,
    values: storedQuestionDrafts(sessionId, answerKey),
  }));
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationPendingRef = useRef<object | null>(null);
  const liveRequestRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    // Retire callbacks at commit, including when the same request is later remounted.
    liveRequestRef.current = {};
    operationPendingRef.current = null;
    return () => { liveRequestRef.current = null; };
  }, [answerKey, sessionId]);
  const questionBlockRefs = useRef(new Map<string, HTMLDivElement | null>());
  const previousDraftRequestRef = useRef({ sessionId, requestId: answerKey });
  // React's opaque useId contains colons. They are valid in HTML ids but break the selector-based
  // HTMLInputElement.list lookup used by some DOM implementations, so keep this idref family plain.
  const labelPrefix = useId().replace(/:/g, "");
  const availabilityId = `${labelPrefix}-availability`;
  const recoveryId = `${labelPrefix}-recovery`;
  const recoveryRequired = recoveryReason === "provider_restart";
  const recoveryCanResume = recoveryRequired && recoveryAction === "resume_answer";
  const recoveryRequiresDismiss = recoveryRequired && !recoveryCanResume;

  useEffect(() => {
    const previous = previousDraftRequestRef.current;
    if (previous.sessionId !== sessionId || previous.requestId !== answerKey) {
      clearQuestionDrafts(previous.sessionId, previous.requestId);
      clearQuestionDrafts(sessionId, answerKey);
      previousDraftRequestRef.current = { sessionId, requestId: answerKey };
      setDrafts({ requestId: answerKey, values: {} });
    } else {
      setDrafts({ requestId: answerKey, values: storedQuestionDrafts(sessionId, answerKey) });
    }
    setValidationAttempted(false);
    setBusy(null);
    setError(null);
  }, [answerKey, sessionId]);

  useEffect(() => {
    setDrafts({ requestId: answerKey, values: storedQuestionDrafts(sessionId, answerKey) });
    setValidationAttempted(false);
  }, [answerKey, responseStyle, sessionId]);

  const draftValues = drafts.requestId === answerKey ? drafts.values : {};
  const draftValue = (questionId: string) => Object.hasOwn(draftValues, questionId) ? draftValues[questionId] : undefined;
  const resolved = questionDraftAnswers(questions, draftValues);
  const unsupportedQuestionFormat = questions.some((question) => !isAnswerableAgentQuestion(question));
  const controlsDisabled = busy !== null || !responsesAvailable || unsupportedQuestionFormat || recoveryRequiresDismiss;
  const fixedChoicesNativelyDisabled = busy !== null || unsupportedQuestionFormat || recoveryRequiresDismiss;

  const updateDraft = (question: AgentQuestion, value: QuestionResponseDraft) => {
    setDrafts((current) => {
      const values = { ...(current.requestId === answerKey ? current.values : {}), [question.id]: value };
      const cacheable: Record<string, QuestionResponseDraft> = {};
      for (const candidate of questions) {
        if (candidate.secret || !Object.hasOwn(values, candidate.id)) continue;
        Object.defineProperty(cacheable, candidate.id, {
          value: values[candidate.id],
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      storeQuestionDrafts(sessionId, answerKey, cacheable);
      return { requestId: answerKey, values };
    });
  };

  const toggle = (question: AgentQuestion, label: string) => {
    const selected = questionDraftSelections(question, draftValue(question.id));
    const labels = question.multiSelect
      ? selected.includes(label) ? selected.filter((candidate) => candidate !== label) : [...selected, label]
      : [label];
    updateDraft(question, { kind: "choice", labels });
  };

  const complete = !unsupportedQuestionFormat && Object.keys(resolved.errors).length === 0;

  const submit = async () => {
    if (operationPendingRef.current || busy !== null || !responsesAvailable || unsupportedQuestionFormat || recoveryRequiresDismiss) return;
    if (Object.keys(resolved.errors).length > 0) {
      setValidationAttempted(true);
      const validatingRequest = liveRequestRef.current;
      const firstInvalid = questions.find((question) => Object.hasOwn(resolved.errors, question.id));
      window.requestAnimationFrame(() => {
        if (liveRequestRef.current !== validatingRequest) return;
        questionBlockRefs.current.get(firstInvalid?.id ?? "")
          ?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled):not([aria-disabled=true])")
          ?.focus();
      });
      return;
    }
    const releaseOperation = claimQuestionResponseOperation(sessionId, answerKey);
    if (!releaseOperation) {
      setError("Another response is already being submitted for this question.");
      return;
    }
    const submittedRequest = liveRequestRef.current;
    const operation = {};
    operationPendingRef.current = operation;
    setBusy("submit");
    setError(null);
    try {
      const updated = await api.answerQuestion(sessionId, {
        requestId, ...(occurrenceId ? { occurrenceId } : {}), answers: resolved.answers, action: "submit",
      });
      if (liveRequestRef.current !== submittedRequest) return;
      clearQuestionDrafts(sessionId, answerKey);
      onSessionUpdate?.(updated);
    } catch (cause) {
      if (liveRequestRef.current === submittedRequest) setError((cause as Error).message);
    } finally {
      releaseOperation();
      if (operationPendingRef.current === operation) operationPendingRef.current = null;
      if (liveRequestRef.current === submittedRequest) setBusy(null);
    }
  };

  const dismiss = async () => {
    if (operationPendingRef.current || busy !== null || !responsesAvailable) return;
    const releaseOperation = claimQuestionResponseOperation(sessionId, answerKey);
    if (!releaseOperation) {
      setError("Another response is already being submitted for this question.");
      return;
    }
    const submittedRequest = liveRequestRef.current;
    const operation = {};
    operationPendingRef.current = operation;
    setBusy("dismiss");
    setError(null);
    try {
      const updated = await api.answerQuestion(sessionId, {
        requestId, ...(occurrenceId ? { occurrenceId } : {}), answers: {}, action: "dismiss",
      });
      if (liveRequestRef.current !== submittedRequest) return;
      clearQuestionDrafts(sessionId, answerKey);
      onSessionUpdate?.(updated);
    } catch (cause) {
      if (liveRequestRef.current === submittedRequest) setError((cause as Error).message);
    } finally {
      releaseOperation();
      if (operationPendingRef.current === operation) operationPendingRef.current = null;
      if (liveRequestRef.current === submittedRequest) setBusy(null);
    }
  };

  return (
    <section
      className={`question-bar question-style-${responseStyle}`}
      aria-label="Agent Questions"
      aria-busy={busy !== null}
      onKeyDown={(event) => {
        if (responseStyle !== "interactive" || event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
        event.preventDefault();
        void submit();
      }}
    >
      <div className="question-main">
        <span className="question-icon" aria-hidden="true">❓</span>
        <span className="question-title">
          {isAsync ? "Async Agent Question" : recoveryRequired
            ? "Agent Question Recovery Required"
            : `The agent has ${questions.length === 1 ? "a question" : `${questions.length} questions`}`}
          {!runnerOnline && <span className="muted"> · Runner Offline</span>}
        </span>
        <div className="question-actions">
          <button
            className="btn ghost sm"
            type="button"
            data-session-request-control="dismiss"
            aria-describedby={!responsesAvailable ? availabilityId : undefined}
            disabled={busy !== null || !responsesAvailable}
            onClick={() => void dismiss()}
          >
            {busy === "dismiss" ? "Dismissing…" : recoveryRequired ? "Dismiss and Continue" : "Dismiss"} {showKeyHints && busy === null && <kbd>D</kbd>}
          </button>
          {responseStyle === "interactive" && questions.length > 0 && !recoveryRequiresDismiss && (
            <button
              className="btn sm primary"
              type="button"
              data-session-request-control="submit"
              aria-describedby={!responsesAvailable ? availabilityId : undefined}
              disabled={busy !== null || !responsesAvailable || !complete}
              onClick={() => void submit()}
            >
              {busy === "submit" ? "Submitting…" : "Submit"}
            </button>
          )}
        </div>
      </div>
      <div id={availabilityId} className="question-availability" role="status" aria-atomic="true">
        {responseRefusal ?? (runnerOnline ? "" : "Responses are unavailable until the runner reconnects.")}
      </div>
      {recoveryRequired && (
        <div className="question-recovery" id={recoveryId} role="status">
          {recoveryCanResume
            ? "The runner restarted after this question was asked. Submit the preserved form to resume the existing agent conversation and deliver these answers once. Prior tool calls will not be replayed."
            : "The runner restarted after this question was asked, so its original answer channel is no longer available. Review the preserved question, then dismiss it and send a new prompt to continue safely. No prior tool calls will be replayed."}
        </div>
      )}
      {responseStyle === "composer" && questions.length > 0 && !recoveryRequiresDismiss && (
        <div className="question-submit-hint">
          Respond through Answer Mode in the Session composer. Press R or use <code>/respond</code>.
        </div>
      )}
      {responseStyle === "interactive" && responsesAvailable && busy === null && questions.length > 0 && !complete && !recoveryRequiresDismiss && (
        <div className="question-submit-hint">
          {unsupportedQuestionFormat
            ? "This question format is unsupported. Dismiss the question to continue."
            : validationAttempted || Object.keys(resolved.errors).some((id) => questionDraftText(draftValue(id)).trim())
              ? "Correct the response errors before submitting."
              : "Complete all required responses before submitting."}
        </div>
      )}
      <div className="question-list">
        {questions.map((question, questionIndex) => {
          const questionLabelId = `${labelPrefix}-question-${questionIndex}`;
          const responseLabelId = `${labelPrefix}-response-${questionIndex}`;
          const contextId = `${labelPrefix}-context-${questionIndex}`;
          const requirementId = `${labelPrefix}-requirement-${questionIndex}`;
          const responseErrorId = `${labelPrefix}-response-error-${questionIndex}`;
          const offeredChoicesId = `${labelPrefix}-offered-choices-${questionIndex}`;
          const draft = draftValue(question.id);
          const rawValue = questionDraftText(draft);
          const selected = questionDraftSelections(question, draft);
          const responseError = Object.hasOwn(resolved.errors, question.id) ? resolved.errors[question.id] : undefined;
          const showResponseError = Boolean(responseError && (validationAttempted || rawValue.trim()));
          const controlDescriptionIds = [
            question.context ? contextId : null,
            requirementId,
            recoveryRequired ? recoveryId : null,
            !responsesAvailable ? availabilityId : null,
          ]
            .filter((value): value is string => value !== null);
          const inputDescriptionIds = [...controlDescriptionIds, showResponseError ? responseErrorId : null]
            .filter((value): value is string => value !== null)
            .join(" ");
          return (
            <div
              className="question-block"
              key={question.id}
              ref={(element) => { questionBlockRefs.current.set(question.id, element); }}
            >
              <div className="question-text" id={questionLabelId}>
                {question.header && <span className="question-chip">{question.header}</span>}
                <StructuredQuestionText>{question.question}</StructuredQuestionText>
                {question.multiSelect && <span className="muted sm"> (select all that apply)</span>}
              </div>
              <span className="sr-only" id={requirementId}>
                {question.required === false ? "This question is optional." : "An answer to this question is required."}
              </span>
              {question.context && (
                <div className="question-context" id={contextId}>
                  <StructuredQuestionText>{question.context}</StructuredQuestionText>
                </div>
              )}
              {responseStyle === "interactive" && question.options.length > 0 && (
                <div
                  className="question-options"
                  role={question.multiSelect ? "group" : "radiogroup"}
                  aria-labelledby={questionLabelId}
                  aria-describedby={inputDescriptionIds}
                  aria-required={question.multiSelect ? undefined : question.required !== false}
                  onKeyDown={question.multiSelect ? undefined : (event) => handleRovingChoiceKeyDown(
                    event,
                    "radio",
                    { includeAriaDisabled: !responsesAvailable, activate: responsesAvailable },
                  )}
                >
                  {question.options.map((option, optionIndex) => {
                    const on = selected.includes(option.label);
                    return (
                      <button
                        key={option.label}
                        type="button"
                        data-session-request-control={`question:${question.id}:option:${optionIndex}`}
                        role={question.multiSelect ? "checkbox" : "radio"}
                        aria-checked={on}
                        aria-disabled={controlsDisabled || undefined}
                        disabled={fixedChoicesNativelyDisabled}
                        tabIndex={fixedChoicesNativelyDisabled
                          ? -1
                          : question.multiSelect ? 0 : on || (selected.length === 0 && optionIndex === 0) ? 0 : -1}
                        className={`question-option${on ? " on" : ""}`}
                        title={option.description}
                        onClick={() => { if (!controlsDisabled) toggle(question, option.label); }}
                      >
                        <span className="question-mark" aria-hidden="true">{question.multiSelect ? (on ? "☑" : "☐") : on ? "●" : "○"}</span>
                        <span>
                          <span className="question-label">{option.label}</span>
                          {option.description && <span className="question-desc">{option.description}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {responseStyle === "interactive" && isAnswerableAgentQuestion(question) && (
                <label className="question-input-label">
                  <span id={responseLabelId}>{question.options.length > 0 ? "Other Response" : "Response"}</span>
                  {question.required === false && <span className="muted sm"> (optional)</span>}
                  <input
                    className="input question-input"
                    data-session-request-control={`question:${question.id}:input`}
                    aria-labelledby={`${questionLabelId} ${responseLabelId}`}
                    aria-describedby={inputDescriptionIds}
                    aria-invalid={showResponseError ? true : undefined}
                    aria-required={question.options.length === 0 ? question.required !== false : undefined}
                    required={question.options.length === 0 && question.required !== false}
                    disabled={controlsDisabled}
                    type={question.secret
                      ? "password"
                      : question.inputFormat === "date-time"
                        ? "datetime-local"
                        : question.inputFormat === "integer" || question.inputFormat === "number"
                          ? "number"
                          : question.inputFormat ?? "text"}
                    inputMode={question.inputFormat === "integer" ? "numeric" : question.inputFormat === "number" ? "decimal" : undefined}
                    step={question.inputFormat === "integer" ? 1 : question.inputFormat === "number" ? "any" : undefined}
                    min={question.minimum}
                    max={question.maximum}
                    minLength={question.minLength}
                    maxLength={question.maxLength ?? DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH}
                    value={draft?.kind === "other" || (draft?.kind === "entry"
                      && (question.options.length === 0 || (!question.multiSelect && question.allowOther && selected.length === 0)))
                      ? rawValue : ""}
                    autoComplete="off"
                    onChange={(event) => updateDraft(question, { kind: "other", value: event.target.value })}
                  />
                  {showResponseError && (
                    <span className="form-error question-field-error" id={responseErrorId} role="alert">
                      {responseError}
                    </span>
                  )}
                </label>
              )}
              {responseStyle === "composer" && question.options.length > 0 && (
                <>
                  <ol className="question-text-options" id={offeredChoicesId} aria-label="Offered Choices">
                    {question.options.map((option) => (
                      <li key={option.label}>
                        <span className="question-label">{option.label}</span>
                        {option.description && <span className="question-desc">{option.description}</span>}
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          );
        })}
      </div>
      {error && <div className="form-error" role="alert">Could not answer the question: {error}</div>}
    </section>
  );
}
