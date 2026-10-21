import {
  AUTOMATION_TARGET_INSTALLATION_UNAVAILABLE,
  type AutomationCommandView,
  type AutomationExecution,
  type AutomationSpec,
  type AutomationTriggerDeliveryMetadata,
} from "@wollipog/protocol";
import { formatDuration } from "./format.js";
import type { View } from "./navigation.js";
import type { StatusValue } from "./status-meta.js";

/*
 * An automation's Run History and Run Details in words (#2970): what each run did, when, who
 * started it and why it was skipped or gave up, never an id, a digest or a command enum.
 */

/** Rows Run History shows at first, and how many more each Show More adds. */
export const RUN_HISTORY_PAGE = 10;

/** Newest first, as the control plane lists them: by the run's scheduled time, which is unique per
 * automation, then by id. */
export function newestRunsFirst(executions: readonly AutomationExecution[]): AutomationExecution[] {
  return [...executions].sort((a, b) => b.scheduledFor - a.scheduledFor ||
    (a.executionId < b.executionId ? 1 : a.executionId > b.executionId ? -1 : 0));
}

/** When the run started; a run that never started (skipped, expired) is placed at its scheduled time. */
export function runStartedAt(execution: AutomationExecution): number {
  return execution.startedAt ?? execution.scheduledFor;
}

/** A signed delivery carries its trigger's metadata and a policy actor; the schedule is the system. */
export function startedBySignedTrigger(execution: AutomationExecution): boolean {
  return execution.triggerDelivery !== undefined || execution.actor.kind === "policy";
}

export function runStartedBy(execution: AutomationExecution): "Schedule" | "Signed Trigger" {
  return startedBySignedTrigger(execution) ? "Signed Trigger" : "Schedule";
}

/** How long a finished run took ("4m 2s"), or null while it runs or when it never started. */
export function runDuration(execution: AutomationExecution): string | null {
  if (execution.startedAt === undefined || execution.completedAt === undefined) return null;
  return formatDuration(Math.max(0, execution.completedAt - execution.startedAt)) || null;
}

function minutes(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "minute" : "minutes"}`;
}

/** How long the run's spec waited for a target before giving up, when it says. */
function expiryMinutes(policy: AutomationSpec["runnerPolicy"] | undefined): number | undefined {
  if (policy?.kind === "expire") return policy.afterMinutes;
  return policy?.kind === "alternate" ? policy.expireAfterMinutes : undefined;
}

/**
 * Why a skipped or expired run did not run, in one sentence; null for any other result. The control
 * plane records a skip as an internal message naming the run still going, so only its cause is
 * read from it. An expired run's limit comes from the spec it was claimed with, else the current one.
 */
export function runReason(execution: AutomationExecution, currentPolicy?: AutomationSpec["runnerPolicy"]): string | null {
  if (execution.status === "skipped") {
    const error = execution.error ?? "";
    if (/is still active/.test(error)) return "Skipped because the last run was still going.";
    if (/misfire policy/.test(error)) return "Skipped because its scheduled time was missed.";
    return "Skipped.";
  }
  if (execution.status !== "expired") return null;
  const limit = expiryMinutes(execution.specSnapshot?.runnerPolicy ?? currentPolicy);
  const subject = execution.error === AUTOMATION_TARGET_INSTALLATION_UNAVAILABLE
    ? { stayed: "The agent installation stayed unavailable", gaveUp: "Gave up waiting for the agent installation." }
    : execution.actionKind === "prompt_session"
      ? { stayed: "The session wasn't ready", gaveUp: "Gave up waiting for the session." }
      : { stayed: "The machine stayed offline", gaveUp: "Gave up waiting for the machine." };
  return limit === undefined ? subject.gaveUp : `${subject.stayed} for ${minutes(limit)}.`;
}

/** Where a run's work can be opened: a workflow run, else its session. */
export function runOpenTarget(execution: AutomationExecution): { label: "Open Run" | "Open Session"; view: View } | null {
  if (execution.runId) return { label: "Open Run", view: { name: "run", id: execution.runId } };
  if (execution.sessionId) return { label: "Open Session", view: { name: "session", id: execution.sessionId } };
  return null;
}

/** What a signed delivery brought, without its content or digest: "Prompt text, Named values (issue, run_id)". */
export function deliveredLabel(delivery: AutomationTriggerDeliveryMetadata): string {
  const target = { session_id: "session", branch: "branch", pull_request: "pull request" } as const;
  const parts = delivery.fields.map((field) => field === "prompt" ? "Prompt text"
    : field === "parameters"
      ? delivery.parameterNames.length ? `Named values (${delivery.parameterNames.join(", ")})` : "Named values"
      : delivery.targetSelector ? `Target by ${target[delivery.targetSelector]}` : "Target");
  return parts.join(", ") || "Nothing beyond the signed request";
}

/**
 * Whether a legacy run was sent once without delivery receipts. The control plane stamps every run
 * it claims without a delivery mode as legacy, including skips and expiries it never sent (#2970,
 * CR-1.1), so only a run with evidence of delivery (it started, or has a session or a workflow run)
 * counts.
 */
export function sentWithoutReceipts(execution: AutomationExecution): boolean {
  if (execution.deliveryMode !== "legacy_at_most_once" || execution.commands?.length) return false;
  if (execution.status === "skipped" || execution.status === "expired") return false;
  return execution.startedAt !== undefined || Boolean(execution.sessionId || execution.runId || execution.workflowInstanceId);
}

/** A step's kind in words. */
export function runStepLabel(kind: AutomationCommandView["kind"]): string {
  return kind === "start_session" ? "Start Session" : "Send Prompt";
}

/** A step's `automation_step` status: a command a retry replaced reads Retried, not its last state. */
export function runStepStatus(command: AutomationCommandView): StatusValue<"automation_step"> {
  return command.supersededBy ? "superseded" : command.state;
}

export function attemptsLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "attempt" : "attempts"}`;
}

const SENTENCE_LIMIT = 200;

/**
 * The first sentence of an error, capitalized and ended, for one line of a step or a notice; the
 * raw text stays available behind Show Details. A sentence over 200 characters is cut at a word.
 */
export function oneSentence(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0]!.trim();
  const end = line.search(/[.!?](\s|$)/);
  let sentence = end >= 0 ? line.slice(0, end + 1) : line;
  if (sentence.length > SENTENCE_LIMIT) {
    const cut = sentence.slice(0, SENTENCE_LIMIT);
    const space = cut.lastIndexOf(" ");
    sentence = `${(space > SENTENCE_LIMIT / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
  } else if (sentence && !/[.!?…]$/.test(sentence)) {
    sentence = `${sentence}.`;
  }
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
