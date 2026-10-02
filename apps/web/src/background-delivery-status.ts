import type { BackgroundDeliveryView, BackgroundDeliveryWatchdogState } from "@wollipog/protocol";
import type { ApiClient } from "./api.js";
import type { BackgroundJobStopAvailability } from "./background-job-stop.js";

/** `pending` progresses on its own; `blocked` and `missing` do not and ask for a step. */
export type BackgroundDeliverySeverity = "pending" | "blocked" | "missing";

export interface BackgroundDeliveryStatusCopy {
  label: string;
  description: string;
  completed: string;
  outstanding: string;
  recovery: string;
  action: string;
  diagnostic: string;
  severity: BackgroundDeliverySeverity;
}

/** User-facing copy for a delivery watchdog, shared by every surface that presents one. */
export const BACKGROUND_DELIVERY_STATUS: Record<BackgroundDeliveryWatchdogState, BackgroundDeliveryStatusCopy> = {
  terminal_without_continuation: {
    label: "Result Pending",
    description: "A background job finished, but its result has not yet been returned to this conversation.",
    completed: "The background job finished.",
    outstanding: "Its result has not yet been returned to this conversation.",
    recovery: "Wollipog is returning the result automatically.",
    action: "No action is needed.",
    diagnostic: "The job is terminal, but no continuation has been recorded.",
    severity: "pending",
  },
  continuation_blocked: {
    label: "Result Blocked",
    description: "A background job finished, but its result cannot be returned while another job from the same turn is still running.",
    completed: "The background job finished.",
    outstanding: "Its result waits until every job started by the same turn has finished.",
    recovery: "Wollipog returns the result automatically once the remaining job ends. It ends that job itself only when a queued handoff has waited on it past its bound.",
    action: "Ask the session to stop the unfinished job (a monitor that never fires ends only with its provider process); stopping or restarting the session also ends that job, together with every other job.",
    diagnostic: "The job is terminal, but a sibling job from its parent turn has no terminal status, so no continuation can be recorded.",
    severity: "blocked",
  },
  accepted_without_result: {
    label: "Result Missing",
    description: "A background job finished, but its result is missing after Wollipog accepted the return step.",
    completed: "The background job finished and Wollipog accepted the return step.",
    outstanding: "The result did not arrive in this conversation.",
    recovery: "Wollipog will not repeat an accepted step automatically because that could duplicate work.",
    action: "Acknowledge the missing result to clear immediate attention without retrying the continuation.",
    diagnostic: "The accepted provider turn ended without a durable delivery receipt.",
    severity: "missing",
  },
  result_not_projected: {
    label: "Transcript Delayed",
    description: "A background result reached Wollipog, but it has not appeared in this conversation yet.",
    completed: "Wollipog received the background result.",
    outstanding: "The result has not appeared in this conversation yet.",
    recovery: "Wollipog is updating the transcript automatically.",
    action: "No action is needed.",
    diagnostic: "The runner result was recorded, but transcript projection is pending.",
    severity: "pending",
  },
  dashboard_observation_pending: {
    label: "Notification Pending",
    description: "A background result reached the conversation, but this dashboard has not yet confirmed the update.",
    completed: "The background result reached the conversation and a notification was queued.",
    outstanding: "This dashboard has not yet confirmed the update.",
    recovery: "Wollipog is waiting for the dashboard confirmation automatically.",
    action: "No action is needed.",
    diagnostic: "A notification was queued, but dashboard observation is pending.",
    severity: "pending",
  },
};

/** A watchdog state that waits on the person rather than on Wollipog: Result Blocked and Result
 * Missing (#2275). The Session Status ranking counts it with their requests. */
export function backgroundDeliveryNeedsYou(state: BackgroundDeliveryWatchdogState): boolean {
  return BACKGROUND_DELIVERY_STATUS[state].severity !== "pending";
}

/**
 * The background delivery a session shows when it has several (#2329): the first whose watchdog
 * state waits on the person (Result Blocked or Result Missing), otherwise the first with any
 * watchdog state. The Session Status ranking, the Pinned Summary and Sessions preview badges, the
 * session reminder and the Background Work panel's highlight all take it from here, so every surface
 * names the same delivery.
 */
export function shownWatchdogDelivery<T extends Pick<BackgroundDeliveryView, "watchdogState">>(
  deliveries: readonly T[] | undefined,
): (T & { watchdogState: BackgroundDeliveryWatchdogState }) | undefined {
  const watched = (deliveries ?? []).filter((delivery): delivery is T & {
    watchdogState: BackgroundDeliveryWatchdogState;
  } => delivery.watchdogState != null);
  return watched.find((delivery) => backgroundDeliveryNeedsYou(delivery.watchdogState)) ?? watched[0];
}

/**
 * The step a watchdog state asks for, where the surface knows whether this runner can stop one job
 * (#1780). Result Blocked then offers Stop Job, or says why it is unavailable; every other state,
 * and a surface that does not know, keeps the shared copy. `restartReportsResult` says the runner's
 * restart hands this result to the new conversation rather than discarding it (v191, #1779).
 */
export function backgroundDeliveryAction(
  state: BackgroundDeliveryWatchdogState,
  jobStop?: BackgroundJobStopAvailability | null,
  stoppableJobListed = true,
  restartReportsResult = false,
): string {
  const status = BACKGROUND_DELIVERY_STATUS[state];
  if (state !== "continuation_blocked" || !jobStop) return status.action;
  if (jobStop.available) {
    const where = stoppableJobListed
      ? "Use Stop Job on the unfinished job below"
      : "Use Stop Job on the unfinished job from the same turn, listed in Background Work";
    return `${where}: only that job ends, it is recorded as killed, and this result is then returned. ` +
      (restartReportsResult
        ? "Stopping the session also ends it but discards this result; restarting the session ends every job " +
          "and reports this result to the new conversation instead."
        : "Restarting or stopping the session also ends it, but ends every other job and discards this result.");
  }
  return `Stop Job is unavailable: ${jobStop.reason} ${status.action}`;
}

/** The continuation a Result Missing delivery's Acknowledge Missing Result applies to, or `null` when
 * there is nothing left to acknowledge (#2275). */
export function missingResultContinuationId(
  delivery: Pick<BackgroundDeliveryView, "watchdogState" | "continuationId" | "missingResultAt" |
    "missingResultAcknowledgedAt" | "runnerResultPersistedAt">,
): string | null {
  if (delivery.watchdogState !== "accepted_without_result" || !delivery.continuationId) return null;
  if (delivery.missingResultAcknowledgedAt != null || delivery.runnerResultPersistedAt != null) return null;
  return delivery.continuationId;
}

/** Acknowledge Missing Result's one request, shared by the Background Work panel and the Session
 * Status popover. It resolves to the failure's sentence, or `null` once acknowledged. */
export function requestMissingResultAcknowledgement(
  api: Pick<ApiClient, "acknowledgeBackgroundMissingResult">,
  sessionId: string,
  continuationId: string,
): Promise<string | null> {
  return api.acknowledgeBackgroundMissingResult(sessionId, continuationId)
    .then(() => null)
    .catch((error: unknown) => error instanceof Error ? error.message : "Missing-result acknowledgement failed.");
}

export function backgroundDeliveryAccessibleName(state: BackgroundDeliveryWatchdogState): string {
  const status = BACKGROUND_DELIVERY_STATUS[state];
  return `Background Work: ${status.label}. ${status.description}`;
}

export function backgroundDeliveryAttentionDescription(state: BackgroundDeliveryWatchdogState): string {
  const status = BACKGROUND_DELIVERY_STATUS[state];
  return `${status.description} ${status.recovery} ${status.action}`;
}
