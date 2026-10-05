import React from "react";
import { DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH, type AgentQuestion } from "@wollipog/protocol";
import {
  isAnswerableAgentQuestion,
  questionDraftSelections,
  questionDraftText,
  type QuestionResponseDraft,
} from "../../question-response.js";
import { FieldError } from "../FieldError.js";
import { StructuredQuestionText } from "../StructuredQuestionText.js";
import { ChoiceRows, type ChoiceRowOption } from "../ui/ChoiceControls.js";

/**
 * The question card's own words (§17; #2196), in one table the copy test classifies: labels and
 * names are Title Case, the line above a question and every foot-note are sentences.
 */
export const QUESTION_CARD_COPY = {
  agentQuestions: "Agent Questions",
  question: "Question",
  asyncQuestion: "Async Question",
  recoveryRequired: "Recovery Required",
  dismiss: "Dismiss",
  dismissAndContinue: "Dismiss and Continue",
  back: "Back",
  next: "Next",
  submitAnswers: "Submit Answers",
  tryAgain: "Try Again",
  somethingElse: "Something Else…",
  somethingElseField: "Something Else",
  chooseOne: "Choose one",
  chooseAny: "Choose any",
  optional: "Optional",
  noDetails: "The agent has a question.",
  required: "An answer to this question is required.",
  chooseOption: "Choose an option.",
  chooseOptions: "Choose at least one option.",
  optionalSentence: "This question is optional.",
  notSent: "Couldn't send your answers. Try again.",
  notDismissed: "Couldn't dismiss this question. Try again.",
  alreadySending: "Another response is already being sent for this question.",
  sending: "Sending your answers…",
  dismissing: "Dismissing the question…",
  runnerOffline: "Responses are unavailable until the runner reconnects.",
  unsupported: "This question format is unsupported. Dismiss the question to continue.",
  answerInComposer: "Respond through Answer Mode in the composer. Press R or use /respond.",
  recoveryResume: "The runner restarted after this question was asked. Submit the preserved form to resume the existing agent conversation and deliver these answers once. Prior tool calls will not be replayed.",
  showWhereAsked: "Show Where Asked",
  findingWhereAsked: "Loading the transcript back to where the question was asked…",
  whereAskedNotLoaded: "This question's place in the transcript isn't loaded.",
  recoveryDismiss: "The runner restarted after this question was asked, so its original answer channel is no longer available. Review the preserved question, then dismiss it and send a new prompt to continue safely. No prior tool calls will be replayed.",
} as const;

/** The footer's foot-note while a request has several questions: "Question 2 of 3". */
export function questionStepLabel(step: number, count: number): string {
  return `Question ${step + 1} of ${count}`;
}

/** The dim line above a question: its header, then "Choose one", "Choose any" or "Optional". */
export function questionEyebrowParts(question: AgentQuestion): { header: string | null; hint: string | null } {
  const header = question.header?.trim() || null;
  const hint = question.options.length > 0
    ? question.multiSelect ? QUESTION_CARD_COPY.chooseAny : QUESTION_CARD_COPY.chooseOne
    : question.required === false ? QUESTION_CARD_COPY.optional : null;
  return { header, hint };
}

/**
 * Whether the question's answer is its own text rather than offered options: Something Else was
 * chosen, or a typed Composer Response that names no option carries over to a single choice.
 */
export function questionOtherChosen(question: AgentQuestion, draft: QuestionResponseDraft | undefined): boolean {
  if (question.options.length === 0) return false;
  if (draft?.kind === "other") return true;
  return draft?.kind === "entry" && !question.multiSelect && question.allowOther === true &&
    questionDraftSelections(question, draft).length === 0 && draft.value.trim() !== "";
}

/** Which row a number key picks: the option at that index, or Something Else after the options. */
export type QuestionChoice = number | "other";

export interface QuestionStepIds {
  /** The question's header in the line above it, when it has one. */
  header?: string;
  /** The question itself: the card's heading. */
  title: string;
  context: string;
  requirement: string;
  error: string;
  somethingElse: string;
}

/**
 * One question's body on the Request Card (#2196): its context, then its answer. A choice question
 * is a ChoiceRows group (§8.4) whose last row is Something Else…, which reveals a text field in the
 * step; a free-text question is the text field alone. A field error (§8.5) shows only once the
 * person tried to move past the question with it unanswered or invalid.
 *
 * In Composer Response the card is the question's context: the offered options are listed, and the
 * answer is given in the composer.
 */
export function QuestionStep({
  question,
  ids,
  responseStyle,
  draft,
  error,
  disabled,
  inputDisabled,
  describedBy,
  showKeyHints,
  onChoose,
  onText,
}: {
  question: AgentQuestion;
  ids: QuestionStepIds;
  responseStyle: "interactive" | "composer";
  draft: QuestionResponseDraft | undefined;
  /** The field error to show, or nothing before the person tried to continue. */
  error?: string;
  /** Choices refuse selection but stay reachable, so their reason is announced. */
  disabled: boolean;
  /** The text field cannot be edited. */
  inputDisabled: boolean;
  /** Shared descriptions every control carries: the recovery and availability lines. */
  describedBy: readonly string[];
  showKeyHints: boolean;
  onChoose: (choice: QuestionChoice) => void;
  onText: (value: string) => void;
}) {
  const otherChosen = questionOtherChosen(question, draft);
  const selected = questionDraftSelections(question, draft);
  const choices = question.options.length > 0;
  const answerable = isAnswerableAgentQuestion(question);
  const textField = answerable && (!choices || otherChosen);
  const names = [ids.header, ids.title].filter((id): id is string => Boolean(id)).join(" ");
  const descriptions = (...extra: Array<string | null>) =>
    [question.context ? ids.context : null, ids.requirement, ...describedBy, ...extra]
      .filter((id): id is string => Boolean(id)).join(" ");
  const keycap = (index: number) => showKeyHints && index < 9 ? <kbd aria-hidden="true">{index + 1}</kbd> : undefined;

  const options: ChoiceRowOption<string>[] = [
    ...question.options.map((option, index) => ({
      value: String(index),
      title: option.label,
      description: option.description,
      meta: keycap(index),
      disabled,
      inputData: { "data-session-request-control": `question:${question.id}:option:${index}` },
    })),
    ...(answerable ? [{
      value: "other",
      title: QUESTION_CARD_COPY.somethingElse,
      meta: keycap(question.options.length),
      disabled,
      inputData: { "data-session-request-control": `question:${question.id}:other` },
    }] : []),
  ];
  const optionIndex = (label: string) => String(question.options.findIndex((option) => option.label === label));
  const choose = (value: string) => onChoose(value === "other" ? "other" : Number(value));
  const choiceError = error && !textField ? ids.error : null;
  const textValue = draft?.kind === "other" || (draft?.kind === "entry" && (!choices || otherChosen))
    ? questionDraftText(draft) : "";

  return (
    <div className="question-step">
      {question.context && (
        <div className="question-context" id={ids.context}>
          <StructuredQuestionText>{question.context}</StructuredQuestionText>
        </div>
      )}
      <span className="sr-only" id={ids.requirement}>
        {question.required === false ? QUESTION_CARD_COPY.optionalSentence : QUESTION_CARD_COPY.required}
      </span>
      {responseStyle === "composer" ? (
        choices && (
          <ol className="question-text-options" aria-label="Offered Choices">
            {question.options.map((option) => (
              <li key={option.label}>
                <span className="question-label">{option.label}</span>
                {option.description && <span className="question-desc">{option.description}</span>}
              </li>
            ))}
          </ol>
        )
      ) : (
        <div className="field question-answer">
          {choices && (
            question.multiSelect ? (
              <ChoiceRows
                multiple
                label={QUESTION_CARD_COPY.question}
                labelledBy={names}
                describedBy={descriptions(choiceError)}
                options={options}
                value={otherChosen ? ["other"] : selected.map(optionIndex)}
                onChange={choose}
              />
            ) : (
              <ChoiceRows
                label={QUESTION_CARD_COPY.question}
                labelledBy={names}
                describedBy={descriptions(choiceError)}
                invalid={Boolean(choiceError)}
                options={options}
                value={otherChosen ? "other" : selected[0] !== undefined ? optionIndex(selected[0]) : null}
                onChange={choose}
              />
            )
          )}
          {textField && (
            <input
              className="input question-input"
              data-session-request-control={`question:${question.id}:input`}
              aria-labelledby={choices ? `${names} ${ids.somethingElse}` : names}
              aria-describedby={descriptions(error ? ids.error : null)}
              aria-invalid={error ? true : undefined}
              aria-required={choices ? undefined : question.required !== false}
              disabled={inputDisabled}
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
              value={textValue}
              autoComplete="off"
              onChange={(event) => onText(event.target.value)}
            />
          )}
          {choices && <span hidden id={ids.somethingElse}>{QUESTION_CARD_COPY.somethingElseField}</span>}
          {error && <FieldError id={ids.error}>{error}</FieldError>}
        </div>
      )}
    </div>
  );
}
