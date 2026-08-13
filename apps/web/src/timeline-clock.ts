import { useEffect, useState } from "react";
import type { SessionStatus } from "@wollipog/protocol";

export const TIMELINE_CLOCK_INTERVAL_MS = 30_000;

export function isTimelineSessionActive(status: SessionStatus): boolean {
  return status === "queued" || status === "starting" || status === "running" || status === "input_required";
}

type ClockSubscriber = (now: number) => void;

const subscribers = new Set<ClockSubscriber>();
let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let listeningDocument: Document | null = null;

function clearClockTimer(): void {
  if (clockTimer == null) return;
  clearInterval(clockTimer);
  clockTimer = null;
}

function publishClock(): void {
  clockNow = Date.now();
  for (const subscriber of subscribers) subscriber(clockNow);
}

function startClockTimer(): void {
  clearClockTimer();
  if (subscribers.size === 0 || typeof document === "undefined" || document.visibilityState === "hidden") return;
  clockTimer = setInterval(publishClock, TIMELINE_CLOCK_INTERVAL_MS);
}

function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    clearClockTimer();
    return;
  }
  publishClock();
  startClockTimer();
}

function subscribeToClock(subscriber: ClockSubscriber): () => void {
  subscribers.add(subscriber);
  if (subscribers.size === 1 && typeof document !== "undefined") {
    listeningDocument = document;
    listeningDocument.addEventListener("visibilitychange", onVisibilityChange);
    publishClock();
    startClockTimer();
  } else {
    subscriber(clockNow);
  }
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size > 0) return;
    clearClockTimer();
    listeningDocument?.removeEventListener("visibilitychange", onVisibilityChange);
    listeningDocument = null;
  };
}

/** One page-level, visible-tab clock shared by every mounted timeline and every visible row. */
export function useTimelineClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    return subscribeToClock(setNow);
  }, [enabled]);
  return now;
}
