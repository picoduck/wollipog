import type { AgentDriverKind, UsageAggregationGranularity, UsageRetentionPolicy } from "@wollipog/protocol";
import type { UsageAggregationQuery } from "./db.js";

const DRIVERS = new Set<AgentDriverKind>(["acp", "claude-code", "codex", "codex-app-server"]);
const DAY_MS = 86_400_000;

function boundedFilter(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 256) throw new RangeError(`${name} must be at most 256 characters`);
  return value;
}

export function parseUsageAggregationQuery(
  raw: Record<string, unknown>,
  retention: UsageRetentionPolicy,
  now = Date.now(),
): UsageAggregationQuery {
  const daysValue = Number(raw.days ?? 30);
  if (!Number.isFinite(daysValue) || !Number.isInteger(daysValue)) {
    throw new RangeError("days must be a whole finite number");
  }
  const days = Math.floor(daysValue);
  if (days < 1 || days > retention.dailyDays) {
    throw new RangeError(`days must be between 1 and ${retention.dailyDays}`);
  }
  const granularity = (raw.granularity ?? (days <= retention.hourlyDays ? "hour" : "day")) as
    UsageAggregationGranularity;
  if (granularity !== "hour" && granularity !== "day") {
    throw new RangeError("granularity must be hour or day");
  }
  if (granularity === "hour" && days > retention.hourlyDays) {
    throw new RangeError(`hour granularity is retained for at most ${retention.hourlyDays} days`);
  }
  const driverRaw = boundedFilter(raw.driver, "driver");
  if (driverRaw && !DRIVERS.has(driverRaw as AgentDriverKind)) throw new RangeError("driver is invalid");
  const bucketMs = granularity === "hour" ? 3_600_000 : DAY_MS;
  const observedSince = Math.max(retention.coverageStartedAt, now - days * DAY_MS);
  return {
    since: Math.floor(observedSince / bucketMs) * bucketMs,
    through: now,
    granularity,
    ...(boundedFilter(raw.runnerId, "runnerId") ? { runnerId: raw.runnerId as string } : {}),
    ...(boundedFilter(raw.workspaceId, "workspaceId") ? { workspaceId: raw.workspaceId as string } : {}),
    ...(boundedFilter(raw.agentId, "agentId") ? { agentId: raw.agentId as string } : {}),
    ...(driverRaw ? { driver: driverRaw as AgentDriverKind } : {}),
  };
}

export function parseUsageRetentionInput(raw: unknown): { hourlyDays: number; dailyDays: number } {
  if (!raw || typeof raw !== "object") throw new RangeError("retention body is required");
  const body = raw as Record<string, unknown>;
  const hourlyDays = body.hourlyDays;
  const dailyDays = body.dailyDays;
  if (typeof hourlyDays !== "number" || !Number.isFinite(hourlyDays) || !Number.isInteger(hourlyDays) || hourlyDays < 1 || hourlyDays > 90) {
    throw new RangeError("hourlyDays must be an integer between 1 and 90");
  }
  if (typeof dailyDays !== "number" || !Number.isFinite(dailyDays) || !Number.isInteger(dailyDays) || dailyDays < Math.max(hourlyDays, 30) || dailyDays > 3650) {
    throw new RangeError("dailyDays must be an integer between max(hourlyDays, 30) and 3650");
  }
  return { hourlyDays, dailyDays };
}
