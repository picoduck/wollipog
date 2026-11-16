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

/** #4069: Detect a process-scoped total that repeats earlier billed turns, from what the turn's
 * other records billed since the previous checkpoint (`billedBefore`) and the latest earlier
 * non-zero checkpoint of the session (`prior`). Returns the billed cost or null.
 * An old CLI whose new process outgrew the previous one in every counter is indistinguishable
 * from the defect, so a match is shown as uncertain, never corrected. */
export function claudeTurnRunningTotal(current: Usage, billedBefore: number, prior: ClaudeUsageCheckpoint | null): number | null {
  const checkpoint = current.claudeUsageCheckpoint;
  if (!checkpoint || checkpoint.accountingScope !== "process" || !(checkpoint.totalCostUsd > 0) || !accrued(current)) return null;
  const billed = billedBefore + (current.costUsd ?? 0);
  // A difference from a baseline bills less than the total; only a whole total repeats earlier turns.
  if (Math.abs(billed - checkpoint.totalCostUsd) > 1e-6 * Math.max(1, checkpoint.totalCostUsd)) return null;
  return prior && prior.sessionId === checkpoint.sessionId && covers(checkpoint, prior) ? billed : null;
}
