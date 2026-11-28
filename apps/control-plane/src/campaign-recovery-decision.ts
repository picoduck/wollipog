import { createHash } from "node:crypto";
import { campaignAuthorityPreflight, campaignIssueForgeUrl, isTerminal, runnerSupportsProtocol, type CampaignPullRequestRef,
  type CampaignRecoveryDecisionSnapshot, type CampaignRecoveryRecord } from "@wollipog/protocol";
import { campaignIssueInScope } from "./campaign-authority.js";
import { forgeRefKey, hasCampaignCheckFailure } from "./campaign-forge-observations.js";
import { campaignFirstMergeHold } from "./campaign-merge-dependencies.js";
import { exhaustedPullRequest } from "./campaign-recovery-store.js";
import type { ControlPlaneDb } from "./db.js";

export const RECOVERY_PROMPT_PREFIX = "campaign_recovery_prompt_";
export const RECOVERY_REQUEST_PREFIX = "campaign_recovery_request_";

export function recoveryDecisionRefs(db: ControlPlaneDb, campaignId: string, ref: CampaignPullRequestRef, after?: number) {
  const work = db.campaignWorkLedger.pullRequestWorkItems(campaignId).get(forgeRefKey(ref));
  const prerequisites = db.campaignWorkLedger.mergePrerequisitesForMerge(campaignId, ref, work?.workItemId ?? null);
  const refs = [ref, ...prerequisites.flatMap(prerequisite => prerequisite.pullRequests.flatMap(entry => entry.outside ? [] : [entry.ref])),
    ...(after === undefined ? [] : [{ repository: ref.repository, number: after }])];
  return [...new Map(refs.map(entry => [forgeRefKey(entry), entry])).values()];
}

/** Derive authority and placement from live records, independently of the parent's continuation.
 * A handed-off item stays handed off. The owner can authorize an exact turn on its original PR. */
export function recoveryDecisionTarget(db: ControlPlaneDb, campaignId: string, ref: CampaignPullRequestRef,
  record: CampaignRecoveryRecord, after: number | undefined, now: number) {
  const refuse = (error: string, retry = false) => ({ ok: false as const, error, retry });
  const root = db.getSession(campaignId, { includeCampaignProjection: false });
  const scope = db.sessionScope(campaignId);
  const control = root?.orchestratorPolicy?.control;
  if (!root || root.parentSessionId || control?.mode !== "full_control" ||
      scope?.owner.kind !== "user" || scope.owner.userId !== control.boundary.authorizedByUserId ||
      record.policyRevision !== root.parentControlPolicy?.revision || record.resource.sessionId !== root.id ||
      db.roleConversionBlocksSession(root.id)) {
    return refuse("The original campaign or its current authority could not be verified.");
  }
  const admission = db.campaignRequesterRecoveryAdmission(campaignId);
  if (admission.state !== "available") return refuse(admission.reason ?? "The campaign is unavailable.", true);
  const work = db.campaignWorkLedger.pullRequestWorkItems(campaignId).get(forgeRefKey(ref));
  const item = work && db.campaignWorkLedger.detail(campaignId, work.workItemId, now, () => true);
  if (!work || !item?.issue || work.handoff?.responsibleActor === "external" ||
      item.issue.repository.toLowerCase() !== ref.repository.toLowerCase() || !campaignIssueInScope(root.orchestratorPolicy, item.issue)) {
    return refuse("The PR needs a committed in-scope work item controlled by this campaign or handed to its owner.");
  }
  if ((record.dispatchFenced || record.state === "resolved") && work.handoff?.responsibleActor !== "human") {
    return refuse("Only an owner handoff can support targeted recovery of this fenced or historical record.");
  }
  const currentFact = (target: CampaignPullRequestRef) => {
    const fact = db.campaignForgeObservations.facts(campaignId, [target], now)[0]?.fact;
    const supplier = db.campaignForgeObservations.supplier(campaignId, target);
    return supplier && supplier === db.campaignForgeObservingRunner(campaignId, target.repository)?.runnerId &&
      fact?.availability === "fresh" ? fact.value : undefined;
  };
  const pr = currentFact(ref);
  if (!pr) return refuse("A current forge observation is required. Try again once the forge read succeeds.", true);
  if (pr.forge === "gitlab" || pr.state !== "open" || pr.draft || pr.mergeQueue || pr.crossRepository ||
      pr.headSha !== record.resource.occurrenceId || pr.headBranch?.tipSha !== pr.headSha ||
      (record.action === "repair_checks" ? !hasCampaignCheckFailure(pr) : pr.reviewDecision !== "changes_requested")) {
    return refuse("The original open PR, exact branch tip or reason for recovery changed.");
  }
  const requesters = db.campaignRecoveryRequesters(campaignId, ref.repository, ref.number);
  const requester = requesters.length === 1 ? db.getSession(requesters[0]!, { includeCampaignProjection: false }) : null;
  const requesterScope = requester && db.sessionScope(requester.id);
  const runnerProtocol = requester && db.getRunner(requester.runnerId)?.protocolVersion;
  if (!requester || requester.id === root.id || requesterScope?.owner.kind !== "user" ||
      requesterScope.owner.userId !== scope.owner.userId || requesterScope.organizationId !== scope.organizationId ||
      !campaignAuthorityPreflight(control, root.driver, runnerProtocol).supported ||
      !runnerSupportsProtocol(runnerProtocol, "durablePromptQueueIdentity") ||
      db.roleConversionBlocksSession(requester.id) ||
      db.campaignSessionRepository(campaignId, requester.id)?.toLowerCase() !== ref.repository.toLowerCase()) {
    return refuse("A supported original review requester owned by this campaign's owner is required.");
  }
  const matches = (requester.worktrees ?? []).filter(tree => tree.branch === pr.headBranch!.name && tree.source !== "legacy" &&
    (!tree.pullRequest || tree.pullRequest.state === "open" && campaignIssueForgeUrl(tree.pullRequest.url, ref.repository, "change", ref.number)));
  if (matches.length !== 1) return refuse("The original requester must have one preserved worktree for the current PR branch.");
  const tree = matches[0]!;
  const worktree = { id: tree.id, path: tree.path, branch: tree.branch };
  if (requester.archiveStatus || requester.stopOperation || requester.worktreeRecovery || requester.queueHold ||
      requester.archived && !isTerminal(requester.status)) {
    return refuse("The original requester has an unfinished lifecycle or worktree operation.", true);
  }
  if (isTerminal(requester.status) && db.sessionStopProvenance(requester.id)?.cause === "guardrail") {
    return refuse("The original requester was stopped by a guardrail.");
  }
  const prerequisites = db.campaignWorkLedger.mergePrerequisitesForMerge(campaignId, ref, work.workItemId);
  if (campaignFirstMergeHold(prerequisites)) return refuse("A recorded merge prerequisite must land before recovery.", true);
  if (after !== undefined) {
    const predecessor = { repository: ref.repository, number: after };
    const predecessorWork = db.campaignWorkLedger.pullRequestWorkItems(campaignId).get(forgeRefKey(predecessor));
    if (!predecessorWork) return refuse("The requested predecessor is not recorded in this campaign.");
    const fact = currentFact(predecessor);
    if (fact?.state !== "merged" || !fact.mergeCommitSha) return refuse(`PR #${after} must merge before recovery.`, true);
  }
  const owner = db.operatingHumanPrincipal(scope.owner.userId, scope.organizationId);
  if (!owner || !db.canAccessSession(owner, root.id) || !db.canAccessSession(owner, requester.id)) {
    return refuse("The owner no longer has access to both sessions.");
  }
  const binding = createHash("sha256").update(JSON.stringify({
    authority: db.campaignContinuationAuthorityDigest(campaignId), scope, ref, after,
    item: item.id, issue: item.issue, handoff: work.handoff,
    prerequisites: prerequisites.map(prerequisite => [prerequisite.id, prerequisite.pullRequests.map(entry => entry.ref)]),
    requester: requester.id, requesterScope, runner: requester.runnerId, workspace: requester.workspaceId,
    // The normal prompt path resolves unset model and effort from the current harness. Keep the
    // durable binding on the requester and its execution permission, including its account.
    project: requester.projectId, agent: requester.agentId, driver: requester.driver,
    permissionMode: requester.permissionMode, account: requester.providerAccountRef,
    worktree, source: tree.source, head: pr.headSha, base: pr.baseRef,
  })).digest("hex");
  return { ok: true as const, root, requester, worktree, binding, owner,
    restoreRequester: requester.archived || isTerminal(requester.status) };
}

export function recoverySnapshotRecord(db: ControlPlaneDb, campaignId: string, snapshot: CampaignRecoveryDecisionSnapshot) {
  const record = db.campaignRecovery.record(campaignId, snapshot.recoveryId);
  return record && exhaustedPullRequest(record) && record.action === snapshot.action && record.attempts === snapshot.attempts &&
    record.resource.repository?.toLowerCase() === snapshot.repository.toLowerCase() &&
    record.resource.pullRequest === snapshot.pullRequest && record.resource.occurrenceId === snapshot.headSha ? record : undefined;
}

/** Deferred prompts reuse the outbox's delivery identity. A stale or unavailable read cannot
 * cause a replay, even after reconnect. The attempt already charged at staging stays charged. */
export function requesterRecoveryMaySend(db: ControlPlaneDb, commandId: string, sessionId: string, now: number): boolean {
  const decision = db.workflowDecisionByOccurrence(commandId.slice(RECOVERY_PROMPT_PREFIX.length));
  const snapshot = decision?.resourceSnapshot;
  if (decision?.status !== "consumed" || snapshot?.category !== "campaign_recovery" || snapshot.requesterSessionId !== sessionId) return false;
  const receipt = db.campaignRecovery.extensions(decision.sessionId).find(entry => entry.requestId === decision.occurrenceId);
  if (receipt?.revokedAt !== null || receipt.delivery !== "requester") return false;
  const target = recoveryDecisionTarget(db, decision.sessionId, { repository: snapshot.repository, number: snapshot.pullRequest },
    receipt.snapshot.record, snapshot.after, now);
  return target.ok && target.binding === snapshot.binding && !target.restoreRequester &&
    target.requester.worktreePath === snapshot.worktree.path && !target.requester.pendingApproval &&
    !db.campaignBudgets.admissionError(sessionId);
}
