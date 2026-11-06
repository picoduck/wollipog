/**
 * Typed Decision questions (#4283). A Decision kind may ask the Decision Model a fixed list of typed
 * questions instead of one open-ended prompt with a model-chosen verdict. Every question has a stable
 * id, an answer type with allowed answers, and optionally one answer per item of a server-supplied
 * subject ("for each proposed issue"). All of a decision's questions go in one call with one output
 * schema; each answer carries its value, a confidence from 0 to 1 and a short evidence string. The
 * control plane derives the verdict from the answers with the kind's fixed rule and confidence
 * threshold: the model never chooses it.
 */

/** The allowed answers of one typed question. */
export type DecisionAnswerType =
  | { type: "boolean" }
  /** One of a fixed set of values, each a lowercase identifier. */
  | { type: "choice"; values: readonly string[] }
  /** An integer score in a closed range. */
  | { type: "score"; minimum: number; maximum: number };

/** How one answer bears on the verdict. `unknown` is never an admission. */
export type DecisionAnswerAssessment = "satisfied" | "violated" | "unknown";

/** One item a per-item question asks about, as the server supplied it. */
export interface DecisionQuestionItemView {
  /** The item's stable id in the output schema, such as `team/repo#4120`. */
  id: string;
  /** Short display label, such as `Issue 4120`. */
  label: string;
}

/** One question as it was asked, for the audit and Campaign Status. */
export interface DecisionQuestionView {
  /** Stable id within the occurrence; a parameterized question's instances add `__<n>`. */
  questionId: string;
  /** Short display label, such as `Skip Security`. */
  label: string;
  /** The question text the model saw, without its quoted parameter. */
  text: string;
  answer: DecisionAnswerType;
  /** Present for a per-item question: every item it asked one answer for, in order. */
  items?: DecisionQuestionItemView[];
}

/** One typed answer the model gave, with the server's assessment of it. */
export interface DecisionAnswerView {
  questionId: string;
  /** Present for a per-item question's answer. */
  itemId?: string;
  value: boolean | string | number;
  /** The model's confidence, 0 to 1. */
  confidence: number;
  /** A short quote or fact the model gave for its answer. */
  evidence: string;
  /** What the value means under the kind's rule, before the confidence threshold. */
  assessment: DecisionAnswerAssessment;
}

/** A typed occurrence's questions, answers and the server-derived verdict (#4283). Absent on
 * single-verdict occurrences, including every audit record from before typed questions. */
export interface DecisionTypedAnswersView {
  /** The kind's fixed threshold: an answer below it never admits or refuses. */
  confidenceThreshold: number;
  questions: DecisionQuestionView[];
  answers: DecisionAnswerView[];
  /** The answer the verdict names: the first confident violation for a refusal, or the first
   * answer that could not admit for an uncertain verdict. Absent when every answer admitted. */
  decisive?: { questionId: string; itemId?: string };
}

/** Largest number of question instances one decision asks. */
export const DECISION_MAX_QUESTIONS = 24;
/** Largest number of items one per-item subject lists. */
export const DECISION_MAX_QUESTION_ITEMS = 25;
/** Largest number of answers one decision may require across every question and item. */
export const DECISION_MAX_ANSWERS = 60;
/** Longest evidence string an answer may carry. */
export const DECISION_EVIDENCE_MAX_CHARS = 160;
/** Longest question or item label. */
export const DECISION_QUESTION_LABEL_MAX_CHARS = 120;
