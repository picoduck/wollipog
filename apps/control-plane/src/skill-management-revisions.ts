import type { DatabaseSync } from "node:sqlite";

/** Persistent per-skill counters cover owner APIs, imports and automatic version updates too.
 * Timestamp/state digests alone miss same-millisecond edits and change-then-revert races. */
export function installSkillManagementRevisions(db: DatabaseSync): void {
  // The remaining group/import flows span several resources. A monotonic library fence also
  // detects same-timestamp ABA changes through the owner API and background update services.
  db.exec(`CREATE TABLE IF NOT EXISTS skill_library_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO skill_library_revision VALUES (1,1);`);
  for (const table of ["skill_groups", "skills", "skill_versions", "skill_assignments", "skill_group_assignments",
    "skill_group_ownership", "skill_ownership", "skill_machine_versions", "skill_git_provenance", "skill_git_auto_updates",
    "skill_machine_provenance", "skill_built_ins", "skill_built_in_provenance", "skill_recommendation_dismissals"]) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER IF NOT EXISTS library_revision_${table}_${event.toLowerCase()}
      AFTER ${event} ON ${table} BEGIN UPDATE skill_library_revision SET revision=revision+1 WHERE id=1; END;`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS skill_management_revisions (skill_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO skill_management_revisions SELECT id, 1 FROM skills;`);
  const bump = (ids: string) => `INSERT INTO skill_management_revisions(skill_id,revision)
    SELECT skill_id,1 FROM (${ids}) WHERE skill_id IS NOT NULL
    ON CONFLICT(skill_id) DO UPDATE SET revision=revision+1;`;
  for (const [table, key] of [["skills", "id"], ["skill_versions", "skill_id"], ["skill_assignments", "skill_id"],
    ["skill_machine_versions", "skill_id"], ["skill_ownership", "skill_id"]] as const) {
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      const ids = event === "INSERT" ? `SELECT NEW.${key} AS skill_id` : event === "DELETE" ? `SELECT OLD.${key} AS skill_id`
        : `SELECT OLD.${key} AS skill_id UNION SELECT NEW.${key} AS skill_id`;
      db.exec(`CREATE TRIGGER IF NOT EXISTS management_revision_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} BEGIN ${bump(ids)} END;`);
    }
  }
  for (const table of ["skill_group_assignments", "skill_group_ownership"] as const) {
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      const groups = event === "INSERT" ? "NEW.group_id" : event === "DELETE" ? "OLD.group_id" : "OLD.group_id, NEW.group_id";
      db.exec(`CREATE TRIGGER IF NOT EXISTS management_revision_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} BEGIN ${bump(`SELECT id AS skill_id FROM skills WHERE group_id IN (${groups})`)} END;`);
    }
  }
}
