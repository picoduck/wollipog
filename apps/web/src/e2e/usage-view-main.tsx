import React from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentDriverKind,
  RunnerView,
  SubscriptionUsageResponse,
  UiSnapshotMessage,
  UsageAggregationGranularity,
  UsageAggregationResponse,
  UsageAmount,
  UsageDriverTimeBucket,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { Shell } from "../App.js";
import { FeedbackProvider } from "../components/FeedbackProvider.js";
import { ThemeProvider } from "../components/ThemeProvider.js";
import { UsageView } from "../components/UsageView.js";
import type { UsageTab, ViewNavigation } from "../navigation.js";
import { StoreProvider } from "../store.js";
import { UI_SOCKET_OPEN, type UiConnectionRuntime, type UiSocket } from "../ui-transport.js";
import "../styles.css";

/**
 * The Usage & Cost view over a deterministic 30-day window, for screenshots and the spec. Query
 * flags: `?theme=light|dark`, `?empty=1` for a window with no usage, `?unpriced=1` for a partially
 * unpriced window with a cached rate table, `?subscriptions=1` for the Claude subscription cards,
 * `?tab=subscriptions` to open the Subscriptions tab, `?hourlyDays=14` for shorter hourly
 * retention, `?noWeek=1` for a plane without weekly aggregation, `?coverage=recent` for recording
 * that started yesterday, so the 30-day window is clamped to its first day, `?coverageDays=10` for
 * recording that started ten days ago, `?sparse=1` for usage on only three of the 30 days, and
 * `?refreshFailed=2` for a subscription refresh where two of three machines failed. A refresh takes
 * 600ms, so it can be seen. Budget and History (#3015): `?member=1` for a viewer who cannot manage
 * them, `?retentionFails=1` for a retention save that fails after the budget saved.
 * The page's states (#3016): `?state=loading` for a first load that never answers, `?state=error`
 * for one that fails, `?offline=1` for a connection that drops after the page loads, and
 * `?offlineMachine=1` for Build Box offline.
 * `?fullShell=1` renders the real application shell to exercise page scrolling and navigation.
 */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");
// `?scheme=dracula` (or another alternative): the colour scheme, as the shell sets it.
if (params.get("scheme")) document.documentElement.setAttribute("data-scheme", params.get("scheme")!);

const DAY = 86_400_000;
const END = Date.UTC(2026, 8, 3);

function amount(input: number, cached: number, output: number, costUsd: number, over: Partial<UsageAmount> = {}): UsageAmount {
  return {
    inputTokens: input, outputTokens: output, costUsd, uncachedInputTokens: input, cachedInputTokens: cached,
    cacheCreationTokens: Math.round(cached / 12), reasoningTokens: Math.round(output / 5),
    cacheSavingsUsd: cached * 0.0000045, costSource: "providerReported", unpricedRecords: 0,
    processedTokens: input + cached + Math.round(cached / 12) + output, ...over,
  };
}

function add(a: UsageAmount, b: UsageAmount): UsageAmount {
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, costUsd: a.costUsd + b.costUsd,
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens, cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens, reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    cacheSavingsUsd: a.cacheSavingsUsd + b.cacheSavingsUsd,
    processedTokens: a.processedTokens + b.processedTokens,
    costSource: a.costSource === "unpriced" || b.costSource === "unpriced" ? "unpriced"
      : a.costSource === "modelPriced" || b.costSource === "modelPriced" ? "modelPriced" : "providerReported",
    unpricedRecords: a.unpricedRecords + b.unpricedRecords,
  };
}

const unpriced = params.get("unpriced") === "1";
const empty = params.get("empty") === "1";
const recentCoverage = params.get("coverage") === "recent";
// `?coverageDays=10`: recording started ten days ago, so the chart's first 20 days are Not Recorded.
const coverageDays = Number(params.get("coverageDays") ?? 0);
// `?sparse=1`: usage on only three days of the 30, so the rest of the axis is zero.
const sparse = params.get("sparse") === "1";
const COVERAGE_STARTED_AT = recentCoverage ? END - DAY + 15 * 3_600_000 + 20 * 60_000
  : coverageDays > 0 ? END - (coverageDays - 1) * DAY : Date.UTC(2026, 6, 1);
// The plane clamps the window to the day recording started, as `usage-aggregation.ts` does.
const SINCE = recentCoverage ? END - DAY : coverageDays > 0 ? COVERAGE_STARTED_AT : END - 29 * DAY;
// Each driver's agent, the model it ran and the machine it ran on, as the store names them.
const drivers: Array<{
  driver: AgentDriverKind; agentId: string; agentName: string; model: string; modelName: string; runnerId: string; weight: number;
}> = [
  { driver: "claude-code", agentId: "claude", agentName: "Claude Code", model: "claude-fable-5-1", modelName: "Fable 5.1", runnerId: "r-build-box", weight: 1 },
  { driver: "codex-app-server", agentId: "codex", agentName: "Codex App Server", model: "gpt-5.5-codex", modelName: "GPT-5.5-Codex", runnerId: "r-studio", weight: 0.55 },
  { driver: "acp", agentId: "gemini", agentName: "Gemini CLI", model: "gemini-3-pro", modelName: "Gemini 3 Pro", runnerId: "r-studio", weight: 0.18 },
];

// A deterministic 30-day shape: weekday activity with a mid-month push, weekends quiet.
const seriesByDriver: UsageDriverTimeBucket[] = [];
for (let dayIndex = 0; dayIndex < 30 && !empty; dayIndex += 1) {
  const bucketTs = END - (29 - dayIndex) * DAY;
  if (bucketTs < SINCE) continue;
  if (sparse && ![4, 17, 26].includes(dayIndex)) continue;
  const weekday = new Date(bucketTs).getUTCDay();
  const quiet = weekday === 0 || weekday === 6;
  const push = dayIndex >= 12 && dayIndex <= 17 ? 1.9 : 1;
  const base = (quiet ? 0.18 : 1) * push * (0.7 + ((dayIndex * 7) % 5) * 0.12);
  for (const entry of drivers) {
    const scale = base * entry.weight;
    const input = Math.round(220_000 * scale);
    const cached = Math.round(1_400_000 * scale);
    const output = Math.round(38_000 * scale);
    const cost = 4.2 * scale;
    const codexUnpriced = unpriced && entry.driver === "codex-app-server" && dayIndex % 6 === 2;
    seriesByDriver.push({
      bucketTs, driver: entry.driver,
      ...amount(input, cached, output, codexUnpriced ? 0 : cost, {
        costSource: codexUnpriced ? "unpriced" : entry.driver === "claude-code" ? "providerReported" : "modelPriced",
        unpricedRecords: codexUnpriced ? 3 : 0,
      }),
    });
  }
}
const byBucket = new Map<number, UsageAmount>();
for (const row of seriesByDriver) byBucket.set(row.bucketTs, add(byBucket.get(row.bucketTs) ?? amount(0, 0, 0, 0), row));
const series = [...byBucket.entries()].map(([bucketTs, total]) => ({ bucketTs, ...total })).sort((a, b) => b.bucketTs - a.bucketTs);
const totals = series.reduce((sum, bucket) => add(sum, bucket), amount(0, 0, 0, 0));
const byDriver = drivers.map((entry) => ({
  key: entry.driver,
  ...seriesByDriver.filter((row) => row.driver === entry.driver).reduce((sum, row) => add(sum, row), amount(0, 0, 0, 0)),
})).filter((row) => row.inputTokens > 0);
const byModel = drivers.map((entry) => ({
  key: entry.model,
  ...seriesByDriver.filter((row) => row.driver === entry.driver).reduce((sum, row) => add(sum, row), amount(0, 0, 0, 0)),
})).filter((row) => row.inputTokens > 0);

const response: UsageAggregationResponse = {
  granularity: "day",
  supportedGranularities: params.get("noWeek") === "1" ? ["hour", "day"] : ["hour", "day", "week"],
  hourlyDataAvailable: true,
  since: SINCE,
  through: END + DAY,
  retention: { hourlyDays: Number(params.get("hourlyDays") ?? 30), dailyDays: 365, coverageStartedAt: COVERAGE_STARTED_AT },
  canManageRetention: params.get("member") !== "1",
  privacy: "content-free aggregates only; no session ids, prompts, paths, tool inputs, event bodies, environment values, or auth data",
  totals,
  series,
  seriesByDriver: [...seriesByDriver].sort((a, b) => b.bucketTs - a.bucketTs || a.driver.localeCompare(b.driver)),
  byDriver,
  byAgent: byModel.map((row) => {
    const entry = drivers.find((candidate) => candidate.model === row.key)!;
    return { ...row, key: `${entry.agentId} / ${row.key}` };
  }),
  byRunner: [...new Set(drivers.map((entry) => entry.runnerId))].map((runnerId) => ({
    key: runnerId,
    ...byModel.filter((row) => drivers.find((entry) => entry.model === row.key)!.runnerId === runnerId)
      .reduce((sum, row) => add(sum, row), amount(0, 0, 0, 0)),
  })),
  byModel,
  pricing: {
    status: unpriced ? "cached" : "fresh",
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    fetchedAt: END - 3 * 3_600_000,
    knownModels: 1287,
  },
};

// Refresh Rates loads a fresh table, which the next answer reports.
let ratesRefreshed = false;
let ratesRefreshAttempts = 0;

function aggregateResponse(granularity: UsageAggregationGranularity): UsageAggregationResponse {
  const bucketStart = (timestamp: number) => {
    if (granularity === "hour") return timestamp + 3 * 3_600_000;
    if (granularity === "week") {
      const day = new Date(timestamp).getUTCDay();
      return timestamp - ((day + 6) % 7) * DAY;
    }
    return timestamp;
  };
  const driverBuckets = new Map<string, UsageDriverTimeBucket>();
  for (const row of response.seriesByDriver) {
    const bucketTs = bucketStart(row.bucketTs);
    const key = `${bucketTs}:${row.driver}`;
    const current = driverBuckets.get(key);
    driverBuckets.set(key, {
      ...(current ? add(current, row) : row),
      bucketTs,
      driver: row.driver,
    });
  }
  const nextSeriesByDriver = [...driverBuckets.values()]
    .sort((a, b) => b.bucketTs - a.bucketTs || a.driver.localeCompare(b.driver));
  const buckets = new Map<number, UsageAmount>();
  for (const row of nextSeriesByDriver) buckets.set(row.bucketTs, add(buckets.get(row.bucketTs) ?? amount(0, 0, 0, 0), row));
  return {
    ...response,
    granularity,
    retention,
    legacyClaudeCostRecords: params.get("legacyCosts") === "1" ? 10 : 0,
    ...(params.get("runningTotals") === "1" ? { runningTotalClaudeRecords: 4 } : {}),
    pricing: ratesRefreshed ? { ...response.pricing!, status: "fresh" } : response.pricing,
    seriesByDriver: nextSeriesByDriver,
    series: [...buckets.entries()].map(([bucketTs, total]) => ({ bucketTs, ...total })).sort((a, b) => b.bucketTs - a.bucketTs),
  };
}

// Exactly what the runner's Claude normalizer produces from real `rate_limit_event` messages
// (#224): a current build reporting every window it tracks, a build that reports resets but no
// utilization, and a source that answered without carrying allowance headers at all.
// Allowance windows are read against the live clock, so anchor them to it: a fixed past date
// would render every card as "Reset time has passed".
const SUBSCRIPTION_NOW = Date.now();
const claudeSource = {
  runnerId: "r-build-box", runnerName: "build-box", runnerStatus: "online" as const,
  provider: "claude" as const, freshness: "fresh" as const, plan: "max",
  fetchedAt: SUBSCRIPTION_NOW,
};
const subscription: SubscriptionUsageResponse = {
  sources: params.get("subscriptions") !== "1" ? [] : [
    {
      runnerId: "r-build-box", runnerName: "build-box", runnerStatus: "online",
      provider: "codex", freshness: "fresh", plan: "pro",
      fetchedAt: SUBSCRIPTION_NOW, sourceId: "8b66ac9939adad73bfadb15095f19d9c",
      providerAccountId: "codex-work",
      agentId: "codex", agentName: "Codex App Server", state: "available",
      accountLabel: "codex@example.com",
      buckets: [
        { id: "codex:primary", label: "Codex — Weekly", usedPercent: 42, remainingPercent: 58,
          windowDurationMinutes: 10_080, resetsAt: SUBSCRIPTION_NOW + 6 * DAY, status: "available" },
        // A used-up window (#3014): Exhausted, with a danger meter.
        { id: "codex_spark:primary", label: "GPT-5.3-Codex-Spark — 5-Hour Window",
          usedPercent: 100, remainingPercent: 0, windowDurationMinutes: 300,
          resetsAt: SUBSCRIPTION_NOW + 5 * 3_600_000, status: "exhausted" },
        { id: "codex_spark:secondary", label: "GPT-5.3-Codex-Spark — Weekly",
          usedPercent: 0, remainingPercent: 100, windowDurationMinutes: 10_080,
          resetsAt: SUBSCRIPTION_NOW + 7 * DAY, status: "available" },
      ],
      credits: { hasCredits: false, balance: "0" },
      spendControls: [{ id: "monthly", label: "Monthly Limit", used: "$12", limit: "$50" }],
    },
    {
      ...claudeSource, sourceId: "4e9ca361dace7ad20c621d0eadac54f0",
      providerAccountId: "claude-work",
      agentId: "claude", agentName: "Claude Code", state: "available",
      accountLabel: "primary@example.com",
      buckets: [
        { id: "five_hour", label: "Five-Hour Window", usedPercent: 83, remainingPercent: 17,
          resetsAt: SUBSCRIPTION_NOW + 2 * 3_600_000 + 41 * 60_000, status: "warning" },
        { id: "seven_day", label: "Weekly — All Models", usedPercent: 46, remainingPercent: 54,
          resetsAt: SUBSCRIPTION_NOW + 4 * DAY, status: "available" },
        { id: "seven_day_overage_included", label: "Weekly — Extra Usage", usedPercent: 12,
          remainingPercent: 88, resetsAt: SUBSCRIPTION_NOW + 4 * DAY, status: "available" },
      ],
    },
    {
      ...claudeSource, sourceId: "8a66ac9939adad73bfadb15095f19d9c",
      providerAccountId: "claude-personal",
      agentId: "claude-wsl", agentName: "Claude Code (Ubuntu)", state: "available",
      accountLabel: "alternate@example.com",
      detail: "Claude Code reported allowance windows for this source without utilization " +
        "percentages. Older Claude Code versions report window status and reset times only; " +
        "update Claude Code if this persists.",
      buckets: [
        { id: "five_hour", label: "Five-Hour Window",
          resetsAt: SUBSCRIPTION_NOW + 3 * 3_600_000 + 12 * 60_000, status: "available" },
        // A status-only `allowed_warning` event: no utilization, but the provider still warned.
        { id: "seven_day", label: "Weekly — All Models",
          resetsAt: SUBSCRIPTION_NOW + 5 * DAY, status: "warning" },
      ],
    },
    {
      ...claudeSource, sourceId: "c58daf328f0472d9a39dee04533481c4",
      agentId: "claude-api", agentName: "Claude Code (Debian)", state: "unavailable",
      detail: "Claude Code answered without reporting subscription allowances. Only Claude.ai " +
        "subscription sessions carry them; API-key, Bedrock, and Vertex sessions never do.",
      buckets: [],
    },
    // Two more sources with no windows (#3014): a machine that went offline before it reported,
    // and a Codex sign-in with an API key. With the one above they fold into one disclosure.
    {
      ...claudeSource, runnerId: "r-laptop", runnerName: "laptop", runnerStatus: "offline",
      sourceId: "0f3ad6b1c2e94d7f8a5b6c7d8e9f0a1b", agentId: "claude", agentName: "Claude Code",
      state: "unavailable", freshness: "stale", fetchedAt: SUBSCRIPTION_NOW - 26 * 3_600_000, buckets: [],
    },
    {
      runnerId: "r-ci", runnerName: "ci-runner", runnerStatus: "online", provider: "codex",
      freshness: "fresh", fetchedAt: SUBSCRIPTION_NOW, sourceId: "1a2b3c4d5e6f708192a3b4c5d6e7f809",
      agentId: "codex", agentName: "Codex App Server", state: "not_applicable",
      detail: "Codex is using API-key billing; subscription allowances do not apply.", buckets: [],
    },
  ],
  staleAfterMs: 600_000,
  generatedAt: END,
};
// `?sharedSubscription=1`: one Claude subscription on three machines, one offline and one waiting.
// `?claudeRefreshable=1`: a control plane at protocol 342 says the Claude Work account can be read on
// request. Without it the fixture speaks as an older one, which says nothing about refresh.
if (params.get("claudeRefreshable") === "1") {
  subscription.sources = subscription.sources.map((source) =>
    source.providerAccountId === "claude-work" ? { ...source, refreshable: true } : source);
}
if (params.get("sharedSubscription") === "1") {
  const shared = { provider: "claude" as const, agentId: "claude", agentName: "Claude Code", plan: "max",
    accountLabel: "primary@example.com", subscriptionKey: "shared-claude-max" };
  subscription.sources = [
    { ...shared, runnerId: "r-laptop", runnerName: "laptop", runnerStatus: "online", freshness: "fresh",
      sourceId: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", state: "available", fetchedAt: SUBSCRIPTION_NOW - 3 * 60_000,
      buckets: [
        { id: "five_hour", label: "Five-Hour Window", usedPercent: 52, remainingPercent: 48,
          resetsAt: SUBSCRIPTION_NOW + 2 * 3_600_000, status: "available" },
        { id: "seven_day", label: "Weekly — All Models", usedPercent: 19, remainingPercent: 81,
          resetsAt: SUBSCRIPTION_NOW + 6 * DAY, status: "available" },
      ] },
    { ...shared, runnerId: "r-box", runnerName: "build-box", runnerStatus: "online", freshness: "fresh",
      sourceId: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2", state: "unavailable", fetchedAt: SUBSCRIPTION_NOW,
      detail: "Claude subscription usage is available after the first provider response in a session.", buckets: [] },
    { ...shared, runnerId: "r-studio", runnerName: "studio", runnerStatus: "offline", freshness: "stale",
      sourceId: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3", state: "available", fetchedAt: SUBSCRIPTION_NOW - 26 * 3_600_000,
      buckets: [
        { id: "five_hour", label: "Five-Hour Window", usedPercent: 90, remainingPercent: 10,
          resetsAt: SUBSCRIPTION_NOW - 20 * 3_600_000, status: "warning" },
      ] },
  ];
}
if (params.get("selectedUnavailable") === "1" && subscription.sources[0]) {
  const { credits: _credits, plan: _plan, ...source } = subscription.sources[0];
  subscription.sources[0] = {
    ...source,
    state: "unsupported",
    detail: "The selected harness installation is unavailable in this execution context.",
    buckets: [],
  };
}

let dailyBudget: { perUserUsd: number | null; updatedAt: number | null } = { perUserUsd: 25, updatedAt: END };
let retention = response.retention;
const users = [
  { userId: "u-ada", userName: "Ada", todayUsd: 26.4, last7DaysUsd: 112.2, last30DaysUsd: 401.7 },
  // Grace has a turn running: the plane sends its open estimate beside her settled spend.
  { userId: "u-grace", userName: "Grace", todayUsd: 9.8, todayEstimateUsd: 1.25, last7DaysUsd: 61.3, last30DaysUsd: 240.1 },
  { userId: "u-linus", userName: "Linus", todayUsd: 0, last7DaysUsd: 4.5, last30DaysUsd: 38.9 },
];
const client = {
  ...api,
  usageDailyBudget: async () => ({ dailyBudget }),
  updateUsageDailyBudget: async (perUserUsd: number | null) => {
    dailyBudget = { perUserUsd, updatedAt: END };
    return { dailyBudget };
  },
  usageUsers: async () => ({
    users: users.map(({ todayEstimateUsd, ...user }) => ({
      ...user,
      dailyBudgetUsd: dailyBudget.perUserUsd,
      ...(dailyBudget.perUserUsd != null && todayEstimateUsd ? { todayEstimateUsd } : {}),
    })),
  }),
  updateUsageRetention: async (input: { hourlyDays: number; dailyDays: number }) => {
    if (params.get("retentionFails") === "1") throw new Error("Usage retention is temporarily unavailable.");
    retention = { ...retention, ...input };
    return { retention };
  },
  usage: async (input: { granularity?: UsageAggregationGranularity }) => {
    // `?state=loading`: the first answer never comes; `?state=error`: every answer fails.
    if (params.get("state") === "loading") return await new Promise<never>(() => {});
    if (params.get("state") === "error") throw new Error("Request failed: 502 Bad Gateway (GET /api/usage)");
    return aggregateResponse(input.granularity ?? "day");
  },
  refreshUsagePricing: async () => {
    // `?ratesRefresh=timeout|invalid`: the fetch fails with that reason, and every later click
    // lands inside the plane's one-minute refresh floor (#4056).
    const failure = params.get("ratesRefresh");
    if (failure === "timeout" || failure === "invalid") {
      const lastRefreshError = {
        message: failure === "timeout" ? "the rate source didn't answer within 30 seconds" : "rate table document isn't valid JSON",
        at: END,
      };
      ratesRefreshAttempts += 1;
      return { pricing: {
        ...response.pricing!,
        status: "cached" as const,
        lastRefreshError,
        ...(ratesRefreshAttempts > 1 ? { refreshSkipped: { nextAttemptAt: END + 60_000, retryAfterMs: 42_000 } } : {}),
      } };
    }
    ratesRefreshed = true;
    return { pricing: { ...response.pricing!, status: "fresh" as const } };
  },
  subscriptionUsage: async () => subscription,
  refreshSubscriptionUsage: async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    const failed = Number(params.get("refreshFailed") ?? 0);
    return { ...subscription, refresh: { attempted: 3, failed } };
  },
} as unknown as ApiClient;

/** The tab is `?tab=subscriptions`, pushed like the shell's route so Back returns to the last tab. */
function currentTab(): UsageTab | undefined {
  return new URLSearchParams(window.location.search).get("tab") === "subscriptions" ? undefined : "api";
}

function UsageRoute() {
  const [tab, setTab] = React.useState(currentTab);
  React.useEffect(() => {
    const listener = () => setTab(currentTab());
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);
  return (
    <UsageView
      tab={tab}
      onSelectTab={(next) => {
        const url = new URL(window.location.href);
        if (next === "api") url.searchParams.delete("tab");
        else url.searchParams.set("tab", "subscriptions");
        window.history.pushState(null, "", url);
        setTab(next);
      }}
    />
  );
}

/** The fleet the store knows, so By Agent, By Machine and By Model show the names people gave them.
 * `?anonymous=1` leaves the store empty, as a plane whose machines are not visible would. */
const runners: RunnerView[] = params.get("anonymous") === "1" ? [] : [
  { runnerId: "r-build-box", displayName: "Build Box" },
  { runnerId: "r-studio", displayName: "Studio Mac" },
].map(({ runnerId, displayName }) => ({
  runnerId, displayName, hostname: runnerId.slice(2), os: "linux", version: "1",
  // `?offlineMachine=1`: Build Box is offline, so the notice says its usage may be missing.
  status: params.get("offlineMachine") === "1" && runnerId === "r-build-box" ? "offline" : "online",
  workspaces: [], connectedAt: END, lastSeen: END,
  agents: drivers.filter((entry) => entry.runnerId === runnerId).map((entry) => ({
    id: entry.agentId, name: entry.agentName, command: entry.agentId, args: [], env: {}, driver: entry.driver, available: true,
    capabilities: { models: [{ id: entry.model, displayName: entry.modelName }], effortLevels: [] },
  })),
} as unknown as RunnerView));

// `?offline=1`: the connection drops once the page has loaded and never comes back.
const dropConnection = params.get("offline") === "1";
let dropped = false;
class FixtureSocket implements UiSocket {
  readonly readyState = UI_SOCKET_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    window.setTimeout(() => {
      // After the drop, every reconnect attempt stays unanswered.
      if (dropped || !this.onopen) return;
      this.onopen();
      const snapshot = { type: "snapshot", runners, boxes: [], sessions: [], runs: [], pods: [] } as unknown as UiSnapshotMessage;
      this.onmessage?.({ data: JSON.stringify(snapshot) });
      if (dropConnection) {
        window.setTimeout(() => {
          dropped = true;
          this.onclose?.({ code: 1006 });
        }, 600);
      }
    }, 0);
  }
  send() {}
  close() {}
}
const connection: UiConnectionRuntime = {
  instanceId: "usage-view-e2e", runtimeKey: "usage-view-e2e", createSocket: () => new FixtureSocket(), close() {},
};
// The harness owns its URL (`?tab=`); the store reads a fixed view and never navigates.
const navigation: ViewNavigation = { current: () => ({ name: "usage", tab: "api" }), push() {}, listen: () => () => {} };

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApiProvider client={client}>
      <FeedbackProvider>
        <StoreProvider connection={connection} navigation={navigation}>
          {/* The shell's main column, which is the `app` size container the compact tier answers to. */}
          {params.get("fullShell") === "1"
            ? <ThemeProvider><Shell /></ThemeProvider>
            : <main className="main"><UsageRoute /></main>}
        </StoreProvider>
      </FeedbackProvider>
    </ApiProvider>
  </React.StrictMode>,
);
