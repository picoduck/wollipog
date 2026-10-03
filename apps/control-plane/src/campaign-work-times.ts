/**
 * Work-item time metrics (docs/campaign-work-ledger.md, "Time Metrics"). Pure: no clock, no
 * database. The accounting store loads the durable intervals; this replays them through the same
 * derivation that produces the primary state, so Queue, Waiting, and Active Time count exactly the
 * spans in which the item was `queued`, `waiting` or `blocked`, and `running`.
 *
 * A span the intervals do not cover (before recording began) has no state. It is a history gap,
 * never zero.
 */
import type {
  CampaignMetric,
  CampaignWorkItemCommitmentState,
  CampaignWorkItemDispatchState,
  CampaignWorkItemPrimaryState,
  SessionStatus,
} from "@wollipog/protocol";
import { deriveCampaignWorkItemState, type CampaignDependencyState } from "./campaign-work-state.js";

/** A recorded change of the item's dispatch state, commitment, or recorded blocker. */
export interface CampaignItemTransition {
  at: number;
  dispatchState: CampaignWorkItemDispatchState;
  commitment: CampaignWorkItemCommitmentState;
  blocked: boolean;
}

/** A recorded status of an attempt's session while the attempt was open. `status: null` means the
 * session was deleted. */
export interface CampaignAttemptStatusTransition {
  at: number;
  status: SessionStatus | null;
  archived: boolean;
}

export interface CampaignAttemptTimeline {
  ordinal: number;
  startedAt: number;
  endedAt: number | null;
  /** When a `delivered` verification of this attempt was recorded, if one was. */
  deliveredAt: number | null;
  /** In recording order. */
  statuses: readonly CampaignAttemptStatusTransition[];
}

export interface CampaignItemTimelineInput {
  id: string;
  createdAt: number;
  /** In recording order. */
  transitions: readonly CampaignItemTransition[];
  attempts: readonly CampaignAttemptTimeline[];
  dependsOn: readonly string[];
}

/** The item's state from `from` until the next segment. `null` is a span with no recorded history. */
export interface CampaignItemStateSegment {
  from: number;
  state: CampaignWorkItemPrimaryState | null;
}

export interface CampaignItemDurations {
  queue: CampaignMetric<number>;
  waiting: CampaignMetric<number>;
  active: CampaignMetric<number>;
}

/** The latest entry at or before `at`. Entries are in recording order, so a later entry recorded
 * in the same millisecond wins. */
function latestAt<T extends { at: number }>(entries: readonly T[], at: number): T | undefined {
  let found: T | undefined;
  for (const entry of entries) if (entry.at <= at) found = entry;
  return found;
}

function stateAt(segments: readonly CampaignItemStateSegment[], at: number): CampaignWorkItemPrimaryState | null {
  let found: CampaignWorkItemPrimaryState | null = null;
  for (const segment of segments) {
    if (segment.from > at) break;
    found = segment.state;
  }
  return found;
}

/** The item's state at one instant, or null when its record at that instant was not recorded. */
function itemStateAt(
  item: CampaignItemTimelineInput,
  at: number,
  dependencyStates: readonly CampaignDependencyState[],
): CampaignWorkItemPrimaryState | null {
  const record = latestAt(item.transitions, at);
  if (!record) return null;
  let latest: CampaignAttemptTimeline | undefined;
  for (const attempt of item.attempts) {
    if (attempt.startedAt <= at && (!latest || attempt.ordinal > latest.ordinal)) latest = attempt;
  }
  const open = latest !== undefined && (latest.endedAt === null || latest.endedAt > at);
  const status = open ? latestAt(latest!.statuses, at) : undefined;
  // An attempt opened before recording began has no observed status until its first transition.
  if (open && !status) return null;
  return deriveCampaignWorkItemState({
    id: item.id,
    commitment: record.commitment,
    dispatchState: record.dispatchState,
    hasBlocker: record.blocked,
    dependsOn: item.dependsOn,
    latestAttempt: latest ? {
      open,
      delivered: latest.deliveredAt !== null && latest.deliveredAt <= at,
    } : null,
    // Holds and pending decisions are not part of the recorded intervals. Both only distinguish
    // `waiting` from `blocked`, which Waiting Time counts together.
    openAttemptSession: status?.status ? { status: status.status, archived: status.archived, held: false, pendingRequests: 0 } : null,
  }, dependencyStates).state;
}

/**
 * Every item's state timeline. Dependencies use the current edges; a missing dependency or a cycle
 * is unresolvable, as in the primary-state derivation. A dependency without recorded history at
 * an instant counts as unfinished, never as blocking.
 */
export function campaignItemTimelines(
  items: readonly CampaignItemTimelineInput[],
): Map<string, CampaignItemStateSegment[]> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const timelines = new Map<string, CampaignItemStateSegment[]>();
  const visiting = new Set<string>();
  const resolve = (id: string): CampaignItemStateSegment[] | "unresolvable" => {
    const done = timelines.get(id);
    if (done) return done;
    const item = byId.get(id);
    if (!item || visiting.has(id)) return "unresolvable";
    visiting.add(id);
    const dependencies = item.dependsOn.map(resolve);
    visiting.delete(id);
    const points = new Set<number>([item.createdAt]);
    for (const transition of item.transitions) points.add(transition.at);
    for (const attempt of item.attempts) {
      points.add(attempt.startedAt);
      if (attempt.endedAt !== null) points.add(attempt.endedAt);
      if (attempt.deliveredAt !== null) points.add(attempt.deliveredAt);
      for (const status of attempt.statuses) points.add(status.at);
    }
    for (const dependency of dependencies) {
      if (dependency !== "unresolvable") for (const segment of dependency) points.add(segment.from);
    }
    const segments: CampaignItemStateSegment[] = [];
    for (const at of [...points].filter((point) => point >= item.createdAt).sort((a, b) => a - b)) {
      const state = itemStateAt(item, at, dependencies.map((dependency) =>
        dependency === "unresolvable" ? "unresolvable" : stateAt(dependency, at) ?? "planned"));
      if (segments.at(-1)?.state !== state || segments.length === 0) segments.push({ from: at, state });
    }
    timelines.set(id, segments);
    return segments;
  };
  for (const item of items) resolve(item.id);
  return timelines;
}

const FINISHED: ReadonlySet<CampaignWorkItemPrimaryState> = new Set(["delivered", "cancelled", "removed"]);

/** Queue, Waiting, and Active Time over a timeline, measured to `asOf`. */
export function campaignItemDurations(
  segments: readonly CampaignItemStateSegment[],
  attemptCount: number,
  asOf: number,
): CampaignItemDurations {
  let queue = 0, waiting = 0, active = 0, gap = 0, unfinishedKnown = 0;
  segments.forEach((segment, index) => {
    const until = Math.min(segments[index + 1]?.from ?? asOf, asOf);
    const span = Math.max(0, until - segment.from);
    if (segment.state === null) gap += span;
    else if (!FINISHED.has(segment.state)) unfinishedKnown += span;
    if (segment.state === "queued") queue += span;
    else if (segment.state === "waiting" || segment.state === "blocked") waiting += span;
    else if (segment.state === "running") active += span;
  });
  const metric = (value: number): CampaignMetric<number> => gap === 0 ? { availability: "known", value }
    // Some of the item's life predates recording. With no recorded unfinished span at all (it
    // finished before recording began), nothing is known about these durations.
    : unfinishedKnown > 0 ? { availability: "partial", value, reason: "history_unavailable" }
    : { availability: "unavailable", reason: "history_unavailable" };
  return {
    queue: metric(queue),
    waiting: metric(waiting),
    active: attemptCount === 0 && gap === 0 ? { availability: "unavailable", reason: "not_started" } : metric(active),
  };
}
