import React, { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  isPolicyApproval,
  validateQuestionFreeText,
  type AgentQuestion,
  type ApprovalContext,
  type SessionView,
} from "@wollipog/protocol";
import { useApi } from "../api-context.js";
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
  const [announcement, setAnnouncement] = useState("");
  const requestId = session.pendingApproval?.requestId ?? null;
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
    previousRequestRef.current = requestId;
    setAnnouncement(requestId ? (hadRequest ? "Agent request updated" : "Agent response required") : "Agent request resolved");
    if (focusDestination === "request") {
      const target = regionRef.current?.querySelector<HTMLElement>(
        'button:not(:disabled), [role="radio"][tabindex="0"], [role="checkbox"]:not([aria-disabled="true"]), input:not(:disabled)',
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

/** Structured agent questions with explicit radio/checkbox semantics and request-keyed state. */
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
  const [busy, setBusy] = useState<"submit" | "dismiss" | null>(null);
  const [selection, setSelection] = useState<QuestionSelectionState>({ requestId, picked: {} });
  const [drafts, setDrafts] = useState<{ requestId: string; values: Record<string, string> }>({ requestId, values: {} });
  const [error, setError] = useState<string | null>(null);
  const labelPrefix = useId();

  useEffect(() => {
    setSelection({ requestId, picked: {} });
    setDrafts({ requestId, values: {} });
    setBusy(null);
    setError(null);
  }, [requestId]);

  const picked = questionSelectionForRequest(selection, requestId);
  const draftValues = drafts.requestId === requestId ? drafts.values : {};

  const toggle = (question: AgentQuestion, label: string) => {
    setSelection((current) => {
      const currentPicked = questionSelectionForRequest(current, requestId);
      const previous = currentPicked[question.id] ?? [];
      if (question.multiSelect) {
        return {
          requestId,
          picked: {
            ...currentPicked,
            [question.id]: previous.includes(label)
              ? previous.filter((item) => item !== label)
              : [...previous, label],
          },
        };
      }
      return { requestId, picked: { ...currentPicked, [question.id]: [label] } };
    });
  };

  const updateDraft = (question: AgentQuestion, value: string) => {
    setDrafts((current) => ({
      requestId,
      values: { ...(current.requestId === requestId ? current.values : {}), [question.id]: value },
    }));
    if (value && !question.multiSelect) {
      setSelection((current) => {
        const currentPicked = questionSelectionForRequest(current, requestId);
        return { requestId, picked: { ...currentPicked, [question.id]: [] } };
      });
    }
  };

  const complete = questions.every((question) => {
    const selected = picked[question.id] ?? [];
    const draft = draftValues[question.id]?.trim() ?? "";
    if (question.multiSelect) {
      if (selected.length === 0 && question.required === false) return true;
      const minimum = question.minSelections ?? (question.required === false ? 0 : 1);
      return selected.length >= minimum && (question.maxSelections == null || selected.length <= question.maxSelections);
    }
    if (selected.length > 0) return true;
    if (!draft) return question.required === false;
    return question.allowOther === true && validateQuestionFreeText(question, draft) == null;
  });

  const submit = async () => {
    setBusy("submit");
    setError(null);
    try {
      const answers: Record<string, string | string[]> = {};
      for (const question of questions) {
        const selected = picked[question.id] ?? [];
        const draft = draftValues[question.id]?.trim() ?? "";
        if (selected.length > 0) answers[question.id] = question.multiSelect ? selected : selected[0]!;
        else if (question.allowOther && draft) answers[question.id] = draft;
        else if (question.required !== false) answers[question.id] = question.multiSelect ? [] : "";
      }
      const updated = await api.answerQuestion(sessionId, { requestId, answers, action: "submit" });
      onSessionUpdate?.(updated);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    setBusy("dismiss");
    setError(null);
    try {
      const updated = await api.answerQuestion(sessionId, { requestId, answers: {}, action: "dismiss" });
      onSessionUpdate?.(updated);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="approval-bar question-bar" aria-label="Agent Questions" aria-busy={busy !== null}>
      <div className="approval-main">
        <span className="approval-icon" aria-hidden="true">❓</span>
        <span className="approval-text">
          The agent has {questions.length === 1 ? "a question" : `${questions.length} questions`}
          {!runnerOnline && <span className="muted"> · Runner Offline</span>}
        </span>
        <div className="approval-actions">
          <button className="btn ghost sm" type="button" disabled={busy !== null || !runnerOnline} onClick={() => void dismiss()}>
            {busy === "dismiss" ? "Dismissing…" : "Dismiss"} {showKeyHints && busy === null && <kbd className="inbox-key-hint">D</kbd>}
          </button>
          {questions.length > 0 && (
            <button className="btn sm primary" type="button" disabled={busy !== null || !runnerOnline || !complete} onClick={() => void submit()}>
              {busy === "submit" ? "Submitting…" : "Submit"}
            </button>
          )}
        </div>
      </div>
      {questions[0]?.context && <div className="question-context">{questions[0].context}</div>}
      <div className="question-list">
        {questions.map((question, questionIndex) => {
          const questionLabelId = `${labelPrefix}-question-${questionIndex}`;
          const responseLabelId = `${labelPrefix}-response-${questionIndex}`;
          const selected = picked[question.id] ?? [];
          return (
            <div className="question-block" key={question.id}>
              <div className="question-text" id={questionLabelId}>
                {question.header && <span className="question-chip">{question.header}</span>}
                {question.question}
                {question.multiSelect && <span className="muted sm"> (select all that apply)</span>}
              </div>
              {question.options.length > 0 && (
                <div
                  className="question-options"
                  role={question.multiSelect ? "group" : "radiogroup"}
                  aria-labelledby={questionLabelId}
                  onKeyDown={question.multiSelect ? undefined : (event) => handleRovingChoiceKeyDown(event, "radio")}
                >
                  {question.options.map((option, optionIndex) => {
                    const on = selected.includes(option.label);
                    return (
                      <button
                        key={option.label}
                        type="button"
                        role={question.multiSelect ? "checkbox" : "radio"}
                        aria-checked={on}
                        tabIndex={question.multiSelect ? 0 : on || (selected.length === 0 && optionIndex === 0) ? 0 : -1}
                        className={`question-option${on ? " on" : ""}`}
                        title={option.description}
                        onClick={() => toggle(question, option.label)}
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
              {question.allowOther && (
                <label className="question-input-label">
                  <span id={responseLabelId}>{question.options.length > 0 ? "Other Response" : "Response"}</span>
                  {question.required === false && <span className="muted sm"> (optional)</span>}
                  <input
                    className="input question-input"
                    aria-labelledby={`${questionLabelId} ${responseLabelId}`}
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
                    maxLength={question.maxLength}
                    value={draftValues[question.id] ?? ""}
                    autoComplete="off"
                    onChange={(event) => updateDraft(question, event.target.value)}
                  />
                </label>
              )}
            </div>
          );
        })}
      </div>
      {error && <div className="form-error" role="alert">Could not answer the question: {error}</div>}
    </section>
  );
}
