import type { DecisionAnswerView, DecisionQuestionView, DecisionTypedAnswersView } from "@wollipog/protocol";
import { CheckIcon, CloseIcon, WarningIcon } from "./Icons.js";

/** How the server treated one answer: it counts only at or above the kind's threshold. */
export type DecisionAnswerStanding = "satisfies" | "violates" | "unsure";

export function decisionAnswerStanding(answer: Pick<DecisionAnswerView, "assessment" | "confidence">, threshold: number): DecisionAnswerStanding {
  if (answer.confidence < threshold || answer.assessment === "unknown") return "unsure";
  return answer.assessment === "satisfied" ? "satisfies" : "violates";
}

const VERBS: Record<DecisionAnswerStanding, string> = { satisfies: "Satisfies", violates: "Violates", unsure: "Unsure About" };

/** One checklist line: "Issue 4120 Violates 'Skip Security'", or "Satisfies 'Count Matches'" for a
 * question asked once. */
export function decisionAnswerClaim(question: DecisionQuestionView, answer: DecisionAnswerView, threshold: number): string {
  const item = answer.itemId === undefined ? null : question.items?.find((candidate) => candidate.id === answer.itemId);
  const verb = VERBS[decisionAnswerStanding(answer, threshold)];
  // A parameterized question names its complete parameter: a shortened label could make two
  // different constraints read alike.
  return `${item ? `${item.label} ` : ""}${verb} '${question.parameter ?? question.label}'`;
}

/** The answer's value in words, as the question allowed it. */
export function decisionAnswerValueText(question: DecisionQuestionView, value: DecisionAnswerView["value"]): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    return question.answer.type === "score" ? `${value} on ${question.answer.minimum} to ${question.answer.maximum}` : String(value);
  }
  return value.replace(/_/gu, " ");
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

const ICONS = { satisfies: CheckIcon, violates: CloseIcon, unsure: WarningIcon } as const;

/**
 * A typed Decision's answers as a short checklist (#4283): one line per question, and per item where
 * the question asked about each one, with the answer, its confidence and the model's evidence. The
 * verdict beside it is the server's derivation from these answers, never the model's choice.
 */
export function DecisionAnswerChecklist({ typed }: { typed: DecisionTypedAnswersView }) {
  const questions = new Map(typed.questions.map((question) => [question.questionId, question]));
  const decisive = typed.decisive;
  return (
    <div className="decision-answers">
      <span className="campaign-status-meta">Answers count at {percent(typed.confidenceThreshold)} confidence or more.</span>
      <ul className="decision-answer-list" aria-label="Answers">
        {typed.answers.map((answer) => {
          const question = questions.get(answer.questionId);
          if (!question) return null;
          const standing = decisionAnswerStanding(answer, typed.confidenceThreshold);
          const Icon = ICONS[standing];
          const decided = decisive?.questionId === answer.questionId && decisive.itemId === answer.itemId;
          return (
            <li key={`${answer.questionId}\u0000${answer.itemId ?? ""}`} className="decision-answer" data-standing={standing}>
              <Icon size={14} className="decision-answer-icon" />
              <span className="decision-answer-claim">{decisionAnswerClaim(question, answer, typed.confidenceThreshold)}</span>
              <span className="campaign-status-meta">
                Answered {decisionAnswerValueText(question, answer.value)} with {percent(answer.confidence)} confidence
                {decided ? "; this answer decided the verdict" : ""}. {answer.evidence}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
