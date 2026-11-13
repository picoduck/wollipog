// A bounded predecessor runner exits while its session-bound native tree survives.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireRunnerDataDirLease } from "../runner-data-dir.ts";
import { ProviderProcessOwnership } from "../provider-process-ownership.ts";
import { spawnAgent } from "../spawn.ts";
import { providerContainmentIdentity } from "../linux-cgroup.ts";
import { providerHomeRunnerMarker, linuxLeaseProcessProbe } from "../provider-home-lease-evidence.ts";
import { ProviderHomeLeaseRegistry } from "../provider-home-lease.ts";
const [root, helper, shape, url, instanceId] = process.argv.slice(2);
const dataDir = join(root, "runner-data");
const lease = acquireRunnerDataDirLease(dataDir, { runnerId: "runner", controlPlaneUrl: url, controlPlaneInstanceId: instanceId });
process.once("exit", lease.release);
const containment = providerContainmentIdentity(dataDir);
if (!containment) throw new Error("fixture requires delegated cgroup containment");
const ownership = new ProviderProcessOwnership(join(dataDir, "provider-processes-v1"), "runner");
const marker = providerHomeRunnerMarker();
const home = join(root, "provider-home");
mkdirSync(home, { mode: 0o700 });
new ProviderHomeLeaseRegistry("a".repeat(64), { runnerMarker: marker, containment }).acquireHome(home, "fixture");
const child = spawnAgent({ command: helper, args: [shape, join(root, "descendant.json")],
  cwd: root, context: { kind: "native" }, processOwnership: ownership.owner("s_owned_tree"), descendantOwner: {} });
const deadline = Date.now() + 5000;
while (!existsSync(join(root, "descendant.json"))) {
  if (Date.now() > deadline) throw new Error("fixture descendant readiness timed out");
  await delay(10);
}
const descendant = JSON.parse(readFileSync(join(root, "descendant.json"), "utf8"));
const startTime = pid => readFileSync(`/proc/${pid}/stat`, "utf8").split(")").at(-1).trim().split(/\s+/)[19];
const manifest = { runnerPid: process.pid, evidence: { bootId: linuxLeaseProcessProbe().bootId(),
  startTime: startTime(process.pid), marker }, root: { pid: child.pid, startTime: startTime(child.pid) },
  descendant: { ...descendant, startTime: startTime(descendant.pid) } };
writeFileSync(join(root, "tree.json.pending"), JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
renameSync(join(root, "tree.json.pending"), join(root, "tree.json"));
process.exit(0);
