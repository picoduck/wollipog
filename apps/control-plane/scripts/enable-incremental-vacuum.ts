import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { convertIncrementalVacuum } from "../src/incremental-vacuum-conversion.js";

const context = { runId: randomUUID(), entryPoint: "offline_cli" };
try {
  const { values } = parseArgs({ options: {
    db: { type: "string" }, "owner-stopped": { type: "boolean", default: false }, "temp-dir": { type: "string" },
  } });
  if (!values.db) throw new Error("usage: pnpm db:enable-incremental-vacuum --db <existing-file> --owner-stopped [--temp-dir <directory>]");
  const result = convertIncrementalVacuum(values.db, { ownerStopped: values["owner-stopped"], tempDirectory: values["temp-dir"] });
  console.log(JSON.stringify({ ...context, event: "incremental_vacuum_conversion", ...result },
    (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
} catch (error) {
  console.error(JSON.stringify({ ...context, event: "incremental_vacuum_conversion_refused", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
