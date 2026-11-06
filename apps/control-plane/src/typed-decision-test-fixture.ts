import type { DecisionQuestionAnswer, TypedDecisionDefinition } from "./decision-questions.js";

/** Fake typed answers (#4283) shared by the fake Decision harnesses. No test calls a real provider. */

/** One fake typed answer; the confidence defaults to 0.95 and the evidence to a fixed line. */
export interface FakeTypedAnswer { value: boolean | string | number; confidence?: number; evidence?: string }

export function satisfiedValue(answer: DecisionQuestionAnswer): boolean | string | number {
  switch (answer.type) {
    case "boolean": return answer.satisfiedWhen;
    case "choice": return answer.satisfied[0]!;
    case "score": return answer.maximum;
  }
}

export function violatedValue(answer: DecisionQuestionAnswer): boolean | string | number {
  switch (answer.type) {
    case "boolean": return !answer.satisfiedWhen;
    case "choice": return answer.violated[0]!;
    case "score": return answer.minimum;
  }
}

/** A typed kind's complete output: every question answered satisfied with confidence 0.95, except
 * the listed ones. The migrated kinds ask no per-item or parameterized question. */
export function typedOutput(typed: TypedDecisionDefinition, answers: Readonly<Record<string, FakeTypedAnswer>> = {}): Record<string, unknown> {
  for (const id of Object.keys(answers)) {
    if (!typed.questions.some((question) => question.questionId === id)) throw new Error(`no question ${id}`);
  }
  return Object.fromEntries(typed.questions.map((question) => {
    if (question.subject || question.parameterized) throw new Error("the fake answers only questions asked once");
    const chosen = answers[question.questionId];
    return [question.questionId, {
      value: chosen?.value ?? satisfiedValue(question.answer),
      confidence: chosen?.confidence ?? 0.95,
      evidence: chosen?.evidence ?? "The quoted data says so.",
    }];
  }));
}

/** The answers that make the server derive `verdict` for a typed kind: the admitting verdict answers
 * every question satisfied, the refusing one violates the first question confidently, and
 * `uncertain` answers the first question below the kind's threshold. */
export function typedAnswersFor(typed: TypedDecisionDefinition, verdict: string): Record<string, FakeTypedAnswer> {
  const first = typed.questions[0]!;
  if (verdict === typed.verdicts.admit) return {};
  if (verdict === typed.verdicts.refuse) return { [first.questionId]: { value: violatedValue(first.answer) } };
  if (verdict === "uncertain") {
    return { [first.questionId]: { value: satisfiedValue(first.answer), confidence: typed.confidenceThreshold / 2 } };
  }
  throw new Error(`a typed kind never derives ${verdict}`);
}
