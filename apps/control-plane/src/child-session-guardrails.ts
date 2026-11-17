import {
  DEFAULT_LIVE_CHILD_LIMIT,
  type ChildSessionDefaults,
  type SessionConfig,
  type SessionView,
} from "@wollipog/protocol";

export const DEFAULT_CHILD_SPAWN_CAP = DEFAULT_LIVE_CHILD_LIMIT;

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

type ParentAllowance = Pick<SessionView, "costBudgetUsd" | "costUsd" | "maxToolCalls" | "toolCallCount">;

/** Name each finite dimension's remaining allowance. `costUsd` and `toolCallCount` already include
 * the children's charges. */
function remainingAllowance(parent: ParentAllowance): string {
  const parts: string[] = [];
  if (parent.costBudgetUsd != null) {
    const remaining = Math.max(0, parent.costBudgetUsd - (parent.costUsd ?? 0));
    parts.push(`$${remaining.toFixed(2)} of its $${parent.costBudgetUsd.toFixed(2)} cost budget`);
  }
  if (parent.maxToolCalls != null) {
    const remaining = Math.max(0, parent.maxToolCalls - (parent.toolCallCount ?? 0));
    parts.push(`${remaining} of its ${parent.maxToolCalls} tool calls`);
  }
  return parts.join(" and ");
}

/** Restarting a terminal child re-reserves the unspent limits its settlement released, which may
 * already back a sibling. Refuse when a finite parent no longer has that much allowance left. */
export function childRestartAllowanceError(
  parent: ParentAllowance,
  charged: { costBudgetUsd: number; maxToolCalls: number },
  reservation: { costBudgetUsd: number; maxToolCalls: number },
): string | null {
  const allowance = {
    ...parent,
    costUsd: (parent.costUsd ?? 0) + charged.costBudgetUsd,
    toolCallCount: (parent.toolCallCount ?? 0) + charged.maxToolCalls,
  };
  // Charges accumulate as floating-point sums; ignore sub-nanodollar drift.
  const costShort = parent.costBudgetUsd != null && reservation.costBudgetUsd > 0 &&
    reservation.costBudgetUsd - (parent.costBudgetUsd - allowance.costUsd) > 1e-9;
  const toolsShort = parent.maxToolCalls != null && reservation.maxToolCalls > 0 &&
    reservation.maxToolCalls > parent.maxToolCalls - allowance.toolCallCount;
  if (!costShort && !toolsShort) return null;
  const needed = [
    ...(costShort ? [`$${reservation.costBudgetUsd.toFixed(2)}`] : []),
    ...(toolsShort ? [`${reservation.maxToolCalls} tool calls`] : []),
  ].join(" and ");
  return `the parent session has ${remainingAllowance(allowance)} remaining, but restarting this child ` +
    `re-reserves ${needed} of its unspent limits; raise the parent's limits before restarting this child`;
}

/** Resolve caller and Project defaults, then divide a finite parent's remaining capacity over
 * live spawn slots as the hard ceiling. Without any of those sources, the dimension is unlimited.
 * `creatorKeepsCostShare` (a member of an Assistant thread's tree, #4671) divides the remaining
 * cost over one more share, which the parent keeps for its own spending, in whole cents. */
export function childSessionGuardrails(
  parent: ParentAllowance,
  requested: SessionConfig | undefined,
  remainingSlots: number,
  defaults?: ChildSessionDefaults | null,
  options: { creatorKeepsCostShare?: boolean } = {},
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
  const keepsShare = options.creatorKeepsCostShare === true;
  const costShare = parent.costBudgetUsd == null
    ? null
    : (parent.costBudgetUsd - (parent.costUsd ?? 0)) / (keepsShare ? remainingSlots + 1 : remainingSlots);
  const costRemaining = costShare != null && keepsShare ? Math.floor(costShare * 100 + 1e-6) / 100 : costShare;
  const toolsRemaining = parent.maxToolCalls == null
    ? null
    : Math.floor((parent.maxToolCalls - (parent.toolCallCount ?? 0)) / remainingSlots);
  if ((costRemaining != null && (!Number.isFinite(costRemaining) || costRemaining <= 0)) ||
      (toolsRemaining != null && (!Number.isFinite(toolsRemaining) || toolsRemaining < 1))) {
    const sharing = keepsShare
      ? `, shared between its own spending and ${remainingSlots} open child slot${remainingSlots === 1 ? "" : "s"} ` +
        "because it runs in a Wollipog Assistant thread, whose budget its whole session tree shares"
      : remainingSlots > 1 ? `, shared across ${remainingSlots} open child slots` : "";
    return {
      error: `the parent session has insufficient remaining budget to create a child: ${
        remainingAllowance(parent)} remain after its own usage and its children's charges${sharing}`,
    };
  }
  if ((costRemaining != null && requestedCost === 0) || (toolsRemaining != null && requestedTools === 0)) {
    return { error: "a child cannot clear a finite parent guardrail" };
  }
  const preferredCost = requestedCost === 0 ? undefined : requestedCost ?? defaults?.costBudgetUsd;
  const preferredTools = requestedTools === 0 ? undefined : requestedTools ?? defaults?.maxToolCalls;
  const bounded = costRemaining == null ? preferredCost : Math.min(preferredCost ?? costRemaining, costRemaining);
  // Whole cents, never below one: zero would clear the guardrail, and the share is at least a cent.
  const costBudgetUsd = keepsShare && bounded !== undefined
    ? Math.max(0.01, Math.floor(bounded * 100 + 1e-6) / 100) : bounded;
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
