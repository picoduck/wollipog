import type { DatabaseSync } from "node:sqlite";
import type { WorkflowEventRetentionCounts, WorkflowEventRetentionView } from "@wollipog/protocol";
import { WORKFLOW_EVENT_RETENTION_LIMITS } from "@wollipog/protocol";

export const WORKFLOW_EVENT_RETENTION_SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS workflow_event_retention_policy (
  organization_id TEXT PRIMARY KEY REFERENCES identity_organizations(organization_id) ON DELETE CASCADE,
  retention_days INTEGER, prunes_from INTEGER, updated_at INTEGER NOT NULL, updated_by TEXT
);
CREATE TABLE IF NOT EXISTS workflow_event_retention_runs (
  organization_id TEXT PRIMARY KEY REFERENCES identity_organizations(organization_id) ON DELETE CASCADE,
  finished_at INTEGER NOT NULL, instances INTEGER NOT NULL, events INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_event_prunes (
  instance_id TEXT PRIMARY KEY REFERENCES workflow_instances(instance_id) ON DELETE CASCADE,
  pruned_at INTEGER NOT NULL, event_count INTEGER NOT NULL, retention_days INTEGER NOT NULL,
  through_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_retention ON workflow_instances(completed_at, instance_id)
  WHERE status IN ('succeeded','failed','stopped') AND completed_at IS NOT NULL;
`;
type Policy = { retentionDays: number | null; prunesFrom: number | null };
export type WorkflowRetentionCursor = { completedAt: number; instanceId: string };
// Prefer the workspace's organization, falling back to the runner. Unknown ownership is kept.
const ELIGIBLE = `FROM workflow_instances i JOIN multi_agent_runs r ON r.id=i.run_id
  LEFT JOIN workspace_ownership w ON w.runner_id=r.runner_id AND w.workspace_id=r.workspace_id
  LEFT JOIN runner_ownership o ON o.runner_id=r.runner_id
  WHERE i.status IN ('succeeded','failed','stopped') AND i.completed_at IS NOT NULL
    AND i.completed_at<? AND COALESCE(w.organization_id,o.organization_id)=?
    AND EXISTS (SELECT 1 FROM workflow_events e WHERE e.instance_id=i.instance_id)`;

/** Only workflow_events are deleted. Summaries, nodes, attempts, artifacts and authority stay put. */
export class WorkflowEventRetentionStore {
  constructor(private readonly db: DatabaseSync, private readonly commit: <T>(work: () => T) => T = (work) => work()) {}
  policy(organizationId: string): Policy | null {
    const row = this.db.prepare("SELECT retention_days,prunes_from FROM workflow_event_retention_policy WHERE organization_id=?")
      .get(organizationId) as { retention_days: number | null; prunes_from: number | null } | undefined;
    return row ? { retentionDays: row.retention_days, prunesFrom: row.prunes_from } : null;
  }
  savePolicy(organizationId: string, policy: Policy, updatedBy: string | null, now: number): void {
    this.db.prepare(`INSERT INTO workflow_event_retention_policy VALUES (?,?,?,?,?)
      ON CONFLICT(organization_id) DO UPDATE SET retention_days=excluded.retention_days,
      prunes_from=excluded.prunes_from,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run(organizationId, policy.retentionDays, policy.prunesFrom, now, updatedBy);
  }
  environment(): Policy | null {
    const row = this.db.prepare("SELECT value FROM control_plane_metadata WHERE key='workflow_event_environment_policy'")
      .get() as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (!parsed || typeof parsed !== "object") return null;
      const { retentionDays, prunesFrom } = parsed as Partial<Policy>;
      if (retentionDays === null && prunesFrom === null) return { retentionDays: null, prunesFrom: null };
      return typeof retentionDays === "number" && Number.isSafeInteger(retentionDays) &&
        retentionDays >= WORKFLOW_EVENT_RETENTION_LIMITS.minDays && retentionDays <= WORKFLOW_EVENT_RETENTION_LIMITS.maxDays &&
        typeof prunesFrom === "number" && Number.isSafeInteger(prunesFrom) && prunesFrom >= 0
        ? { retentionDays, prunesFrom } : null;
    } catch { return null; }
  }
  saveEnvironment(policy: Policy): void {
    this.db.prepare("INSERT OR REPLACE INTO control_plane_metadata(key,value) VALUES('workflow_event_environment_policy',?)")
      .run(JSON.stringify(policy));
  }
  counts(organizationId: string, cutoff: number): WorkflowEventRetentionCounts {
    const row = this.db.prepare(`SELECT COUNT(*) AS instances, COALESCE(SUM((SELECT COUNT(*) FROM workflow_events e
      WHERE e.instance_id=i.instance_id)),0) AS events ${ELIGIBLE}`).get(cutoff, organizationId) as unknown as WorkflowEventRetentionCounts;
    return { instances: row.instances, events: row.events };
  }
  lastRun(organizationId: string): WorkflowEventRetentionView["lastRun"] {
    const row = this.db.prepare("SELECT finished_at,instances,events FROM workflow_event_retention_runs WHERE organization_id=?")
      .get(organizationId) as { finished_at: number; instances: number; events: number } | undefined;
    return row ? { finishedAt: row.finished_at, instances: row.instances, events: row.events } : null;
  }
  recordRun(organizationId: string, now: number, counts: WorkflowEventRetentionCounts): void {
    this.db.prepare("INSERT OR REPLACE INTO workflow_event_retention_runs VALUES(?,?,?,?)")
      .run(organizationId, now, counts.instances, counts.events);
  }
  /** One bounded transaction. Re-select eligibility for every batch; no payload enters JS. A single
   * oversized row is indivisible, but subsequent rows respect the 2 MiB ceiling. The marker,
   * sequence high-water and deletions commit atomically, including in relaxed WAL batches. */
  pruneBatch(organizationId: string, cutoff: number, retentionDays: number, now: number, maxEvents: number,
    cursor: WorkflowRetentionCursor | null = null, maxBytes = 2 * 1024 * 1024): {
      instanceId: string | null; removed: number; bytes: number; cursor: WorkflowRetentionCursor | null; finished: boolean;
    } {
    return this.commit(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // A backlog of already-pruned, foreign or unowned instances also needs bounded reads.
        // Materialize at most fifty indexed terminal summaries before checking scope/event presence.
        const page = this.db.prepare(`WITH page AS MATERIALIZED (
          SELECT instance_id,completed_at,run_id FROM workflow_instances
          WHERE status IN ('succeeded','failed','stopped') AND completed_at IS NOT NULL AND completed_at<?
            ${cursor ? "AND (completed_at,instance_id)>(?,?)" : ""}
          ORDER BY completed_at,instance_id LIMIT 50
        ) SELECT p.instance_id,p.completed_at,COALESCE(w.organization_id,o.organization_id) AS organization_id,
            EXISTS(SELECT 1 FROM workflow_events e WHERE e.instance_id=p.instance_id) AS has_events
          FROM page p JOIN multi_agent_runs r ON r.id=p.run_id
          LEFT JOIN workspace_ownership w ON w.runner_id=r.runner_id AND w.workspace_id=r.workspace_id
          LEFT JOIN runner_ownership o ON o.runner_id=r.runner_id ORDER BY p.completed_at,p.instance_id`)
          .all(...(cursor ? [cutoff, cursor.completedAt, cursor.instanceId] : [cutoff])) as unknown as Array<{
            instance_id: string; completed_at: number; organization_id: string | null; has_events: number;
          }>;
        const candidate = page.find((row) => row.organization_id === organizationId && row.has_events);
        if (!candidate) {
          const last = page.at(-1);
          this.db.exec("COMMIT");
          return { instanceId: null, removed: 0, bytes: 0, finished: page.length < 50,
            cursor: last ? { completedAt: last.completed_at, instanceId: last.instance_id } : cursor };
        }
        const rows = this.db.prepare(`SELECT seq,COALESCE(length(CAST(detail AS BLOB)),0) AS bytes
          FROM workflow_events WHERE instance_id=? ORDER BY seq LIMIT ?`)
          .all(candidate.instance_id, maxEvents) as unknown as Array<{ seq: number; bytes: number }>;
        let bytes = 0;
        const selected = [];
        for (const row of rows) {
          if (selected.length && bytes + row.bytes > maxBytes) break;
          selected.push(row); bytes += row.bytes;
        }
        const last = selected.at(-1)!;
        this.db.prepare(`DELETE FROM workflow_events WHERE instance_id=? AND seq<=?`)
          .run(candidate.instance_id, last.seq);
        this.db.prepare(`INSERT INTO workflow_event_prunes VALUES(?,?,?,?,?)
          ON CONFLICT(instance_id) DO UPDATE SET pruned_at=excluded.pruned_at,
          event_count=event_count+excluded.event_count,retention_days=excluded.retention_days,
          through_seq=MAX(through_seq,excluded.through_seq)`)
          .run(candidate.instance_id, now, selected.length, retentionDays, last.seq);
        const remaining = this.db.prepare("SELECT 1 FROM workflow_events WHERE instance_id=? LIMIT 1").get(candidate.instance_id);
        this.db.exec("COMMIT");
        return { instanceId: candidate.instance_id, removed: selected.length, bytes, finished: false,
          cursor: remaining ? cursor : { completedAt: candidate.completed_at, instanceId: candidate.instance_id } };
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    });
  }
}
