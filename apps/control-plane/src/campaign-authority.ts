import {
  CAMPAIGN_BOUNDARY_LOCATIONS_MAX, campaignAuthorityPreflight, campaignBoundaryRepositories, campaignBoundaryRepository, campaignScopeHolds, initialScopeRepositoryLimits, resolveCampaignAuthority, runnerSupportsProtocol, validCampaignControl,
  type CampaignAuthorityEvaluation, type CampaignBoundaryRepository, type CampaignAuthorityBoundary, type CampaignControl, type CampaignIssueScope, type CampaignRefusedRepository, type CredentialScreenFact,
  type OrchestratorCampaignPolicy, type ParentControlPolicy, type PendingApproval, type SessionView, type WorkflowDecisionResourceSnapshot,
} from "@wollipog/protocol";
import type { HumanPrincipal } from "./identity.js";

/** Construct human provenance from the authenticated principal, never from request JSON. Used
 * by the later launch integration. This is deliberately unavailable to agent-facing routes. */
export function authorizeFullControl(
  principal: HumanPrincipal,
  scope: NonNullable<NonNullable<SessionView["orchestratorPolicy"]>["issueScope"]>,
  proposal: Pick<CampaignAuthorityBoundary, "objective" | "operations" | "delegatablePolicyIds" | "issueAuthority" | "budgetAuthority" | "repositories">,
  revision: number,
  now: number,
): CampaignControl | null {
  if (principal.kind !== "human" || !principal.userId || scope.authorizedByUserId !== principal.userId) return null;
  const control: CampaignControl = { mode: "full_control", boundary: {
    objective: proposal.objective, operations: proposal.operations, delegatablePolicyIds: proposal.delegatablePolicyIds,
    ...(proposal.budgetAuthority !== undefined ? { budgetAuthority: proposal.budgetAuthority } : {}),
    version: 1, revision, issueScopeRevision: scope.revision, repository: scope.repository,
    authorizedByUserId: principal.userId, authorizedAt: now,
    ...(proposal.issueAuthority === undefined ? {} : { issueAuthority: proposal.issueAuthority }),
    // The verified Project repositories the reviewed launch inspected; validation requires the
    // first to be the scope's repository.
    ...(proposal.repositories === undefined ? {} : { repositories: structuredClone(proposal.repositories) }),
  } };
  return validCampaignControl(control) ? structuredClone(control) : null;
}

/** The repositories a campaign already has, which a new Full Control authorization keeps (#4117):
 * its current boundary's list, or the list a Custom campaign grew through approved additions. Only
 * a list led by the scope's own repository carries over; anything else reads as no list, so the
 * authorization keeps today's single-repository boundary. */
export function carriedCampaignRepositories(session: SessionView, scopeRepository: string): CampaignBoundaryRepository[] | undefined {
  const policy = session.orchestratorPolicy;
  const list = policy?.control?.mode === "full_control" ? policy.control.boundary.repositories : policy?.repositories;
  return list?.length && list[0]!.repository.toLowerCase() === scopeRepository.toLowerCase() ? structuredClone(list) : undefined;
}

/** The repositories the owner's first message limits a campaign to (#4117), or none. A limit is
 * narrowing only: nothing here adds a repository, and while one stands only an approved
 * `campaign_repository_addition` gives another repository an entry. */
export function campaignRepositoryLimits(policy: Pick<OrchestratorCampaignPolicy, "firstMessageScope"> | null | undefined): string[] {
  const first = policy?.firstMessageScope;
  return first?.state === "established" ? initialScopeRepositoryLimits(first.initialScope) : [];
}

/** Whether a first-message limit leaves this repository out of the campaign's work (#4117). The
 * launch entry stays in the boundary because the root runs there, but it grants no work: no child is
 * placed in it, and no gate of its is delegated. */
export function campaignRepositoryOutsideLimit(policy: Pick<OrchestratorCampaignPolicy, "firstMessageScope"> | null | undefined, repository: string): boolean {
  const limits = campaignRepositoryLimits(policy);
  return limits.length > 0 && !limits.includes(repository.toLowerCase());
}

/** The runner's diagnostic copy of a campaign's control. A pre-v288 runner rejects a boundary with
 * a `repositories` list (#4117), and a pre-v322 one an issue authority with `otherEpics` (#4118), so
 * each receives the boundary without them, which names the same first repository and its epics. The
 * server keeps and enforces the full boundary. */
export function campaignControlForRunner(control: CampaignControl, protocolVersion: number | null | undefined): CampaignControl {
  if (control.mode !== "full_control") return control;
  let boundary = control.boundary;
  if (boundary.repositories !== undefined && !runnerSupportsProtocol(protocolVersion, "campaignRepositoryBoundary")) {
    const { repositories: _repositories, ...rest } = boundary;
    boundary = rest;
  }
  if (boundary.issueAuthority?.otherEpics !== undefined && !runnerSupportsProtocol(protocolVersion, "repositoryQualifiedEpics")) {
    const { otherEpics: _otherEpics, ...issueAuthority } = boundary.issueAuthority;
    boundary = { ...boundary, issueAuthority };
  }
  return boundary === control.boundary ? control : { mode: "full_control", boundary };
}

/** The authoritative order of the runner's copy of a campaign's control (#3363): the campaign
 * root's policy revision, which every control change advances, so a runner can refuse a delayed
 * update within one issue-scope revision. A pre-v310 runner is never sent it and keeps replacing
 * control with each synchronization, as before. */
export function campaignControlRevisionForRunner(revision: number | undefined, protocolVersion: number | null | undefined): { controlRevision?: number } {
  return revision !== undefined && Number.isSafeInteger(revision) && revision >= 0 &&
    runnerSupportsProtocol(protocolVersion, "campaignControlRevision") ? { controlRevision: revision } : {};
}

/** The boundary a Human's own approval of an issue scope establishes (#2940): the same grants,
 * naming the scope revision that approval created, authorized by that Human at that time. Evidence
 * authority is that boundary author's own disclosure consent, so it carries over only to the same
 * Human; another approver's boundary routes evidence to a person until they authorize it. */
export function remintCampaignBoundary(boundary: CampaignAuthorityBoundary, scope: Pick<CampaignIssueScope, "revision">,
  userId: string, authorizedAt: number): CampaignControl | null {
  const { evidenceAuthority, ...rest } = structuredClone(boundary);
  const next: CampaignAuthorityBoundary = { ...rest, revision: boundary.revision + 1, issueScopeRevision: scope.revision,
    authorizedByUserId: userId, authorizedAt };
  if (evidenceAuthority && userId === boundary.authorizedByUserId) {
    next.evidenceAuthority = { ...evidenceAuthority, revision: next.revision, authorizedAt, issueScopeRevision: scope.revision };
  }
  const control: CampaignControl = { mode: "full_control", boundary: next };
  return validCampaignControl(control) ? control : null;
}

/** The boundary with its authorized epics narrowed to the issue scope it will name (#3920): an
 * issue removed from the scope is no longer an epic whose members lineage can add. Additions never
 * become epics here; only an authorization that names them as its issues does. An epic is narrowed
 * by its own repository's part of the scope (#4118). */
export function boundaryWithScopedEpics(boundary: CampaignAuthorityBoundary, scope: Pick<CampaignIssueScope, "repository" | "issueNumbers" | "issues">): CampaignAuthorityBoundary {
  const issues = boundary.issueAuthority;
  if (!issues) return boundary;
  const { otherEpics, ...rest } = issues;
  const kept = otherEpics?.filter((epic) => campaignScopeHolds(scope, epic));
  return { ...boundary, issueAuthority: { ...rest, epics: issues.epics.filter((n) => scope.issueNumbers.includes(n)), ...(kept?.length ? { otherEpics: kept } : {}) } };
}

export function campaignBoundaryCurrent(controller: Pick<SessionView, "orchestratorPolicy" | "parentControlPolicy">): boolean {
  const control = controller.orchestratorPolicy?.control;
  if (!control || control.mode === "custom") return true;
  const scope = controller.orchestratorPolicy?.issueScope;
  return validCampaignControl(control) && Boolean(scope &&
    scope.authorizedByUserId === control.boundary.authorizedByUserId &&
    scope.authorizedAt <= control.boundary.authorizedAt &&
    scope.repository.toLowerCase() === control.boundary.repository.toLowerCase() &&
    scope.revision === control.boundary.issueScopeRevision &&
    controller.parentControlPolicy?.revision === control.boundary.revision);
}

/** Whether the campaign's current issue scope names this issue (#4062). Both copies of the scope
 * must name it, so a scope the server is still synchronizing never admits more than either says. */
export function campaignIssueInScope(policy: SessionView["orchestratorPolicy"], issue: { repository: string; number: number }): boolean {
  const scope = policy?.issueScope;
  if (!scope || !campaignScopeHolds(scope, issue)) return false;
  // The launch repository's numbers are also what its runner enforces; both must hold the issue.
  return issue.repository.toLowerCase() !== scope.repository.toLowerCase() || Boolean(policy?.issueNumbers?.includes(issue.number));
}

/** Whether a closure's issue is one the campaign holds (#4119): another repository's issue by the
 * repository-qualified scope, and the launch repository's by the numbers its runner enforces. */
export function campaignClosureIssueHeld(policy: SessionView["orchestratorPolicy"], issue: { repository: string; number: number }): boolean {
  const scope = policy?.issueScope;
  if (scope && issue.repository.toLowerCase() !== scope.repository.toLowerCase()) return campaignScopeHolds(scope, issue);
  return Boolean(policy?.issueNumbers?.includes(issue.number));
}

/** The campaign's launch repository: its Full Control boundary's, or the one its scope recorded.
 * Empty when neither is known, as for a legacy campaign that never saved one (#2664). */
export function campaignLaunchRepository(root: Pick<SessionView, "orchestratorPolicy">): string {
  const control = root.orchestratorPolicy?.control;
  return (control?.mode === "full_control" ? control.boundary.repository : root.orchestratorPolicy?.issueScope?.repository ?? "").toLowerCase();
}

/** The repository named here, in lower case, when it is not the campaign's launch repository (#4119):
 * the launch repository's gates stay in the root's own checkout. Null for the launch repository, for
 * no repository, and for a legacy campaign that never recorded one. */
export function campaignOtherRepository(root: Pick<SessionView, "orchestratorPolicy">, repository: string | undefined): string | null {
  const launch = campaignLaunchRepository(root);
  const named = repository?.toLowerCase();
  return named && launch && named !== launch ? named : null;
}

/** The repositories the campaign's issue scope may hold, the launch repository first (#4118): a
 * Full Control boundary's entries, each with its verified Locations in order. A Custom campaign's
 * entries are the launch repository its scope recorded and the list its owner's approved additions
 * grew (#4117). */
export function campaignScopeRepositories(root: Pick<SessionView, "orchestratorPolicy">): CampaignBoundaryRepository[] {
  const control = root.orchestratorPolicy?.control;
  if (control?.mode === "full_control") return campaignBoundaryRepositories(control.boundary)
    .map((entry) => ({ repository: entry.repository.toLowerCase(), locationIds: entry.locationIds }));
  const launch = campaignLaunchRepository(root);
  const listed = (root.orchestratorPolicy?.repositories ?? []).map((entry) => ({ repository: entry.repository.toLowerCase(), locationIds: entry.locationIds }));
  const own = listed.find((entry) => entry.repository === launch);
  return [...(launch ? [own ?? { repository: launch, locationIds: [] }] : []), ...listed.filter((entry) => entry.repository !== launch)];
}

/** The repositories this campaign refuses because a Location's runner can't perform its gates (#4319):
 * each one a read found, recorded durably or still on an exclusion written before that record existed,
 * that holds no entry now. Holding an entry is the only thing that ends a refusal. */
export function campaignRefusedRepositories(root: Pick<SessionView, "orchestratorPolicy">): CampaignRefusedRepository[] {
  const policy = root.orchestratorPolicy;
  const entries = new Set(campaignScopeRepositories(root).map((entry) => entry.repository));
  const seen = new Set<string>();
  return [...policy?.refusedRepositories ?? [],
    ...(policy?.excludedLocations ?? []).flatMap((item) => item.failure === "runner_below_gates" && item.repository
      ? [{ repository: item.repository, locationId: item.locationId, name: item.name }] : [])]
    .map((item) => ({ repository: item.repository.toLowerCase(), locationId: item.locationId, name: item.name }))
    .filter((item) => {
      const key = `${item.repository}\n${item.locationId}`;
      if (entries.has(item.repository) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Keep every repository `policy` refuses now in its durable record (#4319), so no later change to
 * its exclusions forgets one, and drop those that now hold an entry. Call it at the start of every
 * write that can replace or drop an exclusion. Until such a write, the exclusion itself names the
 * repository, and every reader reads both. The record keeps its oldest; past its bound a repository
 * is refused only while its exclusion stands. */
export function rememberRefusedRepositories(policy: OrchestratorCampaignPolicy): void {
  const refused = campaignRefusedRepositories({ orchestratorPolicy: policy });
  if (refused.length) policy.refusedRepositories = refused.slice(0, CAMPAIGN_BOUNDARY_LOCATIONS_MAX);
  else delete policy.refusedRepositories;
}

/** Under Full Control the issue scope bounds what the Orchestrator may deliver (#4062): a child is
 * never dispatched on a work item whose issue is outside it. Recording that item stays allowed. */
export function campaignDispatchScopeRefusal(policy: SessionView["orchestratorPolicy"],
  issue: { repository: string; number: number } | null): string | null {
  if (policy?.control?.mode !== "full_control" || !issue || campaignIssueInScope(policy, issue)) return null;
  return `its issue ${issue.repository}#${issue.number} is outside this Full Control campaign's issue scope. ` +
    "Add it with request_campaign_issue_scope_change first; if that is refused, only the campaign owner can add it, " +
    "so leave the item undispatched and report it as blocked work.";
}

/** Under Full Control a merge may close only issues in the campaign's current issue scope (#4062).
 * A merge's `intendedClosures` are exactly what the forge would close: the child's runner reads that
 * before the merge is requested and again before it is armed, and a mismatch or an unreadable forge
 * refuses it (#3713 for GitHub from v242, #3762 for GitLab from v295). A merge from an older runner
 * is not read, so it is never assumed to close nothing, and its declaration proves nothing either:
 * it is the person's. */
function mergeClosureScope(policy: SessionView["orchestratorPolicy"], protocol: number | null | undefined,
  snapshot: Extract<WorkflowDecisionResourceSnapshot, { category: "pr_merge" }>): Pick<CampaignAuthorityEvaluation, "reason" | "unscopedClosures"> | null {
  const declared = snapshot.intendedClosures ?? [];
  const unscoped = declared.filter((reference) => {
    const separator = reference.lastIndexOf("#");
    return !campaignIssueInScope(policy, { repository: reference.slice(0, separator), number: Number(reference.slice(separator + 1)) });
  });
  if (unscoped.length) return { reason: "outside_issue_scope", unscopedClosures: unscoped };
  const read = runnerSupportsProtocol(protocol,
    snapshot.mergeMethod === undefined ? "githubMergeClosingReferences" : "gitlabMergeClosingReferences");
  return read ? null : { reason: "unverified_closures" };
}

export function evaluateCampaignAuthority(
  controller: Pick<SessionView, "id" | "driver" | "orchestratorPolicy" | "parentControl" | "parentControlPolicy"> & Partial<Pick<SessionView, "runnerId" | "workspaceId">>,
  requester: Pick<SessionView, "id" | "driver"> & Partial<Pick<SessionView, "runnerId" | "workspaceId">> & {
    repositoryRoot?: string;
    /** #4119: `campaignBoundaryRepositoryAt` for the requester's runner and workspace, resolved by
     * the server. Needed only away from the controller's own place; absent there means none. */
    boundaryRepository?: string | null;
  },
  protocol: number | null | undefined,
  request: PendingApproval | WorkflowDecisionResourceSnapshot,
  policy: ParentControlPolicy = controller.parentControlPolicy ?? { revision: 0, decisions: {
    implementation_question: "human", pr_merge: "human", merged_branch_deletion: "human",
    follow_up_issue_publication: "human", ui_evidence_approval: "human", review_round_extension: "human",
  } },
  controllerProtocol: number | null | undefined = protocol,
  peerContracts?: { requester?: unknown; controller?: unknown },
  /** #4075: `ControlPlaneDb.reviewExtensionCap` for a review_round_extension snapshot. */
  reviewExtensionCap?: "within" | "exceeded",
  /** #4104: the typed route's Decision Model screen of an implementation question, at admission only. */
  credentialScreen?: CredentialScreenFact,
): CampaignAuthorityEvaluation {
  const control = controller.orchestratorPolicy?.control;
  const full = control?.mode === "full_control";
  const snapshot = "category" in request ? request : undefined;
  const raw = "requestId" in request ? request : undefined;
  // Only a v230 runner attests worktree containment; an older runner's evidence is unresolved (#2940).
  const pending = raw?.context?.operation?.filesystem?.containment && !runnerSupportsProtocol(protocol, "campaignWorktreeContainment")
    ? { ...raw, context: { ...raw.context, operation: { ...raw.context.operation,
      filesystem: (({ containment: _containment, ...rest }) => rest)(raw.context.operation.filesystem) } } }
    : raw;
  const evaluated = resolveCampaignAuthority({ control, parentControl: controller.parentControl ?? "off",
    decisions: policy.decisions, root: controller.id === requester.id,
    supported: full ? campaignAuthorityPreflight(control, requester.driver, protocol, peerContracts?.requester).supported &&
      campaignAuthorityPreflight(control, controller.driver, controllerProtocol, peerContracts?.controller).supported : (protocol ?? 0) >= (snapshot ? 139 : 136),
    snapshot, request: pending, trustedSource: snapshot ? "workflow_route" : pending?.requestSource,
    humanRequired: pending?.humanRequired, repositoryRoot: requester.repositoryRoot,
    // Both the requester's runner and the controller's must support capped extensions (#4075).
    ...(snapshot?.category === "review_round_extension" && reviewExtensionCap &&
      runnerSupportsProtocol(protocol, "fullControlReviewExtensions") &&
      runnerSupportsProtocol(controllerProtocol, "fullControlReviewExtensions") ? { reviewExtensionCap } : {}),
    ...(snapshot?.category === "implementation_question" && credentialScreen ? { credentialScreen } : {}) });
  // The boundary repository whose Location the requester runs in (#4119): the controller's own
  // place is the first entry's; any other place is the caller's server-resolved Location lookup.
  const atController = controller.runnerId !== undefined && requester.runnerId === controller.runnerId &&
    controller.workspaceId !== undefined && controller.workspaceId !== null && requester.workspaceId === controller.workspaceId;
  const placeRepository = !full ? null : atController ? control.boundary.repository.toLowerCase() : requester.boundaryRepository?.toLowerCase() ?? null;
  // Every request, typed or not: a participant whose Location left the boundary owns nothing.
  const repositoryBound = placeRepository !== null;
  // A pull request's gates belong to the requester's own repository: a child in one boundary
  // repository's Location never merges, extends or deletes another repository's pull request.
  const pullRequestGate = snapshot?.category === "pr_merge" || snapshot?.category === "merged_branch_deletion" ||
    snapshot?.category === "review_round_extension";
  const pullRequestBound = !full || !pullRequestGate || placeRepository === snapshot.repository.toLowerCase();
  const issueOperation = snapshot?.category === "campaign_issue_scope" || snapshot?.category === "issue_closure" ||
    snapshot?.category === "follow_up_issue_publication" && full && control.boundary.issueAuthority;
  const issueBound = !issueOperation || !full || !control.boundary.issueAuthority || Boolean(snapshot && "issueAdmission" in snapshot &&
    snapshot.issueAdmission?.boundaryRevision === control.boundary.revision && (protocol ?? 0) >= 217 && (controllerProtocol ?? 0) >= 217);
  // A repository a first-message limit leaves out grants no work (#4117): none of its gates is
  // delegated, whoever asks, and a child somehow placed there owns nothing. The root still runs in
  // the launch Location, so only a request about that repository is refused. Scope has its own
  // floors, and a repository addition is the owner's already.
  const gatedRepository = snapshot && "repository" in snapshot && snapshot.category !== "campaign_issue_scope" &&
    snapshot.category !== "campaign_repository_addition" ? snapshot.repository : null;
  const outsideLimit = (repository: string | null) => repository !== null && campaignRepositoryOutsideLimit(controller.orchestratorPolicy, repository);
  const limitBound = !outsideLimit(gatedRepository) && (controller.id === requester.id || !outsideLimit(placeRepository));
  if (full && (!campaignBoundaryCurrent({ ...controller, parentControlPolicy: policy }) || !repositoryBound || !pullRequestBound || !issueBound || !limitBound)) {
    // A stale boundary authorizes nothing, including the server's own Full Control declines.
    const { requestClass: _requestClass, disposition: _disposition, ...rest } = evaluated;
    return { ...rest, owner: "human", basis: "human_required",
      reason: repositoryBound && closureProofIncomplete(controller, policy, protocol, controllerProtocol, snapshot) ? "closure_proof_incomplete" : "outside_boundary" };
  }
  // A limit outlives Full Control (#4118): back in Custom, however its toggles are set, a gate of a
  // repository the limit leaves out is still the person's.
  if (!full && evaluated.owner === "orchestrator" && outsideLimit(gatedRepository)) {
    const { requestClass: _requestClass, disposition: _disposition, ...rest } = evaluated;
    return { ...rest, owner: "human", basis: "human_required", reason: "outside_boundary" };
  }
  // #4119: nothing reported is never green, so a merge citing no checks is the person's in every mode.
  if (snapshot?.category === "pr_merge" && snapshot.checksBasis === "all_reported" && !snapshot.requiredChecks.checks.length) {
    const { requestClass: _requestClass, disposition: _disposition, ...rest } = evaluated;
    return { ...rest, owner: "human", basis: "human_required", reason: "no_checks" };
  }
  const closures = full && evaluated.owner === "orchestrator" && snapshot?.category === "pr_merge"
    ? mergeClosureScope(controller.orchestratorPolicy, protocol, snapshot) : null;
  if (closures) return { ...evaluated, owner: "human", basis: "human_required", ...closures };
  return evaluated;
}

/** A closure the current boundary delegates, of an issue in scope, that the server admitted no
 * proof for and named gaps instead (#4058). It names why a person decides it; it never changes who
 * does. A stale boundary, an issue outside the scope or a reason the boundary does not delegate
 * stays `outside_boundary`, as does an admission bound to another boundary revision. */
function closureProofIncomplete(
  controller: Pick<SessionView, "orchestratorPolicy" | "parentControlPolicy">, policy: ParentControlPolicy,
  protocol: number | null | undefined, controllerProtocol: number | null | undefined, snapshot: WorkflowDecisionResourceSnapshot | undefined,
): boolean {
  const control = controller.orchestratorPolicy?.control;
  if (snapshot?.category !== "issue_closure" || control?.mode !== "full_control" || !control.boundary.issueAuthority ||
      snapshot.issueAdmission || !snapshot.deliveryGaps?.length || (protocol ?? 0) < 217 || (controllerProtocol ?? 0) < 217) return false;
  const boundary = control.boundary;
  return campaignBoundaryCurrent({ ...controller, parentControlPolicy: policy }) && boundary.operations.includes("issue_closure") &&
    boundary.issueAuthority!.closureReasons.includes(snapshot.reason) && campaignBoundaryRepository(boundary, snapshot.repository) !== null &&
    campaignIssueInScope(controller.orchestratorPolicy, { repository: snapshot.repository, number: snapshot.issue });
}
