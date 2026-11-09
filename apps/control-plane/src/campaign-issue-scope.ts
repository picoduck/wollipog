import { boundedIssueNumbers, campaignIssueLimitsRequirement, campaignIssueScopeChangesRequirement, campaignRepositoryLocation,
  campaignScopeChangeGroups, campaignScopeForRepository, campaignScopeIssues, canonicalCampaignIssues,
  gitlabCampaignIssuesRequirement, normalizeCampaignIssueScopeSnapshot, RUNNER_CAPABILITY_MIN_PROTOCOL, runnerCapabilityRequirementError, runnerSupportsProtocol,
  type CampaignIssueRef, type CampaignIssueScope, type CampaignIssueScopeRepositoryView, type RunnerCapabilityRequirementDetails,
  type CampaignIssueScopeRequest, type CampaignIssueScopeSnapshot, type CampaignIssueScopeView, type CampaignScopeProposalView, type SessionView,
  type WorkflowDecisionView, isTerminal } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { issueClosureActiveChildren } from "./github-issue-closure.js";
import { campaignSeedHoldsDelegation } from "./campaign-issue-scope-seed.js";
import { campaignLaunchRepository, campaignScopeRepositories } from "./campaign-authority.js";
import { scopeCheckView } from "./scope-check.js";

export function scopeParticipants(db: ControlPlaneDb, root: SessionView): SessionView[] {
  return [root, ...db.campaignDescendantIds(root.id).flatMap((id) => { const s = db.getSession(id); return s?.orchestratorPolicy && !s.archived && !isTerminal(s.status) ? [s] : []; })];
}

/** Why an Orchestrator participant cannot hold the campaign's scope (#4118), or null. It must be in
 * a Location of a boundary repository; outside the launch repository its runner needs v313. */
export function participantScopeRefusal(db: ControlPlaneDb, root: SessionView, member: Pick<SessionView, "id" | "runnerId" | "workspaceId">):
  { error: string; status: number; capability?: RunnerCapabilityRequirementDetails } | null {
  // The root's own workspace always qualifies, even before the campaign records its repository.
  if (db.campaignSharesRepositoryWorkspace(root, member)) return null;
  const repository = db.campaignParticipantRepository(root, member);
  if (!repository) return { status: 409, error: "Every active Orchestrator participant must run in a Location of one of the campaign's repositories. " +
    "Move or finish the other participants, or start an independent campaign, then retry." };
  if (repository === campaignLaunchRepository(root)) return null;
  const version = db.getRunner(member.runnerId)?.protocolVersion;
  if (runnerSupportsProtocol(version, "repositoryQualifiedIssueScope")) return null;
  const { error, ...capability } = runnerCapabilityRequirementError(version, "repositoryQualifiedIssueScope", "issue scope in another campaign repository");
  return { status: 409, error, capability };
}

/** The part of the root's scope a participant's runner stores (#4118): its own repository's
 * numbers, in the earlier one-repository shape. A participant in no boundary repository gets the
 * launch repository with no numbers, which authorizes nothing. */
export function participantScope(db: ControlPlaneDb, root: SessionView, member: Pick<SessionView, "id" | "runnerId" | "workspaceId">): CampaignIssueScope | null {
  const scope = root.orchestratorPolicy?.issueScope;
  if (!scope) return null;
  const repository = db.campaignParticipantRepository(root, member);
  return repository ? campaignScopeForRepository(scope, repository) : { ...campaignScopeForRepository(scope, scope.repository), issueNumbers: [] };
}

/** The fixed refusal for a scope change naming a repository outside the boundary (#4118). It is
 * decided from the stored boundary alone, before any runner call. */
export function repositoryOutsideBoundary(repository: string): { status: 409; error: string; errorDetails: { code: "repository_outside_boundary"; repository: string } } {
  return { status: 409, errorDetails: { code: "repository_outside_boundary", repository },
    error: `${repository} is not one of this campaign's repositories, so its issues can't join the scope. If the campaign's Project ` +
      "has a Location of that repository, ask the campaign's owner to add it with request_campaign_repository_addition, then retry " +
      "this scope change once the addition is carried out. Otherwise report that the work needs a repository with no Location in this Project." };
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

/** The campaign's repository-qualified issues, as a view of `repository` reads them. A scope saved
 * before #4118 (or a legacy campaign's bare numbers) reads as numbers in that repository. */
function viewIssues(root: SessionView, repository: string): CampaignIssueRef[] {
  const scope = root.orchestratorPolicy?.issueScope;
  if (scope) return campaignScopeIssues(scope);
  return repository ? (root.orchestratorPolicy?.issueNumbers ?? []).map((number) => ({ repository: repository.toLowerCase(), number })) : [];
}

/** `states` holds each repository verified or found offline for this view; any other repository
 * shows its saved scope. */
export function scopeView(db: ControlPlaneDb, root: SessionView, repository: string,
  states: ReadonlyMap<string, CampaignIssueScopeRepositoryView["state"]> = new Map()): CampaignIssueScopeView {
  const numbers = root.orchestratorPolicy?.issueNumbers ?? [];
  const issues = viewIssues(root, repository);
  const outsideScope: CampaignIssueScopeView["outsideScope"] = [];
  const unverifiedWork: NonNullable<CampaignIssueScopeView["unverifiedWork"]> = [];
  let cursor: string | undefined;
  do {
    const result = db.campaignWorkLedger.page(root.id, { limit: 100, ...(cursor ? { cursor } : {}) }, Date.now());
    if (!result.ok) throw new Error(result.error);
    for (const item of result.data.items) {
      if (!item.issue) continue;
      const entry = { workItemId: item.id, title: item.title ?? item.key, issue: item.issue, sessionId: item.currentAttempt?.sessionId ?? null };
      const held = issues.some((issue) => issue.repository === item.issue!.repository.toLowerCase() && issue.number === item.issue!.number);
      // An unknown repository (#2664) is no mismatch: only a number outside the saved list is.
      if (!repository && numbers.includes(item.issue.number)) unverifiedWork.push(entry);
      else if (!held) outsideScope.push(entry);
    }
    cursor = result.data.nextCursor ?? undefined;
  } while (cursor);
  // Every boundary repository, the launch one first, then any the scope holds beyond them.
  const launch = repository.toLowerCase();
  const names = [...new Set([...(launch ? [launch] : []), ...campaignScopeRepositories(root).map((entry) => entry.repository),
    ...issues.map((issue) => issue.repository)])];
  const repositories: CampaignIssueScopeRepositoryView[] = names.map((name) => ({ repository: name,
    issueNumbers: issues.filter((issue) => issue.repository === name).map((issue) => issue.number), state: states.get(name) ?? "saved" }));
  const requirement = scopeCompatibility(db, root);
  // A first message's context-only references (#3920), less any the scope now holds.
  const first = root.orchestratorPolicy?.firstMessageScope;
  const context = first && first.state !== "pending" ? (first.contextIssueNumbers ?? []).filter((n) => !numbers.includes(n)) : [];
  // The scope grant the first message established (#4102), for Campaign Status's Scope Grant section.
  const grant = first && first.state !== "pending" ? first.grant : undefined;
  // Its ceilings as the current authorization holds them: a later reauthorization can set Maximum
  // Issues explicitly, and only a limit both the grant and that authorization derived moves.
  const control = root.orchestratorPolicy?.control;
  const authority = control?.mode === "full_control" ? control.boundary.issueAuthority : undefined;
  const derivedNow = Boolean(grant && first && first.state !== "pending" && first.derivedLimits?.maxIssues === true &&
    grant.ceilings.maxIssuesSource === "derived");
  const scopeGrant = grant && authority
    ? { ...grant, ceilings: { ...grant.ceilings, maxIssues: authority.maxIssues, maxIssuesSource: derivedNow ? "derived" as const : "explicit" as const } }
    : grant;
  return { campaignSessionId: root.id, repository, issueNumbers: numbers, ...(repositories.length ? { repositories } : {}),
    revision: root.orchestratorPolicy?.issueScope?.revision ?? 0,
    ...(root.orchestratorPolicy?.issueScope ? { authorization: root.orchestratorPolicy.issueScope } : {}),
    supported: !requirement, ...(requirement ? compatibilityFields(requirement) : {}), canPropose: false,
    ...(context.length ? { contextIssueNumbers: context } : {}),
    ...(scopeGrant ? { scopeGrant, policyRevision: root.parentControlPolicy?.revision ?? 0 } : {}),
    ...(campaignScopeIsProposed(root) ? { scopeProposals: scopeProposalViews(db, root.id) } : {}),
    ...(unverifiedWork.length ? { unverifiedWork } : {}), outsideScope };
}

/** The first repository a scope change names outside the campaign's repositories (#4118), from the
 * stored boundary alone; null when every ref is inside it, or when the launch repository is not
 * known yet (a legacy campaign learns it from its runner, and the snapshot then checks again). */
export function scopeRequestOutsideBoundary(root: SessionView, request: CampaignIssueScopeRequest): string | null {
  const allowed = new Set(campaignScopeRepositories(root).map((entry) => entry.repository));
  if (!allowed.size || !request) return null;
  const refs = (list: unknown) => Array.isArray(list) ? list as CampaignIssueRef[] : [];
  const epic = request.lineage?.kind === "epic" && request.lineage.repository !== undefined ? [{ repository: request.lineage.repository }] : [];
  for (const ref of [...refs(request.additions), ...refs(request.removals), ...epic]) {
    if (ref && typeof ref.repository === "string" && campaignRepositoryLocation(ref.repository) && !allowed.has(ref.repository.toLowerCase())) {
      return ref.repository.toLowerCase();
    }
  }
  return null;
}

/** An epic's lineage names its repository in lower case, and only outside the launch repository. */
function canonicalLineage(lineage: NonNullable<CampaignIssueScopeRequest["lineage"]>, launch: string): NonNullable<CampaignIssueScopeRequest["lineage"]> {
  if (lineage.kind === "selection") return { kind: "selection" };
  if (lineage.kind === "follow_up") return { kind: "follow_up", publicationOccurrenceId: lineage.publicationOccurrenceId };
  const repository = lineage.repository?.toLowerCase();
  return { kind: "epic", epic: lineage.epic, ...(repository && repository !== launch ? { repository } : {}) };
}

/** The exact change, grouped by repository (#4118): `repository` is the launch repository, whose
 * numbers stay at the top level, and every other boundary repository the scope holds or the change
 * touches is an `otherRepositories` group. A same-numbered issue in two repositories is two entries.
 * `proposal`: an Orchestrator's recorded proposal (#4282) with its admission when the floors
 * admitted it. It is part of the snapshot's validation, since only an initial proposal may add nothing. */
export function scopeSnapshot(db: ControlPlaneDb, root: SessionView, repository: string, request: CampaignIssueScopeRequest,
  proposal: Pick<CampaignIssueScopeSnapshot, "scopeProposal" | "issueAdmission"> = {}): CampaignIssueScopeSnapshot | null {
  const launch = repository.toLowerCase();
  const allowed = new Set([launch, ...campaignScopeRepositories(root).map((entry) => entry.repository)]);
  if (!request || typeof request.requestId !== "string" || !request.requestId || request.requestId.length > 256 ||
      !Array.isArray(request.additions) || !Array.isArray(request.removals) ||
      [...request.additions, ...request.removals].some((r) => !r || typeof r.repository !== "string" || !allowed.has(r.repository.toLowerCase()))) return null;
  const additions = canonicalCampaignIssues(request.additions);
  const removals = canonicalCampaignIssues(request.removals);
  if (!additions || !removals) return null;
  const held = viewIssues(root, launch);
  const touched = [...new Set([...held, ...additions, ...removals].map((issue) => issue.repository).filter((name) => name !== launch))].sort();
  const numbers = (issues: readonly CampaignIssueRef[], name: string) => issues.filter((issue) => issue.repository === name).map((issue) => issue.number);
  const groups = [launch, ...touched].map((name) => ({ repository: name,
    before: name === launch ? [...root.orchestratorPolicy?.issueNumbers ?? []] : numbers(held, name),
    additions: numbers(additions, name), removals: numbers(removals, name) }));
  const affectedAssignments: CampaignIssueScopeSnapshot["affectedAssignments"] = [];
  // An identically numbered issue in another repository has separate authority.
  let cursor: string | undefined;
  do {
    const page = db.campaignWorkLedger.page(root.id, { limit: 100, ...(cursor ? { cursor } : {}) }, Date.now());
    if (!page.ok) return null;
    for (const i of page.data.items) {
      const name = i.issue?.repository.toLowerCase();
      const group = groups.find((g) => g.repository === name);
      if (!i.issue || !group || !group.removals.includes(i.issue.number) || !i.currentAttempt?.sessionId ||
          affectedAssignments.some((a) => a.sessionId === i.currentAttempt!.sessionId && a.issue === i.issue!.number && (a.repository ?? launch) === name)) continue;
      affectedAssignments.push({ sessionId: i.currentAttempt.sessionId, issue: i.issue.number, ...(name === launch ? {} : { repository: name }) });
    }
    cursor = page.data.nextCursor ?? undefined;
  } while (cursor);
  // A decision or child is affected when any repository's part of the change affects it.
  const changes = groups.filter((g) => g.additions.length || g.removals.length);
  const affectedDecisions = db.authorityBoundWorkflowDecisionsForController(root.id).filter((d) => d.category !== "campaign_issue_scope" &&
    changes.some((g) => scopeChangeAffectsDecision(db, root.id, g.repository, [...g.additions, ...g.removals], groups.some((x) => x.removals.length > 0),
      db.campaignWorkLedger.sessionsUnrelatedToIssues(root.id, g.repository, [...g.additions, ...g.removals]), d)))
    .map((d) => d.occurrenceId).sort();
  const activeChildren: CampaignIssueScopeSnapshot["activeChildren"] = [];
  for (const g of changes) {
    for (const child of issueClosureActiveChildren(db, root.id, { repository: g.repository, numbers: [...g.additions, ...g.removals] })) {
      if (!activeChildren.some((c) => c.sessionId === child.sessionId)) activeChildren.push(child);
    }
  }
  const [own, ...others] = groups;
  return normalizeCampaignIssueScopeSnapshot({ category: "campaign_issue_scope", repository: launch, expectedRevision: request.expectedRevision,
    before: own!.before, additions: own!.additions, removals: own!.removals, ...(others.length ? { otherRepositories: others } : {}),
    explanation: request.explanation, affectedAssignments, affectedDecisions, activeChildren,
    ...(request.lineage === undefined ? {} : { lineage: canonicalLineage(request.lineage, launch) }),
    ...(proposal.scopeProposal ? { scopeProposal: proposal.scopeProposal } : {}),
    ...(proposal.issueAdmission ? { issueAdmission: proposal.issueAdmission } : {}) });
}

/** Every outstanding decision the root controls, other than scope requests. A person deciding a
 * Full Control scope change re-authorizes the boundary all of them were evaluated under, so that
 * request lists, and its approval revokes, every one (#3915). */
export function everyOutstandingScopeDecision(db: ControlPlaneDb, rootId: string): string[] {
  return db.authorityBoundWorkflowDecisionsForController(rootId).filter((d) => d.category !== "campaign_issue_scope").map((d) => d.occurrenceId).sort();
}

/** Whether a decision filed or settled since a person's Full Control scope request bears on its
 * change, which makes the request stale (#4332). The approval revokes whatever is outstanding when
 * it happens and records exactly that, so the list only gates approval where the change is at stake:
 * - A child's decision never decides here. A child the ledger can't prove unrelated is in the
 *   request's `activeChildren`, whose digest covers each of its unconsumed decisions, so any change
 *   to it already moves the digest. Any other child is proven unrelated to every changed issue.
 * - A closure names its issue, so it bears on the change only when that issue is one the change adds
 *   or removes.
 * - A follow-up publication or admission holds a slot the approval counts again when it is decided.
 * - Nothing proves any other decision of the root unrelated, so it still bears on the change.
 * A listed decision that can no longer be read proves nothing, and bears on it too. */
export function outstandingDecisionsBearOnScopeRequest(db: ControlPlaneDb, rootId: string, request: CampaignIssueScopeSnapshot): boolean {
  const listed = new Set(request.affectedDecisions);
  const outstanding = new Set(everyOutstandingScopeDecision(db, rootId));
  const groups = campaignScopeChangeGroups(request);
  return [...listed, ...outstanding].filter((id) => listed.has(id) !== outstanding.has(id)).some((id) => {
    const decision = db.workflowDecisionByOccurrence(id);
    if (!decision) return true;
    const snapshot = decision.resourceSnapshot;
    if (snapshot.category === "issue_closure") {
      const group = groups.find((candidate) => candidate.repository.toLowerCase() === snapshot.repository.toLowerCase());
      return Boolean(group && (group.additions.includes(snapshot.issue) || group.removals.includes(snapshot.issue)));
    }
    return decision.sessionId === rootId && snapshot.category !== "follow_up_issue_publication" && snapshot.category !== "campaign_follow_up_admission";
  });
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

export function campaignNeedsEpicScope(root: SessionView): boolean {
  return campaignSeedHoldsDelegation(root.orchestratorPolicy);
}

/** Whether a Full Control campaign's scope is the Orchestrator's to propose (#4282): its first
 * message established a grant of status `proposal`, so the server read nothing from the message. */
export function campaignScopeIsProposed(root: Pick<SessionView, "orchestratorPolicy">): boolean {
  const policy = root.orchestratorPolicy;
  const first = policy?.firstMessageScope;
  return policy?.control?.mode === "full_control" && first?.state === "established" && first.grant?.status === "proposal";
}

/** Whether a Full Control campaign still waits for its initial scope (#4282): nothing is dispatched
 * until the Orchestrator's initial proposal, or any scope change its owner approves, is applied. */
export function campaignAwaitsInitialScope(root: Pick<SessionView, "orchestratorPolicy">): boolean {
  const first = root.orchestratorPolicy?.firstMessageScope;
  return campaignScopeIsProposed(root) && first?.state === "established" && !first.initialScope;
}

/** The Orchestrator's proposals for Campaign Status (#4282), newest first, each with what it led to. */
export function scopeProposalViews(db: ControlPlaneDb, rootId: string): CampaignScopeProposalView[] {
  return db.scopeProposalDecisions(rootId).flatMap((decision) => {
    const snapshot = decision.resourceSnapshot;
    if (snapshot.category !== "campaign_issue_scope" || !snapshot.scopeProposal) return [];
    const owner = snapshot.scopeProposal.route === "owner";
    const outcome: CampaignScopeProposalView["outcome"] = decision.status === "consumed" ? owner ? "owner_approved" : "applied"
      : decision.status === "pending" || decision.status === "approved" ? owner ? "waiting_for_owner" : "admitted"
        : decision.status === "denied" ? "owner_declined" : "replaced";
    const checked = snapshot.scopeProposal.constraintCheck ? db.getDecisionOccurrence(snapshot.scopeProposal.constraintCheck.occurrenceId) : null;
    return [{ occurrenceId: decision.occurrenceId, createdAt: decision.createdAt, explanation: snapshot.explanation,
      proposal: snapshot.scopeProposal, outcome, ...(checked ? { check: scopeCheckView(checked) } : {}) }];
  });
}
