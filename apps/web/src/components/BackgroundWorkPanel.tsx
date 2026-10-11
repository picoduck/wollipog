import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  MANAGED_BACKGROUND_JOB_VIEW_LIMIT,
  runnerSupportsProtocol,
  type BackgroundDeliveryView,
  type BackgroundDeliveryWatchdogState,
  type ManagedBackgroundJobView,
  type SessionView,
} from "@wollipog/protocol";
import { formatDuration, formatRecordedRelativeTime } from "../format.js";
import { useTimelineClock } from "../timeline-clock.js";
import {
  backgroundLostSentence,
  requestMissingResultAcknowledgement,
  shownWatchdogDelivery,
  type BackgroundRecoverySubject,
} from "../background-delivery-status.js";
import {
  backgroundJobCurrentState,
  backgroundJobKind,
  backgroundJobLabel,
  backgroundJobSentenceName,
  backgroundJobShortId,
  backgroundJobStopAvailability,
  stoppableJobState,
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
import { BackgroundRecoveryNotice, RecordedTime } from "./BackgroundRecoveryNotice.js";
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
  /** When the session's runner last connected, which dates the restart that lost a job. */
  runnerConnectedAt?: number | null;
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

/**
 * The recovery a delivery still shows (#2859): its watchdog state, or Result Missing for a missing
 * result the watchdog no longer reports. `null` when there is nothing to recover, or once the person
 * acknowledged the missing result, when the group's own status says so instead.
 */
function deliveryRecoveryState(
  delivery: BackgroundDeliveryView,
  acknowledged: boolean,
): BackgroundDeliveryWatchdogState | null {
  const missing = delivery.missingResultAt != null && delivery.runnerResultPersistedAt == null;
  const state = delivery.watchdogState ?? (missing ? "accepted_without_result" : null);
  return state === "accepted_without_result" && acknowledged ? null : state;
}

/**
 * The listed jobs a delivery returns the result of: those its continuation names. One without a
 * continuation yet is the control plane's pending receipt, which counts the turn's present, finished
 * jobs that have a result to return and no continuation; a job with nothing to return, or one the
 * runner no longer lists, is not among them.
 */
function deliveryJobs(delivery: BackgroundDeliveryView, group: BackgroundJobGroup): ManagedBackgroundJobView[] {
  if (delivery.continuationId != null) {
    return group.jobs.filter((job) => job.continuationId === delivery.continuationId);
  }
  return group.jobs.filter((job) => job.sourcePresent && job.terminalStatus != null &&
    job.continuationRequired !== false && job.continuationId == null && job.assistantResultPersistedAt == null);
}

/** A recovery notice names its one job, or counts them. The receipt's own count covers jobs the
 * bounded list leaves out, so a job is named only when the receipt is about that job alone. */
function recoverySubject(delivery: BackgroundDeliveryView, jobs: readonly ManagedBackgroundJobView[]): BackgroundRecoverySubject {
  const count = Math.max(1, jobs.length, delivery.terminalCount);
  return count === 1 && jobs.length === 1 ? { job: backgroundJobSentenceName(jobs[0]!) } : { count };
}

function latestFinish(jobs: readonly ManagedBackgroundJobView[]): number | undefined {
  const finished = jobs.flatMap((job) => job.terminalObservedAt ?? []);
  return finished.length > 0 ? Math.max(...finished) : undefined;
}

/**
 * Background Work (#2858): the jobs the agent left running after a turn, as one group per turn
 * (§5.2 group headers: "Turn 4", the group's status, View Turn) of two-line job rows. A row opens
 * the job's page (`JobDetail`), where Stop Job lives. A result that went wrong is one notice at the
 * top of its group (`BackgroundRecoveryNotice`, #2859). What the panel is and what stays on the
 * machine are its About popover; machine offline and a lost job are its notices; loading, a failed
 * load, an untracked provider, an older runner and an empty history are each one state, in that order.
 */
export function BackgroundWorkPanel({
  session,
  runnerOnline,
  runnerProtocolVersion,
  parentTurns,
  earlierActivityUnloaded = false,
  onViewTurn,
  machineName,
  runnerConnectedAt,
  onOpenTerminal,
  onOpenMachine,
  inventoryError,
  onRetryInventory,
}: BackgroundWorkPanelProps) {
  const api = useApi();
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

  // A successful Acknowledge removes its notice, button and all; focus goes to the turn's heading,
  // whose badge now reads Missing Result Acknowledged. The turn is found by its key once the panel
  // has rendered the acknowledgement: the acknowledged snapshot can reorder the groups first.
  const acknowledgedFocus = useRef<{ sessionId: string; groupKey: string } | null>(null);
  useEffect(() => {
    const target = acknowledgedFocus.current;
    acknowledgedFocus.current = null;
    if (target === null || target.sessionId !== session.id) return;
    const groupIndex = groups.findIndex((group) => group.key === target.groupKey);
    const active = document.activeElement;
    if (groupIndex >= 0 && (active === null || active === document.body)) {
      document.getElementById(`${headingPrefix}-turn-${groupIndex}`)?.focus();
    }
    // Once per acknowledgement, reading the groups of the render that shows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locallyAcknowledged]);
  const acknowledge = (continuationId: string, groupKey: string) => {
    const key = acknowledgementKey(session.id, continuationId);
    if (acknowledgementFeedback.get(key)?.state === "pending") return;
    const token = Symbol("missing-result-acknowledgement");
    setAcknowledgementFeedback((current) => new Map(current).set(key, { token, state: "pending" }));
    void requestMissingResultAcknowledgement(api, session.id, continuationId).then((failure) => {
      if (failure === null) {
        acknowledgedFocus.current = { sessionId: session.id, groupKey };
        setLocallyAcknowledged((current) => new Set(current).add(key));
      }
      setAcknowledgementFeedback((current) => {
        const settled = current.get(key);
        if (settled?.token !== token || settled.state !== "pending") return current;
        const next = new Map(current);
        if (failure === null) next.delete(key);
        else next.set(key, { token, state: "error", message: failure });
        return next;
      });
    });
  };

  const pageJobId = pages.current?.startsWith("background:") ? pages.current.slice("background:".length) : null;
  const pageJob = pageJobId === null ? undefined : jobs.find((job) => job.id === pageJobId);

  const turnViewable = (parentTurnId: string) => onViewTurn !== undefined && parentTurnId !== UNKNOWN_PARENT_TURN &&
    (parentTurns.has(parentTurnId) || earlierActivityUnloaded);

  const notices: SessionNoticeEntry[] = [];
  if (!runnerOnline && !untracked) {
    notices.push({
      key: "background-work-runner-offline",
      severity: "warning",
      rank: PANEL_NOTICE_RANK.runnerOffline,
      title: "Machine Offline",
      render: ({ trailing }) => (
        <Notice tone="warning" title="Machine Offline" trailing={trailing}>
          {machine ? `${machine} is offline.` : "The machine is offline."} Finished jobs are shown; running jobs can't be checked.
        </Notice>
      ),
    });
  }
  if (aggregateState === "orphaned" && !untracked) {
    // Lost (#2859): the runner restarted under a running job, so its result can't come back. The
    // person can ask the agent to run it again from its turn; there is no Rerun.
    const lostJobs = jobs.filter((job) =>
      backgroundJobCurrentState(job, aggregateState, runnerOnline, inventorySupported, now) === "lost");
    const title = lostJobs.length > 1 ? `Lost Track of ${lostJobs.length} Background Jobs` : "Lost Track of a Background Job";
    const lostTurns = [...new Set(lostJobs.map((job) => job.parentTurnId))];
    const viewTurn = lostTurns.length === 1 && turnViewable(lostTurns[0]!) ? lostTurns[0]! : null;
    const lastSeen = lostJobs.length > 0 ? Math.max(...lostJobs.map((job) => job.lastObservedAt)) : undefined;
    const restarted = runnerConnectedAt != null && (lastSeen === undefined || runnerConnectedAt >= lastSeen)
      ? runnerConnectedAt
      : undefined;
    notices.push({
      key: "background-work-lost",
      severity: "danger",
      rank: PANEL_NOTICE_RANK.backgroundWorkLost,
      title,
      render: ({ trailing }) => (
        <Notice tone="danger" title={title} trailing={trailing} dataState="lost"
          actions={viewTurn !== null && (
            <button type="button" className="btn sm" onClick={() => onViewTurn!(viewTurn)}>View Turn</button>
          )}
          details={(lastSeen !== undefined || restarted !== undefined) && (
            <dl className="facts">
              {lastSeen !== undefined && <div><dt>Last Seen</dt><dd><RecordedTime at={lastSeen} now={now} /></dd></div>}
              {restarted !== undefined && <div><dt>Runner Restarted</dt><dd><RecordedTime at={restarted} now={now} /></dd></div>}
              {lostTurns.length > 0 && (
                <div><dt>Started By</dt><dd>{lostTurns.map((turn) => backgroundTurnLabel(turn, parentTurns.get(turn))).join(", ")}</dd></div>
              )}
            </dl>
          )}>
          {backgroundLostSentence(machine, lostJobs)}
        </Notice>
      ),
    });
  }

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
          const lostCount = [...states.values()].filter((state) => state === "lost").length;
          const recoveries =group.deliveries.flatMap((delivery, deliveryIndex) => {
            const state = deliveryRecoveryState(delivery, delivery.missingResultAcknowledgedAt != null ||
              locallyAcknowledgedDelivery(delivery));
            return state === null ? [] : [{ delivery, deliveryIndex, state }];
          });
          return (
            <section className="background-work-turn" key={group.key} aria-labelledby={headingId}
              data-watchdog-state={watchdogDelivery?.watchdogState}
              data-watchdog-highlighted={watchdogHighlighted || undefined}
              aria-current={watchdogHighlighted ? "true" : undefined}>
              <div className="group-label background-work-turn-head">
                <h3 id={headingId} className="background-work-turn-title" tabIndex={-1}>
                  {backgroundTurnLabel(group.parentTurnId, parentTurns.get(group.parentTurnId))}
                </h3>
                {/* Result Missing's notice says it; the badge returns once it is acknowledged. A turn
                    whose unfinished jobs were all lost is waiting for nothing: the Lost notice and the
                    rows say what happened. */}
                {status.key !== "result_missing" && !(status.key === "waiting" && lostCount >= status.unfinished) && (
                  <StatusBadge meta={backgroundJobGroupBadge(status)} inline />
                )}
                {turnViewable(group.parentTurnId) && (
                  <button type="button" className="btn sm ghost background-work-view-turn" aria-describedby={headingId}
                    onClick={() => onViewTurn!(group.parentTurnId)}>
                    View Turn
                  </button>
                )}
              </div>
              {recoveries.map(({ delivery, deliveryIndex, state }) => {
                const deliveredJobs = deliveryJobs(delivery, group);
                const continuationId = delivery.continuationId;
                const feedback = continuationId == null
                  ? undefined
                  : acknowledgementFeedback.get(acknowledgementKey(session.id, continuationId));
                const acknowledgeable = state === "accepted_without_result" && continuationId != null &&
                  delivery.missingResultAt != null && delivery.runnerResultPersistedAt == null;
                // Result Blocked's Stop ends the turn's one unfinished job. The bounded list can leave
                // some out, so the receipt's own count of them must be one too. Like that count, a job
                // the runner no longer lists is not one of them.
                const unfinished = group.jobs.filter((job) => job.sourcePresent && job.terminalStatus == null);
                const oneUnfinished = delivery.unfinishedSiblingJobs !== undefined
                  ? delivery.unfinishedSiblingJobs === 1
                  : session.backgroundJobsTruncated !== true;
                const target = state === "continuation_blocked" && unfinished.length === 1 && oneUnfinished
                  ? unfinished[0]!
                  : null;
                return (
                  <BackgroundRecoveryNotice key={continuationId ?? `${group.key}:${deliveryIndex}`}
                    sessionId={session.id} state={state} subject={recoverySubject(delivery, deliveredJobs)}
                    finishedAt={latestFinish(deliveredJobs)} now={now} missingSince={delivery.missingResultAt}
                    acknowledgement={acknowledgeable ? {
                      busy: feedback?.state === "pending",
                      error: feedback?.state === "error" ? feedback.message : null,
                      onAcknowledge: () => acknowledge(continuationId, group.key),
                    } : null}
                    jobStop={jobStop}
                    stopTarget={target && {
                      job: target,
                      label: backgroundJobLabel(target),
                      stoppable: stoppableJobState(states.get(target.id)!),
                    }}
                    unfinishedListed={unfinished.length} unfinishedUnlisted={counts.partial}
                    restartReportsResult={restartReportsResult} />
                );
              })}
              <ul className="background-work-rows" aria-labelledby={headingId}>
                {/* A receipt with a recovery notice is that notice; the rest list as rows. */}
                {group.jobs.length === 0 ? group.deliveries.filter((delivery) =>
                  !recoveries.some((recovery) => recovery.delivery === delivery)).map((delivery, deliveryIndex) => (
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
    // The Lost notice in the panel's slot says it all.
    null
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
