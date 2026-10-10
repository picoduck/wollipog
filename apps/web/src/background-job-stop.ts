import {
  BACKGROUND_JOB_STALL_MS,
  runnerCapabilityRequirement,
  runnerSupportsProtocol,
  type BackgroundDeliveryView,
  type BackgroundWorkState,
  type ManagedBackgroundJobView,
  type SessionView,
} from "@wollipog/protocol";
import type { ApiClient } from "./api.js";
import { titleCaseLabel } from "./format.js";
import { sessionCommandRefusal } from "./session-command-permissions.js";

/** Whether a surface can offer Stop Job for this session's background jobs (#1780), and if not, why. */
export type BackgroundJobStopAvailability = { available: true } | { available: false; reason: string };

/**
 * Stop Job ends one managed background job through the runner, without ending the session. Only a
 * Claude Code session has managed jobs to stop. `null` means the action does not apply at all, so
 * no control is shown; a person the server would refuse (#1843), or an older or offline runner,
 * shows it as unavailable with the reason.
 */
export function backgroundJobStopAvailability(
  session: Pick<SessionView, "driver" | "backgroundWorkTracking" | "commandPermissions">,
  runnerProtocolVersion: number | null | undefined,
  runnerOnline: boolean,
): BackgroundJobStopAvailability | null {
  if (session.driver !== "claude-code" || session.backgroundWorkTracking === "untracked") return null;
  const refusal = sessionCommandRefusal(session, "stopBackgroundJob");
  if (refusal) return { available: false, reason: refusal };
  if (!runnerSupportsProtocol(runnerProtocolVersion, "backgroundJobStop")) {
    return { available: false, reason: runnerCapabilityRequirement(runnerProtocolVersion, "backgroundJobStop", "stopping a background job") };
  }
  if (!runnerOnline) return { available: false, reason: "The runner is offline." };
  return { available: true };
}

/** A job's current state, as a key of the shared job vocabulary (`statusMeta("job", …)`). */
export type BackgroundJobCurrentState =
  | "running"
  | "stalled"
  | "completed"
  | "failed"
  | "killed"
  | "lost"
  | "unverified";

export function backgroundJobCurrentState(
  job: ManagedBackgroundJobView,
  backgroundWorkState: BackgroundWorkState | undefined,
  runnerOnline: boolean,
  inventorySupported: boolean,
  now?: number,
): BackgroundJobCurrentState {
  if (job.terminalStatus === "completed") return "completed";
  if (job.terminalStatus === "failed") return "failed";
  if (job.terminalStatus === "killed") return "killed";
  if (backgroundWorkState === "orphaned" && job.sourcePresent) return "lost";
  const aggregateCurrent = backgroundWorkState === "running" ||
    backgroundWorkState === "continuation_pending";
  if (!(aggregateCurrent && inventorySupported && runnerOnline && job.sourcePresent)) return "unverified";
  // A job the runner still lists with no terminal status past the bound is reported, not declared
  // ended (#1651). The control plane marks it on read; the clock keeps the label current between
  // broadcasts.
  const stalled = job.stalledSince != null ||
    (now != null && now - job.registeredAt >= BACKGROUND_JOB_STALL_MS);
  return stalled ? "stalled" : "running";
}

/** Only a job the runner still lists as running can be stopped; any other state has nothing to end. */
export function stoppableJobState(state: BackgroundJobCurrentState): boolean {
  return state === "running" || state === "stalled";
}

/** A job's kind, the first part of its name: "Shell Job", "Monitor Job", "Background Job". */
export function backgroundJobKind(job: Pick<ManagedBackgroundJobView, "launchType">): string {
  return titleCaseLabel(job.launchType === "unknown" ? "Background Job" : `${job.launchType} Job`);
}

/** The last six characters of a job's id, which tell two jobs of one kind apart in every turn (#2858). */
export function backgroundJobShortId(job: Pick<ManagedBackgroundJobView, "id">): string {
  return job.id.slice(-6);
}

/**
 * A job's name everywhere it is shown (#2858): its kind and the end of its id, "Shell Job a1f3c9".
 * The id makes it unique across turns, so two jobs never share a name. A row sets the id in `.mono`
 * `--text-faint` from the two parts; a sentence, a page title or a dialog title uses this whole.
 */
export function backgroundJobLabel(job: Pick<ManagedBackgroundJobView, "launchType" | "id">): string {
  return `${backgroundJobKind(job)} ${backgroundJobShortId(job)}`;
}

/** What Stop Job does, as its confirmation says it. */
export const STOP_JOB_OUTCOME =
  "Only this job ends, and it is recorded as killed. The session, its conversation, and its other jobs keep running.";

/** Said when the job had ended on its own before the Stop arrived. */
export const STOP_JOB_ALREADY_ENDED = "This job had already ended, so nothing was changed.";

export type BackgroundJobStopResult =
  | { state: "stopped" }
  | { state: "already_terminal" }
  | { state: "error"; message: string };

/** Stop Job's one request (#1780), shared by the Job Detail page (#2858) and the Session Status popover. */
export function requestBackgroundJobStop(
  api: Pick<ApiClient, "stopBackgroundJob">,
  sessionId: string,
  jobId: string,
): Promise<BackgroundJobStopResult> {
  return api.stopBackgroundJob(sessionId, jobId)
    .then((result): BackgroundJobStopResult => ({ state: result.outcome === "stopped" ? "stopped" : "already_terminal" }))
    .catch((error: unknown): BackgroundJobStopResult => ({
      state: "error",
      message: error instanceof Error ? error.message : "The job could not be stopped.",
    }));
}

/** The one job Stop Job would end to unblock a Result Blocked delivery. */
export interface BlockedDeliveryStopTarget {
  jobId: string;
  jobLabel: string;
}

/**
 * The job to stop for a Result Blocked delivery, where the Session Status popover offers Stop Job
 * itself (#2275): Stop Job is available, exactly one job of the blocked turn is unfinished, and it is
 * the one listed job still running. With none listed, several, or Stop Job unavailable, it is `null` and the popover opens
 * Background Work instead, which lists the jobs and says why.
 */
export function blockedDeliveryStopTarget(
  session: Pick<SessionView, "driver" | "backgroundWorkTracking" | "commandPermissions" | "backgroundJobs" |
    "backgroundJobsTruncated" | "backgroundWorkState">,
  delivery: Pick<BackgroundDeliveryView, "parentTurnId" | "watchdogState" | "unfinishedSiblingJobs">,
  runnerProtocolVersion: number | null | undefined,
  runnerOnline: boolean,
): BlockedDeliveryStopTarget | null {
  if (delivery.watchdogState !== "continuation_blocked" || delivery.parentTurnId === "unknown") return null;
  if (!backgroundJobStopAvailability(session, runnerProtocolVersion, runnerOnline)?.available) return null;
  // The listed inventory is bounded, so one listed running job proves nothing on its own: the
  // control plane's full count of unfinished siblings must be one too. Without that count, only a
  // complete inventory can say so.
  if (delivery.unfinishedSiblingJobs !== undefined ? delivery.unfinishedSiblingJobs !== 1 : session.backgroundJobsTruncated) {
    return null;
  }
  const inventorySupported = runnerSupportsProtocol(runnerProtocolVersion, "managedBackgroundInventory");
  const stoppable = (session.backgroundJobs ?? []).filter((job) => job.parentTurnId === delivery.parentTurnId &&
    stoppableJobState(backgroundJobCurrentState(job, session.backgroundWorkState, runnerOnline, inventorySupported)));
  if (stoppable.length !== 1) return null;
  const job = stoppable[0]!;
  return { jobId: job.id, jobLabel: backgroundJobLabel(job) };
}
