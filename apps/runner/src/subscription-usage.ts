import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentContext,
  AgentDefinition,
  AgentDriverKind,
  HarnessInstallationChoice,
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
import { harnessChoiceFor, selectedHarnessAgent } from "./harness-selection.js";
import { launchTargetStillMatches } from "./discovery/resolve.js";
import { claudeStatusIdentity, codexCredentialIdentity } from "./provider-login.js";

type JsonRecord = Record<string, unknown>;

export const SUBSCRIPTION_USAGE_PROBE_TIMEOUT_MS = 8_000;
export const SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS = 15_000;
const MAX_PROVIDER_BUCKETS = 64;
const MAX_WINDOW_DURATION_MINUTES = 2 * 365 * 24 * 60;
const MAX_RESET_AHEAD_MS = 2 * 365 * 24 * 60 * 60_000;
const MAX_ACCOUNT_LABEL_LENGTH = 160;
const MAX_AUTH_STATUS_OUTPUT = 64 * 1024;

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

/** A one-way fingerprint of a provider identity (`claudeStatusIdentity`, `codexCredentialIdentity`),
 * alike on every machine signed in to one subscription. Every part must be known: an organization
 * alone can be several members' seats, and an email alone can span organizations, so an incomplete
 * identity is not evidence of sameness and yields no fingerprint. */
export function subscriptionIdentityFingerprint(identity: string | undefined): string | undefined {
  if (!identity) return undefined;
  const parts = JSON.parse(identity) as unknown[];
  if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string" || !part)) return undefined;
  return createHash("sha256").update(`wollipog-subscription-identity:v1\0${identity}`).digest("hex");
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

/** Dates each percentage this update reports. A window it leaves out, or reports without a
 * percentage, then keeps its earlier time through the merge, because `fetchedAt` moves on regardless
 * and would make a retained reading look current. Applied after the event signature is taken, since
 * a receipt time would make every repeated event look new. */
function withReadingTimes(snapshot: SubscriptionUsageSnapshot): SubscriptionUsageSnapshot {
  return {
    ...snapshot,
    buckets: snapshot.buckets.map((bucket) =>
      bucket.usedPercent === undefined && bucket.remainingPercent === undefined
        ? bucket
        : { ...bucket, observedAt: snapshot.fetchedAt }),
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
 * one source report independently, and `fetchedAt` is receipt time, not event time. A window's
 * reset time only ever moves forward, so an update for an earlier window is older data and never
 * applies. Within one window (an identical reset time) a lower reading is ambiguous: a late event
 * from a concurrent session looks exactly like a provider quota reset, which lowers usage without
 * moving the reset time (#3482). Hold the first lower reading in `pending` and keep the prior
 * window; a second consecutive lower reading confirms the decrease, while any reading at or above
 * the prior one discards it. This never applies to an authoritative read, which is current
 * whatever it says. */
function mergeObservedBucket(
  prior: SubscriptionUsageBucket | undefined,
  update: SubscriptionUsageBucket,
  pending: Map<string, SubscriptionUsageBucket>,
): SubscriptionUsageBucket {
  if (!prior) {
    pending.delete(update.id);
    return update;
  }
  if (prior.resetsAt !== undefined && update.resetsAt !== undefined) {
    if (update.resetsAt < prior.resetsAt) return prior;
    if (update.resetsAt === prior.resetsAt &&
        prior.usedPercent !== undefined && update.usedPercent !== undefined &&
        update.usedPercent < prior.usedPercent) {
      if (pending.get(update.id)?.resetsAt === update.resetsAt) {
        pending.delete(update.id);
        return { ...prior, ...update };
      }
      pending.set(update.id, update);
      return prior;
    }
  }
  // A status- or reset-only event says nothing about the held reading, so only a reported
  // utilization settles it.
  if (update.usedPercent !== undefined) pending.delete(update.id);
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
  /** Lower same-window readings awaiting confirmation, by bucket id. Claude notifications only. */
  pendingDecreases = new Map<string, SubscriptionUsageBucket>(),
): SubscriptionUsageSnapshot {
  if (!prior || prior.provider !== update.provider) return update;
  // Sparse notifications can be delayed behind a manual read. Never let an older provider
  // observation replace fields from a newer authoritative snapshot.
  if (update.fetchedAt < prior.fetchedAt) return prior;
  const merge = mergeMode === "claude-notification"
    ? (bucket: SubscriptionUsageBucket | undefined, next: SubscriptionUsageBucket) =>
      mergeObservedBucket(bucket, next, pendingDecreases)
    : mergeBucket;
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
  /** Called once the probe is over, with every process it started (none when it returned early).
   * Releases the probe's provider-HOME reference only if each process tree is proven gone. */
  settle?(children: readonly AgentProcess[]): Promise<void>;
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

/** Only a first-party claude.ai sign-in draws on a subscription: API, Bedrock and Vertex billing
 * can report an email too, but they share no allowance. */
function claudeSubscriptionIdentity(stdout: string): string | undefined {
  const status = JSON.parse(stdout) as Record<string, unknown>;
  if (status?.loggedIn !== true || status.authMethod !== "claude.ai") return undefined;
  if (status.apiProvider !== undefined && status.apiProvider !== "firstParty") return undefined;
  return claudeStatusIdentity(stdout);
}

/** Reads the account behind a Claude source from `claude auth status`, under the probe's own
 * authorization. Rejects when the status cannot be read, which proves nothing about the sign-in. */
export async function probeClaudeSubscriptionIdentity(
  agent: AgentDefinition,
  env: Record<string, string>,
  authorization: SubscriptionUsageProbeAuthorization,
  dependencies: Partial<Pick<CodexProbeDeps, "spawn" | "kill" | "onSpawn" | "onFinish">> = {},
  timeoutMs = SUBSCRIPTION_USAGE_PROBE_TIMEOUT_MS,
): Promise<string | undefined> {
  const kill = dependencies.kill ?? killTree;
  const child = (dependencies.spawn ?? spawnAgent)({
    command: agent.command,
    args: [...agent.args, "auth", "status"],
    cwd: authorization.cwd,
    env,
    context: agent.context,
    isolation: authorization.isolation,
  });
  dependencies.onSpawn?.(child);
  let timer: NodeJS.Timeout | undefined;
  try {
    child.stderr.resume();
    child.stdin.end();
    const stdout = await new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.length > MAX_AUTH_STATUS_OUTPUT) reject(new Error("claude auth status output is too large"));
      });
      // Claude can print its structured status before a non-zero exit, so the payload decides.
      child.on("close", () => resolve(output));
      child.on("error", reject);
      timer = setTimeout(() => reject(new Error("claude auth status timed out")), timeoutMs);
    });
    return claudeSubscriptionIdentity(stdout);
  } finally {
    clearTimeout(timer);
    kill(child);
    dependencies.onFinish?.(child);
  }
}

/** Reads the account behind a Codex source from its ChatGPT credential file. No file means no
 * ChatGPT sign-in here; a WSL home is not a host path, so that source reports no identity. Only
 * `codexCredentialIdentity`'s claims are read, and no token is retained. */
export async function readCodexSubscriptionIdentity(
  agent: AgentDefinition,
  env: Record<string, string>,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<string | undefined> {
  if (agent.context?.kind === "wsl") return undefined;
  const home = env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex");
  let content: string;
  try {
    content = await read(join(home, "auth.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return codexCredentialIdentity(content);
}

export interface SubscriptionIdentityRequest {
  agent: AgentDefinition;
  provider: SubscriptionUsageProvider;
  env: Record<string, string>;
  /** Takes the provider HOME's probe authorization, which the manager settles after the read. */
  authorize: () => Promise<SubscriptionUsageProbeAuthorization>;
  processes: Pick<CodexProbeDeps, "kill" | "onSpawn" | "onFinish">;
}

/** Resolves to a source's raw provider identity, or to nothing when it provably has none. Rejects
 * when the read failed, which keeps the identity already known. */
export async function readSubscriptionIdentity(request: SubscriptionIdentityRequest): Promise<string | undefined> {
  if (request.provider === "codex") {
    return request.env.OPENAI_API_KEY ? undefined : readCodexSubscriptionIdentity(request.agent, request.env);
  }
  return probeClaudeSubscriptionIdentity(request.agent, request.env, await request.authorize(), request.processes);
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
  /** A pre-v176 control plane cannot supply authoritative choices, so background sources wait. */
  selectionReady?: () => boolean;
  installationChoices?: () => readonly HarnessInstallationChoice[];
  providerAccounts?: () => ProviderAccountDefinition[];
  /** Production resolves the runner-local credential home against agent execution contexts. The
   * secret-free account passed here never exposes that path to snapshots or the control plane. */
  resolveProviderAccountAgent?: (
    account: ProviderAccountDefinition,
    supportedDrivers: AgentDriverKind[],
    agents: AgentDefinition[],
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
  onTargetChanged?: () => void;
  /** Learns which subscription a source draws on. Without it, sources report no identity. */
  resolveSubscriptionIdentity?: (request: SubscriptionIdentityRequest) => Promise<string | undefined>;
}

export class SubscriptionUsageManager {
  private readonly snapshots = new Map<string, SubscriptionUsageSnapshot>();
  private readonly lastProbeAt = new Map<string, number>();
  private readonly lastEvent = new Map<string, {
    signature: string;
    observedAt: number;
    /** This event put a lower same-window reading on hold, so its repeat confirms it. */
    heldDecrease: boolean;
  }>();
  /** Per source, the lower same-window Claude readings held until a second event confirms them. */
  private readonly pendingDecreases = new Map<string, Map<string, SubscriptionUsageBucket>>();
  /** Sources whose provider has answered at least once. Separates a source that has simply never
   * run from one whose provider reports no allowances, which read identically before. */
  private readonly responded = new Set<string>();
  private readonly activeProbeChildren = new Set<AgentProcess>();
  /** Per source, the fingerprint of its provider identity. Stamped onto what leaves this manager,
   * never onto stored snapshots, so no merge or replacement path can carry a stale one. */
  private readonly identities = new Map<string, string>();
  private readonly lastIdentityReadAt = new Map<string, number>();
  private identityRefresh: Promise<void> = Promise.resolve();
  private refreshPromise: Promise<SubscriptionUsageSnapshot[]> | null = null;
  private shuttingDown = false;
  private selectionGeneration = 0;

  constructor(private readonly options: SubscriptionUsageManagerOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Selection updates invalidate in-flight results and stop probes of the old executable. */
  selectionChanged(): SubscriptionUsageSnapshot[] {
    this.selectionGeneration++;
    for (const child of this.activeProbeChildren) (this.options.killProbe ?? killTree)(child);
    this.lastProbeAt.clear();
    this.lastEvent.clear();
    this.pendingDecreases.clear();
    this.responded.clear();
    this.lastIdentityReadAt.clear();
    return this.syncSources();
  }

  private stamped(snapshot: SubscriptionUsageSnapshot): SubscriptionUsageSnapshot {
    const identity = this.identities.get(snapshot.sourceId);
    return identity ? { ...snapshot, subscriptionIdentity: identity } : snapshot;
  }

  private publish(snapshot: SubscriptionUsageSnapshot): void {
    this.options.publish(this.stamped(snapshot));
  }

  /** Reads each matching source's identity in turn and publishes what changed. */
  refreshIdentities(matches: (source: SubscriptionSource) => boolean = () => true): Promise<void> {
    this.identityRefresh = this.identityRefresh.then(async () => {
      if (this.shuttingDown || !this.options.resolveSubscriptionIdentity) return;
      this.syncSources();
      const selectionGeneration = this.selectionGeneration;
      for (const source of this.sources().filter(matches)) {
        await this.refreshIdentity(source, selectionGeneration);
      }
    }).catch((error) => this.options.log?.(`subscription identity refresh failed: ${errorText(error)}`));
    return this.identityRefresh;
  }

  /** Claude's identity takes a status command per source, which must not spend the control plane's
   * refresh deadline: that only accounts for Codex probes. So it runs beside the usage refresh.
   * Codex reads a file, and does so inside `refreshCodex`, before the probe its identity qualifies. */
  private startClaudeIdentityRefresh(providerAccountId?: string): void {
    void this.refreshIdentities((source) => source.provider === "claude" &&
      (providerAccountId === undefined || source.providerAccountId === providerAccountId));
  }

  private async refreshIdentity(source: SubscriptionSource, selectionGeneration: number): Promise<void> {
    const resolve = this.options.resolveSubscriptionIdentity;
    if (!resolve || this.shuttingDown || selectionGeneration !== this.selectionGeneration) return;
    const state = this.initialSnapshot(source).state;
    if (source.agent.available !== true || state === "unsupported" || state === "unauthenticated" || state === "not_applicable") {
      this.applyIdentity(source, undefined);
      return;
    }
    const now = this.now();
    if (now - (this.lastIdentityReadAt.get(source.sourceId) ?? -Infinity) < SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS) return;
    this.lastIdentityReadAt.set(source.sourceId, now);
    const kill = this.options.killProbe ?? killTree;
    let authorization: SubscriptionUsageProbeAuthorization | undefined;
    const children: AgentProcess[] = [];
    const isCurrent = () => !this.shuttingDown && selectionGeneration === this.selectionGeneration &&
      this.isCurrentSource(source);
    try {
      const env = this.options.resolveEnv(
        source.agent.id,
        source.agent.driver,
        source.agent.context ?? { kind: "native" },
        source.providerAccountId,
      );
      const identity = await resolve({
        agent: source.agent,
        provider: source.provider,
        env,
        authorize: async () => {
          authorization = await this.options.authorizeProbe?.(source.agent, env, source.sourceId);
          if (!authorization) throw new Error("subscription usage probe authorization is unavailable");
          // The wait can outlast the selection, and the caller starts the harness as soon as this
          // returns. Refusing here keeps the old one from running; `finally` releases the grant.
          if (!isCurrent()) throw new Error("subscription identity read was superseded");
          return authorization;
        },
        processes: {
          kill,
          onSpawn: (child) => {
            children.push(child);
            this.activeProbeChildren.add(child);
            if (this.shuttingDown) kill(child);
          },
          onFinish: (child) => this.activeProbeChildren.delete(child),
        },
      });
      if (isCurrent()) this.applyIdentity(source, subscriptionIdentityFingerprint(identity));
    } catch (error) {
      if (isCurrent()) {
        this.options.log?.(`subscription identity read failed for ${source.agent.id}: ${errorText(error)}`);
      }
    } finally {
      try {
        await authorization?.settle?.(children);
      } catch (error) {
        this.options.log?.(`subscription identity probe ownership settlement failed: ${errorText(error)}`);
      }
    }
  }

  private applyIdentity(source: SubscriptionSource, identity: string | undefined): void {
    const prior = this.identities.get(source.sourceId);
    if (prior === identity) return;
    if (identity) this.identities.set(source.sourceId, identity);
    else this.identities.delete(source.sourceId);
    // The windows on record belong to the identity just lost. Clearing them now, not only when the
    // next one arrives, is what stops a later sign-in from inheriting them across a gap with none.
    if (prior) {
      this.pendingDecreases.delete(source.sourceId);
      this.lastEvent.delete(source.sourceId);
      this.lastProbeAt.delete(source.sourceId);
      this.snapshots.set(source.sourceId, this.initialSnapshot(source));
    }
    const snapshot = this.snapshots.get(source.sourceId);
    if (snapshot) this.publish(snapshot);
  }

  private isCurrentSource(source: SubscriptionSource): boolean {
    return this.sources().some((current) => current.sourceId === source.sourceId &&
      current.agent.id === source.agent.id && !current.unsupportedDetail);
  }

  private sources(): SubscriptionSource[] {
    if (this.options.selectionReady && !this.options.selectionReady()) return [];
    const result: SubscriptionSource[] = [];
    const seen = new Set<string>();
    const missingContexts = new Set<string>();
    const accountContexts = new Set<string>();
    const agents = this.options.agents();
    const choices = this.options.installationChoices?.() ?? [];
    const accounts = this.options.providerAccounts?.() ?? [];
    for (const account of accounts) {
      const supportedDrivers: AgentDriverKind[] = account.provider === "codex"
        ? ["codex-app-server"] : ["claude-code"];
      const resolved = this.options.resolveProviderAccountAgent
        ? this.options.resolveProviderAccountAgent(account, supportedDrivers, agents)
        : agentForProviderAccount(agents, account, supportedDrivers);
      const providerAgents = agents.filter((candidate) =>
        providerForDriver(candidate.driver ?? "acp") === account.provider &&
        supportedDrivers.includes(candidate.driver ?? "acp"));
      const fallback = resolved ??
        providerAgents.find((candidate) => candidate.defaultProviderAccountId === account.id) ??
        providerAgents.find((candidate) => (candidate.context?.kind ?? "native") === "native") ??
        providerAgents[0];
      const choice = fallback && harnessChoiceFor(choices, account.provider, fallback.context);
      const accountCompatibleAgents = [
        ...providerAgents.filter((candidate) => candidate.defaultProviderAccountId === account.id),
        ...providerAgents.filter((candidate) => !candidate.defaultProviderAccountId),
      ];
      const selected = fallback && choice
        ? accountCompatibleAgents.includes(fallback) && fallback.installation?.id === choice.installationId
          ? fallback
          : selectedHarnessAgent(accountCompatibleAgents, fallback.driver ?? "acp", fallback.context ?? { kind: "native" }, choices)
        : fallback;
      const agent = selected ?? fallback;
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
        ...(choice && !selected
          ? { unsupportedDetail: "The selected harness installation is unavailable in this provider account's execution context." }
          : !resolved && this.options.resolveProviderAccountAgent
            ? { unsupportedDetail: "This provider account's credential home is not available in a compatible provider execution context on this runner." }
            : {}),
      });
    }
    for (const agent of agents) {
      const provider = providerForDriver(agent.driver ?? "acp");
      if (!provider || agent.driver === "codex") continue;
      const sourceContext = `${provider}\0${contextKey(agent.context)}`;
      const mappedToAccount = accountContexts.has(sourceContext);
      if (mappedToAccount) continue;
      const choice = harnessChoiceFor(choices, provider, agent.context);
      const missingSelection = Boolean(choice && agent.installation?.id !== choice.installationId);
      if (missingSelection) {
        // Keep one explicit unsupported card only when rediscovery lost the chosen executable.
        if (selectedHarnessAgent(agents, agent.driver ?? "acp", agent.context ?? { kind: "native" }, choices) ||
            missingContexts.has(sourceContext)) continue;
        missingContexts.add(sourceContext);
      }
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
        ...(missingSelection
          ? { unsupportedDetail: "The selected harness installation is unavailable in this execution context." }
          : {}),
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
      if (!live.has(sourceId)) {
        this.snapshots.delete(sourceId);
        this.pendingDecreases.delete(sourceId);
        this.identities.delete(sourceId);
        this.lastIdentityReadAt.delete(sourceId);
      }
    }
    for (const source of sources) {
      const initial = this.initialSnapshot(source);
      const prior = this.snapshots.get(source.sourceId);
      // Claude discovery owns its source label. Codex labels arrive only from an authoritative
      // refresh, so comparing them here would mistake every populated Codex snapshot for a switch.
      const accountChanged = source.provider === "claude" && Boolean(prior) &&
        source.accountLabel !== prior?.accountLabel;
      const forced = source.unsupportedDetail != null || prior?.agentId !== source.agent.id ||
        initial.state === "unsupported" ||
        initial.state === "unauthenticated" ||
        initial.state === "not_applicable";
      if (forced) this.lastProbeAt.delete(source.sourceId);
      if (forced || accountChanged) this.pendingDecreases.delete(source.sourceId);
      this.snapshots.set(source.sourceId, forced || !prior || accountChanged ? initial : {
        ...prior,
        agentId: source.agent.id,
      });
    }
    return this.inventory();
  }

  inventory(): SubscriptionUsageSnapshot[] {
    return [...this.snapshots.values()].map((snapshot) => this.stamped(snapshot)).sort((left, right) =>
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
    const source = this.sources().find((candidate) => candidate.sourceId === sourceId &&
      (providerAccountId !== undefined || (!candidate.unsupportedDetail && candidate.agent.id === agentId)));
    if (!source) return null;
    if (update.kind === "response_observed") return source.unsupportedDetail
      ? null : this.observeProviderResponse(sourceId);
    // Account events come from live sessions, including sessions started before a choice changed.
    // Keep the canonical source agent for persistence, but return an event from an unsupported
    // source to its session so automatic account switching can still use the rate-limit window.
    const base = {
      sourceId,
      runnerId: this.options.runnerId,
      agentId: source.agent.id,
      ...(source.providerAccountId ? { providerAccountId: source.providerAccountId } : {}),
    };
    const normalized = provider === "codex"
      ? normalizeCodexRateLimits(update.payload, base, this.now())
      : normalizeClaudeRateLimits(update.payload, base, this.now());
    if (!normalized) return null;
    if (source.unsupportedDetail) return normalized;
    const prior = this.snapshots.get(sourceId);
    if (prior && normalized.fetchedAt < prior.fetchedAt) return prior;
    const { fetchedAt: _fetchedAt, ...eventShape } = normalized;
    const signature = JSON.stringify(eventShape);
    const event = this.lastEvent.get(sourceId);
    // A repeat of the event that held a decrease is exactly the confirmation that decrease waits
    // for, so only that repeat skips the dedupe.
    if (event?.signature === signature && !event.heldDecrease &&
        normalized.fetchedAt - event.observedAt < SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS) {
      return prior ?? null;
    }
    let pendingDecreases = this.pendingDecreases.get(sourceId);
    if (!pendingDecreases) {
      pendingDecreases = new Map();
      this.pendingDecreases.set(sourceId, pendingDecreases);
    }
    const heldBefore = new Map(pendingDecreases);
    const explained = this.explainMissingUtilization(mergeSnapshot(
      prior,
      withReadingTimes(normalized),
      provider === "claude" ? "claude-notification" : "plain",
      pendingDecreases,
    ));
    const heldDecrease = [...pendingDecreases].some(([id, bucket]) => heldBefore.get(id) !== bucket);
    this.lastEvent.set(sourceId, { signature, observedAt: normalized.fetchedAt, heldDecrease });
    if (explained === prior) return prior;
    this.snapshots.set(sourceId, explained);
    this.publish(explained);
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
    this.publish(updated);
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
    const selectionGeneration = this.selectionGeneration;
    const sources = this.sources().filter((source) => source.providerAccountId === providerAccountId);
    if (sources.length === 0) throw new Error("provider account is not configured");
    this.startClaudeIdentityRefresh(providerAccountId);
    for (const source of sources) {
      if (source.provider === "codex") await this.refreshCodex(source, selectionGeneration);
    }
    return this.inventory();
  }

  private async refreshAllNow(): Promise<SubscriptionUsageSnapshot[]> {
    this.syncSources();
    const selectionGeneration = this.selectionGeneration;
    this.startClaudeIdentityRefresh();
    const codexSources = this.sources().filter((source) => source.provider === "codex");
    // A runner may advertise several contexts. Probe sequentially to avoid concurrent mutation of
    // one provider HOME; the control plane derives a bounded deadline from this source count.
    // Duplicate manual requests share refreshPromise and each source has its own minimum interval.
    for (const source of codexSources) await this.refreshCodex(source, selectionGeneration);
    return this.inventory();
  }

  private async refreshCodex(source: SubscriptionSource, selectionGeneration: number): Promise<void> {
    if (this.shuttingDown || selectionGeneration !== this.selectionGeneration ||
        !this.sources().some((current) => current.sourceId === source.sourceId &&
          current.agent.id === source.agent.id)) return;
    if (this.options.resolveSubscriptionIdentity) {
      // First, so a sign-in that changed the subscription clears the old windows before the new ones.
      await this.refreshIdentity(source, selectionGeneration);
      if (this.shuttingDown || selectionGeneration !== this.selectionGeneration) return;
    }
    const initial = this.initialSnapshot(source);
    if (initial.state === "unsupported" ||
        initial.state === "unauthenticated" ||
        initial.state === "not_applicable" ||
        (initial.state === "unavailable" && source.agent.available !== true)) {
      this.snapshots.set(source.sourceId, initial);
      this.publish(initial);
      return;
    }
    const now = this.now();
    const lastProbeAt = this.lastProbeAt.get(source.sourceId) ?? 0;
    if (now - lastProbeAt < SUBSCRIPTION_USAGE_REFRESH_DEDUPE_MS) return;
    this.lastProbeAt.set(source.sourceId, now);
    let authorization: SubscriptionUsageProbeAuthorization | undefined;
    const probeChildren: AgentProcess[] = [];
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
        this.publish(notApplicable);
        return;
      }
      authorization = await this.options.authorizeProbe?.(source.agent, env, source.sourceId);
      if (!authorization) throw new Error("subscription usage probe authorization is unavailable");
      if (this.shuttingDown || selectionGeneration !== this.selectionGeneration || !this.isCurrentSource(source)) return;
      const target = source.agent.installation?.targetIdentity;
      if (target && !launchTargetStillMatches(
        { command: source.agent.command, args: source.agent.args ?? [] },
        source.agent.context ?? { kind: "native" },
        target,
      )) {
        this.options.onTargetChanged?.();
        const unavailable: SubscriptionUsageSnapshot = {
          ...initial,
          state: "unavailable",
          detail: "The harness installation changed; retry after Machine rediscovery.",
          fetchedAt: this.now(),
        };
        this.snapshots.set(source.sourceId, unavailable);
        this.publish(unavailable);
        return;
      }
      const result = await (this.options.probeCodex ?? probeCodexSubscriptionUsage)(
        source.agent,
        env,
        SUBSCRIPTION_USAGE_PROBE_TIMEOUT_MS,
        {
          kill: this.options.killProbe ?? killTree,
          onSpawn: (child) => {
            probeChildren.push(child);
            this.activeProbeChildren.add(child);
            if (this.shuttingDown) (this.options.killProbe ?? killTree)(child);
          },
          onFinish: (child) => this.activeProbeChildren.delete(child),
        },
        authorization,
      );
      if (this.shuttingDown || selectionGeneration !== this.selectionGeneration || !this.isCurrentSource(source)) return;
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
          ...withReadingTimes(normalized),
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
        this.publish(merged);
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
      this.publish(unavailable);
    } catch (error) {
      if (this.shuttingDown || selectionGeneration !== this.selectionGeneration || !this.isCurrentSource(source)) return;
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
      this.publish(failed);
    } finally {
      try {
        await authorization?.settle?.(probeChildren);
      } catch (error) {
        this.options.log?.(`subscription usage probe ownership settlement failed: ${errorText(error)}`);
      }
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
