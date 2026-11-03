import type { ClaudeUsageCheckpoint, SessionEventPayload } from "@wollipog/protocol";

type Usage = Extract<SessionEventPayload, { kind: "token_usage" }>;

/** A record the session ledger accrues: top-level (or independently billed) and not provisional. */
const accrued = (event: Usage) => (!event.parentToolUseId || event.independentUsage === true) && event.liveUsage !== "provisional";

/** The same predicate over a `session_events.payload` column, for queries that must not let
 * display-only records crowd out the baseline. */
export const ACCRUED_USAGE_SQL = `COALESCE(json_extract(payload, '$.liveUsage'), '')<>'provisional'
  AND (json_extract(payload, '$.parentToolUseId') IS NULL OR json_extract(payload, '$.independentUsage')=1)`;

const TOKENS = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const;
/** `later` reports at least everything `earlier` did, model by model. */
function covers(later: ClaudeUsageCheckpoint, earlier: ClaudeUsageCheckpoint): boolean {
  if (later.totalCostUsd + 1e-9 < earlier.totalCostUsd) return false;
  return Object.entries(earlier.models).every(([model, usage]) => {
    const now = later.models[model];
    return now !== undefined && TOKENS.every((field) => now[field] >= usage[field]);
  });
}

/**
 * #4069: a runner that read restored conversation totals as process totals billed every new
 * provider process's whole running total as one turn. Such a turn closes with a process-scoped
 * checkpoint, its records bill exactly that checkpoint's total, and that total covers an earlier
 * non-zero checkpoint of the same conversation, so it includes earlier turns that were already
 * billed. Returns the cost the turn billed when `current` closes such a turn, else null.
 *
 * `earlier` holds the session's earlier usage records, newest first. The signature cannot tell a
 * genuinely old CLI whose new process outgrew the previous one in every counter from the defect,
 * so a match is shown as uncertain, never corrected.
 */
export function claudeRunningTotalBilled(current: Usage, earlier: Usage[]): number | null {
  let billedBefore = 0;
  let index = 0;
  // The turn's other records follow the previous checkpoint.
  for (; index < earlier.length; index++) {
    const event = earlier[index]!;
    if (!accrued(event)) continue;
    if (event.claudeUsageCheckpoint) break;
    billedBefore += event.costUsd ?? 0;
  }
  const prior = earlier.slice(index).find((event) => accrued(event) && (event.claudeUsageCheckpoint?.totalCostUsd ?? 0) > 0);
  return claudeTurnRunningTotal(current, billedBefore, prior?.claudeUsageCheckpoint ?? null);
}

/** The same decision from what the turn's other records billed since the previous checkpoint
 * (`billedBefore`) and the latest earlier non-zero checkpoint of the session (`prior`). */
export function claudeTurnRunningTotal(current: Usage, billedBefore: number, prior: ClaudeUsageCheckpoint | null): number | null {
  const checkpoint = current.claudeUsageCheckpoint;
  if (!checkpoint || checkpoint.accountingScope !== "process" || !(checkpoint.totalCostUsd > 0) || !accrued(current)) return null;
  const billed = billedBefore + (current.costUsd ?? 0);
  // A difference from a baseline bills less than the total; only a whole total repeats earlier turns.
  if (Math.abs(billed - checkpoint.totalCostUsd) > 1e-6 * Math.max(1, checkpoint.totalCostUsd)) return null;
  return prior && prior.sessionId === checkpoint.sessionId && covers(checkpoint, prior) ? billed : null;
}
