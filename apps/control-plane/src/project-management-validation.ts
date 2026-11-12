import { scopeAudienceContained, type AccessScopeChangePreview, type ResourceScope, type ResourceOwner } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import { canAdministerIdentity, type AuthPrincipal, type HumanPrincipal } from "./identity.js";

export function accessScopeOwnerFromQuery(query: unknown): ResourceOwner | undefined {
  const {ownerKind, ownerId} = (query ?? {}) as {ownerKind?: unknown; ownerId?: unknown};
  if (ownerKind === "organization" && typeof ownerId === "string") return {kind: "organization", organizationId: ownerId};
  if (ownerKind === "user" && typeof ownerId === "string") return {kind: "user", userId: ownerId};
  if (ownerKind === "team" && typeof ownerId === "string") return {kind: "team", teamId: ownerId};
  return undefined;
}
export function accessScopeTransitionError(db: ControlPlaneDb, principal: HumanPrincipal, current: ResourceScope, target: ResourceScope): string | null {
  if (canAdministerIdentity(principal.role)) return null;
  const same = scopeAudienceContained(current, target) && scopeAudienceContained(target, current);
  if (same || (db.scopeAudienceContainedWithMembership(target, current) && !db.scopeAudienceContainedWithMembership(current, target))) return null;
  return "organization owner or admin permission is required unless the access change only narrows the current audience";
}
/** Keep attached relationship evidence internal unless the current principal can read it. */
export function accessScopePreviewForPrincipal(db: ControlPlaneDb, principal: AuthPrincipal, preview: AccessScopeChangePreview): AccessScopeChangePreview {
  return {...preview, affectedProjects: preview.affectedProjects.filter(project => db.canAccessProject(principal, project.projectId))};
}

export const projectName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name && name.length <= 120 && !/[\0-\x1f\x7f]/.test(name) ? name : null;
};

export const requestedAccessScope = (
  db: ControlPlaneDb,
  principal: HumanPrincipal,
  value: unknown,
  fallback?: ResourceScope,
): { ok: true; scope: ResourceScope } | { ok: false; status: 400 | 403; error: string } => {
  const requestedValue = value === undefined ? fallback?.owner : value;
  if (!requestedValue || typeof requestedValue !== "object" || Array.isArray(requestedValue)) {
    return { ok: false, status: 400, error: "owner must select a valid access scope" };
  }
  const owner = requestedValue as Partial<ResourceOwner>;
  const administers = canAdministerIdentity(principal.role);
  if (owner.kind === "organization") {
    if (owner.organizationId !== principal.organizationId) {
      return { ok: false, status: 400, error: "organization access must use the current organization" };
    }
    if (!administers) {
      return { ok: false, status: 403, error: "organization owner or admin permission is required for organization access" };
    }
    return { ok: true, scope: { organizationId: principal.organizationId, owner: {
      kind: "organization", organizationId: principal.organizationId,
    } } };
  }
  if (owner.kind === "user") {
    if (owner.userId !== principal.userId) {
      return { ok: false, status: 403, error: "a private scope can only be assigned to the current user" };
    }
    return { ok: true, scope: { organizationId: principal.organizationId, owner: {
      kind: "user", userId: principal.userId,
    } } };
  }
  if (owner.kind === "team" && typeof owner.teamId === "string") {
    const team = db.identityAdministration(principal).teams.find((candidate) => candidate.teamId === owner.teamId);
    if (!team || (!administers && !team.memberUserIds.includes(principal.userId))) {
      return { ok: false, status: 403, error: "the selected team is not available to the current user" };
    }
    return { ok: true, scope: { organizationId: principal.organizationId, owner: {
      kind: "team", teamId: owner.teamId,
    } } };
  }
  return { ok: false, status: 400, error: "owner must select a valid access scope" };
};
