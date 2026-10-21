import assert from "node:assert/strict";
import cp, { spawn, type ChildProcess } from "node:child_process";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cgroupDelegationDirectory, currentCgroupDirectory, LinuxCgroupBoundary, prepareLinuxCgroupLaunch, providerContainmentIdentity, providerContainmentStatus, systemdUserDelegationReply, type LinuxCgroupBoundaryIo } from "./linux-cgroup.js";
import { linuxCgroupHelper, stageLinuxCgroupHelper } from "./linux-cgroup-helper.js";
import { PosixProcessBoundary, terminatePosixProcessBoundaries } from "./posix-process-tree.js";
import { provenProcessTreeExit, ProviderProcessLedger, spawnAgent, waitForPendingKills } from "./spawn.js";

const identity = Object.freeze({ kind: "linux-cgroup-v2" as const, bootId: "boot", mountRoot: "/", cgroupPath: "test/leaf", inode: "42" });

function controlledBoundary() {
  const state = { populated: true, terms: 0, kills: 0, closed: 0, removed: 0, reads: 0, now: 0, unreadable: false, killFails: false, stuck: false };
  const io: LinuxCgroupBoundaryIo = {
    populated() { state.reads++; if (state.unreadable) throw new Error("identity changed"); return state.populated; },
    async term() { state.terms++; },
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

test("delegation must belong to the nearest service/scope, never an ancestor user manager", () => {
  const mountPoint = "/sys/fs/cgroup";
  const scope = "/user.slice/user-1000.slice/user@1000.service/app.slice/runner.scope";
  assert.equal(cgroupDelegationDirectory({ directory: mountPoint + scope + "/worker", mountRoot: "/", mountPoint }), mountPoint + scope);
  assert.equal(cgroupDelegationDirectory({ directory: mountPoint + "/worker", mountRoot: scope, mountPoint }), mountPoint);
  assert.equal(cgroupDelegationDirectory({ directory: mountPoint, mountRoot: scope + "/worker", mountPoint }), undefined,
    "a hidden ancestor unit cannot be attested through a namespaced mount");
});

test("user-manager evidence requires a loaded delegated unit at the exact cgroup path", () => {
  const hierarchy = "/user.slice/user-1000.slice/user@1000.service/app.slice/runner.scope";
  const reply = `LoadState=loaded\nDelegate=yes\nControlGroup=${hierarchy}\n`;
  assert.equal(systemdUserDelegationReply(reply, hierarchy), true);
  for (const invalid of [reply.replace("yes", "no"), reply.replace("loaded", "not-found"),
    reply.replace(hierarchy, hierarchy + "/child"), reply.replace(hierarchy, "/user.slice"),
    reply.replace("Delegate=yes\n", ""), reply + "Delegate=yes\n", ""]) {
    assert.equal(systemdUserDelegationReply(invalid, hierarchy), false, invalid);
  }
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
  assert.equal(state.terms, 1, "retained descendants receive grace even after their root exits");
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
  assert.equal(state.kills, 1, "uncertain admission cannot disable cleanup of our own cgroup");
  boundary.cancelSpawn();
});

test("an admission timeout does not discard a late acknowledgement or disable kernel cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { boundary, state, pipe } = controlledBoundary();
  const first = boundary.terminate();
  t.mock.timers.tick(5_000);
  assert.equal(await first, false);
  assert.equal(state.kills, 1);
  assert.equal(state.closed, 0, "uncertain emptiness still retains the lease proof");
  pipe.end("1");
  assert.equal(await boundary.terminate(), true, "late admission can be consumed by the next proof");
  assert.equal(state.closed, 1);
});

for (const scenario of ["no-mount", "marked", "unmarked", "user-delegated", "user-namespaced", "user-not-delegated", "user-wrong-cgroup", "user-query-failed"] as const) {
test(`${scenario} retains the marker/parent-link API and reports fallback before unsafe writes`, { skip: process.platform !== "linux" }, () => {
  const delegated = scenario === "marked" || scenario === "user-delegated" || scenario === "user-namespaced";
  const reason = delegated || scenario === "no-mount" ? "cgroup-unavailable" : "cgroup-not-delegated";
  const module = new URL("./linux-cgroup.ts", import.meta.url).href;
  const helperModule = new URL("./linux-cgroup-helper.ts", import.meta.url).href;
  const spawnModule = new URL("./spawn.ts", import.meta.url).href;
  const code = `
    import fs from 'node:fs';
    import cp from 'node:child_process';
    import os from 'node:os';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import assert from 'node:assert/strict';
    const cgroup = await import(${JSON.stringify(module)});
    const {linuxCgroupHelper} = await import(${JSON.stringify(helperModule)});
    linuxCgroupHelper();
    const original = {mkdirSync:fs.mkdirSync,readFileSync:fs.readFileSync,statfsSync:fs.statfsSync};
    const originalSpawn = cp.spawnSync;
    const mount = fs.mkdtempSync(path.join(os.tmpdir(),'wollipog-delegation-mock-'));
    fs.mkdirSync(path.join(mount,'runner.scope'));
    fs.mkdirSync(path.join(mount,'runner.scope','worker'));
    fs.mkdirSync(path.join(mount,'worker'));
    const userUnit = ${scenario.startsWith("user-")};
    const membership = userUnit ? '/runner.scope/worker' : '/';
    let queries = 0;
    cp.spawnSync = (file,args,options) => {
      if (args[0] === '--delegation-probe') return {status:${scenario === "marked" ? 0 : 3}};
      if (file === '/usr/bin/systemctl') {
        queries++;
        assert.equal(args.at(-1),'runner.scope','query the nearest unit, not an ancestor');
        assert.equal(args[0],'--user');
        return {status:${scenario === "user-query-failed" ? 1 : 0},stdout:'LoadState=loaded\\nDelegate=${scenario === "user-not-delegated" ? "no" : "yes"}\\nControlGroup=${scenario === "user-wrong-cgroup" ? "/ancestor/runner.scope" : "/runner.scope"}\\n'};
      }
      return originalSpawn(file,args,options);
    };
    fs.readFileSync = (file,...args) => {
      if (file === '/proc/self/mountinfo') return ${scenario === "no-mount" ? "''" : "'30 20 0:30 " + (scenario === "user-namespaced" ? "/runner.scope" : "/") + " ' + mount + ' rw - cgroup2 cgroup rw\\n'"};
      if (file === '/proc/self/cgroup') return '0::' + membership + '\\n';
      if (file === '/proc/sys/kernel/random/boot_id') return '00000000-0000-0000-0000-000000000001';
      return original.readFileSync(file,...args);
    };
    fs.statfsSync = (file,...args) => file.startsWith(mount) ? {type:0x63677270} : original.statfsSync(file,...args);
    let writes = 0;
    fs.mkdirSync = () => { writes++; throw Object.assign(new Error('unavailable delegation'), {code:'EROFS'}); };
    syncBuiltinESMExports();
    assert.equal(cgroup.providerContainmentIdentity(), undefined);
    Object.assign(fs,original);
    cp.spawnSync = originalSpawn;
    syncBuiltinESMExports();
    fs.rmSync(mount,{recursive:true,force:true});
    assert.equal(writes, ${delegated ? 1 : 0});
    assert.equal(queries, ${scenario.startsWith("user-") ? 1 : 0});
    assert.deepEqual(cgroup.providerContainmentStatus(), {proofStandard:'marker-parent-links',reason:${JSON.stringify(reason)}});
    const {spawnAgent,provenProcessTreeExit} = await import(${JSON.stringify(spawnModule)});
    const child = spawnAgent({command:process.execPath,args:['-e',''],cwd:process.cwd()});
    assert.equal(child.posixBoundary.proofStandard,'marker-parent-links');
    await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
    assert.equal(await provenProcessTreeExit(child),true);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { timeout: 20_000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes('proofStandard=marker-parent-links reason=' + reason));
});
}

test("native launcher refuses a non-cgroup descriptor before executing provider code", { skip: process.platform !== "linux" }, () => {
  const result = spawnSync(linuxCgroupHelper(), ["--exec", "/bin/sh", "-c", "echo provider-was-executed"], {
    encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.status, 125);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /provider was not executed/u);
});

test("a removed temporary helper is safely restaged; an unexecutable root can fall back to data", { skip: process.platform !== "linux" }, (t) => {
  const initial = linuxCgroupHelper();
  rmSync(dirname(initial), { recursive: true, force: true });
  const replacement = linuxCgroupHelper();
  assert.notEqual(replacement, initial);
  assert.equal(spawnSync(replacement, [], { timeout: 5_000 }).status, 125);
  const directory = mkdtempSync(join(tmpdir(), "wollipog-cgroup-staging-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const temporary = join(directory, "temporary");
  const data = join(directory, "data");
  fs.mkdirSync(temporary); fs.mkdirSync(data);
  const staged = stageLinuxCgroupHelper([temporary, data], (path) => path.startsWith(data + "/"));
  assert.ok(staged.path.startsWith(data + "/"));
  staged.verify();
});

function requireContainment(t: { skip(message: string): void }): boolean {
  if (providerContainmentIdentity()) return true;
  assert.notEqual(process.env.WOLLIPOG_TEST_REQUIRE_CGROUP, "1", "real delegated cgroup containment was required");
  t.skip(`containment unavailable: ${providerContainmentStatus().reason}`);
  return false;
}

test("user-manager native validation exercises the real query even if a delegation marker exists", {
  skip: process.platform !== "linux" || process.env.WOLLIPOG_TEST_EXPECT_USER_MANAGER_QUERY !== "1",
}, (t) => {
  const original = cp.spawnSync;
  let queries = 0;
  const mock = t.mock.method(cp, "spawnSync", (...args: unknown[]) => {
    // Only the marker's absence is simulated. The actual systemctl query, manager reply,
    // directory identity, writes and all later contained launches remain real kernel I/O.
    if (Array.isArray(args[1]) && args[1][0] === "--delegation-probe") {
      return { pid: 0, output: [null, null, null], stdout: null, stderr: null, status: 3, signal: null };
    }
    if (args[0] === "/usr/bin/systemctl") queries++;
    return Reflect.apply(original, cp, args);
  });
  syncBuiltinESMExports();
  try {
    assert.ok(providerContainmentIdentity(), "the real user manager must attest delegated containment");
    assert.equal(queries, 1, "containment must be initialized through the real user-manager query");
    assert.equal(providerContainmentStatus().proofStandard, "linux-cgroup-v2");
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("successful preparation clears a transient boundary-creation failure", { skip: process.platform !== "linux" }, (t) => {
  if (!requireContainment(t)) return;
  const original = fs.mkdirSync;
  fs.mkdirSync = () => { throw Object.assign(new Error("transient descriptor failure"), { code: "EMFILE" }); };
  syncBuiltinESMExports();
  try { assert.throws(() => prepareLinuxCgroupLaunch(), /provider was not executed/u); }
  finally { fs.mkdirSync = original; syncBuiltinESMExports(); }
  assert.equal(providerContainmentStatus().reason, "boundary-creation-failed");
  const launch = prepareLinuxCgroupLaunch();
  assert.equal(providerContainmentStatus().reason, "available");
  launch!.boundary.cancelSpawn();
});

test("a missing provider executable still emits its ENOENT ChildProcess error", { skip: process.platform !== "linux" }, async () => {
  const child = spawnAgent({ command: "/nonexistent-wollipog-cgroup-test-provider", args: [], cwd: process.cwd() });
  let error: NodeJS.ErrnoException | undefined;
  const events: string[] = [];
  child.on("spawn", () => events.push("spawn"));
  child.on("exit", () => events.push("exit"));
  child.on("error", (value: NodeJS.ErrnoException) => { events.push("error"); error = value; });
  child.stderr.resume();
  await new Promise<void>((resolve) => child.once("close", () => { events.push("close"); resolve(); }));
  assert.equal(error?.code, "ENOENT");
  assert.equal((error as { path?: string })?.path, "/nonexistent-wollipog-cgroup-test-provider");
  assert.equal(events.filter((event) => event === "error").length, 1);
  assert.ok(events.indexOf("error") < events.indexOf("close"), events.join(","));
  if (child.posixBoundary?.proofStandard === "linux-cgroup-v2") {
    assert.equal(await provenProcessTreeExit(child), true, "wrapper exec failure still settles its tree proof");
  }
  // The containment launcher really spawned and must remain observable for root reaping.
  assert.deepEqual(events.filter((event) => event !== "error"),
    child.posixBoundary?.proofStandard === "linux-cgroup-v2" ? ["spawn", "exit", "close"] : ["close"]);
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

for (const mode of ["detached", "nondumpable", "term", "delayed-admission"]) {
  test(`Linux cgroup contains and reaps a ${mode} setsid helper before lease-release proof`, { skip: process.platform !== "linux" }, async (t) => {
    if (!requireContainment(t)) return;
    const parentIdentity = providerContainmentIdentity()!;
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
    const child = ledger.record(spawnAgent({ command: helper, args: [mode === "delayed-admission" ? "detached" : mode, pidfile], cwd: directory, descendantOwner: ledger.owner }));
    t.after(async () => { await child.posixBoundary?.terminate(); });
    if (mode === "delayed-admission") {
      const unblockAt = performance.now() + 6_000;
      while (performance.now() < unblockAt) { /* queue the admission ack behind an event-loop stall */ }
    }
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
    if (mode !== "nondumpable") assert.equal(readFileSync(`/proc/${pid}/environ`).length, 0, "the escaped helper scrubbed all markers");
    else if (process.getuid?.() !== 0) assert.throws(() => readFileSync(`/proc/${pid}/environ`), { code: "EACCES" });
    assert.equal(await ledger.prove({ terminate: false }), false, "early non-killing proof retains the lease while the helper lives");
    if (mode === "detached") assert.equal(await provenProcessTreeExit(child), true, "early per-process proof reaps the same boundary");
    else assert.deepEqual(await Promise.all(terminatePosixProcessBoundaries(ledger.owner)), [true], "shutdown uses the same boundary proof");
    assert.equal(alive(pid), false, "proof cannot precede the helper's death");
    if (mode === "term") assert.equal(readFileSync(pidfile + ".term", "utf8"), "term", "a retained setsid descendant receives TERM before forced cleanup");
    assert.equal(await ledger.prove({ terminate: true }), true);
    assert.equal(unrelated.exitCode, null, "unrelated same-user processes are untouched");
    assert.equal(await waitForPendingKills(10_000), true);
  });
}
