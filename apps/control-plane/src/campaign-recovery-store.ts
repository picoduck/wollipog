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
CREATE INDEX IF NOT EXISTS idx_campaign_recovery_active ON campaign_recovery(campaign_session_id)
  WHERE json_extract(record_json,'$.state') NOT IN ('resolved','cancelled');
CREATE TABLE IF NOT EXISTS campaign_recovery_denial_settlements (
  campaign_session_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  subject_session_id TEXT NOT NULL,
  report_json TEXT NOT NULL,
  PRIMARY KEY (campaign_session_id, occurrence_id),
  FOREIGN KEY (campaign_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
`;

/** Server-verified exact terminal-report accounting, never a quality or media receipt. */
export interface CampaignRecoveryVerifiedReport {
  seq: number;
  eventEpoch: number;
  digest: string;
  ts: number;
  verifiedAt: number;
}

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

/** How long a delivered, completed wake may stay unanswered (same signal, quiet campaign) before
 * the same record is woken again: 2, 4, 8 then 16 minutes, capped at 30. The attempt ceiling
 * still bounds the total; a stalled record past it is exhausted, never silently automatic. */
export const STALLED_RECOVERY_WAKE_BASE_MS = 120_000;
export const STALLED_RECOVERY_WAKE_MAX_MS = 1_800_000;
export const stalledRecoveryWakeDelayMs = (attempts: number) =>
  Math.min(STALLED_RECOVERY_WAKE_MAX_MS, STALLED_RECOVERY_WAKE_BASE_MS * 2 ** Math.max(0, attempts - 1));

function identity(campaignId: string, resource: CampaignRecoveryResource, action: CampaignRecoveryAction): string {
  const coordinate = resource.kind === "worker" && resource.workItemId
    ? { kind: "worker", workItemId: resource.workItemId }
    : (resource.kind === "pull_request" || resource.kind === "review_job") && ["repair_checks", "rereview"].includes(action)
      ? { kind: "pull_request", repository: resource.repository?.toLowerCase(), pullRequest: resource.pullRequest }
      : resource;
  return `recovery_${createHash("sha256").update(JSON.stringify([campaignId, coordinate, action])).digest("hex")}`;
}

/** Durable single-flight admission of recovery *instructions*. Dispatch never executes the
 * underlying effect; all existing typed gates and provider admission still apply at execution. */
export class CampaignRecoveryStore {
  constructor(private readonly db: DatabaseSync, private readonly atomic: <T>(work: () => T) => T) {}

  /** Retire only this denied occurrence after authoritative report verification. Reusing the
   * session cannot resurrect it or clear a newer denial. No permission/status is changed. */
  retireDeniedOccurrence(campaignId: string, sessionId: string, occurrenceId: string,
    report: CampaignRecoveryVerifiedReport): void {
    this.db.prepare(`INSERT OR IGNORE INTO campaign_recovery_denial_settlements
      (campaign_session_id,occurrence_id,subject_session_id,report_json) VALUES (?,?,?,?)`)
      .run(campaignId, occurrenceId, sessionId, JSON.stringify(report));
  }

  campaignIds(): string[] {
    return (this.db.prepare(`SELECT DISTINCT campaign_session_id AS id FROM campaign_recovery
      WHERE json_extract(record_json,'$.state') NOT IN ('resolved','cancelled')`)
      .all() as Array<{ id: string }>).map(row => row.id);
  }

  activeObservations(campaignId: string): CampaignRecoveryObservation[] {
    return this.rows(campaignId).flatMap(row => {
      const record = JSON.parse(row.record_json) as CampaignRecoveryRecord;
      return terminal.has(record.state) ? [] : [{ action: record.action, resource: record.resource,
        reason: record.reason, owner: record.effectiveOwner, signal: row.signal }];
    });
  }

  activeRecords(campaignId: string): CampaignRecoveryRecord[] {
    return this.rows(campaignId).map(row => JSON.parse(row.record_json) as CampaignRecoveryRecord);
  }

  requestRecord(campaignId: string, sessionId: string, occurrenceId: string): CampaignRecoveryRecord | undefined {
    return this.rows(campaignId).map(row => JSON.parse(row.record_json) as CampaignRecoveryRecord)
      .find(record => record.resource.kind === "request" && record.resource.sessionId === sessionId &&
        record.resource.occurrenceId === `sha256:${createHash("sha256").update(occurrenceId).digest("hex")}` && !terminal.has(record.state));
  }

  /** Exact server-created wake, including its attempt. Never interpret a recovery ID as a
   * workflow decision or let a stale/cross-campaign event describe another reservation. */
  eventRecord(campaignId: string, sessionId: string | undefined, recoveryId: string | undefined,
    eventId: string): CampaignRecoveryRecord | undefined {
    if (!recoveryId) return undefined;
    const row = this.db.prepare("SELECT record_json FROM campaign_recovery WHERE campaign_session_id=? AND id=?")
      .get(campaignId, recoveryId) as { record_json: string } | undefined;
    const record = row ? JSON.parse(row.record_json) as CampaignRecoveryRecord : undefined;
    return record && record.resource.sessionId === sessionId && eventId === `${record.id}:${record.attempts}`
      ? record : undefined;
  }

  private rows(campaignId: string): Row[] {
    return this.db.prepare(`SELECT id,signal,record_json FROM campaign_recovery WHERE campaign_session_id=?
      AND json_extract(record_json,'$.state') NOT IN ('resolved','cancelled') ORDER BY id`)
      .all(campaignId) as unknown as Row[];
  }
  private save(campaignId: string, signal: string, record: CampaignRecoveryRecord): void {
    this.db.prepare(`INSERT INTO campaign_recovery(id,campaign_session_id,signal,record_json) VALUES(?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET signal=excluded.signal,record_json=excluded.record_json`)
      .run(record.id, campaignId, signal, JSON.stringify(record));
  }

  /** Complete authoritative scan. Repetition is read-only, including notification/admission ids.
   * Policy revocation cancels old work rather than rebinding it to fresh authority.
   * `settledWakeAt` reports when the turn delivering a dispatched record's current wake completed,
   * only while the campaign is quiet; a record still unanswered after its delay is woken again. */
  synchronize(campaignId: string, policyRevision: number, authorized: boolean,
    observations: readonly CampaignRecoveryObservation[], now: number,
    settledWakeAt?: (record: CampaignRecoveryRecord) => number | undefined): boolean {
    return this.atomic(() => {
      const previous = new Map(this.rows(campaignId).map((row) => [row.id, row]));
      const observed = new Set<string>();
      let changed = false;
      for (const observation of observations) {
        const id = identity(campaignId, observation.resource, observation.action);
        observed.add(id);
        const row = previous.get(id) ?? this.db.prepare("SELECT id,signal,record_json FROM campaign_recovery WHERE id=?")
          .get(id) as Row | undefined;
        const old = row ? JSON.parse(row.record_json) as CampaignRecoveryRecord : undefined;
        const attempts = old?.attempts ?? 0;
        const changedResource = old !== undefined && JSON.stringify(old.resource) !== JSON.stringify(observation.resource);
        const freshOccurrence = old !== undefined && (old.resource.occurrenceId !== observation.resource.occurrenceId ||
          old.resource.sessionId !== observation.resource.sessionId);
        const dispatchFenced = (!authorized || old?.dispatchFenced === true || old?.state === "cancelled" ||
          old !== undefined && old.policyRevision !== policyRevision) && !(authorized && freshOccurrence);
        const currentDispatch = old?.state === "dispatched" && row?.signal === observation.signal && !changedResource;
        // A wake the Orchestrator received and finished without changing anything is no longer in
        // flight. The same record (same occurrence) is woken again, or exhausted past its ceiling.
        const settledAt = currentDispatch && authorized && !observation.resolved ? settledWakeAt?.(old!) : undefined;
        const stalled = settledAt !== undefined && now >= settledAt + stalledRecoveryWakeDelayMs(attempts);
        let reason = attempts >= CAMPAIGN_RECOVERY_LIMITS.maxAttempts && !observation.resolved && (!currentDispatch || stalled)
          ? "attempts_exhausted" : old && hard.has(old.reason) && !terminal.has(old.state) && !observation.resolved
            ? old.reason : observation.reason;
        const state = observation.resolved ? "resolved" : !authorized && observation.owner !== "human"
          ? reason === "uncertain_outcome" ? "blocked" : "cancelled" : hard.has(reason) ? "blocked"
          : observation.owner === "human" || human.has(reason) ? "waiting_human"
          : dispatchFenced ? "blocked"
          : reason === "transient_failure" ? "backoff" : "ready";
        if (state === "blocked" && dispatchFenced && !hard.has(reason) && reason !== "uncertain_outcome") reason = "authority_changed";
        if (old && !stalled && row!.signal === observation.signal && !changedResource && old.policyRevision === policyRevision &&
            old.effectiveOwner === observation.owner && old.reason === reason && Boolean(old.dispatchFenced) === dispatchFenced &&
            (observation.resolved ? old.state === "resolved" : !terminal.has(old.state) || state === old.state)) continue;
        const next: CampaignRecoveryRecord = {
          id, action: observation.action, resource: structuredClone(observation.resource), reason, state,
          effectiveOwner: observation.owner, policyRevision, ...(dispatchFenced ? { dispatchFenced: true } : {}),
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
          state: authorized && record.policyRevision === policyRevision ? "resolved" : "cancelled",
          ...(!authorized || record.policyRevision !== policyRevision ? { dispatchFenced: true } : {}), updatedAt: now });
        changed = true;
      }
      return changed;
    });
  }

  /** Event creation and reservation share one transaction. A crash cannot lose a wake or admit
   * a second wake for the same observation. Current authority and lifecycle are checked by caller. */
  dispatchDue(campaignId: string, policyRevision: number, now: number,
    wake: (record: CampaignRecoveryRecord, eventId: string) => void,
    eligible: (record: CampaignRecoveryRecord) => boolean = () => true): number {
    return this.atomic(() => {
      let dispatched = 0;
      for (const row of this.rows(campaignId)) {
        const record = JSON.parse(row.record_json) as CampaignRecoveryRecord;
        if (dispatched >= CAMPAIGN_RECOVERY_LIMITS.dispatchPerPass) break;
        if (record.dispatchFenced || record.policyRevision !== policyRevision || record.effectiveOwner !== "orchestrator" ||
            !["ready", "backoff"].includes(record.state) || (record.nextAttemptAt ?? 0) > now || !eligible(record)) continue;
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
