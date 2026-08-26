import {
  isSupportedAgentQuestion,
  validateQuestionFreeText,
  type AgentQuestion,
} from "@wollipog/protocol";

export interface ResolvedQuestionResponse {
  answer?: string | string[];
  error?: string;
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

/** Deterministically translate one visible response into the provider's exact normalized shape. */
export function resolveQuestionResponse(question: AgentQuestion, rawValue: string): ResolvedQuestionResponse {
  if (!isSupportedAgentQuestion(question)) {
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
  const current = resolveQuestionResponse({ ...question, required: false }, rawValue).answer;
  const labels = Array.isArray(current) ? current : [];
  return formatQuestionChoiceLabels(labels.includes(label)
    ? labels.filter((candidate) => candidate !== label)
    : [...labels, label]);
}

const questionDraftStore = new Map<string, Record<string, string>>();
const QUESTION_DRAFT_LIMIT = 50;

function draftKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

/** Page-lifetime drafts survive transcript virtualization without ever persisting secret answers. */
export function storedQuestionDrafts(sessionId: string, requestId: string): Record<string, string> {
  return { ...(questionDraftStore.get(draftKey(sessionId, requestId)) ?? {}) };
}

export function storeQuestionDrafts(sessionId: string, requestId: string, values: Record<string, string>): void {
  const key = draftKey(sessionId, requestId);
  questionDraftStore.delete(key);
  questionDraftStore.set(key, { ...values });
  while (questionDraftStore.size > QUESTION_DRAFT_LIMIT) {
    questionDraftStore.delete(questionDraftStore.keys().next().value!);
  }
}

export function clearQuestionDrafts(sessionId: string, requestId: string): void {
  questionDraftStore.delete(draftKey(sessionId, requestId));
}
