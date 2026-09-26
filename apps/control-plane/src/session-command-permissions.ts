import type { SessionCommandPermission, SessionCommandPermissions, SessionView } from "@wollipog/protocol";
import {
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

const VIEWER_REASON = "Your Viewer role is read-only.";
const STOP_JOB_OWNER_REASON = "Only the session owner or its controlling Orchestrator can stop its background jobs.";

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
): string | null {
  const roleError = mutationAuthorizationError("POST", routePath, principal);
  if (roleError) return principal.kind === "human" && principal.role === "viewer" ? VIEWER_REASON : sentence(roleError);
  if (principal.kind !== "agent") return null;
  const targetError = agentCredentialSessionTargetError(routePath, principal, target.id, facts.isDescendant);
  return targetError ? sentence(targetError) : null;
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
