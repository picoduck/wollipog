import type { SessionActivity } from "../activity.js";
import { memo } from "react";
import { activitySeries } from "../activity.js";

/** The compact strip's accessible name and tooltip (#2209). */
export const ACTIVITY_STRIP_LABEL = "Tool activity in the last 30 minutes";

function ActivityStripInner({
  activity,
  now,
  compact = false,
  className,
}: {
  activity?: SessionActivity;
  now: number;
  /** The 48×12px strip on a Sessions row's status line (#2209): a named image with a tooltip. */
  compact?: boolean;
  className?: string;
}) {
  const series = activitySeries(activity, now);
  const peak = Math.max(1, ...series);
  const latestActive = (series.at(-1) ?? 0) > 0;

  return (
    <span
      className={`activity-strip${compact ? " compact" : ""}${latestActive ? " live" : ""}${className ? ` ${className}` : ""}`}
      role={compact ? "img" : undefined}
      aria-label={compact ? ACTIVITY_STRIP_LABEL : undefined}
      title={compact ? ACTIVITY_STRIP_LABEL : undefined}
      aria-hidden={compact ? undefined : "true"}
    >
      {series.map((count, index) => {
        const level = count > 0 ? Math.max(0.2, count / peak) : 0;
        return (
          <span
            // The tagged ring always projects one cell per minute, so the minute index is stable.
            key={index}
            className={`activity-strip-bar${count > 0 ? " active" : ""}`}
            style={{ height: `${2 + level * (compact ? 10 : 14)}px` }}
          />
        );
      })}
    </span>
  );
}

/**
 * Memoised: this renders once per row, and its parent re-renders on every store update — a session
 * status change anywhere in the inbox re-rendered every row in it. The props are primitives and
 * stable callbacks, so a shallow compare is the right guard.
 */
export const ActivityStrip = memo(ActivityStripInner);
