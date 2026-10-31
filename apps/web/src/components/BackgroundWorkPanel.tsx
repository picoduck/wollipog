import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  MANAGED_BACKGROUND_JOB_VIEW_LIMIT,
  backgroundLaunchTypeNoun,
  runnerSupportsProtocol,
  type BackgroundDeliveryView,
  type BackgroundDeliveryWatchdogState,
  type ManagedBackgroundJobView,
  type SessionView,
} from "@wollipog/protocol";
import { formatDuration, formatRecordedRelativeTime } from "../format.js";
import { sessionCommandRefusal } from "../session-command-permissions.js";
import { useTimelineClock } from "../timeline-clock.js";
import {
  BACKGROUND_DELIVERY_STATUS,
  backgroundLostSentence,
  historicalBackgroundResultRecovery,
  backgroundDeliveryAcknowledgement,
  backgroundDeliveryRecoveryKind,
  requestBackgroundDeliveryAcknowledgement,
  type BackgroundDeliveryAcknowledgement,
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
  inBackgroundTurn,
  type BackgroundJobGroup,
  type BackgroundParentTurn,
} from "../background-work.js";
import { useApi } from "../api-context.js";
import { backgroundWorkCondition, statusMeta } from "../status-meta.js";
import { driverLabel } from "../usage-view-model.js";
import { BackgroundRecoveryNotice, RecordedTime, backgroundRecoveryNoticeTone } from "./BackgroundRecoveryNotice.js";
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
import { useBlockedResultAcknowledgement } from "./useBlockedResultAcknowledgement.js";

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
  /** A job to open as this tool's page, from Agents' Open in Background Work (#2860). */
  openJob?: BackgroundJobPageRequest | null;
  onOpenJobHandled?: (seq: number) => void;
}

/** One request to open a job's page; `seq` tells a repeated request for the same job apart. */
export interface BackgroundJobPageRequest { jobId: string; seq: number }

/** True once `active` has held for `delayMs`: a skeleton that never flashes for a fast load (§12.3). */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
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

function acknowledgementKey(sessionId: string, continuationId: string, kind: BackgroundDeliveryAcknowledgement["kind"]): string {
  return JSON.stringify([sessionId, continuationId, kind]);
}

/** What a receipt is regardless of where the bounded inventory lists it, so its notice entry keeps
 * its dismissal and "+N More" choice as other receipts come and go. A receipt without a
 * continuation is the control plane's one held result for its turn, the unknown turn included. */
function receiptIdentity(delivery: BackgroundDeliveryView): string {
  return delivery.continuationId != null
    ? JSON.stringify(["continuation", delivery.continuationId])
    : JSON.stringify(["held", delivery.parentTurnId]);
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
  const exhausted = delivery.retryExhaustedAt != null && delivery.acceptedAt == null && delivery.runnerResultPersistedAt == null;
  const recovery = state ?? (exhausted ? "capacity_retry_exhausted" : null);
  return (recovery === "accepted_without_result" || recovery === "capacity_retry_exhausted") && acknowledged ? null : recovery;
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
 * the job's page (`JobDetail`), where Stop Job lives. What the panel is and what stays on the
 * machine are its About popover. Machine offline, a lost job, each result that went wrong
 * (`BackgroundRecoveryNotice`, #2859) and each acknowledged blocked result are entries of the panel's
 * one notice slot, which shows one and keeps the rest behind "+N More" (#2871); no notice renders
 * inside a turn group. Loading, a failed load, an untracked provider, an older runner and an empty
 * history are each one state, in that order.
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
  openJob,
  onOpenJobHandled,
}: BackgroundWorkPanelProps) {
  const api = useApi();
  const blockedAcknowledgement = useBlockedResultAcknowledgement(session);
  const pages = usePanelPages();
  // Arriving from Agents with a job lands on its page, and Back goes to this list (#2860).
  useEffect(() => {
    if (!openJob) return;
    pages.push(backgroundJobPageKey(openJob.jobId), { root: true });
    onOpenJobHandled?.(openJob.seq);
    // Each request is acted on once, when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openJob?.seq]);
  const headingPrefix = useId();
  const [locallyAcknowledged, setLocallyAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  const [acknowledgementFeedback, setAcknowledgementFeedback] =
    useState<ReadonlyMap<string, AcknowledgementFeedback>>(() => new Map());
  const inventorySupported = runnerSupportsProtocol(runnerProtocolVersion, "managedBackgroundInventory");
  const jobStop = backgroundJobStopAvailability(session, runnerProtocolVersion, runnerOnline);
  const restartReportsResult = runnerSupportsProtocol(runnerProtocolVersion, "restartKeepsQueuedWork");
  const jobs = useMemo(() => session.backgroundJobs ?? [], [session.backgroundJobs]);
  const deliveries = useMemo(() => (session.backgroundDeliveries ?? []).map((delivery) =>
    delivery.watchdogState === "continuation_blocked" && delivery.blockedResultRevision &&
      blockedAcknowledgement.isAcknowledged(delivery.parentTurnId, delivery.blockedResultRevision)
      ? { ...delivery, watchdogState: undefined, blockedResultAcknowledgedAt: Date.now() } : delivery),
  [session.backgroundDeliveries, blockedAcknowledgement.isAcknowledged]);
  const groups = useMemo(() => groupBackgroundHistory(jobs, deliveries), [deliveries, jobs]);
  const highlightedWatchdogDelivery = shownWatchdogDelivery(deliveries);
  // Every visible relative timestamp ages, including settled history left open for inspection.
  const now = useTimelineClock(jobs.length > 0 || deliveries.length > 0 || session.backgroundFollowUp != null ||
    (session.status === "queued" && !session.capacityWait && !!session.queueHold?.unlistedJobs?.length));
  const followUp = session.backgroundWorkState === "continuation_pending" ? backgroundWorkCondition(session, runnerOnline) : null;
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
    delivery.continuationId != null && !(backgroundDeliveryRecoveryKind(delivery) === "retry_exhaustion" && delivery.acceptedAt != null) &&
    locallyAcknowledged.has(acknowledgementKey(session.id, delivery.continuationId, backgroundDeliveryRecoveryKind(delivery)));

  // A successful Acknowledge removes its notice, button and all; focus goes to the turn's heading,
  // whose badge now reads what was acknowledged. The turn is found by its key in the render that
  // shows the acknowledgement: the acknowledged snapshot can reorder the groups first. The notice is
  // in the panel's notice slot, whose own rescue runs first, in a layout effect: it asks
  // `claimRemovedFocus`, which takes the focus the removed Acknowledge (`origin`) held. Focus that
  // was already on <body> (a pointer that doesn't focus buttons) is moved by the passive effect.
  // Under a pushed Job Detail page the list, headings included, is hidden and can't take focus, so
  // the claim declines and the slot keeps focus by its own rescue.
  const acknowledgedFocus = useRef<{ sessionId: string; groupKey: string; origin: Element | null } | null>(null);
  const renderedGroups = useRef(groups);
  renderedGroups.current = groups;
  const turnHeading = (groupKey: string) => {
    const groupIndex = renderedGroups.current.findIndex((group) => group.key === groupKey);
    const heading = groupIndex < 0 ? null : document.getElementById(`${headingPrefix}-turn-${groupIndex}`);
    return heading?.closest("[hidden]") ? null : heading;
  };
  const claimRemovedFocus = () => {
    const target = acknowledgedFocus.current;
    if (target === null || target.sessionId !== session.id || target.origin === null || target.origin.isConnected) return false;
    const heading = turnHeading(target.groupKey);
    if (heading === null) return false;
    acknowledgedFocus.current = null;
    heading.focus();
    return document.activeElement === heading;
  };
  useEffect(() => {
    const target = acknowledgedFocus.current;
    acknowledgedFocus.current = null;
    if (target === null || target.sessionId !== session.id) return;
    const active = document.activeElement;
    if (active === null || active === document.body) turnHeading(target.groupKey)?.focus();
    // Once per acknowledgement, reading the groups of the render that shows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locallyAcknowledged, blockedAcknowledgement.acknowledged]);
  const acknowledge = (acknowledgement: BackgroundDeliveryAcknowledgement, groupKey: string) => {
    const { continuationId } = acknowledgement;
    const key = acknowledgementKey(session.id, continuationId, acknowledgement.kind);
    if (acknowledgementFeedback.get(key)?.state === "pending") return;
    // Registered before the request: the control plane broadcasts the acknowledged session before
    // it answers, so the notice can be gone before the response arrives.
    const focusTarget = { sessionId: session.id, groupKey, origin: document.activeElement };
    acknowledgedFocus.current = focusTarget;
    const token = Symbol("missing-result-acknowledgement");
    setAcknowledgementFeedback((current) => new Map(current).set(key, { token, state: "pending" }));
    void requestBackgroundDeliveryAcknowledgement(api, session.id, acknowledgement).then((failure) => {
      if (failure === null) setLocallyAcknowledged((current) => new Set(current).add(key));
      // Nothing was acknowledged, so the notice and its focused Acknowledge stay.
      else if (acknowledgedFocus.current === focusTarget) acknowledgedFocus.current = null;
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

  // A handoff hold waiting on work no row below shows (#3752): name it here, where people look.
  const unlistedHold = session.status === "queued" && !session.capacityWait ? session.queueHold : undefined;
  if (unlistedHold?.unlistedJobs?.length) {
    const unlisted = unlistedHold.unlistedJobs;
    // Older runners omit the full count; the total minus visible unfinished rows is a safe fallback.
    const countIsLowerBound = unlistedHold.unlistedJobCount === undefined && session.backgroundJobsTruncated === true;
    const unlistedCount = unlistedHold.unlistedJobCount ?? (countIsLowerBound ? unlisted.length : Math.max(unlisted.length,
      unlistedHold.unfinishedBackgroundJobs - (session.backgroundJobs ?? []).filter((job) => !job.terminalStatus).length));
    const oldest = unlistedHold.oldestUnfinishedJob;
    const title = "Handoff Waiting on Unlisted Work";
    // An account label may be an email address (§11.8), so the account is not named.
    const handoff = unlistedHold.kind === "worktree_rebind"
      ? `The move to worktree ${unlistedHold.target}`
      : "The switch to the selected provider account";
    const canRelease = unlistedHold.canRelease === true && sessionCommandRefusal(session, "stopBackgroundJob") === null;
    notices.push({
      key: "background-work-unlisted-hold",
      severity: "warning",
      rank: PANEL_NOTICE_RANK.backgroundWorkUnlisted,
      title,
      render: ({ trailing }) => (
        <Notice tone="warning" title={title} trailing={trailing} dataState="unlisted-hold"
          details={(
            <dl className="facts">
              {unlisted.map((job) => (
                <div key={job.id}>
                  <dt>{job.kind === "provisional" ? "Unconfirmed Launch" : "Unregistered Task"}</dt>
                  <dd><code>{job.id}</code>{job.startedAt !== undefined && <> — Started <RecordedTime at={job.startedAt} now={now} /></>}</dd>
                </div>
              ))}
            </dl>
          )}>
          {`${handoff} waits for ${countIsLowerBound ? `at least ${unlistedCount} ${unlistedCount === 1 ? "task that has" : "tasks that have"}` : unlistedCount === 1 ? "a task that has" : `${unlistedCount} tasks that have`} no job in this list. `}
          {unlistedCount > unlisted.length && `Showing ${unlisted.length} of ${unlistedCount}. `}
          {oldest && <>The oldest blocking item, {backgroundLaunchTypeNoun(oldest.launchType)}, started <RecordedTime at={oldest.startedAt} now={now} />. </>}
          {canRelease
            ? "Proceed Now in the queued messages ends it with the rest of this session's background work."
            : unlistedHold.endsAt !== undefined
              ? "It ends when the provider reports it finished, or when the hold's deadline passes."
              : "It ends when the provider reports it finished."}
        </Notice>
      ),
    });
  }

  const historicalRecovery = historicalBackgroundResultRecovery(session);
  const groupViews = groups.map((group, groupIndex) => {
    const states = new Map(group.jobs.map((job) => [job.id, backgroundJobCurrentState(
      job, session.backgroundWorkState, runnerOnline, inventorySupported, now)] as const));
    return {
      group,
      groupIndex,
      states,
      counts: backgroundJobGroupCounts(group, session.backgroundJobsTruncated === true),
      recoveries: group.deliveries.flatMap((delivery, deliveryIndex) => {
        const state = deliveryRecoveryState(delivery, (backgroundDeliveryRecoveryKind(delivery) === "retry_exhaustion"
          ? delivery.retryExhaustionAcknowledgedAt != null : delivery.missingResultAcknowledgedAt != null) ||
          locallyAcknowledgedDelivery(delivery));
        return state === null ? [] : [{ delivery, deliveryIndex, state }];
      }),
    };
  });

  // Each result that went wrong, and each acknowledged blocked result, is an entry of the panel's one
  // notice slot rather than a notice in its turn group (#2871), and only while the list shows. The
  // slot orders by rank, so the entries take ranks inside their band in the order they are listed
  // here: warnings first, then the groups' order, then each group's deliveries in order.
  if (!inventoryPending && !untracked && !runnerTooOld && groups.length > 0) {
    const results = groupViews
      .flatMap((view) => view.recoveries.map((recovery) => ({
        ...recovery, view, severity: backgroundRecoveryNoticeTone(recovery.state, historicalRecovery),
      })))
      .sort((a, b) => Number(a.severity !== "warning") - Number(b.severity !== "warning") ||
        a.view.groupIndex - b.view.groupIndex || a.deliveryIndex - b.deliveryIndex);
    results.forEach(({ delivery, state, severity, view: { group, states, counts } }, index) => {
      const key = `background-result:${receiptIdentity(delivery)}:${state}`;
      const title = `${BACKGROUND_DELIVERY_STATUS[state].label} ${inBackgroundTurn(group.parentTurnId, parentTurns.get(group.parentTurnId))}`;
      const deliveredJobs = deliveryJobs(delivery, group);
      const continuationId = delivery.continuationId;
      const feedback = continuationId == null
        ? undefined
        : acknowledgementFeedback.get(acknowledgementKey(session.id, continuationId, backgroundDeliveryRecoveryKind(delivery)));
      const acknowledgement = backgroundDeliveryAcknowledgement({ ...delivery, watchdogState: state });
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
      notices.push({
        key,
        severity,
        rank: PANEL_NOTICE_RANK.backgroundResult + index / results.length,
        title,
        // Keyed, so the slot showing another entry in its place never hands it this one's state.
        render: ({ trailing, onDismiss }) => (
          <BackgroundRecoveryNotice key={key} title={title} trailing={trailing} onDismiss={onDismiss}
            sessionId={session.id} state={state} subject={recoverySubject(delivery, deliveredJobs)}
            finishedAt={latestFinish(deliveredJobs)} now={now} missingSince={state === "capacity_retry_exhausted" ? delivery.retryExhaustedAt : delivery.missingResultAt}
            acknowledgement={acknowledgement ? {
              busy: feedback?.state === "pending",
              error: feedback?.state === "error" ? feedback.message : null,
              onAcknowledge: () => acknowledge(acknowledgement, group.key),
            } : null}
            blockedAcknowledgement={state === "continuation_blocked" && blockedAcknowledgement.available
              ? { busy: blockedAcknowledgement.busy, onAcknowledge: () => {
                const focusTarget = { sessionId: session.id, groupKey: group.key, origin: document.activeElement };
                acknowledgedFocus.current = focusTarget;
                blockedAcknowledgement.acknowledge((acknowledged) => {
                  // Nothing was acknowledged, so the notice and its focused Acknowledge stay.
                  if (!acknowledged && acknowledgedFocus.current === focusTarget) acknowledgedFocus.current = null;
                });
              } } : null}
            jobStop={jobStop}
            stopTarget={target && {
              job: target,
              label: backgroundJobLabel(target),
              stoppable: stoppableJobState(states.get(target.id)!),
            }}
            unfinishedListed={unfinished.length} unfinishedUnlisted={counts.partial}
            unknownParentTurn={group.parentTurnId === UNKNOWN_PARENT_TURN}
            unverifiedUnfinished={unfinished.some((job) => states.get(job.id) === "unverified")}
            historicalRecovery={historicalRecovery}
            restartReportsResult={restartReportsResult} />
        ),
      });
    });
    const acknowledgedResults = groups.flatMap((group) => group.deliveries.flatMap((delivery) =>
      delivery.blockedResultAcknowledgedAt != null ? [{ group, delivery }] : []));
    acknowledgedResults.forEach(({ group, delivery }, index) => {
      const key = `background-result-acknowledged:${receiptIdentity(delivery)}:${delivery.blockedResultRevision ?? ""}`;
      const title = `Blocked Result Acknowledged ${inBackgroundTurn(group.parentTurnId, parentTurns.get(group.parentTurnId))}`;
      notices.push({
        key,
        severity: "info",
        rank: PANEL_NOTICE_RANK.backgroundResultAcknowledged + index / acknowledgedResults.length,
        title,
        render: ({ trailing, onDismiss }) => (
          <Notice key={key} tone="info" title={title} trailing={trailing} onDismiss={onDismiss}
            dataState="blocked_result_acknowledged">
            <p>The blocked-result alert was acknowledged. Background jobs and held results are kept.</p>
            <RecordedTime at={delivery.blockedResultAcknowledgedAt} now={now} />
          </Notice>
        ),
      });
    });
  }

  const list = (
    <>
      <div className="background-work-turns">
        {groupViews.map(({ group, groupIndex, states, counts, recoveries }) => {
          const headingId = `${headingPrefix}-turn-${groupIndex}`;
          const status = backgroundJobGroupStatus(group, session.backgroundJobsTruncated === true, locallyAcknowledgedDelivery);
          const watchdogDelivery = shownWatchdogDelivery(group.deliveries);
          // With no watchdog anywhere both sides are undefined; that must not highlight every group.
          const watchdogHighlighted = watchdogDelivery !== undefined && watchdogDelivery === highlightedWatchdogDelivery;
          const lostCount = [...states.values()].filter((state) => state === "lost").length;
          return (
            <section className="background-work-turn" key={group.key} aria-labelledby={headingId}
              data-watchdog-state={watchdogDelivery?.watchdogState}
              data-watchdog-highlighted={watchdogHighlighted || undefined}
              aria-current={watchdogHighlighted ? "true" : undefined}>
              <div className="group-label background-work-turn-head">
                <h3 id={headingId} className="background-work-turn-title" tabIndex={-1}>
                  {backgroundTurnLabel(group.parentTurnId, parentTurns.get(group.parentTurnId))}
                </h3>
                {/* The badge stays while the turn's notice waits in the panel's slot, perhaps behind
                    "+N More" (#2871). A turn whose unfinished jobs were all lost is waiting for
                    nothing: the Lost notice and the rows say what happened. */}
                {!(status.key === "returning" && historicalRecovery) &&
                  !(status.key === "waiting" && lostCount >= status.unfinished) && (
                  <StatusBadge meta={backgroundJobGroupBadge(status)} inline />
                )}
                {turnViewable(group.parentTurnId) && (
                  <button type="button" className="btn sm ghost background-work-view-turn" aria-describedby={headingId}
                    onClick={() => onViewTurn!(group.parentTurnId)}>
                    View Turn
                  </button>
                )}
              </div>
              <ul className="background-work-rows" aria-labelledby={headingId}>
                {/* A receipt with a recovery notice is that notice, in the panel's slot; the rest list
                    as rows. */}
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
                            <span className="row-sub">{backgroundJobRowSentence(job, state, unfinishedSiblings, now, group.deliveries)}</span>
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
  ) : aggregateState === "continuation_pending" ? (
    <State compact title="Follow-Up Pending">
      Background jobs finished, but their follow-up details aren't available yet.
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
      <PanelNoticeSlot sessionId={session.id} entries={notices} claimRemovedFocus={claimRemovedFocus} />
      {/* The list stays mounted under a page, so its rows and scroll are there on Back. */}
      <div className="background-work-panel" hidden={pageJobId !== null}>
        {followUp && (
          <section aria-label="Automatic Follow-Up">
            <StatusBadge meta={followUp.meta} />
            <p>{followUp.description}</p>
            {session.backgroundFollowUp?.queuedAt != null && (
              <p>Queued <RecordedTime at={session.backgroundFollowUp.queuedAt} now={now} />.</p>
            )}
          </section>
        )}
        {body}
      </div>
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
