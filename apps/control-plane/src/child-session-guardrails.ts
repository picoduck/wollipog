import type { ChildSessionDefaults, SessionConfig, SessionView } from "@wollipog/protocol";

/** Finite fallback allowances for an agent-created session whose parent has no ceiling. */
export const DEFAULT_CHILD_COST_BUDGET_USD = 5;
export const DEFAULT_CHILD_MAX_TOOL_CALLS = 100;
export const DEFAULT_CHILD_SPAWN_CAP = 4;

export function childSessionDefaultsError(value: unknown): string | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "childSessionDefaults must be an object or null";
  const defaults = value as Record<string, unknown>;
  if (Object.keys(defaults).some((key) => key !== "costBudgetUsd" && key !== "maxToolCalls") ||
      typeof defaults.costBudgetUsd !== "number" || !Number.isFinite(defaults.costBudgetUsd) ||
      defaults.costBudgetUsd <= 0 || typeof defaults.maxToolCalls !== "number" ||
      !Number.isSafeInteger(defaults.maxToolCalls) || defaults.maxToolCalls < 1) {
    return "childSessionDefaults requires a positive finite costBudgetUsd and a positive integer maxToolCalls";
  }
  return null;
}

/** Divide remaining parent capacity over the remaining spawn slots. Explicit child limits may
 * narrow that allowance, but cannot bypass the parent's remaining ceiling. */
export function childSessionGuardrails(
  parent: Pick<SessionView, "costBudgetUsd" | "costUsd" | "maxToolCalls" | "toolCallCount">,
  requested: SessionConfig | undefined,
  remainingSlots: number,
  defaults?: ChildSessionDefaults | null,
): { config: SessionConfig } | { error: string } {
  if (!Number.isSafeInteger(remainingSlots) || remainingSlots < 1) {
    return { error: "the parent session has reached its child spawn cap" };
  }
  const costRemaining = parent.costBudgetUsd == null
    ? defaults?.costBudgetUsd ?? DEFAULT_CHILD_COST_BUDGET_USD
    : (parent.costBudgetUsd - (parent.costUsd ?? 0)) / remainingSlots;
  const toolsRemaining = parent.maxToolCalls == null
    ? defaults?.maxToolCalls ?? DEFAULT_CHILD_MAX_TOOL_CALLS
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
