import type { WorkflowNodeState } from "@wollipog/protocol";

/** Earliest durable retry deadline that still lies in the future. */
export function nextWorkflowRetryAt(
  states: ReadonlyArray<Pick<WorkflowNodeState, "readyAt">>,
  now: number,
): number | null {
  const future = states
    .map((state) => state.readyAt)
    .filter((readyAt): readyAt is number => typeof readyAt === "number" && readyAt > now);
  return future.length ? Math.min(...future) : null;
}

/** Keep countdown copy fresh at most once a second, then repaint just after the exact deadline. */
export function workflowRetryTimerDelay(readyAt: number, now: number): number {
  return Math.max(25, Math.min(1_000, readyAt - now + 10));
}
