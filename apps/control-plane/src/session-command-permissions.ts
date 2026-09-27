import {
  queueHoldRecoveryAction,
  worktreeRecoveryAction,
  type SessionCommandPermission,
  type SessionCommandPermissions,
  type OrchestratorCampaignProjection,
  type SessionHoldReader,
  type SessionView,
} from "@wollipog/protocol";
import { isAgentControlApiRouteAllowed } from "./auth.js";
import {
  AGENT_UNARCHIVE_ERROR,
  agentCredentialSessionTargetError,
  backgroundJobStopAuthorizationError,
  mutationAuthorizationError,
  orchestratorSelfWorktreeAuthorizationError,
  type AuthPrincipal,
  type HumanPrincipal,
} from "./identity.js";

/** Ownership facts the rules read, looked up by the caller (#1843). */
export interface SessionCommandPermissionFacts {
  /** `isSessionOwner`: the session's ownership scope names this person. Read for people only. */
  ownsSession: boolean;
  /** The session descends from the agent credential's own session. Read for agents only. */
  isDescendant: boolean;
}

const STOP_ROUTE = "/api/sessions/:id/stop";
const RESTART_ROUTE = "/api/sessions/:id/restart";
const STOP_JOB_ROUTE = "/api/sessions/:id/background-jobs/:jobId/stop";
const ARCHIVE_ROUTE = "/api/sessions/:id/archive";
const UNARCHIVE_AND_RESTART_ROUTE = "/api/sessions/:id/unarchive-and-restart";
const PROMPT_ROUTE = "/api/sessions/:id/prompt";
const DELETE_ROUTE = "/api/sessions/:id";
const CANCEL_TURN_ROUTE = "/api/sessions/:id/cancel";
/** Steer, Cancel, Edit, and resolving a delivery or steering attempt apply the same gates (#1857). */
const QUEUE_ROUTES = [
  "/api/sessions/:id/steer",
  "/api/sessions/:id/cancel-queued",
  "/api/sessions/:id/queued/:promptId/edit",
  "/api/sessions/:id/pending-prompts/:commandId/resolve",
  "/api/sessions/:id/steering/:submissionId/resolve",
] as const;
const RENAME_ROUTES = ["/api/sessions/:id/title", "/api/sessions/:id/retitle"] as const;
const CONFIG_ROUTE = "/api/sessions/:id/config";
const RESPOND_ROUTES = ["/api/sessions/:id/answer", "/api/sessions/:id/approve"] as const;

const VIEWER_REASON = "Your Viewer role is read-only.";
const STOP_JOB_OWNER_REASON = "Only the session owner or its controlling Orchestrator can stop its background jobs.";
/** No agent credential's route allowlist includes deleting a session. */
const AGENT_DELETE_REASON = "Session credentials cannot delete sessions.";
/** An agent credential authenticates only on the exact routes its allowlist names (#1857). */
const AGENT_ROUTE_REASON = "Session credentials cannot use this command.";
/** The config service's own rule: on its own session an agent may set only `maxChildSessions`, so
 * none of the configuration this verdict describes (approvals mode, Plan, model, effort) is allowed. */
const AGENT_SELF_CONFIG_REASON = "An agent may change only its own maxChildSessions.";

function sentence(error: string): string {
  const text = error.charAt(0).toUpperCase() + error.slice(1);
  return text.endsWith(".") ? text : `${text}.`;
}

/** The refusal the organization role gate and the agent credential gate give this route, in the
 * order the API applies them, or null when both admit it. */
function routeRefusal(
  routePath: string,
  principal: AuthPrincipal,
  target: { id: string },
  facts: SessionCommandPermissionFacts,
  method = "POST",
): string | null {
  const roleError = mutationAuthorizationError(method, routePath, principal);
  if (roleError) return principal.kind === "human" && principal.role === "viewer" ? VIEWER_REASON : sentence(roleError);
  if (principal.kind !== "agent") return null;
  const targetError = agentCredentialSessionTargetError(routePath, principal, target.id, facts.isDescendant);
  return targetError ? sentence(targetError) : null;
}

/** `routeRefusal` for the commands #1857 added, which also apply the agent credential's route
 * allowlist: a credential outside it is never authenticated for the route. Commands served by
 * several routes take the first refusal, since a surface offers the command only if all admit it. */
function allowlistedRouteRefusal(
  routePaths: readonly string[],
  principal: AuthPrincipal,
  target: { id: string },
  facts: SessionCommandPermissionFacts,
): string | null {
  for (const routePath of routePaths) {
    if (principal.kind === "agent" &&
        !isAgentControlApiRouteAllowed("POST", routePath, principal.orchestrator ? "orchestrator" : null)) {
      return AGENT_ROUTE_REASON;
    }
    const refusal = routeRefusal(routePath, principal, target, facts);
    if (refusal) return refusal;
  }
  return null;
}

function permission(reason: string | null): SessionCommandPermission {
  return reason === null ? { allowed: true } : { allowed: false, reason };
}

/**
 * What `principal` may do to one session it can already see (#1843). Each value is the verdict of
 * the gates the matching route applies, so a surface disables exactly what the server would refuse.
 * Session visibility is not re-checked here: a principal that cannot see the session never
 * receives its view.
 */
export function sessionCommandPermissions(
  principal: AuthPrincipal,
  target: { id: string; parentSessionId?: string | null },
  facts: SessionCommandPermissionFacts,
): SessionCommandPermissions {
  const stopJobRefusal = routeRefusal(STOP_JOB_ROUTE, principal, target, facts) ??
    (backgroundJobStopAuthorizationError(principal, target, principal.kind === "human" && facts.ownsSession)
      ? STOP_JOB_OWNER_REASON
      : null);
  return {
    stop: permission(routeRefusal(STOP_ROUTE, principal, target, facts)),
    restart: permission(routeRefusal(RESTART_ROUTE, principal, target, facts)),
    stopBackgroundJob: permission(stopJobRefusal),
    archive: permission(routeRefusal(ARCHIVE_ROUTE, principal, target, facts)),
    // Both restore routes refuse every agent credential first; for a person they apply the same
    // role gate, so Unarchive and Unarchive and Restart share one verdict.
    unarchive: permission(principal.kind === "agent"
      ? sentence(AGENT_UNARCHIVE_ERROR)
      : routeRefusal(UNARCHIVE_AND_RESTART_ROUTE, principal, target, facts)),
    prompt: permission(routeRefusal(PROMPT_ROUTE, principal, target, facts)),
    delete: permission(principal.kind === "agent"
      ? AGENT_DELETE_REASON
      : routeRefusal(DELETE_ROUTE, principal, target, facts, "DELETE")),
    cancelTurn: permission(allowlistedRouteRefusal([CANCEL_TURN_ROUTE], principal, target, facts)),
    manageQueue: permission(allowlistedRouteRefusal(QUEUE_ROUTES, principal, target, facts)),
    rename: permission(allowlistedRouteRefusal(RENAME_ROUTES, principal, target, facts)),
    configure: permission(allowlistedRouteRefusal([CONFIG_ROUTE], principal, target, facts) ??
      (principal.kind === "agent" && principal.credentialSessionId === target.id ? AGENT_SELF_CONFIG_REASON : null)),
    respond: permission(allowlistedRouteRefusal(RESPOND_ROUTES, principal, target, facts)),
  };
}

/** The routes behind select_worktree and create_worktree, the tools worktree-recovery advice names. */
const HOLD_ADVICE_WORKTREE_ROUTES = ["/api/sessions/:id/worktrees/select", "/api/sessions/:id/worktrees"] as const;

/**
 * What an agent credential may do to a held session, for the hold advice it reads through its tools
 * (#1863): its Stop Job and Restart verdicts, and whether both worktree routes the advice names
 * admit it. `target.orchestratorPolicy` carries Strict Project Isolation, which only an
 * Orchestrator's own session can be refused by. A person gets no reader: they read the server's
 * copy, which the dashboard rewrites for them from their command permissions (#1857).
 */
export function sessionHoldReader(
  principal: AuthPrincipal,
  target: Pick<SessionView, "id" | "parentSessionId" | "orchestratorPolicy">,
  facts: SessionCommandPermissionFacts,
): SessionHoldReader | undefined {
  if (principal.kind !== "agent") return undefined;
  const permissions = sessionCommandPermissions(principal, target, facts);
  const role = principal.orchestrator ? "orchestrator" : null;
  const canManageWorktrees = HOLD_ADVICE_WORKTREE_ROUTES.every((routePath) =>
    isAgentControlApiRouteAllowed("POST", routePath, role) &&
    agentCredentialSessionTargetError(routePath, principal, target.id, facts.isDescendant) === null) &&
    orchestratorSelfWorktreeAuthorizationError(
      principal,
      target.id,
      target.orchestratorPolicy?.execution.strictProjectIsolation !== false,
    ) === null;
  return {
    canStopJobs: permissions.stopBackgroundJob.allowed,
    canRestart: permissions.restart.allowed,
    canManageWorktrees,
  };
}

/** A copy of `session` whose hold advice is written for `reader` (#1863). Each hold is rewritten
 * from the session's own record of it; without a reader the view is returned unchanged. */
export function withHoldAdviceFor<T extends Pick<SessionView, "holds" | "queueHold" | "worktreeRecovery">>(
  session: T,
  reader: SessionHoldReader | undefined,
): T {
  if (!reader || !session.holds?.length) return session;
  const { queueHold, worktreeRecovery } = session;
  return {
    ...session,
    holds: session.holds.map((hold) => {
      if (hold.kind === "worktree_recovery") {
        return worktreeRecovery?.recoveryId === hold.holdId
          ? { ...hold, recoveryAction: worktreeRecoveryAction(worktreeRecovery, reader) }
          : hold;
      }
      return queueHold?.holdId === hold.holdId
        ? { ...hold, recoveryAction: queueHoldRecoveryAction(queueHold, reader) }
        : hold;
    }),
  };
}

/** The ownership lookups `withSessionCommandPermissions` needs from the database. */
export interface SessionCommandPermissionSource {
  isSessionOwner(principal: HumanPrincipal, sessionId: string): boolean;
  isSessionDescendant(ancestorId: string, targetId: string): boolean;
  /** The records behind a projection's holds, read only for an agent credential's projection. */
  sessionHoldRecords(ids: readonly string[]): Map<string,
    Pick<SessionView, "orchestratorPolicy" | "worktreeRecovery" | "queueHold"> & { parentSessionId: string | null }>;
}

function permissionFacts(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal,
  sessionId: string,
): SessionCommandPermissionFacts {
  const credentialSessionId = principal.kind === "agent" ? principal.credentialSessionId : undefined;
  return {
    ownsSession: principal.kind === "human" && source.isSessionOwner(principal, sessionId),
    isDescendant: Boolean(credentialSessionId && source.isSessionDescendant(credentialSessionId, sessionId)),
  };
}

/** `sessionHoldReader` with the ownership facts looked up from the database. */
export function sessionHoldReaderFor(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal | null | undefined,
  target: Pick<SessionView, "id" | "parentSessionId" | "orchestratorPolicy">,
): SessionHoldReader | undefined {
  return principal?.kind === "agent"
    ? sessionHoldReader(principal, target, permissionFacts(source, principal, target.id))
    : undefined;
}

/** A campaign projection whose held children's advice is written for the agent credential reading
 * it (#1863). The projection spans every campaign descendant, and only a direct child's jobs are
 * the Orchestrator's to stop. A person's projection is returned unchanged. */
export function withCampaignHoldAdviceFor<T extends Pick<OrchestratorCampaignProjection, "heldChildren">>(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal | null | undefined,
  projection: T,
): T {
  if (principal?.kind !== "agent" || !projection.heldChildren?.length) return projection;
  const records = source.sessionHoldRecords(projection.heldChildren.map((child) => child.sessionId));
  return {
    ...projection,
    heldChildren: projection.heldChildren.map((child) => {
      const record = records.get(child.sessionId);
      if (!record) return child;
      // A nested Orchestrator's campaign can list its own session, where its isolation policy decides
      // whether it may manage its worktrees.
      const reader = sessionHoldReader(principal, { ...record, id: child.sessionId },
        permissionFacts(source, principal, child.sessionId));
      return { ...child, holds: withHoldAdviceFor({ ...record, holds: child.holds }, reader).holds ?? child.holds };
    }),
  };
}

/** A session view whose hold advice is written for the principal reading it (#1863): its own holds
 * for `reader`, and, when it is an Orchestrator's view, its campaign's held children for
 * `principal`. A person's view is returned unchanged. */
export function withSessionHoldAdviceFor<T extends SessionView>(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal | null | undefined,
  session: T,
  reader: SessionHoldReader | undefined,
): T {
  const view = withHoldAdviceFor(session, reader);
  return view.orchestratorCampaign
    ? { ...view, orchestratorCampaign: withCampaignHoldAdviceFor(source, principal, view.orchestratorCampaign) }
    : view;
}

/** A copy of `session` carrying the requester's command permissions, and for an agent credential,
 * hold advice written for it, including its campaign's held children (#1863). Without a principal
 * (a trusted local connection) the view is returned unchanged, so every command stays offered. */
export function withSessionCommandPermissions<T extends SessionView>(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal | null | undefined,
  session: T,
): T {
  if (!principal) return session;
  const facts = permissionFacts(source, principal, session.id);
  return withSessionHoldAdviceFor(source, principal, {
    ...session,
    commandPermissions: sessionCommandPermissions(principal, session, facts),
  }, session.holds?.length ? sessionHoldReader(principal, session, facts) : undefined);
}
