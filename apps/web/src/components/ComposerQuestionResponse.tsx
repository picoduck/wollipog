import {
  DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH,
  type AgentQuestion,
  type SessionView,
} from "@wollipog/protocol";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useApi } from "../api-context.js";
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
import { Spinner } from "./common.js";

export interface ComposerQuestionResponseProps {
  sessionId: string;
  requestId: string;
  questions: AgentQuestion[];
  runnerOnline: boolean;
  active: boolean;
  showWaiting: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onEnter: () => void;
  onExit: () => void;
  onSessionUpdate?: (session: SessionView) => void;
}

function withDraft(
  values: Record<string, QuestionResponseDraft>,
  questionId: string,
  draft: QuestionResponseDraft,
): Record<string, QuestionResponseDraft> {
  const next = { ...values };
  Object.defineProperty(next, questionId, {
    value: draft,
    configurable: true,
    enumerable: true,
    writable: true,
  });
  return next;
}

/** Persist page-lifetime answer drafts without ever putting secret values in shared storage. */
function persistDrafts(
  sessionId: string,
  requestId: string,
  questions: readonly AgentQuestion[],
  values: Record<string, QuestionResponseDraft>,
): void {
  const cacheable: Record<string, QuestionResponseDraft> = {};
  for (const question of questions) {
    if (question.secret || !Object.hasOwn(values, question.id)) continue;
    Object.defineProperty(cacheable, question.id, {
      value: values[question.id],
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  storeQuestionDrafts(sessionId, requestId, cacheable);
}

function focusSoon(ref: RefObject<HTMLInputElement | null>): void {
  window.requestAnimationFrame(() => ref.current?.focus());
}

/** A request-correlated answer flow inside the composer shell, kept separate from message drafts. */
export function ComposerQuestionResponse({
  sessionId,
  requestId,
  questions,
  runnerOnline,
  active,
  showWaiting,
  inputRef,
  onEnter,
  onExit,
  onSessionUpdate,
}: ComposerQuestionResponseProps) {
  const api = useApi();
  const ids = useId().replace(/:/g, "");
  const [draftState, setDraftState] = useState(() => ({
    requestId,
    values: storedQuestionDrafts(sessionId, requestId),
  }));
  const [questionIndex, setQuestionIndex] = useState(0);
  const [paletteFocusIndex, setPaletteFocusIndex] = useState(0);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operationPendingRef = useRef<string | null>(null);
  const previousActiveRef = useRef(active);
  const liveRequestRef = useRef(requestId);
  liveRequestRef.current = requestId;

  useEffect(() => {
    setDraftState({ requestId, values: storedQuestionDrafts(sessionId, requestId) });
    setQuestionIndex(0);
    setPaletteFocusIndex(0);
    setValidationError(null);
    setSubmissionError(null);
    setBusy(false);
    operationPendingRef.current = null;
  }, [requestId, sessionId]);

  useEffect(() => {
    const entering = active && !previousActiveRef.current;
    previousActiveRef.current = active;
    if (!entering) return;
    const stored = storedQuestionDrafts(sessionId, requestId);
    setDraftState((current) => {
      const values = current.requestId === requestId ? { ...current.values } : {};
      // Interactive Form may have changed non-secret answers while this mounted composer surface
      // was inactive. Merge those exact drafts without erasing a page-only secret kept here.
      for (const question of questions) {
        if (question.secret || !Object.hasOwn(stored, question.id)) continue;
        Object.defineProperty(values, question.id, {
          value: stored[question.id],
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      return { requestId, values };
    });
  }, [active, questions, requestId, sessionId]);

  if (questions.length === 0) return null;
  if (!active) {
    return showWaiting ? (
      <div className="composer-question-waiting" role="status">
        <div>
          <strong>Question Waiting</strong>
          <span>Your message draft is preserved. Press R to respond through the composer.</span>
        </div>
        <button className="btn primary sm" type="button" onClick={onEnter}>Respond</button>
      </div>
    ) : null;
  }

  const currentIndex = Math.min(questionIndex, questions.length - 1);
  const question = questions[currentIndex]!;
  const values = draftState.requestId === requestId ? draftState.values : {};
  const currentDraft = Object.hasOwn(values, question.id) ? values[question.id] : undefined;
  const rawValue = questionDraftText(currentDraft);
  const questionLabelId = `${ids}-composer-question`;
  const questionHelpId = `${ids}-composer-help`;
  const questionErrorId = `${ids}-composer-error`;
  const choicesId = `${ids}-composer-choices`;
  const unsupported = !isAnswerableAgentQuestion(question);
  const controlsDisabled = busy || !runnerOnline || unsupported;

  const updateDraft = (draft: QuestionResponseDraft): Record<string, QuestionResponseDraft> => {
    const next = withDraft(values, question.id, draft);
    setDraftState({ requestId, values: next });
    persistDrafts(sessionId, requestId, questions, next);
    setValidationError(null);
    setSubmissionError(null);
    return next;
  };

  const update = (raw: string): Record<string, QuestionResponseDraft> => {
    const draft = { kind: "entry", value: raw } as const;
    const next = updateDraft(draft);
    if (!question.multiSelect) {
      const selected = questionDraftSelections(question, draft)[0];
      const selectedIndex = question.options.findIndex((option) => option.label === selected);
      if (selectedIndex >= 0) setPaletteFocusIndex(selectedIndex);
    }
    return next;
  };

  const submitAnswers = async (next: Record<string, QuestionResponseDraft>) => {
    const resolved = questionDraftAnswers(questions, next);
    if (Object.keys(resolved.errors).length > 0) {
      const firstInvalidIndex = questions.findIndex((candidate) => Object.hasOwn(resolved.errors, candidate.id));
      setQuestionIndex(Math.max(0, firstInvalidIndex));
      setValidationError(resolved.errors[questions[Math.max(0, firstInvalidIndex)]!.id] ?? "Correct the response.");
      focusSoon(inputRef);
      return;
    }
    if (operationPendingRef.current === requestId || !runnerOnline) return;
    const submittedRequestId = requestId;
    const releaseOperation = claimQuestionResponseOperation(sessionId, submittedRequestId);
    if (!releaseOperation) {
      setSubmissionError("Another response is already being submitted for this question.");
      focusSoon(inputRef);
      return;
    }
    operationPendingRef.current = submittedRequestId;
    setBusy(true);
    setSubmissionError(null);
    try {
      const updated = await api.answerQuestion(sessionId, {
        requestId: submittedRequestId,
        answers: resolved.answers,
        action: "submit",
      });
      if (liveRequestRef.current !== submittedRequestId) return;
      clearQuestionDrafts(sessionId, submittedRequestId);
      onExit();
      onSessionUpdate?.(updated);
    } catch (cause) {
      if (liveRequestRef.current === submittedRequestId) {
        setSubmissionError((cause as Error).message);
        focusSoon(inputRef);
      }
    } finally {
      releaseOperation();
      if (operationPendingRef.current === submittedRequestId) operationPendingRef.current = null;
      if (liveRequestRef.current === submittedRequestId) setBusy(false);
    }
  };

  const accept = (next = values) => {
    if (controlsDisabled) return;
    const resolved = questionDraftAnswers([question], next);
    const error = resolved.errors[question.id];
    if (error) {
      setValidationError(error);
      focusSoon(inputRef);
      return;
    }
    if (currentIndex < questions.length - 1) {
      setQuestionIndex(currentIndex + 1);
      setPaletteFocusIndex(0);
      setValidationError(null);
      focusSoon(inputRef);
      return;
    }
    void submitAnswers(next);
  };

  const setChoice = (label: string) => {
    const selected = questionDraftSelections(question, currentDraft);
    const labels = question.multiSelect
      ? selected.includes(label) ? selected.filter((candidate) => candidate !== label) : [...selected, label]
      : [label];
    return updateDraft({ kind: "choice", labels });
  };

  const onChoiceKeyDown = (event: KeyboardEvent<HTMLButtonElement>, label: string) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
    if (!plain) return;
    const choices = [...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>("button")];
    const index = choices.indexOf(event.currentTarget);
    if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const targetIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? choices.length - 1
          : (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + choices.length) % choices.length;
      const target = choices[targetIndex];
      if (!question.multiSelect) setPaletteFocusIndex(targetIndex);
      target?.focus();
    } else if (event.key === " " || event.key.toLowerCase() === "x") {
      event.preventDefault();
      setChoice(label);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (question.multiSelect) accept();
      else accept(setChoice(label));
    } else if (event.key === "Escape") {
      event.preventDefault();
      onExit();
    }
  };

  return (
    <section className="composer-answer" aria-labelledby={questionLabelId} aria-busy={busy}>
      <div className="composer-answer-heading">
        <div>
          <span className="composer-answer-mode">Answer Mode</span>
          <strong>Answering Question {currentIndex + 1} of {questions.length}</strong>
        </div>
        <button className="btn ghost sm" type="button" disabled={busy} onClick={onExit}>Exit Answer Mode</button>
      </div>
      <div className="composer-answer-question" id={questionLabelId}>
        {question.header && <span className="question-chip">{question.header}</span>}
        {question.question}
        {question.multiSelect && <span className="muted sm"> (select all that apply)</span>}
      </div>
      {question.context && <div className="composer-answer-context">{question.context}</div>}
      {question.options.length > 0 && (
        <div
          className="composer-answer-choices"
          id={choicesId}
          role={question.multiSelect ? "group" : "radiogroup"}
          aria-label="Offered Choices"
        >
          {question.options.map((option, optionIndex) => {
            const selected = questionDraftSelections(question, currentDraft).includes(option.label);
            return (
              <button
                type="button"
                className={`composer-answer-choice${selected ? " on" : ""}`}
                role={question.multiSelect ? "checkbox" : "radio"}
                aria-checked={selected}
                tabIndex={question.multiSelect ? 0 : optionIndex === paletteFocusIndex ? 0 : -1}
                disabled={controlsDisabled}
                key={option.label}
                onClick={() => {
                  setPaletteFocusIndex(optionIndex);
                  setChoice(option.label);
                }}
                onFocus={() => setPaletteFocusIndex(optionIndex)}
                onKeyDown={(event) => onChoiceKeyDown(event, option.label)}
              >
                <span className="composer-answer-choice-number">{optionIndex + 1}</span>
                <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              </button>
            );
          })}
        </div>
      )}
      <label className="sr-only" htmlFor={`${ids}-composer-input`}>Response to Question {currentIndex + 1}</label>
      <input
        id={`${ids}-composer-input`}
        ref={inputRef}
        className="composer-answer-input"
        type={question.secret ? "password" : "text"}
        inputMode={question.inputFormat === "integer" ? "numeric" : question.inputFormat === "number" ? "decimal" : undefined}
        autoComplete="off"
        maxLength={question.allowOther ? question.maxLength ?? DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH : undefined}
        value={rawValue}
        aria-describedby={`${questionHelpId}${question.options.length > 0 ? ` ${choicesId}` : ""}${validationError ? ` ${questionErrorId}` : ""}`}
        aria-invalid={validationError ? true : undefined}
        disabled={controlsDisabled}
        placeholder={question.multiSelect
          ? "Numbers or labels, separated by commas"
          : question.options.length > 0 ? "Number or label" : "Type your response"}
        onChange={(event) => update(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
            event.preventDefault();
            onExit();
          } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
            event.preventDefault();
            accept();
          }
        }}
      />
      <div className="composer-answer-help" id={questionHelpId}>
        {unsupported
          ? "This question format is unsupported. Use Interactive Form or dismiss the question."
          : !runnerOnline
            ? "Responses are unavailable until the runner reconnects. Your draft is preserved."
            : question.required === false
              ? "This response is optional. Press Enter to continue without an answer."
              : question.options.length === 0
                ? "Type your response, then press Enter."
                : question.multiSelect
                  ? "Type displayed numbers or labels separated by commas, then press Enter."
                  : "Type a displayed number or unambiguous label, then press Enter."}
      </div>
      {validationError && <div className="form-error" id={questionErrorId} role="alert">{validationError}</div>}
      {submissionError && <div className="form-error" role="alert">Could not answer the question: {submissionError}</div>}
      <div className="composer-answer-actions">
        <button
          className="btn ghost sm"
          type="button"
          disabled={busy || currentIndex === 0}
          onClick={() => {
            setQuestionIndex(currentIndex - 1);
            setPaletteFocusIndex(0);
            setValidationError(null);
            focusSoon(inputRef);
          }}
        >
          Previous Question
        </button>
        <button className="btn primary sm" type="button" disabled={controlsDisabled} onClick={() => accept()}>
          {busy ? <><Spinner /> Submitting…</> : currentIndex === questions.length - 1 ? "Submit Answers" : "Next Question"}
        </button>
      </div>
    </section>
  );
}
