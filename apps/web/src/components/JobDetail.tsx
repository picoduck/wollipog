import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { runnerSupportsProtocol, type SessionView } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import {
  STOP_JOB_ALREADY_ENDED,
  STOP_JOB_OUTCOME,
  backgroundJobCurrentState,
  backgroundJobLabel,
  backgroundJobStopAvailability,
  requestBackgroundJobStop,
  stoppableJobState,
  type BackgroundJobStopAvailability,
  type BackgroundJobStopResult,
} from "../background-job-stop.js";
import {
  UNKNOWN_PARENT_TURN,
  backgroundJobEndReasonLabel,
  backgroundJobEndedByLabel,
  backgroundJobGroupCounts,
  backgroundJobResultSentence,
  backgroundNotificationStage,
  backgroundTurnLabel,
  groupBackgroundHistory,
  type BackgroundParentTurn,
} from "../background-work.js";
import { formatClock, formatDuration, formatRecordedRelativeTime, formatRecordedTimestamp } from "../format.js";
import { statusMeta } from "../status-meta.js";
import { useTimelineClock } from "../timeline-clock.js";
import { useFeedback } from "./FeedbackProvider.js";
import { Notice } from "./Notice.js";
import { State } from "./State.js";
import { StatusBadge } from "./StatusBadge.js";
import { BusyButton } from "./ui/BusyButton.js";

/** Said under Stop Job once the runner has stopped the job. */
export const STOP_JOB_STOPPED = "Stopped. Its status updates here shortly.";

export interface JobDetailProps {
  session: SessionView;
  /** The managed background job this page shows. */
  jobId: string;
  runnerOnline: boolean;
  runnerProtocolVersion: number | null | undefined;
  /** Each loaded turn by its id, for Started By's name and View Turn. */
  parentTurns: ReadonlyMap<string, BackgroundParentTurn>;
  /** The transcript has earlier activity to load, so a turn outside it can still be viewed. */
  earlierActivityUnloaded?: boolean;
  /** Scroll the transcript to the turn, loading earlier activity first when it is not loaded. */
  onViewTurn?: (parentTurnId: string) => void;
}

/** A recorded time as its age, with the exact date and time as its tooltip. */
function RecordedAge({ at, now, clock = false }: { at: number | undefined; now: number; clock?: boolean }) {
  const exact = formatRecordedTimestamp(at);
  if (!exact) return <>Unavailable</>;
  const time = formatClock(at);
  return (
    <time dateTime={exact.dateTime} title={exact.title}>
      {formatRecordedRelativeTime(at, now)}{clock && time ? ` at ${time}` : ""}
    </time>
  );
}

type StopFeedback = { state: "pending" } | BackgroundJobStopResult;

/**
 * Stop Job… for one unfinished job (#1780, #2858). It asks first, in the shared danger confirmation
 * titled with the job's name, with Cancel focused; the runner then ends only that job. Unavailable,
 * the button stays, disabled, with its reason as visible text it is described by.
 */
function StopJob({ sessionId, jobId, label, availability, stoppable }: {
  sessionId: string;
  jobId: string;
  label: string;
  availability: BackgroundJobStopAvailability;
  stoppable: boolean;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const reasonId = useId();
  const [feedback, setFeedback] = useState<StopFeedback | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const stop = async () => {
    const confirmed = await confirm({
      title: `Stop ${label}`,
      message: STOP_JOB_OUTCOME,
      confirmLabel: "Stop Job",
      tone: "danger",
    });
    if (!confirmed || !mounted.current) return;
    setFeedback({ state: "pending" });
    const result = await requestBackgroundJobStop(api, sessionId, jobId);
    if (mounted.current) setFeedback(result);
  };
  // Once stopped, the job is no longer stoppable and the button goes; its outcome stays.
  const offered = stoppable && feedback?.state !== "stopped" && feedback?.state !== "already_terminal";
  if (!availability.available) {
    return offered ? (
      <div className="job-detail-stop">
        <button type="button" className="btn sm" disabled aria-describedby={reasonId}>Stop Job…</button>
        <p id={reasonId} className="job-detail-stop-note">{availability.reason}</p>
      </div>
    ) : null;
  }
  let note: ReactNode = null;
  if (feedback?.state === "stopped") note = <p className="job-detail-stop-note" role="status">{STOP_JOB_STOPPED}</p>;
  else if (feedback?.state === "already_terminal") {
    note = <p className="job-detail-stop-note" role="status">{STOP_JOB_ALREADY_ENDED}</p>;
  } else if (feedback?.state === "error") {
    note = <Notice tone="danger" compact role="alert">{feedback.message}</Notice>;
  }
  if (!offered && !note) return null;
  return (
    <div className="job-detail-stop">
      {offered && (
        <BusyButton className="btn sm" busy={feedback?.state === "pending"} progress="Stopping…" onClick={() => void stop()}>
          Stop Job…
        </BusyButton>
      )}
      {note}
    </div>
  );
}

/**
 * One managed background job as a panel page (#2858): its status badge, a `.facts` list of when it
 * ran, where its result goes and which turn started it, and Stop Job… while it can be stopped. The
 * page's title is the job's name (`backgroundJobLabel`), which the tool that pushes the page sets.
 * Background Work and the Agents tab share it.
 */
export function JobDetail({
  session,
  jobId,
  runnerOnline,
  runnerProtocolVersion,
  parentTurns,
  earlierActivityUnloaded = false,
  onViewTurn,
}: JobDetailProps) {
  const job = session.backgroundJobs?.find((candidate) => candidate.id === jobId);
  const now = useTimelineClock(job !== undefined);
  const group = useMemo(() => {
    if (!job) return undefined;
    const known = job.parentTurnId !== UNKNOWN_PARENT_TURN;
    return groupBackgroundHistory(
      (session.backgroundJobs ?? []).filter((candidate) => known ? candidate.parentTurnId === job.parentTurnId : candidate === job),
      known ? (session.backgroundDeliveries ?? []).filter((delivery) => delivery.parentTurnId === job.parentTurnId) : [],
    )[0];
  }, [job, session.backgroundJobs, session.backgroundDeliveries]);
  if (!job || !group) {
    return (
      <State compact title="Job Not Listed">
        This job is no longer in the session's list of background jobs.
      </State>
    );
  }
  const inventorySupported = runnerSupportsProtocol(runnerProtocolVersion, "managedBackgroundInventory");
  const state = backgroundJobCurrentState(job, session.backgroundWorkState, runnerOnline, inventorySupported, now);
  const label = backgroundJobLabel(job);
  const counts = backgroundJobGroupCounts(group, session.backgroundJobsTruncated === true);
  const unfinishedSiblings = Math.max(0, counts.total - counts.finished - (job.terminalStatus ? 0 : 1));
  const running = state === "running" || state === "stalled";
  const end = job.terminalObservedAt ?? (running ? now : job.lastObservedAt);
  const duration = formatDuration(Math.max(0, end - job.registeredAt));
  const notification = backgroundNotificationStage(group.deliveries);
  const turn = parentTurns.get(job.parentTurnId);
  const turnViewable = onViewTurn !== undefined && job.parentTurnId !== UNKNOWN_PARENT_TURN &&
    (turn !== undefined || earlierActivityUnloaded);
  const jobStop = backgroundJobStopAvailability(session, runnerProtocolVersion, runnerOnline);
  return (
    <section className="job-detail" aria-label={label}>
      <StatusBadge meta={statusMeta("job", state)} />
      <dl className="facts job-detail-facts">
        <div><dt>Started</dt><dd><RecordedAge at={job.registeredAt} now={now} clock /></dd></div>
        <div><dt>{running ? "Running For" : "Duration"}</dt><dd>{duration || "Unavailable"}</dd></div>
        {job.terminalObservedAt != null && (
          <div><dt>Finished</dt><dd><RecordedAge at={job.terminalObservedAt} now={now} /></dd></div>
        )}
        <div><dt>Last Activity</dt><dd><RecordedAge at={job.lastObservedAt} now={now} /></dd></div>
        <div><dt>Result</dt><dd>{backgroundJobResultSentence(job, state, unfinishedSiblings, now)}</dd></div>
        {notification && <div><dt>Notification</dt><dd>{notification}</dd></div>}
        <div>
          <dt>Started By</dt>
          <dd className="job-detail-turn">
            <span>{backgroundTurnLabel(job.parentTurnId, turn)}</span>
            {turnViewable && (
              <button type="button" className="btn sm ghost" onClick={() => onViewTurn(job.parentTurnId)}>View Turn</button>
            )}
          </dd>
        </div>
        {job.endedBy && (
          <>
            <div>
              <dt>Ended By</dt>
              <dd>
                {backgroundJobEndedByLabel(job.endedBy)}
                {job.endedBy.actor.kind === "orchestrator" && <> <code>{job.endedBy.actor.sessionId}</code></>}
              </dd>
            </div>
            <div><dt>Reason</dt><dd>{backgroundJobEndReasonLabel(job.endedBy)}</dd></div>
          </>
        )}
      </dl>
      {jobStop && (
        <StopJob sessionId={session.id} jobId={job.id} label={label} availability={jobStop}
          stoppable={stoppableJobState(state)} />
      )}
    </section>
  );
}
