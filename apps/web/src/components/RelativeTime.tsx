import { useEffect, useState } from "react";
import { relativeTime } from "../format.js";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long until `relativeTime` reads differently for something `diff` ms old. It shows "just now"
 * below five seconds, then rounds to the second, minute, hour or day, so a reading changes half a
 * unit past each whole one, and when it moves on to the next unit.
 */
export function relativeTimeChangesIn(diff: number): number {
  if (diff < 5 * SECOND) return 5 * SECOND - diff;
  const [unit, nextUnitAt] = diff < MINUTE ? [SECOND, MINUTE] : diff < HOUR ? [MINUTE, HOUR] : diff < DAY ? [HOUR, DAY] : [DAY, Infinity];
  const nextRound = unit - ((diff + unit / 2) % unit) || unit;
  return Math.min(nextRound, nextUnitAt - diff);
}

/**
 * `relativeTime(at)`, rendering its caller again whenever that reading changes (#2872). An age read
 * from the clock only as its component rendered moved on while something else kept rendering it,
 * such as a session view rendering four times a second while an agent streamed.
 */
export function useRelativeTime(at: number | null | undefined): string {
  const [, setTick] = useState(0);
  const text = relativeTime(at ?? null);
  useEffect(() => {
    if (!at) return undefined;
    // A little past the change, so the next reading has moved on.
    const timer = setTimeout(() => setTick((tick) => tick + 1), relativeTimeChangesIn(Date.now() - at) + 20);
    return () => clearTimeout(timer);
  });
  return text;
}

/** `relativeTime(at)` that keeps itself current. */
export function RelativeTime({ at }: { at: number }) {
  return <>{useRelativeTime(at)}</>;
}
