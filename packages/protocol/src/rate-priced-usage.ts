import type { SessionEventPayload } from "./index.js";

/**
 * Cumulative usage the control plane prices from its rate table, carried on a runner session
 * snapshot (protocol v219, #3111). A snapshot's flat totals have no cache breakdown, so a covered
 * record that has no provider-reported cost would otherwise be priced as uncached input. One entry
 * holds every such record that shares a pricing key: the producing model, the request's service
 * tier, and whether the request's input size was known.
 *
 * The runner accrues entries and the control plane counts what it ingested with the same rule
 * (`accrueRatePricedUsage`), so a per-entry difference is exactly the usage the control plane never
 * saw. The control plane prices that difference per bucket, as event-first ingestion would have.
 */
export interface RatePricedUsageTotal {
  /** The record's model, trimmed and bounded as the control plane reads it; absent when unnamed. */
  model?: string;
  /** The record's `pricingContext.serviceTier`, bounded; absent when the record named none. */
  serviceTier?: string;
  /** Smallest and largest `pricingContext.requestInputTokens` among the entry's records. Absent
   * for an entry whose records named no request input size. A rate tier chosen by request size can
   * be reconstructed only when both ends fall in the same tier. */
  requestInputTokens?: { min: number; max: number };
  /** Provider-reported input: the uncached part for Anthropic, inclusive of cache reads for Codex. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
}

/** Beyond this many pricing keys a runner stops reporting entries for the session. */
export const RATE_PRICED_USAGE_MAX_ENTRIES = 32;
const MAX_TOKENS = 1_000_000_000_000;

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), MAX_TOKENS) : 0;
}

function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, limit);
  return text.length > 0 ? text : undefined;
}

/** The pricing key and buckets of a `token_usage` record the control plane rate-prices into the
 * session total, or null for any other record. Mirrors the control plane's accrual predicate: a
 * top-level or independently billed record that is not provisional, not incomplete, carries tokens,
 * and has no usable provider-reported cost. */
export function ratePricedUsageRecord(payload: SessionEventPayload): RatePricedUsageTotal | null {
  if (payload.kind !== "token_usage") return null;
  if (payload.parentToolUseId && payload.independentUsage !== true) return null;
  if (payload.liveUsage === "provisional" || payload.accountingIncomplete) return null;
  if (typeof payload.costUsd === "number" && Number.isFinite(payload.costUsd) && payload.costUsd >= 0) return null;
  const outputTokens = tokenCount(payload.outputTokens);
  const record: RatePricedUsageTotal = {
    inputTokens: tokenCount(payload.inputTokens),
    outputTokens,
    cachedInputTokens: tokenCount(payload.cachedInputTokens),
    cacheCreationInputTokens: tokenCount(payload.cacheCreationInputTokens),
    reasoningOutputTokens: Math.min(outputTokens, tokenCount(payload.reasoningOutputTokens)),
  };
  if (!(record.inputTokens || record.outputTokens || record.cachedInputTokens || record.cacheCreationInputTokens)) return null;
  const model = boundedText(payload.model, 128);
  const serviceTier = boundedText(payload.pricingContext?.serviceTier, 64);
  const requestInput = payload.pricingContext?.requestInputTokens;
  return {
    ...(model === undefined ? {} : { model }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
    ...(typeof requestInput === "number" && Number.isFinite(requestInput) && requestInput >= 0
      ? { requestInputTokens: { min: requestInput, max: requestInput } } : {}),
    ...record,
  };
}

/** Stable identity of an entry's pricing key. */
export function ratePricedUsageKey(entry: Pick<RatePricedUsageTotal, "model" | "serviceTier" | "requestInputTokens">): string {
  return JSON.stringify([entry.model ?? null, entry.serviceTier ?? null, entry.requestInputTokens !== undefined]);
}

/**
 * Adds one record to cumulative entries. Returns the same array when the record is not
 * rate-priced, a new array when it accrued, and null when a new key would exceed
 * `RATE_PRICED_USAGE_MAX_ENTRIES`: the session's entries can no longer be complete.
 */
export function accrueRatePricedUsage(
  totals: readonly RatePricedUsageTotal[],
  payload: SessionEventPayload,
): readonly RatePricedUsageTotal[] | null {
  const record = ratePricedUsageRecord(payload);
  if (!record) return totals;
  const key = ratePricedUsageKey(record);
  const index = totals.findIndex((entry) => ratePricedUsageKey(entry) === key);
  if (index < 0) return totals.length >= RATE_PRICED_USAGE_MAX_ENTRIES ? null : [...totals, record];
  const prior = totals[index]!;
  const sum = (field: "inputTokens" | "outputTokens" | "cachedInputTokens" | "cacheCreationInputTokens" | "reasoningOutputTokens") =>
    Math.min(prior[field] + record[field], MAX_TOKENS);
  const next: RatePricedUsageTotal = {
    ...(prior.model === undefined ? {} : { model: prior.model }),
    ...(prior.serviceTier === undefined ? {} : { serviceTier: prior.serviceTier }),
    ...(prior.requestInputTokens && record.requestInputTokens ? { requestInputTokens: {
      min: Math.min(prior.requestInputTokens.min, record.requestInputTokens.min),
      max: Math.max(prior.requestInputTokens.max, record.requestInputTokens.max),
    } } : {}),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    cacheCreationInputTokens: sum("cacheCreationInputTokens"),
    reasoningOutputTokens: sum("reasoningOutputTokens"),
  };
  return totals.map((entry, position) => position === index ? next : entry);
}

/** Accepts a peer-supplied entry list only when every entry is well formed, keys are unique, and
 * the list is within bounds; otherwise null, so the receiver falls back to flat totals. */
export function parseRatePricedUsage(value: unknown): RatePricedUsageTotal[] | null {
  if (!Array.isArray(value) || value.length > RATE_PRICED_USAGE_MAX_ENTRIES) return null;
  const keys = new Set<string>();
  const entries: RatePricedUsageTotal[] = [];
  const count = (raw: unknown) => typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_TOKENS;
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return null;
    const entry = raw as Record<string, unknown>;
    if (entry.model !== undefined && boundedText(entry.model, 128) !== entry.model) return null;
    if (entry.serviceTier !== undefined && boundedText(entry.serviceTier, 64) !== entry.serviceTier) return null;
    const fields = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationInputTokens", "reasoningOutputTokens"] as const;
    if (!fields.every((field) => count(entry[field]))) return null;
    let requestInputTokens: RatePricedUsageTotal["requestInputTokens"];
    if (entry.requestInputTokens !== undefined) {
      const range = entry.requestInputTokens as { min?: unknown; max?: unknown } | null;
      if (typeof range !== "object" || range === null) return null;
      const { min, max } = range;
      if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max) ||
          min < 0 || max < min) return null;
      requestInputTokens = { min, max };
    }
    const parsed: RatePricedUsageTotal = {
      ...(entry.model === undefined ? {} : { model: entry.model as string }),
      ...(entry.serviceTier === undefined ? {} : { serviceTier: entry.serviceTier as string }),
      ...(requestInputTokens ? { requestInputTokens } : {}),
      inputTokens: entry.inputTokens as number,
      outputTokens: entry.outputTokens as number,
      cachedInputTokens: entry.cachedInputTokens as number,
      cacheCreationInputTokens: entry.cacheCreationInputTokens as number,
      reasoningOutputTokens: entry.reasoningOutputTokens as number,
    };
    const key = ratePricedUsageKey(parsed);
    if (keys.has(key)) return null;
    keys.add(key);
    entries.push(parsed);
  }
  return entries;
}
