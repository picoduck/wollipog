import { useMemo } from "react";
import {
  MANAGED_BACKGROUND_JOB_VIEW_LIMIT,
  runnerSupportsProtocol,
  type BackgroundDeliveryView,
  type BackgroundWorkState,
  type ManagedBackgroundJobView,
  type SessionView,
} from "@wollipog/protocol";
import { formatDuration, formatRecordedRelativeTime, formatRecordedTimestamp, titleCaseLabel } from "../format.js";
import { useTimelineClock } from "../timeline-clock.js";

export type BackgroundJobCurrentState =
  | "Running"
  | "Completed"
  | "Failed"
  | "Killed"
  | "Orphaned"
  | "Status Unverified";

export function backgroundJobCurrentState(
  job: ManagedBackgroundJobView,
  backgroundWorkState: BackgroundWorkState | undefined,
  runnerOnline: boolean,
  inventorySupported: boolean,
): BackgroundJobCurrentState {
  if (job.terminalStatus === "completed") return "Completed";
  if (job.terminalStatus === "failed") return "Failed";
  if (job.terminalStatus === "killed") return "Killed";
  if (backgroundWorkState === "orphaned" && job.sourcePresent) return "Orphaned";
  const aggregateCurrent = backgroundWorkState === "running" ||
    backgroundWorkState === "continuation_pending";
  return aggregateCurrent && inventorySupported && runnerOnline && job.sourcePresent
    ? "Running"
    : "Status Unverified";
}

export function backgroundJobDeliveryStage(job: ManagedBackgroundJobView): string {
  if (job.assistantResultPersistedAt != null) return "Result Delivered";
  if (job.continuationAcceptedAt != null) return "Continuation Accepted";
  if (job.continuationSubmittedAt != null) return "Continuation Submitted";
  if (job.continuationQueuedAt != null || (job.terminalObservedAt != null && job.continuationRequired)) {
    return "Continuation Pending";
  }
  if (job.terminalObservedAt != null && job.continuationRequired === false) return "No Continuation Required";
  return "Not Started";
}

function recordedTime(timestamp: number | undefined, now: number) {
  const exact = formatRecordedTimestamp(timestamp);
  if (!exact) return <span>Unavailable</span>;
  return <time dateTime={exact.dateTime} title={exact.title}>{formatRecordedRelativeTime(timestamp, now)}</time>;
}

function notificationStage(deliveries: readonly BackgroundDeliveryView[]): string | null {
  const receipts = deliveries.flatMap((delivery) => delivery.notifications ?? []);
  if (receipts.some((receipt) => receipt.clickedAt != null)) return "Notification Opened";
  if (receipts.some((receipt) => receipt.shownAt != null)) return "Notification Shown";
  if (receipts.some((receipt) => receipt.serviceAcceptedAt != null)) return "Notification Accepted";
  if (deliveries.some((delivery) => delivery.notificationQueuedAt != null)) return "Notification Queued";
  return null;
}

interface BackgroundJobGroup {
  key: string;
  parentTurnId: string;
  parentTurnKnown: boolean;
  jobs: ManagedBackgroundJobView[];
  deliveries: BackgroundDeliveryView[];
}

function deliveryTimestamp(delivery: BackgroundDeliveryView): number {
  return Math.max(
    delivery.queuedAt ?? 0,
    delivery.submittedAt ?? 0,
    delivery.acceptedAt ?? 0,
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

function deliveryStage(deliveries: readonly BackgroundDeliveryView[]): string {
  if (deliveries.some((delivery) => delivery.runnerResultPersistedAt != null)) return "Result Delivered";
  if (deliveries.some((delivery) => delivery.acceptedAt != null)) return "Continuation Accepted";
  if (deliveries.some((delivery) => delivery.submittedAt != null)) return "Continuation Submitted";
  if (deliveries.some((delivery) => delivery.queuedAt != null)) return "Continuation Pending";
  return "Status Unverified";
}

function groupBackgroundHistory(
  jobs: readonly ManagedBackgroundJobView[],
  deliveries: readonly BackgroundDeliveryView[],
): BackgroundJobGroup[] {
  const groups = new Map<string, BackgroundJobGroup>();
  for (const job of jobs) {
    // `unknown` is a runner sentinel, not a shared barrier identity. Keep those jobs separate so
    // unrelated discoveries can never be presented as one fabricated parent-turn barrier.
    const key = job.parentTurnId === "unknown" ? `unknown:${job.id}` : job.parentTurnId;
    const group = groups.get(key) ?? {
      key,
      parentTurnId: job.parentTurnId,
      parentTurnKnown: job.parentTurnId !== "unknown",
      jobs: [],
      deliveries: [],
    };
    group.jobs.push(job);
    groups.set(key, group);
  }
  deliveries.forEach((delivery, index) => {
    const parentTurnKnown = delivery.parentTurnId !== "unknown";
    const key = parentTurnKnown ? delivery.parentTurnId : `delivery:unknown:${index}`;
    const group = groups.get(key) ?? {
      key,
      parentTurnId: delivery.parentTurnId,
      parentTurnKnown,
      jobs: [],
      deliveries: [],
    };
    group.deliveries.push(delivery);
    groups.set(key, group);
  });
  return [...groups.values()]
    .map((group) => ({
      ...group,
      jobs: group.jobs.sort((left, right) => left.registeredAt - right.registeredAt || left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => {
      const latest = (group: BackgroundJobGroup) => Math.max(
        0,
        ...group.jobs.map((job) => job.registeredAt),
        ...group.deliveries.map(deliveryTimestamp),
      );
      return latest(right) - latest(left);
    });
}

export function BackgroundWorkPanel({
  session,
  runnerOnline,
  runnerProtocolVersion,
  parentTurnEventIds,
  onOpenParentTurn,
  inventoryError,
  onRetryInventory,
}: {
  session: SessionView;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
  parentTurnEventIds: ReadonlyMap<string, number>;
  onOpenParentTurn: (eventId: number) => void;
  inventoryError?: string | null;
  onRetryInventory?: () => void;
}) {
  const inventorySupported = runnerSupportsProtocol(runnerProtocolVersion, "managedBackgroundInventory");
  const jobs = session.backgroundJobs ?? [];
  const deliveries = session.backgroundDeliveries ?? [];
  const groups = useMemo(() => groupBackgroundHistory(jobs, deliveries), [deliveries, jobs]);
  // Every visible relative timestamp ages, including settled history left open for inspection.
  const now = useTimelineClock(jobs.length > 0 || deliveries.length > 0);
  const aggregateState = session.backgroundWorkState === "resumed"
    ? undefined
    : session.backgroundWorkState;
  const inventoryPending = session.backgroundJobsAvailable === true && session.backgroundJobs === undefined;
  const inventoryProjectionUnknown = session.backgroundJobsAvailable === undefined &&
    session.backgroundWorkTracking === "managed" && aggregateState === undefined;

  return (
    <div className="background-work-panel">
      {!inventorySupported && (
        <div className="hint warn" role="status">
          This runner predates inspectable background work. Aggregate status may be available, but per-job lifecycle evidence is not.
        </div>
      )}
      {session.backgroundWorkTracking === "untracked" && (
        <div className="hint warn" role="status">
          This provider does not expose a durable detached-work lifecycle. Wollipog cannot verify running work, completion, cancellation, or recovery.
        </div>
      )}
      {session.backgroundJobsTruncated && (
        <div className="hint" role="status">
          Showing the {MANAGED_BACKGROUND_JOB_VIEW_LIMIT} most relevant jobs. Older job history is not shown.
        </div>
      )}
      {inventorySupported && session.backgroundWorkTracking !== "untracked" && !runnerOnline && jobs.some((job) => !job.terminalStatus) && (
        <div className="hint warn" role="status">
          The runner is offline. Durable terminal outcomes remain available, but current non-terminal status is unverified.
        </div>
      )}

      {groups.length === 0 ? (
        <div className="background-work-empty" role="status">
          <strong>{inventoryPending
            ? inventoryError ? "Background Work Unavailable" : "Loading Background Work"
            : inventoryProjectionUnknown
              ? "Background Work Status Unverified"
            : aggregateState
            ? aggregateState === "orphaned" ? "Background Work Orphaned" : "Background Work Status Available"
            : "No Background Work Recorded"}</strong>
          <p>{inventoryPending
            ? inventoryError
              ? "The durable per-job history could not be loaded."
              : "Loading the durable per-job history for this session."
            : inventoryProjectionUnknown
              ? "This control plane does not expose whether durable per-job history is available."
            : aggregateState
            ? "The runner reports current background work, but per-job lifecycle evidence is unavailable."
            : inventorySupported
              ? "Managed jobs will appear here when the runner reports them."
              : "Update the runner to inspect individual jobs."}</p>
          {inventoryPending && inventoryError && onRetryInventory && (
            <button type="button" className="btn ghost sm" onClick={onRetryInventory}>Retry Loading</button>
          )}
        </div>
      ) : (
        <div className="background-work-groups" role="list" aria-label="Background Work History">
          {groups.map((group, groupIndex) => {
            const deliveryOnly = group.jobs.length === 0;
            const shownTerminalCount = group.jobs.filter((job) => job.terminalStatus).length;
            const shownDeliveredCount = group.jobs.filter((job) => job.assistantResultPersistedAt != null ||
              (job.terminalObservedAt != null && job.continuationRequired === false)).length;
            const groupDeliveries = group.deliveries;
            const recordedJobCount = groupDeliveries.reduce((total, delivery) => total + delivery.jobCount, 0);
            const recordedTerminalCount = groupDeliveries.reduce(
              (total, delivery) => total + delivery.terminalCount,
              0,
            );
            const jobCount = Math.max(group.jobs.length, recordedJobCount);
            const terminalCount = Math.min(jobCount, Math.max(shownTerminalCount, recordedTerminalCount));
            const groupTruncated = !group.parentTurnKnown || jobCount > group.jobs.length ||
              (session.backgroundJobsTruncated === true && recordedJobCount <= group.jobs.length);
            const deliveryComplete = (groupDeliveries.length > 0 &&
              groupDeliveries.every((delivery) => delivery.runnerResultPersistedAt != null)) ||
              (!groupTruncated && shownDeliveredCount === group.jobs.length);
            const parentEventId = parentTurnEventIds.get(group.parentTurnId);
            return (
              <section className="background-work-group" role="listitem" key={group.key}
                aria-labelledby={`background-work-group-${groupIndex}`}>
                <div className="background-work-group-head">
                  <div>
                    <h3 id={`background-work-group-${groupIndex}`}>{group.parentTurnKnown
                      ? `Parent Turn ${groupIndex + 1}`
                      : "Unknown Parent Turn"}</h3>
                    <p>{deliveryOnly
                      ? `Delivery receipt retained for ${jobCount} ${jobCount === 1 ? "job" : "jobs"}. Per-job lifecycle history is outside the bounded inventory.`
                      : <>{terminalCount} of {jobCount} jobs terminal · {groupTruncated
                        ? `${group.jobs.length} shown`
                        : `${shownDeliveredCount} delivered`}</>}</p>
                  </div>
                  {group.parentTurnKnown && parentEventId != null ? (
                    <button type="button" className="btn ghost sm" onClick={() => onOpenParentTurn(parentEventId)}>
                      View Parent Turn
                    </button>
                  ) : !group.parentTurnKnown ? (
                    <span className="background-work-link-unavailable" title="The runner could not associate this job with a parent turn.">
                      Parent Turn Unknown
                    </span>
                  ) : (
                    <span className="background-work-link-unavailable" title="The parent turn is outside the loaded transcript window.">
                      Parent Turn Not Loaded
                    </span>
                  )}
                </div>
                <div className="background-work-barrier" role="group"
                  aria-label={deliveryOnly ? "Delivery Receipt Status" : "Barrier Status"}>
                  <span>{deliveryOnly ? "Delivery Receipt" : "Barrier"}</span>
                  <strong>{deliveryOnly
                    ? deliveryStage(groupDeliveries)
                    : !group.parentTurnKnown
                      ? "Status Unverified"
                      : terminalCount < jobCount
                        ? "Waiting for Jobs"
                        : groupTruncated && !deliveryComplete
                          ? "Status Unverified"
                          : deliveryComplete ? "Delivered" : "Delivery Pending"}</strong>
                  {notificationStage(groupDeliveries) && <span> · {notificationStage(groupDeliveries)}</span>}
                </div>
                {deliveryOnly ? (
                  <ol className="background-work-jobs" aria-label="Retained Delivery Receipts">
                    {groupDeliveries.map((delivery, deliveryIndex) => (
                      <li className="background-work-delivery" key={delivery.continuationId ?? `${group.key}:${deliveryIndex}`}>
                        <div className="background-work-job-title">
                          <strong>Delivery Receipt {deliveryIndex + 1}</strong>
                          <span className="background-work-state">
                            {deliveryStage([delivery])}
                          </span>
                        </div>
                        <dl className="background-work-job-meta">
                          <div><dt>Recorded Job Count</dt><dd>{delivery.jobCount}</dd></div>
                          <div><dt>Recorded Terminal Count</dt><dd>{delivery.terminalCount}</dd></div>
                          <div><dt>Notification</dt><dd>{notificationStage([delivery]) ?? "Not Requested"}</dd></div>
                          <div><dt>Latest Receipt</dt><dd>{recordedTime(deliveryTimestamp(delivery) || undefined, now)}</dd></div>
                        </dl>
                      </li>
                    ))}
                  </ol>
                ) : <ol className="background-work-jobs">
                  {group.jobs.map((job, jobIndex) => {
                    const state = backgroundJobCurrentState(
                      job,
                      session.backgroundWorkState,
                      runnerOnline,
                      inventorySupported,
                    );
                    const end = job.terminalObservedAt ?? (state === "Running" ? now : job.lastObservedAt);
                    const duration = formatDuration(Math.max(0, end - job.registeredAt));
                    return (
                      <li className="background-work-job" key={job.id}>
                        <div className="background-work-job-title">
                          <strong>{titleCaseLabel(job.launchType === "unknown" ? "Background Job" : `${job.launchType} Job`)} {jobIndex + 1}</strong>
                          <span className="background-work-state" data-state={state.toLowerCase().replace(/\s+/g, "-")}>
                            {state}
                          </span>
                        </div>
                        <dl className="background-work-job-meta">
                          <div><dt>Started</dt><dd>{recordedTime(job.registeredAt, now)}</dd></div>
                          <div><dt>Elapsed</dt><dd>{duration || "Unavailable"}</dd></div>
                          <div><dt>Latest Activity</dt><dd>{recordedTime(job.lastObservedAt, now)}</dd></div>
                          {job.terminalObservedAt != null && (
                            <div><dt>Terminal Time</dt><dd>{recordedTime(job.terminalObservedAt, now)}</dd></div>
                          )}
                          <div><dt>Continuation</dt><dd>{backgroundJobDeliveryStage(job)}</dd></div>
                        </dl>
                      </li>
                    );
                  })}
                </ol>}
              </section>
            );
          })}
        </div>
      )}
      <p className="background-work-privacy">
        Commands, local paths, credentials, and raw output stay runner-local.
      </p>
    </div>
  );
}
