/**
 * Who settled a question or a governance decision, named relative to the viewer (#2527).
 *
 * In a session several organization members can open, "by you" is only true for the member who
 * answered. A question's resolution records the answering member's user id (protocol 205), and a
 * governance decision carries its human actor's id; the viewer's own id and the organization
 * directory come from `GET /api/identity`. A resolver is "you" only when those ids match,
 * otherwise their display name, never a raw id.
 *
 * Single-member organizations (personal and local installations) keep the "you" wording, even for
 * a record that carries no id. When the viewer, or in a shared organization the resolver, is not
 * known, the wording stays neutral rather than guessing either way.
 */
import { createContext } from "react";
import type { IdentityAdministrationView } from "@wollipog/protocol";

export interface ViewerIdentity {
  userId: string;
  /** More than one member can open this organization's sessions. */
  shared: boolean;
  /** Display names by user id, for the viewer's organization. */
  names: ReadonlyMap<string, string>;
}

/** The viewer, or null until their identity loads (and whenever it cannot). */
export const ViewerIdentityContext = createContext<ViewerIdentity | null>(null);

export function viewerIdentity(identity: IdentityAdministrationView): ViewerIdentity {
  const members = new Set([identity.context.userId]);
  const names = new Map<string, string>();
  for (const membership of identity.memberships) {
    if (membership.organizationId !== identity.context.organizationId) continue;
    members.add(membership.userId);
    const name = membership.userName.trim();
    if (name) names.set(membership.userId, name);
  }
  return { userId: identity.context.userId, shared: members.size > 1, names };
}

export type HumanResolver =
  | { kind: "viewer" }
  | { kind: "member"; name: string }
  | { kind: "other" };

/** The resolver relative to the viewer, or null when the wording must stay neutral. */
export function humanResolver(viewer: ViewerIdentity | null, actorId: string | undefined): HumanResolver | null {
  if (!viewer) return null;
  if (!viewer.shared) return { kind: "viewer" };
  if (!actorId) return null;
  if (actorId === viewer.userId) return { kind: "viewer" };
  const name = viewer.names.get(actorId);
  return name ? { kind: "member", name } : { kind: "other" };
}

/** "you", a display name, or "another member"; Title Case for labels. */
export function resolverName(resolver: HumanResolver, { titleCase = false } = {}): string {
  switch (resolver.kind) {
    case "viewer": return titleCase ? "You" : "you";
    case "member": return resolver.name;
    case "other": return titleCase ? "Another Member" : "another member";
  }
}
