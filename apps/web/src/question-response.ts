import {
  isSupportedAgentQuestion,
  validateQuestionFreeText,
  type AgentQuestion,
} from "@wollipog/protocol";

export interface ResolvedQuestionResponse {
  answer?: string | string[];
  error?: string;
}

/** The user's intent is retained separately from the provider-shaped value. In particular, an
 * Interactive Form Other response must not turn into a fixed choice while it is being typed. */
export type QuestionResponseDraft =
  | { kind: "choice"; labels: string[] }
  | { kind: "other"; value: string }
  | { kind: "entry"; value: string };

export function isAnswerableAgentQuestion(question: AgentQuestion): boolean {
  return isSupportedAgentQuestion(question) && (question.options.length > 0 || question.allowOther === true);
}

function offeredLabel(question: AgentQuestion, token: string): string | null {
  if (/^\d+$/.test(token)) {
    const index = Number(token) - 1;
    return question.options[index]?.label ?? null;
  }
  const caseExact = question.options.find((option) => option.label === token);
  if (caseExact) return caseExact.label;
  const normalized = token.toLowerCase();
  const matches = question.options.filter((option) => option.label.toLowerCase() === normalized);
  return matches.length === 1 ? matches[0]!.label : null;
}

function splitChoiceTokens(value: string): { tokens?: string[]; error?: string } {
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '"') {
      if (quoted && value[index + 1] === '"') {
        token += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      tokens.push(token.trim());
      token = "";
    } else {
      token += char;
    }
  }
  if (quoted) return { error: "Close the quoted option label." };
  tokens.push(token.trim());
  return { tokens: tokens.filter(Boolean) };
}

export function formatQuestionChoiceLabels(labels: readonly string[]): string {
  return labels.map((label) => /[",]/.test(label) ? `"${label.replace(/"/g, '""')}"` : label).join(", ");
}

/** Parse only the offered-choice identity, deliberately ignoring required/cardinality bounds. The
 * Interactive Form needs to show and toggle an incomplete or over-full selection so the user can
 * reach (or recover back to) a valid state. */
export function offeredQuestionChoices(question: AgentQuestion, rawValue: string): string[] | null {
  const value = rawValue.trim();
  if (!value) return [];
  if (!question.multiSelect) {
    const label = offeredLabel(question, value);
    return label ? [label] : null;
  }
  const wholeLabel = offeredLabel(question, value);
  const parsed = wholeLabel ? { tokens: [wholeLabel] } : splitChoiceTokens(value);
  if (parsed.error) return null;
  const labels: string[] = [];
  for (const token of parsed.tokens!) {
    const label = offeredLabel(question, token);
    if (!label) return null;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** Deterministically translate one visible response into the provider's exact normalized shape. */
export function resolveQuestionResponse(question: AgentQuestion, rawValue: string): ResolvedQuestionResponse {
  if (!isAnswerableAgentQuestion(question)) {
    return { error: "This question format is unsupported." };
  }
  const value = rawValue.trim();
  if (!value) {
    return question.required === false ? {} : { error: "Enter a response." };
  }

  if (question.multiSelect) {
    const wholeLabel = offeredLabel(question, value);
    const parsed = wholeLabel ? { tokens: [wholeLabel] } : splitChoiceTokens(value);
    if (parsed.error) return { error: parsed.error };
    const tokens = parsed.tokens!;
    const labels: string[] = [];
    for (const token of tokens) {
      const label = offeredLabel(question, token);
      if (!label) return { error: `“${token}” is not a displayed number or unambiguous option label.` };
      if (labels.includes(label)) return { error: `“${label}” was selected more than once.` };
      labels.push(label);
    }
    const minimum = question.minSelections ?? (question.required === false ? 0 : 1);
    if (labels.length < minimum) return { error: `Select at least ${minimum} option${minimum === 1 ? "" : "s"}.` };
    if (question.maxSelections != null && labels.length > question.maxSelections) {
      return { error: `Select at most ${question.maxSelections} option${question.maxSelections === 1 ? "" : "s"}.` };
    }
    return { answer: labels };
  }

  const label = offeredLabel(question, value);
  if (label) return { answer: label };
  if (!question.allowOther) {
    return { error: "Enter a displayed number or unambiguous option label." };
  }
  const freeTextError = validateQuestionFreeText(question, value);
  return freeTextError ? { error: `Response ${freeTextError}.` } : { answer: value };
}

/** Validate an explicit Interactive Form Other response without applying Composer Response's displayed
 * number or offered-label syntax. */
function resolveQuestionOtherResponse(question: AgentQuestion, rawValue: string): ResolvedQuestionResponse {
  if (!isAnswerableAgentQuestion(question) || question.multiSelect || !question.allowOther) {
    return { error: "This question format is unsupported." };
  }
  const value = rawValue.trim();
  if (!value) return question.required === false ? {} : { error: "Enter a response." };
  const freeTextError = validateQuestionFreeText(question, value);
  return freeTextError ? { error: `Response ${freeTextError}.` } : { answer: value };
}

export function questionAnswers(
  questions: AgentQuestion[],
  values: Record<string, string>,
): { answers: Record<string, string | string[]>; errors: Record<string, string> } {
  const answers: Record<string, string | string[]> = {};
  const errors: Record<string, string> = {};
  for (const question of questions) {
    const rawValue = Object.hasOwn(values, question.id) ? values[question.id]! : "";
    const resolved = resolveQuestionResponse(question, rawValue);
    const target = resolved.error ? errors : answers;
    const value = resolved.error ?? resolved.answer;
    if (value !== undefined) {
      Object.defineProperty(target, question.id, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
  }
  return { answers, errors };
}

export function toggleQuestionChoice(question: AgentQuestion, rawValue: string, label: string): string {
  if (!question.multiSelect) return label;
  const labels = offeredQuestionChoices(question, rawValue) ?? [];
  return formatQuestionChoiceLabels(labels.includes(label)
    ? labels.filter((candidate) => candidate !== label)
    : [...labels, label]);
}

export function questionDraftText(draft: QuestionResponseDraft | undefined): string {
  return draft?.kind === "choice" ? formatQuestionChoiceLabels(draft.labels) : draft?.value ?? "";
}

export function questionDraftSelections(
  question: AgentQuestion,
  draft: QuestionResponseDraft | undefined,
): string[] {
  if (draft?.kind === "choice") return draft.labels;
  if (draft?.kind === "entry") return offeredQuestionChoices(question, draft.value) ?? [];
  return [];
}

export function questionDraftAnswers(
  questions: AgentQuestion[],
  drafts: Record<string, QuestionResponseDraft>,
): { answers: Record<string, string | string[]>; errors: Record<string, string> } {
  const answers: Record<string, string | string[]> = {};
  const errors: Record<string, string> = {};
  for (const question of questions) {
    const draft = Object.hasOwn(drafts, question.id) ? drafts[question.id] : undefined;
    let resolved: ResolvedQuestionResponse;
    if (draft?.kind === "other") {
      resolved = resolveQuestionOtherResponse(question, draft.value);
    } else if (draft?.kind !== "choice") {
      resolved = resolveQuestionResponse(question, questionDraftText(draft));
    } else if (!isAnswerableAgentQuestion(question)) {
      resolved = { error: "This question format is unsupported." };
    } else if (draft.labels.length === 0) {
      resolved = question.required === false ? {} : { error: "Enter a response." };
    } else if (draft.labels.some((label) => !question.options.some((option) => option.label === label))) {
      resolved = { error: "Select only offered options." };
    } else if (new Set(draft.labels).size !== draft.labels.length) {
      resolved = { error: "Select each option only once." };
    } else if (!question.multiSelect) {
      resolved = draft.labels.length === 1
        ? { answer: draft.labels[0] }
        : { error: "Select one option." };
    } else {
      const minimum = question.minSelections ?? (question.required === false ? 0 : 1);
      resolved = draft.labels.length < minimum
        ? { error: `Select at least ${minimum} option${minimum === 1 ? "" : "s"}.` }
        : question.maxSelections != null && draft.labels.length > question.maxSelections
          ? { error: `Select at most ${question.maxSelections} option${question.maxSelections === 1 ? "" : "s"}.` }
          : { answer: [...draft.labels] };
    }
    const target = resolved.error ? errors : answers;
    const value = resolved.error ?? resolved.answer;
    if (value === undefined) continue;
    Object.defineProperty(target, question.id, {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
  return { answers, errors };
}

const questionDraftStore = new Map<string, Record<string, QuestionResponseDraft>>();
const pendingQuestionOperations = new Set<string>();
const QUESTION_DRAFT_LIMIT = 50;

function draftKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

/** Prevent two mounted response surfaces from delivering the same live request concurrently. */
export function claimQuestionResponseOperation(sessionId: string, requestId: string): (() => void) | null {
  const key = draftKey(sessionId, requestId);
  if (pendingQuestionOperations.has(key)) return null;
  pendingQuestionOperations.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingQuestionOperations.delete(key);
  };
}

/** Page-lifetime drafts let the question surface survive transcript virtualization. */
export function storedQuestionDrafts(sessionId: string, requestId: string): Record<string, QuestionResponseDraft> {
  return structuredClone(questionDraftStore.get(draftKey(sessionId, requestId)) ?? {});
}

export function storeQuestionDrafts(
  sessionId: string,
  requestId: string,
  values: Record<string, QuestionResponseDraft>,
): void {
  const key = draftKey(sessionId, requestId);
  questionDraftStore.delete(key);
  questionDraftStore.set(key, structuredClone(values));
  while (questionDraftStore.size > QUESTION_DRAFT_LIMIT) {
    questionDraftStore.delete(questionDraftStore.keys().next().value!);
  }
}

export function clearQuestionDrafts(sessionId: string, requestId: string): void {
  questionDraftStore.delete(draftKey(sessionId, requestId));
}
