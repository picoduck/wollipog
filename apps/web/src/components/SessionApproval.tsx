import React, { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH,
  isPolicyApproval,
  type AgentQuestion,
  type ApprovalContext,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  clearQuestionDrafts,
  isAnswerableAgentQuestion,
  questionDraftAnswers,
  questionDraftSelections,
  questionDraftText,
  storedQuestionDrafts,
  storeQuestionDrafts,
  type QuestionResponseDraft,
} from "../question-response.js";
import { useQuestionResponseStyle } from "../question-response-style.js";
import { handleRovingChoiceKeyDown } from "./interactions.js";

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

export function approvalKeyHintForOption(
  options: readonly { optionId: string; kind?: string }[],
  optionId: string,
): "A" | "D" | null {
  const option = options.find((candidate) => candidate.optionId === optionId);
  if (option?.kind !== "allow_once" && option?.kind !== "reject_once") return null;
  if (options.filter((candidate) => candidate.kind === option.kind).length !== 1) return null;
  return option.kind === "allow_once" ? "A" : "D";
}

export function ApprovalSelectorContext({ context }: { context?: ApprovalContext }) {
  const selectors = [
    { key: "tool", label: "Tool", value: context?.toolName },
    { key: "path", label: "Path", value: context?.path },
    { key: "network", label: "Network", value: context?.network },
    { key: "branch", label: "Branch", value: context?.branch },
  ].filter((selector): selector is { key: string; label: string; value: string } =>
    typeof selector.value === "string" && selector.value.length > 0);
  if (!selectors.length) return null;

  return (
    <dl className="approval-selector-context" aria-label="Policy Match Context">
      {selectors.map((selector) => (
        <div className="approval-selector-card" data-selector={selector.key} key={selector.key}>
          <dt>{selector.label}</dt>
          <dd>{selector.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Stable focus/live boundary across coalesced approval replacement and final resolution. */
export function SessionApprovalRegion({
  session,
  runnerOnline,
  fallbackFocusRef,
  alternateFallbackFocusRef,
  onSessionUpdate,
  showKeyHints = true,
  questionInTimeline = false,
}: {
  session: SessionView;
  runnerOnline: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  alternateFallbackFocusRef?: RefObject<HTMLElement | null>;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
  /** Whether the pending question already has an authoritative transcript row. */
  questionInTimeline?: boolean;
}) {
  const approval = session.pendingApproval;
  const questionFallback = approval?.kind === "question" && !questionInTimeline;
  const standaloneApproval = approval?.kind === "question" ? null : approval;
  const requestPresentation = questionFallback ? "fallback" : approval?.kind === "question"
    ? "timeline" : standaloneApproval ? "standalone" : "none";
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
      />
      {standaloneApproval && (
        <div data-session-request-id={standaloneApproval.requestId} data-session-request-session={session.id}>
          <SessionApprovalBanner
            key={standaloneApproval.requestId}
            session={session}
            runnerOnline={runnerOnline}
            onSessionUpdate={onSessionUpdate}
            showKeyHints={showKeyHints}
          />
        </div>
      )}
      {questionFallback && (
        <div data-session-request-id={approval.requestId} data-session-request-session={session.id}>
          <SessionQuestionBanner
            key={approval.requestId}
            sessionId={session.id}
            requestId={approval.requestId}
            questions={approval.questions ?? []}
            runnerOnline={runnerOnline}
            onSessionUpdate={onSessionUpdate}
            showKeyHints={showKeyHints}
          />
        </div>
      )}
    </>
  );
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
  pendingQuestion: { requestId: string; questions: AgentQuestion[] } | null;
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
          questions={approval.questions.length > 0 ? approval.questions : eventQuestions}
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
  return controls.find((control) => control.dataset.sessionRequestControl === preferredControl) ?? controls[0] ?? null;
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
}: {
  sessionId: string;
  requestId: string | null;
  requestIsQuestion: boolean;
  requestPresentation: "fallback" | "timeline" | "standalone" | "none";
  runnerOnline: boolean;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  alternateFallbackFocusRef?: RefObject<HTMLElement | null>;
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
  }, [alternateFallbackFocusRef, fallbackFocusRef, ownedFocusBeforeRender, requestId, requestIsQuestion,
    requestPresentation, sessionId]);

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
  }, [alternateFallbackFocusRef, fallbackFocusRef, focusedElementBeforeRender, ownedFocusBeforeRender,
    requestId, requestWasUnchangedBeforeRender, runnerOnline]);

  return <span className="sr-only" role="status" aria-live="polite">{announcement}</span>;
}

export function SessionApprovalBanner({
  session,
  runnerOnline,
  onSessionUpdate,
  showKeyHints = true,
}: {
  session: SessionView;
  runnerOnline: boolean;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [showContext, setShowContext] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const approval = session.pendingApproval!;
  const contextId = useId();
  const isPolicy = isPolicyApproval(approval);
  const decisionNeedsRunner = approval.kind !== "policy_hook";

  const decide = async (optionId: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const updated = await api.approve(session.id, { requestId: approval.requestId, optionId });
      onSessionUpdate?.(updated);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (approval.kind === "question") {
    return (
      <SessionQuestionBanner
        sessionId={session.id}
        requestId={approval.requestId}
        questions={approval.questions ?? []}
        runnerOnline={runnerOnline}
        onSessionUpdate={onSessionUpdate}
        showKeyHints={showKeyHints}
      />
    );
  }

  return (
    <section
      className={`approval-bar${isPolicy ? " cost-budget" : ""}`}
      aria-label={approval.kind === "authentication" ? "Authentication Required" : "Agent Approval Required"}
    >
      <div className="approval-main">
        <span className="approval-icon" aria-hidden="true">
          {approval.kind === "cost_budget" || approval.kind === "cost_checkpoint" ? "💰"
            : approval.kind === "daily_budget" ? "📅"
              : approval.kind === "cost_unpriced" ? "❓"
                : approval.kind === "max_tool_calls" ? "🧰" : approval.kind === "authentication" ? "🔑" : "🔐"}
        </span>
        <span className="approval-text">
          {approval.title}
          {!runnerOnline && decisionNeedsRunner && <span className="muted"> · Runner Offline</span>}
        </span>
        <div className="approval-actions">
          {approval.context?.input && (
            <button
              className="btn ghost sm"
              type="button"
              aria-expanded={showContext}
              aria-controls={contextId}
              onClick={() => setShowContext((value) => !value)}
            >
              {showContext ? "Hide Details" : "Details"}
            </button>
          )}
          {approval.options.map((option) => {
            const keyHint = showKeyHints ? approvalKeyHintForOption(approval.options, option.optionId) : null;
            return (
              <button
                key={option.optionId}
                type="button"
                title={option.description}
                className={`btn sm ${option.kind?.startsWith("allow") ? "primary" : "danger"}`}
                disabled={busy || (decisionNeedsRunner && !runnerOnline)}
                onClick={() => void decide(option.optionId)}
              >
                {option.name}
                {keyHint && <kbd className="inbox-key-hint">{keyHint}</kbd>}
              </button>
            );
          })}
        </div>
      </div>
      {approval.kind === "policy_hook" && (
        <ApprovalSelectorContext context={approval.context} />
      )}
      {showContext && approval.context?.input && (
        <pre className="approval-context" id={contextId}>{approval.context.input}</pre>
      )}
      {error && <div className="form-error" role="alert">Approval failed: {error}</div>}
    </section>
  );
}

/** Structured agent questions with two presentations over one request-keyed canonical draft. */
export function SessionQuestionBanner({
  sessionId,
  requestId,
  questions,
  runnerOnline,
  onSessionUpdate,
  showKeyHints = true,
}: {
  sessionId: string;
  requestId: string;
  questions: AgentQuestion[];
  runnerOnline: boolean;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
}) {
  const api = useApi();
  const responseStyle = useQuestionResponseStyle();
  const [busy, setBusy] = useState<"submit" | "dismiss" | null>(null);
  const [drafts, setDrafts] = useState<{
    requestId: string;
    values: Record<string, QuestionResponseDraft>;
  }>(() => ({
    requestId,
    values: storedQuestionDrafts(sessionId, requestId),
  }));
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operationPendingRef = useRef(false);
  const questionBlockRefs = useRef(new Map<string, HTMLDivElement | null>());
  const previousDraftRequestRef = useRef({ sessionId, requestId });
  // React's opaque useId contains colons. They are valid in HTML ids but break the selector-based
  // HTMLInputElement.list lookup used by some DOM implementations, so keep this idref family plain.
  const labelPrefix = useId().replace(/:/g, "");
  const availabilityId = `${labelPrefix}-availability`;

  useEffect(() => {
    const previous = previousDraftRequestRef.current;
    if (previous.sessionId !== sessionId || previous.requestId !== requestId) {
      clearQuestionDrafts(previous.sessionId, previous.requestId);
      clearQuestionDrafts(sessionId, requestId);
      previousDraftRequestRef.current = { sessionId, requestId };
      setDrafts({ requestId, values: {} });
    } else {
      setDrafts({ requestId, values: storedQuestionDrafts(sessionId, requestId) });
    }
    setValidationAttempted(false);
    setBusy(null);
    setError(null);
  }, [requestId, sessionId]);

  useEffect(() => {
    setDrafts({ requestId, values: storedQuestionDrafts(sessionId, requestId) });
    setValidationAttempted(false);
  }, [requestId, responseStyle, sessionId]);

  const draftValues = drafts.requestId === requestId ? drafts.values : {};
  const draftValue = (questionId: string) => Object.hasOwn(draftValues, questionId) ? draftValues[questionId] : undefined;
  const resolved = questionDraftAnswers(questions, draftValues);
  const unsupportedQuestionFormat = questions.some((question) => !isAnswerableAgentQuestion(question));
  const controlsDisabled = busy !== null || !runnerOnline || unsupportedQuestionFormat;
  const fixedChoicesNativelyDisabled = busy !== null || unsupportedQuestionFormat;

  const updateDraft = (question: AgentQuestion, value: QuestionResponseDraft) => {
    setDrafts((current) => {
      const values = { ...(current.requestId === requestId ? current.values : {}), [question.id]: value };
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
      storeQuestionDrafts(sessionId, requestId, cacheable);
      return { requestId, values };
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
    if (operationPendingRef.current || busy !== null || !runnerOnline || unsupportedQuestionFormat) return;
    if (Object.keys(resolved.errors).length > 0) {
      setValidationAttempted(true);
      const firstInvalid = questions.find((question) => Object.hasOwn(resolved.errors, question.id));
      window.requestAnimationFrame(() => {
        questionBlockRefs.current.get(firstInvalid?.id ?? "")
          ?.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled):not([aria-disabled=true])")
          ?.focus();
      });
      return;
    }
    operationPendingRef.current = true;
    setBusy("submit");
    setError(null);
    try {
      const updated = await api.answerQuestion(sessionId, { requestId, answers: resolved.answers, action: "submit" });
      clearQuestionDrafts(sessionId, requestId);
      onSessionUpdate?.(updated);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      operationPendingRef.current = false;
      setBusy(null);
    }
  };

  const dismiss = async () => {
    if (operationPendingRef.current || busy !== null || !runnerOnline) return;
    operationPendingRef.current = true;
    setBusy("dismiss");
    setError(null);
    try {
      const updated = await api.answerQuestion(sessionId, { requestId, answers: {}, action: "dismiss" });
      clearQuestionDrafts(sessionId, requestId);
      onSessionUpdate?.(updated);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      operationPendingRef.current = false;
      setBusy(null);
    }
  };

  return (
    <section
      className={`approval-bar question-bar question-style-${responseStyle}`}
      aria-label="Agent Questions"
      aria-busy={busy !== null}
      onKeyDown={(event) => {
        if (responseStyle !== "interactive" || event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
        event.preventDefault();
        void submit();
      }}
    >
      <div className="approval-main">
        <span className="approval-icon" aria-hidden="true">❓</span>
        <span className="approval-text">
          The agent has {questions.length === 1 ? "a question" : `${questions.length} questions`}
          {!runnerOnline && <span className="muted"> · Runner Offline</span>}
        </span>
        <div className="approval-actions">
          <button
            className="btn ghost sm"
            type="button"
            data-session-request-control="dismiss"
            aria-describedby={!runnerOnline ? availabilityId : undefined}
            disabled={busy !== null || !runnerOnline}
            onClick={() => void dismiss()}
          >
            {busy === "dismiss" ? "Dismissing…" : "Dismiss"} {showKeyHints && busy === null && <kbd className="inbox-key-hint">D</kbd>}
          </button>
          {responseStyle === "interactive" && questions.length > 0 && (
            <button
              className="btn sm primary"
              type="button"
              data-session-request-control="submit"
              aria-describedby={!runnerOnline ? availabilityId : undefined}
              disabled={busy !== null || !runnerOnline || !complete}
              onClick={() => void submit()}
            >
              {busy === "submit" ? "Submitting…" : "Submit"}
            </button>
          )}
        </div>
      </div>
      <div id={availabilityId} className="question-availability" role="status" aria-atomic="true">
        {runnerOnline ? "" : "Responses are unavailable until the runner reconnects."}
      </div>
      {responseStyle === "composer" && (
        <div className="question-submit-hint">
          Respond through Answer Mode in the Session composer. Press R or use <code>/respond</code>.
        </div>
      )}
      {responseStyle === "interactive" && runnerOnline && busy === null && questions.length > 0 && !complete && (
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
            !runnerOnline ? availabilityId : null,
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
                {question.question}
                {question.multiSelect && <span className="muted sm"> (select all that apply)</span>}
              </div>
              <span className="sr-only" id={requirementId}>
                {question.required === false ? "This question is optional." : "An answer to this question is required."}
              </span>
              {question.context && <div className="question-context" id={contextId}>{question.context}</div>}
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
                    { includeAriaDisabled: !runnerOnline, activate: runnerOnline },
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
              {responseStyle === "interactive" && question.options.length > 0 && !question.allowOther && showResponseError && (
                <span className="form-error question-field-error" id={responseErrorId} role="alert">
                  {responseError}
                </span>
              )}
              {responseStyle === "interactive" && question.allowOther && !question.multiSelect && (
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
                    value={draft?.kind === "other" || (draft?.kind === "entry" && selected.length === 0) ? rawValue : ""}
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
