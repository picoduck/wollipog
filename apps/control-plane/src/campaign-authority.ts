import {
  campaignAuthorityPreflight, resolveCampaignAuthority, runnerSupportsProtocol, validCampaignControl,
  type CampaignAuthorityEvaluation, type CampaignAuthorityBoundary, type CampaignControl, type CampaignIssueScope, type CredentialScreenFact,
  type ParentControlPolicy, type PendingApproval, type SessionView, type WorkflowDecisionResourceSnapshot,
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

/** The runner's diagnostic copy of a campaign's control. A pre-v288 runner rejects a boundary with
 * a `repositories` list (#4117), so it receives the boundary without it, which names the same first
 * repository. The server keeps and enforces the full boundary. */
export function campaignControlForRunner(control: CampaignControl, protocolVersion: number | null | undefined): CampaignControl {
  if (control.mode !== "full_control" || control.boundary.repositories === undefined ||
      runnerSupportsProtocol(protocolVersion, "campaignRepositoryBoundary")) return control;
  const { repositories: _repositories, ...boundary } = control.boundary;
  return { mode: "full_control", boundary };
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
 * become epics here; only an authorization that names them as its issues does. */
export function boundaryWithScopedEpics(boundary: CampaignAuthorityBoundary, issueNumbers: readonly number[]): CampaignAuthorityBoundary {
  const issues = boundary.issueAuthority;
  return issues ? { ...boundary, issueAuthority: { ...issues, epics: issues.epics.filter((n) => issueNumbers.includes(n)) } } : boundary;
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
  return Boolean(scope && scope.repository.toLowerCase() === issue.repository.toLowerCase() &&
    scope.issueNumbers.includes(issue.number) && policy?.issueNumbers?.includes(issue.number));
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
 * refuses it (#3713 for GitHub from v242, #3762 for GitLab from v293). A merge from an older runner
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
  requester: Pick<SessionView, "id" | "driver"> & { repositoryRoot?: string } & Partial<Pick<SessionView, "runnerId" | "workspaceId">>,
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
  const repositoryBound = !pending || (controller.runnerId !== undefined && requester.runnerId === controller.runnerId &&
    controller.workspaceId !== undefined && controller.workspaceId !== null && requester.workspaceId === controller.workspaceId);
  const issueOperation = snapshot?.category === "campaign_issue_scope" || snapshot?.category === "issue_closure" ||
    snapshot?.category === "follow_up_issue_publication" && full && control.boundary.issueAuthority;
  const issueBound = !issueOperation || !full || !control.boundary.issueAuthority || Boolean(snapshot && "issueAdmission" in snapshot &&
    snapshot.issueAdmission?.boundaryRevision === control.boundary.revision && (protocol ?? 0) >= 217 && (controllerProtocol ?? 0) >= 217);
  if (full && (!campaignBoundaryCurrent({ ...controller, parentControlPolicy: policy }) || !repositoryBound || !issueBound)) {
    // A stale boundary authorizes nothing, including the server's own Full Control declines.
    const { requestClass: _requestClass, disposition: _disposition, ...rest } = evaluated;
    return { ...rest, owner: "human", basis: "human_required",
      reason: repositoryBound && closureProofIncomplete(controller, policy, protocol, controllerProtocol, snapshot) ? "closure_proof_incomplete" : "outside_boundary" };
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
    boundary.issueAuthority!.closureReasons.includes(snapshot.reason) && snapshot.repository.toLowerCase() === boundary.repository.toLowerCase() &&
    campaignIssueInScope(controller.orchestratorPolicy, { repository: snapshot.repository, number: snapshot.issue });
}
