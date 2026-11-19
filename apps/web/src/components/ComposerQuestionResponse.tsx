import {
  DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH,
  type AgentQuestion,
  type SessionView,
} from "@wollipog/protocol";
import React, {
  useCallback,
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
import { appendTranscript } from "../dictation.js";
import { DictationStrip } from "./DictationStrip.js";
import { FieldError } from "./FieldError.js";
import { ChevronsDownIcon, ChevronsUpIcon, CloseIcon, ListIcon, MicIcon, QuestionIcon } from "./Icons.js";
import { Notice } from "./Notice.js";
import { StructuredQuestionText } from "./StructuredQuestionText.js";
import { BusyButton } from "./ui/BusyButton.js";
import { secretValueRef } from "./ui/secret-input.js";
import { useIsTouchPhone } from "./useIsMobile.js";
import { useVoiceDictation } from "./useVoiceDictation.js";
import {
  QUESTION_CARD_COPY,
  QuestionChoiceRows,
  answeringStepLabel,
  questionEyebrowParts,
  questionOtherChosen,
  questionStepLabel,
  questionTypesWords,
  type QuestionChoice,
} from "./requests/QuestionStep.js";

/** Answer Mode's field: a line in the composer, or, while a touch phone types Something Else, a
 * box that wraps and grows (#4714). */
export type AnswerField = HTMLInputElement | HTMLTextAreaElement;

/** The most lines the growing Something Else field shows before it scrolls (#4714). */
const OWN_ANSWER_MAX_LINES = 6;

/** Fit the Something Else box to its text, up to OWN_ANSWER_MAX_LINES, then scroll within it; and
 * keep it in view in the composer, which scrolls as a whole when the keyboard leaves it little room. */
function growOwnAnswerField(field: HTMLTextAreaElement): void {
  const style = field.ownerDocument.defaultView?.getComputedStyle(field);
  const line = parseFloat(style?.lineHeight ?? "") || 22;
  const edges = (parseFloat(style?.paddingTop ?? "") || 0) + (parseFloat(style?.paddingBottom ?? "") || 0);
  const max = Math.ceil(line * OWN_ANSWER_MAX_LINES + edges);
  const before = field.style.height;
  field.style.height = "auto";
  // Not laid out (hidden, or a document without layout): the stylesheet's own height stands.
  if (field.scrollHeight === 0) {
    field.style.height = "";
    return;
  }
  const height = `${Math.min(field.scrollHeight, max)}px`;
  field.style.height = height;
  field.style.overflowY = field.scrollHeight > max ? "auto" : "hidden";
  // Only a box that grew or shrank moves the view, so reading the options above is left alone.
  if (height !== before && field === field.ownerDocument.activeElement) field.scrollIntoView?.({ block: "nearest" });
}

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
  inputRef: RefObject<AnswerField | null>;
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

function focusSoon(ref: RefObject<AnswerField | null>): void {
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
 *
 * On a touch phone, Something Else in words is typed here (#4714), whichever style the card has:
 * the head reads "Answering Question 1 of 2" and "Something Else", the question keeps one line,
 * the options and context wait behind Show Options, and the field is a box that wraps and grows to
 * a few lines, with the mic beside Next. The usage triggers step aside to leave the keyboard room.
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
  // While a touch phone types Something Else, whether the options are shown above the field (#4714).
  const [optionsShown, setOptionsShown] = useState(false);
  const touchPhone = useIsTouchPhone();
  // Dictation writes into Something Else (#4714). The phrase lands through a ref that each render
  // points at the step's own draft, so a phrase after a step change never reaches the last step.
  const dictatePhraseRef = useRef<(phrase: string) => void>(() => {});
  const dictation = useVoiceDictation((phrase) => dictatePhraseRef.current(phrase));
  const cancelDictation = dictation.cancel;
  // Dictation lives as long as an enabled mic shows it, as the composer bar's does (#2193): leaving
  // Answer Mode, choosing an offered option, going offline or sending each end it, so nothing listens
  // without a control to stop it. Each render sets this once it knows whether the mic is shown.
  // Stop leaves the recognizer finalizing its last phrase after `recording` turns false, so the mic
  // going away cancels whether or not it still records: no late phrase lands in a hidden answer.
  const micAvailableRef = useRef(false);
  const micWasAvailableRef = useRef(false);
  micAvailableRef.current = false;
  const recording = dictation.recording;
  useEffect(() => {
    const available = micAvailableRef.current;
    if (!available && (recording || micWasAvailableRef.current)) cancelDictation();
    micWasAvailableRef.current = available;
  });
  useEffect(() => cancelDictation, [cancelDictation]);
  const [focusRequest, setFocusRequest] = useState<{ target: AnswerFocus; serial: number } | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [responseAction, setResponseAction] = useState<"submit" | "dismiss">("submit");
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
    setOptionsShown(false);
    setValidationError(null);
    setSubmissionError(null);
    setBusy(false);
    operationPendingRef.current = null;
    cancelDictation();
  }, [answerKey, sessionId, cancelDictation]);

  useEffect(() => {
    setBusy(false);
    setSubmissionError(null);
  }, [recoveryId]);

  // Before paint, and so within the press that opened Answer Mode: a touch phone's card that chose
  // Something Else opens it on the growing field, which must take focus while the keyboard may still
  // open for it (#4714).
  useLayoutEffect(() => {
    const entering = active && !previousActiveRef.current;
    previousActiveRef.current = active;
    if (!entering) return;
    const stored = storedQuestionDrafts(sessionId, answerKey);
    // The panel opens whole, on the step the request's draft keeps.
    setCollapsed(false);
    setOptionsShown(false);
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

  // The growing Something Else field (#4714). Taking the line field's place, it takes the focus the
  // line had, and only then: the swap happens as Answer Mode opens on the draft the card chose, after
  // the line was focused, and removing a focused element leaves focus on the page. Answer Mode that
  // opens by itself leaves focus alone, as it always has, so no keyboard opens unasked.
  const lineHadFocusRef = useRef(false);
  const ownAnswerFieldRef = useCallback((node: HTMLTextAreaElement | null) => {
    inputRef.current = node;
    if (!node) return;
    growOwnAnswerField(node);
    if (!lineHadFocusRef.current) return;
    lineHadFocusRef.current = false;
    node.focus();
  }, [inputRef]);
  const plainFieldRef = useCallback((node: HTMLInputElement | null) => {
    // Detached before the field that replaces it attaches, while it still holds focus.
    const previous = inputRef.current;
    lineHadFocusRef.current = node === null && previous !== null && previous.ownerDocument.activeElement === previous;
    inputRef.current = node;
  }, [inputRef]);
  // A line that left because Answer Mode closed hands nothing to a later Something Else.
  useEffect(() => {
    if (!active) lineHadFocusRef.current = false;
  }, [active]);
  // Whatever wrote the answer (typing, dictation, a restored draft), the box fits it.
  useLayoutEffect(() => {
    const field = inputRef.current;
    if (field?.tagName === "TEXTAREA") growOwnAnswerField(field as HTMLTextAreaElement);
  });

  // Closed, the panel takes no phrase: the last open render's draft is no longer what is shown.
  dictatePhraseRef.current = () => {};
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
  // A touch phone typing Something Else in words (#4714): the field takes the room the options had.
  const typingOwnAnswer = touchPhone && otherChosen && !unsupported && questionTypesWords(question);
  const choicesShown = !typingOwnAnswer || optionsShown;
  micAvailableRef.current = typingOwnAnswer && dictation.supported && !controlsDisabled;
  // Show Context's shrunk panel gives way to the field while Something Else is typed.
  const shrunk = collapsed && !typingOwnAnswer;
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
    cancelDictation();
    setQuestionIndex(step);
    storeQuestionStep(sessionId, answerKey, step);
    setValidationError(null);
    setOptionsShown(false);
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
  dictatePhraseRef.current = (phrase) => {
    if (!typingOwnAnswer || controlsDisabled) return;
    updateDraft({ kind: currentDraft?.kind === "other" ? "other" : "entry", value: appendTranscript(rawValue, phrase) });
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
    await respond("submit", resolved.answers);
  };

  const respond = async (action: "submit" | "dismiss", answers: Record<string, string | string[]>) => {
    if (operationPendingRef.current === answerKey || !runnerOnline) return;
    // What is sent is what the field showed: a phrase still being settled is dropped.
    cancelDictation();
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
    setResponseAction(action);
    setValidationError(null);
    setSubmissionError(null);
    try {
      const updated = await api.answerQuestion(sessionId, {
        requestId: submittedRequestId,
        ...(occurrenceId ? { occurrenceId } : {}),
        answers,
        action,
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
      // Reading the panel is not an answer. Only the field and choice rows advance on Enter.
      if (target === event.currentTarget || target.closest("button, a[href]")) return;
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
  const optionsLabel = optionsShown ? QUESTION_CARD_COPY.hideOptions : QUESTION_CARD_COPY.showOptions;
  const kindLabel = recovery ? QUESTION_CARD_COPY.recoveryRequired
    : isAsync ? QUESTION_CARD_COPY.asyncQuestion : QUESTION_CARD_COPY.question;
  const optionsId = `${ids}-answer-options`;
  const contextId = `${ids}-answer-context`;
  const describedBy = helpShown ? helpId : validationError ? errorId : undefined;
  const fieldChange = (raw: string) => updateDraft({ kind: currentDraft?.kind === "other" ? "other" : "entry", value: raw });

  return (
    <section
      ref={sectionRef}
      className="composer-answer"
      tabIndex={0}
      aria-labelledby={titleId}
      aria-busy={busy}
      data-collapsed={shrunk ? "" : undefined}
      data-own-answer={typingOwnAnswer ? "" : undefined}
      data-options-shown={typingOwnAnswer && optionsShown ? "" : undefined}
      // The question's place while it is answered here, for the request coordinator's focus.
      data-session-request-id={requestId}
      data-session-request-session={sessionId}
      onKeyDown={onKeyDown}
      onMouseDown={holdFieldFocus}
    >
      <div className="answer-head">
        {typingOwnAnswer ? <>
          {/* "Answering Question 1 of 2" (#4714); "Something Else" labels the field below, where a
              phone's width never cuts it short. */}
          <span className="answer-kind"><QuestionIcon size={16} />{answeringStepLabel(currentIndex, questions.length)}</span>
          {/* Icon-only, as Show Context is on a phone (§15.1): the head's words need the width. */}
          <button
            type="button"
            className="icon-btn sm answer-options-toggle"
            aria-label={optionsLabel}
            title={optionsLabel}
            aria-expanded={optionsShown}
            aria-controls={`${optionsId}${question.context ? ` ${contextId}` : ""}`}
            disabled={busy}
            onClick={() => setOptionsShown((current) => !current)}
          >
            <ListIcon size={16} />
          </button>
        </> : <>
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
        </>}
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
      {!shrunk && choicesShown && (eyebrow.header || eyebrow.hint) && (
        <p className="answer-eyebrow">
          {eyebrow.header && <span id={headerId}>{eyebrow.header}</span>}
          {eyebrow.hint && <span>{eyebrow.hint}</span>}
        </p>
      )}
      <div className="answer-title" id={titleId}>
        <StructuredQuestionText>{question.question}</StructuredQuestionText>
      </div>
      {shrunk && <p className="answer-summary" aria-live="polite">{answerSelectionSummary(question, currentDraft)}</p>}
      {/* Hidden, not unmounted, behind Show Context: the field keeps its place for the composer's
          focus, and nothing in it resets. */}
      <div className="answer-body" id={bodyId} hidden={shrunk}>
        {recovery && <p className="answer-recovery">{QUESTION_CARD_COPY.recoveryResume}</p>}
        {question.context && (
          <div className="answer-context" id={contextId} hidden={!choicesShown}>
            <StructuredQuestionText>{question.context}</StructuredQuestionText>
          </div>
        )}
        {question.options.length > 0 && (
          // Behind Show Options while a touch phone types Something Else (#4714).
          <div className="answer-options" id={optionsId} hidden={!choicesShown}>
            <QuestionChoiceRows
              question={question}
              draft={currentDraft}
              disabled={controlsDisabled}
              labelledBy={eyebrow.header && !shrunk && choicesShown ? `${headerId} ${titleId}` : titleId}
              describedBy={describedBy}
              invalid={validationError !== null}
              marker={(index) => index < 9 ? <span className="answer-option-number" aria-hidden="true">{index + 1}</span> : undefined}
              onChoose={choose}
            />
          </div>
        )}
        {submissionError && (
          <Notice tone="danger" compact role="alert"
            details={submissionError !== QUESTION_CARD_COPY.alreadySending ? submissionError : undefined}>
            {submissionError === QUESTION_CARD_COPY.alreadySending ? submissionError
              : responseAction === "dismiss" ? QUESTION_CARD_COPY.notDismissed : QUESTION_CARD_COPY.notSent}
          </Notice>
        )}
        {question.secret ? (
          // A secret is uncontrolled, so it never reaches the value attribute (#3814); the page-only
          // draft reaches the field through its ref. The keys keep React from reusing one input for both.
          <input
            key="secret"
            ref={secretValueRef(rawValue, inputRef)}
            className="composer-answer-input"
            data-session-request-focus=""
            type="password"
            autoComplete="off"
            maxLength={question.maxLength ?? DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH}
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
        ) : typingOwnAnswer ? (<>
          {/* What the field answers, named as the card's Something Else row is (#4714). */}
          <span className="answer-own" id={`${ids}-answer-own`}>{QUESTION_CARD_COPY.somethingElseField}</span>
          {/* Wraps and grows to a few lines, then scrolls within itself (#4714). Enter still moves on,
              as the keyboard's Next or Send key says; Shift+Enter starts a new line. */}
          <textarea
            key="own"
            ref={ownAnswerFieldRef}
            className="composer-answer-input"
            data-session-request-focus=""
            rows={1}
            enterKeyHint={lastStep ? "send" : "next"}
            autoComplete="off"
            maxLength={question.maxLength ?? DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH}
            value={rawValue}
            aria-labelledby={`${titleId} ${ids}-answer-own`}
            aria-describedby={describedBy}
            aria-invalid={validationError ? true : undefined}
            aria-disabled={responseUnavailable || undefined}
            disabled={busy}
            readOnly={responseUnavailable}
            placeholder={QUESTION_CARD_COPY.typeAnswer}
            onChange={(event) => fieldChange(event.currentTarget.value)}
          />
        </>) : (
          <input
            key="plain"
            ref={plainFieldRef}
            className="composer-answer-input"
            data-session-request-focus=""
            type="text"
            inputMode={question.inputFormat === "integer" ? "numeric" : question.inputFormat === "number" ? "decimal" : undefined}
            autoComplete="off"
            maxLength={question.maxLength ?? DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH}
            value={rawValue}
            aria-labelledby={titleId}
            aria-describedby={describedBy}
            aria-invalid={validationError ? true : undefined}
            aria-disabled={responseUnavailable || undefined}
            disabled={busy}
            readOnly={responseUnavailable}
            placeholder={answerPlaceholder(question, currentDraft)}
            onChange={(event) => fieldChange(event.currentTarget.value)}
          />
        )}
        {validationError !== null && <FieldError id={errorId}>{validationError}</FieldError>}
        {helpShown && <p className="answer-help" id={helpId}>{help}</p>}
        {/* The usage triggers step aside while a phone types Something Else: the keyboard leaves the
            composer little room, and they are back on the composer bar once the answer is sent. */}
        {usage && usageOwnRow && !typingOwnAnswer && <div className="composer-answer-usage own-row">{usage}</div>}
        <div className="answer-foot">
          {typingOwnAnswer && dictation.recording && dictation.startedAt !== null && (
            <DictationStrip startedAt={dictation.startedAt} held={dictation.held} interim={dictation.interim} />
          )}
          <BusyButton className="btn ghost" busy={busy && responseAction === "dismiss"}
            progress={QUESTION_CARD_COPY.dismissing} disabled={!runnerOnline || (busy && responseAction !== "dismiss")}
            aria-describedby={helpShown && !runnerOnline ? helpId : undefined}
            onClick={() => void respond("dismiss", {})}>
            {recovery ? QUESTION_CARD_COPY.dismissAndContinue : QUESTION_CARD_COPY.dismiss}
          </BusyButton>
          {currentIndex > 0 && (
            <button type="button" className="btn" disabled={busy} onClick={() => goToStep(currentIndex - 1)}>
              {QUESTION_CARD_COPY.back}
            </button>
          )}
          {usage && !usageOwnRow && !typingOwnAnswer && <div className="composer-answer-usage">{usage}</div>}
          {typingOwnAnswer && dictation.supported && (
            // As the composer's mic (#2193): a tap toggles, a hold is push-to-talk, and a press that
            // never completes stops. Its phrases go into Something Else.
            <button
              type="button"
              className="icon-btn answer-mic"
              disabled={controlsDisabled}
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0) return;
                dictation.pressStart();
              }}
              onPointerUp={dictation.pressEnd}
              onPointerCancel={dictation.pressCancel}
              onPointerLeave={dictation.pressCancel}
              // Enter, Space and assistive technology click without a pointer (detail 0).
              onClick={(event) => {
                if (event.detail === 0) dictation.toggle();
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !dictation.recording) return;
                event.preventDefault();
                event.stopPropagation();
                dictation.stop();
              }}
              title={dictation.recording ? QUESTION_CARD_COPY.stopDictating : QUESTION_CARD_COPY.dictate}
              aria-label={dictation.recording ? QUESTION_CARD_COPY.stopDictating : QUESTION_CARD_COPY.dictate}
              aria-pressed={dictation.recording}
            >
              <MicIcon size={16} />
            </button>
          )}
          <BusyButton
            className="btn primary"
            busy={busy && responseAction === "submit"}
            progress={QUESTION_CARD_COPY.sending}
            disabled={responseUnavailable || (busy && responseAction !== "submit")}
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
