import { PERSONAL_ORGANIZATION_ID, type IdentityContextView } from "@wollipog/protocol";

/** Provider profile routes (#3239) are neither member-scoped nor organization-admin routes, so the
 * control plane confines them to Owners and Admins of its personal organization; an Owner or Admin
 * of any other organization would be refused, so the actions are not offered there. */
export function canManageProviderProfiles(
  context: Pick<IdentityContextView, "organizationId" | "role"> | null | undefined,
): boolean {
  return !!context && (context.role === "owner" || context.role === "admin") &&
    context.organizationId === PERSONAL_ORGANIZATION_ID;
}
