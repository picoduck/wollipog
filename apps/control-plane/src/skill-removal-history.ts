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
    versions: db.prepare("SELECT * FROM skill_versions WHERE skill_id=?").all(skillId),
    assignments: db.prepare("SELECT * FROM skill_assignments WHERE skill_id=?").all(skillId),
    policies: db.prepare("SELECT * FROM skill_machine_versions WHERE skill_id=?").all(skillId),
    machineProvenance: db.prepare("SELECT * FROM skill_machine_provenance WHERE version_id IN (SELECT id FROM skill_versions WHERE skill_id=?)").all(skillId),
    gitProvenance: db.prepare("SELECT * FROM skill_git_provenance WHERE version_id IN (SELECT id FROM skill_versions WHERE skill_id=?)").all(skillId),
    builtInProvenance: db.prepare("SELECT * FROM skill_built_in_provenance WHERE version_id IN (SELECT id FROM skill_versions WHERE skill_id=?)").all(skillId),
  };
  db.exec("CREATE TABLE IF NOT EXISTS skill_removal_history (skill_id TEXT PRIMARY KEY, removed_at INTEGER NOT NULL, snapshot_json TEXT NOT NULL)");
  db.prepare("INSERT INTO skill_removal_history VALUES (?,?,?)").run(skillId, now, JSON.stringify(snapshot));
}
