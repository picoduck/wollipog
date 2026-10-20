import {
  ARCHIVED_HISTORY_RETENTION_DELAY_MS,
  ARCHIVED_HISTORY_RETENTION_LIMITS,
  type ArchivedHistoryRetentionView,
  runnerSupportsProtocol,
} from "@wollipog/protocol";
import { randomUUID } from "node:crypto";
import type { Hub } from "./hub.js";
import type { ControlPlaneDb } from "./db.js";

/**
 * Archived-history retention (#2777): once an organization turns it on, archived sessions older
 * than its threshold keep their prompts, final response, usage, report and attachment events and
 * lose the rest of their cached transcript. See docs/archived-history-retention.md.
 */

export const ARCHIVED_HISTORY_RETENTION_ENV = "CONTROL_PLANE_ARCHIVED_HISTORY_RETENTION_DAYS";
const DAY_MS = 24 * 60 * 60_000;
export const ARCHIVED_HISTORY_RETENTION_STARTUP_DELAY_MS = 10 * 60_000;
export const ARCHIVED_HISTORY_RETENTION_INTERVAL_MS = 60 * 60_000;

/** The approved ceilings for one batch's transaction. */
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** Each batch should finish in about this long. Removing indexed text costs 2–5 ms per KB with
 * FTS5 secure-delete on an SSD, far more than the rows themselves, so the per-batch budgets adapt
 * to the measured time below the ceilings. One row's text cannot be split, so a batch holding a
 * single row near the 8 KB index cap still takes longer; such rows are about 0.02% of events. */
const TARGET_BATCH_MS = 4;
const EVENT_BUDGET = { initial: 100, min: 8, max: MAX_BATCH_EVENTS };
const SEARCH_BUDGET = { initial: 1024, min: 256, max: 64 * 1024 };
/** Rest three times as long as a batch took, so pruning uses at most a quarter of the event loop. */
const PACING_FACTOR = 3;
const LEGACY_SEARCH_ROWS_PER_STEP = 1_000;
const CANDIDATES_PER_PAGE = 50;

export interface ArchivedHistoryRetentionLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

export interface ArchivedHistoryRetentionPolicy {
  retentionDays: number | null;
  prunesFrom: number | null;
  source: ArchivedHistoryRetentionView["source"];
}

export interface ArchivedHistoryPassResult {
  sessions: number;
  events: number;
  batches: number;
  maxBatchMs: number;
}

export function validArchivedHistoryRetentionDays(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= ARCHIVED_HISTORY_RETENTION_LIMITS.minDays && value <= ARCHIVED_HISTORY_RETENTION_LIMITS.maxDays;
}

/** Unset, empty or 0 turns the environment default off. Anything else outside the limits is
 * reported and treated as off: an operator typo must never delete history. */
export function parseArchivedHistoryRetentionEnvironment(value: string | undefined): {
  retentionDays: number | null; invalid: boolean;
} {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "" || trimmed === "0") return { retentionDays: null, invalid: false };
  const days = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  return validArchivedHistoryRetentionDays(days)
    ? { retentionDays: days, invalid: false }
    : { retentionDays: null, invalid: true };
}

export class ArchivedHistoryRetention {
  private readonly environment: { retentionDays: number | null; prunesFrom: number | null };
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<ArchivedHistoryPassResult> | null = null;
  private stopped = false;
  private nextRunAt: number | null = null;
  private eventBudget = EVENT_BUDGET.initial;
  private searchBudget = SEARCH_BUDGET.initial;

  constructor(
    private readonly db: ControlPlaneDb,
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      log: ArchivedHistoryRetentionLog;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      hub?: Pick<Hub, "isRunnerOnline" | "requestFromRunner">;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const parsed = parseArchivedHistoryRetentionEnvironment((options.env ?? process.env)[ARCHIVED_HISTORY_RETENTION_ENV]);
    if (parsed.invalid) {
      options.log.warn({ variable: ARCHIVED_HISTORY_RETENTION_ENV, limits: ARCHIVED_HISTORY_RETENTION_LIMITS },
        "archived history retention environment value is invalid; it is treated as off");
    }
    this.environment = this.armEnvironment(parsed.retentionDays, this.now());
    options.log.info({
      event: "archived_history_retention",
      environmentDays: this.environment.retentionDays,
      prunesFrom: this.environment.prunesFrom,
    }, this.environment.retentionDays === null
      ? "archived history retention is off unless an organization turns it on"
      : `archived history retention defaults to ${this.environment.retentionDays} days after archiving`);
  }

  /** The environment default arms like a saved setting: turning it on or shortening it waits out
   * the delay, measured from the first start that saw the new value. */
  private armEnvironment(retentionDays: number | null, now: number): { retentionDays: number | null; prunesFrom: number | null } {
    const saved = this.db.getArchivedHistoryEnvironmentPolicy();
    const previous = { retentionDays: saved?.retentionDays ?? null, prunesFrom: saved?.prunesFrom ?? null };
    const next = {
      retentionDays,
      prunesFrom: retentionDays === null ? null : armedPrunesFrom(previous, retentionDays, now),
    };
    if (!saved || saved.retentionDays !== next.retentionDays || saved.prunesFrom !== next.prunesFrom) {
      this.db.saveArchivedHistoryEnvironmentPolicy(next);
    }
    return next;
  }

  policy(organizationId: string): ArchivedHistoryRetentionPolicy {
    const saved = this.db.getArchivedHistoryRetentionPolicy(organizationId);
    if (saved) return { ...saved, source: "organization" };
    if (this.environment.retentionDays !== null) return { ...this.environment, source: "environment" };
    return { retentionDays: null, prunesFrom: null, source: "default" };
  }

  view(organizationId: string, canManage: boolean, previewDays?: number): ArchivedHistoryRetentionView {
    const now = this.now();
    const policy = this.policy(organizationId);
    const counts = (days: number) => this.db.archivedHistoryRetentionCounts(organizationId, now - days * DAY_MS);
    return {
      retentionDays: policy.retentionDays,
      source: policy.source,
      environmentDays: this.environment.retentionDays,
      canManage,
      prunesFrom: policy.prunesFrom,
      nextRunAt: this.nextRunAt,
      eligible: policy.retentionDays === null ? { sessions: 0, events: 0 } : counts(policy.retentionDays),
      lastRun: this.db.archivedHistoryRetentionLastRun(organizationId),
      limits: ARCHIVED_HISTORY_RETENTION_LIMITS,
      ...(previewDays === undefined ? {} : {
        preview: {
          retentionDays: previewDays,
          eligible: counts(previewDays),
          prunesFrom: armedPrunesFrom(policy, previewDays, now),
        },
      }),
    };
  }

  /** Save the organization's policy. Turning it on or shortening it waits out the delay; turning it
   * off or lengthening it applies at once. */
  update(organizationId: string, retentionDays: number | null, updatedBy: string | null): ArchivedHistoryRetentionView {
    const now = this.now();
    const current = this.policy(organizationId);
    const prunesFrom = retentionDays === null ? null : armedPrunesFrom(current, retentionDays, now);
    this.db.saveArchivedHistoryRetentionPolicy(organizationId, { retentionDays, prunesFrom }, updatedBy, now);
    this.options.log.info({
      event: "archived_history_retention_changed", organizationId, retentionDays, prunesFrom,
      previousDays: current.retentionDays,
    }, "archived history retention changed");
    return this.view(organizationId, true);
  }

  /** First pass ten minutes after startup, then hourly after each pass ends. */
  start(): void {
    this.schedule(ARCHIVED_HISTORY_RETENTION_STARTUP_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.nextRunAt = this.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextRunAt = null;
      void this.runPass().finally(() => this.schedule(ARCHIVED_HISTORY_RETENTION_INTERVAL_MS));
    }, delayMs);
    this.timer.unref?.();
  }

  /** Map legacy search rows, then visit organizations for retention. A running pass is shared. */
  runPass(): Promise<ArchivedHistoryPassResult> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<ArchivedHistoryPassResult> {
    const started = this.now();
    const result: ArchivedHistoryPassResult = { sessions: 0, events: 0, batches: 0, maxBatchMs: 0 };
    try {
      // Mapping also makes ordinary session deletion keyed, even when every retention policy is off.
      if (!await this.mapLegacySearchRows(result)) return result;
      for (const organizationId of this.db.listOrganizationIds()) {
        if (this.stopped) break;
        const armed = this.armed(this.policy(organizationId));
        const pruned = await this.pruneOrganization(organizationId, result);
        if (this.stopped) break;
        if (armed) this.db.recordArchivedHistoryRetentionRun(organizationId, this.now(), pruned.sessions, pruned.events);
        result.sessions += pruned.sessions;
        result.events += pruned.events;
        await this.trimRunnerHistories(organizationId);
      }
    } catch (error) {
      this.options.log.warn({ error: error instanceof Error ? error.message : String(error) },
        "archived history retention pass deferred");
    }
    if (result.batches > 0) {
      this.options.log.info({
        event: "archived_history_pruned", ...result, maxBatchMs: Math.round(result.maxBatchMs * 10) / 10,
        durationMs: this.now() - started,
      }, "archived history pruned");
    }
    return result;
  }

  private async trimRunnerHistories(organizationId: string): Promise<void> {
    const hub = this.options.hub;
    if (!hub) return;
    let afterId = "";
    while (!this.stopped) {
      const policy = this.policy(organizationId);
      if (!this.armed(policy)) return;
      const candidates = this.db.runnerHistoryTrimCandidates(organizationId,
        this.now() - policy.retentionDays * DAY_MS, afterId, CANDIDATES_PER_PAGE);
      if (!candidates.length) return;
      for (const candidate of candidates) {
        afterId = candidate.id;
        const currentPolicy = this.policy(organizationId);
        if (this.stopped || !this.armed(currentPolicy)) return;
        // Refresh eligibility after the preceding asynchronous request: policy relaxation,
        // unarchive, Stop and delayed hydration must all cancel a not-yet-issued trim.
        const fresh = this.db.runnerHistoryTrimCandidates(organizationId,
          this.now() - currentPolicy.retentionDays * DAY_MS, "", 1, candidate.id)[0];
        if (!fresh || !hub.isRunnerOnline(fresh.runnerId) ||
            !runnerSupportsProtocol(this.db.getRunner(fresh.runnerId)?.protocolVersion, "runnerHistoryRetention")) continue;
        const requestId = `trim_${randomUUID()}`;
        try {
          const result = await hub.requestFromRunner(fresh.runnerId, requestId, {
            type: "trim_session_history", requestId, sessionId: fresh.id,
            logEpoch: fresh.logEpoch, throughSeq: fresh.throughSeq,
          }, 15 * 60_000);
          if (result.type !== "trim_session_history_result" || !result.ok || !result.trimmed) {
            this.options.log.info({ event: "runner_history_retention_deferred", sessionId: fresh.id, requestId },
              "runner history trim deferred until a later pass");
          } else if ((result.bytesRemoved ?? 0) > 0) {
            this.options.log.info({ event: "runner_history_retention", sessionId: fresh.id, requestId,
              bytesRemoved: result.bytesRemoved, throughSeq: fresh.throughSeq }, "runner history trimmed");
          }
        } catch {
          this.options.log.warn({ event: "runner_history_retention_deferred", sessionId: fresh.id, requestId },
            "runner history trim unavailable; the next pass retries");
        }
      }
    }
  }

  private armed(policy: ArchivedHistoryRetentionPolicy): policy is ArchivedHistoryRetentionPolicy & { retentionDays: number } {
    return policy.retentionDays !== null && policy.prunesFrom !== null && this.now() >= policy.prunesFrom;
  }

  /** Search rows indexed before keyed rows existed must be mapped before any of them can be pruned. */
  private async mapLegacySearchRows(result: ArchivedHistoryPassResult): Promise<boolean> {
    while (!this.stopped && this.db.legacySearchRowsPending()) {
      const started = performance.now();
      this.db.mapLegacySearchRows(LEGACY_SEARCH_ROWS_PER_STEP);
      await this.pace(performance.now() - started, result);
    }
    return !this.stopped;
  }

  private async pruneOrganization(organizationId: string, result: ArchivedHistoryPassResult): Promise<{ sessions: number; events: number }> {
    const pruned = { sessions: 0, events: 0 };
    // Each session is visited once per pass, even if it stays a candidate (a failure, newer rows).
    const visited = new Set<string>();
    const visit = async (sessionId: string) => {
      visited.add(sessionId);
      try {
        const events = await this.pruneSession(organizationId, sessionId, result);
        if (events > 0) {
          pruned.sessions += 1;
          pruned.events += events;
        }
      } catch (error) {
        this.options.log.warn({ sessionId, error: error instanceof Error ? error.message : String(error) },
          "archived history prune deferred");
      }
    };
    // A run left open by a restart, or by a session unarchived or a policy turned off between
    // batches, continues if still eligible and otherwise closes over what it removed.
    for (const sessionId of this.db.archivedHistoryOpenPrunes(organizationId)) {
      if (this.stopped) break;
      await visit(sessionId);
    }
    while (!this.stopped) {
      const policy = this.policy(organizationId);
      if (!this.armed(policy)) break;
      const cutoff = this.now() - policy.retentionDays * DAY_MS;
      const candidates = this.db.archivedHistoryPruneCandidates(organizationId, cutoff, CANDIDATES_PER_PAGE + visited.size)
        .filter((sessionId) => !visited.has(sessionId));
      if (!candidates.length) break;
      for (const sessionId of candidates) {
        if (this.stopped) break;
        await visit(sessionId);
      }
    }
    return pruned;
  }

  /** Prune one session batch by batch. The policy is read again for every batch, so turning it off
   * or lengthening it stops a run at the next batch; the run then closes over what it removed. */
  private async pruneSession(organizationId: string, sessionId: string, result: ArchivedHistoryPassResult): Promise<number> {
    while (!this.stopped) {
      const policy = this.policy(organizationId);
      const now = this.now();
      const retentionDays = policy.retentionDays ?? 0;
      const started = performance.now();
      const batch = this.db.pruneArchivedHistoryBatch(sessionId, {
        cutoff: this.armed(policy) ? now - retentionDays * DAY_MS : Number.NEGATIVE_INFINITY,
        retentionDays,
        now,
        maxEvents: this.eventBudget,
        maxPayloadBytes: MAX_BATCH_PAYLOAD_BYTES,
        maxSearchLength: this.searchBudget,
      });
      const elapsed = performance.now() - started;
      result.batches += 1;
      result.maxBatchMs = Math.max(result.maxBatchMs, elapsed);
      if (batch.finished) return batch.prunedEvents;
      this.adapt(elapsed, batch);
      await this.pace(elapsed, result);
    }
    return 0;
  }

  /** Shrink both budgets in proportion after a slow batch. After a fast one, grow only the budget
   * that limited it, so a run of cheap batches cannot inflate the other one ahead of costly rows. */
  private adapt(elapsedMs: number, batch: { removed: number; searchLength: number }): void {
    if (elapsedMs > TARGET_BATCH_MS) {
      const scale = TARGET_BATCH_MS / elapsedMs;
      this.eventBudget = clamp(Math.floor(this.eventBudget * scale), EVENT_BUDGET);
      this.searchBudget = clamp(Math.floor(this.searchBudget * scale), SEARCH_BUDGET);
    } else if (elapsedMs < TARGET_BATCH_MS * 0.6) {
      if (batch.removed >= this.eventBudget) this.eventBudget = clamp(Math.ceil(this.eventBudget * 1.25), EVENT_BUDGET);
      if (batch.searchLength >= this.searchBudget * 0.75) {
        this.searchBudget = clamp(Math.ceil(this.searchBudget * 1.25), SEARCH_BUDGET);
      }
    }
  }

  private async pace(elapsedMs: number, result: ArchivedHistoryPassResult): Promise<void> {
    result.maxBatchMs = Math.max(result.maxBatchMs, elapsedMs);
    await this.sleep(Math.max(1, Math.ceil(elapsedMs * PACING_FACTOR)));
  }
}

/** When pruning may start under a policy of `retentionDays`: after the delay when it turns
 * retention on or shortens it, otherwise when the current policy already allowed it. */
function armedPrunesFrom(
  current: { retentionDays: number | null; prunesFrom: number | null },
  retentionDays: number,
  now: number,
): number {
  if (current.retentionDays === null || current.prunesFrom === null || retentionDays < current.retentionDays) {
    return Math.max(current.prunesFrom ?? 0, now + ARCHIVED_HISTORY_RETENTION_DELAY_MS);
  }
  return current.prunesFrom;
}

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}
