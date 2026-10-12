import type { DatabaseSync } from "node:sqlite";

// Install after the older column migrations. None of these indexes touches session_events:
// write savings on a periodic retained-history scan must not add work to streaming ingest.
const INDEXES = /* sql */ `
CREATE INDEX IF NOT EXISTS idx_workflow_attempts_deadline_active
  ON workflow_attempts(deadline_at, attempt_id)
  WHERE status IN ('dispatching','running','awaiting_output');
CREATE INDEX IF NOT EXISTS idx_session_stop_intents_pending
  ON session_stop_intents(last_attempt_at, session_id)
  WHERE archive_after_stop=1 AND failed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_session_command_invocations_expiry
  ON session_command_invocations(state, expires_at, session_id);
CREATE INDEX IF NOT EXISTS idx_session_prompt_commands_expiry
  ON session_prompt_commands(expires_at, created_at)
  WHERE state IN ('pending','sent','accepted','queued','started');
CREATE INDEX IF NOT EXISTS idx_session_prompt_commands_retention
  ON session_prompt_commands(expires_at, created_at)
  WHERE state IN ('completed','failed','uncertain');
CREATE INDEX IF NOT EXISTS idx_outbound_event_deliveries_lease
  ON outbound_event_deliveries(lease_expires_at) WHERE status='delivering';
CREATE INDEX IF NOT EXISTS idx_outbound_event_deliveries_retention
  ON outbound_event_deliveries(updated_at) WHERE status IN ('delivered','failed','dropped');
CREATE INDEX IF NOT EXISTS idx_outbound_event_deliveries_retry
  ON outbound_event_deliveries(next_attempt_at, created_at, delivery_id)
  WHERE status IN ('pending','retrying') AND payload_json IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_managed_background_jobs_held_results
  ON managed_background_jobs(terminal_observed_at, session_id)
  WHERE source_present=1 AND continuation_required=1 AND continuation_id IS NULL AND terminal_observed_at IS NOT NULL;
`;

const ORPHANS = /* sql */ `
CREATE TABLE IF NOT EXISTS outbound_event_orphans (
  event_id TEXT PRIMARY KEY REFERENCES outbound_events(event_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE TRIGGER IF NOT EXISTS outbound_events_orphan_insert
AFTER INSERT ON outbound_events BEGIN
  INSERT OR IGNORE INTO outbound_event_orphans(event_id) VALUES(NEW.event_id);
END;
CREATE TRIGGER IF NOT EXISTS outbound_deliveries_orphan_insert
AFTER INSERT ON outbound_event_deliveries BEGIN
  DELETE FROM outbound_event_orphans WHERE event_id=NEW.event_id;
END;
CREATE TRIGGER IF NOT EXISTS outbound_deliveries_orphan_delete
AFTER DELETE ON outbound_event_deliveries BEGIN
  INSERT OR IGNORE INTO outbound_event_orphans(event_id)
    SELECT event_id FROM outbound_events WHERE event_id=OLD.event_id
      AND NOT EXISTS (SELECT 1 FROM outbound_event_deliveries WHERE event_id=OLD.event_id);
END;
CREATE TRIGGER IF NOT EXISTS outbound_deliveries_orphan_update
AFTER UPDATE OF event_id ON outbound_event_deliveries WHEN OLD.event_id!=NEW.event_id BEGIN
  DELETE FROM outbound_event_orphans WHERE event_id=NEW.event_id;
  INSERT OR IGNORE INTO outbound_event_orphans(event_id)
    SELECT event_id FROM outbound_events WHERE event_id=OLD.event_id
      AND NOT EXISTS (SELECT 1 FROM outbound_event_deliveries WHERE event_id=OLD.event_id);
END;
`;

/** One atomic upgrade: old events are inspected once, and all later changes maintain the set.
 * The event-existence check in delete/update triggers also covers parent/session cascades: a
 * delivery deleted because its event disappeared must not resurrect a foreign-key reference.
 */
export function installMaintenanceIndexes(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const installed = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbound_event_orphans'",
    ).get();
    db.exec(INDEXES);
    db.exec(ORPHANS);
    if (!installed) {
      db.exec(`INSERT INTO outbound_event_orphans(event_id)
        SELECT event_id FROM outbound_events WHERE NOT EXISTS (
          SELECT 1 FROM outbound_event_deliveries delivery WHERE delivery.event_id=outbound_events.event_id
        )`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
