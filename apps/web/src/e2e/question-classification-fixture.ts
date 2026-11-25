import { CAMPAIGN_HANDOFF_QUESTION_KEY, type PendingApproval } from "@wollipog/protocol";

export const heldQuestion = (): PendingApproval => ({
  requestId: "question-configuration", occurrenceId: "question-configuration", kind: "workflow_decision", title: "Question",
  options: [{ optionId: "shared", name: "Shared Configuration", kind: "allow_once" },
    { optionId: "local", name: "Session Configuration", kind: "allow_once" },
    { optionId: "__workflow_deny__", name: "Dismiss Question", kind: "reject_once" }],
  workflowDecision: {
    requestId: "question-configuration", occurrenceId: "question-configuration", sessionId: "session-alpha", controllingSessionId: "session-alpha",
    category: "implementation_question", resourceKey: "configuration", resourceDigest: "a".repeat(64), policyRevision: 1,
    resourceSnapshot: { category: "implementation_question", kind: "question",
      question: "Where should provider account configuration persist in picoduck/wollipog?",
      options: [{ optionId: "shared", label: "Shared Configuration" }, { optionId: "local", label: "Session Configuration" }] },
    authority: "human", status: "pending", createdAt: Date.now() - 120_000,
    authorityEvaluation: { owner: "human", basis: "human_required", operation: "implementation_question", reason: "credential_screen_review",
      credentialScreen: { occurrenceId: "screen-configuration", state: "review" } },
  },
});

export function heldHandoff(itemCount = 1): PendingApproval {
  const request = heldQuestion();
  const decision = request.workflowDecision!;
  request.title = "Owner Question";
  request.options = [];
  decision.category = "owner_decision";
  decision.resourceKey = CAMPAIGN_HANDOFF_QUESTION_KEY;
  const items = Array.from({ length: itemCount }, (_, index) => {
    const title = itemCount === 1 ? "Review Documentation" : `Review Documentation Section ${index + 1}`;
    return `- ${title} (human)\n  Reason: The rollout notes need your input.\n  Next action: Choose which example should lead.`;
  });
  decision.resourceSnapshot = { category: "owner_decision", kind: "question",
    question: "This campaign handed work to you. What should happen next?", options: [],
    material: `${items.join("\n\n")}\n\nThis question authorizes nothing. Your answer grants no action authority.` };
  decision.authorityEvaluation = { ...decision.authorityEvaluation!, operation: "owner_decision",
    credentialScreen: { occurrenceId: "screen-configuration", state: "review", failureClass: "harness_unavailable" } };
  return request;
}
