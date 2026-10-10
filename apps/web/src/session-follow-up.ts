import { attentionRequestRank, pendingRequests, type SessionView } from "@wollipog/protocol";

export type SessionFollowUpGroup = "needs_input" | "ready_for_review" | "working" | "quiet";

export function outstandingSessionResult(session: Pick<SessionView, "attention">) {
  const facts = session.attention;
  return facts?.result?.owner === "human" && facts.result.revision !== facts.acknowledgedRevision
    ? facts.result : null;
}

export function sessionFollowUp(session: SessionView) {
  const humanActions = session.attention?.humanActions ?? pendingRequests(session.pendingApproval)
    .filter((request) => {
      const owners = session.pendingRequestOwners;
      const exact = owners?.requests?.find((owner) => owner.requestId === request.requestId);
      return exact ? exact.owner !== "orchestrator" : owners?.human !== 0;
    }).map((request) => ({ requestId: request.requestId, rank: attentionRequestRank(request),
      requestedAt: request.requestedAt ?? session.createdAt }));
  const firstAction = [...humanActions].sort((a, b) => a.rank - b.rank || a.requestedAt - b.requestedAt)[0];
  // A concrete recovery affordance is actionable. Failure/idle/Review placement alone is not.
  const recovery = !session.attention && (session.historyQuarantine || session.worktreeRecovery || session.stopOperation?.status === "stop_failed" ||
    session.backgroundDeliveries?.some((delivery) =>
      delivery.watchdogState === "continuation_blocked" || delivery.watchdogState === "accepted_without_result"));
  const result = outstandingSessionResult(session);
  const group: SessionFollowUpGroup = firstAction || recovery || (session.orchestratorCampaign?.pendingRequests?.human ?? 0) > 0 ||
    (!session.attention && !session.pendingRequestOwners && session.status === "input_required")
    ? "needs_input" : result ? "ready_for_review" :
      ["running", "starting", "queued", "input_required"].includes(session.status) ? "working" : "quiet";
  return { group, priority: { needs_input: 3, ready_for_review: 2, working: 1, quiet: 0 }[group],
    requestRank: firstAction?.rank ?? (recovery ? 0 : 6),
    at: firstAction?.requestedAt ?? result?.at ?? session.attention?.meaningfulAt ?? session.createdAt ?? 0,
    label: { needs_input: "Needs Your Input", ready_for_review: "Result Available", working: "Working", quiet: "Quiet" }[group] };
}
