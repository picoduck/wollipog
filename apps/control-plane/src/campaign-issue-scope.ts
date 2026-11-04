import { boundedIssueNumbers, campaignIssueLimitsRequirement, campaignIssueScopeChangesRequirement, campaignRepositoryLocation,
  gitlabCampaignIssuesRequirement, normalizeCampaignIssueScopeSnapshot, RUNNER_CAPABILITY_MIN_PROTOCOL, runnerSupportsProtocol, type RunnerCapabilityRequirementDetails,
  type CampaignIssueScopeRequest, type CampaignIssueScopeSnapshot, type CampaignIssueScopeView, type SessionView, type WorkflowDecisionView, isTerminal } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { issueClosureActiveChildren } from "./github-issue-closure.js";
import { initialCampaignEpic } from "./campaign-issue-scope-seed.js";

export function scopeParticipants(db: ControlPlaneDb, root: SessionView): SessionView[] {
  return [root, ...db.campaignDescendantIds(root.id).flatMap((id) => { const s = db.getSession(id); return s?.orchestratorPolicy && !s.archived && !isTerminal(s.status) ? [s] : []; })];
}

/** GitLab issue closure and scope (#3539) need every participating Orchestrator runner at v249: an
 * older runner reads only GitHub issues. Null for a GitHub (or not yet known) repository. */
export function gitlabIssueCompatibility(db: ControlPlaneDb, root: SessionView, repository: string | undefined): ({ error: string } & RunnerCapabilityRequirementDetails) | null {
  if (campaignRepositoryLocation(repository)?.forge !== "gitlab") return null;
  const outdated = scopeParticipants(db, root).find((s) => !runnerSupportsProtocol(db.getRunner(s.runnerId)?.protocolVersion, "gitlabCampaignIssues"));
  return outdated ? gitlabCampaignIssuesRequirement(db.getRunner(outdated.runnerId)?.protocolVersion) : null;
}

/** The runner floor that blocks issue scope work, as the shared sentence plus the versions of the
 * first participant below it, or null when every participating Orchestrator runner is current.
 * `repository` defaults to the stored scope's; a GitLab one also needs `gitlabCampaignIssues`. */
export function scopeCompatibility(db: ControlPlaneDb, root: SessionView,
  repository: string | undefined = root.orchestratorPolicy?.issueScope?.repository): ({ error: string } & RunnerCapabilityRequirementDetails) | null {
  const participants = scopeParticipants(db, root);
  if (root.orchestratorPolicy?.control?.mode === "full_control" && root.orchestratorPolicy.control.boundary.issueAuthority) {
    const outdated = participants.find((s) =>
      (db.getRunner(s.runnerId)?.protocolVersion ?? 0) < RUNNER_CAPABILITY_MIN_PROTOCOL.fullControlIssueAuthority);
    if (outdated) return campaignIssueLimitsRequirement(db.getRunner(outdated.runnerId)?.protocolVersion);
  }
  const outdated = participants.find((s) => !runnerSupportsProtocol(db.getRunner(s.runnerId)?.protocolVersion, "campaignIssueScopeChanges"));
  return outdated ? campaignIssueScopeChangesRequirement(db.getRunner(outdated.runnerId)?.protocolVersion)
    : gitlabIssueCompatibility(db, root, repository);
}

/** A view's compatibility notice: the sentence, with the versions beside it rather than inside it. */
export function compatibilityFields({ error, ...versions }: { error: string } & RunnerCapabilityRequirementDetails) {
  return { compatibilityMessage: error, ...versions };
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
  const requirement = scopeCompatibility(db, root);
  // A first message's context-only references (#3920), less any the scope now holds.
  const first = root.orchestratorPolicy?.firstMessageScope;
  const context = first && first.state !== "pending" ? (first.contextIssueNumbers ?? []).filter((n) => !numbers.includes(n)) : [];
  return { campaignSessionId: root.id, repository, issueNumbers: numbers, revision: root.orchestratorPolicy?.issueScope?.revision ?? 0,
    ...(root.orchestratorPolicy?.issueScope ? { authorization: root.orchestratorPolicy.issueScope } : {}),
    supported: !requirement, ...(requirement ? compatibilityFields(requirement) : {}), canPropose: false,
    ...(context.length ? { contextIssueNumbers: context } : {}), outsideScope };
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
  const changed = [...additions, ...removals];
  const unrelated = db.campaignWorkLedger.sessionsUnrelatedToIssues(root.id, repository, changed);
  const affectedDecisions = db.unconsumedWorkflowDecisionsForController(root.id)
    .filter((d) => d.category !== "campaign_issue_scope" && scopeChangeAffectsDecision(db, root.id, repository, changed, removals.length > 0, unrelated, d))
    .map((d) => d.occurrenceId).sort();
  return normalizeCampaignIssueScopeSnapshot({ category: "campaign_issue_scope", repository, expectedRevision: request.expectedRevision,
    before, additions, removals, explanation: request.explanation, affectedAssignments, affectedDecisions,
    activeChildren: issueClosureActiveChildren(db, root.id, { repository, numbers: changed }),
    ...(request.lineage === undefined ? {} : { lineage: request.lineage }) });
}

/** Every outstanding decision the root controls, other than scope requests. A person deciding a
 * Full Control scope change re-authorizes the boundary all of them were evaluated under, so that
 * request lists, and its approval revokes, every one (#3915). */
export function everyOutstandingScopeDecision(db: ControlPlaneDb, rootId: string): string[] {
  return db.unconsumedWorkflowDecisionsForController(rootId).filter((d) => d.category !== "campaign_issue_scope").map((d) => d.occurrenceId).sort();
}

/** Whether a scope change that adds or removes `changed` invalidates an outstanding decision (#3915).
 * A closure depends on its own issue only: one for an issue the change touches, or in another
 * repository, is invalidated. A follow-up publication or admission counts against the campaign's
 * issue capacity, which every scope change moves, so it is always invalidated. Any other decision
 * is left alone only when its requester is a child the work ledger proves unrelated to every
 * changed issue, by the rule issue closures use (#3914); the root's own decisions and every child
 * without that proof are invalidated. An armed merge survives a change that only adds issues,
 * whoever requested it: its enqueue already ran, so revoking it withdraws nothing and only stops
 * the forge-proven merge being recorded. Anything kept is still re-evaluated against the new scope
 * when it is resolved or consumed. */
function scopeChangeAffectsDecision(db: ControlPlaneDb, rootId: string, repository: string, changed: readonly number[],
  removes: boolean, unrelated: ReadonlySet<string>, decision: WorkflowDecisionView): boolean {
  const snapshot = decision.resourceSnapshot;
  if (snapshot.category === "issue_closure") return snapshot.repository.toLowerCase() !== repository.toLowerCase() || changed.includes(snapshot.issue);
  if (snapshot.category === "follow_up_issue_publication" || snapshot.category === "campaign_follow_up_admission") return true;
  if (!removes && decision.status === "approved" && snapshot.category === "pr_merge" && decision.actionAdmission?.kind === "pr_merge_enqueue") return false;
  return decision.sessionId === rootId || db.initialUserMessageText(decision.sessionId) === null || !unrelated.has(decision.sessionId);
}

export function campaignNeedsEpicScope(db: ControlPlaneDb, root: SessionView): boolean {
  return !root.orchestratorPolicy?.issueScope && (root.orchestratorPolicy?.issueScopeProposalEpic !== undefined || initialCampaignEpic(db.initialUserMessageText(root.id) ?? "") !== null);
}
