import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { runnerSupportsProtocol, type CampaignWorktreeRetirementState } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { AuthPrincipal } from "./identity.js";

const PREFIX = "/api/sessions/:id/orchestrator-campaign/cleanup/worktree";

function confirmationState(value: unknown): value is CampaignWorktreeRetirementState {
  if (!value || typeof value !== "object") return false;
  const state = value as CampaignWorktreeRetirementState;
  return state.clean === true && [state.path, state.worktreeId, state.registeredBranch, state.branch, state.pathIdentity]
    .every(item => typeof item === "string" && item.length > 0 && item.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(item)) &&
    typeof state.headSha === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(state.headSha);
}

/** Deliberately HTTP-only. These routes are absent from every Assistant/session/CLI dispatcher.
 * A delegated decision, Full Control or an asserted actor in request JSON grants no access. */
export function registerCampaignWorktreeRetirementRoutes(app: FastifyInstance, deps: {
  db: ControlPlaneDb; hub: Hub; requestPrincipal(request: FastifyRequest): AuthPrincipal | null;
}): void {
  const { db, hub } = deps;
  for (const operation of ["inspect", "confirm"] as const) app.post(`${PREFIX}/${operation}`, async (request, reply) => {
    const principal = deps.requestPrincipal(request);
    if (principal?.kind !== "human" || principal.role === "viewer") {
      return reply.code(403).send({ error: "only an authenticated human operator may confirm worktree retirement" });
    }
    const rootId = (request.params as { id: string }).id;
    const body = request.body as { childSessionId?: unknown; path?: unknown; state?: unknown } | null;
    const childId = body?.childSessionId;
    const path = operation === "confirm" && confirmationState(body?.state) ? body.state.path : body?.path;
    if (typeof childId !== "string" || !childId || childId.length > 256 || typeof path !== "string" ||
        !path || path.length > 4096 || (operation === "confirm" && !confirmationState(body?.state))) {
      return reply.code(400).send({ error: "a campaign child and exact worktree state are required" });
    }
    const root = db.getSession(rootId), child = db.getSession(childId);
    if (!root || !child || !root.orchestratorPolicy || db.campaignRootForMember(childId) !== rootId ||
        !db.canAccessSession(principal, rootId) || !db.canAccessSession(principal, childId) ||
        !db.canAccessRunner(principal, child.runnerId)) {
      return reply.code(404).send({ error: "campaign worktree not found" });
    }
    if (!child.archived || child.archiveStatus || !db.campaignWorktreeCleanup(childId)
      .some(item => item.path === path && item.status === "refused")) {
      return reply.code(409).send({ error: "only a fully archived child's refused worktree can be retired here" });
    }
    if (!runnerSupportsProtocol(db.getRunner(child.runnerId)?.protocolVersion, "campaignWorktreeConfirmation")) {
      return reply.code(409).send({ error: "update the child's runner: person-only worktree confirmation is required" });
    }
    if (!hub.isRunnerOnline(child.runnerId)) return reply.code(409).send({ error: "the child's runner is offline" });
    const requestId = `human_retirement_${randomUUID()}`, now = Date.now();
    if (operation === "confirm") {
      // Durable admission audit precedes the runner effect. The runner cleanup receipt carries the
      // same person/time and exact state, even if the HTTP response is lost or cleanup needs replay.
      db.recordMutationAudit({ auditId: requestId, principal, method: "CONFIRM", route: `${PREFIX}/confirm`,
        targetId: `${childId}:${(body!.state as CampaignWorktreeRetirementState).worktreeId}`, statusCode: 202, now });
    }
    try {
      const result = await hub.requestFromRunner(child.runnerId, requestId, operation === "inspect"
        ? { type: "session_worktree", requestId, sessionId: childId, operation: "inspect_retirement", path }
        : { type: "session_worktree", requestId, sessionId: childId, operation: "confirm_retirement",
          state: body!.state as CampaignWorktreeRetirementState, confirmedBy: { userId: principal.userId, at: now } }, 150_000);
      if (result.type !== "session_worktree_result" || result.sessionId !== childId ||
          result.operation !== `${operation}_retirement`) return reply.code(502).send({ error: "mismatched retirement reply" });
      if (!result.ok || !result.snapshot || operation === "inspect" && !result.retirementState) {
        return reply.code(409).send({ error: result.error ?? "worktree retirement could not be verified" });
      }
      db.updateSessionFromSnapshot(childId, result.snapshot, Date.now());
      return { ...(result.retirementState ? { state: result.retirementState } : {}), retirement: result.retirement };
    } catch {
      return reply.code(409).send({ error: "retirement response unavailable; refresh cleanup before trying again" });
    }
  });
}
