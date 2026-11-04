import { randomUUID } from "node:crypto";
import {
  WORKFLOW_EVENT_RETENTION_DELAY_MS, WORKFLOW_EVENT_RETENTION_LIMITS,
  type WorkflowEventRetentionView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { ArchivedHistoryRetentionLog } from "./archived-history-retention.js";
import { WorkflowEventRetentionStore, type WorkflowRetentionCursor } from "./workflow-event-retention-store.js";

export const WORKFLOW_EVENT_RETENTION_ENV = "CONTROL_PLANE_WORKFLOW_EVENT_RETENTION_DAYS";
export const WORKFLOW_EVENT_RETENTION_STARTUP_DELAY_MS = 10 * 60_000;
export const WORKFLOW_EVENT_RETENTION_INTERVAL_MS = 60 * 60_000;
export const WORKFLOW_EVENT_RETENTION_MAX_BATCH_EVENTS = 500;
const DAY = 24 * 60 * 60_000;
type Policy = { retentionDays: number | null; prunesFrom: number | null };
export interface WorkflowEventRetentionPassResult { instances: number; events: number; batches: number; maxBatchMs: number }

export function validWorkflowEventRetentionDays(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= WORKFLOW_EVENT_RETENTION_LIMITS.minDays && value <= WORKFLOW_EVENT_RETENTION_LIMITS.maxDays;
}
export function parseWorkflowEventRetentionEnvironment(value: string | undefined): { retentionDays: number | null; invalid: boolean } {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "" || trimmed === "0") return { retentionDays: null, invalid: false };
  const days = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  return validWorkflowEventRetentionDays(days) ? { retentionDays: days, invalid: false } : { retentionDays: null, invalid: true };
}
function prunesFrom(current: Policy, days: number, now: number): number {
  return current.retentionDays === null || current.prunesFrom === null || days < current.retentionDays
    ? Math.max(current.prunesFrom ?? 0, now + WORKFLOW_EVENT_RETENTION_DELAY_MS) : current.prunesFrom;
}

/** Separate opt-in policy: only terminal instances older than the completion-age threshold. */
export class WorkflowEventRetention {
  private readonly store: WorkflowEventRetentionStore;
  private readonly environment: Policy;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<WorkflowEventRetentionPassResult> | null = null;
  private stopped = false;
  private nextRunAt: number | null = null;
  private eventBudget = 100;
  constructor(private readonly db: ControlPlaneDb, private readonly options: {
    env?: NodeJS.ProcessEnv; log: ArchivedHistoryRetentionLog; now?: () => number; sleep?: (ms: number) => Promise<void>;
  }) {
    this.store = new WorkflowEventRetentionStore(db.raw(), (work) => db.workflowEventRetentionCommit(work));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const parsed = parseWorkflowEventRetentionEnvironment((options.env ?? process.env)[WORKFLOW_EVENT_RETENTION_ENV]);
    if (parsed.invalid) options.log.warn({ event: "workflow_event_retention_invalid", variable: WORKFLOW_EVENT_RETENTION_ENV },
      "workflow event retention environment value is invalid; it is treated as off");
    const previous = this.store.environment() ?? { retentionDays: null, prunesFrom: null };
    this.environment = { retentionDays: parsed.retentionDays,
      prunesFrom: parsed.retentionDays === null ? null : prunesFrom(previous, parsed.retentionDays, this.now()) };
    this.store.saveEnvironment(this.environment);
    options.log.info({ event: "workflow_event_retention", environmentDays: this.environment.retentionDays,
      prunesFrom: this.environment.prunesFrom }, "workflow event retention default loaded (null means off)");
  }
  policy(organizationId: string): Policy & { source: WorkflowEventRetentionView["source"] } {
    const saved = this.store.policy(organizationId);
    return saved ? { ...saved, source: "organization" }
      : { ...this.environment, source: this.environment.retentionDays === null ? "default" : "environment" };
  }
  view(organizationId: string, canManage: boolean, previewDays?: number): WorkflowEventRetentionView {
    const policy = this.policy(organizationId);
    const counts = (days: number) => this.store.counts(organizationId, this.now() - days * DAY);
    return { ...policy, environmentDays: this.environment.retentionDays, canManage, nextRunAt: this.nextRunAt,
      eligible: policy.retentionDays === null ? { instances: 0, events: 0 } : counts(policy.retentionDays),
      lastRun: this.store.lastRun(organizationId), limits: WORKFLOW_EVENT_RETENTION_LIMITS,
      ...(previewDays === undefined ? {} : { preview: { retentionDays: previewDays, eligible: counts(previewDays),
        prunesFrom: prunesFrom(policy, previewDays, this.now()) } }) };
  }
  update(organizationId: string, retentionDays: number | null, updatedBy: string | null): WorkflowEventRetentionView {
    if (retentionDays !== null && !validWorkflowEventRetentionDays(retentionDays)) throw new Error("invalid retention days");
    const previous = this.policy(organizationId);
    const next = { retentionDays, prunesFrom: retentionDays === null ? null : prunesFrom(previous, retentionDays, this.now()) };
    this.store.savePolicy(organizationId, next, updatedBy, this.now());
    this.options.log.info({ event: "workflow_event_retention_changed", organizationId, updatedBy,
      previousDays: previous.retentionDays, ...next }, "workflow event retention changed");
    return this.view(organizationId, true);
  }
  start(): void { this.schedule(WORKFLOW_EVENT_RETENTION_STARTUP_DELAY_MS); }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.nextRunAt = null;
  }
  private schedule(delay: number): void {
    if (this.stopped) return;
    this.nextRunAt = this.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null; this.nextRunAt = null;
      void this.runPass().finally(() => this.schedule(WORKFLOW_EVENT_RETENTION_INTERVAL_MS));
    }, delay);
    this.timer.unref?.();
  }
  runPass(): Promise<WorkflowEventRetentionPassResult> {
    this.running ??= this.pass().finally(() => { this.running = null; });
    return this.running;
  }
  private async pass(): Promise<WorkflowEventRetentionPassResult> {
    const passId = randomUUID();
    const started = this.now();
    const result = { instances: 0, events: 0, batches: 0, maxBatchMs: 0 };
    for (const organizationId of this.db.listOrganizationIds()) {
      if (this.stopped) break;
      let previousInstance: string | null = null;
      let cursor: WorkflowRetentionCursor | null = null;
      const counts = { instances: 0, events: 0 };
      let armed = false;
      try {
        while (!this.stopped) {
          const policy = this.policy(organizationId);
          if (policy.retentionDays === null || policy.prunesFrom === null || policy.prunesFrom > this.now()) break;
          armed = true;
          const batchStart = performance.now();
          const batch = this.store.pruneBatch(organizationId, this.now() - policy.retentionDays * DAY,
            policy.retentionDays, this.now(), this.eventBudget, cursor);
          if (batch.finished) break;
          cursor = batch.cursor;
          const elapsed = performance.now() - batchStart;
          if (batch.instanceId !== null) {
            if (batch.instanceId !== previousInstance) counts.instances++;
            previousInstance = batch.instanceId;
          }
          counts.events += batch.removed; result.batches++;
          result.maxBatchMs = Math.max(result.maxBatchMs, elapsed);
          // Aim for 4 ms; yield at least 3x the time spent on the event loop after every batch.
          if (elapsed > 4) this.eventBudget = Math.max(1, Math.floor(this.eventBudget * 4 / elapsed));
          else if (elapsed < 2.4) this.eventBudget = Math.min(WORKFLOW_EVENT_RETENTION_MAX_BATCH_EVENTS, Math.ceil(this.eventBudget * 1.25));
          await this.sleep(Math.max(1, Math.ceil(elapsed * 3)));
        }
        if (armed && !this.stopped) this.store.recordRun(organizationId, this.now(), counts);
      } catch (error) {
        this.options.log.warn({ event: "workflow_event_retention_deferred", passId, organizationId,
          error: error instanceof Error ? error.message : String(error) }, "workflow event retention pass deferred");
      }
      result.instances += counts.instances; result.events += counts.events;
    }
    this.options.log.info({ event: "workflow_events_pruned", passId, entryPoint: "retention_pass", ...result,
      durationMs: this.now() - started }, "workflow event retention pass finished");
    return result;
  }
}
