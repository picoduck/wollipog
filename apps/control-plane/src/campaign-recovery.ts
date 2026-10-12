import { createHash } from "node:crypto";
import { campaignAuthorityPreflight, isTerminal, pendingRequests, runnerSupportsProtocol,
  type CampaignAuthorityEvaluation, type CampaignRecoveryReason, type SessionView } from "@wollipog/protocol";
import { campaignBoundaryCurrent, evaluateCampaignAuthority } from "./campaign-authority.js";
import type { ControlPlaneDb } from "./db.js";
import type { CampaignRecoveryObservation } from "./campaign-recovery-store.js";

/** Hash untrusted provider coordinates rather than allowing an identifier to become a credential,
 * bearer URL, command or media leak. The digest still identifies the exact original resource. */
export function recoveryCoordinate(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function requestReason(evaluation: CampaignAuthorityEvaluation): CampaignRecoveryReason {
  if (evaluation.owner === "orchestrator") return "authorized_action";
  switch (evaluation.reason) {
    case "outside_boundary": return "boundary_enlargement";
    case "unsupported_provider": case "unverified_intent": case "evidence_review_unavailable":
    case "provider_delivery_unavailable": return "unsupported_capability";
    case "protected_request": case "human_required_rule": case "custom_owner": return "human_required_rule";
    default: return "missing_human_information";
  }
}

/** Server adapters translate authoritative requests, holds, receipt state and forge facts into
 * recovery instructions. They never execute an external effect or weaken a typed decision. */
export class CampaignRecoveryService {
  constructor(private readonly db: ControlPlaneDb,
    private readonly changed: (campaignId: string) => void,
    private readonly log: { info(message: string): void }) {}

  maintain(now: number, runnerId?: string): void {
    const roots = new Set([...this.db.listOrchestratorCampaignSessionIds(runnerId), ...this.db.campaignRecovery.campaignIds()]);
    for (const rootId of roots) {
      const root = this.db.getSession(rootId);
      if (!root || (runnerId && root.runnerId !== runnerId)) continue;
      if (root.orchestratorPolicy?.control?.mode !== "full_control" && !this.db.campaignRecovery.campaignIds().includes(rootId)) continue;
      this.synchronize(root, now);
    }
  }

  synchronize(root: SessionView, now: number): void {
    const full = root.orchestratorPolicy?.control?.mode === "full_control";
    const current = full && !root.archived && !root.stopOperation && !isTerminal(root.status) && campaignBoundaryCurrent(root);
    const supported = campaignAuthorityPreflight(root.orchestratorPolicy?.control, root.driver,
      this.db.getRunner(root.runnerId)?.protocolVersion).supported;
    const revision = root.parentControlPolicy?.revision ?? 0;
    const observations: CampaignRecoveryObservation[] = [];
    const previous = this.db.campaignRecovery.activeObservations(root.id);
    const ledgerWorkers = this.db.campaignWorkLedger.attemptedSessionIds(root.id);
    const sessions = [root, ...this.db.campaignDescendantIds(root.id).flatMap(id => {
      const child = this.db.getSession(id); return child ? [child] : [];
    })];
    for (const session of sessions) {
      if (session.archived || session.stopOperation) continue;
      for (const request of pendingRequests(session.pendingApproval)) {
        if (!request.occurrenceId) continue;
        const decision = request.kind === "workflow_decision" ? this.db.workflowDecisionByOccurrence(request.occurrenceId) : null;
        const evaluated = evaluateCampaignAuthority(root, { ...session,
          repositoryRoot: this.db.sessionRepositoryRoot(session.id) ?? undefined },
        this.db.getRunner(session.runnerId)?.protocolVersion,
        decision?.resourceSnapshot ?? this.db.campaignPolicyRequest(session.id, root.orchestratorPolicy?.control, request),
        root.parentControlPolicy, this.db.getRunner(root.runnerId)?.protocolVersion);
        const owner = decision?.authority === "human" ? "human" : evaluated.owner;
        const reason = request.kind === "authentication"
          ? "missing_access" : request.kind === "question" && owner === "human" && !request.humanRequired &&
            evaluated.reason === "unverified_intent" ? "missing_human_information"
          : decision?.humanFallback ? "unsupported_capability"
          : requestReason({ ...evaluated, owner });
        observations.push({ action: decision?.category === "ui_evidence_approval" ? "review_evidence" : "answer_request",
          resource: { kind: "request", sessionId: session.id, occurrenceId: recoveryCoordinate(request.occurrenceId) },
          reason, owner, signal: `${revision}:${owner}:${reason}` });
      }
      for (const hold of session.holds ?? []) {
        observations.push({ action: "recover_hold", resource: { kind: "hold", sessionId: session.id,
          occurrenceId: recoveryCoordinate(hold.holdId) },
          reason: hold.kind === "provider_account_switch" ? "missing_access" : "transient_failure",
          owner: hold.kind === "provider_account_switch" ? "human" : "orchestrator", signal: hold.kind });
      }
      if (session.id !== root.id && !this.db.campaignChildReportVerified(root.id, session.id) &&
          (session.status === "failed" || session.status === "stopped")) {
        const assignment = this.db.campaignWorkLedger.currentAssignment(session.id);
        // Ended attempts are historical, and must not race the replacement's current failure.
        if (assignment || !ledgerWorkers.has(session.id)) observations.push({ action: "replace_worker",
          resource: { kind: "worker", sessionId: session.id, occurrenceId: `epoch:${session.eventEpoch ?? 0}`,
            ...(assignment ? { workItemId: assignment.workItemId } : {}) },
          reason: session.status === "stopped" ? "hard_denial" : "transient_failure",
          owner: "orchestrator", signal: `${session.id}:${session.eventEpoch ?? 0}:${session.status}` });
      }
      for (const attempt of session.steeringAttempts ?? []) {
        if (attempt.state !== "uncertain" || attempt.resolution?.state === "applied") continue;
        observations.push({ action: "reconcile_outcome", resource: { kind: "steering", sessionId: session.id,
          occurrenceId: recoveryCoordinate(attempt.submissionId) }, reason: "uncertain_outcome", owner: "orchestrator",
          signal: attempt.resolution?.state ?? attempt.state });
      }
    }
    for (const decision of this.db.campaignRecoverySettledDecisions(root.id)) {
      observations.push({ action: decision.status === "denied" ? "answer_request" : "reconcile_outcome",
        resource: { kind: "request", sessionId: decision.sessionId, occurrenceId: recoveryCoordinate(decision.occurrenceId) },
        reason: decision.status === "denied" ? "hard_denial" : "uncertain_outcome",
        owner: decision.status === "denied" ? "orchestrator" : "human", signal: decision.status });
    }
    const continuation = this.db.latestCampaignContinuation(root.id);
    if (continuation?.state === "failed" || continuation?.state === "missing_result") {
      const command = this.db.getSessionPromptCommand(continuation.commandId);
      const retryable = command?.state === "failed" && command.userEventSeq === undefined &&
        command.errorCode !== "INVALID_COMMAND" && !command.error?.includes("no longer supports");
      observations.push({ action: continuation.state === "missing_result" ? "reconcile_outcome" : "continue_campaign",
        resource: { kind: "continuation", sessionId: root.id, occurrenceId: continuation.commandId },
        reason: continuation.state === "missing_result" ? "uncertain_outcome"
          : continuation.attemptCount >= 4 ? "attempts_exhausted" : retryable ? "transient_failure" : "unsupported_capability",
        // An ambiguous *parent* turn prevents another parent turn. Its outbox retains the original
        // identity for receipt reconciliation; never acknowledge it merely to admit a new turn.
        owner: retryable ? "orchestrator" : "human", signal: `${continuation.state}:${continuation.attemptCount}` });
    }
    const targets = this.db.campaignWorkLedger.forgeBackgroundTargets(id => id === root.id);
    for (const target of targets) {
      for (const { ref, fact } of this.db.campaignForgeObservations.facts(root.id, target.refs, now)) {
        if (fact.availability !== "fresh") {
          observations.push(...previous.filter(item => item.resource.kind === "pull_request" &&
            item.resource.repository === ref.repository && item.resource.pullRequest === ref.number));
          const reason = fact.availability === "unavailable" && ["forge_unauthenticated", "not_authorized"].includes(fact.reason)
            ? "missing_access" : fact.availability === "unavailable" && ["runner_unsupported", "forge_unsupported"].includes(fact.reason)
              ? "unsupported_capability" : "transient_failure";
          observations.push({ action: "reconcile_outcome", resource: { kind: "pull_request", sessionId: root.id,
            repository: ref.repository, pullRequest: ref.number, occurrenceId: recoveryCoordinate(`${ref.repository}#${ref.number}`) },
            reason, owner: reason === "transient_failure" ? "orchestrator" : "human",
            signal: fact.availability === "unavailable" ? fact.reason : "stale" });
          continue;
        }
        const value = fact.value;
        if (value.state !== "open") continue;
        const resource = { kind: "pull_request" as const, sessionId: root.id, repository: ref.repository,
          pullRequest: ref.number, occurrenceId: value.headSha };
        if (value.checks.state === "failing" || value.requiredChecks.state === "failing") {
          observations.push({ action: "repair_checks", resource, reason: "failed_checks", owner: "orchestrator",
            signal: `${value.headSha}:checks:${value.checks.state}:${value.requiredChecks.state}` });
        }
        if (value.reviewDecision === "changes_requested") {
          observations.push({ action: "rereview", resource, reason: "reviewer_objection", owner: "orchestrator",
            signal: `${value.headSha}:review:${value.reviewDecision}` });
        }
      }
    }
    const changed = this.db.campaignRecovery.synchronize(root.id, revision, current, observations, now);
    // A paused/input-required root is never restarted. Child-owned human work does not prevent an
    // otherwise idle parent from repairing unrelated work. One durable continuation remains the
    // execution lane, with its existing receipt and active-turn uniqueness constraints.
    const mayWake = current && supported && root.status === "idle" && !root.pendingApproval &&
      runnerSupportsProtocol(this.db.getRunner(root.runnerId)?.protocolVersion, "campaignContinuations");
    const dispatched = mayWake ? this.db.campaignRecovery.dispatchDue(root.id, revision, now, (record, eventId) => {
      if (record.resource.kind === "continuation") return; // existing outbox owns backoff/reconciliation
      this.db.recordCampaignContinuationEvent({ eventId, campaignSessionId: root.id,
        kind: "request_actionable", subjectSessionId: record.resource.sessionId,
        occurrenceId: record.id, now });
      this.log.info(JSON.stringify({ event: "campaign_recovery_dispatched", entryPoint: "recovery_sweep",
        campaignId: root.id, recoveryId: record.id, policyRevision: revision, action: record.action,
        reason: record.reason, attempt: record.attempts }));
    }) : 0;
    if (changed || dispatched) this.changed(root.id);
  }
}
