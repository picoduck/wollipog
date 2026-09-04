import { useMemo } from "react";
import {
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
  return inventorySupported && runnerOnline && job.sourcePresent ? "Running" : "Status Unverified";
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

function notificationStage(delivery: BackgroundDeliveryView | undefined): string | null {
  if (!delivery) return null;
  const receipts = delivery.notifications ?? [];
  if (receipts.some((receipt) => receipt.clickedAt != null)) return "Notification Opened";
  if (receipts.some((receipt) => receipt.shownAt != null)) return "Notification Shown";
  if (receipts.some((receipt) => receipt.serviceAcceptedAt != null)) return "Notification Accepted";
  if (delivery.notificationQueuedAt != null) return "Notification Queued";
  return null;
}

interface BackgroundJobGroup {
  parentTurnId: string;
  jobs: ManagedBackgroundJobView[];
}

function groupJobs(jobs: readonly ManagedBackgroundJobView[]): BackgroundJobGroup[] {
  const groups = new Map<string, ManagedBackgroundJobView[]>();
  for (const job of jobs) {
    const group = groups.get(job.parentTurnId) ?? [];
    group.push(job);
    groups.set(job.parentTurnId, group);
  }
  return [...groups.entries()]
    .map(([parentTurnId, group]) => ({
      parentTurnId,
      jobs: group.sort((left, right) => left.registeredAt - right.registeredAt || left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => Math.max(...right.jobs.map((job) => job.registeredAt)) -
      Math.max(...left.jobs.map((job) => job.registeredAt)));
}

export function BackgroundWorkPanel({
  session,
  runnerOnline,
  runnerProtocolVersion,
  parentTurnEventIds,
  onOpenParentTurn,
}: {
  session: SessionView;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
  parentTurnEventIds: ReadonlyMap<string, number>;
  onOpenParentTurn: (eventId: number) => void;
}) {
  const inventorySupported = runnerSupportsProtocol(runnerProtocolVersion, "managedBackgroundInventory");
  const jobs = session.backgroundJobs ?? [];
  const groups = useMemo(() => groupJobs(jobs), [jobs]);
  const clockEnabled = jobs.some((job) => !job.terminalStatus && runnerOnline && job.sourcePresent);
  const now = useTimelineClock(clockEnabled);
  const deliveries = new Map((session.backgroundDeliveries ?? [])
    .filter((delivery) => delivery.continuationId)
    .map((delivery) => [delivery.continuationId!, delivery]));

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
      {inventorySupported && session.backgroundWorkTracking !== "untracked" && !runnerOnline && jobs.some((job) => !job.terminalStatus) && (
        <div className="hint warn" role="status">
          The runner is offline. Durable terminal outcomes remain available, but current non-terminal status is unverified.
        </div>
      )}

      {groups.length === 0 ? (
        <div className="background-work-empty" role="status">
          <strong>No Background Work Recorded</strong>
          <p>{inventorySupported
            ? "Managed jobs will appear here when the runner reports them."
            : "Update the runner to inspect individual jobs."}</p>
        </div>
      ) : (
        <div className="background-work-groups" role="list" aria-label="Background Work Jobs">
          {groups.map((group, groupIndex) => {
            const terminalCount = group.jobs.filter((job) => job.terminalStatus).length;
            const deliveredCount = group.jobs.filter((job) => job.assistantResultPersistedAt != null ||
              (job.terminalObservedAt != null && job.continuationRequired === false)).length;
            const continuationId = group.jobs.find((job) => job.continuationId)?.continuationId;
            const delivery = continuationId ? deliveries.get(continuationId) : undefined;
            const parentEventId = parentTurnEventIds.get(group.parentTurnId);
            return (
              <section className="background-work-group" role="listitem" key={group.parentTurnId}
                aria-labelledby={`background-work-group-${groupIndex}`}>
                <div className="background-work-group-head">
                  <div>
                    <h3 id={`background-work-group-${groupIndex}`}>Parent Turn {groupIndex + 1}</h3>
                    <p>{terminalCount} of {group.jobs.length} jobs terminal · {deliveredCount} delivered</p>
                  </div>
                  {parentEventId != null ? (
                    <button type="button" className="btn ghost sm" onClick={() => onOpenParentTurn(parentEventId)}>
                      View Parent Turn
                    </button>
                  ) : (
                    <span className="background-work-link-unavailable" title="The parent turn is outside the loaded transcript window.">
                      Parent Turn Not Loaded
                    </span>
                  )}
                </div>
                <div className="background-work-barrier" aria-label="Barrier Status">
                  <span>Barrier</span>
                  <strong>{terminalCount < group.jobs.length
                    ? "Waiting for Jobs"
                    : deliveredCount < group.jobs.length ? "Delivery Pending" : "Delivered"}</strong>
                  {notificationStage(delivery) && <span> · {notificationStage(delivery)}</span>}
                </div>
                <ol className="background-work-jobs">
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
                </ol>
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
