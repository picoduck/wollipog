import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CAMPAIGN_RECOVERY_EXPLANATIONS, CAMPAIGN_RECOVERY_LIMITS,
  type CampaignRecoveryAction, type CampaignRecoveryInput, type CampaignRecoveryProjection,
  type CampaignRecoveryReason, type CampaignRecoveryRecord, type CampaignRecoveryResource } from "@wollipog/protocol";

export const CAMPAIGN_RECOVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS campaign_recovery (
  id TEXT PRIMARY KEY,
  campaign_session_id TEXT NOT NULL,
  signal TEXT NOT NULL,
  record_json TEXT NOT NULL,
  FOREIGN KEY (campaign_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_campaign_recovery_root ON campaign_recovery(campaign_session_id);
`;

/** Derived by server adapters from authoritative state, not accepted from agent JSON. */
export interface CampaignRecoveryObservation {
  action: CampaignRecoveryAction;
  resource: CampaignRecoveryResource;
  reason: CampaignRecoveryReason;
  owner: "human" | "orchestrator";
  signal: string;
  /** Evidence of a completed repair/reconciliation. Absence from a partial scan is not resolution. */
  resolved?: boolean;
}
interface Row { id: string; signal: string; record_json: string }
const inputFor: Partial<Record<CampaignRecoveryReason, CampaignRecoveryInput>> = {
  missing_human_information: "answer_existing_request", missing_access: "restore_existing_access",
  boundary_enlargement: "authorize_exact_boundary_change", human_required_rule: "perform_human_required_action",
  unsupported_capability: "use_supported_capability", uncertain_outcome: "reconcile_original_outcome",
};
const terminal = new Set(["resolved", "cancelled"]);
const hard = new Set<CampaignRecoveryReason>(["hard_denial", "attempts_exhausted"]);
const human = new Set<CampaignRecoveryReason>(["missing_human_information", "missing_access",
  "boundary_enlargement", "human_required_rule", "unsupported_capability"]);

function identity(campaignId: string, resource: CampaignRecoveryResource, action: CampaignRecoveryAction): string {
  const coordinate = resource.kind === "worker" && resource.workItemId
    ? { kind: "worker", workItemId: resource.workItemId } : resource;
  return `recovery_${createHash("sha256").update(JSON.stringify([campaignId, coordinate, action])).digest("hex")}`;
}

/** Durable single-flight admission of recovery *instructions*. Dispatch never executes the
 * underlying effect; all existing typed gates and provider admission still apply at execution. */
export class CampaignRecoveryStore {
  constructor(private readonly db: DatabaseSync, private readonly atomic: <T>(work: () => T) => T) {}

  campaignIds(): string[] {
    return (this.db.prepare("SELECT DISTINCT campaign_session_id AS id FROM campaign_recovery")
      .all() as Array<{ id: string }>).map(row => row.id);
  }

  activeObservations(campaignId: string): CampaignRecoveryObservation[] {
    return this.rows(campaignId).flatMap(row => {
      const record = JSON.parse(row.record_json) as CampaignRecoveryRecord;
      return terminal.has(record.state) ? [] : [{ action: record.action, resource: record.resource,
        reason: record.reason, owner: record.effectiveOwner, signal: row.signal }];
    });
  }

  requestRecord(campaignId: string, sessionId: string, occurrenceId: string): CampaignRecoveryRecord | undefined {
    return this.rows(campaignId).map(row => JSON.parse(row.record_json) as CampaignRecoveryRecord)
      .find(record => record.resource.kind === "request" && record.resource.sessionId === sessionId &&
        record.resource.occurrenceId === `sha256:${createHash("sha256").update(occurrenceId).digest("hex")}` && !terminal.has(record.state));
  }

  private rows(campaignId: string): Row[] {
    return this.db.prepare("SELECT id,signal,record_json FROM campaign_recovery WHERE campaign_session_id=? ORDER BY id")
      .all(campaignId) as unknown as Row[];
  }
  private save(campaignId: string, signal: string, record: CampaignRecoveryRecord): void {
    this.db.prepare(`INSERT INTO campaign_recovery(id,campaign_session_id,signal,record_json) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET signal=excluded.signal,record_json=excluded.record_json`)
      .run(record.id, campaignId, signal, JSON.stringify(record));
  }

  /** Complete authoritative scan. Repetition is read-only, including notification/admission ids.
   * Policy revocation cancels old work rather than rebinding it to fresh authority. */
  synchronize(campaignId: string, policyRevision: number, authorized: boolean,
    observations: readonly CampaignRecoveryObservation[], now: number): boolean {
    return this.atomic(() => {
      const previous = new Map(this.rows(campaignId).map((row) => [row.id, row]));
      const observed = new Set<string>();
      let changed = false;
      for (const observation of observations) {
        const id = identity(campaignId, observation.resource, observation.action);
        observed.add(id);
        const row = previous.get(id);
        const old = row ? JSON.parse(row.record_json) as CampaignRecoveryRecord : undefined;
        if (old && old.state === "cancelled") continue;
        if (old && hard.has(old.reason) && !observation.resolved && authorized && old.policyRevision === policyRevision) continue;
        if (old && row!.signal === observation.signal && old.policyRevision === policyRevision && authorized &&
            old.effectiveOwner === observation.owner && old.reason === observation.reason &&
            (observation.resolved ? old.state === "resolved" : !terminal.has(old.state))) continue;
        const attempts = old?.attempts ?? 0;
        const reason = attempts >= CAMPAIGN_RECOVERY_LIMITS.maxAttempts && !observation.resolved
          ? "attempts_exhausted" : observation.reason;
        const cancelled = !authorized || (old !== undefined && old.policyRevision !== policyRevision);
        const state = cancelled ? "cancelled" : observation.resolved ? "resolved" : hard.has(reason) ? "blocked"
          : observation.owner === "human" || human.has(reason) ? "waiting_human"
          : reason === "transient_failure" ? "backoff" : "ready";
        const next: CampaignRecoveryRecord = {
          id, action: observation.action, resource: structuredClone(observation.resource), reason, state,
          effectiveOwner: observation.owner, policyRevision: old?.policyRevision ?? policyRevision,
          attempts, maxAttempts: CAMPAIGN_RECOVERY_LIMITS.maxAttempts,
          attemptedRecovery: old?.attemptedRecovery ?? [], requiredInput: inputFor[reason] ?? "none",
          explanation: CAMPAIGN_RECOVERY_EXPLANATIONS[reason], createdAt: old?.createdAt ?? now, updatedAt: now,
          ...(state === "backoff" ? { nextAttemptAt: now + Math.min(CAMPAIGN_RECOVERY_LIMITS.maxBackoffMs,
            CAMPAIGN_RECOVERY_LIMITS.baseBackoffMs * 2 ** attempts) } : {}),
        };
        this.save(campaignId, observation.signal, next); changed = true;
      }
      for (const row of previous.values()) {
        const record = JSON.parse(row.record_json) as CampaignRecoveryRecord;
        if (terminal.has(record.state) || observed.has(row.id)) continue;
        this.save(campaignId, row.signal, { ...record,
          state: authorized && record.policyRevision === policyRevision ? "resolved" : "cancelled", updatedAt: now });
        changed = true;
      }
      return changed;
    });
  }

  /** Event creation and reservation share one transaction. A crash cannot lose a wake or admit
   * a second wake for the same observation. Current authority and lifecycle are checked by caller. */
  dispatchDue(campaignId: string, policyRevision: number, now: number,
    wake: (record: CampaignRecoveryRecord, eventId: string) => void): number {
    return this.atomic(() => {
      let dispatched = 0;
      for (const row of this.rows(campaignId)) {
        const record = JSON.parse(row.record_json) as CampaignRecoveryRecord;
        if (dispatched >= CAMPAIGN_RECOVERY_LIMITS.dispatchPerPass) break;
        if (record.policyRevision !== policyRevision || record.effectiveOwner !== "orchestrator" ||
            !["ready", "backoff"].includes(record.state) || (record.nextAttemptAt ?? 0) > now) continue;
        const next: CampaignRecoveryRecord = { ...record, state: "dispatched", attempts: record.attempts + 1,
          attemptedRecovery: [...record.attemptedRecovery, record.action], updatedAt: now };
        delete next.nextAttemptAt;
        wake(next, `${record.id}:${next.attempts}`);
        this.save(campaignId, row.signal, next); dispatched += 1;
      }
      return dispatched;
    });
  }

  projection(campaignId: string): CampaignRecoveryProjection {
    const records = this.rows(campaignId).map(row => JSON.parse(row.record_json) as CampaignRecoveryRecord)
      .filter(record => !terminal.has(record.state));
    const waitingHuman = records.filter(record => record.state === "waiting_human").length;
    const blocked = records.filter(record => record.state === "blocked").length;
    return { unattendedReady: waitingHuman === 0 && blocked === 0,
      automatic: records.length - waitingHuman - blocked, waitingHuman, blocked,
      records: records.slice(0, CAMPAIGN_RECOVERY_LIMITS.visibleRecords),
      truncated: records.length > CAMPAIGN_RECOVERY_LIMITS.visibleRecords };
  }
}
