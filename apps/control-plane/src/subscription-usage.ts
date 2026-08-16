import { createHash } from "node:crypto";
import type {
  AgentDefinition,
  SubscriptionUsageBucket,
  SubscriptionUsageSnapshot,
  SubscriptionUsageSpendControl,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";

type JsonRecord = Record<string, unknown>;

export const SUBSCRIPTION_USAGE_STALE_AFTER_MS = 10 * 60_000;
export const SUBSCRIPTION_USAGE_REFRESH_TIMEOUT_MS = 10_000;
export const MAX_SUBSCRIPTION_USAGE_REFRESH_TIMEOUT_MS = 60_000;
export const MAX_SUBSCRIPTION_USAGE_SNAPSHOTS = 32;
const MAX_BUCKETS = 64;
const MAX_SPEND_CONTROLS = 64;

export function subscriptionUsageRefreshTimeoutMs(codexSourceCount: number): number {
  return Math.min(
    MAX_SUBSCRIPTION_USAGE_REFRESH_TIMEOUT_MS,
    SUBSCRIPTION_USAGE_REFRESH_TIMEOUT_MS +
      Math.max(0, Math.floor(codexSourceCount) - 1) * 8_000,
  );
}

function record(value: unknown): JsonRecord {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("subscription usage value must be an object");
  }
  return value as JsonRecord;
}

function text(value: unknown, field: string, max: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function number(value: unknown, field: string, min: number, max: number, optional = false): number | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} is out of range`);
  }
  return value;
}

function boolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function expectedSourceId(runnerId: string, agent: AgentDefinition, provider: "codex" | "claude"): string {
  const context = agent.context?.kind === "wsl" ? `wsl:${agent.context.distro}` : "native";
  return createHash("sha256")
    .update(JSON.stringify({ runnerId, agentId: agent.id, provider, context }))
    .digest("hex")
    .slice(0, 32);
}

function bucket(value: unknown, now: number): SubscriptionUsageBucket {
  const input = record(value);
  const usedPercent = number(input.usedPercent, "bucket usedPercent", 0, 100, true);
  const remainingPercent = number(input.remainingPercent, "bucket remainingPercent", 0, 100, true);
  const windowDurationMinutes = number(input.windowDurationMinutes, "bucket duration", 1, 2 * 365 * 24 * 60, true);
  const resetsAt = number(input.resetsAt, "bucket reset", 1, now + 2 * 365 * 24 * 60 * 60_000, true);
  const status = input.status;
  if (status !== undefined && status !== "available" && status !== "warning" && status !== "exhausted") {
    throw new Error("bucket status is invalid");
  }
  return {
    id: text(input.id, "bucket id", 96)!,
    label: text(input.label, "bucket label", 160)!,
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(remainingPercent === undefined ? {} : { remainingPercent }),
    ...(windowDurationMinutes === undefined ? {} : { windowDurationMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(status === undefined ? {} : { status }),
  };
}

function spendControl(value: unknown, now: number): SubscriptionUsageSpendControl {
  const input = record(value);
  const limit = text(input.limit, "spend limit", 80, true);
  const used = text(input.used, "spend used", 80, true);
  const remainingPercent = number(input.remainingPercent, "spend remainingPercent", 0, 100, true);
  const resetsAt = number(input.resetsAt, "spend reset", 1, now + 2 * 365 * 24 * 60 * 60_000, true);
  const reached = boolean(input.reached, "spend reached");
  return {
    id: text(input.id, "spend id", 96)!,
    label: text(input.label, "spend label", 160)!,
    ...(limit === undefined ? {} : { limit }),
    ...(used === undefined ? {} : { used }),
    ...(remainingPercent === undefined ? {} : { remainingPercent }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(reached === undefined ? {} : { reached }),
  };
}

export function validateSubscriptionUsageSnapshot(
  value: unknown,
  authenticatedRunnerId: string,
  db: ControlPlaneDb,
  now = Date.now(),
): SubscriptionUsageSnapshot {
  const input = record(value);
  const runnerId = text(input.runnerId, "runnerId", 200)!;
  if (runnerId !== authenticatedRunnerId) throw new Error("subscription usage runner binding does not match");
  const sourceId = text(input.sourceId, "sourceId", 32)!;
  if (!/^[a-f0-9]{32}$/.test(sourceId)) throw new Error("subscription usage sourceId is invalid");
  const agentId = text(input.agentId, "agentId", 128)!;
  const provider = input.provider;
  if (provider !== "codex" && provider !== "claude") throw new Error("subscription usage provider is invalid");
  const agent = db.getRunner(runnerId)?.agents.find((candidate) => candidate.id === agentId);
  const expectedDriver = provider === "codex" ? "codex-app-server" : "claude-code";
  if (!agent || agent.driver !== expectedDriver || sourceId !== expectedSourceId(runnerId, agent, provider)) {
    throw new Error("subscription usage source is not advertised by this runner");
  }
  const state = input.state;
  if (state !== "available" && state !== "unavailable" && state !== "unsupported" &&
      state !== "unauthenticated" && state !== "not_applicable") {
    throw new Error("subscription usage state is invalid");
  }
  const fetchedAt = number(input.fetchedAt, "fetchedAt", 1, now + 5 * 60_000)!;
  if (!Array.isArray(input.buckets) || input.buckets.length > MAX_BUCKETS) {
    throw new Error("subscription usage buckets are invalid");
  }
  const detail = text(input.detail, "detail", 500, true);
  const plan = text(input.plan, "plan", 80, true);
  const creditsInput = input.credits === undefined ? undefined : record(input.credits);
  const credits = creditsInput ? {
    ...(boolean(creditsInput.hasCredits, "credits hasCredits") === undefined
      ? {}
      : { hasCredits: boolean(creditsInput.hasCredits, "credits hasCredits")! }),
    ...(boolean(creditsInput.unlimited, "credits unlimited") === undefined
      ? {}
      : { unlimited: boolean(creditsInput.unlimited, "credits unlimited")! }),
    ...(text(creditsInput.balance, "credits balance", 80, true) === undefined
      ? {}
      : { balance: text(creditsInput.balance, "credits balance", 80, true)! }),
  } : undefined;
  if (input.spendControls !== undefined && (!Array.isArray(input.spendControls) || input.spendControls.length > MAX_SPEND_CONTROLS)) {
    throw new Error("subscription usage spend controls are invalid");
  }
  return {
    sourceId,
    runnerId,
    agentId,
    provider,
    state,
    ...(detail === undefined ? {} : { detail }),
    fetchedAt,
    buckets: input.buckets.map((item) => bucket(item, now)),
    ...(plan === undefined ? {} : { plan }),
    ...(credits === undefined ? {} : { credits }),
    ...(input.spendControls === undefined
      ? {}
      : { spendControls: input.spendControls.map((item) => spendControl(item, now)) }),
  };
}

export function validateSubscriptionUsageInventory(
  value: unknown,
  authenticatedRunnerId: string,
  db: ControlPlaneDb,
  now = Date.now(),
): SubscriptionUsageSnapshot[] {
  if (!Array.isArray(value) || value.length > MAX_SUBSCRIPTION_USAGE_SNAPSHOTS) {
    throw new Error("subscription usage inventory is invalid");
  }
  const snapshots = value.map((item) => validateSubscriptionUsageSnapshot(item, authenticatedRunnerId, db, now));
  if (new Set(snapshots.map((snapshot) => snapshot.sourceId)).size !== snapshots.length) {
    throw new Error("subscription usage inventory contains duplicate sources");
  }
  return snapshots;
}
