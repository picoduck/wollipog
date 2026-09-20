import { createHash } from "node:crypto";
import type {
  AgentContext,
  AgentDefinition,
  AgentDriverKind,
  ProviderAccountDefinition,
  SubscriptionUsageBucket,
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
  SubscriptionUsageSpendControl,
} from "@wollipog/protocol";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import { JsonRpcPeer } from "./jsonrpc.js";
import { killTree, spawnAgent, type AgentProcess, type SpawnIsolation } from "./spawn.js";
import type { DriverSubscriptionUsageUpdate } from "./drivers/driver.js";
import { agentForProviderAccount, providerForDriver } from "./provider-accounts.js";

type JsonRecord = Record<string, unknown>;

export const SUBSCRIPTION_USAGE_PROBE_TIMEOUT_MS = 8_000;
export const SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS = 15_000;
const MAX_PROVIDER_BUCKETS = 64;
const MAX_WINDOW_DURATION_MINUTES = 2 * 365 * 24 * 60;
const MAX_RESET_AHEAD_MS = 2 * 365 * 24 * 60 * 60_000;
const MAX_ACCOUNT_LABEL_LENGTH = 160;

function record(value: unknown): JsonRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown, max = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]+/g, " ");
  return normalized ? normalized.slice(0, max) : undefined;
}

function accountLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_ACCOUNT_LABEL_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function percent(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed === undefined ? undefined : Math.max(0, Math.min(100, parsed));
}

/** Anthropic reports `utilization` as the fraction of a window consumed, not a percentage: 0.42
 * means 42% used. Values above 1 are legitimate when usage runs past a window's cap, so the scale
 * follows the field name and never the magnitude. Percent-named fields are already 0..100. */
function utilizationPercent(value: unknown): number | undefined {
  const parsed = finite(value);
  if (parsed === undefined) return undefined;
  // Round to hundredths of a percent: scaling by 100 in binary floating point leaves noise
  // (0.07 becomes 7.000000000000001) that would churn the event-dedupe signature for free.
  return Math.max(0, Math.min(100, Math.round(parsed * 10_000) / 100));
}

function epochMilliseconds(value: unknown): number | undefined {
  const parsed = finite(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return parsed < 10_000_000_000 ? Math.round(parsed * 1_000) : Math.round(parsed);
}

function boundedDurationMinutes(value: unknown): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && parsed >= 1 && parsed <= MAX_WINDOW_DURATION_MINUTES
    ? parsed
    : undefined;
}

function boundedResetAt(value: unknown, observedAt: number): number | undefined {
  const parsed = epochMilliseconds(value);
  return parsed !== undefined && parsed <= observedAt + MAX_RESET_AHEAD_MS ? parsed : undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = stringValue(record(error)?.message, 300);
  return message ?? String(error);
}

function contextKey(context: AgentContext | undefined): string {
  return context?.kind === "wsl" ? `wsl:${context.distro}` : "native";
}

export function subscriptionUsageSourceId(
  runnerId: string,
  agentId: string,
  provider: SubscriptionUsageProvider,
  context: AgentContext | undefined,
  providerAccountId?: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify(providerAccountId
      ? { runnerId, provider, providerAccountId }
      : { runnerId, agentId, provider, context: contextKey(context) }))
    .digest("hex")
    .slice(0, 32);
}

function titleWords(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function subscriptionUsageBucketLabel(id: string): string {
  const known: Record<string, string> = {
    five_hour: "Five-Hour Window",
    seven_day: "Weekly — All Models",
    seven_day_opus: "Weekly — Opus",
    seven_day_sonnet: "Weekly — Sonnet",
    seven_day_fable: "Weekly — Fable",
    seven_day_overage_included: "Weekly — Extra Usage",
    overage: "Extra Usage",
  };
  return known[id] ?? titleWords(id);
}

function durationLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === undefined) return fallback;
  if (minutes % (7 * 24 * 60) === 0) {
    const weeks = minutes / (7 * 24 * 60);
    return weeks === 1 ? "Weekly" : `${weeks}-Week Window`;
  }
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return days === 1 ? "Daily" : `${days}-Day Window`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "Hourly" : `${hours}-Hour Window`;
  }
  return `${minutes}-Minute Window`;
}

function codexWindow(
  limitId: string,
  limitLabel: string,
  lane: "primary" | "secondary",
  input: unknown,
  observedAt: number,
): SubscriptionUsageBucket | null {
  const window = record(input);
  if (!window) return null;
  const usedPercent = percent(window.usedPercent ?? window.used_percentage);
  const windowDurationMinutes = boundedDurationMinutes(
    window.windowDurationMins ?? window.window_duration_mins,
  );
  const resetsAt = boundedResetAt(window.resetsAt ?? window.resets_at, observedAt);
  if (usedPercent === undefined && windowDurationMinutes === undefined && resetsAt === undefined) return null;
  const laneLabel = durationLabel(windowDurationMinutes, lane === "primary" ? "Primary Window" : "Secondary Window");
  return {
    id: `${limitId}:${lane}`,
    label: stringValue(limitLabel === laneLabel ? limitLabel : `${limitLabel} — ${laneLabel}`, 160)!,
    ...(usedPercent === undefined ? {} : {
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
      status: usedPercent >= 100 ? "exhausted" as const : usedPercent >= 80 ? "warning" as const : "available" as const,
    }),
    ...(windowDurationMinutes === undefined ? {} : { windowDurationMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function codexLimitId(input: unknown, fallbackId: string): string {
  const snapshot = record(input);
  return stringValue(snapshot?.limitId ?? snapshot?.limit_id, 86) ??
    stringValue(fallbackId, 86) ?? "codex";
}

function compareStableText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCodexLimitEntries(
  [leftFallbackId, leftValue]: [string, unknown],
  [rightFallbackId, rightValue]: [string, unknown],
): number {
  const leftId = codexLimitId(leftValue, leftFallbackId);
  const rightId = codexLimitId(rightValue, rightFallbackId);
  const priority = Number(rightId === "codex") - Number(leftId === "codex");
  return priority || compareStableText(leftId, rightId) || compareStableText(leftFallbackId, rightFallbackId);
}

function codexBucketLimitId(id: string): string {
  const laneSeparator = id.lastIndexOf(":");
  return laneSeparator < 0 ? id : id.slice(0, laneSeparator);
}

function compareCodexBuckets(left: SubscriptionUsageBucket, right: SubscriptionUsageBucket): number {
  const leftLimitId = codexBucketLimitId(left.id);
  const rightLimitId = codexBucketLimitId(right.id);
  const priority = Number(rightLimitId === "codex") - Number(leftLimitId === "codex");
  const leftDuration = left.windowDurationMinutes ?? Number.POSITIVE_INFINITY;
  const rightDuration = right.windowDurationMinutes ?? Number.POSITIVE_INFINITY;
  return priority || compareStableText(leftLimitId, rightLimitId) ||
    leftDuration - rightDuration || compareStableText(left.id, right.id);
}

function normalizeCodexSnapshot(
  input: unknown,
  fallbackId: string,
  observedAt: number,
): {
  buckets: SubscriptionUsageBucket[];
  plan?: string;
  credits?: SubscriptionUsageSnapshot["credits"];
  spendControl?: SubscriptionUsageSpendControl;
} | null {
  const snapshot = record(input);
  if (!snapshot) return null;
  // Bucket ids append `:secondary`; keep the provider segment within the control-plane's
  // exact 96-character bound and sanitize map keys just like explicit ids.
  const limitId = codexLimitId(snapshot, fallbackId);
  const limitLabel = stringValue(snapshot.limitName ?? snapshot.limit_name, 120) ??
    subscriptionUsageBucketLabel(limitId);
  const buckets = [
    codexWindow(limitId, limitLabel, "primary", snapshot.primary, observedAt),
    codexWindow(limitId, limitLabel, "secondary", snapshot.secondary, observedAt),
  ].filter((bucket): bucket is SubscriptionUsageBucket => bucket !== null)
    .sort(compareCodexBuckets);
  const creditsRecord = record(snapshot.credits);
  const balance = creditsRecord ? stringValue(creditsRecord.balance, 80) : undefined;
  const credits = creditsRecord ? {
    ...(typeof creditsRecord.hasCredits === "boolean" ? { hasCredits: creditsRecord.hasCredits } : {}),
    ...(typeof creditsRecord.unlimited === "boolean" ? { unlimited: creditsRecord.unlimited } : {}),
    ...(balance === undefined ? {} : { balance }),
  } : undefined;
  const spend = record(snapshot.individualLimit ?? snapshot.individual_limit);
  const spendControl = spend ? {
    id: limitId,
    label: `${limitLabel} Spend Control`,
    ...(stringValue(spend.limit, 80) ? { limit: stringValue(spend.limit, 80)! } : {}),
    ...(stringValue(spend.used, 80) ? { used: stringValue(spend.used, 80)! } : {}),
    ...(percent(spend.remainingPercent ?? spend.remaining_percent) === undefined
      ? {}
      : { remainingPercent: percent(spend.remainingPercent ?? spend.remaining_percent)! }),
    ...(boundedResetAt(spend.resetsAt ?? spend.resets_at, observedAt) === undefined
      ? {}
      : { resetsAt: boundedResetAt(spend.resetsAt ?? spend.resets_at, observedAt)! }),
    ...(typeof snapshot.spendControlReached === "boolean"
      ? { reached: snapshot.spendControlReached }
      : typeof snapshot.spend_control_reached === "boolean"
        ? { reached: snapshot.spend_control_reached }
        : {}),
  } : undefined;
  return {
    buckets,
    ...(stringValue(snapshot.planType ?? snapshot.plan_type, 80)
      ? { plan: stringValue(snapshot.planType ?? snapshot.plan_type, 80)! }
      : {}),
    ...(credits && Object.keys(credits).length > 0 ? { credits } : {}),
    ...(spendControl ? { spendControl } : {}),
  };
}

export function normalizeCodexRateLimits(
  payload: unknown,
  base: Pick<SubscriptionUsageSnapshot, "sourceId" | "runnerId" | "agentId" | "providerAccountId">,
  fetchedAt: number,
): SubscriptionUsageSnapshot | null {
  const root = record(payload);
  if (!root) return null;
  const byId = record(root.rateLimitsByLimitId ?? root.rate_limits_by_limit_id);
  const snapshots: Array<[string, unknown]> = byId && Object.keys(byId).length > 0
    ? Object.entries(byId)
    : [["codex", root.rateLimits ?? root.rate_limits ?? root]];
  const buckets: SubscriptionUsageBucket[] = [];
  const spendControls: SubscriptionUsageSpendControl[] = [];
  let plan: string | undefined;
  let credits: SubscriptionUsageSnapshot["credits"];
  for (const [fallbackId, value] of snapshots.sort(compareCodexLimitEntries).slice(0, MAX_PROVIDER_BUCKETS)) {
    const normalized = normalizeCodexSnapshot(value, fallbackId, fetchedAt);
    if (!normalized) continue;
    buckets.push(...normalized.buckets);
    plan ??= normalized.plan;
    credits ??= normalized.credits;
    if (normalized.spendControl) spendControls.push(normalized.spendControl);
  }
  if (buckets.length === 0 && !plan && !credits && spendControls.length === 0) return null;
  return {
    ...base,
    provider: "codex",
    state: "available",
    fetchedAt,
    buckets: buckets.slice(0, MAX_PROVIDER_BUCKETS),
    ...(plan ? { plan } : {}),
    ...(credits ? { credits } : {}),
    ...(spendControls.length > 0 ? { spendControls: spendControls.slice(0, MAX_PROVIDER_BUCKETS) } : {}),
  };
}

function claudeWindow(id: string, input: unknown, observedAt: number): SubscriptionUsageBucket | null {
  const window = record(input);
  if (!window) return null;
  const usedPercent = percent(window.used_percentage ?? window.usedPercent) ??
    utilizationPercent(window.utilization);
  const resetsAt = boundedResetAt(window.resets_at ?? window.resetsAt, observedAt);
  const duration = boundedDurationMinutes(window.window_duration_minutes ?? window.windowDurationMinutes);
  const rawStatus = stringValue(window.status, 40);
  if (usedPercent === undefined && resetsAt === undefined && duration === undefined && !rawStatus) return null;
  const status = rawStatus === "rejected" || rawStatus === "exhausted"
    ? "exhausted" as const
    : rawStatus === "allowed_warning" || (usedPercent !== undefined && usedPercent >= 80)
      ? "warning" as const
      : "available" as const;
  const safeId = stringValue(id, 96);
  if (!safeId) return null;
  return {
    id: safeId,
    label: subscriptionUsageBucketLabel(safeId),
    ...(usedPercent === undefined ? {} : {
      usedPercent,
      remainingPercent: Math.max(0, 100 - usedPercent),
    }),
    ...(duration === undefined ? {} : { windowDurationMinutes: duration }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    status,
  };
}

export function normalizeClaudeRateLimits(
  payload: unknown,
  base: Pick<SubscriptionUsageSnapshot, "sourceId" | "runnerId" | "agentId" | "providerAccountId">,
  fetchedAt: number,
): SubscriptionUsageSnapshot | null {
  const root = record(payload);
  if (!root) return null;
  const buckets: SubscriptionUsageBucket[] = [];
  const info = record(root.rate_limit_info ?? root.rateLimitInfo);
  if (info) {
    // `unifiedWindows` is where Claude Code actually reports per-window utilization: one entry per
    // allowance window (five-hour, weekly, overage-included weekly), each carrying the fraction
    // consumed and a reset time. It is tracked on every observation, unlike the top-level
    // status/utilization pair, which only describes whichever window is currently limiting.
    const limitingId = stringValue(info.rateLimitType ?? info.rate_limit_type, 96);
    const unified = record(info.unifiedWindows ?? info.unified_windows);
    const unifiedIds = new Set<string>();
    for (const [rawId, value] of Object.entries(unified ?? {}).slice(0, MAX_PROVIDER_BUCKETS)) {
      const window = record(value);
      if (!window) continue;
      // Compare sanitized ids. `limitingId` is already bounded, and `claudeWindow` bounds the raw
      // key the same way, so comparing the raw key would silently miss any id past the bound —
      // suppressing the top-level bucket while never folding its status into the window.
      const id = stringValue(rawId, 96);
      // Distinct raw keys can bound to the same id. The first one read owns it: letting a later
      // key overwrite would fuse two windows, and both would match a bounded `limitingId`.
      if (id !== undefined && unifiedIds.has(id)) continue;
      // A unified window carries no status of its own; the limiting window's status is the
      // top-level one, so fold it in rather than reporting that window as plainly available.
      const isLimiting = id !== undefined && id === limitingId;
      const bucket = claudeWindow(rawId, isLimiting ? { ...window, status: info.status } : window, fetchedAt);
      if (!bucket) continue;
      unifiedIds.add(bucket.id);
      buckets.push(bucket);
    }
    // Fold the top-level pair into the window it names. Emitting it separately would stand a
    // second, percentage-less card beside the real one whenever a sparse status/reset event
    // arrives for a window `unifiedWindows` already describes.
    if (!limitingId || !unifiedIds.has(limitingId)) {
      const bucket = claudeWindow(limitingId ?? "subscription", info, fetchedAt);
      if (bucket) buckets.push(bucket);
    }
  }
  if (buckets.length === 0) return null;
  // The fallback bucket above can still land on an id a unified window already used — a payload
  // naming no `rateLimitType` while carrying a `subscription` window does exactly that.
  const deduped = new Map<string, SubscriptionUsageBucket>();
  // Records inside one payload are equally current, so this is a plain field merge: ordering
  // rules belong only to sparse notifications arriving across events.
  for (const bucket of buckets) deduped.set(bucket.id, mergeBucket(deduped.get(bucket.id), bucket));
  return {
    ...base,
    provider: "claude",
    state: "available",
    fetchedAt,
    // Unified windows are already bounded, but the fallback bucket can put the total one over.
    // The control plane rejects a snapshot above this many buckets and drops the whole update.
    buckets: [...deduped.values()].slice(0, MAX_PROVIDER_BUCKETS),
  };
}

/** True when a source has usable allowance numbers, as opposed to reset times alone. */
export function hasSubscriptionUtilization(snapshot: SubscriptionUsageSnapshot): boolean {
  return snapshot.buckets.some((bucket) =>
    bucket.usedPercent !== undefined || bucket.remainingPercent !== undefined);
}

/** Field-level merge with no ordering judgement. Records inside one provider payload, and every
 * field of an authoritative probe result, are current by construction. */
function mergeBucket(
  prior: SubscriptionUsageBucket | undefined,
  update: SubscriptionUsageBucket,
): SubscriptionUsageBucket {
  return prior ? { ...prior, ...update } : update;
}

/** Merge for sparse provider notifications, which can arrive out of order: concurrent sessions on
 * one source report independently, and `fetchedAt` is receipt time, not event time. Two signals
 * order them — a window's reset time only ever moves forward, and within one window (an identical
 * reset time) usage only accumulates. An update failing either test is older data, so keep the
 * newer window intact rather than letting a late event walk utilization backwards. This never
 * applies to an authoritative read, which is current whatever it says. */
function mergeObservedBucket(
  prior: SubscriptionUsageBucket | undefined,
  update: SubscriptionUsageBucket,
): SubscriptionUsageBucket {
  if (!prior) return update;
  if (prior.resetsAt !== undefined && update.resetsAt !== undefined) {
    if (update.resetsAt < prior.resetsAt) return prior;
    if (update.resetsAt === prior.resetsAt &&
        prior.usedPercent !== undefined && update.usedPercent !== undefined &&
        update.usedPercent < prior.usedPercent) {
      return prior;
    }
  }
  return { ...prior, ...update };
}

/** Hold the snapshot inside the control plane's bucket bound, which it enforces by rejecting the
 * whole update. Buckets the update did not report are dropped first: retaining an old bucket at the
 * cost of a currently reported window is how a source loses the windows the user actually needs.
 * This helper is Claude-only. Codex buckets are sorted deterministically before using a direct
 * capped slice, so account-wide limits retain priority over model-specific limits. */
function boundBuckets(ordered: SubscriptionUsageBucket[], reported: Set<string>): SubscriptionUsageBucket[] {
  if (ordered.length <= MAX_PROVIDER_BUCKETS) return ordered;
  const excess = ordered.length - MAX_PROVIDER_BUCKETS;
  const dropped = new Set<string>();
  for (let index = ordered.length - 1; index >= 0 && dropped.size < excess; index -= 1) {
    const candidate = ordered[index];
    if (candidate && !reported.has(candidate.id)) dropped.add(candidate.id);
  }
  return ordered.filter((bucket) => !dropped.has(bucket.id)).slice(0, MAX_PROVIDER_BUCKETS);
}

function mergeSnapshot(
  prior: SubscriptionUsageSnapshot | undefined,
  update: SubscriptionUsageSnapshot,
  /** Only Claude notifications carry the per-window semantics needed for freshness-aware merging.
   * Codex probes and push updates use a plain field merge, then sort buckets deterministically
   * before truncation so sparse updates cannot change their presentation priority. */
  mergeMode: "claude-notification" | "plain",
): SubscriptionUsageSnapshot {
  if (!prior || prior.provider !== update.provider) return update;
  // Sparse notifications can be delayed behind a manual read. Never let an older provider
  // observation replace fields from a newer authoritative snapshot.
  if (update.fetchedAt < prior.fetchedAt) return prior;
  const merge = mergeMode === "claude-notification" ? mergeObservedBucket : mergeBucket;
  const buckets = new Map(prior.buckets.map((bucket) => [bucket.id, bucket]));
  for (const bucket of update.buckets) buckets.set(bucket.id, merge(buckets.get(bucket.id), bucket));
  const orderedBuckets = [...buckets.values()];
  if (update.provider === "codex") orderedBuckets.sort(compareCodexBuckets);
  const spendControls = new Map((prior.spendControls ?? []).map((item) => [item.id, item]));
  for (const item of update.spendControls ?? []) {
    spendControls.set(item.id, { ...spendControls.get(item.id), ...item });
  }
  const { detail: _priorDetail, ...priorWithoutDetail } = prior;
  return {
    ...priorWithoutDetail,
    ...update,
    buckets: mergeMode === "claude-notification"
      ? boundBuckets(orderedBuckets, new Set(update.buckets.map((bucket) => bucket.id)))
      : orderedBuckets.slice(0, MAX_PROVIDER_BUCKETS),
    ...(update.credits || prior.credits ? { credits: { ...prior.credits, ...update.credits } } : {}),
    ...(spendControls.size > 0 ? { spendControls: [...spendControls.values()] } : {}),
  };
}

export interface CodexSubscriptionProbeResult {
  state: "available" | "unavailable" | "unauthenticated" | "not_applicable";
  detail?: string;
  plan?: string;
  accountLabel?: string;
  rateLimits?: unknown;
}

export interface SubscriptionUsageProbeAuthorization {
  cwd: string;
  isolation?: SpawnIsolation;
}

interface CodexProbeDeps {
  spawn: typeof spawnAgent;
  kill: typeof killTree;
  now: () => number;
  onSpawn?: (child: AgentProcess) => void;
  onFinish?: (child: AgentProcess) => void;
}

export async function probeCodexSubscriptionUsage(
  agent: AgentDefinition,
  env: Record<string, string>,
  timeoutMs = SUBSCRIPTION_USAGE_PROBE_TIMEOUT_MS,
  dependencies: Partial<CodexProbeDeps> = {},
  authorization?: SubscriptionUsageProbeAuthorization,
): Promise<CodexSubscriptionProbeResult> {
  const deps: CodexProbeDeps = {
    spawn: dependencies.spawn ?? spawnAgent,
    kill: dependencies.kill ?? killTree,
    now: dependencies.now ?? Date.now,
    ...(dependencies.onSpawn ? { onSpawn: dependencies.onSpawn } : {}),
    ...(dependencies.onFinish ? { onFinish: dependencies.onFinish } : {}),
  };
  let child: AgentProcess | null = null;
  let peer: JsonRpcPeer | null = null;
  try {
    child = deps.spawn({
      command: agent.command,
      args: [...agent.args, "app-server"],
      cwd: authorization?.cwd ?? process.cwd(),
      env,
      context: agent.context,
      scrubInheritedEnv: ["OPENAI_API_KEY"],
      isolation: authorization?.isolation,
    });
    deps.onSpawn?.(child);
    child.stderr.resume();
    peer = new JsonRpcPeer(child.stdin, child.stdout);
    child.on("close", () => peer?.dispose("codex app-server usage probe exited"));
    child.on("error", (error) => peer?.dispose(`codex app-server usage probe failed: ${errorText(error)}`));
    const deadlineAt = deps.now() + timeoutMs;
    await peer.requestWithDeadline("initialize", {
      clientInfo: { name: "wollipog-subscription-usage", version: "1" },
    }, deadlineAt);
    peer.notify("initialized", {});
    const account = await peer.requestWithDeadline<JsonRecord>(
      "account/read",
      { refreshToken: false },
      deadlineAt,
    );
    const accountValue = record(account?.account);
    if (!accountValue) {
      return {
        state: "unauthenticated",
        detail: "Codex is not signed in to a subscription account on this runner.",
      };
    }
    const type = stringValue(accountValue.type, 40);
    if (type !== "chatgpt") {
      return {
        state: "not_applicable",
        detail: type === "apiKey"
          ? "Codex is using API-key billing; subscription allowances do not apply."
          : "This Codex authentication mode does not report subscription allowances.",
      };
    }
    const rateLimits = await peer.requestWithDeadline(
      "account/rateLimits/read",
      undefined,
      deadlineAt,
    );
    return {
      state: "available",
      ...(stringValue(accountValue.planType, 80) ? { plan: stringValue(accountValue.planType, 80)! } : {}),
      ...(accountLabel(accountValue.email) ? { accountLabel: accountLabel(accountValue.email)! } : {}),
      rateLimits,
    };
  } finally {
    peer?.dispose("codex app-server usage probe complete");
    if (child) {
      deps.kill(child);
      deps.onFinish?.(child);
    }
  }
}

interface SubscriptionSource {
  agent: AgentDefinition;
  provider: SubscriptionUsageProvider;
  sourceId: string;
  accountLabel?: string;
  providerAccountId?: string;
  authStatus?: ProviderAccountDefinition["authStatus"];
  unsupportedDetail?: string;
}

export interface SubscriptionUsageManagerOptions {
  runnerId: string;
  agents: () => AgentDefinition[];
  providerAccounts?: () => ProviderAccountDefinition[];
  /** Production resolves the runner-local credential home against agent execution contexts. The
   * secret-free account passed here never exposes that path to snapshots or the control plane. */
  resolveProviderAccountAgent?: (
    account: ProviderAccountDefinition,
    supportedDrivers: AgentDriverKind[],
  ) => AgentDefinition | undefined;
  resolveEnv: (agentId: string, driver: AgentDefinition["driver"], context: AgentContext, providerAccountId?: string) => Record<string, string>;
  /** Discovery probes the context-default Claude credential scope. Configured sources that select
   * another credential scope must not inherit that probe's account label. */
  usesDiscoveredClaudeAccount?: (agent: AgentDefinition) => boolean;
  authorizeProbe?: (
    agent: AgentDefinition,
    env: Record<string, string>,
    sourceId: string,
  ) => SubscriptionUsageProbeAuthorization | Promise<SubscriptionUsageProbeAuthorization>;
  publish: (snapshot: SubscriptionUsageSnapshot) => void;
  log?: (message: string) => void;
  now?: () => number;
  probeCodex?: typeof probeCodexSubscriptionUsage;
  killProbe?: typeof killTree;
}

export class SubscriptionUsageManager {
  private readonly snapshots = new Map<string, SubscriptionUsageSnapshot>();
  private readonly lastProbeAt = new Map<string, number>();
  private readonly lastEvent = new Map<string, { signature: string; observedAt: number }>();
  /** Sources whose provider has answered at least once. Separates a source that has simply never
   * run from one whose provider reports no allowances, which read identically before. */
  private readonly responded = new Set<string>();
  private readonly activeProbeChildren = new Set<AgentProcess>();
  private refreshPromise: Promise<SubscriptionUsageSnapshot[]> | null = null;
  private shuttingDown = false;

  constructor(private readonly options: SubscriptionUsageManagerOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private sources(): SubscriptionSource[] {
    const result: SubscriptionSource[] = [];
    const seen = new Set<string>();
    const accountContexts = new Set<string>();
    const accounts = this.options.providerAccounts?.() ?? [];
    for (const account of accounts) {
        const supportedDrivers: AgentDriverKind[] = account.provider === "codex"
          ? ["codex-app-server"] : ["claude-code"];
        const agents = this.options.agents();
        const resolved = this.options.resolveProviderAccountAgent
          ? this.options.resolveProviderAccountAgent(account, supportedDrivers)
          : agentForProviderAccount(agents, account, supportedDrivers);
        const providerAgents = agents.filter((candidate) =>
          providerForDriver(candidate.driver ?? "acp") === account.provider &&
          supportedDrivers.includes(candidate.driver ?? "acp"));
        const agent = resolved ??
          providerAgents.find((candidate) => candidate.defaultProviderAccountId === account.id) ??
          providerAgents.find((candidate) => (candidate.context?.kind ?? "native") === "native") ??
          providerAgents[0];
        if (!agent) continue;
        if (resolved) accountContexts.add(`${account.provider}\0${contextKey(agent.context)}`);
        const sourceId = subscriptionUsageSourceId(
          this.options.runnerId,
          agent.id,
          account.provider,
          agent.context,
          account.id,
        );
        result.push({
          agent,
          provider: account.provider,
          sourceId,
          providerAccountId: account.id,
          accountLabel: account.label,
          authStatus: account.authStatus,
          ...(!resolved && this.options.resolveProviderAccountAgent
            ? { unsupportedDetail: "This provider account's credential home is not available in a compatible provider execution context on this runner." }
            : {}),
        });
    }
    for (const agent of this.options.agents()) {
      const provider = providerForDriver(agent.driver ?? "acp");
      if (!provider || agent.driver === "codex") continue;
      const mappedToAccount = accountContexts.has(`${provider}\0${contextKey(agent.context)}`);
      if (mappedToAccount) continue;
      const sourceId = subscriptionUsageSourceId(
        this.options.runnerId,
        agent.id,
        provider,
        agent.context,
      );
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      const claudeAccountLabel = provider === "claude" &&
        (this.options.usesDiscoveredClaudeAccount?.(agent) ?? true) &&
        agent.claudeCode?.auth.billingSource === "subscription"
        ? accountLabel((agent.claudeCode?.auth as { accountLabel?: unknown } | undefined)?.accountLabel)
        : undefined;
      result.push({
        agent,
        provider,
        sourceId,
        ...(claudeAccountLabel ? { accountLabel: claudeAccountLabel } : {}),
      });
    }
    return result;
  }

  private initialSnapshot(source: SubscriptionSource): SubscriptionUsageSnapshot {
    const { agent, provider, sourceId } = source;
    const discoveryClaude = provider === "claude" && source.providerAccountId === undefined
      ? agent.claudeCode
      : undefined;
    const base = {
      sourceId,
      runnerId: this.options.runnerId,
      agentId: agent.id,
      provider,
      fetchedAt: this.now(),
      buckets: [],
      ...(source.accountLabel ? { accountLabel: source.accountLabel } : {}),
      ...(source.providerAccountId ? { providerAccountId: source.providerAccountId } : {}),
    };
    if (source.unsupportedDetail) {
      return { ...base, state: "unsupported", detail: source.unsupportedDetail };
    }
    if (agent.available !== true) {
      return { ...base, state: "unavailable", detail: `${agent.name} is not available on this runner.` };
    }
    if (source.authStatus === "unauthenticated" ||
        (source.providerAccountId === undefined && agent.authStatus === "unauthenticated") ||
        discoveryClaude?.status === "unauthenticated") {
      return { ...base, state: "unauthenticated", detail: `${agent.name} is not signed in.` };
    }
    if (provider === "codex" && agent.codexAppServer?.status !== "supported") {
      return {
        ...base,
        state: "unsupported",
        detail: "This Codex version does not expose the supported App Server rate-limit contract.",
      };
    }
    if (provider === "claude") {
      const auth = discoveryClaude?.auth;
      if (agent.claudeCode?.status === "unsupported") {
        return {
          ...base,
          state: "unsupported",
          detail: "This Claude Code version does not expose structured subscription usage.",
        };
      }
      if (auth && auth.billingSource !== "subscription" && auth.billingSource !== "unknown") {
        return {
          ...base,
          state: "not_applicable",
          detail: "Claude Code is not using Claude.ai subscription billing for this source.",
          ...(auth.subscriptionType ? { plan: auth.subscriptionType } : {}),
        };
      }
      return {
        ...base,
        state: "unavailable",
        detail: this.responded.has(sourceId)
          ? "Claude Code answered without reporting subscription allowances. Only Claude.ai " +
            "subscription sessions carry them; API-key, Bedrock, and Vertex sessions never do."
          : "Claude subscription usage is available after the first provider response in a session.",
        ...(auth?.subscriptionType ? { plan: auth.subscriptionType } : {}),
      };
    }
    return {
      ...base,
      state: "unavailable",
      detail: "Codex subscription usage has not been fetched yet.",
    };
  }

  syncSources(): SubscriptionUsageSnapshot[] {
    const sources = this.sources();
    const live = new Set(sources.map((source) => source.sourceId));
    for (const sourceId of this.snapshots.keys()) {
      if (!live.has(sourceId)) this.snapshots.delete(sourceId);
    }
    for (const source of sources) {
      const initial = this.initialSnapshot(source);
      const prior = this.snapshots.get(source.sourceId);
      // Claude discovery owns its source label. Codex labels arrive only from an authoritative
      // refresh, so comparing them here would mistake every populated Codex snapshot for a switch.
      const accountChanged = source.provider === "claude" && Boolean(prior) &&
        source.accountLabel !== prior?.accountLabel;
      const forced = initial.state === "unsupported" ||
        initial.state === "unauthenticated" ||
        initial.state === "not_applicable";
      this.snapshots.set(source.sourceId, forced || !prior || accountChanged ? initial : {
        ...prior,
        agentId: source.agent.id,
      });
    }
    return this.inventory();
  }

  inventory(): SubscriptionUsageSnapshot[] {
    return [...this.snapshots.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.agentId.localeCompare(right.agentId));
  }

  observe(
    agentId: string,
    driver: AgentDefinition["driver"],
    context: AgentContext,
    update: DriverSubscriptionUsageUpdate,
    providerAccountId?: string,
  ): SubscriptionUsageSnapshot | null {
    this.syncSources();
    const provider = driver === "codex-app-server" ? "codex" : driver === "claude-code" ? "claude" : null;
    if (!provider || provider !== update.provider) return null;
    const sourceId = subscriptionUsageSourceId(this.options.runnerId, agentId, provider, context, providerAccountId);
    if (update.kind === "response_observed") return this.observeProviderResponse(sourceId);
    const source = this.sources().find((candidate) => candidate.sourceId === sourceId);
    // Remote targets intentionally have no runner-local account source. Ignore their provider
    // events instead of publishing snapshots the control plane must reject.
    if (!source) return null;
    const base = {
      sourceId,
      runnerId: this.options.runnerId,
      agentId,
      ...(source.providerAccountId ? { providerAccountId: source.providerAccountId } : {}),
    };
    const normalized = provider === "codex"
      ? normalizeCodexRateLimits(update.payload, base, this.now())
      : normalizeClaudeRateLimits(update.payload, base, this.now());
    if (!normalized) return null;
    const prior = this.snapshots.get(sourceId);
    if (prior && normalized.fetchedAt < prior.fetchedAt) return prior;
    const { fetchedAt: _fetchedAt, ...eventShape } = normalized;
    const signature = JSON.stringify(eventShape);
    const event = this.lastEvent.get(sourceId);
    if (event?.signature === signature && normalized.fetchedAt - event.observedAt < SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS) {
      return prior ?? null;
    }
    this.lastEvent.set(sourceId, { signature, observedAt: normalized.fetchedAt });
    const explained = this.explainMissingUtilization(
      mergeSnapshot(prior, normalized, provider === "claude" ? "claude-notification" : "plain"));
    if (explained === prior) return prior;
    this.snapshots.set(sourceId, explained);
    this.options.publish(explained);
    return explained;
  }

  /** A Claude source reporting allowance windows without percentages is not a source waiting on
   * its first response. Describe only what the provider actually sent: a status-only event carries
   * no reset time either, and the cause can be the installed version or the account's responses. */
  private explainMissingUtilization(snapshot: SubscriptionUsageSnapshot): SubscriptionUsageSnapshot {
    if (snapshot.provider !== "claude" || snapshot.state !== "available") return snapshot;
    if (hasSubscriptionUtilization(snapshot)) return snapshot;
    return {
      ...snapshot,
      detail: "Claude Code reported allowance windows for this source without utilization " +
        "percentages. Older Claude Code versions report window status and reset times only; " +
        "update Claude Code if this persists.",
    };
  }

  /** The provider answered for this source. Only the pre-first-response wording is now wrong, so
   * real provider data — including a source already reporting allowances — is never disturbed. */
  private observeProviderResponse(sourceId: string): SubscriptionUsageSnapshot | null {
    const prior = this.snapshots.get(sourceId);
    if (!this.responded.has(sourceId)) this.responded.add(sourceId);
    if (!prior || prior.state !== "unavailable" || prior.buckets.length > 0) return prior ?? null;
    const source = this.sources().find((candidate) => candidate.sourceId === sourceId);
    if (!source) return prior;
    const updated = this.initialSnapshot(source);
    if (updated.state !== "unavailable" || updated.detail === prior.detail) return prior;
    this.snapshots.set(sourceId, updated);
    this.options.publish(updated);
    return updated;
  }

  refreshAll(): Promise<SubscriptionUsageSnapshot[]> {
    if (this.shuttingDown) return Promise.reject(new Error("subscription usage manager is shutting down"));
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refreshAllNow().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async refreshAccount(providerAccountId: string): Promise<SubscriptionUsageSnapshot[]> {
    if (this.shuttingDown) throw new Error("subscription usage manager is shutting down");
    this.syncSources();
    const sources = this.sources().filter((source) => source.providerAccountId === providerAccountId);
    if (sources.length === 0) throw new Error("provider account is not configured");
    for (const source of sources) {
      if (source.provider === "codex") await this.refreshCodex(source);
    }
    return this.inventory();
  }

  private async refreshAllNow(): Promise<SubscriptionUsageSnapshot[]> {
    this.syncSources();
    const codexSources = this.sources().filter((source) => source.provider === "codex");
    // A runner may advertise several contexts. Probe sequentially to avoid concurrent mutation of
    // one provider HOME; the control plane derives a bounded deadline from this source count.
    // Duplicate manual requests share refreshPromise and each source has its own minimum interval.
    for (const source of codexSources) await this.refreshCodex(source);
    return this.inventory();
  }

  private async refreshCodex(source: SubscriptionSource): Promise<void> {
    if (this.shuttingDown) return;
    const initial = this.initialSnapshot(source);
    if (initial.state === "unsupported" ||
        initial.state === "unauthenticated" ||
        initial.state === "not_applicable" ||
        (initial.state === "unavailable" && source.agent.available !== true)) {
      this.snapshots.set(source.sourceId, initial);
      this.options.publish(initial);
      return;
    }
    const now = this.now();
    const lastProbeAt = this.lastProbeAt.get(source.sourceId) ?? 0;
    if (now - lastProbeAt < SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS) return;
    this.lastProbeAt.set(source.sourceId, now);
    try {
      const env = this.options.resolveEnv(
        source.agent.id,
        source.agent.driver,
        source.agent.context ?? { kind: "native" },
        source.providerAccountId,
      );
      if (env.OPENAI_API_KEY) {
        const notApplicable: SubscriptionUsageSnapshot = {
          ...initial,
          state: "not_applicable",
          detail: "Codex is using API-key billing; subscription allowances do not apply.",
          fetchedAt: now,
        };
        this.snapshots.set(source.sourceId, notApplicable);
        this.options.publish(notApplicable);
        return;
      }
      const authorization = await this.options.authorizeProbe?.(source.agent, env, source.sourceId);
      if (!authorization) throw new Error("subscription usage probe authorization is unavailable");
      if (this.shuttingDown) return;
      const result = await (this.options.probeCodex ?? probeCodexSubscriptionUsage)(
        source.agent,
        env,
        SUBSCRIPTION_USAGE_PROBE_TIMEOUT_MS,
        {
          kill: this.options.killProbe ?? killTree,
          onSpawn: (child) => {
            this.activeProbeChildren.add(child);
            if (this.shuttingDown) (this.options.killProbe ?? killTree)(child);
          },
          onFinish: (child) => this.activeProbeChildren.delete(child),
        },
        authorization,
      );
      if (this.shuttingDown) return;
      if (result.state === "available") {
        const normalized = normalizeCodexRateLimits(
          result.rateLimits,
          {
            sourceId: source.sourceId,
            runnerId: this.options.runnerId,
            agentId: source.agent.id,
            ...(source.providerAccountId ? { providerAccountId: source.providerAccountId } : {}),
          },
          this.now(),
        );
        if (!normalized) throw new Error("Codex returned no recognizable rate-limit fields");
        const prior = this.snapshots.get(source.sourceId);
        const update = {
          ...normalized,
          ...(result.plan && !normalized.plan ? { plan: result.plan } : {}),
          ...(source.accountLabel ? { accountLabel: source.accountLabel } :
            result.accountLabel ? { accountLabel: result.accountLabel } : {}),
        };
        // A provider-account switch changes the authority behind every allowance. Replace the
        // source atomically so absent buckets from the new account cannot survive from the old one.
        const accountChanged = Boolean(prior) && prior?.accountLabel !== update.accountLabel;
        const merged = accountChanged
          ? update
          : mergeSnapshot(prior, update, "plain");
        this.snapshots.set(source.sourceId, merged);
        this.options.publish(merged);
        return;
      }
      const unavailable: SubscriptionUsageSnapshot = {
        ...initial,
        state: result.state,
        detail: result.detail ?? initial.detail,
        fetchedAt: this.now(),
        ...(result.plan ? { plan: result.plan } : {}),
        ...(source.accountLabel ? { accountLabel: source.accountLabel } :
          result.accountLabel ? { accountLabel: result.accountLabel } : {}),
      };
      this.snapshots.set(source.sourceId, unavailable);
      this.options.publish(unavailable);
    } catch (error) {
      if (this.shuttingDown) return;
      this.options.log?.(`subscription usage probe failed for ${source.agent.id}: ${errorText(error)}`);
      const prior = this.snapshots.get(source.sourceId);
      const failed: SubscriptionUsageSnapshot = prior?.buckets.length
        ? {
            ...prior,
            detail: "The latest Codex refresh failed; showing the last provider snapshot.",
          }
        : {
            ...initial,
            state: "unavailable",
            detail: "Codex subscription usage could not be refreshed. Try again.",
            fetchedAt: this.now(),
          };
      this.snapshots.set(source.sourceId, failed);
      this.options.publish(failed);
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    for (const child of this.activeProbeChildren) (this.options.killProbe ?? killTree)(child);
  }
}

export function shouldPublishSubscriptionUsageInventory(
  discoveryDone: boolean,
  controlPlaneProtocolVersion: number | null,
): boolean {
  return discoveryDone && runnerSupportsProtocol(controlPlaneProtocolVersion, "subscriptionUsage");
}
