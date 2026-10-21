import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { currentCgroupDirectory, LinuxCgroupBoundary, providerContainmentIdentity, providerContainmentStatus, type LinuxCgroupBoundaryIo } from "./linux-cgroup.js";
import { linuxCgroupHelper } from "./linux-cgroup-helper.js";
import { PosixProcessBoundary, terminatePosixProcessBoundaries } from "./posix-process-tree.js";
import { provenProcessTreeExit, ProviderProcessLedger, spawnAgent, waitForPendingKills } from "./spawn.js";

const identity = Object.freeze({ kind: "linux-cgroup-v2" as const, bootId: "boot", mountRoot: "/", cgroupPath: "test/leaf", inode: "42" });

function controlledBoundary() {
  const state = { populated: true, kills: 0, closed: 0, removed: 0, reads: 0, now: 0, unreadable: false, killFails: false, stuck: false };
  const io: LinuxCgroupBoundaryIo = {
    populated() { state.reads++; if (state.unreadable) throw new Error("identity changed"); return state.populated; },
    kill() { state.kills++; if (state.killFails) throw new Error("denied"); if (!state.stuck) state.populated = false; },
    remove() { state.removed++; },
    close() { state.closed++; },
    async sleep(milliseconds) { state.now += milliseconds; },
    now: () => state.now,
  };
  const boundary = new LinuxCgroupBoundary(identity, io);
  const pipe = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdio: [null, null, null, null, pipe], pid: 100 }) as unknown as ChildProcess;
  boundary.bind(child);
  return { boundary, state, pipe };
}

test("cgroup mount resolution uses the current delegation and decodes mount paths", () => {
  const mount = "30 20 0:30 /user.slice /sys/fs/cgroup\\040test rw - cgroup2 cgroup rw\n";
  assert.deepEqual(currentCgroupDirectory(mount, "0::/user.slice/user-1000/runner\n"), {
    mountRoot: "/user.slice", mountPoint: "/sys/fs/cgroup test", directory: "/sys/fs/cgroup test/user-1000/runner",
  });
  assert.equal(currentCgroupDirectory(mount, "0::/other/runner\n"), undefined);
  assert.equal(currentCgroupDirectory(mount, "0::/user.slice/../other\n"), undefined);
  assert.equal(currentCgroupDirectory("30 20 0:30 / /cgroup rw - cgroup cgroup rw", "0::/runner\n"), undefined);
});

test("an empty cgroup before admission is never an early-release proof", async () => {
  const { boundary, state, pipe } = controlledBoundary();
  state.populated = false;
  let settled = false;
  const proof = boundary.releaseIfEmpty().then((value) => { settled = true; return value; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(state.reads, 0);
  state.populated = true;
  pipe.end("1");
  assert.equal(await proof, false);
  assert.equal(state.kills, 0, "non-killing release leaves retained background work alive");
  assert.equal(await boundary.terminate(), true);
  assert.equal(state.kills, 1);
  assert.equal(state.closed, 1);
});

test("early release and shutdown use the same kernel proof without a process scan", async () => {
  const { boundary: kernel, state, pipe } = controlledBoundary();
  pipe.end("1");
  const owner = {};
  const boundary = new PosixProcessBoundary(100, owner, "marker", {
    async listProcesses() { throw new Error("must not scan unrelated processes or environments"); },
  }, undefined, kernel);
  assert.equal(boundary.proofStandard, "linux-cgroup-v2");
  assert.strictEqual(boundary.containmentIdentity, identity);
  assert.equal(await boundary.releaseIfEmpty(), false);
  assert.deepEqual(await Promise.all(terminatePosixProcessBoundaries(owner)), [true]);
  assert.equal(state.kills, 1);
  assert.equal(state.closed, 1);
  assert.equal(await boundary.terminate(), true);
  assert.equal(terminatePosixProcessBoundaries(owner).length, 0);
});

for (const failure of ["unreadable", "killFails", "stuck"] as const) {
  test(`cgroup ${failure} cannot produce an empty-tree proof`, async () => {
    const { boundary, state, pipe } = controlledBoundary();
    pipe.end("1");
    state[failure] = true;
    assert.equal(await boundary.terminate(), false);
    assert.equal(state.closed, 0);
    assert.equal(state.removed, 0);
    state[failure] = false;
    assert.equal(await boundary.terminate(), true, "a later real empty proof can settle cleanup");
  });
}

test("a failed admission cannot authorize release even if the unused cgroup is empty", async () => {
  const { boundary, state, pipe } = controlledBoundary();
  state.populated = false;
  pipe.end();
  assert.equal(await boundary.releaseIfEmpty(), false);
  assert.equal(await boundary.terminate(), false);
  assert.equal(state.kills, 0);
  boundary.cancelSpawn();
});

test("unavailable containment retains the marker/parent-link launch API and reports fallback", { skip: process.platform !== "linux" }, () => {
  const module = new URL("./linux-cgroup.ts", import.meta.url).href;
  const spawnModule = new URL("./spawn.ts", import.meta.url).href;
  const code = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import assert from 'node:assert/strict';
    const cgroup = await import(${JSON.stringify(module)});
    const original = fs.mkdirSync;
    fs.mkdirSync = () => { throw Object.assign(new Error('unavailable delegation'), {code:'EROFS'}); };
    syncBuiltinESMExports();
    assert.equal(cgroup.providerContainmentIdentity(), undefined);
    fs.mkdirSync = original;
    syncBuiltinESMExports();
    assert.deepEqual(cgroup.providerContainmentStatus(), {proofStandard:'marker-parent-links',reason:'cgroup-unavailable'});
    const {spawnAgent,provenProcessTreeExit} = await import(${JSON.stringify(spawnModule)});
    const child = spawnAgent({command:process.execPath,args:['-e',''],cwd:process.cwd()});
    assert.equal(child.posixBoundary.proofStandard,'marker-parent-links');
    await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
    assert.equal(await provenProcessTreeExit(child),true);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { timeout: 20_000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /proofStandard=marker-parent-links reason=cgroup-unavailable/u);
});

test("native launcher refuses a non-cgroup descriptor before executing provider code", { skip: process.platform !== "linux" }, () => {
  const result = spawnSync(linuxCgroupHelper(), ["/bin/sh", "-c", "echo provider-was-executed"], {
    encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 125);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /provider was not executed/u);
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("fixture did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: number): boolean {
  try { return !/^Z/u.test(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0]!); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

for (const mode of ["detached", "nondumpable"]) {
  test(`Linux cgroup contains and reaps a ${mode} setsid helper before lease-release proof`, { skip: process.platform !== "linux" }, async (t) => {
    const parentIdentity = providerContainmentIdentity();
    if (!parentIdentity) {
      assert.notEqual(process.env.WOLLIPOG_TEST_REQUIRE_CGROUP, "1", "real delegated cgroup containment was required");
      t.skip(`containment unavailable: ${providerContainmentStatus().reason}`);
      return;
    }
    const directory = mkdtempSync(join(tmpdir(), "wollipog-cgroup-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const helper = join(directory, "descendant");
    const source = fileURLToPath(new URL("../native/fixtures/cgroup-descendant.c", import.meta.url));
    const compiled = spawnSync("/usr/bin/cc", ["-std=c11", "-Wall", "-Wextra", "-Werror", source, "-o", helper], { encoding: "utf8", timeout: 30_000 });
    assert.equal(compiled.status, 0, compiled.stderr);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    t.after(() => unrelated.kill("SIGKILL"));
    const ledger = new ProviderProcessLedger();
    const pidfile = join(directory, "helper.pid");
    const child = ledger.record(spawnAgent({ command: helper, args: [mode, pidfile], cwd: directory, descendantOwner: ledger.owner }));
    t.after(async () => { await child.posixBoundary?.terminate(); });
    await new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
    await waitUntil(() => { try { return readFileSync(pidfile, "utf8").trim().length > 0; } catch { return false; } });
    const pid = Number(readFileSync(pidfile, "utf8").trim());
    assert.ok(alive(pid));
    assert.equal(child.posixBoundary?.proofStandard, "linux-cgroup-v2");
    const leaf = child.posixBoundary!.containmentIdentity!;
    assert.equal(leaf.bootId, parentIdentity.bootId);
    assert.ok(leaf.cgroupPath.startsWith(parentIdentity.cgroupPath + "/"));
    assert.notEqual(leaf.inode, parentIdentity.inode);
    assert.match(readFileSync(`/proc/${pid}/cgroup`, "utf8"), new RegExp(`/${leaf.cgroupPath}\\n`, "u"));
    if (mode === "detached") assert.equal(readFileSync(`/proc/${pid}/environ`).length, 0, "the escaped helper scrubbed all markers");
    else if (process.getuid?.() !== 0) assert.throws(() => readFileSync(`/proc/${pid}/environ`), { code: "EACCES" });
    assert.equal(await ledger.prove({ terminate: false }), false, "early non-killing proof retains the lease while the helper lives");
    if (mode === "detached") assert.equal(await provenProcessTreeExit(child), true, "early per-process proof reaps the same boundary");
    else assert.deepEqual(await Promise.all(terminatePosixProcessBoundaries(ledger.owner)), [true], "shutdown uses the same boundary proof");
    assert.equal(alive(pid), false, "proof cannot precede the helper's death");
    assert.equal(await ledger.prove({ terminate: true }), true);
    assert.equal(unrelated.exitCode, null, "unrelated same-user processes are untouched");
    assert.equal(await waitForPendingKills(10_000), true);
  });
}
