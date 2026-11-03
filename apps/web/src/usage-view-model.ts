import type {
  AgentDriverKind,
  UsageAggregationGranularity,
  UsageAggregationResponse,
  UsageAmount,
  UsageBreakdown,
  UsageDriverTimeBucket,
  UsagePricingStatus,
  UsageTimeBucket,
  UserCostWindows,
} from "@wollipog/protocol";

/**
 * Pure view logic for the Usage & Cost view: metric selection, number formatting, driver
 * presentation, and the stacked-column geometry the chart draws. Framework-free so it unit-tests
 * with `node:test` and so the chart's numbers and the hover readout come from one computation.
 */

export type UsageMetric = "cost" | "tokens";
/** The Breakdown's tabs (#3013). `time` follows Group By, so it is By Hour, By Day or By Week. */
export type UsageBreakdownTab = "time" | "model" | "agent" | "machine" | "person";

/** Fixed categorical slot per driver. Colour follows the entity, never its rank: a driver keeps
 * its slot whether or not the others have usage in the window. Slots map to `--usage-series-N`.
 * Claude Code takes the blue slot and Codex the orange one, so the most common series is never the
 * red-orange that sits beside failure and danger. */
export const DRIVER_PRESENTATION: Record<AgentDriverKind, { label: string; slot: 1 | 2 | 3 | 4 | 5 }> = {
  "claude-code": { label: "Claude Code", slot: 2 },
  "codex-app-server": { label: "Codex", slot: 1 },
  acp: { label: "ACP", slot: 4 },
  codex: { label: "Codex CLI", slot: 3 },
  pi: { label: "Pi", slot: 5 },
};

/** Stable reading order across the driver list, chart bands, readout and tables, and the chart's
 * stacking order from the baseline up. It is explicit rather than derived from the slots, so the
 * pairs that touch in a column are the pairs colour-schemes.test.ts measures: blue never sits on
 * purple, and Pi's pink sits between Codex and ACP because on Codex CLI's green it falls to
 * ΔE 7.1 under deuteranopia in the dark theme, under the floor of 8. */
export const DRIVER_ORDER: readonly AgentDriverKind[] = ["claude-code", "codex-app-server", "pi", "acp", "codex"];

/** The usage page's name for ACP usage that no single agent owns. */
export const OTHER_AGENTS_LABEL = "Other Agents";

/** Literal class per slot, so the stylesheet's class inventory can see every series class. */
const SERIES_CLASS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "usage-series-1",
  2: "usage-series-2",
  3: "usage-series-3",
  4: "usage-series-4",
  5: "usage-series-5",
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

const SUBSCRIPTION_PLAN_LABELS: Readonly<Record<string, string>> = {
  max: "Max",
  pro: "Pro",
};

/** Provider plan values are open strings. Correct only tier names whose branding is known and
 * preserve every unknown value exactly so a new provider tier remains recognizable. */
export function subscriptionPlanLabel(plan: string): string {
  return SUBSCRIPTION_PLAN_LABELS[plan.toLocaleLowerCase("en-US")] ?? plan;
}

/**
 * Every token the provider processed. The control plane derives `processedTokens` per row with the
 * driver's input semantics and sums it, so the figure is additive across buckets, breakdowns, and
 * drivers and every total on the page agrees. A plane older than that field gets a conservative
 * fallback: the reported input plus output, which never over-counts.
 */
export function processedTokens(amount: UsageAmount): number {
  const derived = (amount as Partial<UsageAmount>).processedTokens;
  if (typeof derived === "number" && Number.isFinite(derived)) return derived;
  return amount.inputTokens + amount.outputTokens;
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

/** Drivers with real activity in the window, in DRIVER_ORDER. The `Other` remainder row is not a
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

/** An agent a runner advertises: enough to tell an ACP agent and name it. */
export interface UsageAgentCandidate {
  id: string;
  driver?: AgentDriverKind;
  name: string;
}

/**
 * The usage page's series names. "ACP" is a protocol, not something anyone chose, so ACP usage is
 * named by its agent when exactly one ACP agent the runners advertise owns all of it in the window,
 * and reads "Other Agents" otherwise: several agents, an agent no runner advertises any more, or one
 * folded into the breakdown's `Other` remainder. An id two runners name differently has no one name.
 *
 * The plane keys each agent row `<agent id>` or `<agent id> / <model>`, one row per model, so a row
 * belongs to the one advertised id it equals or starts with followed by " / ", and an agent's rows
 * are summed across its models. A row no id resolves, or two ids could claim, is left unattributed;
 * if it held ACP usage the named agent no longer accounts for the whole ACP total, and the label
 * falls back.
 */
export function usageDriverLabels(
  data: Pick<UsageAggregationResponse, "byDriver" | "byAgent">,
  agents: Iterable<UsageAgentCandidate>,
): Record<AgentDriverKind, string> {
  const labels = Object.fromEntries(DRIVER_ORDER.map((driver) => [driver, DRIVER_PRESENTATION[driver].label])) as
    Record<AgentDriverKind, string>;
  labels.acp = OTHER_AGENTS_LABEL;
  const acp = data.byDriver.find((row) => row.key === "acp");
  if (!acp) return labels;
  const knownIds = new Set<string>();
  const acpNames = new Map<string, Set<string>>();
  for (const agent of agents) {
    knownIds.add(agent.id);
    if ((agent.driver ?? "acp") !== "acp") continue;
    const names = acpNames.get(agent.id) ?? new Set<string>();
    names.add(agent.name);
    acpNames.set(agent.id, names);
  }
  const agentOf = (key: string) => {
    const matches = [...knownIds].filter((id) => key === id || key.startsWith(`${id} / `));
    return matches.length === 1 ? matches[0]! : null;
  };
  const owned = new Map<string, { tokens: number; costUsd: number }>();
  for (const row of data.byAgent) {
    if (row.key === "Other" || (processedTokens(row) <= 0 && row.costUsd <= 0)) continue;
    const id = agentOf(row.key);
    if (id === null || !acpNames.has(id)) continue;
    const sum = owned.get(id) ?? { tokens: 0, costUsd: 0 };
    owned.set(id, { tokens: sum.tokens + processedTokens(row), costUsd: sum.costUsd + row.costUsd });
  }
  if (owned.size !== 1) return labels;
  const [[id, sum]] = [...owned] as [[string, { tokens: number; costUsd: number }]];
  const names = acpNames.get(id)!;
  // The one agent must account for every ACP token and cent; otherwise some ACP usage belongs to
  // an agent the runners no longer advertise, and the name would claim it.
  const ownsAll = sum.tokens === processedTokens(acp) && Math.abs(sum.costUsd - acp.costUsd) < 0.005;
  if (names.size === 1 && ownsAll) labels.acp = [...names][0]!;
  return labels;
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
  /** False for a bucket that ended before recording started: the chart draws it inside the Not
   * Recorded band, never as zero usage, and the keyboard skips it. */
  recorded: boolean;
}

/** The time axis a chart spans: the response's window and granularity, the range the user chose
 * (whose start the response clamps to the start of recording), and that start of recording. */
export interface UsageAxis {
  granularity: UsageAggregationGranularity;
  since: number;
  through: number;
  coverageStartedAt: number;
  /** The range the response answers, in days; without it the axis starts at `since`. */
  rangeDays?: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** More buckets than the longest window holds (ten years of days), so a malformed window can
 * never make the chart iterate without bound. */
const MAX_AXIS_BUCKETS = 4_000;

export function bucketStepMs(granularity: UsageAggregationGranularity): number {
  return granularity === "hour" ? HOUR_MS : granularity === "week" ? 7 * DAY_MS : DAY_MS;
}

/** The start of the bucket holding `timestamp`: its UTC hour, its UTC day, or the Monday the
 * control plane's weekly rows start on (Unix day zero was a Thursday). */
export function bucketStart(timestamp: number, granularity: UsageAggregationGranularity): number {
  if (granularity === "hour") return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
  const day = Math.floor(timestamp / DAY_MS);
  if (granularity === "day") return day * DAY_MS;
  return (day - (((day + 3) % 7) + 7) % 7) * DAY_MS;
}

/**
 * Stacked columns in ascending time order, one for EVERY bucket on the axis: a bucket without
 * usage is a zero column rather than a gap, so a quiet weekend keeps its width and one day of data
 * is one day wide. Buckets that ended before recording started are marked unrecorded. Bands stack
 * in `drivers` order (DRIVER_ORDER), so a driver sits at the same height in every column, and a
 * bucket missing a driver gets a zero band so the readout can still list it. A window with no usage
 * at all has no columns, which the chart shows as its empty state.
 */
export function buildColumns(
  series: readonly UsageTimeBucket[],
  seriesByDriver: readonly UsageDriverTimeBucket[],
  drivers: readonly AgentDriverKind[],
  metric: UsageMetric,
  axis: UsageAxis,
): UsageColumn[] {
  if (series.length === 0) return [];
  const byBucket = new Map<number, Map<AgentDriverKind, number>>();
  for (const row of seriesByDriver) {
    const bucket = byBucket.get(row.bucketTs) ?? new Map<AgentDriverKind, number>();
    bucket.set(row.driver, (bucket.get(row.driver) ?? 0) + metricValue(row, metric));
    byBucket.set(row.bucketTs, bucket);
  }
  // A pre-v103 plane sends no per-driver split at all: its columns keep their total height as one
  // unsplit mark and the readout lists only the total, and a filled bucket claims no zeros either.
  const split = seriesByDriver.length > 0;
  const step = bucketStepMs(axis.granularity);
  const column = (bucketTs: number, total: number): UsageColumn => {
    const recorded = bucketTs + step > axis.coverageStartedAt;
    const perDriver = byBucket.get(bucketTs);
    if (!perDriver) {
      const bands = split && total === 0 ? drivers.map((driver) => ({ driver, value: 0, from: 0, to: 0 })) : [];
      return { bucketTs, total, bands, recorded };
    }
    let cursor = 0;
    const bands = drivers.map((driver) => {
      const value = perDriver.get(driver) ?? 0;
      const band = { driver, value, from: cursor, to: cursor + value };
      cursor += value;
      return band;
    });
    return { bucketTs, total: cursor, bands, recorded };
  };

  // The plane clamps `since` to the start of recording; the range the user chose may start
  // earlier, and those earlier buckets become the Not Recorded band.
  const requested = axis.rangeDays === undefined ? axis.since : axis.through - axis.rangeDays * DAY_MS;
  const last = bucketStart(Math.max(axis.since, axis.through - 1), axis.granularity);
  let first = bucketStart(Math.min(axis.since, requested), axis.granularity);
  if ((last - first) / step >= MAX_AXIS_BUCKETS) first = last - (MAX_AXIS_BUCKETS - 1) * step;
  const columns = new Map<number, UsageColumn>();
  for (let bucketTs = first; bucketTs <= last; bucketTs += step) columns.set(bucketTs, column(bucketTs, 0));
  // Every bucket the plane sent is drawn, even one off this grid, so filling never drops data.
  for (const bucket of series) columns.set(bucket.bucketTs, column(bucket.bucketTs, metricValue(bucket, metric)));
  return [...columns.values()].sort((a, b) => a.bucketTs - b.bucketTs);
}

const PERIOD_ADJECTIVE: Record<UsageAggregationGranularity, string> = { hour: "Hourly", day: "Daily", week: "Weekly" };

function peakWhen(bucketTs: number, granularity: UsageAggregationGranularity): string {
  if (granularity === "hour") return `on ${shortUtcDate(bucketTs)} at ${utcHour(bucketTs)}:00`;
  if (granularity === "week") return `in the week of ${shortUtcDate(bucketTs)}`;
  return `on ${shortUtcDate(bucketTs)}`;
}

/**
 * The readout's resting line, useful before anyone points at a column: the average recorded
 * bucket and the peak with its date, "Daily average $6.46 · Peak $16.10 on Aug 17". Not Recorded
 * buckets are not zero usage, so they stay out of the average.
 */
export function usageRestingSummary(
  columns: readonly UsageColumn[],
  metric: UsageMetric,
  granularity: UsageAggregationGranularity,
): { average: string; peak: string | null } {
  const recorded = columns.filter((column) => column.recorded);
  const sum = recorded.reduce((total, column) => total + column.total, 0);
  const average = `${PERIOD_ADJECTIVE[granularity]} average ${formatMetric(recorded.length > 0 ? sum / recorded.length : 0, metric)}`;
  const peak = recorded.reduce<UsageColumn | null>((best, column) => (!best || column.total > best.total ? column : best), null);
  return {
    average,
    peak: peak && peak.total > 0 ? `Peak ${formatMetric(peak.total, metric)} ${peakWhen(peak.bucketTs, granularity)}` : null,
  };
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

const shortUtcDate = (timestamp: number) => new Date(timestamp).toLocaleDateString("en-US", {
  timeZone: "UTC", month: "short", day: "numeric",
});

const fullUtcDate = (timestamp: number) => new Date(timestamp).toLocaleDateString("en-US", {
  timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
});

/** The headline's caption: what the figure is and the dates it covers, read from the response's
 * clamped window rather than the range the user last chose, so a headline never labels one
 * window's totals with another's length. A window that starts where recording started says so
 * instead of naming a length it does not have. `through` is exclusive, so the last day shown is
 * the one holding its final instant. A window that crosses a year names the year on both dates. */
export function usageWindowCaption(
  metric: UsageMetric,
  data: Pick<UsageAggregationResponse, "since" | "through" | "retention">,
): string {
  const subject = metric === "cost" ? "Estimated API cost" : "Processed tokens";
  const last = Math.max(data.since, data.through - 1);
  const date = new Date(data.since).getUTCFullYear() === new Date(last).getUTCFullYear() ? shortUtcDate : fullUtcDate;
  if (data.retention.coverageStartedAt >= data.since) {
    return `${subject} since ${date(data.since)}, when recording started`;
  }
  const [first, final] = [date(data.since), date(last)];
  return first === final ? `${subject}, ${first}` : `${subject}, ${first} – ${final}`;
}

const utcHour = (timestamp: number) => String(new Date(timestamp).getUTCHours()).padStart(2, "0");

function shortUtcWeek(bucketTs: number): string {
  const end = bucketTs + 6 * 86_400_000;
  const startDate = new Date(bucketTs);
  const endDate = new Date(end);
  if (startDate.getUTCFullYear() === endDate.getUTCFullYear() && startDate.getUTCMonth() === endDate.getUTCMonth()) {
    return `${shortUtcDate(bucketTs)}–${endDate.getUTCDate()}`;
  }
  return `${shortUtcDate(bucketTs)}–${shortUtcDate(end)}`;
}

/** Short labels retain enough UTC calendar context to distinguish repeated hours and weeks. */
export function axisLabel(bucketTs: number, granularity: UsageAggregationGranularity): string {
  const date = new Date(bucketTs);
  if (granularity === "hour") return `${shortUtcDate(bucketTs)} · ${utcHour(bucketTs)}:00`;
  if (granularity === "week") return shortUtcWeek(bucketTs);
  return date.toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}

/** Complete UTC bucket labels shared by hover/focus readouts and the exact-value table. */
export function bucketLabel(
  bucketTs: number,
  granularity: UsageAggregationGranularity,
  bounds?: Pick<UsageAggregationResponse, "since" | "through">,
): string {
  if (granularity === "hour") return `${fullUtcDate(bucketTs)} · ${utcHour(bucketTs)}:00–${utcHour(bucketTs)}:59 UTC`;
  if (granularity === "week") {
    const end = bucketTs + 6 * 86_400_000;
    const isPartial = bounds !== undefined &&
      (bounds.since > bucketTs || bounds.through < bucketTs + 7 * 86_400_000);
    return `${fullUtcDate(bucketTs)} 00:00–${fullUtcDate(end)} 23:59 UTC${isPartial ? " (Partial)" : ""}`;
  }
  return `${fullUtcDate(bucketTs)} · 00:00–23:59 UTC`;
}

/** A time table row's name. The column header says the zone, "Day (UTC)", so the row says only
 * which period: "Sep 3, 2026", "Sep 3, 2026 · 14:00", or "Sep 14–20, 2026" for a week. */
export function periodLabel(
  bucketTs: number,
  granularity: UsageAggregationGranularity,
  bounds?: Pick<UsageAggregationResponse, "since" | "through">,
): string {
  if (granularity === "hour") return `${fullUtcDate(bucketTs)} · ${utcHour(bucketTs)}:00`;
  if (granularity === "day") return fullUtcDate(bucketTs);
  const end = bucketTs + 6 * 86_400_000;
  const lastYear = new Date(end).getUTCFullYear();
  const range = new Date(bucketTs).getUTCFullYear() !== lastYear
    ? `${fullUtcDate(bucketTs)}–${fullUtcDate(end)}`
    : `${shortUtcWeek(bucketTs)}, ${lastYear}`;
  const isPartial = bounds !== undefined && (bounds.since > bucketTs || bounds.through < bucketTs + 7 * 86_400_000);
  return isPartial ? `${range} (Partial)` : range;
}

/** Rows the time table shows before "Show All 30 Days". */
export const PERIOD_ROWS_SHOWN = 7;

/** Two amounts as one, field by field. Each field is additive by construction (`processedTokens`
 * is derived per row so it sums), and a sum is unpriced if either part is, as the plane resolves it. */
export function addUsageAmounts(a: UsageAmount, b: UsageAmount): UsageAmount {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheSavingsUsd: a.cacheSavingsUsd + b.cacheSavingsUsd,
    processedTokens: processedTokens(a) + processedTokens(b),
    costSource: a.costSource === "unpriced" || b.costSource === "unpriced" ? "unpriced"
      : a.costSource === "modelPriced" || b.costSource === "modelPriced" ? "modelPriced" : "providerReported",
    unpricedRecords: a.unpricedRecords + b.unpricedRecords,
  };
}

/** The plane's remainder row past its 20 largest. */
export const OTHER_BREAKDOWN_KEY = "Other";

export interface BreakdownRow {
  key: string;
  name: string;
  amount: UsageAmount;
  /** Share of the window's total for the ACTIVE metric. */
  share: number;
}

/**
 * A By Model, By Agent or By Machine table's rows: named, largest first by the active metric, and
 * "Other" last whatever its size, since it is not one thing to rank.
 */
export function breakdownRows(
  rows: readonly UsageBreakdown[],
  nameOf: (key: string) => string,
  metric: UsageMetric,
  totals: UsageAmount,
): BreakdownRow[] {
  const total = metricValue(totals, metric);
  return rows
    .map(({ key, ...amount }) => ({
      key,
      name: key === OTHER_BREAKDOWN_KEY ? key : nameOf(key),
      amount,
      share: total > 0 ? metricValue(amount, metric) / total : 0,
    }))
    .sort((a, b) => Number(a.key === OTHER_BREAKDOWN_KEY) - Number(b.key === OTHER_BREAKDOWN_KEY) ||
      metricValue(b.amount, metric) - metricValue(a.amount, metric));
}

/**
 * The plane keys an agent's usage as "agent id / model" ("claude-code / claude-fable-5-1"). By
 * Agent compares agents, so each key is cut at its FIRST " / " (a model id may hold one, an agent
 * id never does) and an agent's models are summed into one row. A later protocol field can replace
 * the split; until then older planes keep working.
 */
export function agentBreakdown(rows: readonly UsageBreakdown[]): UsageBreakdown[] {
  const byAgent = new Map<string, UsageBreakdown>();
  for (const { key, ...amount } of rows) {
    const cut = key.indexOf(" / ");
    const agentId = key === OTHER_BREAKDOWN_KEY || cut < 0 ? key : key.slice(0, cut);
    const current = byAgent.get(agentId);
    byAgent.set(agentId, { key: agentId, ...(current ? addUsageAmounts(current, amount) : amount) });
  }
  return [...byAgent.values()];
}

/** Whole micro-dollars, the precision the daily-budget gate compares at. */
const micros = (usd: number) => Math.round(usd * 1_000_000);

/** A person's spend today as the daily-budget gate counts it: settled spend plus the open estimate
 * of their running turns (#3196). */
export function todaySpendUsd(row: Pick<UserCostWindows, "todayUsd" | "todayEstimateUsd">): number {
  return micros(row.todayUsd + (row.todayEstimateUsd ?? 0)) / 1_000_000;
}

/** At or over the daily budget, the point at which the gate pauses the person's new turns. */
export function dailyBudgetReached(row: Pick<UserCostWindows, "todayUsd" | "todayEstimateUsd" | "dailyBudgetUsd">): boolean {
  return row.dailyBudgetUsd != null && row.dailyBudgetUsd > 0 && micros(todaySpendUsd(row)) >= micros(row.dailyBudgetUsd);
}

/**
 * Indexes of the columns that get an axis label, at most `limit`: the first column and every
 * `step` after it, then the last, which the chart end-anchors at the plot's right edge so it is
 * never clipped. A step label within one step of the last is skipped rather than drawn into it
 * ("Sep 2Sep 3"). An end-anchored label reaches further left than a centred one, so the chart
 * passes `lastClearance`, in columns, when its labels are wider than that one step allows for.
 */
export function axisLabelIndexes(count: number, limit = 8, lastClearance = 1): number[] {
  if (count <= 0) return [];
  const lastIndex = count - 1;
  const step = count <= limit ? 1 : Math.ceil(lastIndex / (Math.max(2, limit) - 1));
  const clearance = Math.max(step, lastClearance);
  const indexes: number[] = [];
  for (let index = 0; index < lastIndex; index += step) {
    if (lastIndex - index >= clearance) indexes.push(index);
  }
  indexes.push(lastIndex);
  return indexes;
}

export interface CoverageNotice {
  /** Offline Machines by display name (`runnerDisplay()`), never by hostname. */
  offlineMachines: string[];
  unpricedRecords: number;
  legacyClaudeCostRecords?: number;
  pricing?: UsageAggregationResponse["pricing"];
}

/** One gap in the totals (#3016): what is missing, so the notice can say it and offer its fix. */
export type CoverageItem =
  | { kind: "offline-machines"; machines: string[] }
  | { kind: "unpriced"; records: number }
  | { kind: "legacy-claude"; records: number }
  | { kind: "rates-unavailable" }
  | { kind: "rates-cached" };

/** What is missing from the totals, in the order the notice says it; empty when they are complete
 * and fully priced. */
export function coverageMessages(notice: CoverageNotice): CoverageItem[] {
  const items: CoverageItem[] = [];
  if (notice.offlineMachines.length > 0) items.push({ kind: "offline-machines", machines: notice.offlineMachines });
  if (notice.unpricedRecords > 0) items.push({ kind: "unpriced", records: notice.unpricedRecords });
  const legacy = notice.legacyClaudeCostRecords ?? 0;
  if (legacy > 0) items.push({ kind: "legacy-claude", records: legacy });
  if (notice.pricing?.status === "unavailable") items.push({ kind: "rates-unavailable" });
  else if (notice.pricing?.status === "cached") items.push({ kind: "rates-cached" });
  return items;
}

const MACHINE_LIST = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** One sentence per gap, in the person's words: a turn rather than a record, a Machine by name. */
export function coverageSentence(item: CoverageItem): string {
  switch (item.kind) {
    case "offline-machines": {
      const one = item.machines.length === 1;
      return `${MACHINE_LIST.format(item.machines)} ${one ? "is" : "are"} offline, so usage ${one ? "it hasn't" : "they haven't"} reported yet isn't counted.`;
    }
    case "unpriced":
      return item.records === 1
        ? "1 turn has no price because no rate is known for its model."
        : `${item.records.toLocaleString("en-US")} turns have no price because no rate is known for their model.`;
    case "legacy-claude":
      return "Some older Claude Code costs were recorded in a way that can count a resumed session's spending more than once.";
    case "rates-unavailable":
      return "No rates are loaded, so turns without a cost from their provider have no price.";
    case "rates-cached":
      return "Rates couldn't be updated, so costs use the last rates Wollipog loaded.";
  }
}

/** Whether loading newer rates could help: something is unpriced, or the rates are missing or old. */
export function coverageNeedsRates(items: readonly CoverageItem[]): boolean {
  return items.some((item) => item.kind === "unpriced" || item.kind === "rates-unavailable" || item.kind === "rates-cached");
}

/** What a Refresh Rates that didn't produce a fresh table says: a sentence in the notice and its
 * reason behind Show Details, one paragraph each. */
export interface RatesRefreshProblem {
  summary: string;
  details: string[];
}

const COULD_NOT_REFRESH = "Rates couldn't be refreshed.";

/** Ends the plane's failure text as a sentence; it arrives as a bare clause. */
function asSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** Why a Refresh Rates answer didn't fetch a fresh table (#3016, #4056), or `null` when it did. A
 * plane that predates #4056 sends neither the failure nor the skip, so it keeps the general wording. */
export function ratesRefreshProblem(pricing: UsagePricingStatus): RatesRefreshProblem | null {
  if (pricing.source === "disabled") return { summary: COULD_NOT_REFRESH, details: ["Rate fetching is turned off on this control plane."] };
  const failure = pricing.lastRefreshError?.message;
  if (pricing.refreshSkipped) {
    const seconds = Math.max(1, Math.ceil(pricing.refreshSkipped.retryAfterMs / 1000));
    return {
      summary: "This refresh was skipped because one ran less than a minute ago.",
      details: [
        `Wollipog tries the rate source at most once a minute. Try again in ${seconds === 1 ? "1 second" : `${seconds} seconds`}.`,
        // A failed attempt leaves the rates cached or unavailable, so fresh rates mean it succeeded.
        failure ? `The last attempt failed: ${asSentence(failure)}`
          : pricing.status === "fresh" ? "The last attempt succeeded, so the rates are current." : null,
      ].filter((line): line is string => line !== null),
    };
  }
  if (pricing.status === "fresh") return null;
  if (failure) {
    return {
      summary: COULD_NOT_REFRESH,
      details: [`${pricing.source} couldn't be fetched: ${asSentence(failure)}`, `The rates are still ${pricing.status}.`],
    };
  }
  return {
    summary: COULD_NOT_REFRESH,
    details: [
      `${pricing.source} didn't return a usable rate table, so the rates are still ${pricing.status}. ` +
        "Wollipog fetches them at most once a minute; the control plane's log has the cause.",
    ],
  };
}

/** A window with nothing in it (#3016): no processed tokens and no cost. */
export function usageIsEmpty(totals: UsageAmount): boolean {
  return processedTokens(totals) === 0 && totals.costUsd === 0;
}
