import type {
  DecisionAnswerAssessment,
  DecisionAnswerType,
  DecisionAnswerView,
  DecisionQuestionItemView,
  DecisionQuestionView,
  DecisionTypedAnswersView,
} from "@wollipog/protocol";
import {
  DECISION_EVIDENCE_MAX_CHARS,
  DECISION_MAX_ANSWERS,
  DECISION_MAX_QUESTION_ITEMS,
  DECISION_MAX_QUESTIONS,
  DECISION_QUESTION_LABEL_MAX_CHARS,
  DECISION_QUESTION_PARAMETER_MAX_CHARS,
} from "@wollipog/protocol";

/**
 * Typed Decision questions (#4283).
 *
 * A typed kind asks the Decision Model a fixed list of questions, each with allowed answers, in one
 * call whose output schema requires one answer per question and per item. Each answer carries a
 * value, a confidence and a short evidence string. The verdict is the server's: it is derived here
 * from the answers by the kind's fixed rule and confidence threshold, so the model never chooses it,
 * and nothing in quoted data can add a question, change an answer type or set the verdict.
 */

/** A question's allowed answers and what each one means for the verdict. */
export type DecisionQuestionAnswer =
  /** `satisfiedWhen` satisfies; the other value violates. */
  | { type: "boolean"; satisfiedWhen: boolean }
  /** Values in neither list (such as `cannot_tell`) are `unknown`, which never admits or refuses. */
  | { type: "choice"; values: readonly string[]; satisfied: readonly string[]; violated: readonly string[] }
  /** At least `satisfiedAtLeast` satisfies, at most `violatedAtMost` violates, anything between is unknown. */
  | { type: "score"; minimum: number; maximum: number; satisfiedAtLeast: number; violatedAtMost: number };

/** One fixed question of a typed kind. Its text is trusted and never contains caller data. */
export interface DecisionQuestionTemplate {
  /** Stable id, a lowercase identifier. */
  questionId: string;
  /** Short Title Case display label. A parameterized question's instances use their parameter. */
  label: string;
  text: string;
  answer: DecisionQuestionAnswer;
  /** Ask one answer per item of this caller-supplied subject ("for each proposed issue"). */
  subject?: string;
  /** Ask once per caller-supplied parameter (such as each constraint the owner stated), quoted as
   * data. Zero parameters ask nothing; instances are `<questionId>__<n>`. */
  parameterized?: boolean;
}

/** A kind's typed questions and its fixed derivation rule. */
export interface TypedDecisionDefinition {
  /** Fixed per kind and recorded on every occurrence: an answer below it never admits or refuses. */
  confidenceThreshold: number;
  questions: readonly DecisionQuestionTemplate[];
  /** The kind's names for the derived verdicts; `uncertain` is always `uncertain`. */
  verdicts: { admit: string; refuse: string };
}

/** What a caller supplies for a typed call besides the kind's quoted data fields. */
export interface DecisionQuestionInputs {
  /** Each per-item subject's items, in the order they are shown. */
  subjects?: Readonly<Record<string, readonly DecisionQuestionItemView[]>>;
  /** Each parameterized question's parameters, by template id. */
  parameters?: Readonly<Record<string, readonly string[]>>;
}

/** One question as asked in one occurrence. */
export interface DecisionQuestionInstance {
  questionId: string;
  templateId: string;
  label: string;
  text: string;
  answer: DecisionQuestionAnswer;
  parameter?: string;
  subject?: string;
  items?: readonly DecisionQuestionItemView[];
}

export class DecisionQuestionError extends Error {
  override readonly name = "DecisionQuestionError";
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,47}$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._/#:-]{0,79}$/;
const PARAMETER_MAX_CHARS = DECISION_QUESTION_PARAMETER_MAX_CHARS;

function oneLine(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
}

/** Check a kind's typed definition once, so a malformed kind fails at load, not in a campaign. */
export function assertTypedDefinition(kind: string, typed: TypedDecisionDefinition): void {
  const fail = (detail: string) => { throw new DecisionQuestionError(`${kind}: ${detail}`); };
  if (!(typed.confidenceThreshold > 0 && typed.confidenceThreshold <= 1)) fail("the confidence threshold must be in (0, 1]");
  if (!typed.questions.length) fail("a typed kind needs at least one question");
  if (typed.verdicts.admit === typed.verdicts.refuse || [typed.verdicts.admit, typed.verdicts.refuse].includes("uncertain")) {
    fail("admit, refuse and uncertain must be distinct verdicts");
  }
  const ids = new Set<string>();
  for (const question of typed.questions) {
    if (!IDENTIFIER.test(question.questionId) || question.questionId.includes("__")) fail(`bad question id ${question.questionId}`);
    if (ids.has(question.questionId)) fail(`duplicate question id ${question.questionId}`);
    ids.add(question.questionId);
    if (question.subject !== undefined && !IDENTIFIER.test(question.subject)) fail(`bad subject ${question.subject}`);
    const answer = question.answer;
    if (answer.type === "choice") {
      if (!answer.values.length || new Set(answer.values).size !== answer.values.length ||
          answer.values.some((value) => !IDENTIFIER.test(value))) fail(`${question.questionId}: bad choice values`);
      const ruled = [...answer.satisfied, ...answer.violated];
      if (new Set(ruled).size !== ruled.length || ruled.some((value) => !answer.values.includes(value)) ||
          !answer.satisfied.length) fail(`${question.questionId}: bad choice rule`);
    }
    if (answer.type === "score") {
      const integers = [answer.minimum, answer.maximum, answer.satisfiedAtLeast, answer.violatedAtMost];
      if (integers.some((value) => !Number.isSafeInteger(value)) || answer.minimum >= answer.maximum ||
          answer.violatedAtMost >= answer.satisfiedAtLeast || answer.satisfiedAtLeast > answer.maximum ||
          answer.violatedAtMost < answer.minimum - 1) fail(`${question.questionId}: bad score rule`);
    }
  }
}

/** The protocol's answer type for a question: the allowed answers without the rule. */
export function decisionAnswerType(answer: DecisionQuestionAnswer): DecisionAnswerType {
  switch (answer.type) {
    case "boolean": return { type: "boolean" };
    case "choice": return { type: "choice", values: [...answer.values] };
    case "score": return { type: "score", minimum: answer.minimum, maximum: answer.maximum };
  }
}

/** Expand a kind's questions with the caller's subjects and parameters. Anything malformed, missing,
 * unused or too large throws: a typed decision never asks a partial set of questions. */
export function instantiateQuestions(typed: TypedDecisionDefinition, inputs: DecisionQuestionInputs): DecisionQuestionInstance[] {
  const subjects = inputs.subjects ?? {};
  const parameters = inputs.parameters ?? {};
  const usedSubjects = new Set(typed.questions.flatMap((question) => question.subject ? [question.subject] : []));
  const parameterized = new Set(typed.questions.flatMap((question) => question.parameterized ? [question.questionId] : []));
  for (const name of Object.keys(subjects)) {
    if (!usedSubjects.has(name)) throw new DecisionQuestionError(`no question asks about the subject ${name}`);
  }
  for (const name of Object.keys(parameters)) {
    if (!parameterized.has(name)) throw new DecisionQuestionError(`no question takes parameters named ${name}`);
  }
  const checkedItems = new Map<string, DecisionQuestionItemView[]>();
  for (const name of usedSubjects) {
    const items = subjects[name];
    if (!items?.length) throw new DecisionQuestionError(`the subject ${name} needs at least one item`);
    if (items.length > DECISION_MAX_QUESTION_ITEMS) throw new DecisionQuestionError(`the subject ${name} has too many items`);
    const ids = new Set<string>();
    checkedItems.set(name, items.map((item) => {
      const label = typeof item.label === "string" ? oneLine(item.label) : "";
      if (typeof item.id !== "string" || !ITEM_ID.test(item.id) || ids.has(item.id) || !label ||
          label.length > DECISION_QUESTION_LABEL_MAX_CHARS) {
        throw new DecisionQuestionError(`the subject ${name} has a malformed or repeated item`);
      }
      ids.add(item.id);
      return { id: item.id, label };
    }));
  }
  const instances: DecisionQuestionInstance[] = [];
  for (const question of typed.questions) {
    const items = question.subject ? checkedItems.get(question.subject)! : undefined;
    const base = { templateId: question.questionId, text: question.text, answer: question.answer,
      ...(items ? { subject: question.subject!, items } : {}) };
    if (!question.parameterized) {
      instances.push({ ...base, questionId: question.questionId, label: question.label });
      continue;
    }
    (parameters[question.questionId] ?? []).forEach((raw, index) => {
      const parameter = typeof raw === "string" ? oneLine(raw) : "";
      if (!parameter || parameter.length > PARAMETER_MAX_CHARS) {
        throw new DecisionQuestionError(`a parameter of ${question.questionId} is empty or too long`);
      }
      const label = parameter.length > DECISION_QUESTION_LABEL_MAX_CHARS
        ? `${parameter.slice(0, DECISION_QUESTION_LABEL_MAX_CHARS - 1)}…` : parameter;
      instances.push({ ...base, questionId: `${question.questionId}__${index + 1}`, label, parameter });
    });
  }
  if (!instances.length) throw new DecisionQuestionError("the decision asks no question");
  if (instances.length > DECISION_MAX_QUESTIONS) throw new DecisionQuestionError("the decision asks too many questions");
  const answers = instances.reduce((total, instance) => total + (instance.items?.length ?? 1), 0);
  if (answers > DECISION_MAX_ANSWERS) throw new DecisionQuestionError("the decision needs too many answers");
  return instances;
}

function valueSchema(answer: DecisionQuestionAnswer): Record<string, unknown> {
  switch (answer.type) {
    case "boolean": return { type: "boolean" };
    case "choice": return { type: "string", enum: [...answer.values] };
    case "score": return { type: "integer", minimum: answer.minimum, maximum: answer.maximum };
  }
}

function answerSchema(instance: DecisionQuestionInstance): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    ...(instance.items ? { item: { type: "string", enum: instance.items.map((item) => item.id) } } : {}),
    value: valueSchema(instance.answer),
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: { type: "string", maxLength: DECISION_EVIDENCE_MAX_CHARS },
  };
  const object = { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  return instance.items
    ? { type: "array", minItems: instance.items.length, maxItems: instance.items.length, items: object }
    : object;
}

/** The one output schema of a typed call: exactly one property per question, each requiring a
 * value from the allowed answers, a confidence and evidence, and one entry per item where defined.
 * There is no verdict property. The same schema goes to Claude Code's `--json-schema` and Codex's
 * strict `outputSchema`. */
export function typedOutputSchema(instances: readonly DecisionQuestionInstance[]): Record<string, unknown> {
  const properties = Object.fromEntries(instances.map((instance) => [instance.questionId, answerSchema(instance)]));
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

function answerDescription(answer: DecisionQuestionAnswer): string {
  switch (answer.type) {
    case "boolean": return "true or false";
    case "choice": return `one of ${answer.values.join(", ")}`;
    case "score": return `an integer from ${answer.minimum} to ${answer.maximum}`;
  }
}

/** Render the questions after the kind's quoted data. Question text is the kind's own; every
 * parameter and item label is quoted data in its own element. */
export function renderQuestions(instances: readonly DecisionQuestionInstance[], quote: (value: string) => string): string {
  const parts = [
    "Questions. Answer every one in the output property named by its id. A question marked per item needs " +
    "exactly one answer for each listed item, naming the item by its id.",
  ];
  const subjects = new Map<string, readonly DecisionQuestionItemView[]>();
  for (const instance of instances) {
    const attributes = [`id="${instance.questionId}"`, `answer="${answerDescription(instance.answer)}"`];
    const subject = instance.items ? `items_${instance.subject!}` : null;
    if (subject) {
      attributes.push(`per_item="${subject}"`);
      subjects.set(subject, instance.items!);
    }
    const body = instance.parameter === undefined
      ? instance.text
      : `${instance.text}\n<untrusted_data name="parameter">\n${quote(instance.parameter)}\n</untrusted_data>`;
    parts.push(`<question ${attributes.join(" ")}>\n${body}\n</question>`);
  }
  for (const [name, items] of subjects) {
    parts.push(`<untrusted_data name="${name}">\n${quote(JSON.stringify(items))}\n</untrusted_data>`);
  }
  return parts.join("\n\n");
}

const ANSWER_KEYS = ["value", "confidence", "evidence"] as const;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validValue(answer: DecisionQuestionAnswer, value: unknown): value is boolean | string | number {
  switch (answer.type) {
    case "boolean": return typeof value === "boolean";
    case "choice": return typeof value === "string" && answer.values.includes(value);
    case "score": return typeof value === "number" && Number.isSafeInteger(value) && value >= answer.minimum && value <= answer.maximum;
  }
}

export function assessAnswer(answer: DecisionQuestionAnswer, value: boolean | string | number): DecisionAnswerAssessment {
  switch (answer.type) {
    case "boolean": return value === answer.satisfiedWhen ? "satisfied" : "violated";
    case "choice":
      return answer.satisfied.includes(value as string) ? "satisfied" : answer.violated.includes(value as string) ? "violated" : "unknown";
    case "score":
      return (value as number) >= answer.satisfiedAtLeast ? "satisfied" : (value as number) <= answer.violatedAtMost ? "violated" : "unknown";
  }
}

function readAnswer(instance: DecisionQuestionInstance, raw: unknown, itemId?: string): DecisionAnswerView | null {
  const keys = itemId === undefined ? ANSWER_KEYS : ["item", ...ANSWER_KEYS];
  if (!exactKeys(raw, keys)) return null;
  const { value, confidence, evidence } = raw;
  if (!validValue(instance.answer, value)) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  if (typeof evidence !== "string" || evidence.length > DECISION_EVIDENCE_MAX_CHARS) return null;
  const normalized = oneLine(evidence);
  if (!normalized) return null;
  return {
    questionId: instance.questionId,
    ...(itemId !== undefined ? { itemId } : {}),
    value,
    confidence,
    evidence: normalized,
    assessment: assessAnswer(instance.answer, value),
  };
}

/** Strictly parse and validate one typed attempt's output. It must be one JSON object with exactly
 * one property per question; each answer exactly its fields, its value from the allowed answers;
 * each per-item question exactly one answer per listed item. Anything else — an added question or
 * field, a verdict, a changed type, a missing or repeated item — returns null and is retried as
 * invalid output; there is no lenient reading. Answers come back in question and item order. */
export function validateTypedAnswers(instances: readonly DecisionQuestionInstance[], outputText: string): DecisionAnswerView[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    return null;
  }
  if (!exactKeys(parsed, instances.map((instance) => instance.questionId))) return null;
  const answers: DecisionAnswerView[] = [];
  for (const instance of instances) {
    const raw = parsed[instance.questionId];
    if (!instance.items) {
      const answer = readAnswer(instance, raw);
      if (!answer) return null;
      answers.push(answer);
      continue;
    }
    if (!Array.isArray(raw) || raw.length !== instance.items.length) return null;
    const byItem = new Map<string, DecisionAnswerView>();
    for (const entry of raw) {
      const itemId = (entry as { item?: unknown } | null)?.item;
      if (typeof itemId !== "string" || byItem.has(itemId) || !instance.items.some((item) => item.id === itemId)) return null;
      const answer = readAnswer(instance, entry, itemId);
      if (!answer) return null;
      byItem.set(itemId, answer);
    }
    for (const item of instance.items) answers.push(byItem.get(item.id)!);
  }
  return answers;
}

export interface DerivedTypedVerdict {
  verdict: string;
  /** A bounded sentence the server writes from the deciding answer; never the model's prose. */
  reason: string;
  typedAnswers: DecisionTypedAnswersView;
}

function percent(threshold: number): string {
  return `${Math.round(threshold * 100)}%`;
}

function answerSubject(instance: DecisionQuestionInstance, answer: DecisionAnswerView): string {
  return answer.itemId === undefined ? "The answer" : instance.items!.find((item) => item.id === answer.itemId)!.label;
}

/**
 * Derive the verdict from validated answers, deterministically:
 * - refuse when any answer is a violation with confidence at or above the threshold (the first, in
 *   question and item order, is named);
 * - admit when every answer is satisfied with confidence at or above the threshold;
 * - otherwise uncertain, naming the first answer that could not admit.
 */
export function deriveTypedVerdict(
  typed: TypedDecisionDefinition,
  instances: readonly DecisionQuestionInstance[],
  answers: readonly DecisionAnswerView[],
): DerivedTypedVerdict {
  const threshold = typed.confidenceThreshold;
  const instanceOf = new Map(instances.map((instance) => [instance.questionId, instance]));
  const confident = (answer: DecisionAnswerView) => answer.confidence >= threshold;
  const questions: DecisionQuestionView[] = instances.map((instance) => ({
    questionId: instance.questionId,
    label: instance.label,
    text: instance.text,
    // The label may be shortened; the audit keeps the complete parameter the model was asked about.
    ...(instance.parameter !== undefined ? { parameter: instance.parameter } : {}),
    answer: decisionAnswerType(instance.answer),
    ...(instance.items ? { items: instance.items.map((item) => ({ ...item })) } : {}),
  }));
  const record = (decisive?: DecisionAnswerView): DecisionTypedAnswersView => ({
    confidenceThreshold: threshold,
    questions,
    answers: answers.map((answer) => ({ ...answer })),
    ...(decisive ? { decisive: { questionId: decisive.questionId, ...(decisive.itemId !== undefined ? { itemId: decisive.itemId } : {}) } } : {}),
  });
  const violation = answers.find((answer) => answer.assessment === "violated" && confident(answer));
  if (violation) {
    const instance = instanceOf.get(violation.questionId)!;
    return {
      verdict: typed.verdicts.refuse,
      reason: `${answerSubject(instance, violation)} violates '${instance.label}'.`,
      typedAnswers: record(violation),
    };
  }
  const open = answers.find((answer) => answer.assessment !== "satisfied" || !confident(answer));
  if (!open) {
    return {
      verdict: typed.verdicts.admit,
      reason: `Every answer is satisfied with at least ${percent(threshold)} confidence.`,
      typedAnswers: record(),
    };
  }
  const instance = instanceOf.get(open.questionId)!;
  const subject = answerSubject(instance, open);
  return {
    verdict: "uncertain",
    reason: open.assessment === "unknown"
      ? `${subject} can't be settled for '${instance.label}'.`
      : `${subject} on '${instance.label}' is below the ${percent(threshold)} confidence threshold.`,
    typedAnswers: record(open),
  };
}
