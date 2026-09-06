import type { SessionConfig, SessionView } from "@wollipog/protocol";

/** Finite fallback allowances for an agent-created session whose parent has no ceiling. */
export const DEFAULT_CHILD_COST_BUDGET_USD = 5;
export const DEFAULT_CHILD_MAX_TOOL_CALLS = 100;
export const DEFAULT_CHILD_SPAWN_CAP = 4;

/** Divide remaining parent capacity over the remaining spawn slots. Explicit child limits may
 * narrow that allowance, but cannot bypass the parent's remaining ceiling. */
export function childSessionGuardrails(
  parent: Pick<SessionView, "costBudgetUsd" | "costUsd" | "maxToolCalls" | "toolCallCount">,
  requested: SessionConfig | undefined,
  remainingSlots: number,
): { config: SessionConfig } | { error: string } {
  if (!Number.isSafeInteger(remainingSlots) || remainingSlots < 1) {
    return { error: "the parent session has reached its child spawn cap" };
  }
  const costRemaining = parent.costBudgetUsd == null
    ? DEFAULT_CHILD_COST_BUDGET_USD
    : (parent.costBudgetUsd - (parent.costUsd ?? 0)) / remainingSlots;
  const toolsRemaining = parent.maxToolCalls == null
    ? DEFAULT_CHILD_MAX_TOOL_CALLS
    : Math.floor((parent.maxToolCalls - (parent.toolCallCount ?? 0)) / remainingSlots);
  if (!Number.isFinite(costRemaining) || costRemaining <= 0 ||
      !Number.isFinite(toolsRemaining) || toolsRemaining < 1) {
    return { error: "the parent session has insufficient remaining budget to create a child" };
  }
  for (const key of ["costBudgetUsd", "maxToolCalls"] as const) {
    const value = requested?.[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 ||
        (key === "maxToolCalls" && !Number.isSafeInteger(value)))) {
      return { error: `agent-created sessions require a positive ${key}` };
    }
  }
  return {
    config: {
      ...requested,
      costBudgetUsd: Math.min(requested?.costBudgetUsd ?? costRemaining, costRemaining),
      maxToolCalls: Math.min(requested?.maxToolCalls ?? toolsRemaining, toolsRemaining),
    },
  };
}
