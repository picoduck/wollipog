import {
  scopeAudienceContained,
  type AccessScopeChangePreview,
  type IdentityAdministrationView,
  type ResourceOwner,
  type ResourceScope,
} from "@wollipog/protocol";
import { accountLabelText } from "./personal-identifiers.js";

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

function privateOwnerName(userId: string, identity?: IdentityAdministrationView | null): string {
  return accountLabelText(
    identity?.memberships.find((member) => member.userId === userId)?.userName ?? "Another Member",
    "Another Member",
  );
}

export function accessScopeLabel(scope: ResourceScope, identity?: IdentityAdministrationView | null): string {
  if (scope.owner.kind === "organization") return "Organization-Wide";
  if (scope.owner.kind === "user") {
    const userId = scope.owner.userId;
    return userId === identity?.context.userId ? "Private to Me" : `Private to ${privateOwnerName(userId, identity)}`;
  }
  const teamId = scope.owner.teamId;
  return `Team: ${identity?.teams.find((team) => team.teamId === teamId)?.name ?? "Unknown Team"}`;
}

export function accessScopeChoices(
  identity: IdentityAdministrationView,
  current?: ResourceScope,
): AccessScopeChoice[] {
  const choices: AccessScopeChoice[] = [];
  const organizationId = identity.context.organizationId;
  const choice = (owner: ResourceOwner, label: string): AccessScopeChoice => ({
    key: resourceOwnerKey(owner),
    label,
    description: accessScopeAudience({ organizationId, owner }, identity),
    owner,
  });
  if (identity.context.role !== "viewer") {
    choices.push(choice({ kind: "user", userId: identity.context.userId }, "Private to Me"));
  }
  const administers = identity.context.role === "owner" || identity.context.role === "admin";
  for (const team of identity.context.role === "viewer" ? [] : identity.teams) {
    if (!administers && !team.memberUserIds.includes(identity.context.userId)) continue;
    choices.push(choice({ kind: "team", teamId: team.teamId }, `Team: ${team.name}`));
  }
  if (administers) choices.push(choice({ kind: "organization", organizationId }, "Organization-Wide"));
  if (current && !choices.some((entry) => entry.key === resourceOwnerKey(current.owner))) {
    choices.unshift({
      key: resourceOwnerKey(current.owner),
      label: accessScopeLabel(current, identity),
      description: accessScopeAudience(current, identity),
      owner: current.owner,
    });
  }
  return choices;
}

function people(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

function sessions(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

function teamOf(identity: IdentityAdministrationView | null | undefined, teamId: string) {
  return identity?.teams.find((team) => team.teamId === teamId);
}

/** "Everyone on Builders (3 people)": the count comes from the identity data the page already
 * loads, and no member is named. */
function teamAudience(name: string, memberCount: number): string {
  return `Everyone on ${name} (${memberCount === 0 ? "no members yet" : people(memberCount)})`;
}

/** Who an access level reaches, without its period: a choice's description and the readout's
 * sentence are both built from it. */
function audience(scope: ResourceScope, identity?: IdentityAdministrationView | null): string {
  if (scope.owner.kind === "organization") return "Everyone in your organization";
  if (scope.owner.kind === "user") {
    return scope.owner.userId === identity?.context.userId
      ? "Only you and organization admins"
      : `Only ${privateOwnerName(scope.owner.userId, identity)} and organization admins`;
  }
  const team = teamOf(identity, scope.owner.teamId);
  return team ? teamAudience(team.name, team.memberUserIds.length) : "Everyone on this team";
}

/** A choice's one-line description (§8.4): "Only you and organization admins." */
export function accessScopeAudience(scope: ResourceScope, identity?: IdentityAdministrationView | null): string {
  return `${audience(scope, identity)}.`;
}

/** The saved access as the readout's one sentence: "Everyone in your organization can see and use it." */
export function accessScopeSentence(scope: ResourceScope, identity?: IdentityAdministrationView | null): string {
  const team = scope.owner.kind === "team" ? teamOf(identity, scope.owner.teamId) : undefined;
  if (team && team.memberUserIds.length === 0) {
    return `${team.name} has no members yet, so only organization admins can see and use it.`;
  }
  return `${audience(scope, identity)} can see and use it.`;
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

export type AccessScopeImpact =
  /** Someone loses access: a warning titled by who keeps it. */
  | { kind: "narrowing"; title: string; body: string }
  /** Nobody loses access: one dim sentence. */
  | { kind: "broadening"; text: string }
  /** The server refused the change. `blockedByLocation` is a Project with a Location narrower than
   * the requested access, which changing that Location's access resolves. */
  | { kind: "incompatible"; message: string; blockedByLocation: boolean };

/**
 * The server's refusal in the person's words (§17.2). The preview's reasons are fixed sentences, so
 * each is matched by its opening; a reason this does not know is shown as the server wrote it.
 */
function incompatibleImpact(preview: AccessScopeChangePreview): AccessScopeImpact {
  const reason = preview.reason ?? "";
  const noun = preview.resource === "project" ? "project" : "location";
  if (reason.startsWith("The requested Project access would expose a narrower Location")) {
    return {
      kind: "incompatible",
      message: "A location in this project is more private than this choice. Change that location's access first, or choose a more private option.",
      blockedByLocation: true,
    };
  }
  const message = reason.startsWith("The requested Location access would be broader than its Machine access")
    ? "The machine this location is on isn't shared that widely. Choose a more private option."
    : reason.startsWith("The requested Location access is narrower than an attached Project")
      ? "A project that uses this location is shared more widely than this choice. Change that project's access first, or choose a wider option."
      : /^A session in this (Project|Location) has an incompatible private owner/u.test(reason)
        ? `A session in this ${noun} is private to someone else, so changing the ${noun}'s access can't include it.`
        : reason || "This access change isn't allowed.";
  return { kind: "incompatible", message, blockedByLocation: false };
}

/**
 * What a previewed access change does, worded by who loses or gains access. The counts are the
 * preview's, and a team's size is its member count; no member is named. Once the server allows a
 * change, every session of the resource is inside the new access, so the count is the total.
 */
export function accessScopeImpact(
  preview: AccessScopeChangePreview,
  identity: IdentityAdministrationView,
): AccessScopeImpact {
  if (!preview.compatible) return incompatibleImpact(preview);
  const noun = preview.resource === "project" ? "project" : "location";
  const total = preview.totalSessionCount;
  const active = preview.activeSessionCount;
  const target = preview.targetScope;
  const itsSessions = total > 0 ? ` and its ${sessions(total)}` : "";
  if (target.owner.kind === "organization" ||
      scopeAudienceContainedForIdentity(identity, preview.currentScope, target)) {
    return { kind: "broadening", text: `${audience(target, identity)} will see this ${noun}${itsSessions}.` };
  }
  if (target.owner.kind === "user") {
    return {
      kind: "narrowing",
      title: total > 0
        ? `${total} ${total === 1 ? "Session Becomes" : "Sessions Become"} Private to You`
        : `This ${noun === "project" ? "Project" : "Location"} Becomes Private to You`,
      body: (active > 0 ? `That includes ${active} active ${active === 1 ? "session" : "sessions"}. ` : "") +
        `Others in your organization lose access to this ${noun}${total > 0 ? " and its sessions" : ""}.`,
    };
  }
  const team = teamOf(identity, target.owner.teamId);
  const name = team?.name ?? "This Team";
  const members = team?.memberUserIds.length ?? 0;
  if (members === 0) {
    return {
      kind: "narrowing",
      title: `${name} Has No Members`,
      body: `Only organization admins would keep access to this ${noun}${itsSessions}.`,
    };
  }
  const narrowed = total === 0 ? ""
    : total === 1 ? ` Its one session${active > 0 ? ", which is active," : ""} is narrowed to the team.`
      : ` ${sessions(total)}${active > 0 ? `, ${active} of them active,` : ""} are narrowed to the team.`;
  return {
    kind: "narrowing",
    title: `Only ${name} Keeps Access`,
    body: `${teamAudience(name, members)} keeps access.${narrowed}`,
  };
}
