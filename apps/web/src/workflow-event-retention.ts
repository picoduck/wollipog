import type { WorkflowEventRetentionCounts, WorkflowEventRetentionView } from "@wollipog/protocol";
import { formatRetentionDateTime, retentionDaysLabel } from "./archived-history-retention.js";
export {
  RETENTION_NO_PERMISSION, RETENTION_UNSUPPORTED, parseRetentionDays, retentionChangePrunesMore,
  retentionDaysError, retentionScheduleSentence, retentionSourceSentence,
} from "./archived-history-retention.js";
export const RETENTION_LOAD_FAILED = "Couldn't load workflow event retention. Try again.";
export const RETENTION_SAVE_FAILED = "Workflow event retention wasn't saved. Try again.";
export function retentionCountsLabel(counts: WorkflowEventRetentionCounts): string {
  return counts.instances === 0 ? "None" : `${counts.instances.toLocaleString()} workflow ${counts.instances === 1 ? "instance" : "instances"}, ${counts.events.toLocaleString()} ${counts.events === 1 ? "event" : "events"}`;
}
export function retentionSwitchDescription(view: Pick<WorkflowEventRetentionView, "retentionDays">): string {
  return view.retentionDays === null ? "Completed workflows keep their full event history."
    : `Workflows lose their event history ${retentionDaysLabel(view.retentionDays)} after completion.`;
}
export function retentionLastRun(lastRun: NonNullable<WorkflowEventRetentionView["lastRun"]>): { when: string; pruned: string } {
  return { when: `Finished ${formatRetentionDateTime(lastRun.finishedAt)}.`,
    pruned: lastRun.instances ? retentionCountsLabel(lastRun) : "Nothing to prune" };
}
export function retentionConfirmation(current: number | null, preview: NonNullable<WorkflowEventRetentionView["preview"]>) {
  return {
    title: current === null ? "Prune Workflow Events" : "Shorten Workflow Event Retention",
    message: `Event history of workflows completed more than ${retentionDaysLabel(preview.retentionDays)} ago is permanently removed from this control plane, starting ${formatRetentionDateTime(preview.prunesFrom)}. Instance summaries, node outcomes, attempts, artifacts, decisions and action receipts are kept. This cannot be undone here.`,
    confirmLabel: current === null ? "Prune Events" : "Shorten Retention",
    detailRows: [
      { label: "Workflow Instances to Prune", meta: preview.eligible.instances.toLocaleString() },
      { label: "Events to Remove", meta: preview.eligible.events.toLocaleString() },
    ],
  };
}
