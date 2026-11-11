import type { DatabaseSync } from "node:sqlite";
import type { HumanPrincipal } from "./identity.js";

/** Receipt reconciliation may prove the former ownership without exposing removed content. */
export function canReconcileSkillRemoval(db: DatabaseSync, owner: HumanPrincipal, skillId: string): boolean {
  if (owner.role !== "owner" || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_removal_history'").get()) return false;
  const row = db.prepare("SELECT json_extract(snapshot_json, '$.ownership[0].organization_id') AS organization FROM skill_removal_history WHERE skill_id=?").get(skillId) as {organization: string} | undefined;
  return row?.organization === owner.organizationId;
}

/** Removal changes the desired library, not the historical evidence. Called inside deleteSkill's
 * transaction so a failed deletion cannot leave a spurious historical removal. No tool exposes
 * these raw snapshots; normal live-resource access does not grant access to deleted content. */
export function preserveSkillRemoval(db: DatabaseSync, skillId: string, now: number): void {
  const skill = db.prepare("SELECT * FROM skills WHERE id=?").get(skillId);
  if (!skill) return;
  const snapshot = {
    skill,
    ownership: db.prepare("SELECT * FROM skill_ownership WHERE skill_id=?").all(skillId),
  };
  db.exec("CREATE TABLE IF NOT EXISTS skill_removal_history (skill_id TEXT PRIMARY KEY, removed_at INTEGER NOT NULL, snapshot_json TEXT NOT NULL)");
  db.exec(`CREATE TABLE IF NOT EXISTS skill_removed_records (
    skill_id TEXT NOT NULL, source_table TEXT NOT NULL, record_id TEXT NOT NULL, record_json TEXT NOT NULL,
    PRIMARY KEY(skill_id, source_table, record_id));`);
  // Copy history in SQLite, one row per record. Loading every immutable version into a JavaScript
  // array would make removing a long-lived skill require unbounded memory or one enormous JSON row.
  for (const [table, where] of [
    ["skill_versions", "skill_id=?"], ["skill_assignments", "skill_id=?"], ["skill_machine_versions", "skill_id=?"],
    ["skill_group_assignments", "group_id IN (SELECT group_id FROM skills WHERE id=?)"],
    ["skill_machine_provenance", "version_id IN (SELECT id FROM skill_versions WHERE skill_id=?)"],
    ["skill_git_provenance", "version_id IN (SELECT id FROM skill_versions WHERE skill_id=?)"],
    ["skill_built_in_provenance", "version_id IN (SELECT id FROM skill_versions WHERE skill_id=?)"],
  ] as const) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>;
    // Identifiers come from the application schema, never user input.
    const fields = columns.map(({name}) => `'${name.replaceAll("'", "''")}',"${name.replaceAll('"', '""')}"`).join(",");
    db.prepare(`INSERT INTO skill_removed_records SELECT ?,?,CAST(rowid AS TEXT),json_object(${fields}) FROM ${table} WHERE ${where}`)
      .run(skillId, table, skillId);
  }
  db.prepare("INSERT INTO skill_removal_history VALUES (?,?,?)").run(skillId, now, JSON.stringify(snapshot));
}
