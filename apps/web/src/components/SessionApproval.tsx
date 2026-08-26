import React, { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH,
  isPolicyApproval,
  isSupportedAgentQuestion,
  type AgentQuestion,
  type ApprovalContext,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  clearQuestionDrafts,
  questionAnswers,
  resolveQuestionResponse,
  storedQuestionDrafts,
  storeQuestionDrafts,
  toggleQuestionChoice,
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
}: {
  session: SessionView;
  runnerOnline: boolean;
  fallbackFocusRef: RefObject<HTMLElement>;
  alternateFallbackFocusRef?: RefObject<HTMLElement>;
  onSessionUpdate?: (session: SessionView) => void;
  showKeyHints?: boolean;
}) {
  const regionRef = useRef<HTMLDivElement>(null);
  const focusOwnedRef = useRef(false);
  const previousRequestRef = useRef<string | null>(null);
  const previousRunnerOnlineRef = useRef(runnerOnline);
  const [announcement, setAnnouncement] = useState("");
  const requestId = session.pendingApproval?.requestId ?? null;
  const requestWasUnchangedBeforeRender = previousRequestRef.current === requestId;
  const focusedElementBeforeRender = typeof document !== "undefined"
    && focusOwnedRef.current
    && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const focusFallback = () => {
    const primary = fallbackFocusRef.current;
    const target = primary && !primary.matches(":disabled") ? primary : alternateFallbackFocusRef?.current;
    target?.focus();
  };

  useIsomorphicLayoutEffect(() => {
    if (previousRequestRef.current === requestId) return;
    const hadFocus = focusOwnedRef.current;
    const hadRequest = previousRequestRef.current !== null;
    const focusDestination = approvalFocusDestination(previousRequestRef.current, requestId, hadFocus);
    if (previousRequestRef.current) clearQuestionDrafts(session.id, previousRequestRef.current);
    previousRequestRef.current = requestId;
    setAnnouncement(requestId ? (hadRequest ? "Agent request updated" : "Agent response required") : "Agent request resolved");
    if (focusDestination === "request") {
      const target = regionRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled):not([aria-disabled="true"]), [role="radio"][tabindex="0"]:not(:disabled):not([aria-disabled="true"]), [role="checkbox"]:not([aria-disabled="true"]), input:not(:disabled)',
      );
      if (target) {
        target.focus();
        focusOwnedRef.current = true;
      } else {
        focusFallback();
        focusOwnedRef.current = false;
      }
      return;
    }
    if (focusDestination === "fallback") {
      focusFallback();
      focusOwnedRef.current = false;
    }
  }, [alternateFallbackFocusRef, fallbackFocusRef, requestId]);

  useIsomorphicLayoutEffect(() => {
    const wentOffline = previousRunnerOnlineRef.current && !runnerOnline;
    previousRunnerOnlineRef.current = runnerOnline;
    if (!wentOffline || !requestWasUnchangedBeforeRender || !focusedElementBeforeRender) return;
    if (!focusedElementBeforeRender.matches(":disabled")
      && focusedElementBeforeRender.getAttribute("aria-disabled") !== "true") return;
    focusFallback();
    focusOwnedRef.current = false;
  }, [alternateFallbackFocusRef, fallbackFocusRef, focusedElementBeforeRender, requestWasUnchangedBeforeRender, runnerOnline]);

  return (
    <div
      ref={regionRef}
      onFocusCapture={() => { focusOwnedRef.current = true; }}
      onBlurCapture={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          focusOwnedRef.current = false;
        }
      }}
    >
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
      {session.pendingApproval && (
        <SessionApprovalBanner
          key={session.pendingApproval.requestId}
          session={session}
          runnerOnline={runnerOnline}
          onSessionUpdate={onSessionUpdate}
          showKeyHints={showKeyHints}
        />
      )}
    </div>
  );
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
          {approval.kind === "cost_budget" ? "💰" : approval.kind === "max_tool_calls" ? "🧰" : approval.kind === "authentication" ? "🔑" : "🔐"}
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
  const [drafts, setDrafts] = useState<{ requestId: string; values: Record<string, string> }>(() => ({
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

  const draftValues = drafts.requestId === requestId ? drafts.values : {};
  const draftValue = (questionId: string) => Object.hasOwn(draftValues, questionId) ? draftValues[questionId]! : "";
  const resolved = questionAnswers(questions, draftValues);
  const unsupportedQuestionFormat = questions.some((question) => !isSupportedAgentQuestion(question));
  const controlsDisabled = busy !== null || !runnerOnline || unsupportedQuestionFormat;
  const fixedChoicesNativelyDisabled = busy !== null || unsupportedQuestionFormat;

  const updateDraft = (question: AgentQuestion, value: string) => {
    setDrafts((current) => {
      const values = { ...(current.requestId === requestId ? current.values : {}), [question.id]: value };
      storeQuestionDrafts(sessionId, requestId, values);
      return { requestId, values };
    });
  };

  const toggle = (question: AgentQuestion, label: string) => {
    updateDraft(question, toggleQuestionChoice(question, draftValue(question.id), label));
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
        if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
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
            aria-describedby={!runnerOnline ? availabilityId : undefined}
            disabled={busy !== null || !runnerOnline}
            onClick={() => void dismiss()}
          >
            {busy === "dismiss" ? "Dismissing…" : "Dismiss"} {showKeyHints && busy === null && <kbd className="inbox-key-hint">D</kbd>}
          </button>
          {questions.length > 0 && (
            <button
              className="btn sm primary"
              type="button"
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
      {runnerOnline && busy === null && questions.length > 0 && !complete && (
        <div className="question-submit-hint">
          {unsupportedQuestionFormat
            ? "This question format is unsupported. Dismiss the question to continue."
            : validationAttempted || Object.keys(resolved.errors).some((id) => draftValue(id).trim())
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
          const rawValue = draftValue(question.id);
          const answer = resolveQuestionResponse(question, rawValue).answer;
          const selected = Array.isArray(answer)
            ? answer
            : question.options.some((option) => option.label === answer) ? [answer as string] : [];
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
                  aria-describedby={controlDescriptionIds.join(" ")}
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
              {responseStyle === "interactive" && question.allowOther && !question.multiSelect && (
                <label className="question-input-label">
                  <span id={responseLabelId}>{question.options.length > 0 ? "Other Response" : "Response"}</span>
                  {question.required === false && <span className="muted sm"> (optional)</span>}
                  <input
                    className="input question-input"
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
                    value={selected.length > 0 ? "" : rawValue}
                    autoComplete="off"
                    onChange={(event) => updateDraft(question, event.target.value)}
                  />
                  {showResponseError && (
                    <span className="form-error question-field-error" id={responseErrorId} role="alert">
                      {responseError}
                    </span>
                  )}
                </label>
              )}
              {responseStyle === "text" && (
                <>
                  {question.options.length > 0 && (
                    <ol className="question-text-options" aria-label="Offered Choices">
                      {question.options.map((option) => (
                        <li key={option.label}>
                          <span className="question-label">{option.label}</span>
                          {option.description && <span className="question-desc">{option.description}</span>}
                        </li>
                      ))}
                    </ol>
                  )}
                  <label className="question-input-label">
                    <span id={responseLabelId}>Response</span>
                    {question.required === false && <span className="muted sm"> (optional)</span>}
                    <input
                      className="input question-input question-text-input"
                      aria-labelledby={`${questionLabelId} ${responseLabelId}`}
                      aria-describedby={inputDescriptionIds}
                      aria-invalid={showResponseError ? true : undefined}
                      aria-required={question.required !== false}
                      required={question.required !== false}
                      disabled={controlsDisabled}
                      type={question.secret ? "password" : "text"}
                      inputMode={question.inputFormat === "integer" ? "numeric" : question.inputFormat === "number" ? "decimal" : undefined}
                      maxLength={question.allowOther ? question.maxLength ?? DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH : undefined}
                      value={rawValue}
                      autoComplete="off"
                      list={!question.secret && question.options.length > 0 ? `${labelPrefix}-choices-${questionIndex}` : undefined}
                      placeholder={question.multiSelect ? "Numbers or labels, separated by commas" : question.options.length > 0 ? "Number or label" : undefined}
                      onChange={(event) => updateDraft(question, event.target.value)}
                    />
                    {!question.secret && question.options.length > 0 && (
                      <datalist id={`${labelPrefix}-choices-${questionIndex}`}>
                        {question.options.map((option, optionIndex) => (
                          <option key={option.label} value={option.label}>{optionIndex + 1}. {option.label}</option>
                        ))}
                      </datalist>
                    )}
                    {showResponseError && (
                      <span className="form-error question-field-error" id={responseErrorId} role="alert">
                        {responseError}
                      </span>
                    )}
                  </label>
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
