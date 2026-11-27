import { performance } from "node:perf_hooks";

export type GuardPhase = "fixture" | "version" | "inventory" | "cli-exec" | "cli-tui" | "app-server";
let sequence = 0;

/** Only fixture-owned labels and timings enter reports, never provider output or exceptions. */
export async function guardPhase<T>(phase: GuardPhase, limitMs: number, action: () => Promise<T>): Promise<T> {
  const id = ++sequence;
  const started = performance.now();
  const emit = (state: "started" | "completed" | "failed") => console.log(JSON.stringify({
    event: "codex_guard_phase", phase, id, state, limitMs,
    elapsedMs: Math.round(performance.now() - started),
  }));
  emit("started");
  try {
    const result = await action();
    emit("completed");
    return result;
  } catch (error) {
    emit("failed");
    throw error;
  }
}
