import type { PendingApproval } from "@wollipog/protocol";

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
