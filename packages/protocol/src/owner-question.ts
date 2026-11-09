import type { AgentQuestion, OwnerDecisionSnapshot, PendingApproval, WorkflowDecisionResourceSnapshot } from "./index.js";
import { presentScopeProposalRequest, scopeProposalOfRequest } from "./scope-proposal.js";

/**
 * Owner Questions (#4270). A Full Control root asks its campaign's owner a design choice, a
 * clarification or a preference with `request_owner_decision` and `kind: "question"`. It stays an
 * `owner_decision` workflow decision on the server, so its owner-only answering, audit and Campaign
 * Status listing are unchanged, but it grants nothing: the owner answers it in their own words, the
 * way any agent question is answered, and a boundary or policy change never revokes it.
 *
 * The question form is derived from the stored snapshot, never stored itself, so the control plane
 * that validates an answer and every client that presents the card build the same form.
 */
export type OwnerQuestionSnapshot = OwnerDecisionSnapshot & { kind: "question" };
export type ChildQuestionSnapshot = Extract<WorkflowDecisionResourceSnapshot, { category: "implementation_question" }> & { kind: "question" };
export type WorkflowQuestionSnapshot = OwnerQuestionSnapshot | ChildQuestionSnapshot;

export function isChildQuestionSnapshot(snapshot: WorkflowDecisionResourceSnapshot | null | undefined): snapshot is ChildQuestionSnapshot {
  return snapshot?.category === "implementation_question" && snapshot.kind === "question";
}

export function isWorkflowQuestionSnapshot(snapshot: WorkflowDecisionResourceSnapshot | null | undefined): snapshot is WorkflowQuestionSnapshot {
  return isOwnerQuestionSnapshot(snapshot) || isChildQuestionSnapshot(snapshot);
}

/** The answer field's id: the owner's choice among the suggested options, or their own words. */
export const OWNER_QUESTION_ANSWER_ID = "owner_question_answer";
/** The note's id: optional words to go with a chosen option. Offered only when there are options. */
export const OWNER_QUESTION_NOTE_ID = "owner_question_note";
/** The most free text one answer field takes. */
export const OWNER_QUESTION_ANSWER_MAX_LENGTH = 4000;
/** The suffix that marks the root's recommended option in its label, as agent questions do. */
export const OWNER_QUESTION_RECOMMENDED_SUFFIX = " (Recommended)";

export function isOwnerQuestionSnapshot(snapshot: WorkflowDecisionResourceSnapshot | null | undefined): snapshot is OwnerQuestionSnapshot {
  return snapshot?.category === "owner_decision" && snapshot.kind === "question";
}

/** A stored question card: a root's Owner Question or an explicit child clarification (#4359).
 * Keep the public helper names for existing clients; only presentation and form helpers accept
 * children. isOwnerQuestionSnapshot stays root-only for ownership and lifecycle rules. */
export function ownerQuestionOfRequest(request: Pick<PendingApproval, "kind" | "workflowDecision"> | null | undefined): WorkflowQuestionSnapshot | null {
  if (request?.kind !== "workflow_decision") return null;
  const snapshot = request.workflowDecision?.resourceSnapshot;
  return isWorkflowQuestionSnapshot(snapshot) ? snapshot : null;
}

/** Whether a pending card is answered as a question: a child clarification, an owner question, or the owner's one
 * approval of an Orchestrator's scope proposal (#4282), which is presented the same way. */
export function isOwnerQuestionRequest(request: Pick<PendingApproval, "kind" | "workflowDecision"> | null | undefined): boolean {
  return ownerQuestionOfRequest(request) !== null || scopeProposalOfRequest(request) !== null;
}

/** An Owner Question in either form: the card the control plane stores, or the question card
 * `presentOwnerQuestionRequest` makes of it, which keeps its workflow decision. The session detail
 * shows the presented card, and its badge must still read as the owner's question. */
export function isOwnerQuestionCard(request: Pick<PendingApproval, "kind" | "workflowDecision"> | null | undefined): boolean {
  return isOwnerQuestionRequest(request) ||
    (request?.kind === "question" && isWorkflowQuestionSnapshot(request.workflowDecision?.resourceSnapshot));
}

function optionLabel(snapshot: WorkflowQuestionSnapshot, option: WorkflowQuestionSnapshot["options"][number]): string {
  return option.optionId === snapshot.recommendedOptionId ? `${option.label}${OWNER_QUESTION_RECOMMENDED_SUFFIX}` : option.label;
}

/**
 * The owner question as a normal agent question form: the question with its background as Markdown
 * context and the suggested options (the recommended one marked), answered by choosing one or by
 * typing an answer; then, when there are options, an optional note to go with the choice.
 */
export function ownerQuestionAgentQuestions(snapshot: WorkflowQuestionSnapshot): AgentQuestion[] {
  const answer: AgentQuestion = {
    id: OWNER_QUESTION_ANSWER_ID,
    header: isChildQuestionSnapshot(snapshot) ? "Question" : "Owner Question",
    question: snapshot.question,
    ...("material" in snapshot && snapshot.material ? { context: snapshot.material } : {}),
    options: snapshot.options.map((option) => ({ label: optionLabel(snapshot, option),
      ...(option.description ? { description: option.description } : {}) })),
    allowOther: true,
    maxLength: OWNER_QUESTION_ANSWER_MAX_LENGTH,
  };
  if (snapshot.options.length === 0) return [answer];
  return [answer, {
    id: OWNER_QUESTION_NOTE_ID,
    header: "Note",
    question: isChildQuestionSnapshot(snapshot) ? "Anything to add for the session?" : "Anything to add for the Orchestrator?",
    options: [],
    allowOther: true,
    required: false,
    maxLength: OWNER_QUESTION_ANSWER_MAX_LENGTH,
  }];
}

/** What the owner answered: the option they chose, their own words, or both. */
export interface OwnerQuestionAnswer {
  selectedOptionId?: string;
  /** The owner's own words, exactly as typed: their answer, then their note, a blank line apart. */
  text?: string;
}

/**
 * Read a submitted answer map against the question form. The caller has already validated it with
 * `validateQuestionAnswers` against `ownerQuestionAgentQuestions`. Null when nothing was answered.
 */
export function ownerQuestionAnswer(snapshot: WorkflowQuestionSnapshot, answers: Record<string, string | string[]>): OwnerQuestionAnswer | null {
  const answer = Object.hasOwn(answers, OWNER_QUESTION_ANSWER_ID) ? answers[OWNER_QUESTION_ANSWER_ID] : undefined;
  const note = Object.hasOwn(answers, OWNER_QUESTION_NOTE_ID) ? answers[OWNER_QUESTION_NOTE_ID] : undefined;
  if (Array.isArray(answer) || Array.isArray(note)) return null;
  const chosen = typeof answer === "string"
    ? snapshot.options.find((option) => optionLabel(snapshot, option) === answer) : undefined;
  const words = [chosen ? undefined : answer, note]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const text = words.length ? words.join("\n\n") : undefined;
  if (!chosen && !text) return null;
  return { ...(chosen ? { selectedOptionId: chosen.optionId } : {}), ...(text ? { text } : {}) };
}

/**
 * A pending card as clients present it: an owner question becomes a question card (`kind:
 * "question"`, its form, and `async`, since the root keeps working), keeping its occurrence and
 * workflow decision. Everything else is returned unchanged. Answers go to the session's question
 * route, which the control plane resolves as the owner's answer.
 */
export function presentOwnerQuestionRequest(request: PendingApproval): PendingApproval {
  if (scopeProposalOfRequest(request)) return presentScopeProposalRequest(request);
  const snapshot = ownerQuestionOfRequest(request);
  // A question the Decision Model could not screen is classified on its own card first (#4104).
  if (!snapshot || request.workflowDecision?.authorityEvaluation?.reason === "credential_screen_review") return request;
  return { ...request, kind: "question", title: isChildQuestionSnapshot(snapshot) ? "Question" : "Owner Question",
    ...(isOwnerQuestionSnapshot(snapshot) ? { async: true } : {}), questions: ownerQuestionAgentQuestions(snapshot) };
}
