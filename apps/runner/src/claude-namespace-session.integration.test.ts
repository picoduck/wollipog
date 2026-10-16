import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { claudeProjectPathKey, inspectClaudeBackgroundWork } from "./claude-background-work.js";
import {
  claudeNamespaceTempRoot,
} from "./claude-namespace-session.js";
import { killTreeAndWait, spawnAgent, terminateDescendantBoundaries, waitForPendingKills, type AgentProcess, type BwrapSpawnIsolation } from "./spawn.js";

const available = process.platform === "linux" && existsSync("/usr/bin/bwrap") && existsSync("/usr/bin/cc");
const root = mkdtempSync(join(tmpdir(), "wollipog-claude-namespace-test-"));
const worktree = join(root, "worktree");
mkdirSync(worktree);
const sibling = join(root, "sibling");
mkdirSync(sibling);
mkdirSync(join(root, ".git"));
writeFileSync(join(root, ".git", "config"), "protected");
after(() => rmSync(root, { recursive: true, force: true }));
const isolation: BwrapSpawnIsolation = {
  backend: "bwrap", command: "/usr/bin/bwrap", args: [], network: "inherit",
  protectedWorktree: { parent: root, path: worktree, gitWritableRoots: [] },
};

function launch(owner: object, script: string, sessionId = "namespace-integration"): AgentProcess {
  return spawnAgent({
    command: process.execPath,
    args: ["-e", script],
    cwd: worktree,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    context: { kind: "native" },
    isolation,
    claudeNamespaceProvider: true,
    claudeNamespaceSessionId: sessionId,
    descendantOwner: owner,
  });
}

async function closed(child: AgentProcess, input = ""): Promise<{ code: number | null; stdout: string; elapsed: number }> {
  const began = Date.now();
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const result = new Promise<{ code: number | null; stdout: string; elapsed: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("virtual Claude process did not close")), 5_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`Claude provider exited ${code}: ${stderr}`));
      else resolve({ code, stdout, elapsed: Date.now() - began });
    });
  });
  child.stdin.end(input);
  return result;
}

function hostPid(marker: string): number {
  const matches: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (cmdline.startsWith(`${process.execPath}\0`) && cmdline.endsWith(`${marker}\0`)) matches.push(Number(name));
    } catch { /* process exited */ }
  }
  assert.equal(matches.length, 1, `host PID scan: ${matches}`);
  return matches[0]!;
}

function workerPid(marker: string): number {
  const matches: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (cmdline.startsWith("/proc/self/exe\0") && cmdline.includes(marker)) matches.push(Number(name));
    } catch { /* process exited */ }
  }
  assert.equal(matches.length, 1, `worker PID scan: ${matches}`);
  return matches[0]!;
}

test("protected Claude namespace retains tasks across provider exits and reaps descendants", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  const hostHelper = spawn("/bin/sleep", ["20"], { stdio: "ignore" });
  try {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const key = claudeProjectPathKey(worktree);
    const providerTask = `/tmp/claude/${key}/${sessionId}/tasks/task-1.output`;
    const script = `require('node:child_process').spawn('/bin/sh',['-c',${JSON.stringify(`sleep .2; mkdir -p /tmp/claude/${key}/${sessionId}/tasks; echo done > ${providerTask}`)}],{detached:true,stdio:'ignore'}).unref(); process.stdout.write('first')`;
    const first = launch(owner, script);
    const firstPid = first.pid;
    const firstResult = await closed(first);
    assert.equal(firstResult.stdout, "first");
    assert.ok(firstResult.elapsed < 1000, `first provider waited ${firstResult.elapsed}ms`);
    const tempRoot = claudeNamespaceTempRoot(owner);
    assert.ok(tempRoot);
    const hostTask = join(tempRoot, "claude", key, sessionId, "tasks", "task-1.output");
    for (let i = 0; i < 100 && !existsSync(hostTask); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(readFileSync(hostTask, "utf8").trim(), "done");
    const discovered = inspectClaudeBackgroundWork(worktree, sessionId, [], { tempRoot });
    assert.deepEqual(discovered.incompleteArtifacts, [{ id: "task-1", outputFile: hostTask }]);
    const later = launch(owner, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(providerTask)},'utf8'))`);
    assert.equal(later.pid, firstPid);
    assert.equal((await closed(later)).stdout.trim(), "done");
    const adversary = launch(owner, `const fs=require('node:fs');let outcomes=[];try{process.kill(${hostHelper.pid},'SIGTERM');outcomes.push('host-signal-open')}catch(e){outcomes.push(e.code)};for(const pid of [1,process.ppid]){try{fs.openSync('/proc/'+pid+'/fd/1','r+');outcomes.push('control-open')}catch(e){outcomes.push(e.code)}};for(const path of [${JSON.stringify(join(sibling, "write"))},${JSON.stringify(join(root, ".git", "config"))},'/proc/${hostHelper.pid}/root/etc/hostname','/proc/${hostHelper.pid}/fd/1']){try{fs.writeFileSync(path,'bad');outcomes.push('write-open')}catch(e){outcomes.push(e.code)}};process.stdout.write(outcomes.join(','))`);
    const evidence = (await closed(adversary)).stdout;
    assert.ok(evidence.includes("ESRCH"), evidence);
    assert.ok(!evidence.includes("open"), evidence);
    assert.equal(hostHelper.exitCode, null);
    assert.equal(readFileSync(join(root, ".git", "config"), "utf8"), "protected");
    assert.equal(existsSync(join(sibling, "write")), false);
    if (existsSync("/usr/bin/python3")) {
      const ptrace = spawnAgent({
        command: "/usr/bin/python3",
        args: ["-c", "import ctypes,os; c=ctypes.CDLL(None,use_errno=True); r=c.ptrace(16,os.getppid(),0,0); print(r,ctypes.get_errno())"],
        cwd: worktree,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        context: { kind: "native" },
        isolation, claudeNamespaceProvider: true, descendantOwner: owner,
      });
      assert.equal((await closed(ptrace)).stdout.trim(), "-1 1");
    }
    const marker = `claude-owned-${process.pid}-${Date.now()}`;
    const inherited = launch(owner, `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)','${marker}'],{detached:true,stdio:['ignore','inherit','inherit']}).unref();process.stdout.write('exit')`);
    const inheritedResult = await closed(inherited);
    assert.equal(inheritedResult.stdout, "exit");
    assert.ok(inheritedResult.elapsed < 1000, `inherited stdio waited ${inheritedResult.elapsed}ms`);
    const ownedPid = hostPid(marker);
    terminateDescendantBoundaries(owner);
    assert.equal(await waitForPendingKills(6_000), true);
    for (let i = 0; i < 200 && existsSync(`/proc/${ownedPid}`); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(`/proc/${ownedPid}`), false);
    assert.equal(existsSync(tempRoot), false);
  } finally {
    hostHelper.kill("SIGKILL");
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("new namespace reconciles a stale task root for its exact session key", {
  skip: !available, timeout: 30_000,
}, async () => {
  const sessionId = "stale-namespace-test";
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  const stale = mkdtempSync(join(tmpdir(), `wollipog-claude-tasks-${key}-`));
  mkdirSync(join(stale, "claude"));
  writeFileSync(join(stale, "owner.json"), JSON.stringify({ pid: process.pid, startTime: "not-this-process" }));
  writeFileSync(join(stale, "claude", "old.output"), "stale");
  const owner = {};
  try {
    assert.equal((await closed(launch(owner, "process.stdout.write('fresh')", sessionId))).stdout, "fresh");
    assert.equal(existsSync(stale), false);
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
    rmSync(stale, { recursive: true, force: true });
  }
});

test("protected Claude namespace executes the configured symlink entry point", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  const entry = join(worktree, `claude-entry-${process.pid}`);
  const target = join(worktree, `claude-target-${process.pid}`);
  writeFileSync(target, "#!/bin/sh\ncase \"$0\" in *claude-entry-*) printf entry;; *) exit 72;; esac\n");
  chmodSync(target, 0o700);
  symlinkSync(target, entry);
  try {
    const child = spawnAgent({
      command: entry, args: [], cwd: worktree,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      context: { kind: "native" }, isolation,
      claudeNamespaceProvider: true, descendantOwner: owner,
    });
    assert.equal((await closed(child)).stdout, "entry");
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
    rmSync(entry, { force: true });
    rmSync(target, { force: true });
  }
});

test("protected Claude namespace accepts an inline settings-sized argument", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  try {
    const script = `process.stdout.write('settings-ok')/*${"x".repeat(64 * 1024)}*/`;
    assert.equal((await closed(launch(owner, script))).stdout, "settings-ok");
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("immediate cancel kills the established provider group and preserves later launches", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  try {
    assert.equal((await closed(launch(owner, "process.stdout.write('ready')"))).stdout, "ready");
    const retainedMarker = `retained-${process.pid}-${Date.now()}`;
    await closed(launch(owner, `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)','${retainedMarker}'],{detached:true,stdio:'ignore'}).unref()`));
    const retainedPid = hostPid(retainedMarker);
    const escapedMarker = `canceled-setsid-${process.pid}-${Date.now()}`;
    const escaping = launch(owner, `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)','${escapedMarker}'],{detached:true,stdio:'ignore'}).unref();process.stdout.write('started');setInterval(()=>{},1000)`);
    await new Promise<void>((resolve) => escaping.stdout.once("data", () => resolve()));
    const escapedPid = hostPid(escapedMarker);
    assert.equal(await killTreeAndWait(escaping), true);
    for (let i = 0; i < 100 && existsSync(`/proc/${escapedPid}`); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(`/proc/${escapedPid}`), false);
    assert.equal(existsSync(`/proc/${retainedPid}`), true);
    for (let attempt = 0; attempt < 20; attempt++) {
      const child = launch(owner, `setTimeout(()=>require('node:fs').writeFileSync('/tmp/claude/canceled-${attempt}','bad'),250)`);
      const stopped = await killTreeAndWait(child);
      assert.equal(stopped, true);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const tempRoot = claudeNamespaceTempRoot(owner);
    assert.ok(tempRoot);
    for (let attempt = 0; attempt < 20; attempt++) {
      assert.equal(existsSync(join(tempRoot, "claude", `canceled-${attempt}`)), false);
    }
    assert.equal((await closed(launch(owner, "process.stdout.write('next')"))).stdout, "next");
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("stalled generation cancellation reports failure without killing earlier tasks", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  let stoppedWorker: number | undefined;
  try {
    const retainedMarker = `stall-retained-${process.pid}-${Date.now()}`;
    await closed(launch(owner, `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)','${retainedMarker}'],{detached:true,stdio:'ignore'}).unref()`));
    const retainedPid = hostPid(retainedMarker);
    const activeMarker = `stall-active-${process.pid}-${Date.now()}`;
    const active = launch(owner, `process.stdout.write('running');setInterval(()=>{},1000);/*${activeMarker}*/`);
    await new Promise<void>((resolve) => active.stdout.once("data", () => resolve()));
    stoppedWorker = workerPid(activeMarker);
    process.kill(stoppedWorker, "SIGSTOP");
    assert.equal(await killTreeAndWait(active), false);
    assert.equal(existsSync(`/proc/${retainedPid}`), true);
    assert.equal(existsSync(claudeNamespaceTempRoot(owner)!), true);
    process.kill(stoppedWorker, "SIGCONT");
    stoppedWorker = undefined;
    await new Promise<void>((resolve, reject) => {
      active.once("close", () => resolve());
      setTimeout(() => reject(new Error("canceled worker never reported EXIT")), 3_000).unref();
    });
    assert.equal(existsSync(`/proc/${retainedPid}`), true);
    assert.equal((await closed(launch(owner, "process.stdout.write('still-ready')"))).stdout, "still-ready");
  } finally {
    if (stoppedWorker) {
      try { process.kill(stoppedWorker, "SIGCONT"); } catch { /* already gone */ }
    }
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("a provider process-group signal cannot kill the namespace or older tasks", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  try {
    const marker = `group-retained-${process.pid}-${Date.now()}`;
    await closed(launch(owner, `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)','${marker}'],{detached:true,stdio:'ignore'}).unref()`));
    const retainedPid = hostPid(marker);
    const taskRoot = claudeNamespaceTempRoot(owner);
    assert.ok(taskRoot);
    const current = launch(owner, "require('node:child_process').spawn('/bin/sh',['-c','kill 0'])");
    current.stdout.resume(); current.stderr.resume(); current.stdin.end();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("group-signaled provider never closed")), 5_000);
      current.once("close", () => { clearTimeout(timer); resolve(); });
      current.once("error", () => { /* provider failure is expected */ });
    });
    assert.equal(existsSync(`/proc/${retainedPid}`), true, "group signal killed earlier work");
    assert.equal(existsSync(taskRoot), true, "group signal removed the task root");
    assert.equal((await closed(launch(owner, "process.stdout.write('next')"))).stdout, "next");
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("direct worker SIGKILL fails only its provider generation", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  try {
    const marker = `worker-kill-retained-${process.pid}-${Date.now()}`;
    await closed(launch(owner, `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)','${marker}'],{detached:true,stdio:'ignore'}).unref()`));
    const retainedPid = hostPid(marker);
    const taskRoot = claudeNamespaceTempRoot(owner);
    assert.ok(taskRoot);
    const current = launch(owner, "process.kill(process.ppid, 'SIGKILL')");
    current.stdout.resume(); current.stderr.resume(); current.stdin.end();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker-killed provider never closed")), 5_000);
      current.once("close", () => { clearTimeout(timer); resolve(); });
      current.once("error", () => { /* synthetic provider failure is expected */ });
    });
    assert.equal(existsSync(`/proc/${retainedPid}`), true, "worker kill ended prior work");
    assert.equal(existsSync(taskRoot), true, "worker kill removed the task root");
    const activeMarker = `worker-parent-death-${process.pid}-${Date.now()}`;
    const active = launch(owner, `process.stdout.write('armed');setInterval(()=>{},1000);//${activeMarker}`);
    await new Promise<void>((resolve) => active.stdout.once("data", () => resolve()));
    const activePid = hostPid(activeMarker);
    const activeWorker = workerPid(activeMarker);
    const activeClosed = new Promise<void>((resolve) => active.once("close", () => resolve()));
    process.kill(activeWorker, "SIGKILL");
    await activeClosed;
    for (let i = 0; i < 100 && existsSync(`/proc/${activePid}`); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(`/proc/${activePid}`), false, "provider survived worker parent death");
    assert.equal(existsSync(`/proc/${retainedPid}`), true);
    assert.equal((await closed(launch(owner, "process.stdout.write('recovered')"))).stdout, "recovered");
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("Bubblewrap's namespace PID 1 reaper survives a same-UID provider signal", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  try {
    const marker = `init-signal-retained-${process.pid}-${Date.now()}`;
    await closed(launch(owner, `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)','${marker}'],{detached:true,stdio:'ignore'}).unref()`));
    const retainedPid = hostPid(marker);
    const taskRoot = claudeNamespaceTempRoot(owner);
    assert.ok(taskRoot);
    const identity = launch(owner, "const fs=require('node:fs');const status=fs.readFileSync('/proc/'+process.ppid+'/status','utf8');process.stdout.write(status.match(/^PPid:\\s+(\\d+)/m)[1])");
    assert.notEqual((await closed(identity)).stdout, "1", "the provider worker's parent is not Bubblewrap PID 1");
    // Bubblewrap owns PID 1; our supervisor is a different namespace PID.
    // This checks reaper behavior, not same-UID isolation from the supervisor.
    const attempt = launch(owner, "try{process.kill(1,'SIGKILL');process.stdout.write('sent')}catch(error){process.stdout.write(error.code)}");
    assert.ok(["sent", "EPERM"].includes((await closed(attempt)).stdout));
    assert.equal(existsSync(`/proc/${retainedPid}`), true);
    assert.equal(existsSync(taskRoot), true);
    assert.equal((await closed(launch(owner, "process.stdout.write('next')"))).stdout, "next");
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("a persistent provider worker reaps adopted short-lived children", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  try {
    const marker = `adopted-reap-${process.pid}-${Date.now()}`;
    const current = launch(owner, `require('node:child_process').spawn('/bin/sh',['-c','sleep .1 &'],{stdio:'ignore'});process.stdout.write('running');setInterval(()=>{},1000);/*${marker}*/`);
    await new Promise<void>((resolve) => current.stdout.once("data", () => resolve()));
    const worker = workerPid(marker);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const children = readFileSync(`/proc/${worker}/task/${worker}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    const zombies = children.filter((pid) => {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2)[0] === "Z";
      }
      catch { return false; }
    });
    assert.deepEqual(zombies, [], `worker retained zombie children: ${zombies}`);
    assert.equal(await killTreeAndWait(current), true);
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("the session supervisor reaps a short-lived one-shot background child", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  try {
    const marker = `oneshot-reap-${process.pid}-${Date.now()}`;
    await closed(launch(owner, `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},400)','${marker}'],{detached:true,stdio:'ignore'}).unref()`));
    const orphan = hostPid(marker);
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(existsSync(`/proc/${orphan}`), false, "session supervisor retained a zombie background child");
    assert.equal((await closed(launch(owner, "process.stdout.write('next')"))).stdout, "next");
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("a disposing namespace refuses a new provider before outer close", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  try {
    assert.equal((await closed(launch(owner, "process.stdout.write('ready')"))).stdout, "ready");
    terminateDescendantBoundaries(owner);
    assert.throws(() => launch(owner, "process.stdout.write('must-not-run')"), /disposing/);
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("late control frames after worker exit cannot dispose earlier retained work", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  try {
    const retainedMarker = `late-retained-${process.pid}-${Date.now()}`;
    await closed(launch(owner, `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)','${retainedMarker}'],{detached:true,stdio:'ignore'}).unref()`));
    const retainedPid = hostPid(retainedMarker);
    const taskRoot = claudeNamespaceTempRoot(owner);
    assert.ok(taskRoot);
    for (const action of ["cancel", "input", "end"] as const) {
      const workerMarker = `late-worker-${action}-${process.pid}-${Date.now()}`;
      const active = launch(owner, `const fs=require('node:fs');process.stdout.write('armed');const timer=setInterval(()=>{if(fs.existsSync('/tmp/claude/release-${action}')){clearInterval(timer);process.exit(0)}},1);/*${workerMarker}*/`);
      await new Promise<void>((resolve) => active.stdout.once("data", () => resolve()));
      const closedActive = new Promise<void>((resolve) => active.once("close", () => resolve()));
      const worker = workerPid(workerMarker);
      writeFileSync(join(taskRoot, "claude", `release-${action}`), "go");
      // Keep the host event loop from reading the queued EXIT until the
      // supervisor has reaped this worker and cleared its active generation.
      const deadline = Date.now() + 2_000;
      while (existsSync(`/proc/${worker}`) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      assert.equal(existsSync(`/proc/${worker}`), false, "worker did not exit during the host pause");
      if (action === "cancel") assert.equal(await killTreeAndWait(active), true);
      else if (action === "input") active.stdin.write("late");
      else active.stdin.end();
      await closedActive;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(existsSync(`/proc/${retainedPid}`), true, `late ${action} killed earlier work`);
      assert.equal(existsSync(taskRoot), true, `late ${action} disposed the session task root`);
    }
    assert.equal((await closed(launch(owner, "process.stdout.write('next')"))).stdout, "next");
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("pre-ready cancellation closes only a namespace that has accepted no provider", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  const child = launch(owner, "setInterval(()=>{},1000)");
  const taskRoot = claudeNamespaceTempRoot(owner);
  assert.ok(taskRoot);
  assert.equal(await killTreeAndWait(child), true);
  assert.equal(existsSync(taskRoot), false);
});

test("disposing during a queued provider launch cannot crash the runner", {
  skip: !available, timeout: 30_000,
}, async () => {
  const fixture = join(root, "dispose-queued-launch-fixture.mjs");
  const spawnModule = pathToFileURL(fileURLToPath(new URL("./spawn.ts", import.meta.url))).href;
  writeFileSync(fixture, [
    `import { spawnAgent, terminateDescendantBoundaries, waitForPendingKills } from ${JSON.stringify(spawnModule)};`,
    "const owner = {};",
    `const launch = (script, targetOwner = owner) => spawnAgent({ command: process.execPath, args: ['-e', script], cwd: ${JSON.stringify(worktree)}, env: { PATH: process.env.PATH }, context: { kind: 'native' }, isolation: ${JSON.stringify(isolation)}, claudeNamespaceProvider: true, descendantOwner: targetOwner });`,
    "const first = launch(\"process.stdout.write('ready')\");",
    "first.stdout.resume(); first.stderr.resume(); first.stdin.end();",
    "await new Promise((resolve, reject) => { first.once('error', reject); first.once('close', resolve); });",
    "const next = launch('setInterval(()=>{},1000)');",
    "next.stdout.resume(); next.stderr.resume();",
    "next.stdin.end(Buffer.alloc(256 * 1024, 65));",
    "terminateDescendantBoundaries(owner);",
    "if (!await waitForPendingKills(6000)) process.exit(2);",
    "const secondOwner = {};",
    "const secondReady = launch(\"process.stdout.write('ready')\", secondOwner);",
    "secondReady.stdout.resume(); secondReady.stderr.resume(); secondReady.stdin.end();",
    "await new Promise((resolve, reject) => { secondReady.once('error', reject); secondReady.once('close', resolve); });",
    "const streaming = launch(\"process.stdout.write('armed');process.stdin.resume();setInterval(()=>{},1000)\", secondOwner);",
    "streaming.stderr.resume();",
    "await new Promise((resolve) => streaming.stdout.once('data', resolve));",
    "streaming.stdin.write(Buffer.alloc(256 * 1024, 66));",
    "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);",
    "terminateDescendantBoundaries(secondOwner);",
    "if (!await waitForPendingKills(6000)) process.exit(3);",
    "await new Promise((resolve) => setTimeout(resolve, 200));",
    "process.stdout.write('survived\\n');",
  ].join("\n"));
  const fixtureRunner = spawn(process.execPath, ["--import", "tsx", fixture], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  fixtureRunner.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  fixtureRunner.stderr.on("data", (data: Buffer) => { error += data.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { fixtureRunner.kill("SIGKILL"); reject(new Error("dispose fixture hung")); }, 10_000);
    fixtureRunner.once("close", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  assert.equal(code, 0, error);
  assert.equal(output.trim(), "survived");
});

test("runner death kills the namespace and next launch reconciles its task root", {
  skip: !available, timeout: 30_000,
}, async () => {
  const sessionId = `runner-death-${process.pid}-${Date.now()}`;
  const marker = `runner-death-child-${process.pid}-${Date.now()}`;
  const fixture = join(root, "runner-death-fixture.mjs");
  const spawnModule = pathToFileURL(fileURLToPath(new URL("./spawn.ts", import.meta.url))).href;
  const namespaceModule = pathToFileURL(fileURLToPath(new URL("./claude-namespace-session.ts", import.meta.url))).href;
  writeFileSync(fixture, [
    `import { spawnAgent } from ${JSON.stringify(spawnModule)};`,
    `import { claudeNamespaceTempRoot } from ${JSON.stringify(namespaceModule)};`,
    "const owner = {};",
    `const child = spawnAgent({ command: process.execPath, args: ['-e', ${JSON.stringify(`require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)','${marker}'],{detached:true,stdio:'ignore'}).unref()`)}], cwd: ${JSON.stringify(worktree)}, env: { PATH: process.env.PATH }, context: { kind: 'native' }, isolation: ${JSON.stringify(isolation)}, claudeNamespaceProvider: true, claudeNamespaceSessionId: ${JSON.stringify(sessionId)}, descendantOwner: owner });`,
    "child.stdout.resume(); child.stderr.resume(); child.stdin.end();",
    "child.once('close', () => { process.stdout.write(JSON.stringify({ outerPid: child.pid, taskRoot: claudeNamespaceTempRoot(owner) }) + '\\n'); setInterval(() => {}, 1000); });",
  ].join("\n"));
  const runner = spawn(process.execPath, ["--import", "tsx", fixture], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let runnerError = "";
  runner.stdout.on("data", (data: Buffer) => { output += data.toString(); });
  runner.stderr.on("data", (data: Buffer) => { runnerError += data.toString(); });
  try {
    const deadline = Date.now() + 6_000;
    while (!output.includes("\n") && Date.now() < deadline) {
      if (runner.exitCode != null) throw new Error(`fixture exited ${runner.exitCode}: ${runnerError}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(output.includes("\n"), runnerError);
    const { outerPid, taskRoot } = JSON.parse(output.split("\n")[0]!) as { outerPid: number; taskRoot: string };
    const ownedPid = hostPid(marker);
    const runnerClosed = new Promise<void>((resolve) => runner.once("close", () => resolve()));
    runner.kill("SIGKILL");
    await runnerClosed;
    for (let i = 0; i < 200 && (existsSync(`/proc/${outerPid}`) || existsSync(`/proc/${ownedPid}`)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(`/proc/${outerPid}`), false);
    assert.equal(existsSync(`/proc/${ownedPid}`), false);
    assert.equal(existsSync(taskRoot), true);
    const owner = {};
    try {
      assert.equal((await closed(launch(owner, "process.stdout.write('recovered')", sessionId))).stdout, "recovered");
      assert.equal(existsSync(taskRoot), false);
    } finally {
      terminateDescendantBoundaries(owner);
      await waitForPendingKills(6_000);
    }
  } finally {
    if (runner.exitCode == null) runner.kill("SIGKILL");
  }
});

test("protected Claude transport acknowledges bounded stdin chunks and closes on provider exit", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  try {
    const payload = "x".repeat(512 * 1024);
    const child = launch(owner, "let n=0;process.stdin.on('data',c=>n+=c.length);process.stdin.on('end',()=>process.stdout.write(String(n)))");
    assert.equal((await closed(child, payload)).stdout, String(Buffer.byteLength(payload)));
    const persistent = launch(owner, "process.stdin.setEncoding('utf8');process.stdin.on('data',s=>process.stdout.write(s.toUpperCase()))");
    let output = "";
    persistent.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const completed = new Promise<void>((resolve, reject) => {
      persistent.once("error", reject);
      persistent.once("close", (code) => code === 0 ? resolve() : reject(new Error(`persistent provider exited ${code}`)));
    });
    persistent.stdin.write("first\n");
    persistent.stdin.write("second\n");
    persistent.stdin.end();
    await completed;
    assert.equal(output, "FIRST\nSECOND\n");
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});

test("broken namespace control closes the virtual provider and removes owned task files", {
  skip: !available, timeout: 30_000,
}, async () => {
  const owner = {};
  try {
    const marker = `claude-broken-${process.pid}-${Date.now()}`;
    const background = launch(owner, `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)','${marker}'],{detached:true,stdio:'ignore'}).unref()`);
    await closed(background);
    const ownedPid = hostPid(marker);
    const tempRoot = claudeNamespaceTempRoot(owner);
    assert.ok(tempRoot);
    const active = launch(owner, "setInterval(()=>{},1000)");
    const closedActive = new Promise<void>((resolve, reject) => {
      active.once("error", () => { /* namespace failure is expected */ });
      active.once("close", () => resolve());
      setTimeout(() => reject(new Error("virtual provider held after control broke")), 4_000).unref();
    });
    assert.ok(active.pid);
    process.kill(-active.pid, "SIGKILL");
    await closedActive;
    for (let i = 0; i < 200 && existsSync(`/proc/${ownedPid}`); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(existsSync(`/proc/${ownedPid}`), false);
    assert.equal(existsSync(tempRoot), false);
  } finally {
    terminateDescendantBoundaries(owner);
    await waitForPendingKills(6_000);
  }
});
