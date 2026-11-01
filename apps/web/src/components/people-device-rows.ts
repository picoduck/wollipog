import type {
  DeviceView,
  IdentityAdministrationView,
  OrganizationMembershipView,
} from "@wollipog/protocol";

type IdentityContext = IdentityAdministrationView["context"];

/** Owners and admins manage people, teams and devices; operators and viewers see the lists only. */
export function canAdminister(context: Pick<IdentityContext, "role">): boolean {
  return context.role === "owner" || context.role === "admin";
}

/** Whether a People row is the signed-in person's own: it says "You" and is never managed from the
 * list (#2997). Renaming yourself from this row builds on it (#3001). */
export function isOwnRow(
  member: Pick<OrganizationMembershipView, "userId">,
  context: Pick<IdentityContext, "userId">,
): boolean {
  return member.userId === context.userId;
}

/**
 * What a People row's trailing slot holds, so no row ever shows a disabled Manage button (#2997):
 * - `you`: your own row, which says "You" instead;
 * - `owner-locked`: an owner's row seen by an admin, which says "Only owners can change an owner";
 * - `manage`: Manage…, and the row opens Manage Person;
 * - `none`: operators and viewers manage no one, so the row opens nothing.
 */
export type PersonRowAction = "you" | "owner-locked" | "manage" | "none";

export function personRowAction(
  member: Pick<OrganizationMembershipView, "userId" | "role">,
  context: Pick<IdentityContext, "userId" | "role">,
): PersonRowAction {
  if (isOwnRow(member, context)) return "you";
  if (!canAdminister(context)) return "none";
  if (member.role === "owner" && context.role !== "owner") return "owner-locked";
  return "manage";
}

export const OWNER_LOCKED_REASON = "Only owners can change an owner";

/** A person's device count for line 2 of their row, from the devices already loaded. */
export function deviceCountLabel(count: number): string {
  return count === 0 ? "No devices" : count === 1 ? "1 device" : `${count} devices`;
}

/** The Revoke Device confirmation's sentence, the same from a row and from Device Details. */
export function revokeDeviceMessage(deviceName: string, personName: string): string {
  return `“${deviceName}” stops working for ${personName} right away. To use it again, pair it again.`;
}

/** Devices per person, for the People rows' device counts. */
export function devicesByPerson(devices: readonly DeviceView[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const device of devices) counts.set(device.userId, (counts.get(device.userId) ?? 0) + 1);
  return counts;
}
