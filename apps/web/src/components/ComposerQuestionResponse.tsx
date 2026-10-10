import {
  DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH,
  type AgentQuestion,
  type SessionView,
} from "@wollipog/protocol";
import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import { useApi } from "../api-context.js";
import { useInstanceScope } from "../instance-scope.js";
import { KEYBOARD_EDITABLE, TOUCH_PHONE_MEDIA } from "../mobile-viewport.js";
import {
  clearQuestionDrafts,
  claimQuestionResponseOperation,
  isAnswerableAgentQuestion,
  questionDraftAnswers,
  questionDraftSelections,
  questionDraftText,
  questionDraftIdentity,
  storedQuestionDrafts,
  storedQuestionStep,
  storeQuestionDrafts,
  storeQuestionStep,
  type QuestionResponseDraft,
} from "../question-response.js";
import { FieldError } from "./FieldError.js";
import { ChevronsDownIcon, ChevronsUpIcon, CloseIcon, QuestionIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StructuredQuestionText } from "./StructuredQuestionText.js";
import { BusyButton } from "./ui/BusyButton.js";
import {
  QUESTION_CARD_COPY,
  QuestionChoiceRows,
  questionEyebrowParts,
  questionOtherChosen,
  questionStepLabel,
  type QuestionChoice,
} from "./requests/QuestionStep.js";

export interface ComposerQuestionResponseProps {
  sessionId: string;
  requestId: string;
  occurrenceId?: string;
  requestedAt?: number;
  recoveryId?: string;
  isAsync?: boolean;
  questions: AgentQuestion[];
  runnerOnline: boolean;
  /** Answer Mode is open. While it is closed the question waits on the request dock's compact card
   * (#2212) and this renders nothing, keeping the answers given so far. */
  active: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onExit: () => void;
  onSessionUpdate?: (session: SessionView) => void;
  /** The session's context and cost triggers, which Answer Mode keeps in reach while it replaces
   * the composer bar (#2166). Beside Submit, or on their own row when the column is narrow. */
  usage?: ReactNode;
  usageOwnRow?: boolean;
  /** Receives the way back to the answer while Answer Mode is open: given this question's request
   * id it expands the panel, focuses the field and answers true. Jump to Question, an attention
   * link and the Reply key use it. */
  revealRef?: MutableRefObject<((requestId: string) => boolean) | null>;
  /** The runner restarted after the question was asked and answering resumes the conversation once
   * (`recoveryAction: "resume_answer"`): the head reads Recovery Required and the body says so, as
   * the card does. */
  recovery?: boolean;
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

/** Share non-secret answer drafts while keeping secret values in this mounted response surface. */
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

/** What the collapsed panel says has been answered so far: the chosen options, the typed answer, or
 * "Nothing chosen yet". A secret is never repeated. */
export function answerSelectionSummary(question: AgentQuestion, draft: QuestionResponseDraft | undefined): string {
  const selected = questionDraftSelections(question, draft);
  if (selected.length > 0) return selected.join(", ");
  const text = draft?.kind === "choice" ? "" : draft?.value.trim() ?? "";
  if (!text) return QUESTION_CARD_COPY.nothingChosen;
  return question.secret ? QUESTION_CARD_COPY.answerEntered : text;
}

/** What to type into the answer field. */
function answerPlaceholder(question: AgentQuestion, draft: QuestionResponseDraft | undefined): string {
  if (question.options.length === 0 || questionOtherChosen(question, draft) || draft?.kind === "other") {
    return QUESTION_CARD_COPY.typeAnswer;
  }
  if (question.multiSelect) return QUESTION_CARD_COPY.typeChoices;
  return question.allowOther ? QUESTION_CARD_COPY.typeChoiceOrAnswer : QUESTION_CARD_COPY.typeChoice;
}

/** Where focus goes once the commit that renders it lands: the answer field, or one choice row. */
type AnswerFocus = { kind: "input" } | { kind: "control"; name: string };

/**
 * Answer Mode (docs/design-system.md §13.2; #2212): a question answered in the composer, kept
 * separate from the message draft. While it is open the request dock leaves the question out, so it
 * is shown once.
 *
 * Top to bottom: the answer head (the kind, "Question 2 of 3" when there are several, Show Context
 * and the × that exits), the question, its options as the card's ChoiceRows numbered 1–9, the answer
 * field in the reading font, and a footer of Back (from question 2) and Next or Submit Answers.
 * The field is the composer's own: it has no edge of its own, the composer card's edge shows focus,
 * and an invalid answer turns that edge red with the error under the field (§8.5).
 *
 * Show Context shrinks the panel to its head (the question, a summary of the answer so far and
 * Show Answer) so the conversation the question is about can be read. Nothing resets: the answers
 * and the step stay in the request-keyed draft the card shares. Escape exits Answer Mode, and a
 * number key opens the panel before it chooses.
 */
export function ComposerQuestionResponse({
  sessionId,
  requestId,
  occurrenceId,
  requestedAt,
  recoveryId,
  isAsync,
  questions,
  runnerOnline,
  active,
  inputRef,
  onExit,
  onSessionUpdate,
  usage = null,
  usageOwnRow = false,
  revealRef,
  recovery = false,
}: ComposerQuestionResponseProps) {
  const api = useApi();
  const instanceScope = useInstanceScope();
  const operationKey = isAsync && occurrenceId ? `${requestId}:${occurrenceId}` : requestId;
  const answerKey = useMemo(() => questionDraftIdentity(requestId, questions, occurrenceId, requestedAt, instanceScope),
    [requestId, questions, occurrenceId, requestedAt, instanceScope]);
  const ids = useId().replace(/:/g, "");
  const [draftState, setDraftState] = useState(() => ({
    requestId: answerKey,
    values: storedQuestionDrafts(sessionId, answerKey),
  }));
  const [questionIndex, setQuestionIndex] = useState(() => storedQuestionStep(sessionId, answerKey));
  const [collapsed, setCollapsed] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ target: AnswerFocus; serial: number } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const operationPendingRef = useRef<string | null>(null);
  const previousActiveRef = useRef(active);
  const liveRequestRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    // A committed question owns its response only until replacement or unmount. A fresh
    // token also prevents an earlier incarnation of the same request from regaining ownership.
    liveRequestRef.current = {};
    operationPendingRef.current = null;
    return () => { liveRequestRef.current = null; };
  }, [answerKey, sessionId, recoveryId]);

  useEffect(() => {
    setDraftState({ requestId: answerKey, values: storedQuestionDrafts(sessionId, answerKey) });
    setQuestionIndex(storedQuestionStep(sessionId, answerKey));
    setCollapsed(false);
    setValidationError(null);
    setSubmissionError(null);
    setBusy(false);
    operationPendingRef.current = null;
  }, [answerKey, sessionId]);

  useEffect(() => {
    setBusy(false);
    setSubmissionError(null);
  }, [recoveryId]);

  useEffect(() => {
    const entering = active && !previousActiveRef.current;
    previousActiveRef.current = active;
    if (!entering) return;
    const stored = storedQuestionDrafts(sessionId, answerKey);
    // The panel opens whole, on the step the request's draft keeps.
    setCollapsed(false);
    setQuestionIndex(storedQuestionStep(sessionId, answerKey));
    setDraftState((current) => {
      const values = current.requestId === answerKey ? { ...current.values } : {};
      // The card may have changed non-secret answers while this mounted composer surface was
      // inactive. Merge those exact drafts without erasing a page-only secret kept here.
      for (const question of questions) {
        if (question.secret || !Object.hasOwn(stored, question.id)) continue;
        Object.defineProperty(values, question.id, {
          value: stored[question.id],
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      return { requestId: answerKey, values };
    });
  }, [active, questions, answerKey, sessionId]);

  // Focus moves in the commit that renders its target: a collapsed panel opening, or a step change.
  useLayoutEffect(() => {
    const target = focusRequest?.target;
    if (!target) return;
    if (target.kind === "input") {
      inputRef.current?.focus();
      return;
    }
    [...sectionRef.current?.querySelectorAll<HTMLElement>("[data-session-request-control]") ?? []]
      .find((candidate) => candidate.dataset.sessionRequestControl === target.name)?.focus();
  // Only a new request moves focus.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);
  const requestFocus = (target: AnswerFocus) =>
    setFocusRequest((current) => ({ target, serial: (current?.serial ?? 0) + 1 }));

  const revealRefCurrent = useRef<() => void>(() => {});
  revealRefCurrent.current = () => {
    setCollapsed(false);
    requestFocus({ kind: "input" });
  };
  useEffect(() => {
    if (!revealRef || !active) return;
    const reveal = (target: string) => {
      if (target !== requestId) return false;
      revealRefCurrent.current();
      return true;
    };
    revealRef.current = reveal;
    return () => {
      if (revealRef.current === reveal) revealRef.current = null;
    };
  }, [active, requestId, revealRef]);

  if (questions.length === 0 || !active) return null;

  const currentIndex = Math.min(Math.max(questionIndex, 0), questions.length - 1);
  const question = questions[currentIndex]!;
  const values = draftState.requestId === answerKey ? draftState.values : {};
  const currentDraft = Object.hasOwn(values, question.id) ? values[question.id] : undefined;
  const rawValue = questionDraftText(currentDraft);
  const titleId = `${ids}-answer-title`;
  const bodyId = `${ids}-answer-body`;
  const headerId = `${ids}-answer-header`;
  const helpId = `${ids}-answer-help`;
  const errorId = `${ids}-answer-error`;
  const unsupported = !isAnswerableAgentQuestion(question);
  const responseUnavailable = !runnerOnline || unsupported;
  const controlsDisabled = busy || responseUnavailable;
  const lastStep = currentIndex === questions.length - 1;
  const otherChosen = questionOtherChosen(question, currentDraft);
  const eyebrow = questionEyebrowParts(question);
  const help = unsupported
    ? QUESTION_CARD_COPY.unsupported
    : !runnerOnline
      ? QUESTION_CARD_COPY.runnerOffline
      : question.required === false ? QUESTION_CARD_COPY.optionalSentence : null;
  // The error takes the help line's place under the field (§8.5).
  const helpShown = validationError === null && help !== null;
  /** The step's error, worded as the card words it: nothing chosen names the choice. */
  const stepError = (next: Record<string, QuestionResponseDraft>, target: AgentQuestion): string | undefined => {
    const error = questionDraftAnswers([target], next).errors[target.id];
    if (error === undefined || target.options.length === 0) return error;
    const draft = Object.hasOwn(next, target.id) ? next[target.id] : undefined;
    return questionOtherChosen(target, draft) || questionDraftSelections(target, draft).length > 0 || questionDraftText(draft).trim()
      ? error : target.multiSelect ? QUESTION_CARD_COPY.chooseOptions : QUESTION_CARD_COPY.chooseOption;
  };

  const goToStep = (step: number) => {
    setQuestionIndex(step);
    storeQuestionStep(sessionId, answerKey, step);
    setValidationError(null);
    requestFocus({ kind: "input" });
  };

  const updateDraft = (draft: QuestionResponseDraft): Record<string, QuestionResponseDraft> => {
    const next = withDraft(values, question.id, draft);
    setDraftState({ requestId: answerKey, values: next });
    persistDrafts(sessionId, answerKey, questions, next);
    setValidationError(null);
    setSubmissionError(null);
    return next;
  };

  const submitAnswers = async (next: Record<string, QuestionResponseDraft>) => {
    const resolved = questionDraftAnswers(questions, next);
    if (Object.keys(resolved.errors).length > 0) {
      const firstInvalidIndex = Math.max(0, questions.findIndex((candidate) => Object.hasOwn(resolved.errors, candidate.id)));
      setQuestionIndex(firstInvalidIndex);
      storeQuestionStep(sessionId, answerKey, firstInvalidIndex);
      setValidationError(stepError(next, questions[firstInvalidIndex]!) ?? QUESTION_CARD_COPY.required);
      focusSoon(inputRef);
      return;
    }
    if (operationPendingRef.current === answerKey || !runnerOnline) return;
    const submittedRequestId = requestId;
    const submittedRequest = liveRequestRef.current;
    const releaseOperation = claimQuestionResponseOperation(sessionId, operationKey);
    if (!releaseOperation) {
      setSubmissionError(QUESTION_CARD_COPY.alreadySending);
      focusSoon(inputRef);
      return;
    }
    operationPendingRef.current = answerKey;
    setBusy(true);
    setSubmissionError(null);
    try {
      const updated = await api.answerQuestion(sessionId, {
        requestId: submittedRequestId,
        ...(occurrenceId ? { occurrenceId } : {}),
        answers: resolved.answers,
        action: "submit",
      });
      if (liveRequestRef.current !== submittedRequest) return;
      clearQuestionDrafts(sessionId, answerKey);
      onExit();
      onSessionUpdate?.(updated);
    } catch (cause) {
      if (liveRequestRef.current === submittedRequest) {
        setSubmissionError((cause as Error).message);
        focusSoon(inputRef);
      }
    } finally {
      releaseOperation();
      if (operationPendingRef.current === answerKey) operationPendingRef.current = null;
      if (liveRequestRef.current === submittedRequest) setBusy(false);
    }
  };

  /** Next checks the step and moves on; on the last step it submits. */
  const accept = (next = values) => {
    if (controlsDisabled) return;
    const error = stepError(next, question);
    if (error) {
      setValidationError(error);
      focusSoon(inputRef);
      return;
    }
    if (!lastStep) {
      goToStep(currentIndex + 1);
      return;
    }
    void submitAnswers(next);
  };

  const choose = (choice: QuestionChoice) => {
    if (controlsDisabled) return;
    if (choice === "other") {
      if (otherChosen && question.multiSelect) updateDraft({ kind: "choice", labels: [] });
      else if (!otherChosen) updateDraft({ kind: "other", value: "" });
      // Something Else is answered in the field.
      requestFocus({ kind: "input" });
      return;
    }
    const label = question.options[choice]?.label;
    if (label === undefined) return;
    const selected = questionDraftSelections(question, currentDraft);
    updateDraft({
      kind: "choice",
      labels: question.multiSelect
        ? selected.includes(label) ? selected.filter((candidate) => candidate !== label) : [...selected, label]
        : [label],
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // A menu or popover opened from the panel (the usage triggers) is portalled: its keys are its own.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      event.preventDefault();
      onExit();
      return;
    }
    if (event.key === "Enter") {
      // A button keeps its own Enter; the field and the choice rows move on.
      if (target.closest("button, a[href]")) return;
      event.preventDefault();
      if (!event.repeat) accept();
      return;
    }
    if (target === inputRef.current || event.repeat || !/^[1-9]$/.test(event.key)) return;
    const index = Number(event.key) - 1;
    const rows = question.options.length + (unsupported ? 0 : 1);
    if (question.options.length === 0 || index >= rows) return;
    event.preventDefault();
    setCollapsed(false);
    if (index === question.options.length) {
      choose("other");
      return;
    }
    choose(index);
    requestFocus({ kind: "control", name: `question:${question.id}:option:${index}` });
  };

  // On a touch phone a focused field is the software keyboard, and its blur changes the layout
  // between a press and its click. Pressing a row or a button while typing keeps the field focused
  // until the click lands, as the question card does (#2205).
  const holdFieldFocus = (event: MouseEvent<HTMLElement>) => {
    const focused = event.currentTarget.ownerDocument.activeElement;
    const target = event.target as HTMLElement;
    if (!(focused instanceof HTMLElement) || !event.currentTarget.contains(focused) || !focused.matches(KEYBOARD_EDITABLE) ||
        target.closest(KEYBOARD_EDITABLE) || !target.closest("button, label, input") ||
        !event.currentTarget.ownerDocument.defaultView?.matchMedia(TOUCH_PHONE_MEDIA).matches) return;
    event.preventDefault();
  };

  const contextLabel = collapsed ? QUESTION_CARD_COPY.showAnswer : QUESTION_CARD_COPY.showContext;
  const kindLabel = recovery ? QUESTION_CARD_COPY.recoveryRequired
    : isAsync ? QUESTION_CARD_COPY.asyncQuestion : QUESTION_CARD_COPY.question;

  return (
    <section
      ref={sectionRef}
      className="composer-answer"
      aria-labelledby={titleId}
      aria-busy={busy}
      data-collapsed={collapsed ? "" : undefined}
      // The question's place while it is answered here, for the request coordinator's focus.
      data-session-request-id={requestId}
      data-session-request-session={sessionId}
      onKeyDown={onKeyDown}
      onMouseDown={holdFieldFocus}
    >
      <div className="answer-head">
        <span className="answer-kind"><QuestionIcon size={16} />{kindLabel}</span>
        {questions.length > 1 && <span className="answer-step">{questionStepLabel(currentIndex, questions.length)}</span>}
        {/* Icon-only below 760px, under the same name (§15.1). */}
        <button
          type="button"
          className="btn sm ghost answer-context-toggle"
          aria-label={contextLabel}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          onClick={() => setCollapsed((current) => !current)}
        >
          {collapsed ? <ChevronsUpIcon size={14} /> : <ChevronsDownIcon size={14} />}
          <span className="answer-context-label">{contextLabel}</span>
        </button>
        <button
          type="button"
          className="icon-btn sm"
          aria-label={QUESTION_CARD_COPY.exitAnswerMode}
          title={QUESTION_CARD_COPY.exitAnswerMode}
          disabled={busy}
          onClick={onExit}
        >
          <CloseIcon size={16} />
        </button>
      </div>
      {!collapsed && (eyebrow.header || eyebrow.hint) && (
        <p className="answer-eyebrow">
          {eyebrow.header && <span id={headerId}>{eyebrow.header}</span>}
          {eyebrow.hint && <span>{eyebrow.hint}</span>}
        </p>
      )}
      <div className="answer-title" id={titleId}>
        <StructuredQuestionText>{question.question}</StructuredQuestionText>
      </div>
      {collapsed && <p className="answer-summary" aria-live="polite">{answerSelectionSummary(question, currentDraft)}</p>}
      {/* Hidden, not unmounted, behind Show Context: the field keeps its place for the composer's
          focus, and nothing in it resets. */}
      <div className="answer-body" id={bodyId} hidden={collapsed}>
        {recovery && <p className="answer-recovery">{QUESTION_CARD_COPY.recoveryResume}</p>}
        {question.context && (
          <div className="answer-context">
            <StructuredQuestionText>{question.context}</StructuredQuestionText>
          </div>
        )}
        {question.options.length > 0 && (
          <div className="answer-options">
            <QuestionChoiceRows
              question={question}
              draft={currentDraft}
              disabled={controlsDisabled}
              labelledBy={eyebrow.header && !collapsed ? `${headerId} ${titleId}` : titleId}
              describedBy={helpShown ? helpId : validationError ? errorId : undefined}
              invalid={validationError !== null}
              marker={(index) => index < 9 ? <span className="answer-option-number" aria-hidden="true">{index + 1}</span> : undefined}
              onChoose={choose}
            />
          </div>
        )}
        {submissionError && (
          <Notice tone="danger" compact role="alert"
            details={submissionError !== QUESTION_CARD_COPY.alreadySending ? submissionError : undefined}>
            {submissionError === QUESTION_CARD_COPY.alreadySending ? submissionError : QUESTION_CARD_COPY.notSent}
          </Notice>
        )}
        <input
          ref={inputRef}
          className="composer-answer-input"
          data-session-request-focus=""
          type={question.secret ? "password" : "text"}
          inputMode={question.inputFormat === "integer" ? "numeric" : question.inputFormat === "number" ? "decimal" : undefined}
          autoComplete="off"
          maxLength={question.maxLength ?? DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH}
          value={rawValue}
          aria-labelledby={titleId}
          aria-describedby={helpShown ? helpId : validationError ? errorId : undefined}
          aria-invalid={validationError ? true : undefined}
          aria-disabled={responseUnavailable || undefined}
          disabled={busy}
          readOnly={responseUnavailable}
          placeholder={answerPlaceholder(question, currentDraft)}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            updateDraft({ kind: currentDraft?.kind === "other" ? "other" : "entry", value: raw });
          }}
        />
        {validationError !== null && <FieldError id={errorId}>{validationError}</FieldError>}
        {helpShown && <p className="answer-help" id={helpId}>{help}</p>}
        {usage && usageOwnRow && <div className="composer-answer-usage own-row">{usage}</div>}
        <div className="answer-foot">
          {currentIndex > 0 && (
            <button type="button" className="btn" disabled={busy} onClick={() => goToStep(currentIndex - 1)}>
              {QUESTION_CARD_COPY.back}
            </button>
          )}
          {usage && !usageOwnRow && <div className="composer-answer-usage">{usage}</div>}
          <BusyButton
            className="btn primary"
            busy={busy}
            progress={QUESTION_CARD_COPY.sending}
            disabled={responseUnavailable}
            aria-describedby={helpShown && responseUnavailable ? helpId : undefined}
            onClick={() => accept()}
          >
            {lastStep ? QUESTION_CARD_COPY.submitAnswers : QUESTION_CARD_COPY.next}
          </BusyButton>
        </div>
      </div>
    </section>
  );
}
