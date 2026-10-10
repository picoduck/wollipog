import type { BackgroundDeliveryView, ManagedBackgroundJobEnd, ManagedBackgroundJobView } from "@wollipog/protocol";
import type { BackgroundJobCurrentState } from "./background-job-stop.js";
import { formatClock, formatRecordedRelativeTime } from "./format.js";
import { statusMeta, type StatusMeta } from "./status-meta.js";

/**
 * Background Work's words and grouping (#2858): jobs grouped by the turn that started them, each
 * group's one status, and the sentences its rows and the Job Detail page read. The panel and the
 * Agents tab's job page share them, so a job reads the same wherever it opens.
 */

/** Where a job's parent turn is in the loaded transcript. */
export interface BackgroundParentTurn {
  /** The prompt that opened the turn, which View Turn scrolls to. */
  eventId: number;
  /** The transcript's own turn number, the one its footer shows; absent where none was recorded. */
  turn?: number;
  /** When the prompt was sent, which names a turn without a number. */
  startedAt?: number;
}

/** The runner's sentinel for a job it could not tie to a turn. */
export const UNKNOWN_PARENT_TURN = "unknown";

/**
 * A turn's name: "Turn 4" as the transcript numbers it, "Turn at 2:14 PM" where it has no number,
 * "Earlier Turn" while it is outside the loaded transcript, and "Unknown Turn" where the runner
 * could not name it. Never a position in the list.
 */
export function backgroundTurnLabel(parentTurnId: string, turn: BackgroundParentTurn | undefined): string {
  if (parentTurnId === UNKNOWN_PARENT_TURN) return "Unknown Turn";
  if (!turn) return "Earlier Turn";
  if (turn.turn !== undefined) return `Turn ${turn.turn}`;
  const clock = formatClock(turn.startedAt);
  return clock ? `Turn at ${clock}` : "Earlier Turn";
}

export interface BackgroundJobGroup {
  key: string;
  parentTurnId: string;
  parentTurnKnown: boolean;
  /** Oldest first. */
  jobs: ManagedBackgroundJobView[];
  deliveries: BackgroundDeliveryView[];
}

/** The latest receipt time a delivery records, which orders delivery-only groups and dates a receipt. */
export function deliveryTimestamp(delivery: BackgroundDeliveryView): number {
  return Math.max(
    delivery.queuedAt ?? 0,
    delivery.submittedAt ?? 0,
    delivery.acceptedAt ?? 0,
    delivery.missingResultAt ?? 0,
    delivery.missingResultAcknowledgedAt ?? 0,
    delivery.runnerResultPersistedAt ?? 0,
    delivery.transcriptProjectedAt ?? 0,
    delivery.notificationQueuedAt ?? 0,
    delivery.dashboardObservedAt ?? 0,
    delivery.statusSettledAt ?? 0,
    ...(delivery.notifications ?? []).flatMap((receipt) => [
      receipt.serviceAcceptedAt ?? 0,
      receipt.shownAt ?? 0,
      receipt.clickedAt ?? 0,
    ]),
  );
}

/** Jobs and delivery receipts grouped by the turn that started them, the most recent turn first. */
export function groupBackgroundHistory(
  jobs: readonly ManagedBackgroundJobView[],
  deliveries: readonly BackgroundDeliveryView[],
): BackgroundJobGroup[] {
  const groups = new Map<string, BackgroundJobGroup>();
  for (const job of jobs) {
    // `unknown` is a runner sentinel, not a shared turn. Keep those jobs separate so unrelated
    // discoveries can never be presented as one fabricated turn.
    const parentTurnKnown = job.parentTurnId !== UNKNOWN_PARENT_TURN;
    const key = parentTurnKnown ? job.parentTurnId : `unknown:${job.id}`;
    const group = groups.get(key) ?? { key, parentTurnId: job.parentTurnId, parentTurnKnown, jobs: [], deliveries: [] };
    group.jobs.push(job);
    groups.set(key, group);
  }
  deliveries.forEach((delivery, index) => {
    const parentTurnKnown = delivery.parentTurnId !== UNKNOWN_PARENT_TURN;
    const key = parentTurnKnown ? delivery.parentTurnId : `delivery:unknown:${index}`;
    const group = groups.get(key) ?? { key, parentTurnId: delivery.parentTurnId, parentTurnKnown, jobs: [], deliveries: [] };
    group.deliveries.push(delivery);
    groups.set(key, group);
  });
  const latest = (group: BackgroundJobGroup) => Math.max(
    0,
    ...group.jobs.map((job) => job.registeredAt),
    ...group.deliveries.map(deliveryTimestamp),
  );
  return [...groups.values()]
    .map((group) => ({
      ...group,
      jobs: group.jobs.sort((left, right) => left.registeredAt - right.registeredAt || left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => latest(right) - latest(left));
}

/** A group's one status, on the `jobGroup` vocabulary. */
export type BackgroundJobGroupStatus =
  | { key: "waiting"; unfinished: number }
  | { key: "finished"; finished: number; total: number }
  | { key: "returning" | "returned" | "result_missing" | "missing_acknowledged" | "unverified" };

/** The group status's badge, with its count in the label where it has one. */
export function backgroundJobGroupBadge(status: BackgroundJobGroupStatus): StatusMeta {
  const meta = statusMeta("jobGroup", status.key);
  if (status.key === "waiting") {
    return { ...meta, label: status.unfinished === 1 ? "Waiting for 1 Job" : `Waiting for ${status.unfinished} Jobs` };
  }
  if (status.key === "finished") return { ...meta, label: `${status.finished} of ${status.total} Finished` };
  return meta;
}

/** Where one or more delivery receipts stand, for a group or a receipt with no listed jobs. */
export function deliveryReceiptStatus(
  deliveries: readonly BackgroundDeliveryView[],
  acknowledged: (delivery: BackgroundDeliveryView) => boolean = () => false,
): BackgroundJobGroupStatus {
  if (deliveries.some((delivery) => delivery.runnerResultPersistedAt != null)) return { key: "returned" };
  if (deliveries.some((delivery) => delivery.missingResultAt != null &&
      delivery.missingResultAcknowledgedAt == null && !acknowledged(delivery))) return { key: "result_missing" };
  if (deliveries.some((delivery) => delivery.missingResultAcknowledgedAt != null || acknowledged(delivery))) {
    return { key: "missing_acknowledged" };
  }
  if (deliveries.some((delivery) => delivery.queuedAt != null || delivery.submittedAt != null ||
      delivery.acceptedAt != null)) return { key: "returning" };
  return { key: "unverified" };
}

/** A group's job counts: the larger of what is listed and what its delivery receipts recorded. */
export function backgroundJobGroupCounts(group: BackgroundJobGroup, inventoryTruncated: boolean) {
  const recordedJobCount = group.deliveries.reduce((total, delivery) => total + delivery.jobCount, 0);
  const recordedFinishedCount = group.deliveries.reduce((total, delivery) => total + delivery.terminalCount, 0);
  const total = Math.max(group.jobs.length, recordedJobCount);
  const finished = Math.min(total, Math.max(group.jobs.filter((job) => job.terminalStatus).length, recordedFinishedCount));
  // Some of the group's jobs are outside the bounded list, or could be.
  const partial = !group.parentTurnKnown || total > group.jobs.length ||
    (inventoryTruncated && recordedJobCount <= group.jobs.length);
  return { total, finished, partial };
}

/**
 * A group's one status. Unverified where the turn is unknown or some jobs are not listed; then
 * Waiting while none has finished, N of M Finished while some have, and once all have, whether
 * their result came back.
 */
export function backgroundJobGroupStatus(
  group: BackgroundJobGroup,
  inventoryTruncated: boolean,
  acknowledged: (delivery: BackgroundDeliveryView) => boolean = () => false,
): BackgroundJobGroupStatus {
  if (group.jobs.length === 0) return deliveryReceiptStatus(group.deliveries, acknowledged);
  if (!group.parentTurnKnown) return { key: "unverified" };
  const { total, finished, partial } = backgroundJobGroupCounts(group, inventoryTruncated);
  if (finished < total) {
    return finished === 0 ? { key: "waiting", unfinished: total } : { key: "finished", finished, total };
  }
  const returnedJobs = group.jobs.filter((job) => job.assistantResultPersistedAt != null ||
    (job.terminalObservedAt != null && job.continuationRequired === false)).length;
  const returned = (group.deliveries.length > 0 &&
    group.deliveries.every((delivery) => delivery.runnerResultPersistedAt != null)) ||
    (!partial && returnedJobs === group.jobs.length);
  if (returned) return { key: "returned" };
  if (partial) return { key: "unverified" };
  const pending = group.deliveries.filter((delivery) => delivery.runnerResultPersistedAt == null);
  if (pending.some((delivery) => delivery.missingResultAt != null &&
      delivery.missingResultAcknowledgedAt == null && !acknowledged(delivery))) return { key: "result_missing" };
  if (pending.some((delivery) => delivery.missingResultAcknowledgedAt != null || acknowledged(delivery))) {
    return { key: "missing_acknowledged" };
  }
  return { key: "returning" };
}

const finishedStates: ReadonlySet<BackgroundJobCurrentState> = new Set(["completed", "failed", "killed"]);

/**
 * A job row's second line (#2858): one sentence about its result, "Started 10m ago", "Result waits
 * for the other job", "Result returned 50m ago", "Last seen 12m ago". `unfinishedSiblings` counts
 * the other jobs of its turn that have not finished.
 */
export function backgroundJobRowSentence(
  job: ManagedBackgroundJobView,
  state: BackgroundJobCurrentState,
  unfinishedSiblings: number,
  now: number,
): string {
  const ago = (timestamp: number | undefined) => formatRecordedRelativeTime(timestamp, now);
  if (state === "running" || state === "stalled") return `Started ${ago(job.registeredAt)}`;
  if (!finishedStates.has(state)) return `Last seen ${ago(job.lastObservedAt)}`;
  if (job.assistantResultPersistedAt != null) return `Result returned ${ago(job.assistantResultPersistedAt)}`;
  if (job.continuationMissingResultAt != null) return "Result never arrived";
  if (job.continuationAcceptedAt != null || job.continuationSubmittedAt != null || job.continuationQueuedAt != null) {
    return "Returning result";
  }
  if (job.continuationRequired !== false && unfinishedSiblings > 0) {
    return unfinishedSiblings === 1 ? "Result waits for the other job" : `Result waits for ${unfinishedSiblings} other jobs`;
  }
  return `Finished ${ago(job.terminalObservedAt ?? job.lastObservedAt)}`;
}

/** The Job Detail page's Result fact: where the job's result goes, or went. */
export function backgroundJobResultSentence(
  job: ManagedBackgroundJobView,
  state: BackgroundJobCurrentState,
  unfinishedSiblings: number,
  now: number,
): string {
  if (job.assistantResultPersistedAt != null) {
    return `Returned to this conversation ${formatRecordedRelativeTime(job.assistantResultPersistedAt, now)}`;
  }
  if (job.continuationMissingResultAt != null) return "Never reached this conversation";
  if (job.continuationAcceptedAt != null || job.continuationSubmittedAt != null || job.continuationQueuedAt != null) {
    return "Returning to this conversation now";
  }
  if (state === "lost") return "Can't return to this conversation, because the job was lost";
  if (!finishedStates.has(state)) return "Returns to this conversation when the job finishes";
  if (job.continuationRequired === false) return "Nothing to return to this conversation";
  if (unfinishedSiblings > 0) {
    return unfinishedSiblings === 1
      ? "Returns to this conversation when the other job finishes"
      : `Returns to this conversation when the other ${unfinishedSiblings} jobs finish`;
  }
  return "Returning to this conversation now";
}

/** How far the push notification for a turn's result got, or null when none was sent. */
export function backgroundNotificationStage(deliveries: readonly BackgroundDeliveryView[]): string | null {
  const receipts = deliveries.flatMap((delivery) => delivery.notifications ?? []);
  if (receipts.some((receipt) => receipt.clickedAt != null)) return "Opened";
  if (receipts.some((receipt) => receipt.shownAt != null)) return "Shown";
  if (receipts.some((receipt) => receipt.serviceAcceptedAt != null)) return "Sent";
  if (deliveries.some((delivery) => delivery.notificationQueuedAt != null)) return "Queued";
  return null;
}

/** Who ended a job Wollipog ended (#1849). A person is named by role, as the timeline names them. */
export function backgroundJobEndedByLabel(end: ManagedBackgroundJobEnd): string {
  if (end.actor.kind === "orchestrator") return "Controlling Orchestrator";
  if (end.actor.kind === "user") return "Session Owner";
  return "Wollipog";
}

export function backgroundJobEndReasonLabel(end: ManagedBackgroundJobEnd): string {
  if (end.reason === "stop_request") return "Stop Job Request";
  if (end.reason === "handoff_wait_bound") return "Handoff Waited Past Its Bound";
  return "Session Restarted";
}
