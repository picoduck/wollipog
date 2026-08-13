import type { ResourceScope } from "@wollipog/protocol";

/** Every principal who can see the narrower scope must also be able to see the wider scope. */
export function scopeAudienceContained(narrower: ResourceScope, wider: ResourceScope): boolean {
  if (narrower.organizationId !== wider.organizationId) return false;
  if (wider.owner.kind === "organization") return true;
  if (narrower.owner.kind !== wider.owner.kind) return false;
  if (narrower.owner.kind === "user" && wider.owner.kind === "user") {
    return narrower.owner.userId === wider.owner.userId;
  }
  return narrower.owner.kind === "team" && wider.owner.kind === "team" &&
    narrower.owner.teamId === wider.owner.teamId;
}
