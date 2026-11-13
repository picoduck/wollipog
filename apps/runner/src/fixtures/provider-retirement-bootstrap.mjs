// Exercise index.ts's real attestation -> data lease -> retirement -> registration ordering.
import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeControlPlane } from "./fake-control-plane.ts";
import { transportRunnerEnvironment } from "./transport-runner-environment.ts";
import { linuxLeaseProcessProbe, proveLeaseAbandoned } from "../provider-home-lease-evidence.ts";
import { ProviderHomeLeaseRegistry } from "../provider-home-lease.ts";
const [root, helper, shape, proof = "valid"] = process.argv.slice(2);
const refused = ["inode", "user", "live-runner"].includes(proof);
const timer = setTimeout(() => { throw new Error("bootstrap rehearsal timed out"); }, 25_000);
const cp = await startFakeControlPlane({ onMessage: (_socket, message) => {
  if (message.type !== "register") return;
  const records = readdirSync(join(root, "runner-data/provider-processes-v1"));
  assert.equal(records.length, refused ? 1 : 0, "unproven ownership must remain recorded");
  if (shape === "empty") {
    clearTimeout(timer);
    process.stdout.write("bootstrap-empty-ready\n");
    process.exit(0);
  }
  const manifest = JSON.parse(readFileSync(join(root, "tree.json"), "utf8"));
  for (const member of [manifest.root, manifest.descendant]) {
    try {
      const stat = readFileSync(`/proc/${member.pid}/stat`, "utf8");
      if (refused) assert.doesNotMatch(stat, /\) [ZX] /u, "unproven tree must remain untouched");
      else assert.match(stat, /\) [ZX] /u, "recorded provider tree must exit before registration");
    } catch (error) { if (error.code !== "ENOENT" || refused) throw error; }
  }
  if (refused) {
    const proof = proveLeaseAbandoned(manifest.evidence, manifest.runnerPid, linuxLeaseProcessProbe());
    assert.equal(proof.proven, false, "unproven survivors must still block HOME recovery");
    assert.equal(proof.reason, "marked_process");
  }
  const leases = new ProviderHomeLeaseRegistry("a".repeat(64));
  if (refused) assert.throws(() => leases.acquireHome(join(root, "provider-home"), "fixture"), /surviving provider or helper/u);
  else assert.doesNotThrow(() => leases.acquireHome(join(root, "provider-home"), "fixture"));
  leases.releaseAll();
  clearTimeout(timer);
  process.stdout.write(refused ? "bootstrap-tree-retained\n" : "bootstrap-tree-retired\n");
  process.exit(0);
} });
const url = `ws://127.0.0.1:${cp.port}/runner`;
const env = transportRunnerEnvironment(root);
if (shape !== "empty") {
  execFileSync(process.execPath, ["--import", "tsx", new URL("./provider-owned-boundary.mjs", import.meta.url).pathname,
    root, helper, shape, url, cp.instanceId], { env, timeout: 10_000, stdio: "pipe" });
const journal = join(root, "runner-data/provider-processes-v1");
const recordPath = join(journal, readdirSync(journal)[0]);
const original = readFileSync(recordPath, "utf8");
writeFileSync(join(root, "original-record.json"), original, { mode: 0o600 });
if (proof !== "valid") {
  const record = JSON.parse(original);
  if (proof === "inode") record.containment.inode = String(BigInt(record.containment.inode) + 1n);
  if (proof === "user") record.uid++;
  if (proof === "live-runner") {
    record.runnerPid = process.pid;
    record.runnerStartTime = readFileSync(`/proc/${process.pid}/stat`, "utf8").split(")").at(-1).trim().split(/\s+/)[19];
  }
  if (proof === "pid-reuse") {
    record.pid = process.ppid;
    record.startTime = String(BigInt(readFileSync(`/proc/${process.ppid}/stat`, "utf8").split(")").at(-1).trim().split(/\s+/)[19]) + 1n);
  }
  writeFileSync(recordPath, JSON.stringify(record));
}
}
const config = join(root, "runner.json");
writeFileSync(config, JSON.stringify({ runnerId: "runner", token: "synthetic-runner-token", controlPlaneUrl: url,
  dataDir: join(root, "runner-data"), agents: [], workspaces: [], executionIsolation: { mode: "provider", network: "inherit" } }));
// Consume no real runner/account environment or provider HOME in the actual daemon import.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
process.argv = [process.execPath, new URL("../index.ts", import.meta.url).pathname, "--config", config];
await import("../index.ts");
