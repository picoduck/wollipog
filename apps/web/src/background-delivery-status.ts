import type { BackgroundDeliveryView, BackgroundDeliveryWatchdogState, ManagedBackgroundJobView } from "@wollipog/protocol";
import type { ApiClient } from "./api.js";
import { backgroundJobSentenceName } from "./background-job-stop.js";

/** `pending` progresses on its own; `blocked` and `missing` do not and ask for a step. */
export type BackgroundDeliverySeverity = "pending" | "blocked" | "missing";

export interface BackgroundDeliveryStatusCopy {
  label: string;
  description: string;
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
    recovery: "Wollipog is returning the result automatically.",
    action: "No action is needed.",
    diagnostic: "The job is terminal, but no continuation has been recorded.",
    severity: "pending",
  },
  continuation_blocked: {
    label: "Result Blocked",
    description: "A background job finished, but its result cannot be returned while another job from the same turn is still running.",
    recovery: "Wollipog returns the result automatically once the remaining job ends. It ends that job itself only when a queued handoff has waited on it past its bound.",
    action: "Ask the session to stop the unfinished job (a monitor that never fires ends only with its provider process); stopping or restarting the session also ends that job, together with every other job.",
    diagnostic: "The job is terminal, but a sibling job from its parent turn has no terminal status, so no continuation can be recorded.",
    severity: "blocked",
  },
  accepted_without_result: {
    label: "Result Missing",
    description: "A background job finished, but its result is missing after Wollipog accepted the return step.",
    recovery: "Wollipog will not repeat an accepted step automatically because that could duplicate work.",
    action: "Acknowledge the missing result to clear immediate attention without retrying the continuation.",
    diagnostic: "The accepted provider turn ended without a durable delivery receipt.",
    severity: "missing",
  },
  result_not_projected: {
    label: "Transcript Delayed",
    description: "A background result reached Wollipog, but it has not appeared in this conversation yet.",
    recovery: "Wollipog is updating the transcript automatically.",
    action: "No action is needed.",
    diagnostic: "The runner result was recorded, but transcript projection is pending.",
    severity: "pending",
  },
  dashboard_observation_pending: {
    label: "Notification Pending",
    description: "A background result reached the conversation, but this dashboard has not yet confirmed the update.",
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

/** What a recovery notice names (#2859): the one job it is about, or how many when it is several or
 * none of them is listed. */
export type BackgroundRecoverySubject = { job: string } | { count: number };

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function subjectName(subject: BackgroundRecoverySubject): string {
  if ("job" in subject) return subject.job;
  return subject.count === 1 ? "a background job" : `${subject.count} background jobs`;
}

function subjectResult(subject: BackgroundRecoverySubject): string {
  if ("job" in subject) return `${subject.job}'s result`;
  return subject.count === 1 ? "the result of a background job" : `the result of ${subject.count} background jobs`;
}

const singular = (subject: BackgroundRecoverySubject) => "job" in subject || subject.count === 1;

/**
 * A recovery notice's one sentence (#2859), naming the job: "Shell job a1f3c9 finished, but its result
 * never reached this conversation. …" for Result Missing, "Returning shell job a1f3c9's result to this
 * conversation." for Result Pending. The notice's action, or none, is the rest of what the person needs.
 */
export function backgroundRecoverySentence(
  state: BackgroundDeliveryWatchdogState,
  subject: BackgroundRecoverySubject,
): string {
  const its = singular(subject) ? "its" : "their";
  switch (state) {
    case "accepted_without_result":
      return `${capitalize(subjectName(subject))} finished, but ${its} result never reached this conversation. ` +
        "Wollipog won't retry on its own, so the step can't run twice.";
    case "continuation_blocked":
      return `${capitalize(subjectName(subject))} finished, but ${its} result can't be returned while another job ` +
        "from the same turn is still running.";
    case "terminal_without_continuation":
      return `Returning ${subjectResult(subject)} to this conversation.`;
    case "result_not_projected":
      return `${capitalize(subjectResult(subject))} reached Wollipog and is being added to this conversation.`;
    case "dashboard_observation_pending":
      return `Confirming that this dashboard shows ${subjectResult(subject)}.`;
  }
}

/**
 * The Lost notice's sentence (#2859): "Studio Workstation restarted while monitor job 7be210 was
 * running, so its result can't come back to this conversation." `machine` is the person's name for it.
 */
export function backgroundLostSentence(
  machine: string | null,
  lostJobs: readonly Pick<ManagedBackgroundJobView, "launchType" | "id">[],
): string {
  const where = machine ?? "The machine";
  if (lostJobs.length > 1) {
    return `${where} restarted while ${lostJobs.length} background jobs were running, so their results can't come back ` +
      "to this conversation.";
  }
  const job = lostJobs.length === 1 ? backgroundJobSentenceName(lostJobs[0]!) : "a background job";
  return `${where} restarted while ${job} was running, so its result can't come back to this conversation.`;
}

/** What Result Missing's Acknowledge does, as its Show Details says it. */
export const ACKNOWLEDGE_MISSING_RESULT_EFFECT = "Clears the alert. It doesn't rerun the job or resend the result.";

/**
 * Result Blocked's other ways out, behind its Show Details (#1779, #2859): stopping or restarting the
 * session ends the unfinished job too, at a cost. `restartReportsResult` says the runner's restart hands
 * this result to the new conversation rather than discarding it (v191).
 */
export function blockedResultSessionAlternative(restartReportsResult: boolean): string {
  return restartReportsResult
    ? "Stopping the session also ends the unfinished job but discards this result. Restarting the session ends " +
      "every job and reports this result to the new conversation."
    : "Restarting or stopping the session also ends the unfinished job, but ends every other job and discards " +
      "this result.";
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
