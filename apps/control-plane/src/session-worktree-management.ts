import { randomUUID } from "node:crypto";
import { SESSION_WORKTREE_CREATE_RUNNER_TIMEOUT_MS, runnerSupportsProtocol, locationSwitchRole, sessionRole, withRepositoryMismatchGuidance, type RunnerProtocolCapability } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { SessionsService } from "./sessions.js";
import { orchestratorSelfWorktreeAuthorizationError, worktreeRequestedBySession, type AuthPrincipal } from "./identity.js";
import { failureBody, type CapabilityRefusal } from "./capability-refusal.js";
import { legacyPeerWorktreeRetirement } from "./worktree-retirement.js";
import type { WorktreeCreateCoordinator } from "./worktree-create-coordinator.js";
import type { OwnerManagementReply } from "./owner-management.js";

export function createSessionWorktreeManagement(deps: {
  db: ControlPlaneDb; hub: Hub; svc: SessionsService; worktreeCreates: WorktreeCreateCoordinator;
  runnerCapabilityError: (id: string, capability: RunnerProtocolCapability, label: string) => CapabilityRefusal | null;
}) {
  const {db, hub, svc, worktreeCreates, runnerCapabilityError} = deps;
  async function runSessionWorktreeRequest(
    sessionId: string,
    request:
      | { operation: "create"; baseRef?: string; branch: string; progress?: boolean }
      | { operation: "attach" | "select" | "discard" | "retry_setup"; path: string }
      | { operation: "generate_setup" }
      | { operation: "delete_refs"; path?: string; refs: import("@wollipog/protocol").SessionWorktreeRefDeletion[] },
    principal: AuthPrincipal | null,
    reply: OwnerManagementReply,
  ) {
    const session = db.getSession(sessionId);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const reviewRefusal = svc.reviewSessionRefusal(sessionId, "reads its runner's checkout and takes no worktree");
    if (reviewRefusal) return reply.code(409).send({ error: reviewRefusal });
    const authorizationError = orchestratorSelfWorktreeAuthorizationError(
      principal,
      sessionId,
      session.orchestratorPolicy?.execution.strictProjectIsolation !== false,
    );
    if (authorizationError) return reply.code(403).send({ error: authorizationError });
    const unsupported = runnerCapabilityError(
      session.runnerId,
      request.operation === "discard" ? "sessionWorktreeDiscard"
        : request.operation === "retry_setup" ? "worktreeSetup"
        : request.operation === "generate_setup" ? "worktreeSetupConfig"
        : request.operation === "delete_refs" ? "sessionWorktreeRefDeletion" : "sessionWorktrees",
      request.operation === "discard" ? "session worktree discard"
        : request.operation === "retry_setup" ? "worktree setup"
        : request.operation === "generate_setup" ? "worktree setup generation"
        : request.operation === "delete_refs" ? "runner-managed worktree ref deletion" : "session worktrees",
    );
    if (unsupported) return reply.code(409).send(failureBody(unsupported));
    const reconciliationBlock = svc.podReconciliationMutationError(sessionId);
    if (reconciliationBlock) return reply.code(409).send({ error: reconciliationBlock });
    if (!hub.isRunnerOnline(session.runnerId)) return reply.code(409).send({ error: "runner is offline" });
    // Only the session's own switch may continue by itself after its relaunch (#3810). A pre-v255
    // runner gets no flag and keeps going idle once the relaunch has run.
    const selfRequest = (request.operation === "create" || request.operation === "attach" || request.operation === "select") &&
        worktreeRequestedBySession(principal, sessionId) &&
        runnerSupportsProtocol(db.getRunner(session.runnerId)?.protocolVersion, "worktreeSwitchContinuation")
      ? { requestedBySession: true }
      : {};
    if (request.operation === "create" && request.progress === true && runnerSupportsProtocol(
      db.getRunner(session.runnerId)?.protocolVersion,
      "progressAwareSessionWorktrees",
    )) {
      const operation = worktreeCreates.startOrJoin({
        runnerId: session.runnerId,
        sessionId,
        branch: request.branch,
        ...(request.baseRef ? { baseRef: request.baseRef } : {}),
        ...(session.worktreeRecovery ? { recoveryId: session.worktreeRecovery.recoveryId } : {}),
      }, async (requestId) => {
        const res = await hub.requestFromRunner(
          session.runnerId,
          requestId,
          { ...request, ...selfRequest, type: "session_worktree", requestId, sessionId, progress: true },
          SESSION_WORKTREE_CREATE_RUNNER_TIMEOUT_MS,
        );
        if (res.type !== "session_worktree_result") throw new Error("unexpected runner reply");
        if (res.sessionId !== sessionId || res.operation !== "create") {
          throw new Error("mismatched runner worktree reply");
        }
        if (!res.ok || !res.snapshot) throw new Error(res.error ?? "worktree operation failed");
        db.updateSessionFromSnapshot(sessionId, res.snapshot, Date.now());
        return { snapshot: res.snapshot, worktree: res.worktree, ...(res.isolation ? { isolation: res.isolation } : {}) };
      });
      if (operation.status === "in_progress") {
        return reply.code(202).send({ operation });
      }
      worktreeCreates.releaseTerminal(operation.id);
      if (operation.status === "failed") {
        return reply.code(409).send({ operation, error: operation.error });
      }
      return {
        operation: { id: operation.id, status: operation.status },
        worktree: operation.worktree,
        session: db.getSession(sessionId),
        ...(operation.isolation ? { isolation: operation.isolation } : {}),
      };
    }
    const requestId = `worktree_${randomUUID().slice(0, 8)}`;
    const campaignDeliveredPullRequests = request.operation === "discard" &&
      runnerSupportsProtocol(db.getRunner(session.runnerId)?.protocolVersion, "worktreePatchDelivery")
      ? db.campaignChildDeliveredPullRequests(sessionId) : undefined;
    const deliveryCandidates = campaignDeliveredPullRequests === undefined ? {} : { campaignDeliveredPullRequests };
    try {
      const res = await hub.requestFromRunner(
        session.runnerId,
        requestId,
        { ...request, ...selfRequest, ...deliveryCandidates, type: "session_worktree", requestId, sessionId },
        request.operation === "create"
          ? 65 * 60_000
          : request.operation === "retry_setup" ? 65 * 60_000
            // Discovery and deletion-boundary patch verification each have a 90-second deadline.
            : campaignDeliveredPullRequests?.length ? 330_000 : 150_000,
      );
      if (res.type !== "session_worktree_result") return reply.code(502).send({ error: "unexpected runner reply" });
      if (!res.ok || !res.snapshot) {
        const error = res.error ?? "worktree operation failed";
        // A pre-v159 runner cannot answer a discard with a durable receipt, so its retention refusal
        // is terminal rather than pending. Say so explicitly instead of letting the caller wait for a
        // replay that was never journaled.
        const legacy = request.operation === "discard"
          ? legacyPeerWorktreeRetirement(db.getRunner(session.runnerId)?.protocolVersion, error)
          : null;
        // The session's own attach into another repository learns how to recover (#4138). A regular
        // session is pointed at request_location_switch only when its runner has that tool.
        const role = locationSwitchRole({ role: sessionRole(session), parentSessionId: session.parentSessionId });
        const explained = request.operation === "attach" && worktreeRequestedBySession(principal, sessionId) &&
            (role !== "offer" || runnerSupportsProtocol(db.getRunner(session.runnerId)?.protocolVersion, "sessionLocationSwitch"))
          ? withRepositoryMismatchGuidance(role, "worktree_attach", error)
          : error;
        return reply.code(409).send(legacy ?? { error: explained });
      }
      db.updateSessionFromSnapshot(sessionId, res.snapshot, Date.now());
      if (request.operation !== "create" && request.operation !== "delete_refs") worktreeCreates.invalidateSession(sessionId);
      // v133+ runners say whether a live platform sandbox can already write to an attached path.
      // A pre-v133 runner omits it, and the field stays absent rather than being guessed here.
      return { worktree: res.worktree, session: db.getSession(sessionId),
        ...(res.isolation ? { isolation: res.isolation } : {}),
        ...(res.retirement ? { retirement: res.retirement } : {}),
        ...(res.refDeletion ? { refDeletion: res.refDeletion } : {}),
        ...(res.generatedSetup ? { generatedSetup: res.generatedSetup } : {}) };
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message });
    }
  }

  return runSessionWorktreeRequest;
}
