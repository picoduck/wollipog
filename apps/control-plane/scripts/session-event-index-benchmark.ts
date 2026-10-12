import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { ControlPlaneDb } from "../src/db.js";

const { values } = parseArgs({ options: {
  disk: { type: "boolean" }, dir: { type: "string" }, repeats: { type: "string", default: "5" },
} });
const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error("repeats must be an integer from 1 to 20");
const root = mkdtempSync(join(values.dir ?? tmpdir(), "wollipog-event-indexes-"));
const schemaDb = ControlPlaneDb.open(":memory:");
const indexes = schemaDb.raw().prepare(`SELECT name,sql FROM sqlite_master
  WHERE type='index' AND tbl_name='session_events' AND sql IS NOT NULL ORDER BY name`).all() as Array<{ name: string; sql: string }>;
const schema = (schemaDb.raw().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_events'")
  .get() as { sql: string }).sql;
schemaDb.close();
// Never accept a database path. This event-only clone isolates index maintenance from FTS,
// counter triggers, payload staging, JSON serialization and other appendEvent projection work.
const db = new DatabaseSync(values.disk ? join(root, "synthetic.db") : ":memory:");
try {
  db.exec("PRAGMA secure_delete=ON; PRAGMA foreign_keys=OFF");
  if (values.disk) db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=1000");
  db.exec(schema);
  const insert = db.prepare("INSERT INTO session_events(session_id,seq,runner_seq,ts,kind,payload) VALUES(?,?,?,?,?,?)");
  const payload = (i: number, size: number) => {
    const kind = ["agent_message", "tool_call", "tool_call_update", "user_message"][i % 4]!;
    return { kind, json: JSON.stringify({ kind, toolCallId: `tool${i % 25}`,
      toolKind: i % 20 === 1 ? "agent" : "shell", ...(i % 10 === 0 ? { parentToolUseId: "parent" } : {}),
      text: "x".repeat(size) }) };
  };
  db.exec("BEGIN");
  for (let i = 0; i < 200_000; i++) {
    const record = payload(i, 128);
    insert.run(`s${i % 2_000}`, Math.floor(i / 2_000) + 1, i + 1, i, record.kind, record.json);
  }
  db.exec("COMMIT");
  const configurations = [
    { label: "all", keep: indexes.map(index => index.name) }, { label: "none", keep: [] as string[] },
    ...indexes.map(index => ({ label: `without ${index.name}`, keep: indexes.filter(other => other.name !== index.name).map(other => other.name) })),
    ...indexes.map(index => ({ label: `only ${index.name}`, keep: [index.name] })),
  ];
  const results: Array<Record<string, string | number>> = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    const offset = repeat * 3 % configurations.length;
    for (const config of [...configurations.slice(offset), ...configurations.slice(0, offset)]) {
      for (const index of indexes) db.exec(`DROP INDEX IF EXISTS ${index.name}`);
      for (const index of indexes) if (config.keep.includes(index.name)) db.exec(index.sql);
      for (const size of [128, 40_960]) {
        const records = Array.from({ length: 2_400 }, (_, i) => payload(i, size));
        const latencies: number[] = [];
        if (values.disk) db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        else db.exec("BEGIN");
        let started = performance.now();
        for (let i = 0; i < records.length; i++) {
          if (i === 400) started = performance.now();
          const record = records[i]!;
          const before = performance.now();
          insert.run(`s${i % 2_000}`, 1_000 + i, 300_000 + i, i, record.kind, record.json);
          if (i >= 400) latencies.push(performance.now() - before);
        }
        const elapsed = performance.now() - started;
        if (!values.disk) db.exec("COMMIT");
        latencies.sort((a, b) => a - b);
        results.push({ repeat, config: config.label, textBytes: size, payloadBytes: Buffer.byteLength(records[0]!.json),
          events: 2_000, meanUs: elapsed * 1_000 / 2_000,
          p50Us: latencies[1_000]! * 1_000, p95Us: latencies[1_900]! * 1_000 });
        db.prepare("DELETE FROM session_events WHERE runner_seq>=300000").run();
      }
    }
    console.error(`Completed Repetition ${repeat + 1}/${repeats}`);
  }
  console.log(JSON.stringify({ node: process.version, cpu: cpus()[0]?.model,
    mode: values.disk ? "WAL NORMAL; autocommit; checkpoint 1000 pages" : "in-memory; one transaction per sample",
    secureDelete: db.prepare("PRAGMA secure_delete").get(), existingEvents: 200_000, sessionKeys: 2_000,
    indexes, results }, null, 2));
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
