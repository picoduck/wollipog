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
/** Why a pending request needs its owner: the four irrecoverable classes of #2938 stay distinct. */
export function requestReason(evaluation: CampaignAuthorityEvaluation): CampaignRecoveryReason {
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
  private readonly admissionStates = new Map<string, string>();
  constructor(private readonly db: ControlPlaneDb,
    private readonly changed: (campaignId: string) => void,
    private readonly log: { info(message: string): void }) {}

  maintain(now: number, runnerId?: string): void {
    const retained = new Set(this.db.campaignRecovery.campaignIds());
    const roots = new Set([...this.db.listOrchestratorCampaignSessionIds(runnerId), ...retained]);
    for (const rootId of roots) {
      const root = this.db.getSession(rootId);
      if (!root || (runnerId && root.runnerId !== runnerId)) continue;
      if (root.orchestratorPolicy?.control?.mode !== "full_control" && !retained.has(rootId)) continue;
      this.synchronize(root, now);
    }
  }

  synchronize(root: SessionView, now: number): void {
    const full = root.orchestratorPolicy?.control?.mode === "full_control";
    const revision = root.parentControlPolicy?.revision ?? 0;
    if (!full) {
      this.admissionStates.delete(root.id);
      if (this.db.campaignRecovery.synchronize(root.id, revision, false, [], now)) this.changed(root.id);
      return;
    }
    const current = full && !root.archived && !root.stopOperation && !isTerminal(root.status) && campaignBoundaryCurrent(root);
    const supported = campaignAuthorityPreflight(root.orchestratorPolicy?.control, root.driver,
      this.db.getRunner(root.runnerId)?.protocolVersion).supported;
    const observations: CampaignRecoveryObservation[] = [];
    const previous = this.db.campaignRecovery.activeObservations(root.id);
    const ledgerWorkers = this.db.campaignWorkLedger.attemptedSessionIds(root.id);
    const sessions = [root, ...this.db.campaignDescendantIds(root.id).flatMap(id => {
      const child = this.db.getSession(id); return child ? [child] : [];
    })];
    for (const session of sessions) {
      // Stop/archive is no receipt. Preserve the original uncertain steering identity even
      // when the worker is retired; only its reconciled receipt may remove this observation.
      for (const attempt of session.steeringAttempts ?? []) {
        if (attempt.state !== "uncertain" || attempt.resolution?.state === "applied") continue;
        observations.push({ action: "reconcile_outcome", resource: { kind: "steering", sessionId: session.id,
          occurrenceId: recoveryCoordinate(attempt.submissionId) }, reason: "uncertain_outcome", owner: "orchestrator",
          signal: attempt.resolution?.state ?? attempt.state });
      }
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
    }
    for (const decision of this.db.campaignRecoverySettledDecisions(root.id)) {
      if (decision.status === "denied") {
        const report = this.db.campaignRecoveryVerifiedReport(root.id, decision.sessionId);
        if (report) {
          this.db.campaignRecovery.retireDeniedOccurrence(root.id, decision.sessionId, decision.occurrenceId, report);
          continue;
        }
      }
      observations.push({ action: decision.status === "denied" ? "answer_request" : "reconcile_outcome",
        resource: { kind: "request", sessionId: decision.sessionId, occurrenceId: recoveryCoordinate(decision.occurrenceId) },
        reason: decision.status === "denied" ? "hard_denial" : "uncertain_outcome",
        owner: decision.status === "denied" ? "orchestrator" : "human", signal: decision.status });
    }
    for (const job of this.db.campaignReviewJobs.recoveryJobs(root.id)) {
      const unknown = job.usageSettlement === "unavailable" || job.usageSettlement === "pending" && previous.some(item =>
        item.resource.kind === "review_job" && item.resource.occurrenceId === job.jobId && item.reason === "uncertain_outcome");
      const objection = job.attemptValid === true && job.vote === "DOWNVOTE";
      const invalid = job.terminalOutcome === "invalid_review" || job.terminalOutcome === "not_launched";
      if (!unknown && !objection && !invalid) continue;
      const exhausted = objection ? job.round >= 4 : invalid && job.attemptConsumed === true && job.attempt >= 2;
      observations.push({ action: unknown ? "reconcile_outcome" : "rereview",
        resource: { kind: "review_job", sessionId: job.worktreeSessionId, occurrenceId: job.jobId,
          repository: job.request.pullRequest.repository, pullRequest: job.request.pullRequest.number,
          workItemId: job.request.workItemId },
        reason: unknown ? "uncertain_outcome" : exhausted ? "attempts_exhausted"
          : objection ? "reviewer_objection" : "transient_failure",
        owner: "orchestrator", signal: `${job.reviewEpoch}:${job.round}:${job.attempt}:${job.terminalOutcome}:${job.receiptSha256 ?? "unsettled"}` });
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
          // The background forge reader owns retries for stale/transient reads. A read gap is
          // informational, not an unknown mutation and not another parent recovery instruction.
          // Retain any prior check/review failure until a fresh observation proves its repair.
          if (reason === "transient_failure") continue;
          observations.push({ action: "reconcile_outcome", resource: { kind: "pull_request", sessionId: root.id,
            repository: ref.repository, pullRequest: ref.number, occurrenceId: recoveryCoordinate(`${ref.repository}#${ref.number}`) },
            reason, owner: "human",
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
        if (value.reviewDecision === "changes_requested" && !observations.some(item =>
          item.action === "rereview" && item.resource.repository === ref.repository && item.resource.pullRequest === ref.number)) {
          observations.push({ action: "rereview", resource, reason: "reviewer_objection", owner: "orchestrator",
            signal: `${value.headSha}:review:${value.reviewDecision}` });
        }
      }
    }
    // A dispatched wake is unanswered only while nothing could still be answering it: the root is
    // idle with nothing pending and no descendant is queued, starting or running.
    const quiet = root.status === "idle" && !root.pendingApproval && sessions.slice(1).every(session =>
      session.archived || !["queued", "starting", "running"].includes(session.status));
    const changed = this.db.campaignRecovery.synchronize(root.id, revision, current, observations, now,
      quiet ? record => this.db.campaignRecoveryWakeSettledAt(root.id, `${record.id}:${record.attempts}`) : undefined);
    const admission = this.db.campaignContinuationAdmission(root.id);
    const admissionKey = `${revision}:${admission.state}`;
    if (this.admissionStates.get(root.id) !== admissionKey) {
      this.admissionStates.set(root.id, admissionKey);
      this.log.info(JSON.stringify({ event: "campaign_recovery_admission", entryPoint: "recovery_sweep",
        campaignId: root.id, policyRevision: revision, state: admission.state }));
    }
    // A paused/input-required root is never restarted. Child-owned human work does not prevent an
    // otherwise idle parent from repairing unrelated work. One durable continuation remains the
    // execution lane, with its existing receipt and active-turn uniqueness constraints.
    const mayWake = current && supported && admission.state === "available" &&
      root.status === "idle" && !root.pendingApproval &&
      runnerSupportsProtocol(this.db.getRunner(root.runnerId)?.protocolVersion, "campaignContinuations");
    const committedDispatches: Array<{ recoveryId: string; action: string; reason: string; attempt: number }> = [];
    const dispatched = mayWake ? this.db.campaignRecovery.dispatchDue(root.id, revision, now, (record, eventId) => {
      if (record.resource.kind === "continuation") return; // existing outbox owns backoff/reconciliation
      this.db.recordCampaignContinuationEvent({ eventId, campaignSessionId: root.id,
        kind: "request_actionable", subjectSessionId: record.resource.sessionId,
        occurrenceId: record.id, now });
      committedDispatches.push({ recoveryId: record.id, action: record.action, reason: record.reason, attempt: record.attempts });
    }, record => {
      const completion = this.db.campaignRecoveryCompletion(root.id, now);
      return completion.state === "children_unfinished" || completion.recoveryIds.includes(record.id);
    }) : 0;
    for (const dispatch of committedDispatches) this.log.info(JSON.stringify({
      event: "campaign_recovery_dispatched", entryPoint: "recovery_sweep", campaignId: root.id,
      policyRevision: revision, ...dispatch }));
    if (changed || dispatched) this.changed(root.id);
  }
}
