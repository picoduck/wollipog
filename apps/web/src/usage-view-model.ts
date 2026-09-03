import type {
  AgentDriverKind,
  UsageAggregationResponse,
  UsageAmount,
  UsageBreakdown,
  UsageDriverTimeBucket,
  UsageTimeBucket,
} from "@wollipog/protocol";

/**
 * Pure view logic for the Usage & Cost view: metric selection, number formatting, driver
 * presentation, and the stacked-column geometry the chart draws. Framework-free so it unit-tests
 * with `node:test` and so the chart's numbers and the hover readout come from one computation.
 */

export type UsageMetric = "cost" | "tokens";
export type UsageBreakdownMode = "model" | "time";

/** Fixed categorical slot per driver. Colour follows the entity, never its rank: a driver keeps
 * its slot whether or not the others have usage in the window. Slots map to `--usage-series-N`. */
export const DRIVER_PRESENTATION: Record<AgentDriverKind, { label: string; slot: 1 | 2 | 3 | 4 }> = {
  "claude-code": { label: "Claude Code", slot: 1 },
  "codex-app-server": { label: "Codex", slot: 2 },
  codex: { label: "Codex CLI", slot: 3 },
  acp: { label: "ACP", slot: 4 },
};

/** Stable reading order across the driver list, chart bands, legend, and hover readout. */
export const DRIVER_ORDER = (Object.keys(DRIVER_PRESENTATION) as AgentDriverKind[])
  .sort((a, b) => DRIVER_PRESENTATION[a].slot - DRIVER_PRESENTATION[b].slot);

/** Literal class per slot, so the stylesheet's class inventory can see every series class. */
const SERIES_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: "usage-series-1",
  2: "usage-series-2",
  3: "usage-series-3",
  4: "usage-series-4",
};

export function seriesClass(driver: AgentDriverKind): string {
  return SERIES_CLASS[DRIVER_PRESENTATION[driver].slot];
}

export function isDriverKind(value: string): value is AgentDriverKind {
  return Object.hasOwn(DRIVER_PRESENTATION, value);
}

export function driverLabel(driver: string): string {
  return isDriverKind(driver) ? DRIVER_PRESENTATION[driver].label : driver;
}

/**
 * Every token the provider processed: input across all cache buckets plus output.
 *
 * Aggregates mix three row shapes: Anthropic rows report `inputTokens` as the uncached part, Codex
 * rows report it inclusive of `cachedInputTokens`, and pre-v103 rows carry no split at all. The
 * split buckets are always counted; whatever reported input the split does not account for is the
 * unsplit (legacy) remainder and is added once. This never over-counts. It under-counts only when
 * legacy rows are mixed with cached Anthropic rows, where the legacy input is indistinguishable
 * from the cached part at aggregate level; that remainder ages out with retention.
 */
export function processedTokens(amount: UsageAmount): number {
  const split = amount.uncachedInputTokens + amount.cachedInputTokens + amount.cacheCreationTokens;
  const unsplit = Math.max(0, amount.inputTokens - amount.uncachedInputTokens - amount.cachedInputTokens);
  return split + unsplit + amount.outputTokens;
}

export function metricValue(amount: UsageAmount, metric: UsageMetric): number {
  return metric === "cost" ? amount.costUsd : processedTokens(amount);
}

/** Compacts to three significant figures with a unit suffix so columns line up: 804K, 76.7M, 1.2B. */
export function formatCompactTokens(value: number): string {
  const abs = Math.abs(value);
  const trim = (scaled: number) => {
    const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
    return scaled.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
  };
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return String(Math.round(value));
}

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Fixed two decimals; a sub-cent non-zero amount reads `<$0.01` rather than a misleading `$0.00`. */
export function formatMoney(usd: number): string {
  if (usd > 0 && usd < 0.005) return "<$0.01";
  return MONEY.format(usd);
}

export function formatMetric(value: number, metric: UsageMetric): string {
  return metric === "cost" ? formatMoney(value) : formatCompactTokens(value);
}

export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  return `${(share * 100).toFixed(share < 0.0995 ? 1 : 0)}%`;
}

/** Drivers with real activity in the window, in slot order. The `Other` remainder row is not a
 * driver and never gets a slot. */
export function activeDrivers(byDriver: readonly UsageBreakdown[]): AgentDriverKind[] {
  const active = new Set(byDriver.filter((row) => isDriverKind(row.key) && processedTokens(row) + row.costUsd > 0).map((row) => row.key));
  return DRIVER_ORDER.filter((driver) => active.has(driver));
}

export interface DriverRow {
  driver: AgentDriverKind;
  amount: UsageAmount;
  /** Share of the window's total for the ACTIVE metric. */
  share: number;
}

export function driverRows(data: Pick<UsageAggregationResponse, "byDriver" | "totals">, metric: UsageMetric): DriverRow[] {
  const total = metricValue(data.totals, metric);
  return activeDrivers(data.byDriver).map((driver) => {
    const amount = data.byDriver.find((row) => row.key === driver)!;
    const value = metricValue(amount, metric);
    return { driver, amount, share: total > 0 ? value / total : 0 };
  });
}

export interface ColumnBand {
  driver: AgentDriverKind;
  value: number;
  /** Cumulative bottom and top of the band in metric units. */
  from: number;
  to: number;
}

export interface UsageColumn {
  bucketTs: number;
  total: number;
  /** Empty when the plane sent no per-driver split for this bucket: the total is known, the
   * per-driver values are not, and nothing should present them as zero. */
  bands: ColumnBand[];
}

/**
 * Stacked columns in ascending time order. Bands stack in `drivers` order (slot order), so a
 * driver sits at the same height position in every column. Buckets missing a driver get a zero
 * band so the hover readout can still list it.
 */
export function buildColumns(
  series: readonly UsageTimeBucket[],
  seriesByDriver: readonly UsageDriverTimeBucket[],
  drivers: readonly AgentDriverKind[],
  metric: UsageMetric,
): UsageColumn[] {
  const byBucket = new Map<number, Map<AgentDriverKind, number>>();
  for (const row of seriesByDriver) {
    const bucket = byBucket.get(row.bucketTs) ?? new Map<AgentDriverKind, number>();
    bucket.set(row.driver, (bucket.get(row.driver) ?? 0) + metricValue(row, metric));
    byBucket.set(row.bucketTs, bucket);
  }
  return [...series]
    .sort((a, b) => a.bucketTs - b.bucketTs)
    .map((bucket) => {
      const perDriver = byBucket.get(bucket.bucketTs);
      // A pre-v103 plane sends no per-driver split: the column keeps its total height as one
      // unsplit mark and the readout lists only the total.
      if (!perDriver) return { bucketTs: bucket.bucketTs, total: metricValue(bucket, metric), bands: [] };
      let cursor = 0;
      const bands = drivers.map((driver) => {
        const value = perDriver.get(driver) ?? 0;
        const band = { driver, value, from: cursor, to: cursor + value };
        cursor += value;
        return band;
      });
      return { bucketTs: bucket.bucketTs, total: cursor, bands };
    });
}

/** Round axis ticks: the max snaps up to a 1/2/2.5/5 × 10^n step so ticks read as clean numbers. */
export function niceScale(peak: number, tickCount = 4): { max: number; ticks: number[] } {
  if (!(peak > 0)) return { max: 1, ticks: [0, 1] };
  const rough = peak / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const residual = rough / magnitude;
  const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10) * magnitude;
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step / 2; value += step) ticks.push(Number(value.toPrecision(12)));
  return { max, ticks };
}

/** Whole days a window spans, from the response itself rather than the range the user last
 * clicked, so a headline never labels one window's totals with another's length. */
export function windowDays(data: Pick<UsageAggregationResponse, "since" | "through">): number {
  return Math.max(1, Math.round((data.through - data.since) / 86_400_000));
}

/** Short axis label in UTC, matching the table's UTC caption: `Sep 3` for days, `14:00` for hours. */
export function axisLabel(bucketTs: number, granularity: "hour" | "day"): string {
  const date = new Date(bucketTs);
  return granularity === "hour"
    ? `${String(date.getUTCHours()).padStart(2, "0")}:00`
    : date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/** Indexes of the columns that get an axis label: never more than `limit`, always the ends. */
export function axisLabelIndexes(count: number, limit = 8): number[] {
  if (count <= 0) return [];
  if (count <= limit) return Array.from({ length: count }, (_, index) => index);
  const step = Math.ceil((count - 1) / (limit - 1));
  const indexes = new Set<number>();
  for (let index = 0; index < count; index += step) indexes.add(index);
  indexes.add(count - 1);
  return [...indexes].sort((a, b) => a - b);
}

export interface CoverageNotice {
  offlineMachines: string[];
  unpricedRecords: number;
  pricing: UsageAggregationResponse["pricing"];
}

/** The sentences the coverage block shows; empty when totals are complete and fully priced. */
export function coverageMessages(notice: CoverageNotice): string[] {
  const messages: string[] = [];
  if (notice.offlineMachines.length > 0) {
    messages.push(`${notice.offlineMachines.join(", ")} ${notice.offlineMachines.length === 1 ? "is" : "are"} offline; usage it has not yet reported is missing from these totals.`);
  }
  if (notice.unpricedRecords > 0) {
    messages.push(`${notice.unpricedRecords.toLocaleString("en-US")} ${notice.unpricedRecords === 1 ? "record has" : "records have"} tokens but no price, so cost is a lower bound.`);
  }
  if (notice.pricing?.status === "unavailable") {
    messages.push("No model rate table is loaded; usage without a provider-reported cost is unpriced.");
  } else if (notice.pricing?.status === "cached") {
    messages.push("The model rate table could not be refreshed; estimates use the last cached rates.");
  }
  return messages;
}
