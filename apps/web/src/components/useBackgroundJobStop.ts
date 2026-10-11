import { useEffect, useRef, useSyncExternalStore } from "react";
import { useApi } from "../api-context.js";
import { STOP_JOB_OUTCOME, requestBackgroundJobStop, type BackgroundJobStopResult } from "../background-job-stop.js";
import { useFeedback } from "./FeedbackProvider.js";

export type BackgroundJobStopFeedback = { state: "pending" } | BackgroundJobStopResult;

/**
 * Each job's Stop Job request and its outcome, for the life of the page. The request outlives the
 * surface that sent it: Back and reopening the job, or the job's Result Blocked notice, shows it still
 * stopping, so a second request is never sent while the first runs, and its outcome lands wherever
 * the job is shown. A job is keyed by its session, id and start time: after a restart a provider can
 * reuse a task id for a new job, which must not inherit the old job's outcome.
 */
const stopFeedback = new Map<string, BackgroundJobStopFeedback>();
const stopListeners = new Set<() => void>();
const stopKey = (sessionId: string, jobId: string, registeredAt: number) =>
  JSON.stringify([sessionId, jobId, registeredAt]);
function setStopFeedback(key: string, feedback: BackgroundJobStopFeedback) {
  stopFeedback.set(key, feedback);
  for (const listener of stopListeners) listener();
}
function subscribeStopFeedback(listener: () => void) {
  stopListeners.add(listener);
  return () => { stopListeners.delete(listener); };
}

/**
 * Stop Job for one job (#1780, #2858), shared by the Job Detail page and a Result Blocked notice
 * (#2859): it asks first, in the shared danger confirmation titled with the job's name, with Cancel
 * focused; the runner then ends only that job. `offered` is false once the job is gone or stopped.
 */
export function useBackgroundJobStop({ sessionId, jobId, registeredAt, label, available, stoppable }: {
  sessionId: string;
  jobId: string;
  registeredAt: number;
  label: string;
  available: boolean;
  stoppable: boolean;
}) {
  const api = useApi();
  const { confirm } = useFeedback();
  const key = stopKey(sessionId, jobId, registeredAt);
  const feedback = useSyncExternalStore(subscribeStopFeedback, () => stopFeedback.get(key) ?? null);
  // What the surface shows now, read once the confirmation answers: it can stay open while the job
  // ends, leaves the list, or is replaced by a new job under the same id after a restart (#1779).
  const shown = useRef({ mounted: false, registeredAt, stoppable, available });
  shown.current = { ...shown.current, registeredAt, stoppable, available };
  useEffect(() => {
    shown.current.mounted = true;
    return () => { shown.current.mounted = false; };
  }, []);
  const stop = async () => {
    if (stopFeedback.get(key)?.state === "pending") return;
    const confirmed = await confirm({
      title: `Stop ${label}`,
      message: STOP_JOB_OUTCOME,
      confirmLabel: "Stop Job",
      tone: "danger",
    });
    if (!confirmed) return;
    // The request names only the session and the job id, so it is sent only while the surface still
    // shows the very job that was confirmed, still stoppable.
    const now = shown.current;
    if (!now.mounted || now.registeredAt !== registeredAt || !now.stoppable || !now.available) return;
    // Another surface showing the same job may have sent it while this confirmation was open.
    if (stopFeedback.get(key)?.state === "pending") return;
    setStopFeedback(key, { state: "pending" });
    setStopFeedback(key, await requestBackgroundJobStop(api, sessionId, jobId));
  };
  // Once stopped, the job is no longer stoppable and the button goes; its outcome stays.
  const offered = stoppable && feedback?.state !== "stopped" && feedback?.state !== "already_terminal";
  return { feedback, offered, busy: feedback?.state === "pending", stop };
}
