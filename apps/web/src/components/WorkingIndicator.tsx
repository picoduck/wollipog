import { useEffect, useId, useState } from "react";
import { formatDuration } from "../format.js";
import { statusMeta } from "../status-meta.js";
import type { ActiveTurnProgress } from "../turn-progress.js";
import { useOptionalStoreSelector } from "../store.js";
import { StatusBadge } from "./StatusBadge.js";

export const ACTIVE_TURN_CLOCK_INTERVAL_MS = 1_000;
/** No activity for this long is worth saying on the exception line ("No new output for 2m"). */
export const ACTIVE_TURN_SILENCE_MS = 120_000;

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

/** Whole minutes under an hour ("3m"), so a silence that is still growing does not tick each second. */
function silenceLabel(silentMs: number): string {
  const minutes = Math.floor(silentMs / 60_000);
  return minutes < 60 ? `${minutes}m` : formatDuration(silentMs);
}

/** Live "agent is working" row at the tail of the transcript while a turn is in flight.
 *
 * One line in a fixed order: the state, the elapsed time, the current step (a link that reveals it
 * in the transcript) and at most one action. A pending approval or question outranks progress: its
 * attention badge takes the state slot and the action is Review. Failures, retries and silence get
 * a second line only when they happen; zero counts never render (#2170). */
export function WorkingIndicator({
  label,
  progress,
  onRevealCurrentOperation,
  onOpenSubagent,
  onReviewPendingRequest,
  now: nowOverride,
  liveActivitySessionId,
}: {
  label?: string;
  progress?: ActiveTurnProgress | null;
  onRevealCurrentOperation?: (eventId: number) => void;
  onOpenSubagent?: (subagentId: string) => void;
  /** Moves focus to the pending request that is blocking the turn. */
  onReviewPendingRequest?: (requestId: string) => void;
  /** Deterministic rendering for focused component coverage; production uses the shared clock. */
  now?: number;
  /** The live session whose heartbeat also counts as activity. A chunk that only lengthens the
   * reply does not render the view that computes `progress`, so silence reads it here (#2763). */
  liveActivitySessionId?: string;
}) {
  const clockNow = useActiveTurnClock(nowOverride == null);
  const liveActivityAt = useOptionalStoreSelector((state) => liveActivitySessionId === undefined
    ? undefined
    : state.activity.get(liveActivitySessionId)?.lastEventAt ?? undefined);
  const lastActivityAt = progress && liveActivityAt != null
    ? Math.max(progress.lastActivityAt ?? Number.NEGATIVE_INFINITY, liveActivityAt)
    : progress?.lastActivityAt;
  const [mountedAt] = useState(() => Date.now());
  const tooltipId = useId();
  const now = Math.max(
    nowOverride ?? clockNow,
    progress?.turnStartedAt ?? Number.NEGATIVE_INFINITY,
    lastActivityAt ?? Number.NEGATIVE_INFINITY,
  );
  // The turn start is authoritative when observed; the mount clock is only the pre-event fallback,
  // and it stays quiet for the first moments so an instant turn does not flash "0s".
  const elapsedMs = progress?.turnStartedAt != null
    ? Math.max(0, now - progress.turnStartedAt)
    : Math.max(0, (nowOverride ?? clockNow) - mountedAt);
  const elapsed = elapsedMs >= 2_000 ? formatDuration(elapsedMs) : null;
  const operation = progress?.currentOperation;
  const step = operation?.title ?? label;
  const waiting = progress?.waitingReason;
  const attention = waiting
    ? statusMeta("attention", waiting.kind === "question" ? "answer_required" : "approval_required")
    : null;
  const failed = progress?.failedTools ?? 0;
  const retry = progress?.retryGroup;
  // Waiting on the person is not silence: the agent has nothing to say until they answer.
  const quietSince = lastActivityAt ?? progress?.turnStartedAt;
  const silentMs = !waiting && quietSince != null ? now - quietSince : 0;
  const silence = silentMs >= ACTIVE_TURN_SILENCE_MS ? `No new output for ${silenceLabel(silentMs)}` : null;
  const stepDetails = [
    "Show this step in the transcript.",
    progress?.completedTools ? `${progress.completedTools} completed.` : null,
    progress?.currentPlanStep ? `Plan step: ${progress.currentPlanStep.content}` : null,
  ].filter((detail): detail is string => detail !== null);
  // Announce what changed state, never the step or the clock: a screen reader hears "Working",
  // "Approval Required" or a new failure once, not every tool call or elapsed second.
  const announcement = [attention?.label ?? "Working", failed > 0 ? `${failed} failed` : null]
    .filter(Boolean)
    .join(", ");

  return (
    <section className="tl-working" aria-label="Active Turn Progress">
      <div className="tl-working-line">
        {attention ? (
          <StatusBadge meta={attention} className="tl-working-attention" />
        ) : (
          <>
            <span className="working-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="tl-working-state">Working</span>
          </>
        )}
        {elapsed && <span className="tl-working-elapsed">{elapsed}</span>}
        {step && (
          <span className="tl-working-step">
            {operation && onRevealCurrentOperation ? (
              <>
                <button
                  type="button"
                  className="link tl-working-step-text"
                  aria-describedby={tooltipId}
                  onClick={() => onRevealCurrentOperation(operation.eventId)}
                >
                  {operation.title}
                </button>
                <span id={tooltipId} className="tl-tooltip" role="tooltip">
                  {stepDetails.map((detail, index) => (
                    <span key={detail} className="tl-working-tip">{index > 0 ? " " : ""}{detail}</span>
                  ))}
                </span>
              </>
            ) : (
              <span className="tl-working-step-text">{step}</span>
            )}
          </span>
        )}
        {waiting && onReviewPendingRequest ? (
          <button type="button" className="btn sm ghost tl-working-action" onClick={() => onReviewPendingRequest(waiting.requestId)}>
            Review
          </button>
        ) : operation?.subagentId && onOpenSubagent ? (
          <button type="button" className="btn sm ghost tl-working-action" onClick={() => onOpenSubagent(operation.subagentId!)}>
            Open Agent
          </button>
        ) : null}
      </div>
      {(failed > 0 || retry || silence) && (
        <p className="tl-working-note">
          {failed > 0 && <span className="tl-working-failed">{failed} failed</span>}
          {retry && (
            <span className="tl-working-retry" title={retry.latestError}>
              {`Retried ${retry.retries} ${retry.retries === 1 ? "time" : "times"}: ${retry.latestError}`}
            </span>
          )}
          {silence && <span className="tl-working-silence">{silence}</span>}
        </p>
      )}
      <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </section>
  );
}
