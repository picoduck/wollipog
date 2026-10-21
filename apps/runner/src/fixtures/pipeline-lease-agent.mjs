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
  appendFileSync(output, JSON.stringify({ pid: process.pid, startedAt: stat[19], kind: "process" }) + "\n");
  await import("../../../mock-agent/index.mjs");
  // Discovery also starts this executable for initialize-only probes. Only an actual session
  // prompt should create retained background work or count as a provider turn.
  let input = "";
  let started = false;
  process.stdin.on("data", (chunk) => {
    input += String(chunk);
    for (;;) {
      const newline = input.indexOf("\n");
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (started || message.method !== "session/prompt") continue;
      started = true;
      appendFileSync(output, JSON.stringify({ pid: process.pid, startedAt: stat[19], kind: "provider" }) + "\n");
      spawn(process.execPath, [import.meta.filename, "--descendant"], { detached: true, stdio: "ignore", env: process.env }).unref();
    }
  });
}
