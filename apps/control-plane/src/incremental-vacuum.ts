import { randomUUID } from "node:crypto";
import type { ControlPlaneDb } from "./db.js";

export const INCREMENTAL_VACUUM_ENV = "CONTROL_PLANE_DB_INCREMENTAL_VACUUM";
export const INCREMENTAL_VACUUM_ARMING_MS = 86_400_000;
export const INCREMENTAL_VACUUM_STARTUP_MS = 10 * 60_000;
export const INCREMENTAL_VACUUM_INTERVAL_MS = 60 * 60_000;
export const INCREMENTAL_VACUUM_MAX_STEPS = 1_000;
export const INCREMENTAL_VACUUM_MIN_FREE_PAGES = 256;

export function parseIncrementalVacuum(value: string | undefined): { enabled: boolean; invalid: boolean } {
  const v = value?.trim() ?? "";
  return { enabled: v === "1", invalid: !["", "0", "1"].includes(v) };
}

export interface IncrementalVacuumResult {
  steps: number;
  reclaimedPages: number;
  reclaimedBytes: number;
  p95StepMs: number;
  maxStepMs: number;
}

/** Host-wide storage maintenance; organization policy and retained records are unaffected. */
export class IncrementalVacuum {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly enabled: boolean;
  private readonly armedAt: number | null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<IncrementalVacuumResult> | null = null;

  constructor(private readonly db: ControlPlaneDb, private readonly options: {
    env?: NodeJS.ProcessEnv;
    log: { info(details: object, message: string): void; warn(details: object, message: string): void };
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const parsed = parseIncrementalVacuum((options.env ?? process.env)[INCREMENTAL_VACUUM_ENV]);
    const startup = { runId: randomUUID(), entryPoint: "startup" };
    if (parsed.invalid) options.log.warn({ ...startup, event: "incremental_vacuum_invalid", variable: INCREMENTAL_VACUUM_ENV },
      "invalid incremental vacuum configuration; treated as off");
    this.enabled = parsed.enabled;
    const previous = db.getIncrementalVacuumPolicy();
    this.armedAt = !this.enabled ? null : previous?.enabled && previous.armedAt !== null
      ? previous.armedAt : this.now() + INCREMENTAL_VACUUM_ARMING_MS;
    if (previous?.enabled !== this.enabled || previous?.armedAt !== this.armedAt) {
      db.saveIncrementalVacuumPolicy({ enabled: this.enabled, armedAt: this.armedAt });
    }
    const { mode } = db.incrementalVacuumStats();
    options.log.info({ ...startup, event: "incremental_vacuum_configured", enabled: this.enabled, armedAt: this.armedAt, mode },
      this.enabled ? "host incremental vacuum configured" : "incremental vacuum is off; free pages are reused");
    if (this.enabled && mode !== 2) options.log.warn({ ...startup, event: "incremental_vacuum_conversion_required", mode },
      "incremental vacuum requires offline conversion; see docs/archived-history-retention.md");
  }

  start(): void { if (!this.timer && !this.stopped) this.schedule(INCREMENTAL_VACUUM_STARTUP_MS); }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runPass().finally(() => this.schedule(INCREMENTAL_VACUUM_INTERVAL_MS));
    }, ms);
    this.timer.unref?.();
  }
  runPass(): Promise<IncrementalVacuumResult> {
    this.running ??= this.pass().finally(() => { this.running = null; });
    return this.running;
  }
  private async pass(): Promise<IncrementalVacuumResult> {
    const result: IncrementalVacuumResult = { steps: 0, reclaimedPages: 0, reclaimedBytes: 0, p95StepMs: 0, maxStepMs: 0 };
    const started = this.now();
    if (this.stopped || !this.enabled || this.armedAt === null || started < this.armedAt) return result;
    const context = { runId: randomUUID(), entryPoint: "maintenance" };
    const durations: number[] = [];
    let pages = 1;
    let onePageMs = Infinity;
    let deferred = false;
    let slowSteps = 0;
    try {
      const initial = this.db.incrementalVacuumStats();
      if (initial.mode !== 2 || initial.freePages < INCREMENTAL_VACUUM_MIN_FREE_PAGES) return result;
      while (!this.stopped && result.steps < INCREMENTAL_VACUUM_MAX_STEPS) {
        const before = performance.now();
        const step = this.db.incrementalVacuumStep(pages);
        const elapsed = performance.now() - before;
        durations.push(elapsed);
        result.steps++;
        result.reclaimedPages += step.reclaimedPages;
        result.reclaimedBytes += step.reclaimedPages * initial.pageSize;
        if (elapsed >= 16 && ++slowSteps === 1) this.options.log.warn({ ...context, event: "incremental_vacuum_slow_step", stepMs: elapsed, pages },
          "incremental vacuum step exceeded the 16 ms latency target; benchmark this storage; further slow steps are counted in the pass summary");
        // FULL commits have a fixed sync cost. Measure the one-page baseline so
        // that cost cannot consume the entire 4 ms budget for additional pages.
        if (pages === 1) onePageMs = elapsed;
        // Keep headroom below 16 ms regardless of the baseline estimate. Limit
        // growth to doubling so a noisy first sample cannot jump straight to 32.
        pages = elapsed >= 12
          ? Math.max(1, Math.floor(pages * 8 / elapsed))
          : Math.max(1, Math.min(32, pages * 2, Math.floor(pages * 4 / Math.max(1, elapsed - onePageMs))));
        // Yield even after the final step, leaving at least three quarters of time for requests.
        await this.sleep(Math.max(1, Math.ceil(elapsed * 3)));
        if (!step.reclaimedPages || step.freePages === 0) break;
      }
    } catch (error) {
      deferred = true;
      this.options.log.warn({ ...context, event: "incremental_vacuum_deferred", error: error instanceof Error ? error.message : String(error) },
        "incremental vacuum deferred until next pass");
    }
    durations.sort((a, b) => a - b);
    result.p95StepMs = durations[Math.ceil(durations.length * 0.95) - 1] ?? 0;
    result.maxStepMs = durations.at(-1) ?? 0;
    this.options.log.info({ ...context, event: "incremental_vacuum_pass", ...result, deferred, slowSteps,
      pagesPerStep: result.steps ? result.reclaimedPages / result.steps : 0,
      durationMs: this.now() - started, interrupted: this.stopped, stepLimitReached: result.steps === INCREMENTAL_VACUUM_MAX_STEPS },
    "incremental vacuum pass finished; reclaimed bytes reach the main file through normal WAL checkpoints");
    return result;
  }
}
