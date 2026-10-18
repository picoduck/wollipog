import { sessionCampaignRequests } from "@wollipog/protocol";
import { attentionRequestRank, pendingRequests, type SessionView } from "@wollipog/protocol";

export type SessionFollowUpGroup = "needs_input" | "ready_for_review" | "working" | "quiet";

type CampaignFacts = Partial<Pick<SessionView, "parentSessionId" | "orchestratorCampaign" | "orchestratorPolicy">>;

/** A Full Control root whose campaign the server reports Verified Complete (#2940): its normal
 * completion is informational, never review work. Only the server's projection decides this; any
 * other campaign state, a Custom campaign or a descendant keeps its ordinary follow-up. */
export function completedFullControlCampaign(session: CampaignFacts): boolean {
  const campaign = session.orchestratorCampaign;
  if (session.parentSessionId || campaign?.status !== "verified_complete") return false;
  return (campaign.control ?? session.orchestratorPolicy?.control)?.mode === "full_control";
}

export function outstandingSessionResult(session: Pick<SessionView, "attention"> & CampaignFacts) {
  const facts = session.attention;
  return facts?.result?.owner === "human" && facts.result.revision !== facts.acknowledgedRevision &&
    !completedFullControlCampaign(session)
    ? facts.result : null;
}

/** Foreground work, a pending stop, or background work still returning to the conversation. */
export function sessionWorking(session: Pick<SessionView, "status" | "stopOperation" | "backgroundWorkState">) {
  return ["running", "starting", "queued"].includes(session.status) || session.stopOperation?.status === "stop_pending" ||
    session.backgroundWorkState === "running" || session.backgroundWorkState === "continuation_pending";
}

/** Ancestors whose work is unfinished, even when intermediate turns or sibling results are at rest.
 * Stop on cycles and already marked paths. */
export function sessionsWithWorkingDescendants(sessions: readonly SessionView[]): ReadonlySet<string> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const active = new Set<string>();
  for (const session of sessions) {
    if (!sessionWorking(session) && session.status !== "input_required") continue;
    let parentId = session.parentSessionId;
    const seen = new Set([session.id]);
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      if (active.has(parentId)) break;
      seen.add(parentId);
      active.add(parentId);
      parentId = byId.get(parentId)!.parentSessionId;
    }
  }
  return active;
}

export function sessionFollowUp(session: SessionView, { familyWorking = false }: { familyWorking?: boolean } = {}) {
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
  const result = sessionWorking(session) || familyWorking ? null : outstandingSessionResult(session);
  const group: SessionFollowUpGroup = firstAction || recovery || (sessionCampaignRequests(session)?.human ?? 0) > 0 ||
    (!session.attention && !session.pendingRequestOwners && session.status === "input_required")
    ? "needs_input" : result ? "ready_for_review" :
      sessionWorking(session) || familyWorking || session.status === "input_required" ? "working" : "quiet";
  return { group, priority: { needs_input: 3, ready_for_review: 2, working: 1, quiet: 0 }[group],
    requestRank: firstAction?.rank ?? (recovery ? 0 : 6),
    at: firstAction?.requestedAt ?? result?.at ?? session.attention?.meaningfulAt ?? session.createdAt ?? 0,
    label: { needs_input: "Needs Your Input", ready_for_review: "Ready for Review", working: "Working", quiet: "Quiet" }[group] };
}
