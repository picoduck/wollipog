import type { AssistantThread } from "./assistant-threads.js";
import { formatUsd } from "./guardrail-values.js";
import { statusMeta } from "./status-meta.js";

export type ThreadSpendingKind = "near_budget" | "budget_used_up" | "over_budget" | "launch_limit";

export interface ThreadSpendingState {
  kind: ThreadSpendingKind;
  used: number;
  limit: number;
}

/** Blocking limits come before advisory warnings. The same order feeds the badge and the slot. */
export function threadSpendingStates(thread: Pick<AssistantThread, "status" | "usage">): ThreadSpendingState[] {
  if (!thread.usage || thread.status === "archived") return [];
  const { costUsd, launchedSessions } = thread.usage;
  const states: ThreadSpendingState[] = [];
  const budget = costUsd.limit;
  if (budget != null && costUsd.used >= budget) {
    states.push({ kind: costUsd.used > budget ? "over_budget" : "budget_used_up", used: costUsd.used, limit: budget });
  }
  if (launchedSessions.limit != null && launchedSessions.used >= launchedSessions.limit) {
    states.push({ kind: "launch_limit", used: launchedSessions.used, limit: launchedSessions.limit });
  }
  if (budget != null && costUsd.used < budget && costUsd.used >= budget * 0.8) {
    states.push({ kind: "near_budget", used: costUsd.used, limit: budget });
  }
  return states;
}

export function threadSpendingCopy({ kind, used, limit }: ThreadSpendingState) {
  const label = statusMeta("assistantThreadSpending", kind).label;
  const budget = formatUsd(limit);
  switch (kind) {
    case "near_budget":
      return { title: label, message: formatUsd(used) + " of " + budget + " used. At " + budget + " the assistant can't launch more sessions." };
    case "budget_used_up":
      return { title: label, message: "This thread has spent its " + budget + " budget, so the assistant can't launch more sessions. It can still answer you." };
    case "over_budget":
      return { title: label + " by " + formatUsd(used - limit), message: "Sessions this thread launched kept running after its " + budget + " budget ran out, and their cost counts toward it. The assistant can't launch more until you raise the budget." };
    case "launch_limit":
      return { title: label, message: used + " of " + limit + " session launches used. The assistant can't start more." };
  }
}
