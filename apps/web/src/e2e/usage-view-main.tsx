import React from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentDriverKind,
  SubscriptionUsageResponse,
  UsageAggregationResponse,
  UsageAmount,
  UsageDriverTimeBucket,
} from "@wollipog/protocol";
import { api, type ApiClient } from "../api.js";
import { ApiProvider } from "../api-context.js";
import { UsageView } from "../components/UsageView.js";
import "../styles.css";

/**
 * The Usage & Cost view over a deterministic 30-day window, for screenshots and the spec. Query
 * flags: `?theme=light|dark`, `?empty=1` for a window with no usage, `?unpriced=1` for a partially
 * unpriced window with a cached rate table.
 */
const params = new URLSearchParams(window.location.search);
document.documentElement.setAttribute("data-theme", params.get("theme") === "light" ? "light" : "dark");

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
const drivers: Array<{ driver: AgentDriverKind; model: string; weight: number }> = [
  { driver: "claude-code", model: "claude-fable-5-1", weight: 1 },
  { driver: "codex-app-server", model: "gpt-5.5-codex", weight: 0.55 },
  { driver: "acp", model: "gemini-3-pro", weight: 0.18 },
];

// A deterministic 30-day shape: weekday activity with a mid-month push, weekends quiet.
const seriesByDriver: UsageDriverTimeBucket[] = [];
for (let dayIndex = 0; dayIndex < 30 && !empty; dayIndex += 1) {
  const bucketTs = END - (29 - dayIndex) * DAY;
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
  since: END - 29 * DAY,
  through: END + DAY,
  retention: { hourlyDays: 30, dailyDays: 365, coverageStartedAt: Date.UTC(2026, 6, 1) },
  canManageRetention: true,
  privacy: "content-free aggregates only; no session ids, prompts, paths, tool inputs, event bodies, environment values, or auth data",
  totals,
  series,
  seriesByDriver: [...seriesByDriver].sort((a, b) => b.bucketTs - a.bucketTs || a.driver.localeCompare(b.driver)),
  byDriver,
  byAgent: byDriver.map((row) => ({ ...row, key: `${row.key === "acp" ? "gemini" : row.key} / ${row.key}` })),
  byRunner: [{ key: "build-box", ...totals }],
  byModel,
  pricing: {
    status: unpriced ? "cached" : "fresh",
    source: "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    fetchedAt: END - 3 * 3_600_000,
    knownModels: 1287,
  },
};

const subscription: SubscriptionUsageResponse = { sources: [], staleAfterMs: 600_000, generatedAt: END };

let dailyBudget: { perUserUsd: number | null; updatedAt: number | null } = { perUserUsd: 25, updatedAt: END };
const users = [
  { userId: "u-ada", userName: "Ada", todayUsd: 26.4, last7DaysUsd: 112.2, last30DaysUsd: 401.7 },
  { userId: "u-grace", userName: "Grace", todayUsd: 9.8, last7DaysUsd: 61.3, last30DaysUsd: 240.1 },
  { userId: "u-linus", userName: "Linus", todayUsd: 0, last7DaysUsd: 4.5, last30DaysUsd: 38.9 },
];
const client = {
  ...api,
  usageDailyBudget: async () => ({ dailyBudget }),
  updateUsageDailyBudget: async (perUserUsd: number | null) => {
    dailyBudget = { perUserUsd, updatedAt: END };
    return { dailyBudget };
  },
  usageUsers: async () => ({ users: users.map((user) => ({ ...user, dailyBudgetUsd: dailyBudget.perUserUsd })) }),
  usage: async () => response,
  subscriptionUsage: async () => subscription,
  refreshSubscriptionUsage: async () => subscription,
} as unknown as ApiClient;

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ApiProvider client={client}>
      <main className="main-pane"><UsageView /></main>
    </ApiProvider>
  </React.StrictMode>,
);
