import type { CreateSessionRequest, ResourceScope } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";

export type SessionCreationOwnershipResolution =
  | { ok: true; body: CreateSessionRequest; scope: ResourceScope | undefined }
  | { ok: false; status: 404; error: string };

export function canAssignSessionProject(
  db: ControlPlaneDb,
  principal: HumanPrincipal,
  sessionId: string,
  projectId: string | null,
): boolean {
  const session = db.getSession(sessionId);
  if (!session) return false;
  if (projectId !== null && !db.canAccessProject(principal, projectId)) return false;
  if (!session.projectId || session.projectId === projectId || db.canManageProject(principal, session.projectId)) {
    return true;
  }
  const scope = db.sessionScope(sessionId);
  return scope?.owner.kind === "user" && scope.owner.userId === principal.userId;
}

/** Resolve the route's durable Project assignment and freeze the session to that Project's scope. */
export function resolveSessionCreationOwnership(
  db: ControlPlaneDb,
  principal: HumanPrincipal | null,
  body: CreateSessionRequest,
): SessionCreationOwnershipResolution {
  let resolvedBody = body;
  let projectScope: ResourceScope | null = null;

  if (typeof body.projectId === "string") {
    if (!principal || !db.canAccessProject(principal, body.projectId)) {
      return { ok: false, status: 404, error: "project not found" };
    }
    projectScope = db.projectScope(body.projectId);
  } else if (body.projectId === undefined && body.projectLocationId === undefined && !body.workspacePath?.trim()) {
    const inferred = db.findProjectLocation(body.runnerId, body.workspaceId);
    if (inferred) {
      if (principal && db.canAccessProject(principal, inferred.projectId)) {
        projectScope = db.projectScope(inferred.projectId);
      } else {
        resolvedBody = { ...body, projectId: null, projectLocationId: null };
      }
    }
  }

  const scope = projectScope ?? (principal ? {
    organizationId: principal.organizationId,
    owner: { kind: "user" as const, userId: principal.userId },
  } : undefined);
  return { ok: true, body: resolvedBody, scope };
}
