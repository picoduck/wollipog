import {
  campaignAuthorityPreflight, resolveCampaignAuthority, runnerSupportsProtocol, validCampaignControl,
  type CampaignAuthorityEvaluation, type CampaignAuthorityBoundary, type CampaignControl, type CampaignIssueScope,
  type ParentControlPolicy, type PendingApproval, type SessionView, type WorkflowDecisionResourceSnapshot,
} from "@wollipog/protocol";
import type { HumanPrincipal } from "./identity.js";

/** Construct human provenance from the authenticated principal, never from request JSON. Used
 * by the later launch integration. This is deliberately unavailable to agent-facing routes. */
export function authorizeFullControl(
  principal: HumanPrincipal,
  scope: NonNullable<NonNullable<SessionView["orchestratorPolicy"]>["issueScope"]>,
  proposal: Pick<CampaignAuthorityBoundary, "objective" | "operations" | "delegatablePolicyIds" | "issueAuthority" | "budgetAuthority">,
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
  } };
  return validCampaignControl(control) ? structuredClone(control) : null;
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
    humanRequired: pending?.humanRequired, repositoryRoot: requester.repositoryRoot });
  const repositoryBound = !pending || (controller.runnerId !== undefined && requester.runnerId === controller.runnerId &&
    controller.workspaceId !== undefined && controller.workspaceId !== null && requester.workspaceId === controller.workspaceId);
  const issueOperation = snapshot?.category === "campaign_issue_scope" || snapshot?.category === "issue_closure" ||
    snapshot?.category === "follow_up_issue_publication" && full && control.boundary.issueAuthority;
  const issueBound = !issueOperation || !full || !control.boundary.issueAuthority || Boolean(snapshot && "issueAdmission" in snapshot &&
    snapshot.issueAdmission?.boundaryRevision === control.boundary.revision && (protocol ?? 0) >= 217 && (controllerProtocol ?? 0) >= 217);
  if (full && (!campaignBoundaryCurrent({ ...controller, parentControlPolicy: policy }) || !repositoryBound || !issueBound)) {
    // A stale boundary authorizes nothing, including the server's own Full Control declines.
    const { requestClass: _requestClass, disposition: _disposition, ...rest } = evaluated;
    return { ...rest, owner: "human", basis: "human_required", reason: "outside_boundary" };
  }
  return evaluated;
}
