import type { PendingApproval, SessionAttentionKind } from "@wollipog/protocol";
import { prioritizedPendingRequests } from "@wollipog/protocol";
import { statusMeta, statusValues, type StatusMeta } from "./status-meta.js";
import { requestAttentionKind } from "./worker-roster.js";

/**
 * Who in a session needs the person (#2861): the session itself, for its own requests, or one worker,
 * with the most urgent request each holds. The Agents panel's attention notice counts these, and the
 * Session Tools list's Agents badge counts the same kinds, so the two never disagree on a count.
 */
export type AttentionAsker = {
  /** The owning worker's id (a subagent's tool-call id, a member's row id), or null for the session's
   * own requests. */
  ownerId: string | null;
  /** The worker's name, when the panel can name it. */
  name?: string;
  kind: SessionAttentionKind;
} & (
  /** A request this session holds: its most urgent, in the request dock's priority order. */
  | { request: PendingApproval; sessionId?: never }
  /** A pod, run or workflow member session waiting on the person, answered in that session. */
  | { sessionId: string; request?: never }
);

/**
 * The askers behind a session's pending requests, most urgent first: the first asker's request is
 * the one the request dock's priority rule puts on top. A request preserved across a runner restart
 * is the session's to recover, whoever asked it.
 */
export function attentionAskers(
  pendingApproval: PendingApproval | null | undefined,
  nameOf: (ownerId: string, request: PendingApproval) => string | undefined,
): AttentionAsker[] {
  const askers = new Map<string, AttentionAsker>();
  for (const request of prioritizedPendingRequests(pendingApproval)) {
    const ownerId = request.ownerToolUseId && !request.recoveryReason ? request.ownerToolUseId : null;
    const key = ownerId ?? "";
    if (askers.has(key)) continue;
    const name = ownerId ? nameOf(ownerId, request) : undefined;
    askers.set(key, { ownerId, ...(name ? { name } : {}), kind: requestAttentionKind(request), request });
  }
  return [...askers.values()];
}

const KIND_ORDER: readonly SessionAttentionKind[] = ["recovery_required", "authentication_required", "answer_required",
  "approval_required", "review_requested", "input_required"];

/** Each kind with how many ask it: the most first, then the most urgent kind. */
export function attentionKindCounts(kinds: readonly SessionAttentionKind[]): { kind: SessionAttentionKind; count: number }[] {
  const counts = new Map<SessionAttentionKind, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

/** What one asker, or several, wait for: "is waiting for your approval.", "have a question for you." */
const WAITS_FOR: Record<SessionAttentionKind, { one: string; many: string }> = {
  approval_required: { one: "is waiting for your approval.", many: "are waiting for your approval." },
  answer_required: { one: "has a question for you.", many: "have a question for you." },
  authentication_required: { one: "needs you to sign in.", many: "need you to sign in." },
  recovery_required: { one: "needs you to recover it.", many: "need you to recover them." },
  review_requested: { one: "is waiting for your review.", many: "are waiting for your review." },
  input_required: { one: "is waiting for your input.", many: "are waiting for your input." },
};

/** A kind counted in a mixed sentence: "2 approvals", "1 answer". */
const KIND_NOUNS: Record<SessionAttentionKind, [string, string]> = {
  approval_required: ["approval", "approvals"],
  answer_required: ["answer", "answers"],
  authentication_required: ["sign-in", "sign-ins"],
  recovery_required: ["recovery", "recoveries"],
  review_requested: ["review", "reviews"],
  input_required: ["other request", "other requests"],
};

const workers = (count: number) => `${count} ${count === 1 ? "worker" : "workers"}`;

/**
 * The attention notice's one sentence, counting by kind with the request card's words (#2861):
 * "Audit Storage has a question for you.", "2 workers are waiting for your approval.",
 * "3 workers need you: 2 approvals, 1 answer." The session's own requests make it "The session".
 */
export function attentionSentence(askers: readonly AttentionAsker[]): string {
  const session = askers.some((asker) => asker.ownerId === null);
  const workerCount = askers.filter((asker) => asker.ownerId !== null).length;
  const one = askers.length === 1;
  const subject = one
    ? session ? "The session" : askers[0]!.name ?? "A subagent"
    : session ? `The session and ${workers(workerCount)}` : workers(workerCount);
  const kinds = attentionKindCounts(askers.map((asker) => asker.kind));
  if (kinds.length === 1) return `${subject} ${one ? WAITS_FOR[kinds[0]!.kind].one : WAITS_FOR[kinds[0]!.kind].many}`;
  const counted = kinds.map(({ kind, count }) => `${count} ${KIND_NOUNS[kind][count === 1 ? 0 : 1]}`).join(", ");
  return `${subject} need you: ${counted}.`;
}

/**
 * The attention notice while the runner is offline (#2861): the count stays (§12.5), with the reason
 * no request can be answered now in place of Review in Session (§13.2). "2 requests are waiting. You
 * can answer them when Build Box reconnects."
 */
export function offlineAttentionSentence(requests: number, machine: string): string {
  return requests === 1
    ? `1 request is waiting. You can answer it when ${machine} reconnects.`
    : `${requests} requests are waiting. You can answer them when ${machine} reconnects.`;
}

/** The attention notice's line in "+N More", Title Case: "Audit Storage Needs You", "3 Workers Need You". */
export function attentionTitle(askers: readonly AttentionAsker[]): string {
  const session = askers.some((asker) => asker.ownerId === null);
  const workerCount = askers.filter((asker) => asker.ownerId !== null).length;
  if (askers.length === 1) return session ? "The Session Needs You" : `${askers[0]!.name ?? "A Subagent"} Needs You`;
  const counted = `${workerCount} ${workerCount === 1 ? "Worker" : "Workers"}`;
  return session ? `The Session and ${counted} Need You` : `${counted} Need You`;
}

const ATTENTION_KINDS: ReadonlySet<string> = new Set(statusValues("attention"));
const attentionMeta = (kind: SessionAttentionKind) =>
  statusMeta("attention", ATTENTION_KINDS.has(kind) ? kind : "input_required");

/**
 * One badge for several workers that need the person, counting every kind: one kind keeps its word
 * ("2 Approval Required"), mixed kinds read "3 Awaiting Input" (§11.2's rollup word), danger when
 * any of them is Recovery Required. `description` names each kind, for the badge's tooltip and name.
 * Offline it keeps the count but no tone that asks for an action: neutral with a hollow dot, the
 * mark of a state whose source is offline (§11.2).
 */
export function attentionBadge(kinds: readonly SessionAttentionKind[], online = true): { meta: StatusMeta; label: string; description: string } | null {
  if (kinds.length === 0) return null;
  const counts = attentionKindCounts(kinds);
  const description = counts.map(({ kind, count }) => `${count} ${attentionMeta(kind).label}`).join(", ");
  const meta: StatusMeta = counts.length === 1 ? attentionMeta(counts[0]!.kind) : {
    label: statusMeta("session", "input_required").label, pulse: false,
    tone: counts.some(({ kind }) => attentionMeta(kind).tone === "danger") ? "danger" : "warning",
  };
  return { meta: online ? meta : { ...meta, tone: "neutral", hollow: true }, label: `${kinds.length} ${meta.label}`, description };
}
