import { useId, type ReactNode } from "react";
import type { BackgroundDeliveryWatchdogState, ManagedBackgroundJobView } from "@wollipog/protocol";
import {
  ACKNOWLEDGE_BLOCKED_RESULT_EFFECT,
  ACKNOWLEDGE_MISSING_RESULT_EFFECT,
  BACKGROUND_DELIVERY_STATUS,
  backgroundRecoverySentence,
  blockedResultSessionAlternative,
  type BackgroundRecoverySubject,
} from "../background-delivery-status.js";
import { STOP_JOB_ALREADY_ENDED, type BackgroundJobStopAvailability } from "../background-job-stop.js";
import { formatRecordedRelativeTime, formatRecordedTimestamp } from "../format.js";
import { STOP_JOB_STOPPED } from "./JobDetail.js";
import { Notice } from "./Notice.js";
import { BusyButton } from "./ui/BusyButton.js";
import { useBackgroundJobStop } from "./useBackgroundJobStop.js";

/** A recorded time as its age, with the exact date and time as its tooltip. */
export function RecordedTime({ at, now }: { at: number | undefined; now: number }) {
  const exact = formatRecordedTimestamp(at);
  if (!exact) return <>Unavailable</>;
  return <time dateTime={exact.dateTime} title={exact.title}>{formatRecordedRelativeTime(at, now)}</time>;
}

/** The pipeline code and what it means, the last fact behind a recovery notice's Show Details. */
function Diagnostic({ state }: { state: BackgroundDeliveryWatchdogState }) {
  return (
    <div><dt>Diagnostic</dt><dd><code>{state}</code> {BACKGROUND_DELIVERY_STATUS[state].diagnostic}</dd></div>
  );
}

/** Result Missing's Acknowledge: its request is running, or it failed with this message. */
export interface MissingResultAcknowledgement {
  busy: boolean;
  error: string | null;
  onAcknowledge: () => void;
}

/** The job Result Blocked's Stop would end: the one unfinished job of the turn. */
export interface BlockedResultStopTarget {
  job: ManagedBackgroundJobView;
  label: string;
  stoppable: boolean;
}

export interface BackgroundRecoveryNoticeProps {
  sessionId: string;
  state: BackgroundDeliveryWatchdogState;
  subject: BackgroundRecoverySubject;
  /** When the job, or the last of the jobs, finished. */
  finishedAt: number | undefined;
  now: number;
  /** Result Missing: when the result was found missing, and Acknowledge where it applies. */
  missingSince?: number;
  acknowledgement?: MissingResultAcknowledgement | null;
  /** Acknowledges the currently reported blocked snapshots without stopping their jobs. */
  blockedAcknowledgement?: { busy: boolean; onAcknowledge: () => void } | null;
  /** Result Blocked: whether Stop Job applies here (`null`: it does not, so nothing is offered). */
  jobStop?: BackgroundJobStopAvailability | null;
  stopTarget?: BlockedResultStopTarget | null;
  /** Result Blocked with no single job to stop: how many of the turn's unfinished jobs are listed, and
   * whether some of the turn's jobs are outside the bounded list. */
  unfinishedListed?: number;
  unfinishedUnlisted?: boolean;
  restartReportsResult?: boolean;
  /** Historical sentinels do not prove that these jobs shared a launching turn. */
  unknownParentTurn?: boolean;
  unverifiedUnfinished?: boolean;
  historicalRecovery?: boolean;
}

/**
 * One recovery delivery as one notice at the top of its turn group (docs/design-system.md §4.10,
 * §13.2; #2859). Result Missing is a warning with one sentence, Acknowledge and Show Details; Result
 * Blocked a warning with Stop <job name>… or why it can't be offered; Result Pending, Transcript
 * Delayed and Notification Pending one compact info line with no action.
 */
export function BackgroundRecoveryNotice(props: BackgroundRecoveryNoticeProps) {
  const { state, subject } = props;
  const severity = BACKGROUND_DELIVERY_STATUS[state].severity;
  if (severity === "missing" || state === "capacity_retry_exhausted") return <ResultMissingNotice {...props} />;
  if (severity === "blocked") return <ResultBlockedNotice {...props} />;
  if (props.historicalRecovery && state === "terminal_without_continuation") {
    return <ResultBlockedNotice {...props} />;
  }
  return (
    <Notice tone="info" compact role="status" className="background-recovery-notice" dataState={state}>
      {backgroundRecoverySentence(state, subject)}
    </Notice>
  );
}

function ResultMissingNotice({ state, subject, finishedAt, now, missingSince, acknowledgement }: BackgroundRecoveryNoticeProps) {
  return (
    <Notice
      tone="warning"
      title={BACKGROUND_DELIVERY_STATUS[state].label}
      className="background-recovery-notice"
      dataState={state}
      actions={acknowledgement && (
        <>
          <BusyButton className="btn sm" busy={acknowledgement.busy} progress={state === "capacity_retry_exhausted" ? "Acknowledging retry exhaustion…" : "Acknowledging the missing result…"}
            onClick={acknowledgement.onAcknowledge}>
            Acknowledge
          </BusyButton>
          {acknowledgement.error && <p className="background-recovery-note notice-error" role="alert">{acknowledgement.error}</p>}
        </>
      )}
      details={(
        <dl className="facts">
          <div><dt>Finished</dt><dd><RecordedTime at={finishedAt} now={now} /></dd></div>
          <div><dt>{state === "capacity_retry_exhausted" ? "Exhausted Since" : "Missing Since"}</dt><dd><RecordedTime at={missingSince} now={now} /></dd></div>
          {acknowledgement && <div><dt>Acknowledge</dt><dd>{ACKNOWLEDGE_MISSING_RESULT_EFFECT}</dd></div>}
          <Diagnostic state={state} />
        </dl>
      )}
    >
      <p>{backgroundRecoverySentence(state, subject)}</p>
    </Notice>
  );
}

function ResultBlockedNotice({
  sessionId,
  state,
  subject,
  finishedAt,
  now,
  jobStop,
  stopTarget,
  unfinishedListed = 0,
  unfinishedUnlisted = false,
  restartReportsResult = false,
  unknownParentTurn = false,
  unverifiedUnfinished = false,
  historicalRecovery = false,
  blockedAcknowledgement,
}: BackgroundRecoveryNoticeProps) {
  const reasonId = useId();
  // Called with no target too, so the hooks run in the same order whatever the notice offers.
  const stop = useBackgroundJobStop({
    sessionId,
    jobId: stopTarget?.job.id ?? "",
    registeredAt: stopTarget?.job.registeredAt ?? 0,
    label: stopTarget?.label ?? "",
    available: jobStop?.available === true,
    stoppable: stopTarget?.stoppable === true,
  });
  const target = stopTarget && jobStop ? stopTarget : null;
  let reason: string | null = null;
  if (jobStop && !jobStop.available) reason = jobStop.reason;
  else if (historicalRecovery) {
    reason = (state === "continuation_blocked"
      ? "These historical job records have no confirmed end. Wollipog cannot verify that the jobs are still running. "
      : "These historical results have no recorded return step. Wollipog will not resubmit them automatically. ") +
      "Review the conversation before recovering. Open More Actions and choose Restart Session to recover in a new conversation. " +
      (restartReportsResult
        ? "Restart ends every job and reports held results; it does not rerun their original commands."
        : "Restart ends every job and discards held results; it does not rerun their original commands.");
  } else if (jobStop && !target) {
    if (unfinishedListed > 1) reason = "Open one of the unfinished jobs below to stop it.";
    else if (unfinishedUnlisted) reason = "The unfinished job isn't in this list, so it can't be stopped here.";
  }
  let outcome: ReactNode = null;
  if (target && jobStop?.available) {
    if (stop.feedback?.state === "stopped") outcome = <p className="background-recovery-note" role="status">{STOP_JOB_STOPPED}</p>;
    else if (stop.feedback?.state === "already_terminal") outcome = <p className="background-recovery-note" role="status">{STOP_JOB_ALREADY_ENDED}</p>;
    else if (stop.feedback?.state === "error") outcome = <p className="background-recovery-note notice-error" role="alert">{stop.feedback.message}</p>;
  }
  const button = target && stop.offered && (
    jobStop?.available
      ? (
        <BusyButton className="btn sm" busy={stop.busy} progress="Stopping…" onClick={() => void stop.stop()}>
          Stop {target.label}…
        </BusyButton>
      )
      : <button type="button" className="btn sm" disabled aria-describedby={reasonId}>Stop {target.label}…</button>
  );
  return (
    <Notice
      tone="warning"
      title={BACKGROUND_DELIVERY_STATUS[state].label}
      className="background-recovery-notice"
      dataState={state}
      actions={(blockedAcknowledgement || button || outcome) && <>
        {blockedAcknowledgement && <BusyButton className="btn sm" busy={blockedAcknowledgement.busy}
          progress="Acknowledging blocked results…" onClick={blockedAcknowledgement.onAcknowledge}>Acknowledge</BusyButton>}
        {button}{outcome}
      </>}
      details={(
        <dl className="facts">
          <div><dt>Finished</dt><dd><RecordedTime at={finishedAt} now={now} /></dd></div>
          <div><dt>Other Ways</dt><dd>{blockedResultSessionAlternative(restartReportsResult)}</dd></div>
          <Diagnostic state={state} />
        </dl>
      )}
    >
      <p>{state === "terminal_without_continuation"
        ? "Finished historical results need an explicit recovery step."
        : unknownParentTurn
        ? "Finished background results are held by historical job records whose parent turn is unknown."
        : unverifiedUnfinished
          ? "Finished background results are held because another job has no confirmed end."
          : backgroundRecoverySentence(state, subject)}</p>
      {blockedAcknowledgement && <p>{ACKNOWLEDGE_BLOCKED_RESULT_EFFECT}</p>}
      {reason && <p id={reasonId}>{reason}</p>}
    </Notice>
  );
}
