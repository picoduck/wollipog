import type { OrganizationRole } from "@wollipog/protocol";
import type { ResourceScope } from "@wollipog/protocol";
import { matchWorkspaceId } from "./workspace-match.js";

export const PERSONAL_ORGANIZATION_ID = "org_personal";
export const LOCAL_OWNER_USER_ID = "usr_local_owner";

export interface HumanPrincipal {
  kind: "human";
  actorId: string;
  userId: string;
  userName: string;
  organizationId: string;
  organizationName: string;
  role: OrganizationRole;
  deviceId: string | null;
  localBootstrap: boolean;
}

export interface AgentPrincipal {
  kind: "agent";
  actorId: string;
  userId?: undefined;
  organizationId: string;
  delegatedScope: ResourceScope;
  deviceId?: undefined;
  localBootstrap?: false;
}

export type AuthPrincipal = HumanPrincipal | AgentPrincipal;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isMutationMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export function canOperate(role: OrganizationRole): boolean {
  return role !== "viewer";
}

export function canAdministerIdentity(role: OrganizationRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Central organization-role gate for the API surface. Conductors remain limited by their
 * existing exact route allowlist before they reach this function. Human viewers are read-only;
 * identity/team/device administration additionally requires owner/admin. Trusted loopback is
 * represented as the bootstrap owner, so the personal zero-setup deployment remains compatible.
 */
export function mutationAuthorizationError(
  method: string,
  routePath: string,
  principal: AuthPrincipal | null,
): string | null {
  if (!isMutationMethod(method) || !(routePath === "/api" || routePath.startsWith("/api/"))) return null;
  if (!principal) return "authentication required";
  if (principal.kind === "agent") return null;
  // Session reminders are private per-user Inbox metadata, not a mutation of the shared session.
  // The route separately requires a human principal and exact read access to the session.
  if (routePath === "/api/sessions/:id/reminder") {
    return null;
  }
  if (!canOperate(principal.role)) return "read-only members cannot mutate organization resources";
  if (
    (routePath === "/api/identity" || routePath.startsWith("/api/identity/") ||
      routePath === "/api/devices" || routePath.startsWith("/api/devices/")) &&
    !canAdministerIdentity(principal.role)
  ) {
    return "organization owner or admin permission is required";
  }
  return null;
}

export function agentDelegationAuthorizationError(routePath: string, principal: AgentPrincipal): string | null {
  const resourceRoute = routePath === "/api/runners" || routePath === "/api/sessions" ||
    routePath.startsWith("/api/sessions/");
  if (resourceRoute || principal.delegatedScope.owner.kind === "organization") return null;
  return "the conductor session is not delegated organization-wide access to this global resource";
}

export function forkSnapshotIdentityError(
  source: {
    agentId: string | null;
    driver: string;
    workspaceId: string | null;
    executionWorkspacePath?: string | null;
  },
  fork: {
    agentId: string | null;
    driver: string;
    workspaceId: string | null;
    workspacePath?: string | null;
  },
): string | null {
  // workspaceId is control-plane-owned filing metadata and may have changed since the runner
  // launched the source. Prefer the runner-persisted launch path whenever it is available; only
  // legacy rows without that immutable execution identity fall back to the organizational id.
  const sameExecutionWorkspace = source.executionWorkspacePath
    ? fork.workspacePath != null &&
      matchWorkspaceId([{ id: "source", path: source.executionWorkspacePath }], fork.workspacePath) === "source" &&
      matchWorkspaceId([{ id: "fork", path: fork.workspacePath }], source.executionWorkspacePath) === "fork"
    : fork.workspaceId === source.workspaceId;
  return fork.agentId === source.agentId && fork.driver === source.driver && sameExecutionWorkspace
    ? null
    : "runner returned a fork with a different agent or workspace identity";
}

export function forkProjectAssignment(
  source: {
    runnerId: string;
    workspaceId: string | null;
    projectId?: string | null;
  },
  activeLocation: {
    id: string;
    projectId: string;
    runnerId: string;
    workspaceId: string;
    availability: string;
  } | null,
  forkExecutionWorkspaceId: string | null,
): { projectId: string | null; projectLocationId: string | null } {
  if (!source.projectId) return { projectId: null, projectLocationId: null };
  const exactLocation =
    forkExecutionWorkspaceId === source.workspaceId &&
    activeLocation?.projectId === source.projectId &&
    activeLocation.availability !== "runner_removed" &&
    activeLocation.runnerId === source.runnerId &&
    activeLocation.workspaceId === source.workspaceId
      ? activeLocation
      : null;
  return {
    projectId: source.projectId,
    projectLocationId: exactLocation?.id ?? null,
  };
}

export function providerForkNeedsCleanup(forkCreatedOnRunner: boolean, timedOut: boolean): boolean {
  return forkCreatedOnRunner || timedOut;
}

export function providerForkCleanupTarget(
  requestedTargetSessionId: string,
  forkCreatedOnRunner: boolean,
  timedOut: boolean,
): string | null {
  return providerForkNeedsCleanup(forkCreatedOnRunner, timedOut) ? requestedTargetSessionId : null;
}

export function providerForkSnapshotIdError(targetSessionId: string, snapshotSessionId: string): string | null {
  return snapshotSessionId === targetSessionId ? null : "runner returned the wrong fork session";
}

export function boundedTargetId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const record = params as Record<string, unknown>;
  for (const key of [
    "shareId", "id", "sessionId", "runnerId", "resourceId", "podId", "workflowId", "policyId",
    "triggerId", "attemptId", "instanceId", "artifactId", "userId", "teamId",
  ] as const) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 256);
  }
  return undefined;
}
