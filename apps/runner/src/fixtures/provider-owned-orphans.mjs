// Bounded fake runner: publish real launch ownership, then exit while inert providers survive.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProviderProcessOwnership } from "../provider-process-ownership.ts";
import { ProviderHomeLeaseRegistry } from "../provider-home-lease.ts";
import { providerHomeRunnerMarker } from "../provider-home-lease-evidence.ts";
import { ProviderProcessLedger, spawnAgent } from "../spawn.ts";
const [directory, runnerId, complete, rootSession = "root"] = process.argv.slice(2);
const registry = new ProviderProcessOwnership(directory, runnerId);
const home = join(dirname(directory), "provider-home");
if (complete) {
  mkdirSync(home, { mode: 0o700 });
  new ProviderHomeLeaseRegistry("a".repeat(64), { runnerMarker: providerHomeRunnerMarker() }).acquireHome(home, "fixture");
}
const start = pid => readFileSync(`/proc/${pid}/stat`, "utf8").split(")").at(-1).trim().split(/\s+/)[19];
const owner = { runnerPid: process.pid, runnerStartTime: start(process.pid),
  bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), uid: process.getuid() };
const children = [rootSession, "child", ...(complete ? [] : ["unknown"])].map(sessionId => {
  const ledger = new ProviderProcessLedger({ processOwnership: sessionId === "unknown" ? undefined : registry.owner(sessionId) });
  const child = ledger.launch(spawnAgent, { command: process.execPath, args: ["-e", "setInterval(()=>{},1000);setTimeout(()=>process.exit(0),30000)"],
    cwd: process.cwd(), context: { kind: "native" } });
  return { sessionId, pid: child.pid, startTime: start(child.pid) };
});
writeFileSync(join(dirname(directory), "fixture-state.json"), JSON.stringify({ ...owner, home, children }), { flag: "wx", mode: 0o600 });
process.stdout.write("ready\n");
process.exit(0);
