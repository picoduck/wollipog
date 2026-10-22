import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { currentCgroupDirectory, providerContainmentIdentity, providerContainmentStatus, type LinuxCgroupIdentity } from "./linux-cgroup.js";
import { inspectLeaseCgroup } from "./provider-home-lease-containment.js";

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("native recovery fixture readiness timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

for (const survivor of [false, true]) test(`replacement runner ${survivor ? "refuses a surviving boundary helper" : "recovers an empty boundary"} with an unreadable unrelated process alive`, {
  skip: process.platform !== "linux", timeout: 120_000,
}, async (t) => {
  if (!providerContainmentIdentity()) {
    assert.notEqual(process.env.WOLLIPOG_TEST_REQUIRE_CGROUP, "1", "delegated containment is mandatory for native validation");
    t.skip(`containment unavailable: ${providerContainmentStatus().reason}`); return;
  }
  assert.notEqual(process.getuid?.(), 0, "run as the real user so PR_SET_DUMPABLE=0 denies environment reads");
  const root = mkdtempSync(join(tmpdir(), "wollipog-lease-cgroup-"));
  const temporary = join(root, "tmp"); mkdirSync(temporary);
  const data = join(root, "data"); mkdirSync(data);
  const helper = join(root, "descendant");
  const fixture = fileURLToPath(new URL("./fixtures/provider-home-cgroup-recovery.cjs", import.meta.url));
  const source = fileURLToPath(new URL("../native/fixtures/cgroup-descendant.c", import.meta.url));
  const built = spawnSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", helper], { encoding: "utf8", timeout: 30_000 });
  assert.equal(built.status, 0, built.stderr);
  const env = { ...process.env, HOME: join(root, "runner-home"), CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), TMPDIR: temporary };
  const holder = spawn(process.execPath, ["--import", "tsx", fixture, survivor ? "survivor" : "hold", root, helper], { env, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; holder.stderr!.on("data", (chunk) => { errors += String(chunk); });
  const owned = new Set<number>();
  let boundaries: LinuxCgroupIdentity[] = [];
  t.after(async () => {
    holder.kill("SIGKILL");
    for (const pid of owned) { try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ } }
    const mount = currentCgroupDirectory(readFileSync("/proc/self/mountinfo", "utf8"), readFileSync("/proc/self/cgroup", "utf8"));
    for (const identity of boundaries) {
      const directory = join(mount!.mountPoint, identity.cgroupPath);
      for (let attempt = 0; attempt < 100; attempt++) {
        try { if (lstatSync(directory, { bigint: true }).ino.toString() === identity.inode) rmdirSync(directory); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  await waitUntil(() => { assert.equal(holder.exitCode, null, errors); return existsSync(join(root, "ready.json")); });
  const ready = JSON.parse(readFileSync(join(root, "ready.json"), "utf8")) as { identity: LinuxCgroupIdentity; leaf?: LinuxCgroupIdentity };
  boundaries = [...(ready.leaf ? [ready.leaf] : []), ready.identity];
  const journal = join(root, "provider-home/.agent-manager/provider-home-leases-v1");
  const original = readFileSync(join(journal, "mutable-home.recovery.json"));
  const record = JSON.parse(original.toString()) as { leaseId: string; process: { version: number; containment: LinuxCgroupIdentity } };
  assert.equal(record.process.version, 2);
  assert.deepEqual(record.process.containment, ready.identity, "worker records its launch parent's exact boundary");
  if (survivor) { await waitUntil(() => existsSync(join(root, "survivor.pid"))); owned.add(Number(readFileSync(join(root, "survivor.pid"), "utf8"))); }
  // Start after the holder so the legacy scanner cannot exclude it by start time. Its double
  // fork reparents it away from the replacement runner; it remains alive through every recovery.
  const unrelatedFile = join(root, "unrelated.pid");
  const detached = spawnSync(helper, ["nondumpable", unrelatedFile], { timeout: 5_000 });
  assert.equal(detached.status, 0);
  await waitUntil(() => existsSync(unrelatedFile));
  const unrelated = Number(readFileSync(unrelatedFile, "utf8")); owned.add(unrelated);
  assert.throws(() => readFileSync(`/proc/${unrelated}/environ`), { code: "EACCES" });
  holder.kill("SIGKILL"); await once(holder, "close");
  const recover = () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", fixture, "recover", root, helper], { env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout) as { ok: boolean; released?: boolean; code?: string; fallbackUninspectable: boolean };
    assert.equal(outcome.fallbackUninspectable, true, "the unrelated fixture really blocks the legacy scan");
    assert.throws(() => readFileSync(`/proc/${unrelated}/environ`), { code: "EACCES" }, "unrelated process survives recovery untouched");
    return outcome;
  };
  assert.equal(inspectLeaseCgroup({ ...ready.identity, inode: (BigInt(ready.identity.inode) + 1n).toString() }), "unverifiable", "path with a different inode is never proof");
  assert.equal(inspectLeaseCgroup({ ...ready.identity, cgroupPath: ready.identity.cgroupPath + "-missing" }), "unverifiable", "an absent or renamed path is never proof");
  if (survivor) {
    assert.equal(inspectLeaseCgroup(ready.identity), "populated");
    assert.equal(recover().code, "boundary_survivor");
    assert.deepEqual(readFileSync(join(journal, "mutable-home.recovery.json")), original);
    assert.equal(readdirSync(journal).filter((name) => name.startsWith("next-")).length, 0, "refusal appends nothing");
    const pid = Number(readFileSync(join(root, "survivor.pid"), "utf8")); process.kill(pid, "SIGKILL"); owned.delete(pid);
    await waitUntil(() => inspectLeaseCgroup(ready.identity) === "empty");
  }
  assert.equal(inspectLeaseCgroup(ready.identity), "empty");
  assert.deepEqual(recover(), { ok: true, released: true, fallbackUninspectable: true });
  assert.deepEqual(readFileSync(join(journal, "mutable-home.recovery.json")), original, "recovery retains the exact predecessor bytes");
  const successor = JSON.parse(readFileSync(join(journal, `next-${record.leaseId}.json`), "utf8")) as { recovery: unknown; previousRecordHash: string };
  assert.deepEqual(successor.recovery, { proof: "linux_cgroup" });
  assert.equal(successor.previousRecordHash, createHash("sha256").update(original).digest("hex"));
});
