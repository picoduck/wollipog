/**
 * Who settled a question or a governance decision, named relative to the viewer (#2527).
 *
 * In a session several organization members can open, "by you" is only true for the member who
 * answered. The control plane records the resolving member's user id on the governance audit
 * entry; the viewer's own id and the organization directory come from `GET /api/identity`. A
 * resolver is "you" only when those ids match, otherwise their display name, never a raw id.
 *
 * Single-member organizations (personal and local installations) keep the "you" wording without
 * needing the audit record. When the viewer, or the resolver in a shared organization, is not
 * known, the wording stays neutral rather than guessing either way.
 */
import { createContext } from "react";
import type { GovernanceAuditEntry, IdentityAdministrationView } from "@wollipog/protocol";

export interface ViewerIdentity {
  userId: string;
  /** More than one member can open this organization's sessions. */
  shared: boolean;
  /** Display names by user id, for the viewer's organization. */
  names: ReadonlyMap<string, string>;
}

/** A member's answer to a question, from its content-safe governance audit record. */
export interface HumanQuestionAnswer {
  actorId?: string;
}

export interface ResolverDirectory {
  viewer: ViewerIdentity | null;
  /** Human answers by question request id, oldest first. */
  questionAnswers: ReadonlyMap<string, readonly HumanQuestionAnswer[]>;
}

const NO_ANSWERS: ReadonlyMap<string, readonly HumanQuestionAnswer[]> = new Map();

export const NO_RESOLVER_DIRECTORY: ResolverDirectory = { viewer: null, questionAnswers: NO_ANSWERS };

export const ResolverDirectoryContext = createContext<ResolverDirectory>(NO_RESOLVER_DIRECTORY);

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

/** Human question answers in an audit snapshot, grouped by request id. */
export function humanQuestionAnswers(
  entries: readonly GovernanceAuditEntry[],
): ReadonlyMap<string, readonly HumanQuestionAnswer[]> {
  let answers: Map<string, HumanQuestionAnswer[]> | null = null;
  for (const entry of entries) {
    if (entry.approvalKind !== "question" || entry.stage !== "resolution" ||
        entry.outcome !== "answered" || entry.actor.kind !== "human") continue;
    answers ??= new Map();
    const list = answers.get(entry.requestId) ?? [];
    list.push(entry.actor.id ? { actorId: entry.actor.id } : {});
    answers.set(entry.requestId, list);
  }
  return answers ?? NO_ANSWERS;
}

/**
 * The member who answered a request. A request id can be reused, and the audit carries no
 * occurrence id; its control-plane timestamps cannot be matched against the runner's either, since
 * the two clocks may disagree. So a reused id names its member only when every recorded answer
 * came from the same one; otherwise the row stays neutral rather than risk naming the wrong one.
 */
export function questionAnswerActorId(directory: ResolverDirectory, requestId: string): string | undefined {
  const answers = directory.questionAnswers.get(requestId);
  const actorId = answers?.[0]?.actorId;
  return actorId && answers!.every((answer) => answer.actorId === actorId) ? actorId : undefined;
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
