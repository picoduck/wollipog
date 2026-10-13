import {
  campaignAuthorityPreflight, resolveCampaignAuthority, validCampaignControl,
  type CampaignAuthorityEvaluation, type CampaignAuthorityBoundary, type CampaignControl,
  type ParentControlPolicy, type PendingApproval, type SessionView, type WorkflowDecisionResourceSnapshot,
} from "@wollipog/protocol";
import type { HumanPrincipal } from "./identity.js";

/** Construct human provenance from the authenticated principal, never from request JSON. Used
 * by the later launch integration. This is deliberately unavailable to agent-facing routes. */
export function authorizeFullControl(
  principal: HumanPrincipal,
  scope: NonNullable<NonNullable<SessionView["orchestratorPolicy"]>["issueScope"]>,
  proposal: Pick<CampaignAuthorityBoundary, "objective" | "operations" | "delegatablePolicyIds" | "issueAuthority">,
  revision: number,
  now: number,
): CampaignControl | null {
  if (principal.kind !== "human" || !principal.userId || scope.authorizedByUserId !== principal.userId) return null;
  const control: CampaignControl = { mode: "full_control", boundary: {
    objective: proposal.objective, operations: proposal.operations, delegatablePolicyIds: proposal.delegatablePolicyIds,
    version: 1, revision, issueScopeRevision: scope.revision, repository: scope.repository,
    authorizedByUserId: principal.userId, authorizedAt: now,
    ...(proposal.issueAuthority === undefined ? {} : { issueAuthority: proposal.issueAuthority }),
  } };
  return validCampaignControl(control) ? structuredClone(control) : null;
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
    follow_up_issue_publication: "human", ui_evidence_approval: "human",
  } },
  controllerProtocol: number | null | undefined = protocol,
): CampaignAuthorityEvaluation {
  const control = controller.orchestratorPolicy?.control;
  const full = control?.mode === "full_control";
  const snapshot = "category" in request ? request : undefined;
  const pending = "requestId" in request ? request : undefined;
  const evaluated = resolveCampaignAuthority({ control, parentControl: controller.parentControl ?? "off",
    decisions: policy.decisions, root: controller.id === requester.id,
    supported: full ? campaignAuthorityPreflight(control, requester.driver, protocol).supported &&
      campaignAuthorityPreflight(control, controller.driver, controllerProtocol).supported : (protocol ?? 0) >= (snapshot ? 139 : 136),
    snapshot, request: pending, trustedSource: snapshot ? "workflow_route" : pending?.requestSource,
    humanRequired: pending?.humanRequired, repositoryRoot: requester.repositoryRoot });
  const repositoryBound = !pending || (controller.runnerId !== undefined && requester.runnerId === controller.runnerId &&
    controller.workspaceId !== undefined && controller.workspaceId !== null && requester.workspaceId === controller.workspaceId);
  const issueOperation = snapshot?.category === "campaign_issue_scope" || snapshot?.category === "issue_closure" ||
    snapshot?.category === "follow_up_issue_publication" && full && control.boundary.issueAuthority;
  const issueBound = !issueOperation || !full || !control.boundary.issueAuthority || Boolean(snapshot && "issueAdmission" in snapshot &&
    snapshot.issueAdmission?.boundaryRevision === control.boundary.revision && (protocol ?? 0) >= 217 && (controllerProtocol ?? 0) >= 217);
  return full && (!campaignBoundaryCurrent({ ...controller, parentControlPolicy: policy }) || !repositoryBound || !issueBound)
    ? { ...evaluated, owner: "human", basis: "human_required", reason: "outside_boundary" }
    : evaluated;
}
