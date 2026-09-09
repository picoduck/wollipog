/**
 * Governance decisions as transcript context.
 *
 * The control plane records an intentionally content-safe audit log: it carries actors, policy
 * ids, stages, and outcomes, but never tool input, question answers, or credentials. Everything
 * here reads only those safe fields, so both the transcript annotation and the consolidated
 * side-panel history preserve that boundary.
 *
 * Placement contract: `requestId` is the only join key between an audit entry and a transcript
 * row. Resolved permissions and questions already render their own outcome in place, so those
 * entries are left alone (annotating them again would duplicate the outcome). Policy-hook
 * decisions have no transcript event at all — the runner polls the hook and the approval lives
 * only on the live approval card — so they are materialized as their own compact chronological
 * row, anchored to the last loaded event at or before the decision's timestamp.
 */
import type { GovernanceAuditEntry } from "@wollipog/protocol";
import { isCollapsibleWorkItem, type TimelineItem } from "./timeline.js";

export type GovernanceOutcomeTone = "allowed" | "denied" | "timed-out" | "policy";

export interface GovernanceOutcome {
  label: string;
  detail: string;
  tone: GovernanceOutcomeTone;
}

/** A single user-visible governance outcome, reduced to content-safe display fields. */
export interface GovernanceDecision extends GovernanceOutcome {
  auditId: string;
  requestId: string;
  /** Content-safe actor description, e.g. "You · device-1". */
  decidedBy: string;
  policyId?: string;
  timestamp: number;
}

/** How many audit records the session view pulls. The endpoint is an unpaginated newest-N
 * snapshot (max 500), so this is the whole governance history the client ever sees. */
export const GOVERNANCE_AUDIT_LIMIT = 200;

export function governanceAuditPresentation(entry: GovernanceAuditEntry): GovernanceOutcome | null {
  if (entry.approvalKind === "question" && entry.actor.kind === "policy" && entry.outcome === "answered") {
    return { label: "Answered by Policy", detail: `Question answered by policy ${entry.governancePolicyId ?? entry.actor.id}.`, tone: "allowed" };
  }
  if (entry.approvalKind !== "policy_hook") return null;
  if (entry.stage === "policy_decision" && entry.outcome === "denied") {
    return { label: "Blocked by Policy", detail: "The matched policy denied this tool.", tone: "policy" };
  }
  if (entry.stage !== "resolution") return null;
  if (entry.outcome === "timed_out") {
    return { label: "Approval Timed Out", detail: "The policy deadline expired, so the tool was denied.", tone: "timed-out" };
  }
  if (entry.actor.kind === "human" && entry.outcome === "allowed") {
    return { label: "Approved by You", detail: "The suspended tool invocation resumed.", tone: "allowed" };
  }
  if (entry.actor.kind === "human" && entry.outcome === "denied") {
    return { label: "Denied by You", detail: "The suspended tool invocation was blocked.", tone: "denied" };
  }
  return null;
}

const ACTOR_LABELS: Record<string, string> = {
  human: "You",
  policy: "Policy",
  agent: "Agent",
  system: "System",
};

function decidedByLabel(actor: GovernanceAuditEntry["actor"]): string {
  const kind = ACTOR_LABELS[actor.kind] ?? actor.kind;
  return actor.id ? `${kind} · ${actor.id}` : kind;
}

/**
 * Project the audit snapshot into oldest-first display decisions.
 *
 * Deduplicated on `auditId` and totally ordered on (timestamp, auditId) so a refetch of the
 * newest-N snapshot can never reorder or duplicate an outcome that is already on screen.
 */
export function governanceDecisions(entries: readonly GovernanceAuditEntry[]): GovernanceDecision[] {
  const seen = new Set<string>();
  const decisions: GovernanceDecision[] = [];
  for (const entry of entries) {
    const outcome = governanceAuditPresentation(entry);
    if (!outcome || seen.has(entry.auditId)) continue;
    seen.add(entry.auditId);
    decisions.push({
      ...outcome,
      auditId: entry.auditId,
      requestId: entry.requestId,
      decidedBy: decidedByLabel(entry.actor),
      ...(entry.governancePolicyId ? { policyId: entry.governancePolicyId } : {}),
      timestamp: entry.timestamp,
    });
  }
  return decisions.sort((a, b) => a.timestamp - b.timestamp || (a.auditId < b.auditId ? -1 : 1));
}

/** Audit ids are append-only records, so the id list identifies the snapshot's content. */
export function sameGovernanceSnapshot(
  a: readonly GovernanceAuditEntry[],
  b: readonly GovernanceAuditEntry[],
): boolean {
  return a.length === b.length && a.every((entry, index) => entry.auditId === b[index]!.auditId);
}

/**
 * Decisions that need their own transcript row: the ones whose request has no timeline row of
 * its own. A resolved permission or question row already states its outcome in place.
 */
export function transcriptGovernanceDecisions(
  decisions: readonly GovernanceDecision[],
  items: readonly TimelineItem[],
): GovernanceDecision[] {
  const represented = new Set<string>();
  for (const item of items) {
    if (item.kind === "permission" || item.kind === "question") represented.add(item.requestId);
  }
  return decisions.filter((decision) => !represented.has(decision.requestId));
}

export interface GovernanceAnchorEvent {
  seq: number;
  ts: number;
}

/**
 * Suffix minimum of event timestamps, in sequence order.
 *
 * Events are ordered by sequence, and their timestamps are NOT required to be non-decreasing:
 * hydrated runner pages validate contiguous `seq` and a non-negative `ts` and nothing more, so a
 * recovered history can legitimately step backwards in time. Binary-searching raw timestamps
 * would then anchor a decision to whichever slots the probes happened to hit. The suffix minimum
 * is non-decreasing by construction, and the last index whose suffix minimum is at or before a
 * timestamp is exactly the last event at or before it: that event qualifies and every later one
 * is strictly newer. On a well-behaved history it equals the raw timestamps.
 */
function suffixMinTimestamps(events: readonly GovernanceAnchorEvent[]): number[] {
  const suffix: number[] = new Array(events.length);
  let min = Number.POSITIVE_INFINITY;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    min = Math.min(min, events[index]!.ts);
    suffix[index] = min;
  }
  return suffix;
}

function anchorSeqFrom(
  events: readonly GovernanceAnchorEvent[],
  suffixMin: readonly number[],
  timestamp: number,
): number {
  let low = 0;
  let high = events.length - 1;
  let anchor = Number.NEGATIVE_INFINITY;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (suffixMin[mid]! <= timestamp) {
      anchor = events[mid]!.seq;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return anchor;
}

/**
 * Sequence of the last loaded event at or before `timestamp`.
 *
 * -Infinity means the decision predates the loaded window: it pins to the head of the window
 * (directly under the "earlier activity" control) rather than being dropped, so paging older
 * activity moves it into place without ever omitting it.
 */
export function governanceAnchorSeq(events: readonly GovernanceAnchorEvent[], timestamp: number): number {
  return anchorSeqFrom(events, suffixMinTimestamps(events), timestamp);
}

/**
 * Synthetic ids for governance rows, kept negative so they can never collide with an event
 * sequence in the reveal index, and stable per audit id so a row keeps its virtual-list identity
 * (and its open disclosure) across refetches.
 */
const governanceItemIds = new Map<string, number>();
let nextGovernanceItemId = -1;
const MAX_TRACKED_GOVERNANCE_ITEM_IDS = 4096;

export function governanceItemId(auditId: string): number {
  const existing = governanceItemIds.get(auditId);
  if (existing !== undefined) return existing;
  if (governanceItemIds.size >= MAX_TRACKED_GOVERNANCE_ITEM_IDS) governanceItemIds.clear();
  const id = nextGovernanceItemId--;
  governanceItemIds.set(auditId, id);
  return id;
}

/**
 * One timeline item per decision object, reused across merges.
 *
 * The row projector's incremental paths compare item identity slot by slot. Allocating a fresh
 * wrapper on every merge would mark every governance slot dirty on every streamed chunk, which
 * pushes the projector off its append/settle fast paths and back to re-projecting the whole
 * transcript — so a session would lose incremental rendering permanently after its first
 * governance outcome. Decision objects are themselves stable while the audit snapshot is
 * unchanged, so keying on them keeps unchanged rows identical.
 */
const governanceItems = new WeakMap<GovernanceDecision, TimelineItem>();

function governanceItem(decision: GovernanceDecision): TimelineItem {
  const cached = governanceItems.get(decision);
  if (cached) return cached;
  const item: TimelineItem = {
    kind: "governance_decision",
    id: governanceItemId(decision.auditId),
    decision,
  };
  governanceItems.set(decision, item);
  return item;
}

/**
 * Anchor of every governance row in a merged timeline: the sequence of the row's predecessor
 * (or -Infinity at the window head). Callers freeze these for rows that have rendered.
 */
export function landedGovernanceAnchors(merged: readonly TimelineItem[]): Map<string, number> {
  const anchors = new Map<string, number>();
  let previousSeq = Number.NEGATIVE_INFINITY;
  for (const item of merged) {
    if (item.kind === "governance_decision") anchors.set(item.decision.auditId, previousSeq);
    else previousSeq = item.id;
  }
  return anchors;
}

/**
 * Splice governance rows into a derived timeline at their chronological positions.
 *
 * Returns the input array unchanged (same identity) when there is nothing to add, so sessions
 * without governance activity keep the incremental row projector's fast path.
 */
export interface MergeGovernanceOptions {
  /**
   * The transcript ends in a work run that is still growing (the turn is running). Decisions that
   * belong inside or after that run are held back until a standalone row closes it: emitting
   * them now would put the row at the tail, and every streamed work item would then be inserted
   * in front of it instead of appended, which throws the row projector off its append fast path
   * for the rest of the turn. Once the turn settles the held decisions flush in one projection.
   */
  holdTrailingRun?: boolean;
  /**
   * Anchors of decisions that have already rendered, by audit id. A landed row is never held and
   * never moves: the status flips to running before the next turn's first event arrives, so
   * holding it again would make it vanish until a standalone event came in; and a later event
   * carrying an earlier timestamp (a recovered history, clocks that disagree between the runner
   * and the control plane) would otherwise re-anchor the row to the tail, where every streamed
   * work item is an insertion in front of it. A row pinned to the window head (-Infinity) is the
   * exception: it stays live so paging older activity can move it into place.
   */
  landed?: ReadonlyMap<string, number>;
}

export function mergeGovernanceDecisions(
  items: TimelineItem[],
  decisions: readonly GovernanceDecision[],
  events: readonly GovernanceAnchorEvent[],
  { holdTrailingRun = false, landed }: MergeGovernanceOptions = {},
): TimelineItem[] {
  if (!decisions.length) return items;
  const suffixMin = suffixMinTimestamps(events);
  const anchorOf = (decision: GovernanceDecision): number => {
    const frozen = landed?.get(decision.auditId);
    if (frozen !== undefined && Number.isFinite(frozen)) return frozen;
    return anchorSeqFrom(events, suffixMin, decision.timestamp);
  };
  const anchored = decisions
    .map((decision) => ({ decision, anchorSeq: anchorOf(decision) }))
    .sort((a, b) =>
      a.anchorSeq - b.anchorSeq ||
      a.decision.timestamp - b.decision.timestamp ||
      (a.decision.auditId < b.decision.auditId ? -1 : 1));

  const merged: TimelineItem[] = [];
  let next = 0;
  const flushBefore = (id: number) => {
    while (next < anchored.length && anchored[next]!.anchorSeq < id) {
      merged.push(governanceItem(anchored[next++]!.decision));
    }
  };
  for (const item of items) {
    // Only ever land immediately before a standalone row. A governance row placed inside a run of
    // collapsible work items would split the "Worked" block in two, and only the first fragment
    // keeps the original disclosure key — so an open block would silently collapse its tail when
    // the audit fetch settled. Placed immediately before a run it would instead become that
    // block's boundary and change its key. Deferring to the next standalone row leaves every work
    // group's identity untouched, at the cost of resolving position to the enclosing block rather
    // than to an individual tool call.
    if (!isCollapsibleWorkItem(item)) flushBefore(item.id);
    merged.push(item);
  }
  const trailingRunOpen = holdTrailingRun && items.length > 0 && isCollapsibleWorkItem(items[items.length - 1]!);
  if (!trailingRunOpen) {
    flushBefore(Number.POSITIVE_INFINITY);
  } else if (landed) {
    for (; next < anchored.length; next += 1) {
      const { decision } = anchored[next]!;
      if (landed.has(decision.auditId)) merged.push(governanceItem(decision));
    }
  }
  // Nothing landed: hand back the same array so the caller's identity checks keep the fast path.
  return merged.length === items.length ? items : merged;
}
