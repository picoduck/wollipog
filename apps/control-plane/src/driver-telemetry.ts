import type { DriverTelemetryMessage } from "@wollipog/protocol";

const DRIVERS = new Set(["acp", "claude-code", "codex", "codex-app-server"]);
const METRICS = new Set(["launch", "resume", "approval", "crash", "fallback"]);
const OUTCOMES = new Set(["success", "failure", "allowed", "denied", "cancelled", "observed"]);
const REASONS = new Set(["fresh", "process_restart", "app_server_exit", "agent_exit", "explicit_exec", "compatibility_exec"]);

/** Runtime boundary for a runner frame: bound values/cardinality before aggregate persistence. */
export function normalizeDriverTelemetry(message: DriverTelemetryMessage): DriverTelemetryMessage | null {
  const valid =
    DRIVERS.has(message.driver) &&
    METRICS.has(message.metric) &&
    OUTCOMES.has(message.outcome) &&
    (message.context === "native" || message.context === "wsl") &&
    (message.reason === undefined || REASONS.has(message.reason)) &&
    (message.durationMs === undefined || (Number.isFinite(message.durationMs) && message.durationMs >= 0))
  if (!valid) return null;
  // A malformed/free-form version must not become a persisted dimension, but it also should not
  // discard the otherwise useful closed observation. Discovery normally supplies a semver token.
  const version = message.version && /^[A-Za-z0-9.+_-]{1,80}$/.test(message.version) ? message.version : undefined;
  return { ...message, version };
}

export function telemetryWindowDays(raw: unknown): number | null {
  const value = Number(raw ?? 30);
  return Number.isFinite(value) && value >= 1 && value <= 90 ? Math.floor(value) : null;
}
