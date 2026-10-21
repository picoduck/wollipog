// Test-only ACP wrapper: the actual mock protocol still runs unchanged. Both the provider and its
// detached descendant record kernel identities, so cleanup never signals a reused or foreign PID.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const output = process.env.WOLLIPOG_PIPELINE_PROCESSES;
const descendant = process.argv.includes("--descendant");
const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8").split(") ").at(-1).split(" ");
if (descendant) {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
  appendFileSync(output, JSON.stringify({ pid: process.pid, startedAt: stat[19], kind: "descendant" }) + "\n");
  setInterval(() => {}, 1000);
} else {
  appendFileSync(output, JSON.stringify({ pid: process.pid, startedAt: stat[19], kind: "provider" }) + "\n");
  spawn(process.execPath, [import.meta.filename, "--descendant"], { detached: true, stdio: "ignore", env: process.env }).unref();
  await import("../../../mock-agent/index.mjs");
}
