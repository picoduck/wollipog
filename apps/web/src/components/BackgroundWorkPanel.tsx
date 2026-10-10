import { useEffect, useId, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  MANAGED_BACKGROUND_JOB_VIEW_LIMIT,
  runnerSupportsProtocol,
  type BackgroundDeliveryView,
  type SessionView,
} from "@wollipog/protocol";
import { formatDuration, formatRecordedRelativeTime, formatRecordedTimestamp } from "../format.js";
import { useTimelineClock } from "../timeline-clock.js";
import {
  BACKGROUND_DELIVERY_STATUS,
  backgroundDeliveryAction,
  requestMissingResultAcknowledgement,
  shownWatchdogDelivery,
} from "../background-delivery-status.js";
import {
  backgroundJobCurrentState,
  backgroundJobKind,
  backgroundJobLabel,
  backgroundJobShortId,
  backgroundJobStopAvailability,
  stoppableJobState,
  type BackgroundJobStopAvailability,
} from "../background-job-stop.js";
import {
  UNKNOWN_PARENT_TURN,
  backgroundJobGroupBadge,
  backgroundJobGroupCounts,
  backgroundJobGroupStatus,
  backgroundJobRowSentence,
  backgroundTurnLabel,
  deliveryReceiptStatus,
  deliveryTimestamp,
  groupBackgroundHistory,
  type BackgroundJobGroup,
  type BackgroundParentTurn,
} from "../background-work.js";
import { useApi } from "../api-context.js";
import { statusMeta } from "../status-meta.js";
import { driverLabel } from "../usage-view-model.js";
import { ChevronRightIcon } from "./Icons.js";
import { InfoPopover } from "./InfoPopover.js";
import { JobDetail } from "./JobDetail.js";
import { ListFoot } from "./ListFoot.js";
import { Notice } from "./Notice.js";
import { PanelNoticeSlot } from "./PanelNoticeSlot.js";
import { PanelPageTitle, usePanelPages } from "./PanelPages.js";
import { PanelHeaderActions } from "./RightPanel.js";
import { PANEL_NOTICE_RANK, type SessionNoticeEntry } from "./SessionNoticeSlot.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";

export { backgroundJobCurrentState, type BackgroundJobCurrentState } from "../background-job-stop.js";

/** How long loading waits before its skeleton rows show (§12.3). */
export const BACKGROUND_WORK_SKELETON_DELAY_MS = 300;

/** A job's page key, shared with the Agents tab's job rows. */
export const backgroundJobPageKey = (jobId: string) => `background:${jobId}`;

export interface BackgroundWorkPanelProps {
  session: SessionView;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
  /** Each loaded turn by its id: its number for the group heading and its prompt for View Turn. */
  parentTurns: ReadonlyMap<string, BackgroundParentTurn>;
  /** The transcript has earlier activity to load, so a turn outside it can still be viewed. */
  earlierActivityUnloaded?: boolean;
  /** Scroll the transcript to a turn, loading earlier activity first when it is not loaded. */
  onViewTurn?: (parentTurnId: string) => void;
  /** The session's machine, as the person named it. */
  machineName?: string;
  onOpenTerminal?: () => void;
  onOpenMachine?: () => void;
  inventoryError?: string | null;
  onRetryInventory?: () => void;
}

function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

type AcknowledgementFeedback = {
  token: symbol;
  state: "pending";
} | {
  token: symbol;
  state: "error";
  message: string;
};

function acknowledgementKey(sessionId: string, continuationId: string): string {
  return JSON.stringify([sessionId, continuationId]);
}

function recordedTime(timestamp: number | undefined, now: number) {
  const exact = formatRecordedTimestamp(timestamp);
  if (!exact) return <span>Unavailable</span>;
  return <time dateTime={exact.dateTime} title={exact.title}>{formatRecordedRelativeTime(timestamp, now)}</time>;
}

/**
 * A turn's recovery deliveries: a result that is blocked, missing or still on its way. They keep
 * their present summary until the recovery notices replace it (#2859).
 */
function RecoverySummaries({
  session,
  group,
  groupIndex,
  now,
  jobStop,
  stoppableJobListed,
  restartReportsResult,
  locallyAcknowledged,
  onAcknowledged,
  acknowledgementFeedback,
  setAcknowledgementFeedback,
}: {
  session: SessionView;
  group: BackgroundJobGroup;
  groupIndex: number;
  now: number;
  jobStop: BackgroundJobStopAvailability | null;
  stoppableJobListed: boolean;
  restartReportsResult: boolean;
  locallyAcknowledged: (delivery: BackgroundDeliveryView) => boolean;
  onAcknowledged: (key: string) => void;
  /** Per session and continuation, held by the panel so a request outlives the group it started in. */
  acknowledgementFeedback: ReadonlyMap<string, AcknowledgementFeedback>;
  setAcknowledgementFeedback: Dispatch<SetStateAction<ReadonlyMap<string, AcknowledgementFeedback>>>;
}) {
  const api = useApi();
  const recoveryDeliveries = group.deliveries.filter((delivery) =>
    delivery.watchdogState || (delivery.missingResultAt != null && delivery.runnerResultPersistedAt == null));
  return recoveryDeliveries.map((delivery, deliveryIndex) => {
    const recoveryState = delivery.watchdogState;
    const continuationId = delivery.continuationId;
    const localAcknowledgementKey = continuationId == null ? null : acknowledgementKey(session.id, continuationId);
    const feedback = localAcknowledgementKey == null ? undefined : acknowledgementFeedback.get(localAcknowledgementKey);
    const acknowledging = feedback?.state === "pending";
    const acknowledged = delivery.missingResultAcknowledgedAt != null || locallyAcknowledged(delivery);
    const isMissing = delivery.missingResultAt != null;
    const status = recoveryState
      ? BACKGROUND_DELIVERY_STATUS[recoveryState]
      : isMissing ? BACKGROUND_DELIVERY_STATUS.accepted_without_result : null;
    const summaryId = `background-delivery-summary-${groupIndex}-${deliveryIndex}`;
    return (
      <div className="background-delivery-summary" role="group" key={continuationId ?? summaryId}
        aria-labelledby={summaryId} data-recovery-state={acknowledged
          ? "missing-result-acknowledged"
          : recoveryState ?? (isMissing ? "accepted_without_result" : undefined)}>
        <strong id={summaryId}>{acknowledged ? "Missing Result Acknowledged" : status?.label}</strong>
        <p>{acknowledged
          ? "You acknowledged that this continuation ended without a durable result. Its delivery history remains available."
          : status?.description}</p>
        <dl>
          {status && !acknowledged && <>
            <div><dt>Completed</dt><dd>{status.completed}</dd></div>
            <div><dt>Still Pending</dt><dd>{status.outstanding}</dd></div>
            <div><dt>Recovery</dt><dd>{status.recovery}</dd></div>
            <div><dt>Your Action</dt><dd>{recoveryState
              ? backgroundDeliveryAction(recoveryState, jobStop, stoppableJobListed, restartReportsResult)
              : status.action}</dd></div>
          </>}
          {isMissing && <div><dt>Missing Since</dt><dd>{recordedTime(delivery.missingResultAt, now)}</dd></div>}
          {isMissing && (
            <div><dt>Recovery State</dt><dd>{acknowledged
              ? delivery.missingResultAcknowledgedAt != null
                ? <>Acknowledged {recordedTime(delivery.missingResultAcknowledgedAt, now)}</>
                : "Acknowledged"
              : "Acknowledgement Required"}</dd></div>
          )}
        </dl>
        {!acknowledged && isMissing && delivery.runnerResultPersistedAt == null && continuationId && (
          <button type="button" className="btn ghost sm"
            disabled={acknowledging}
            onClick={() => {
              const key = localAcknowledgementKey!;
              const token = Symbol("missing-result-acknowledgement");
              setAcknowledgementFeedback((current) => new Map(current).set(key, { token, state: "pending" }));
              void requestMissingResultAcknowledgement(api, session.id, continuationId).then((failure) => {
                if (failure === null) onAcknowledged(key);
                setAcknowledgementFeedback((current) => {
                  const settled = current.get(key);
                  if (settled?.token !== token || settled.state !== "pending") return current;
                  const next = new Map(current);
                  if (failure === null) next.delete(key);
                  else next.set(key, { token, state: "error", message: failure });
                  return next;
                });
              });
            }}>
            {acknowledging
              ? "Acknowledging…"
              : "Acknowledge Missing Result"}
          </button>
        )}
        {feedback?.state === "error" && !acknowledged && isMissing && delivery.runnerResultPersistedAt == null && (
          <p className="hint warn" role="alert">{feedback.message}</p>
        )}
        <details>
          <summary>Technical Details</summary>
          <dl>
            <div><dt>Pipeline State</dt><dd><code>{acknowledged
              ? "missing_result_acknowledged"
              : recoveryState ?? (isMissing ? "accepted_without_result" : undefined)}</code></dd></div>
            {status && !acknowledged && <div><dt>Diagnostic</dt><dd>{status.diagnostic}</dd></div>}
          </dl>
        </details>
      </div>
    );
  });
}

/**
 * Background Work (#2858): the jobs the agent left running after a turn, as one group per turn
 * (§5.2 group headers: "Turn 4", the group's status, View Turn) of two-line job rows. A row opens
 * the job's page (`JobDetail`), where Stop Job lives. What the panel is and what stays on the
 * machine are its About popover; machine offline is its one notice; loading, a failed load, an
 * untracked provider, an older runner and an empty history are each one state, in that order.
 */
export function BackgroundWorkPanel({
  session,
  runnerOnline,
  runnerProtocolVersion,
  parentTurns,
  earlierActivityUnloaded = false,
  onViewTurn,
  machineName,
  onOpenTerminal,
  onOpenMachine,
  inventoryError,
  onRetryInventory,
}: BackgroundWorkPanelProps) {
  const pages = usePanelPages();
  const headingPrefix = useId();
  const [locallyAcknowledged, setLocallyAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  const [acknowledgementFeedback, setAcknowledgementFeedback] =
    useState<ReadonlyMap<string, AcknowledgementFeedback>>(() => new Map());
  const inventorySupported = runnerSupportsProtocol(runnerProtocolVersion, "managedBackgroundInventory");
  const jobStop = backgroundJobStopAvailability(session, runnerProtocolVersion, runnerOnline);
  const restartReportsResult = runnerSupportsProtocol(runnerProtocolVersion, "restartKeepsQueuedWork");
  const jobs = useMemo(() => session.backgroundJobs ?? [], [session.backgroundJobs]);
  const deliveries = useMemo(() => session.backgroundDeliveries ?? [], [session.backgroundDeliveries]);
  const groups = useMemo(() => groupBackgroundHistory(jobs, deliveries), [deliveries, jobs]);
  const highlightedWatchdogDelivery = shownWatchdogDelivery(deliveries);
  // Every visible relative timestamp ages, including settled history left open for inspection.
  const now = useTimelineClock(jobs.length > 0 || deliveries.length > 0);
  const aggregateState = session.backgroundWorkState === "resumed" ? undefined : session.backgroundWorkState;
  const inventoryPending = session.backgroundJobsAvailable === true && session.backgroundJobs === undefined;
  const inventoryProjectionUnknown = session.backgroundJobsAvailable === undefined &&
    session.backgroundWorkTracking === "managed" && aggregateState === undefined;
  const untracked = session.backgroundWorkTracking === "untracked";
  // An unknown runner version is not proof of an old runner.
  const runnerTooOld = runnerProtocolVersion != null && !inventorySupported;
  const showSkeleton = useDelayedFlag(inventoryPending && !inventoryError, BACKGROUND_WORK_SKELETON_DELAY_MS);
  const machine = machineName?.trim() || null;
  const locallyAcknowledgedDelivery = (delivery: BackgroundDeliveryView) =>
    delivery.continuationId != null && locallyAcknowledged.has(acknowledgementKey(session.id, delivery.continuationId));

  const pageJobId = pages.current?.startsWith("background:") ? pages.current.slice("background:".length) : null;
  const pageJob = pageJobId === null ? undefined : jobs.find((job) => job.id === pageJobId);

  const notices: SessionNoticeEntry[] = !runnerOnline && !untracked ? [{
    key: "background-work-runner-offline",
    severity: "warning",
    rank: PANEL_NOTICE_RANK.runnerOffline,
    title: "Machine Offline",
    render: ({ trailing }) => (
      <Notice tone="warning" title="Machine Offline" trailing={trailing}>
        {machine ? `${machine} is offline.` : "The machine is offline."} Finished jobs are shown; running jobs can't be checked.
      </Notice>
    ),
  }] : [];

  const turnViewable = (parentTurnId: string) => onViewTurn !== undefined && parentTurnId !== UNKNOWN_PARENT_TURN &&
    (parentTurns.has(parentTurnId) || earlierActivityUnloaded);

  const list = (
    <>
      <div className="background-work-turns">
        {groups.map((group, groupIndex) => {
          const headingId = `${headingPrefix}-turn-${groupIndex}`;
          const status = backgroundJobGroupStatus(group, session.backgroundJobsTruncated === true, locallyAcknowledgedDelivery);
          const counts = backgroundJobGroupCounts(group, session.backgroundJobsTruncated === true);
          const watchdogDelivery = shownWatchdogDelivery(group.deliveries);
          // With no watchdog anywhere both sides are undefined; that must not highlight every group.
          const watchdogHighlighted = watchdogDelivery !== undefined && watchdogDelivery === highlightedWatchdogDelivery;
          const states = new Map(group.jobs.map((job) => [job.id, backgroundJobCurrentState(
            job, session.backgroundWorkState, runnerOnline, inventorySupported, now)] as const));
          const stoppableJobListed = [...states.values()].some(stoppableJobState);
          return (
            <section className="background-work-turn" key={group.key} aria-labelledby={headingId}
              data-watchdog-state={watchdogDelivery?.watchdogState}
              data-watchdog-highlighted={watchdogHighlighted || undefined}
              aria-current={watchdogHighlighted ? "true" : undefined}>
              <div className="group-label background-work-turn-head">
                <h3 id={headingId} className="background-work-turn-title">
                  {backgroundTurnLabel(group.parentTurnId, parentTurns.get(group.parentTurnId))}
                </h3>
                <StatusBadge meta={backgroundJobGroupBadge(status)} inline />
                {turnViewable(group.parentTurnId) && (
                  <button type="button" className="btn sm ghost background-work-view-turn" aria-describedby={headingId}
                    onClick={() => onViewTurn!(group.parentTurnId)}>
                    View Turn
                  </button>
                )}
              </div>
              <RecoverySummaries session={session} group={group} groupIndex={groupIndex} now={now} jobStop={jobStop}
                stoppableJobListed={stoppableJobListed} restartReportsResult={restartReportsResult}
                locallyAcknowledged={locallyAcknowledgedDelivery}
                onAcknowledged={(key) => setLocallyAcknowledged((current) => new Set(current).add(key))}
                acknowledgementFeedback={acknowledgementFeedback} setAcknowledgementFeedback={setAcknowledgementFeedback} />
              <ul className="background-work-rows" aria-labelledby={headingId}>
                {group.jobs.length === 0 ? group.deliveries.map((delivery, deliveryIndex) => (
                  <li key={delivery.continuationId ?? `${group.key}:${deliveryIndex}`}>
                    <div className="row row-2 background-job-row">
                      <span className="row-body">
                        <span className="row-line">
                          <span className="row-title">Result Receipt</span>
                          <StatusBadge meta={backgroundJobGroupBadge(deliveryReceiptStatus([delivery], locallyAcknowledgedDelivery))} />
                        </span>
                        <span className="row-line">
                          <span className="row-sub">
                            {delivery.terminalCount} of {delivery.jobCount} {delivery.jobCount === 1 ? "job" : "jobs"} finished
                          </span>
                          <span className="row-trail">{formatRecordedRelativeTime(deliveryTimestamp(delivery) || undefined, now)}</span>
                        </span>
                      </span>
                    </div>
                  </li>
                )) : group.jobs.map((job) => {
                  const state = states.get(job.id)!;
                  const running = state === "running" || state === "stalled";
                  const end = job.terminalObservedAt ?? (running ? now : job.lastObservedAt);
                  const unfinishedSiblings = Math.max(0, counts.total - counts.finished - (job.terminalStatus ? 0 : 1));
                  const pageKey = backgroundJobPageKey(job.id);
                  return (
                    <li key={job.id}>
                      <button type="button" className="row row-2 background-job-row" data-panel-page-key={pageKey}
                        onClick={() => pages.push(pageKey)}>
                        <span className="row-body">
                          <span className="row-line">
                            <span className="row-title">
                              {backgroundJobKind(job)} <span className="mono background-job-id">{backgroundJobShortId(job)}</span>
                            </span>
                            <StatusBadge meta={statusMeta("job", state)} />
                          </span>
                          <span className="row-line">
                            <span className="row-sub">{backgroundJobRowSentence(job, state, unfinishedSiblings, now)}</span>
                            <span className="row-trail">{formatDuration(Math.max(0, end - job.registeredAt))}</span>
                          </span>
                        </span>
                        <ChevronRightIcon size={16} className="background-job-chevron" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      {session.backgroundJobsTruncated && (
        <ListFoot>Showing the {MANAGED_BACKGROUND_JOB_VIEW_LIMIT} most recent jobs.</ListFoot>
      )}
    </>
  );

  const body = inventoryPending && !inventoryError ? (
    showSkeleton ? (
      <div className="skeleton background-work-skeleton" role="status" aria-live="polite">
        <span className="sr-only">Loading background work…</span>
        {[0, 1, 2].map((index) => (
          <div className="row row-2" aria-hidden="true" key={index}>
            <span className="row-body">
              <span className="skeleton-bar title" />
              <span className="skeleton-bar" />
            </span>
          </div>
        ))}
      </div>
    ) : null
  ) : inventoryPending ? (
    <State variant="error" compact title="Couldn't Load Background Work" details={inventoryError}
      actions={onRetryInventory && <button type="button" className="btn sm" onClick={onRetryInventory}>Retry</button>}>
      The machine's list of background jobs didn't load.
    </State>
  ) : untracked ? (
    <State compact title="Background Work Isn't Tracked"
      actions={onOpenTerminal && <button type="button" className="btn sm" onClick={onOpenTerminal}>Open Terminal</button>}>
      {driverLabel(session.driver)} doesn't report background jobs, so Wollipog can't list them or tell when they finish.
    </State>
  ) : runnerTooOld ? (
    <State compact title="Runner Update Required"
      actions={onOpenMachine && <button type="button" className="btn sm" onClick={onOpenMachine}>Open Machine</button>}>
      {machine ? `${machine}'s runner` : "This machine's runner"} is too old to list individual jobs.
    </State>
  ) : groups.length > 0 ? list : inventoryProjectionUnknown ? (
    <State compact title="Jobs Aren't Listed">
      This version of Wollipog doesn't list individual background jobs.
    </State>
  ) : aggregateState === "orphaned" ? (
    <State compact title="Background Work Lost">
      A background job was lost, and its details aren't available.
    </State>
  ) : aggregateState ? (
    <State compact title="Background Work Running">
      A background job is running, but its details aren't available yet.
    </State>
  ) : (
    <State compact title="No Background Work">
      Jobs the agent leaves running after a turn show up here, grouped by the turn that started them.
    </State>
  );

  return (
    <>
      <PanelHeaderActions>
        <InfoPopover tool="Background Work">
          <p>
            Jobs the agent leaves running after a turn, grouped by the turn that started them. When they finish,
            their result returns to this conversation.
          </p>
          <p>
            Commands, file paths, credentials and output stay on {machine ?? "this machine"}. Wollipog only shows
            timing and status.
          </p>
        </InfoPopover>
      </PanelHeaderActions>
      <PanelNoticeSlot sessionId={session.id} entries={notices} />
      {/* The list stays mounted under a page, so its rows and scroll are there on Back. */}
      <div className="background-work-panel" hidden={pageJobId !== null}>{body}</div>
      {pageJobId !== null && (
        <div className="background-work-page" key={pageJobId}>
          <PanelPageTitle>{pageJob ? backgroundJobLabel(pageJob) : "Background Job"}</PanelPageTitle>
          <JobDetail session={session} jobId={pageJobId} runnerOnline={runnerOnline}
            runnerProtocolVersion={runnerProtocolVersion} parentTurns={parentTurns}
            earlierActivityUnloaded={earlierActivityUnloaded} onViewTurn={onViewTurn} />
        </div>
      )}
    </>
  );
}
