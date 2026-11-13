import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, chmodSync, statSync, symlinkSync, unlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ProviderProcessOwnership } from "./provider-process-ownership.js";
import { linuxCgroupHelper } from "./linux-cgroup-helper.js";
import { linuxLeaseProcessProbe, proveLeaseAbandoned } from "./provider-home-lease-evidence.js";
import { spawnAgent } from "./spawn.js";
import type { LinuxCgroupBoundary } from "./linux-cgroup.js";

const linux = process.platform === "linux";
type Manifest = { bootId: string; uid: number; runnerPid: number; runnerStartTime: string; marker: string;
  children: Array<{ sessionId: string; pid: number; startTime: string }> };
function fixture(mode?: "tree" | "tree-same-group") {
  const root = mkdtempSync(join(tmpdir(), "provider-ownership-test-"));
  const directory = join(root, "records");
  const fixture = fileURLToPath(new URL("./fixtures/provider-owned-orphans.mjs", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", fixture, directory, "runner-test", ...(mode ? [mode] : [])],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 8192 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ready");
  const manifest = JSON.parse(readFileSync(join(root, "fixture-state.json"), "utf8")) as Manifest;
  const records = readdirSync(directory).filter(name => name.endsWith(".json")).map(name => join(directory, name));
  const alive = (child: Manifest["children"][number]) =>
    linuxLeaseProcessProbe()?.startTime(child.pid) === child.startTime &&
    !/\) [ZX] /u.test(readFileSync(`/proc/${child.pid}/stat`, "utf8"));
  return { directory, manifest, records, alive, close() {
    // Only fixture-created identities, with the same pidfd verification as production.
    const helper = linuxCgroupHelper();
    for (const child of manifest.children) spawnSync(helper, ["--retire-process"], {
      input: `${manifest.bootId}\n${child.pid}\n${child.startTime}\n${manifest.uid}\n${manifest.runnerPid}\n${manifest.runnerStartTime}\n`,
      timeout: 5000, stdio: ["pipe", "ignore", "ignore"],
    });
    rmSync(root, { recursive: true, force: true });
  } };
}

test("startup independently retires two recorded prior-runner sessions and keeps an unknown survivor", { skip: !linux }, async () => {
  const f = fixture();
  try {
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
    assert.equal(f.records.length, 2);
    for (const path of f.records) assert.equal(statSync(path).mode & 0o777, 0o600);
    const recovery = new ProviderProcessOwnership(f.directory, "runner-test");
    const result = await recovery.recover();
    assert.deepEqual({ ...result, sessions: result.sessions.sort() }, { retired: 2, retained: 0, pruned: 0, sessions: ["child", "root"] });
    assert.equal(f.alive(f.manifest.children[0]!), false);
    assert.equal(f.alive(f.manifest.children[1]!), false);
    assert.equal(f.alive(f.manifest.children[2]!), true);
    await assert.rejects(recovery.recover(), /already ran/);
  } finally { f.close(); }
});

for (const mode of ["tree", "tree-same-group"] as const) {
  test(`an unrecorded marked descendant (${mode}) survives root retirement and still blocks the production HOME proof`, { skip: !linux }, async () => {
    const f = fixture(mode);
    try {
      // Rehearse legacy records explicitly even on a delegated host. They grant no
      // authority over descendants and must retain the marker-based HOME refusal.
      for (const path of f.records) {
        const record = JSON.parse(readFileSync(path, "utf8"));
        delete record.containment;
        record.version = 1;
        writeFileSync(path, JSON.stringify(record));
      }
      const descendant = f.manifest.children.find(child => child.sessionId === "grandchild")!;
      assert.equal((await new ProviderProcessOwnership(f.directory, "runner-test").recover()).retired, 2);
      assert.equal(f.alive(descendant), true, "ancestry or an inherited marker alone grants no session-bound signal authority");
      const proof = proveLeaseAbandoned({ bootId: f.manifest.bootId, startTime: f.manifest.runnerStartTime,
        marker: f.manifest.marker }, f.manifest.runnerPid, linuxLeaseProcessProbe());
      assert.equal(proof.proven, false);
      if (!proof.proven) assert.equal(proof.reason, "marked_process");
    } finally { f.close(); }
  });
}

test("a contained journal survives root close and is removed only by whole-boundary release", { skip: !linux }, () => {
  const directory = mkdtempSync(join(tmpdir(), "owned-boundary-lifetime-"));
  try {
    const registry = new ProviderProcessOwnership(directory, "runner");
    let release!: () => void;
    const containment = { identity: { kind: "linux-cgroup-v2", bootId: linuxLeaseProcessProbe()!.bootId(),
      mountRoot: "/", cgroupPath: "fixture/provider", inode: "42" },
      onReleased: (callback: () => void) => { release = callback; } } as unknown as LinuxCgroupBoundary;
    const child = Object.assign(new EventEmitter(), { pid: process.pid });
    registry.owner("s_lifetime")!.prepare().spawned(child, containment);
    const name = readdirSync(directory)[0]!;
    const record = JSON.parse(readFileSync(join(directory, name), "utf8"));
    assert.equal(record.version, 2);
    assert.deepEqual(record.containment, containment.identity);
    child.emit("close");
    assert.deepEqual(readdirSync(directory), [name], "a surviving descendant retains durable ownership");
    release();
    assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("PID reuse identity mismatch retains the unrelated process and handles the other session", { skip: !linux }, async () => {
  const f = fixture();
  try {
    const path = f.records.find(path => JSON.parse(readFileSync(path, "utf8")).sessionId === "root")!;
    const old = JSON.parse(readFileSync(path, "utf8"));
    const unrelated = f.manifest.children[2]!;
    // The numeric PID now names another process with a different kernel start time.
    writeFileSync(path, JSON.stringify({ ...old, pid: unrelated.pid, startTime: String(BigInt(unrelated.startTime) + 1n) }));
    const result = await new ProviderProcessOwnership(f.directory, "runner-test").recover();
    assert.equal(result.retired, 1);
    assert.equal(result.pruned, 1, "the former identity is gone, so its obsolete metadata is not a permanent admission leak");
    assert.equal(f.alive(unrelated), true);
    assert.equal(f.alive(f.manifest.children[1]!), false);
  } finally { f.close(); }
});

for (const kind of ["runner", "user", "legacy", "permissions", "symlink", "missing-boundary"] as const) {
  test(`unproven ${kind} ownership is kept without signalling`, { skip: !linux }, async () => {
    const f = fixture();
    try {
      for (const path of f.records) {
        const record = JSON.parse(readFileSync(path, "utf8"));
        if (kind === "runner") record.runnerId = "other-runner";
        if (kind === "user") record.uid++;
        if (kind === "legacy") { delete record.startTime; delete record.containment; record.version = 1; }
        if (kind === "missing-boundary") {
          record.version = 2;
          record.containment = { kind: "linux-cgroup-v2", bootId: record.bootId, mountRoot: "/",
            cgroupPath: `missing-${randomUUID()}`, inode: "42" };
        }
        writeFileSync(path, JSON.stringify(record));
        if (kind === "permissions") chmodSync(path, 0o644);
        if (kind === "symlink") {
          const target = join(f.directory, "..", `source-${record.sessionId}.json`);
          writeFileSync(target, JSON.stringify(record), { mode: 0o600 });
          unlinkSync(path);
          symlinkSync(target, path);
        }
      }
      const result = await new ProviderProcessOwnership(f.directory, "runner-test").recover();
      assert.equal(result.retired, 0);
      assert.equal(kind === "legacy" ? result.pruned : result.retained, 2);
      for (const child of f.manifest.children) assert.equal(f.alive(child), true);
    } finally { f.close(); }
  });
}

test("the current runner generation is never signalled", { skip: !linux }, async () => {
  const root = mkdtempSync(join(tmpdir(), "current-provider-ownership-"));
  const registry = new ProviderProcessOwnership(root, "runner-test");
  const child = spawnAgent({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"],
    cwd: process.cwd(), context: { kind: "native" }, processOwnership: registry.owner("current") });
  try {
    // Isolate the generation fence from the separate live-runner fence.
    const path = join(root, readdirSync(root).find(name => name.endsWith(".json"))!);
    const record = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...record, runnerPid: 2147483646, runnerStartTime: "1" }));
    assert.equal((await registry.recover()).retired, 0);
    assert.equal(child.exitCode, null);
    assert.ok(linuxLeaseProcessProbe()?.startTime(child.pid!));
  } finally {
    child.kill();
    await new Promise<void>(done => child.once("close", () => done()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed spawn and synchronous abort release their admission intent instead of filling the journal", { skip: !linux }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "failed-provider-ownership-"));
  const registry = new ProviderProcessOwnership(directory, "runner-test");
  try {
    // Cross the old global cap while modeling the no-pid async ENOENT contract.
    for (let index = 0; index < 1030; index++) {
      const admission = registry.owner("failed")!.prepare();
      if (index % 2) admission.aborted();
      else admission.spawned({ once: (_event, close) => { close(); } });
    }
    assert.deepEqual(readdirSync(directory), []);
    const child = spawnAgent({ command: join(directory, "missing-provider"), args: [], cwd: directory,
      context: { kind: "native" }, processOwnership: registry.owner("failed") });
    child.on("error", () => {});
    await new Promise<void>(done => child.once("close", () => done()));
    assert.deepEqual(readdirSync(directory), []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("startup prunes dead-runner intents and recovers a completed pending publication", { skip: !linux }, async () => {
  const f = fixture();
  try {
    const intent = f.records.find(path => JSON.parse(readFileSync(path, "utf8")).sessionId === "root")!;
    const record = JSON.parse(readFileSync(intent, "utf8"));
    renameSync(intent, `${intent}.pending`); // Crash after complete fsync, before rename.
    delete record.pid; delete record.startTime;
    writeFileSync(intent, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    const result = await new ProviderProcessOwnership(f.directory, "runner-test").recover();
    assert.equal(result.retired, 2);
    assert.equal(result.pruned, 1);
    assert.equal(result.retained, 0);
    assert.deepEqual(readdirSync(f.directory), []);
    assert.equal(f.alive(f.manifest.children[2]!), true);
  } finally { f.close(); }
});

test("an already full journal of obsolete intents can recover admission without signalling the unproven survivors", { skip: !linux }, async () => {
  const f = fixture();
  try {
    const record = JSON.parse(readFileSync(f.records[0]!, "utf8"));
    delete record.pid; delete record.startTime;
    for (const path of f.records) unlinkSync(path);
    for (let index = 0; index < 1025; index++) writeFileSync(join(f.directory, `${randomUUID()}.json`),
      JSON.stringify(record), { flag: "wx", mode: 0o600 });
    const registry = new ProviderProcessOwnership(f.directory, "runner-test");
    assert.equal((await registry.recover()).pruned, 1025);
    const next = registry.owner("next")!.prepare();
    next.aborted();
    assert.deepEqual(readdirSync(f.directory), []);
    for (const child of f.manifest.children) assert.equal(f.alive(child), true);
  } finally { f.close(); }
});
