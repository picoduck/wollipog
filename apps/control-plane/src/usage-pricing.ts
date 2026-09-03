import type { UsageCostSource } from "@wollipog/protocol";

/**
 * Model rate lookup and cost arithmetic for usage accounting.
 *
 * Rates are USD per token for the four billable input/output buckets. Everything here is pure so
 * the pricing rules unit-test without a network or a database; loading and caching the table
 * lives in `usage-rate-table.ts`.
 */

export interface ModelRate {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheCreationCostPerToken: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/** Token buckets for one priced record. `uncachedInputTokens` excludes both cache buckets. */
export interface UsageTokenBuckets {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

export interface PricedUsage {
  costUsd: number;
  costSource: UsageCostSource;
  /** What the cached input would have cost at the full input rate minus what it cost. */
  cacheSavingsUsd: number;
}

/** Rate-table entries that omit cache pricing fall back to the industry-standard ratios: cache
 * reads at roughly a tenth of input and cache writes at a quarter premium. Pricing cached input at
 * the full rate over-charges cache-heavy sessions roughly tenfold; pricing it at zero hides cost. */
export const FALLBACK_CACHE_READ_INPUT_RATIO = 0.1;
export const FALLBACK_CACHE_WRITE_INPUT_RATIO = 1.25;

/** Identifiers never priced regardless of the table. Bare family names are ambiguous across
 * generations, and synthetic markers denote locally generated messages that were never billed. */
const UNPRICEABLE_MODELS = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable", "default", "auto"]);

interface RawRateEntry {
  input_cost_per_token?: unknown;
  output_cost_per_token?: unknown;
  cache_read_input_token_cost?: unknown;
  cache_creation_input_token_cost?: unknown;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeRateKey(model: string): string {
  return model.trim().toLowerCase();
}

function bareModelName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

/** Drops a bracketed variant suffix such as `claude-fable-5-1[1m]` that Claude Code writes for the
 * 1M context tier. Rate tables know the base name, and the base tier is what gets priced. */
function stripVariantSuffix(key: string): string {
  const bracket = key.indexOf("[");
  return bracket === -1 ? key : key.slice(0, bracket);
}

/** Drops a trailing `-YYYYMMDD` snapshot date so a dated Claude id still matches an undated entry. */
function stripSnapshotDate(key: string): string {
  return key.replace(/-\d{8}$/, "");
}

function sameRate(a: ModelRate, b: ModelRate): boolean {
  return a.inputCostPerToken === b.inputCostPerToken &&
    a.outputCostPerToken === b.outputCostPerToken &&
    a.cacheReadCostPerToken === b.cacheReadCostPerToken &&
    a.cacheCreationCostPerToken === b.cacheCreationCostPerToken;
}

/**
 * Projects a LiteLLM-style `model_prices_and_context_window.json` document into a rate table.
 *
 * Entries without both an input and an output rate are dropped: a half-priced model would silently
 * under-report cost, which is worse than reporting it as unpriced. Entries keep their full
 * normalized key (`provider/model`); a bare model name is aliased only when no canonical bare entry
 * exists and every qualified entry agrees on the rate.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;
  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as RawRateEntry;
    const input = finiteNonNegative(entry.input_cost_per_token);
    const output = finiteNonNegative(entry.output_cost_per_token);
    if (input === null || output === null) continue;
    const key = normalizeRateKey(name);
    if (key.length === 0 || key === "sample_spec") continue;
    table.set(key, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheReadCostPerToken: finiteNonNegative(entry.cache_read_input_token_cost) ?? input * FALLBACK_CACHE_READ_INPUT_RATIO,
      cacheCreationCostPerToken:
        finiteNonNegative(entry.cache_creation_input_token_cost) ?? input * FALLBACK_CACHE_WRITE_INPUT_RATIO,
    });
  }
  // `null` marks a bare name claimed at conflicting rates: no alias for it.
  const aliases = new Map<string, ModelRate | null>();
  for (const [key, rate] of table) {
    const alias = bareModelName(key);
    if (alias.length === 0 || alias === key || table.has(alias)) continue;
    const held = aliases.get(alias);
    if (held === undefined) aliases.set(alias, rate);
    else if (held !== null && !sameRate(held, rate)) aliases.set(alias, null);
  }
  for (const [alias, rate] of aliases) {
    if (rate !== null) table.set(alias, rate);
  }
  return table;
}

/** Resolves a provider-reported model id to a rate, or `null` when it cannot be priced honestly. */
export function lookupRate(table: RateTable, model: string | null | undefined): ModelRate | null {
  if (typeof model !== "string") return null;
  const key = stripVariantSuffix(normalizeRateKey(model));
  const bare = bareModelName(key);
  if (bare.length === 0 || UNPRICEABLE_MODELS.has(bare)) return null;
  return table.get(key) ?? table.get(bare) ?? table.get(stripSnapshotDate(key)) ?? table.get(stripSnapshotDate(bare)) ?? null;
}

/**
 * Prices one usage record. A provider-reported cost always wins and is used unchanged. Reasoning
 * tokens are never charged separately: providers report them inside `outputTokens`.
 */
export function priceUsage(
  table: RateTable | null,
  model: string | null | undefined,
  buckets: UsageTokenBuckets,
  reportedCostUsd: number | null | undefined,
): PricedUsage {
  const rate = table ? lookupRate(table, model) : null;
  const cacheSavingsUsd = rate
    ? Math.max(0, buckets.cachedInputTokens * (rate.inputCostPerToken - rate.cacheReadCostPerToken))
    : 0;
  if (typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0) {
    return { costUsd: reportedCostUsd, costSource: "providerReported", cacheSavingsUsd };
  }
  if (!rate) return { costUsd: 0, costSource: "unpriced", cacheSavingsUsd: 0 };
  const costUsd =
    buckets.uncachedInputTokens * rate.inputCostPerToken +
    buckets.cachedInputTokens * rate.cacheReadCostPerToken +
    buckets.cacheCreationTokens * rate.cacheCreationCostPerToken +
    buckets.outputTokens * rate.outputCostPerToken;
  return { costUsd, costSource: "modelPriced", cacheSavingsUsd };
}

/** A bucket that mixes provenance reports the weakest so the UI never overstates confidence: any
 * unpriced record marks the bucket unpriced (the unpriced count says how much), any estimated record
 * marks it model-priced, and only an entirely provider-reported bucket claims exact billing. */
export function resolveCostSource(counts: {
  providerReported: number;
  modelPriced: number;
  unpriced: number;
}): UsageCostSource {
  const total = counts.providerReported + counts.modelPriced + counts.unpriced;
  if (total === 0 || counts.unpriced > 0) return "unpriced";
  if (counts.modelPriced > 0) return "modelPriced";
  return "providerReported";
}
