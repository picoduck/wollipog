import assert from "node:assert/strict";
import test from "node:test";
import { OWNER_QUESTION_ANSWER_ID, OWNER_QUESTION_NOTE_ID, pendingRequests, sessionAttentionStatus, type OwnerDecisionSnapshot, type PendingApproval,
  type SessionView, type WorkflowDecisionView } from "@wollipog/protocol";
import { withPresentedOwnerQuestions } from "./owner-question-presentation.js";
import { requestKindMeta } from "./components/requests/request-meta.js";
import { approvalOptionForIntent } from "./inbox.js";

function ownerCard(occurrenceId: string, snapshot: WorkflowDecisionView["resourceSnapshot"], reason = "owner_kept"): PendingApproval {
  return {
    requestId: occurrenceId, occurrenceId, title: "Owner Question", kind: "workflow_decision", async: true,
    options: [{ optionId: "lease", name: "Short-Lived Lease", kind: "allow_once" }, { optionId: "__workflow_deny__", name: "Dismiss Question", kind: "reject_once" }],
    workflowDecision: { occurrenceId, sessionId: "root", controllingSessionId: "root", requestId: occurrenceId, resourceKey: occurrenceId,
      category: "owner_decision", status: "pending", authority: "human", policyRevision: 1, resourceDigest: "d", createdAt: 1,
      authorityEvaluation: { owner: "human", reason }, resourceSnapshot: snapshot } as unknown as WorkflowDecisionView,
  };
}

const QUESTION: OwnerDecisionSnapshot = { category: "owner_decision", kind: "question", question: "Which credential design should the bridge use?",
  material: "See [the note](https://example.com/note).", recommendedOptionId: "lease",
  options: [{ optionId: "lease", label: "Short-Lived Lease" }, { optionId: "broker", label: "Broker Process" }] };
const APPROVAL: OwnerDecisionSnapshot = { category: "owner_decision", question: "May the campaign merge #7?",
  options: [{ optionId: "merge", label: "Merge" }, { optionId: "hold", label: "Hold" }] };
const BLOCKING: PendingApproval = { requestId: "perm", occurrenceId: "perm", title: "Run Command", kind: "permission",
  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] };

test("child questions share question presentation, attention and Inbox metadata without becoming async (#4359)", () => {
  const card = ownerCard("child-q", { category: "implementation_question", kind: "question", question: "Which approach?",
    options: [{ optionId: "a", label: "Approach A" }] });
  delete card.async;
  const shown = withPresentedOwnerQuestions({ status: "running" as const, pendingApproval: card });
  assert.equal(shown.pendingApproval.kind, "question");
  assert.equal(shown.pendingApproval.async, undefined);
  assert.equal(shown.pendingApproval.questions![0]!.allowOther, true);
  assert.equal(sessionAttentionStatus(shown)?.label, "Needs Your Input");
  assert.equal(sessionAttentionStatus(shown)?.description, "This session asked you a question. Answer it to continue.");
  assert.equal(requestKindMeta(card).label, "Question", "Inbox and request lists identify the stored card as a question");
  assert.equal(approvalOptionForIntent(card, "approve"), null, "question choices cannot be approved by a one-key shortcut");
  const legacy = ownerCard("legacy", { category: "implementation_question", question: "May I proceed?",
    options: [{ optionId: "yes", label: "Proceed" }, { optionId: "no", label: "Stop" }] });
  assert.equal(withPresentedOwnerQuestions({ pendingApproval: legacy }).pendingApproval.kind, "workflow_decision");
  const delegated = { ...card, workflowDecision: { ...card.workflowDecision!, authority: "orchestrator" as const } };
  const readOnly = withPresentedOwnerQuestions({ pendingApproval: delegated });
  assert.equal(readOnly.pendingApproval.kind, "workflow_decision", "a human never enters Composer Answer Mode for a delegated child question");
  assert.equal(requestKindMeta(readOnly.pendingApproval).label, "Question", "read-only questions still identify themselves as questions");
});

test("an Owner Question is presented as a question card the composer answers (#4270)", () => {
  const approval = ownerCard("approval", APPROVAL);
  const question = ownerCard("question", QUESTION);
  const session = { pendingApproval: { ...approval, additionalRequests: [question] } };
  const presented = withPresentedOwnerQuestions(session);
  const [first, second] = pendingRequests(presented.pendingApproval);
  assert.equal(first!.requestId, "question", "the question goes ahead of other non-blocking cards");
  assert.equal(first!.kind, "question");
  assert.equal(first!.occurrenceId, "question");
  assert.equal(first!.async, true);
  assert.deepEqual(first!.questions!.map((item) => item.id), [OWNER_QUESTION_ANSWER_ID, OWNER_QUESTION_NOTE_ID]);
  assert.equal(first!.questions![0]!.context, QUESTION.material);
  assert.deepEqual(first!.questions![0]!.options.map((option) => option.label), ["Short-Lived Lease (Recommended)", "Broker Process"]);
  assert.equal(second!.kind, "workflow_decision", "an Owner Approval keeps its card");
  // Never ahead of a request that holds the session.
  const held = withPresentedOwnerQuestions({ pendingApproval: { ...BLOCKING, additionalRequests: [question] } });
  assert.deepEqual(pendingRequests(held.pendingApproval).map((request) => [request.requestId, request.kind]),
    [["perm", "permission"], ["question", "question"]]);
  // A session without one is unchanged, and a question awaiting classification keeps its card (#4104).
  const plain = { pendingApproval: approval };
  assert.equal(withPresentedOwnerQuestions(plain), plain);
  const screening = ownerCard("screening", QUESTION, "credential_screen_review");
  assert.equal(pendingRequests(withPresentedOwnerQuestions({ pendingApproval: screening }).pendingApproval)[0]!.kind, "workflow_decision");
});

test("the session detail's presented Owner Question still reads Needs Your Input; approvals and agent questions keep their labels (#4270)", () => {
  const label = (session: Pick<SessionView, "status" | "pendingApproval">) => sessionAttentionStatus(session)?.label;
  const stored = { status: "running" as const, pendingApproval: ownerCard("question", QUESTION) };
  assert.equal(label(stored), "Needs Your Input", "the stored card, as lists show it");
  const presented = withPresentedOwnerQuestions(stored);
  assert.equal(pendingRequests(presented.pendingApproval)[0]!.kind, "question");
  assert.equal(label(presented), "Needs Your Input", "the presented card, as the session detail header shows it");
  assert.equal(label(withPresentedOwnerQuestions({ status: "running", pendingApproval: ownerCard("open", { ...QUESTION, options: [] }) })),
    "Needs Your Input", "a question with no suggested options too");
  // An Owner Approval, before and after presentation, still asks for an approval.
  const approval = { status: "running" as const, pendingApproval: ownerCard("approval", APPROVAL) };
  assert.equal(label(approval), "Approval Required");
  assert.equal(label(withPresentedOwnerQuestions(approval)), "Approval Required");
  // A child's pr_merge handed to the owner is an Owner Approval bound to its exact head.
  const merge: PendingApproval = { requestId: "merge", occurrenceId: "merge", title: "Merge Pull Request", kind: "workflow_decision", async: true,
    options: [{ optionId: "approve", name: "Approve", kind: "allow_once" }, { optionId: "deny", name: "Do Not Proceed", kind: "reject_once" }],
    workflowDecision: { occurrenceId: "merge", sessionId: "child", controllingSessionId: "root", requestId: "merge", resourceKey: "team/repo#7",
      category: "pr_merge", status: "pending", authority: "human", policyRevision: 1, resourceDigest: "d", createdAt: 1,
      ownerHandoff: { bySessionId: "root", at: 1, reason: "The owner keeps this merge." }, resourceSnapshot: { category: "pr_merge", repository: "team/repo", pullRequest: 7, headSha: "a".repeat(40),
        reviewResult: "merge", requiredChecks: { headSha: "a".repeat(40), status: "passed", checkedAt: 1, checks: [{ name: "CI", state: "passed" }] } } } as unknown as WorkflowDecisionView };
  assert.equal(label(withPresentedOwnerQuestions({ status: "running", pendingApproval: merge })), "Approval Required");
  // An ordinary agent question keeps its own label, even beside an Owner Question's snapshot shape.
  const agentQuestion: PendingApproval = { requestId: "ask", occurrenceId: "ask", title: "Question", kind: "question", options: [],
    questions: [{ id: "q", header: "Question", question: "Which?", options: [{ label: "A" }, { label: "B" }] }] };
  assert.equal(label({ status: "input_required", pendingApproval: agentQuestion }), "Answer Required");
  assert.equal(label({ status: "input_required", pendingApproval: { ...agentQuestion, workflowDecision: ownerCard("approval", APPROVAL).workflowDecision } }),
    "Answer Required", "a question card carrying an Owner Approval's decision is not an Owner Question");
});

test("an Owner Question is listed as a question and never takes a one-key choice (#4270)", () => {
  const question = ownerCard("question", { ...QUESTION, options: [{ optionId: "lease", label: "Short-Lived Lease" }] });
  assert.equal(requestKindMeta(question).label, "Question");
  assert.equal(approvalOptionForIntent(question, "approve"), null);
  assert.equal(requestKindMeta(ownerCard("approval", APPROVAL)).label, "Workflow Decision");
});
