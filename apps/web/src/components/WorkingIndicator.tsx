import { useEffect, useState } from "react";
import { formatDuration, formatRecordedRelativeTime, formatRecordedTimestamp } from "../format.js";
import type { ActiveTurnProgress } from "../turn-progress.js";

export const ACTIVE_TURN_CLOCK_INTERVAL_MS = 1_000;

function useActiveTurnClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ACTIVE_TURN_CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** Live "agent is working" row at the tail of the transcript while a turn is in flight.
 *
 * This row is the single active-turn surface: the IDEA-006 progress facts (current operation,
 * waiting reason, elapsed, last activity, tool counts, retries, plan step) render here instead of
 * a separate card above the composer, so live state reads in the same place as the work itself. */
export function WorkingIndicator({
  label,
  progress,
  onRevealCurrentOperation,
  onOpenSubagent,
  now: nowOverride,
}: {
  label?: string;
  progress?: ActiveTurnProgress | null;
  onRevealCurrentOperation?: (eventId: number) => void;
  onOpenSubagent?: (subagentId: string) => void;
  /** Deterministic rendering for focused component coverage; production uses the shared clock. */
  now?: number;
}) {
  const clockNow = useActiveTurnClock(nowOverride == null);
  const [mountedAt] = useState(() => Date.now());
  const now = Math.max(
    nowOverride ?? clockNow,
    progress?.turnStartedAt ?? Number.NEGATIVE_INFINITY,
    progress?.lastActivityAt ?? Number.NEGATIVE_INFINITY,
  );
  // The turn start is authoritative when observed; the mount clock is only the pre-event fallback,
  // and it stays quiet for the first moments so an instant turn does not flash "0s".
  const elapsedMs = progress?.turnStartedAt != null
    ? Math.max(0, now - progress.turnStartedAt)
    : Math.max(0, (nowOverride ?? clockNow) - mountedAt);
  const elapsed = elapsedMs >= 2_000 ? formatDuration(elapsedMs) : null;
  const lastActivity = formatRecordedTimestamp(progress?.lastActivityAt);
  const relativeActivity = formatRecordedRelativeTime(progress?.lastActivityAt, now);
  const operation = progress?.currentOperation;
  const operationTitle = operation?.title ?? label;
  const retryLabel = progress?.retryGroup
    ? `Retried ${progress.retryGroup.retries} ${progress.retryGroup.retries === 1 ? "Time" : "Times"}`
    : null;

  return (
    <section className="tl-working" aria-label="Active Turn Progress">
      <span className="working-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {operation && onRevealCurrentOperation ? (
        <button
          type="button"
          className="tl-working-operation"
          onClick={() => onRevealCurrentOperation(operation.eventId)}
          title="Reveal this operation in the transcript."
        >
          {operation.title}
        </button>
      ) : (
        <span className="working-label">{operationTitle ?? "Working"}</span>
      )}
      {operation?.subagentId && onOpenSubagent && (
        <button type="button" className="tl-working-subagent" onClick={() => onOpenSubagent(operation.subagentId!)}>
          Open Subagent
        </button>
      )}
      {progress?.waitingReason && (
        <span className={`tl-working-waiting ${progress.waitingReason.kind}`} title={progress.waitingReason.title} role="status">
          {progress.waitingReason.label}
        </span>
      )}
      {elapsed && (
        progress ? (
          <span className="tl-working-metric"><span>Elapsed</span><strong>{elapsed}</strong></span>
        ) : (
          <span className="working-secs">{elapsed}</span>
        )
      )}
      {progress && (
        <>
          <span className="tl-working-metric">
            <span>Last Activity</span>
            {lastActivity ? (
              <time dateTime={lastActivity.dateTime} title={lastActivity.title}>{relativeActivity || "Unavailable"}</time>
            ) : <strong>{relativeActivity || "Unavailable"}</strong>}
          </span>
          <span className="tl-working-metric"><span>Completed</span><strong>{progress.completedTools}</strong></span>
          <span className={`tl-working-metric${progress.failedTools ? " failed" : ""}`}><span>Failed</span><strong>{progress.failedTools}</strong></span>
          {progress.retryGroup && (
            <span className="tl-working-retry" title={progress.retryGroup.latestError}>
              <strong>{retryLabel}</strong>
              <span>{progress.retryGroup.latestError}</span>
            </span>
          )}
          {progress.currentPlanStep && (
            <span className="tl-working-metric tl-working-plan">
              <span>Plan Step</span>
              <strong>{progress.currentPlanStep.content}</strong>
            </span>
          )}
        </>
      )}
      <span className="sr-only" role="status" aria-live="polite">{operationTitle ?? "Working"}</span>
    </section>
  );
}
