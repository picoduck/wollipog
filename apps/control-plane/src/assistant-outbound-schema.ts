import type { DatabaseSync } from "node:sqlite";

/** Add a connection-owned scope while preserving existing subscription IDs and delivery FKs.
 * Run only on the owning connection, outside any transaction, before background workers start. */
export function installAssistantOutboundScope(sql: DatabaseSync): void {
  const columns = sql.prepare("PRAGMA table_info(outbound_event_subscriptions)").all() as {name: string}[];
  if (columns.some(column => column.name === "assistant_connection_id")) return;
  const definition = (sql.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='outbound_event_subscriptions'")
    .get() as {sql: string}).sql;
  const indexes = sql.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='outbound_event_subscriptions' AND sql IS NOT NULL")
    .all() as {sql: string}[];
  const replacement = definition.replace("outbound_event_subscriptions", "outbound_event_subscriptions_assistant")
    .replace("('project','automation')", "('project','automation','assistant')")
    .replace("project_id            TEXT,", "assistant_connection_id TEXT, private_addresses_json TEXT, project_id            TEXT,")
    .replace("FOREIGN KEY (project_id)", "FOREIGN KEY (assistant_connection_id) REFERENCES assistant_connections(id), FOREIGN KEY (project_id)")
    .replace("(scope_kind='automation' AND automation_id IS NOT NULL AND project_id IS NULL)",
      "(scope_kind='automation' AND automation_id IS NOT NULL AND project_id IS NULL) OR (scope_kind='assistant' AND assistant_connection_id IS NOT NULL AND project_id IS NULL AND automation_id IS NULL)");
  if (!replacement.includes("private_addresses_json")) throw new Error("Unsupported outbound subscription schema");
  sql.exec("PRAGMA foreign_keys=OFF");
  try {
    sql.exec("BEGIN IMMEDIATE");
    sql.exec(replacement);
    const names = columns.map(column => `"${column.name}"`).join(",");
    sql.exec(`INSERT INTO outbound_event_subscriptions_assistant(${names}) SELECT ${names} FROM outbound_event_subscriptions`);
    sql.exec("DROP TABLE outbound_event_subscriptions; ALTER TABLE outbound_event_subscriptions_assistant RENAME TO outbound_event_subscriptions");
    for (const index of indexes) sql.exec(index.sql);
    if (sql.prepare("PRAGMA foreign_key_check(outbound_event_deliveries)").get()) throw new Error("Outbound subscription migration failed integrity check");
    sql.exec("COMMIT");
  } catch (error) { sql.exec("ROLLBACK"); throw error; }
  finally { sql.exec("PRAGMA foreign_keys=ON"); }
}
