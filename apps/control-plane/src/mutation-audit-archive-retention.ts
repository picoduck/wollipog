import { randomUUID } from "node:crypto";
import type { ControlPlaneDb } from "./db.js";

export const MUTATION_AUDIT_ARCHIVE_RETENTION_ENV = "CONTROL_PLANE_MUTATION_AUDIT_ARCHIVE_RETENTION_DAYS";
export const MUTATION_AUDIT_ARCHIVE_RETENTION_LIMITS = { minDays: 7, maxDays: 3650, suggestedDays: 90 };
const DAY_MS = 86_400_000;
export const MUTATION_AUDIT_ARCHIVE_ARMING_MS = DAY_MS;
export const MUTATION_AUDIT_ARCHIVE_STARTUP_MS = 10 * 60_000;
export const MUTATION_AUDIT_ARCHIVE_INTERVAL_MS = 60 * 60_000;
const MAX_BATCHES = 1_000;

export function parseMutationAuditArchiveRetention(value: string | undefined): {
  retentionDays: number | null; invalid: boolean;
} {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || trimmed === "0") return { retentionDays: null, invalid: false };
  const days = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  return Number.isSafeInteger(days) && days >= MUTATION_AUDIT_ARCHIVE_RETENTION_LIMITS.minDays &&
    days <= MUTATION_AUDIT_ARCHIVE_RETENTION_LIMITS.maxDays
    ? { retentionDays: days, invalid: false } : { retentionDays: null, invalid: true };
}

export interface MutationAuditArchivePassResult {
  removed: number; batches: number; maxBatchMs: number;
}

/** Host environment only: no API, organization override or agent tool can change this policy. */
export class MutationAuditArchiveRetention {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retentionDays: number | null;
  private readonly prunesFrom: number | null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<MutationAuditArchivePassResult> | null = null;
  private batchSize = 100;

  constructor(private readonly db: ControlPlaneDb, private readonly options: {
    env?: NodeJS.ProcessEnv;
    log: { info(details: object, message: string): void; warn(details: object, message: string): void };
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const parsed = parseMutationAuditArchiveRetention((options.env ?? process.env)[MUTATION_AUDIT_ARCHIVE_RETENTION_ENV]);
    if (parsed.invalid) options.log.warn({ event: "mutation_audit_archive_retention_invalid",
      variable: MUTATION_AUDIT_ARCHIVE_RETENTION_ENV, limits: MUTATION_AUDIT_ARCHIVE_RETENTION_LIMITS },
    "invalid mutation audit archive retention; treated as off");
    const previous = db.getMutationAuditArchiveRetention();
    this.retentionDays = parsed.retentionDays;
    this.prunesFrom = this.retentionDays === null ? null
      : previous.retentionDays === null || previous.prunesFrom === null || this.retentionDays < previous.retentionDays
        ? Math.max(previous.prunesFrom ?? 0, this.now() + MUTATION_AUDIT_ARCHIVE_ARMING_MS)
        : previous.prunesFrom;
    if (previous.retentionDays !== this.retentionDays || previous.prunesFrom !== this.prunesFrom) {
      db.saveMutationAuditArchiveRetentionPolicy(this.retentionDays, this.prunesFrom);
    }
    options.log.info({ event: "mutation_audit_archive_retention", retentionDays: this.retentionDays,
      prunesFrom: this.prunesFrom, ageBasis: "created_at", removedTotal: previous.removedTotal },
    this.retentionDays === null ? "mutation audit archive retention is off; archive rows are kept forever"
      : "host mutation audit archive retention configured");
  }

  start(): void { if (!this.timer && !this.stopped) this.schedule(MUTATION_AUDIT_ARCHIVE_STARTUP_MS); }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runPass().finally(() => this.schedule(MUTATION_AUDIT_ARCHIVE_INTERVAL_MS));
    }, ms);
    this.timer.unref?.();
  }
  runPass(): Promise<MutationAuditArchivePassResult> {
    this.running ??= this.pass().finally(() => { this.running = null; });
    return this.running;
  }
  private async pass(): Promise<MutationAuditArchivePassResult> {
    const result = { removed: 0, batches: 0, maxBatchMs: 0 };
    const started = this.now();
    if (this.stopped || this.retentionDays === null || this.prunesFrom === null || started < this.prunesFrom) return result;
    const cutoff = started - this.retentionDays * DAY_MS;
    const runId = randomUUID();
    try {
      while (!this.stopped && result.batches < MAX_BATCHES) {
        const before = performance.now();
        const removed = this.db.pruneMutationAuditArchiveBatch(cutoff, this.batchSize);
        const elapsed = performance.now() - before;
        result.maxBatchMs = Math.max(result.maxBatchMs, elapsed);
        result.batches++;
        result.removed += removed;
        if (!removed) break;
        this.batchSize = Math.max(1, Math.min(500, Math.floor(this.batchSize * 4 / Math.max(1, elapsed))));
        // Yield after every nonempty batch; rest 3x the work to leave ~75% for other requests.
        await this.sleep(Math.max(1, Math.ceil(elapsed * 3)));
      }
      this.db.recordMutationAuditArchiveRetentionPass(this.now(), cutoff, result.removed);
      this.options.log.info({ event: "mutation_audit_archive_pruned", runId, entryPoint: "maintenance",
        retentionDays: this.retentionDays, cutoff, ...result, durationMs: this.now() - started,
        interrupted: this.stopped, batchLimitReached: result.batches === MAX_BATCHES }, "mutation audit archive retention pass finished");
    } catch (error) {
      this.options.log.warn({ event: "mutation_audit_archive_retention_deferred", runId, entryPoint: "maintenance",
        ...result, error: error instanceof Error ? error.message : String(error) }, "mutation audit archive retention deferred until next pass");
    }
    return result;
  }
}
