import {
  scopeAudienceContained,
  type IdentityAdministrationView,
  type ResourceOwner,
  type ResourceScope,
} from "@wollipog/protocol";

export interface AccessScopeChoice {
  key: string;
  label: string;
  description: string;
  owner: ResourceOwner;
}

export function resourceOwnerKey(owner: ResourceOwner): string {
  return owner.kind === "organization" ? `organization:${owner.organizationId}`
    : owner.kind === "user" ? `user:${owner.userId}` : `team:${owner.teamId}`;
}

export function sameResourceScope(left: ResourceScope | undefined, right: ResourceScope | undefined): boolean {
  return Boolean(left && right && left.organizationId === right.organizationId &&
    resourceOwnerKey(left.owner) === resourceOwnerKey(right.owner));
}

export function scopeAudienceContainedForIdentity(
  identity: IdentityAdministrationView,
  narrower: ResourceScope,
  wider: ResourceScope,
): boolean {
  if (scopeAudienceContained(narrower, wider)) return true;
  if (narrower.organizationId !== wider.organizationId ||
      narrower.owner.kind !== "user" || wider.owner.kind !== "team") return false;
  const userId = narrower.owner.userId;
  const teamId = wider.owner.teamId;
  return identity.teams.some((team) => team.teamId === teamId &&
      team.organizationId === wider.organizationId && team.memberUserIds.includes(userId));
}

export function accessScopeLabel(scope: ResourceScope, identity?: IdentityAdministrationView | null): string {
  if (scope.owner.kind === "organization") return "Organization-Wide";
  if (scope.owner.kind === "user") {
    const userId = scope.owner.userId;
    return userId === identity?.context.userId
      ? "Private to Me"
      : `Private to ${identity?.memberships.find((member) => member.userId === userId)?.userName ?? "Another Member"}`;
  }
  const teamId = scope.owner.teamId;
  return `Team: ${identity?.teams.find((team) => team.teamId === teamId)?.name ?? "Unknown Team"}`;
}

export function accessScopeChoices(
  identity: IdentityAdministrationView,
  current?: ResourceScope,
): AccessScopeChoice[] {
  const choices: AccessScopeChoice[] = [];
  if (identity.context.role !== "viewer") choices.push({
    key: `user:${identity.context.userId}`,
    label: "Private to Me",
    description: "Only you and organization administrators can access this resource.",
    owner: { kind: "user", userId: identity.context.userId },
  });
  const administers = identity.context.role === "owner" || identity.context.role === "admin";
  for (const team of identity.context.role === "viewer" ? [] : identity.teams) {
    if (!administers && !team.memberUserIds.includes(identity.context.userId)) continue;
    choices.push({
      key: `team:${team.teamId}`,
      label: `Team: ${team.name}`,
      description: "Every member of this team can access this resource.",
      owner: { kind: "team", teamId: team.teamId },
    });
  }
  if (administers) choices.push({
    key: `organization:${identity.context.organizationId}`,
    label: "Organization-Wide",
    description: "Every active member of your organization can access this resource.",
    owner: { kind: "organization", organizationId: identity.context.organizationId },
  });
  if (current && !choices.some((choice) => choice.key === resourceOwnerKey(current.owner))) {
    choices.unshift({
      key: resourceOwnerKey(current.owner),
      label: accessScopeLabel(current, identity),
      description: "This is the current scope. Choose another permitted scope to change it.",
      owner: current.owner,
    });
  }
  return choices;
}

export function canAssignAccessScope(identity: IdentityAdministrationView, owner: ResourceOwner): boolean {
  return accessScopeChoices(identity).some((choice) => choice.key === resourceOwnerKey(owner));
}

export function canChangeAccessScope(
  identity: IdentityAdministrationView,
  currentScope: ResourceScope,
  targetOwner: ResourceOwner,
): boolean {
  if (!canAssignAccessScope(identity, targetOwner)) return false;
  if (identity.context.role === "owner" || identity.context.role === "admin") return true;
  const targetScope = { organizationId: identity.context.organizationId, owner: targetOwner };
  const sameAudience = scopeAudienceContained(currentScope, targetScope) &&
    scopeAudienceContained(targetScope, currentScope);
  return sameAudience || (scopeAudienceContainedForIdentity(identity, targetScope, currentScope) &&
    !scopeAudienceContainedForIdentity(identity, currentScope, targetScope));
}
