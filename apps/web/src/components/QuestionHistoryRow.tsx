import type { AgentQuestion, QuestionAnswerSummaryEntry } from "@wollipog/protocol";
import { formatClock, formatRecordedTimestamp } from "../format.js";
import { statusMeta, type StatusValue } from "../status-meta.js";
import type { TimelineItem } from "../timeline.js";
import { CheckIcon, QuestionIcon } from "./Icons.js";
import { StatusBadge } from "./StatusBadge.js";
import { StructuredQuestionText, structuredQuestionSummary } from "./StructuredQuestionText.js";
import { ToolStep } from "./ToolStep.js";

type QuestionItem = Extract<TimelineItem, { kind: "question" }>;

/** The row's inline status (docs/design-system.md §11.2, the `question` domain). */
export function questionOutcome(item: QuestionItem): StatusValue<"question"> {
  if (item.answered === undefined) return "awaiting_answer";
  if (item.resolvedByParentSessionId) return item.answered ? "answered_by_parent" : "dismissed_by_parent";
  if (item.answeredByPolicies?.length) return "answered_by_policy";
  if (item.resolutionReason === "replaced") return "replaced";
  if (item.resolutionReason === "expired") return "expired";
  if (item.resolutionReason === "provider_resolved") return "provider_resolved";
  return item.answered ? "answered" : "dismissed";
}

/** Line 1: the question's header, or its first line. Several questions name every header. */
function questionTitle(questions: readonly AgentQuestion[]): string {
  const first = questions[0];
  if (!first) return "Question";
  const name = (question: AgentQuestion) => question.header?.trim() || structuredQuestionSummary(question.question);
  if (questions.length > 1 && questions.every((question) => question.header?.trim())) {
    return questions.map(name).join(", ");
  }
  return questions.length > 1 ? `${name(first)} (+${questions.length - 1} more)` : name(first);
}

/** Free text in quotes; text the control plane cut at its bound ends in an ellipsis. */
function quoted(entry: QuestionAnswerSummaryEntry): string {
  const text = entry.truncated ? `${entry.text}…` : entry.text;
  return `“${text}”`;
}

function answerValue(entry: QuestionAnswerSummaryEntry): string | null {
  if (entry.withheld) return null;
  if (entry.selected?.length) return entry.selected.join(", ");
  if (entry.text !== undefined) return quoted(entry);
  return null;
}

/** Line 2: "Answer: Destination 1 (Production)", or "Answer not shown" for a secret answer. */
export function questionAnswerLine(item: QuestionItem): string | null {
  const parts: string[] = [];
  if (item.answered && item.answers?.length) {
    const byQuestion = new Map(item.answers.map((entry) => [entry.questionId, entry]));
    const values = item.questions.flatMap((question) => {
      const entry = byQuestion.get(question.id);
      return entry ? [answerValue(entry)] : [];
    });
    if (values.length && values.every((value) => value === null)) parts.push("Answer not shown");
    else if (values.length === 1) parts.push(`Answer: ${values[0]}`);
    else if (values.length) parts.push(`Answers: ${values.map((value) => value ?? "(not shown)").join(" · ")}`);
  }
  if (item.answered && item.answeredByPolicies?.length) parts.push(`Policy: ${item.answeredByPolicies.join(", ")}`);
  return parts.length ? parts.join(" · ") : null;
}

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 12)}…` : id);

/** "Answered by you at 12:31 AM", or who else settled it. */
function resolutionSentence(item: QuestionItem): string | null {
  if (item.answered === undefined) return null;
  const at = item.resolvedAt !== undefined && formatClock(item.resolvedAt) ? ` at ${formatClock(item.resolvedAt)}` : "";
  const parent = item.resolvedByParentSessionId ? `parent session ${shortId(item.resolvedByParentSessionId)}` : null;
  switch (questionOutcome(item)) {
    case "answered_by_parent": return `Answered by ${parent}${at}.`;
    case "dismissed_by_parent": return `Dismissed by ${parent}${at}.`;
    case "answered_by_policy": return `Answered by policy ${item.answeredByPolicies!.join(", ")}${at}.`;
    case "replaced": return `Replaced by a newer question${at}.`;
    case "expired": return `Expired${at}.`;
    case "provider_resolved": return `Resolved by the provider${at}.`;
    case "dismissed": return `Dismissed${at}.`;
    default: return item.answers ? `Answered by you${at}.` : `Answered${at}.`;
  }
}

const SETTLED_VERB: Record<StatusValue<"question">, string> = {
  awaiting_answer: "",
  answered: "answered",
  answered_by_policy: "answered",
  answered_by_parent: "answered",
  dismissed: "dismissed",
  dismissed_by_parent: "dismissed",
  replaced: "replaced",
  expired: "expired",
  provider_resolved: "resolved",
};

/** "Asked 12:30:01 AM, answered 12:31:05 AM": the exact times behind the row's one clock time. */
function timing(item: QuestionItem): string | undefined {
  const asked = formatRecordedTimestamp(item.createdAt)?.label;
  const verb = SETTLED_VERB[questionOutcome(item)];
  const settled = verb ? formatRecordedTimestamp(item.resolvedAt)?.label : undefined;
  const parts = [asked && `asked ${asked}`, settled && `${verb} ${settled}`].filter(Boolean);
  if (!parts.length) return undefined;
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * An agent's question as one step (#2188): line 1 its header or first line, line 2 the answer, then
 * the time and an inline status. The body shows each question once with its options, a check on the
 * chosen ones, free text in quotes, and who answered. Secret and email answers were never stored, so
 * they read "Answer not shown".
 */
export function QuestionHistoryRow({ item, open, onToggle }: {
  item: QuestionItem;
  open: boolean;
  onToggle?: () => void;
}) {
  const title = questionTitle(item.questions);
  const answerLine = questionAnswerLine(item);
  const meta = statusMeta("question", questionOutcome(item));
  const time = formatClock(item.resolvedAt ?? item.createdAt);
  const timestamp = formatRecordedTimestamp(item.resolvedAt ?? item.createdAt);
  const multiple = item.questions.length > 1;
  const byQuestion = new Map((item.answered ? item.answers ?? [] : []).map((entry) => [entry.questionId, entry]));
  const resolution = resolutionSentence(item);
  return (
    <div className="tl-question">
      <ToolStep
        icon={<QuestionIcon size={16} />}
        verb={title}
        detail={answerLine ?? undefined}
        trail={time && timestamp ? <time dateTime={timestamp.dateTime}>{time}</time> : undefined}
        timing={timing(item)}
        status={<StatusBadge meta={meta} inline className="tl-step-status" />}
        label={[title, answerLine, meta.label].filter(Boolean).join(" · ")}
        open={open}
        onToggle={onToggle}
      >
        <div className="tl-question-body">
          {item.questions.map((question, index) => {
            const entry = byQuestion.get(question.id);
            return (
              <section className="tl-question-item" key={question.id}>
                {multiple && (
                  <div className="tl-question-label">
                    {multiple && <strong>Question {index + 1}</strong>}
                    {question.header && <span className="question-chip">{question.header}</span>}
                  </div>
                )}
                <StructuredQuestionText>{question.question}</StructuredQuestionText>
                {question.context && (
                  <div className="tl-question-context">
                    <StructuredQuestionText>{question.context}</StructuredQuestionText>
                  </div>
                )}
                {question.options.length > 0 && (
                  <ul className="tl-question-choices" aria-label={multiple ? `Question ${index + 1} Options` : "Options"}>
                    {question.options.map((option) => {
                      const chosen = !entry?.withheld && entry?.selected?.includes(option.label) === true;
                      return (
                        <li key={option.label} className={chosen ? "chosen" : undefined}>
                          <span className="tl-question-check" aria-hidden="true">{chosen && <CheckIcon size={14} />}</span>
                          <span>{option.label}</span>
                          {chosen && <span className="sr-only"> (Chosen)</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {entry?.text !== undefined && <p className="tl-question-free-text">{quoted(entry)}</p>}
                {entry?.withheld && <p className="tl-question-withheld">Answer not shown</p>}
              </section>
            );
          })}
          {resolution && <p className="tl-question-resolution">{resolution}</p>}
        </div>
      </ToolStep>
    </div>
  );
}
