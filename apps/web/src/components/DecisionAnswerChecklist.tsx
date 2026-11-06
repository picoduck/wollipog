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

/** A human phrase for each allowed choice answer the Decision kinds ask (#4282, #4283). Display only:
 * the stored value, the audit and the verdict derivation keep the identifier. */
const ANSWER_PHRASES: Readonly<Record<string, string>> = {
  cannot_tell: "Can't tell",
  // Scope check (#4282).
  consistent: "Consistent",
  inconsistent: "Inconsistent",
  asked_for: "Asked for",
  only_mentioned: "Only mentioned",
  satisfies: "Satisfies",
  violates: "Violates",
  complete: "Complete",
  missing_constraint: "A constraint is missing",
  omits_requested: "Leaves out a requested issue",
  respected: "Respected",
  not_respected: "Not respected",
  // Follow-up relatedness and closure reasons (#4283).
  completes_requested_work: "Completes the requested work",
  gap_found_in_requested_work: "A gap found in the requested work",
  separate_work: "Separate work",
  contradicts_evidence: "Contradicts the evidence",
  supports: "Supports",
  does_not_support: "Doesn't support",
};

/** The answer's value in words, as the question allowed it: a known answer's phrase, yes or no, a
 * score on its scale, or an unknown identifier with its underscores read as spaces. */
export function decisionAnswerValueText(question: DecisionQuestionView, value: DecisionAnswerView["value"]): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return question.answer.type === "score" ? `${value} on ${question.answer.minimum} to ${question.answer.maximum}` : String(value);
  }
  const phrase = ANSWER_PHRASES[value] ?? value.replace(/_/gu, " ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
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
                {decisionAnswerValueText(question, answer.value)} ({percent(answer.confidence)} confidence)
                {decided ? "; this answer decided the verdict" : ""}. {answer.evidence}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
