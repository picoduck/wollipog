import type { SessionUsageResponse, SessionView } from "@wollipog/protocol";
import { formatCost } from "./format.js";

/** What the always-visible session-cost control shows. */
export interface SessionCostLabel {
  /** Compact text for the status strip: a formatted amount, or the unknown-cost placeholder. */
  text: string;
  /** True when `text` is a real priced amount rather than a placeholder. */
  priced: boolean;
  /** Accessible name for the control, matching the visible Title Case convention. */
  ariaLabel: string;
}

/** Stands in for an amount we cannot state. Never render a priced-looking `$0.00` instead. */
const UNKNOWN_COST = "$—";

/**
 * The cost the status strip shows for a session.
 *
 * A session that has processed nothing renders no control at all. A session whose tokens are
 * known but whose cost is not — an unpriced model, a runner that reports no cost, a rate table
 * that never loaded — says so rather than claiming it was free.
 *
 * Zero is not automatically "unknown". `priceUsage` keeps a provider-reported cost of exactly 0 as
 * `providerReported`, so a genuinely free session has a real amount and must be allowed to say
 * `$0.00`. Only the ledger carries that provenance, so the strip admits it does not know until
 * `breakdown` has arrived, and never invents a `$0.00` for a session nobody managed to price.
 */
export function sessionCostLabel(
  session: Pick<SessionView, "tokensIn" | "tokensOut" | "costUsd">,
  breakdown: SessionUsageResponse | null = null,
): SessionCostLabel | null {
  const cost = formatCost(Math.max(session.costUsd, breakdown?.totals.costUsd ?? 0));
  if (cost) return { text: cost, priced: true, ariaLabel: `Session Usage: ${cost}` };
  if (session.tokensIn + session.tokensOut > 0) {
    if (breakdown && breakdown.totals.costSource !== "unpriced") {
      return { text: "$0.00", priced: true, ariaLabel: "Session Usage: $0.00" };
    }
    return { text: UNKNOWN_COST, priced: false, ariaLabel: "Session Usage: Cost Unavailable" };
  }
  return null;
}

/** Cumulative token buckets for the Session Usage popover, with progressive-disclosure rows
 * present only when the runner actually reported them. */
export interface SessionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  processedTokens: number;
  cacheSavingsUsd: number;
  costUsd: number;
  /** False until the per-model ledger has answered: the session totals are the floor until then. */
  detailed: boolean;
}

/**
 * Cumulative usage for a session, preferring the ledger response when it has arrived.
 *
 * `session.tokensIn`/`tokensOut` are the runner's running totals and are all an older runner
 * reports, so they are the fallback and the floor. The ledger adds the cache and reasoning
 * buckets; a row that carries a cache split reports the uncached part as input (zero is a real
 * value for a fully cached turn), while a legacy row without one reports what the provider called
 * input.
 */
export function sessionUsageTotals(
  session: Pick<SessionView, "tokensIn" | "tokensOut" | "costUsd">,
  breakdown: SessionUsageResponse | null,
): SessionUsageTotals {
  const fallback = {
    inputTokens: session.tokensIn,
    outputTokens: session.tokensOut,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    processedTokens: session.tokensIn + session.tokensOut,
    cacheSavingsUsd: 0,
    costUsd: session.costUsd,
    detailed: false,
  };
  if (!breakdown) return fallback;
  const totals = breakdown.totals;
  // A ledger that has not caught up with the runner's running counters must not be mixed with
  // them: raising only the total to the live floor renders rows that contradict their own sum
  // (Input 100, Output 10, Total Processed 10,000). The runner's counters are self-consistent and
  // are the more current figure, so they stay authoritative — including for cost — until the
  // ledger passes them. `detailed: false` is how the caller knows to ignore the rest of the
  // response too, so no part of the panel is drawn from a source the totals rejected.
  if (totals.processedTokens < session.tokensIn + session.tokensOut) return fallback;
  const split = totals.cachedInputTokens + totals.cacheCreationTokens > 0;
  return {
    inputTokens: split ? totals.uncachedInputTokens : totals.inputTokens,
    outputTokens: totals.outputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    reasoningTokens: totals.reasoningTokens,
    processedTokens: totals.processedTokens,
    cacheSavingsUsd: totals.cacheSavingsUsd,
    costUsd: Math.max(totals.costUsd, session.costUsd),
    detailed: true,
  };
}

/**
 * One honest sentence about where the cost figure came from, or null when there is nothing to
 * qualify. Older runners send no `pricing` block and no `costSource`, so absence stays silent
 * rather than being reported as a problem.
 */
export function costProvenanceNote(breakdown: SessionUsageResponse | null): string | null {
  if (!breakdown) return null;
  const { costSource, unpricedRecords } = breakdown.totals;
  if (costSource === "unpriced") {
    const records = unpricedRecords === 1 ? "1 record" : `${unpricedRecords} records`;
    return `${records} could not be priced, so this cost is a lower bound.`;
  }
  const pricing = breakdown.pricing;
  if (costSource === "providerReported") return "Cost as reported by the provider.";
  if (pricing?.status === "unavailable") return "No rate table is loaded, so cost is not estimated.";
  if (pricing?.source) {
    if (estimatedCostSourceUrl(breakdown)) {
      return pricing.status === "cached"
        ? "Estimated API costs use the cached rate table."
        : "Estimated API costs use the model rate table.";
    }
    return pricing.status === "cached"
      ? `Estimated from a cached ${pricing.source} rate table.`
      : `Estimated from the ${pricing.source} rate table.`;
  }
  return "Estimated from the model rate table.";
}

/** A browser-safe pricing source URL for estimated costs, when the rate table names one. */
export function estimatedCostSourceUrl(breakdown: SessionUsageResponse | null): string | null {
  if (!breakdown || breakdown.totals.costSource !== "modelPriced") return null;
  const source = breakdown.pricing?.source;
  if (!source) return null;
  try {
    const url = new URL(source);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
