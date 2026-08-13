import type { SessionActivity } from "../activity.js";
import { memo } from "react";
import { activitySeries } from "../activity.js";

function ActivityStripInner({
  activity,
  now,
  compact = false,
  className,
}: {
  activity?: SessionActivity;
  now: number;
  compact?: boolean;
  className?: string;
}) {
  const series = activitySeries(activity, now);
  const peak = Math.max(1, ...series);
  const latestActive = (series.at(-1) ?? 0) > 0;

  return (
    <span
      className={`activity-strip${compact ? " compact" : ""}${latestActive ? " live" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
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
