import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Preserve the old nominal 400 × 50 ms budget, but include time spent probing.
const HEALTH_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT = 8_192;

export function sanitizeStartupOutput(value: string, secrets: readonly string[], repoRoot?: string): string {
  // Redact before truncation so a boundary cannot expose part of a known secret.
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[redacted]");
  if (repoRoot) result = result.split(repoRoot + "/").join("[repo]");
  return result
    .replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/(?<![\w-])((?:[\w-]*(?:token|secret|password|authorization|api[_-]?key)[\w-]*)["']?\s*[:=]\s*)[^\r\n]+/giu, "$1[redacted]")
    .replace(/(?<![\w:/\]])(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)[^\s"'<>]+/gu, "[path]");
}

export async function waitForLiveStackHealth(
  baseUrl: string,
  child: ChildProcess,
  logs: () => { controlPlane: string; runner: string },
  options: { phase: "initial startup" | "restart"; secrets: readonly string[]; repoRoot?: string; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const started = performance.now();
  let phase = "spawn requested";
  let lastProbe = "not attempted";
  let spawnError: string | null = null;
  const onSpawn = () => { phase = "process spawned"; };
  const onError = (error: NodeJS.ErrnoException) => { spawnError = error.code ?? "unknown"; };
  child.on("spawn", onSpawn);
  child.on("error", onError);
  if (child.pid !== undefined) phase = "process spawned";
  const failed = (reason: string) => {
    const output = logs();
    const section = (value: string) => sanitizeStartupOutput(value, options.secrets, options.repoRoot).slice(-OUTPUT_LIMIT);
    return new Error(
    `control plane did not become healthy: ${reason}\n` +
    `startup=${options.phase}; phase=${phase}; elapsedMs=${Math.round(performance.now() - started)}; budgetMs=${timeoutMs}\n` +
    `process=${spawnError ? "spawn failed" : child.exitCode !== null || child.signalCode !== null ? "exited" : child.pid === undefined ? "pending" : "running"}; ` +
    `exitCode=${child.exitCode}; signal=${child.signalCode}; spawnError=${spawnError ?? "none"}\n` +
    `lastHealthProbe=${lastProbe}\n=== CONTROL PLANE ===\n${section(output.controlPlane)}\n=== RUNNER ===\n${section(output.runner)}`,
    );
  };
  try {
    while (performance.now() - started < timeoutMs) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) throw failed("process stopped");
      const remaining = timeoutMs - (performance.now() - started);
      try {
        const response = await fetch(`${baseUrl}/healthz`, {
          signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, Math.ceil(remaining)))),
        });
        lastProbe = `HTTP ${response.status}`;
        phase = "health listener responded";
        await response.body?.cancel();
        if (response.ok) return;
      } catch (error) {
        // Error messages and causes can contain URLs, credentials and local paths.
        lastProbe = error instanceof Error && error.name === "TimeoutError"
          ? "probe timed out" : "connection error";
      }
      await delay(Math.max(0, Math.min(50, timeoutMs - (performance.now() - started))));
    }
    throw failed("readiness deadline exceeded");
  } finally {
    child.off("spawn", onSpawn);
    child.off("error", onError);
  }
}
