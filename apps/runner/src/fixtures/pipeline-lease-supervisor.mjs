// Isolated stand-in for the development stack's supervisor. Use its actual argv builder, and
// mirror scripts/dev-runner-bootstrap.mjs's once-only signal forwarding and child-exit wait.
// No stack discovery, installed services, real credentials, or existing processes are involved.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runnerLaunchArgs } from "../../../../scripts/dev-runner-bootstrap.mjs";

const [configPath, identityPath] = process.argv.slice(2);
const child = spawn(process.execPath, runnerLaunchArgs(fileURLToPath(import.meta.resolve("tsx/cli")), configPath, false), {
  cwd: process.cwd(), env: process.env, stdio: "inherit",
});
const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8").split(") ").at(-1).split(" ");
writeFileSync(identityPath, JSON.stringify({ pid: child.pid, startedAt: stat[19] }));
const forward = (signal) => { if (!child.killed) child.kill(signal); };
process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
