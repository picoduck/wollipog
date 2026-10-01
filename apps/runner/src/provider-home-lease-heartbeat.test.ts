import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { transformSync } from "esbuild";
import { AsyncProviderHomeLeaseRegistry } from "./provider-home-lease-async.js";
import { LEASE_WORKER_LIMITS } from "./provider-home-lease-worker-protocol.js";

const owner = "a".repeat(64);

/** Execute the actual production heartbeat function without booting a runner or live provider.
 * The socket has the same synchronous send/ping contract and returns an immediate pong. */
function heartbeat(interval: number) {
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = index.indexOf("function startHeartbeat("), end = index.indexOf("\nfunction ", start + 1);
  assert.ok(start > 0 && end > start);
  const source = index.slice(start, end);
  let last = performance.now(); const delays: number[] = [];
  const context = vm.createContext({ setInterval, clearInterval, Date,
    WebSocket: { OPEN: 1 }, MAX_MISSED_HEARTBEAT_PONGS: 2, MAX_INITIAL_MISSED_HEARTBEAT_PONGS: 4,
    metadata: { agents: [] }, staleNativeInstallationKey: () => "[]", reportedStaleInstallationKey: "[]",
    config: { runnerId: "isolated-lease-heartbeat" }, log: () => {}, heartbeatTimer: null,
    missedHeartbeatPongs: 0, heartbeatPongObserved: false,
    stopHeartbeat() { if (context.heartbeatTimer) clearInterval(context.heartbeatTimer); },
  });
  const socket = { readyState: 1, send(frame: string) {
    assert.equal(JSON.parse(frame).type, "heartbeat");
    const now = performance.now(); delays.push(Math.max(0, now - last - interval)); last = now;
  }, ping() { context.missedHeartbeatPongs = 0; context.heartbeatPongObserved = true; },
  terminate() { assert.fail("lease work made the healthy socket terminate"); } };
  vm.runInContext(transformSync(source, { loader: "ts", format: "cjs" }).code, context);
  context.startHeartbeat(socket, interval);
  return { stop() { clearInterval(context.heartbeatTimer); }, report() {
    return { intervalMs: interval, dispatches: delays.length, maxDispatchDelayMs: Math.max(0, ...delays),
      heartbeatSourceSha256: createHash("sha256").update(source).digest("hex") };
  } };
}

async function measure(t: { diagnostic(message: string): void }, scenario: string, action: () => Promise<void>, normal = false) {
  const timers = [heartbeat(100), ...(normal ? [heartbeat(10_000)] : [])];
  try {
    await pause(220);
    const begin = performance.now(); await action(); const operationDurationMs = performance.now() - begin;
    await pause(120);
    const reports = timers.map(timer => timer.report());
    t.diagnostic(JSON.stringify({ scenario, operationDurationMs, heartbeat: reports }));
    for (const report of reports) {
      assert.ok(report.dispatches > 0, "the production heartbeat dispatched while lease work was pending");
      assert.ok(report.maxDispatchDelayMs <= LEASE_WORKER_LIMITS.heartbeatDelayMs,
        `${scenario}: heartbeat ${report.maxDispatchDelayMs} ms late; operation ${operationDurationMs} ms`);
    }
  } finally { for (const timer of timers) timer.stop(); }
}

function legacy(home: string, transitions: number) {
  const root = join(home, ".agent-manager/provider-home-leases-v1"), lock = join(root, "mutable-home.lock");
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  let previous = { version: 2, state: "active", ownerHash: owner, leaseId: randomUUID(), previousLeaseId: null as string | null,
    previousRecordHash: null as string | null, recoveredEntriesHash: createHash("sha256").update("[]").digest("hex") as string | undefined,
    pid: 999999, hostname: hostname(), provider: "skills", createdAt: "2026-10-01", padding: "p".repeat(3300) };
  let raw = `${JSON.stringify(previous)}\n`; const anchor = join(root, "mutable-home.recovery.json");
  writeFileSync(anchor, raw, { mode: 0o600 }); linkSync(anchor, join(lock, "checkpoint.json"));
  linkSync(anchor, join(lock, `lease-${previous.leaseId}.json`));
  for (let i = 0; i < transitions; i++) {
    const next = { ...previous, recoveredEntriesHash: undefined, state: i % 2 === 0 ? "released" : "active", leaseId: randomUUID(),
      previousLeaseId: previous.leaseId, previousRecordHash: createHash("sha256").update(raw).digest("hex") };
    raw = `${JSON.stringify(next)}\n`; const name = `next-${previous.leaseId}.json`;
    writeFileSync(join(root, name), raw, { mode: 0o600 }); linkSync(join(root, name), join(lock, name)); previous = next;
  }
}

test("maximal padded migration keeps the production 10-second heartbeat within 500 ms", { skip: process.platform !== "linux", timeout: 330_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worker-migration-")), home = join(root, "home");
  const registry = new AsyncProviderHomeLeaseRegistry(owner, { helperDataDir: join(root, "runner") });
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  legacy(home, 4090);
  await measure(t, "maximal-4090-transitions-padding-3300", async () => {
    assert.equal(await registry.acquireHome(home), true); assert.equal(await registry.releaseHome(home), true);
  }, true);
});

test("cold initialization and malformed-evidence refusal keep heartbeat dispatch responsive", async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worker-cold-")), home = join(root, "home");
  const registry = new AsyncProviderHomeLeaseRegistry(owner, { helperDataDir: join(root, "runner") });
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  await measure(t, "cold-init-acquire-release", async () => {
    assert.equal(await registry.acquireHome(home), true); assert.equal(await registry.releaseHome(home), true);
  });
  const anchor = join(home, ".agent-manager/provider-home-leases-v1/mutable-home.recovery.json");
  writeFileSync(anchor, "malformed ownership evidence");
  await measure(t, "initialization-refusal", async () => { await assert.rejects(registry.acquireHome(home)); });
});

test("native helper initialization failure leaves HOME untouched and heartbeat responsive", { skip: process.platform === "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worker-helper-failure-"));
  const home = join(root, "home");
  const loader = createRequire(import.meta.url).resolve("tsx/cjs");
  const io = fileURLToPath(new URL("./provider-home-lease-io.ts", import.meta.url));
  const entry = fileURLToPath(new URL("./provider-home-lease-worker.ts", import.meta.url));
  const registry = new AsyncProviderHomeLeaseRegistry(owner, {
    helperDataDir: join(root, "runner"),
    workerFactoryForTest: data => new Worker(
      `require(${JSON.stringify(loader)});require(${JSON.stringify(io)}).refuseLeaseIoProbeForTest(()=>true);require(${JSON.stringify(entry)});`,
      { eval: true, execArgv: [], workerData: data, env: { ...process.env, HOME: root, TMPDIR: root } },
    ),
  });
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  await measure(t, "native-helper-initialization-failure", async () => {
    await assert.rejects(registry.acquireHome(home), /helper unavailable|refused/iu);
    assert.equal(existsSync(home), false);
  });
});

async function waitMarker(child: ReturnType<typeof spawn>, marker: string): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (!existsSync(marker)) {
    assert.equal(child.exitCode, null, "fixture process exited before its checkpoint");
    assert.equal(child.signalCode, null); assert.ok(performance.now() < deadline, "fixture checkpoint deadline");
    await pause(10);
  }
}

test("a held POSIX fence delays release duration while heartbeats continue", { skip: process.platform !== "linux", timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worker-fence-")), home = join(root, "home");
  const registry = new AsyncProviderHomeLeaseRegistry(owner, { helperDataDir: join(root, "runner") });
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 9; i++) { await registry.acquireHome(home); assert.equal(await registry.releaseHome(home), true); }
  await registry.acquireHome(home);
  const guard = join(home, ".agent-manager/provider-home-leases-v1/mutable-home.lock/protocol-v4.json"), marker = join(root, "reader");
  const child = spawn("python3", ["-c", `import fcntl,time\nf=open(${JSON.stringify(guard)},'rb')\nfcntl.flock(f,fcntl.LOCK_SH)\nopen(${JSON.stringify(marker)},'w').write('ready')\ntime.sleep(1.5)`],
    { env: { PATH: process.env.PATH, HOME: root }, stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  await waitMarker(child, marker);
  await measure(t, "release-shared-reader-held-1500ms", async () => { assert.equal(await registry.releaseHome(home), true); });
  await exited;
});

test("SIGKILL at candidate-durable recovers through the worker without delaying heartbeat", { skip: process.platform !== "linux", timeout: 40_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worker-recovery-")), home = join(root, "home");
  const registry = new AsyncProviderHomeLeaseRegistry(owner, { helperDataDir: join(root, "runner") });
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 8; i++) { await registry.acquireHome(home); assert.equal(await registry.releaseHome(home), true); }
  const marker = join(root, "candidate"), script = join(root, "writer.mts");
  const module = fileURLToPath(new URL("./provider-home-lease-async.ts", import.meta.url));
  writeFileSync(script, `import {AsyncProviderHomeLeaseRegistry} from ${JSON.stringify(module)};\nconst r=new AsyncProviderHomeLeaseRegistry(${JSON.stringify(owner)}, {helperDataDir:${JSON.stringify(join(root, "runner"))},engineOptionsForTest:{nativeCheckpointBarrierForTest:{boundary:'candidate-durable',marker:${JSON.stringify(marker)}}}});await r.acquireHome(${JSON.stringify(home)});await r.close();`);
  const child = spawn(process.execPath, ["--import", "tsx", script], { env: { ...process.env, HOME: root, TMPDIR: root }, stdio: "ignore" });
  const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  await waitMarker(child, marker); child.kill("SIGKILL"); await exited;
  await measure(t, "runner-SIGKILL-candidate-durable-recovery", async () => {
    assert.equal(await registry.acquireHome(home), true); assert.equal(await registry.releaseHome(home), true);
  });
});
