// Native fixture: all HOME/data/temp paths are supplied by the test's private directory.
const fs = require("node:fs");
const path = require("node:path");
const { AsyncProviderHomeLeaseRegistry } = require("../provider-home-lease-async.ts");
const { providerHomeRunnerMarker, linuxLeaseProcessProbe } = require("../provider-home-lease-evidence.ts");
const { providerContainmentIdentity, providerContainmentUnitIdentity } = require("../linux-cgroup.ts");
const { spawnAgent } = require("../spawn.ts");
const [mode, root, helper] = process.argv.slice(2);
const home = path.join(root, "provider-home");
async function main() {
  const diagnostics = [];
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), {
    runnerMarker: providerHomeRunnerMarker(), helperDataDir: path.join(root, "data"),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  if (mode === "hold" || mode === "survivor") {
    await registry.acquireHome(home, "acp");
    let leaf;
    if (mode === "survivor") {
      // Model a session's retained work: ownerless probes intentionally kill their whole tree
      // when the root closes. A session owner only checks emptiness, preserving this helper
      // until the test crashes its runner and a replacement attempts the actual lease proof.
      const child = spawnAgent({ command: helper, args: ["nondumpable", path.join(root, "survivor.pid")], cwd: root, descendantOwner: {} });
      leaf = child.posixBoundary?.containmentIdentity;
      await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    }
    fs.writeFileSync(path.join(root, "ready.json"), JSON.stringify({ pid: process.pid, identity: { ...providerContainmentIdentity(), unit: providerContainmentUnitIdentity() }, leaf }));
    setInterval(() => {}, 1000);
    return;
  }
  const stale = JSON.parse(fs.readFileSync(path.join(home, ".agent-manager/provider-home-leases-v1/mutable-home.recovery.json"), "utf8"));
  const scan = linuxLeaseProcessProbe().scan(stale.process.marker, stale.process.startTime);
  let outcome;
  try {
    await registry.acquireHome(home, "acp");
    outcome = { ok: true, released: await registry.close() };
  } catch (error) {
    outcome = { ok: false, code: error.code };
    await registry.close();
  }
  const removed = diagnostics.find((diagnostic) => diagnostic.event === "provider_home_boundary_recovered");
  process.stdout.write(JSON.stringify({ ...outcome, fallbackUninspectable: scan.uninspectable.length > 0,
    ...(removed ? { unitRemovedProof: true, migrationLimitExplained: removed.message.includes("deliberate same-user cgroup migration") } : {}) }) + "\n");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
