import type { BackgroundDeliveryWatchdogState } from "@wollipog/protocol";

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
    recovery: "Wollipog returns the result automatically once the remaining job ends, but it cannot end that job itself.",
    action: "Ask the session to stop the unfinished job (a monitor that never fires ends only with its provider process), or restart the session to recover the finished result.",
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

export function backgroundDeliveryAccessibleName(state: BackgroundDeliveryWatchdogState): string {
  const status = BACKGROUND_DELIVERY_STATUS[state];
  return `Background Work: ${status.label}. ${status.description}`;
}

export function backgroundDeliveryAttentionDescription(state: BackgroundDeliveryWatchdogState): string {
  const status = BACKGROUND_DELIVERY_STATUS[state];
  return `${status.description} ${status.recovery} ${status.action}`;
}
