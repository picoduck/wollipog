import assert from "node:assert/strict";
import test from "node:test";
import { OWNER_QUESTION_ANSWER_ID, OWNER_QUESTION_NOTE_ID, pendingRequests, type OwnerDecisionSnapshot, type PendingApproval,
  type WorkflowDecisionView } from "@wollipog/protocol";
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

test("an Owner Question is listed as a question and never takes a one-key choice (#4270)", () => {
  const question = ownerCard("question", { ...QUESTION, options: [{ optionId: "lease", label: "Short-Lived Lease" }] });
  assert.equal(requestKindMeta(question).label, "Question");
  assert.equal(approvalOptionForIntent(question, "approve"), null);
  assert.equal(requestKindMeta(ownerCard("approval", APPROVAL)).label, "Workflow Decision");
});
