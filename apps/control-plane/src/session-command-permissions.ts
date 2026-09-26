import type { SessionCommandPermission, SessionCommandPermissions, SessionView } from "@wollipog/protocol";
import { isAgentControlApiRouteAllowed } from "./auth.js";
import {
  AGENT_UNARCHIVE_ERROR,
  agentCredentialSessionTargetError,
  backgroundJobStopAuthorizationError,
  mutationAuthorizationError,
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
    configure: permission(allowlistedRouteRefusal([CONFIG_ROUTE], principal, target, facts)),
    respond: permission(allowlistedRouteRefusal(RESPOND_ROUTES, principal, target, facts)),
  };
}

/** The ownership lookups `withSessionCommandPermissions` needs from the database. */
export interface SessionCommandPermissionSource {
  isSessionOwner(principal: HumanPrincipal, sessionId: string): boolean;
  isSessionDescendant(ancestorId: string, targetId: string): boolean;
}

/** A copy of `session` carrying the requester's command permissions. Without a principal (a
 * trusted local connection) the view is returned unchanged, so every command stays offered. */
export function withSessionCommandPermissions<T extends SessionView>(
  source: SessionCommandPermissionSource,
  principal: AuthPrincipal | null | undefined,
  session: T,
): T {
  if (!principal) return session;
  const credentialSessionId = principal.kind === "agent" ? principal.credentialSessionId : undefined;
  return {
    ...session,
    commandPermissions: sessionCommandPermissions(principal, session, {
      ownsSession: principal.kind === "human" && source.isSessionOwner(principal, session.id),
      isDescendant: Boolean(credentialSessionId && source.isSessionDescendant(credentialSessionId, session.id)),
    }),
  };
}
