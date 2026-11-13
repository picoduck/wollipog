// Bounded fake runner: publish real launch ownership, then exit while inert providers survive.
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { ProviderProcessOwnership } from "../provider-process-ownership.ts";
import { ProviderHomeLeaseRegistry } from "../provider-home-lease.ts";
import { providerHomeRunnerMarker } from "../provider-home-lease-evidence.ts";
import { ProviderProcessLedger, spawnAgent } from "../spawn.ts";
const [directory, runnerId, complete, rootSession = "root"] = process.argv.slice(2);
const registry = new ProviderProcessOwnership(directory, runnerId);
const home = join(dirname(directory), "provider-home");
const marker = providerHomeRunnerMarker();
if (complete === "complete") {
  mkdirSync(home, { mode: 0o700 });
  new ProviderHomeLeaseRegistry("a".repeat(64), { runnerMarker: providerHomeRunnerMarker() }).acquireHome(home, "fixture");
}
const start = pid => readFileSync(`/proc/${pid}/stat`, "utf8").split(")").at(-1).trim().split(/\s+/)[19];
const owner = { runnerPid: process.pid, runnerStartTime: start(process.pid),
  bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), uid: process.getuid(), marker };
const descendantFile = join(dirname(directory), "descendant.json");
const inert = "setInterval(()=>{},1000);setTimeout(()=>process.exit(0),30000)";
const children = [rootSession, "child", ...(complete ? [] : ["unknown"])].map(sessionId => {
  const ledger = new ProviderProcessLedger({ processOwnership: sessionId === "unknown" ? undefined : registry.owner(sessionId) });
  const script = complete?.startsWith("tree") && sessionId === rootSession ? `
const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(inert)}], { detached: ${complete === "tree"}, stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(descendantFile)}, JSON.stringify({ sessionId: 'grandchild', pid: c.pid }), { mode: 0o600 });
${inert}` : inert;
  const child = ledger.launch(spawnAgent, { command: process.execPath, args: ["-e", script],
    cwd: process.cwd(), context: { kind: "native" } });
  return { sessionId, pid: child.pid, startTime: start(child.pid) };
});
if (complete?.startsWith("tree")) {
  const deadline = Date.now() + 5000;
  while (!existsSync(descendantFile)) {
    if (Date.now() >= deadline) throw new Error("fixture descendant did not start");
    await delay(10);
  }
  const child = JSON.parse(readFileSync(descendantFile, "utf8"));
  children.push({ ...child, startTime: start(child.pid) });
}
writeFileSync(join(dirname(directory), "fixture-state.json"), JSON.stringify({ ...owner, home, children }), { flag: "wx", mode: 0o600 });
process.stdout.write("ready\n");
process.exit(0);
