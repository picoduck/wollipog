import type { ChildSessionDefaults, SessionConfig, SessionView } from "@wollipog/protocol";

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

/** Resolve caller and Project defaults, then divide a finite parent's remaining capacity over
 * live spawn slots as the hard ceiling. Without any of those sources, the dimension is unlimited. */
export function childSessionGuardrails(
  parent: Pick<SessionView, "costBudgetUsd" | "costUsd" | "maxToolCalls" | "toolCallCount">,
  requested: SessionConfig | undefined,
  remainingSlots: number,
  defaults?: ChildSessionDefaults | null,
): { config: SessionConfig } | { error: string } {
  if (!Number.isSafeInteger(remainingSlots) || remainingSlots < 1) {
    return { error: "the parent session has 0 remaining live child slots; raise maxChildSessions before creating another child" };
  }
  for (const key of ["costBudgetUsd", "maxToolCalls"] as const) {
    const value = requested?.[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0 ||
        (key === "maxToolCalls" && !Number.isSafeInteger(value)))) {
      return { error: `agent-created sessions require a non-negative ${key}` };
    }
  }
  const requestedCost = requested?.costBudgetUsd;
  const requestedTools = requested?.maxToolCalls;
  const costRemaining = parent.costBudgetUsd == null
    ? null
    : (parent.costBudgetUsd - (parent.costUsd ?? 0)) / remainingSlots;
  const toolsRemaining = parent.maxToolCalls == null
    ? null
    : Math.floor((parent.maxToolCalls - (parent.toolCallCount ?? 0)) / remainingSlots);
  if ((costRemaining != null && (!Number.isFinite(costRemaining) || costRemaining <= 0)) ||
      (toolsRemaining != null && (!Number.isFinite(toolsRemaining) || toolsRemaining < 1))) {
    return { error: "the parent session has insufficient remaining budget to create a child" };
  }
  if ((costRemaining != null && requestedCost === 0) || (toolsRemaining != null && requestedTools === 0)) {
    return { error: "a child cannot clear a finite parent guardrail" };
  }
  const preferredCost = requestedCost === 0 ? undefined : requestedCost ?? defaults?.costBudgetUsd;
  const preferredTools = requestedTools === 0 ? undefined : requestedTools ?? defaults?.maxToolCalls;
  const costBudgetUsd = costRemaining == null
    ? preferredCost
    : Math.min(preferredCost ?? costRemaining, costRemaining);
  const maxToolCalls = toolsRemaining == null
    ? preferredTools
    : Math.min(preferredTools ?? toolsRemaining, toolsRemaining);
  const { costBudgetUsd: _requestedCost, maxToolCalls: _requestedTools, ...otherRequested } = requested ?? {};
  return {
    config: {
      ...otherRequested,
      ...(costBudgetUsd === undefined ? {} : { costBudgetUsd }),
      ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    },
  };
}
