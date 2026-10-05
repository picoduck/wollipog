import { boundedIssueNumbers, normalizeCampaignIssueScopeSnapshot, runnerSupportsProtocol,
  type CampaignIssueScopeRequest, type CampaignIssueScopeSnapshot, type CampaignIssueScopeView, type SessionView, isTerminal } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { issueClosureActiveChildren } from "./github-issue-closure.js";
import { initialCampaignEpic } from "./campaign-issue-scope-seed.js";

export function scopeParticipants(db: ControlPlaneDb, root: SessionView): SessionView[] {
  return [root, ...db.campaignDescendantIds(root.id).flatMap((id) => { const s = db.getSession(id); return s?.orchestratorPolicy && !s.archived && !isTerminal(s.status) ? [s] : []; })];
}

export function scopeCompatibility(db: ControlPlaneDb, root: SessionView): string | null {
  return scopeParticipants(db, root).every((s) => runnerSupportsProtocol(db.getRunner(s.runnerId)?.protocolVersion, "campaignIssueScopeChanges"))
    ? null : "Campaign issue scope changes require protocol-v208 on every participating Orchestrator runner. Update the runners and reconnect before retrying.";
}

export function scopeView(db: ControlPlaneDb, root: SessionView, repository: string): CampaignIssueScopeView {
  const numbers = root.orchestratorPolicy?.issueNumbers ?? [];
  const outsideScope: CampaignIssueScopeView["outsideScope"] = [];
  let cursor: string | undefined;
  do {
    const result = db.campaignWorkLedger.page(root.id, { limit: 100, ...(cursor ? { cursor } : {}) }, Date.now());
    if (!result.ok) throw new Error(result.error);
    for (const item of result.data.items) {
      if (item.issue && (item.issue.repository.toLowerCase() !== repository.toLowerCase() || !numbers.includes(item.issue.number))) {
        outsideScope.push({ workItemId: item.id, title: item.title ?? item.key, issue: item.issue, sessionId: item.currentAttempt?.sessionId ?? null });
      }
    }
    cursor = result.data.nextCursor ?? undefined;
  } while (cursor);
  const compatibilityMessage = scopeCompatibility(db, root);
  return { campaignSessionId: root.id, repository, issueNumbers: numbers, revision: root.orchestratorPolicy?.issueScope?.revision ?? 0,
    ...(root.orchestratorPolicy?.issueScope ? { authorization: root.orchestratorPolicy.issueScope } : {}),
    supported: !compatibilityMessage, ...(compatibilityMessage ? { compatibilityMessage } : {}), canPropose: false, outsideScope };
}

export function scopeSnapshot(db: ControlPlaneDb, root: SessionView, repository: string, request: CampaignIssueScopeRequest): CampaignIssueScopeSnapshot | null {
  if (!request || typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 256 ||
      !Array.isArray(request.additions) || !Array.isArray(request.removals) ||
      [...request.additions, ...request.removals].some((r) => !r || typeof r.repository !== "string" || r.repository.toLowerCase() !== repository.toLowerCase())) return null;
  const additions = request.additions.map((r) => r.number);
  const removals = request.removals.map((r) => r.number);
  if (!boundedIssueNumbers(additions) || !boundedIssueNumbers(removals)) return null;
  const before = root.orchestratorPolicy?.issueNumbers ?? [];
  const affectedAssignments: CampaignIssueScopeSnapshot["affectedAssignments"] = [];
  // An identically numbered issue in another repository has separate authority.
  let cursor: string | undefined;
  do {
    const page = db.campaignWorkLedger.page(root.id, { limit: 100, ...(cursor ? { cursor } : {}) }, Date.now());
    if (!page.ok) return null;
    for (const i of page.data.items) if (i.issue && i.issue.repository.toLowerCase() === repository.toLowerCase() && removals.includes(i.issue.number) && i.currentAttempt?.sessionId &&
        !affectedAssignments.some((a) => a.sessionId === i.currentAttempt!.sessionId && a.issue === i.issue!.number)) {
      affectedAssignments.push({ sessionId: i.currentAttempt.sessionId, issue: i.issue.number });
    }
    cursor = page.data.nextCursor ?? undefined;
  } while (cursor);
  // All outstanding action decisions are invalidated conservatively; their authority was evaluated under the old scope.
  const affectedDecisions = db.unconsumedWorkflowDecisionsForController(root.id)
    .filter((d) => d.category !== "campaign_issue_scope").map((d) => d.occurrenceId).sort();
  return normalizeCampaignIssueScopeSnapshot({ category: "campaign_issue_scope", repository, expectedRevision: request.expectedRevision,
    before, additions, removals, explanation: request.explanation, affectedAssignments, affectedDecisions, activeChildren:issueClosureActiveChildren(db,root.id) });
}

export function campaignNeedsEpicScope(db: ControlPlaneDb, root: SessionView): boolean {
  return !root.orchestratorPolicy?.issueScope && (root.orchestratorPolicy?.issueScopeProposalEpic !== undefined || initialCampaignEpic(db.initialUserMessageText(root.id) ?? "") !== null);
}
