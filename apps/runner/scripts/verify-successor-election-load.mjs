import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// Opt-in #2378 validation: two owned CPU + 16 KiB write/delete workers remain active
// during five consecutive executions of the exact real-process election fixture.
const root = mkdtempSync(join(tmpdir(), "wollipog-successor-election-load-"));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const counters = new Int32Array(new SharedArrayBuffer(12));
const workers = [];
let child;
let workerFailure;
let terminating = false;
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());
function healthy() {
  if (controller.signal.aborted) throw new Error("successor load validation cancelled");
  if (workerFailure) throw new Error(workerFailure);
}
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function killOwnedTree(current) {
  if (current.exitCode !== null || current.signalCode !== null || !current.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => execFile("taskkill", ["/PID", String(current.pid), "/T", "/F"], { timeout: 5_000 }, (error) => {
      if (!error || error.code === 128) resolve(); else reject(new Error("owned validation tree termination failed"));
    }));
  } else {
    try { process.kill(-current.pid, "SIGKILL"); } catch { current.kill("SIGKILL"); }
  }
}
async function run() {
  healthy();
  let output = "";
  const current = spawn(process.execPath, [
    "--import", "tsx", "--test", "--test-reporter=tap", "--test-timeout=30000",
    "--test-name-pattern=^the exclusive successor elects one winner across real runner processes$",
    "apps/runner/src/provider-home-lease.test.ts",
  ], { cwd: repo, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "inherit"] });
  child = current;
  const closed = new Promise((resolve, reject) => {
    current.once("error", reject);
    current.once("close", (code, signal) => {
      child = undefined;
      if (code === 0) resolve(); else reject(new Error(`focused validation exit=${code} signal=${signal}`));
    });
  });
  // Attach rejection handling before cancellation can initiate cleanup.
  void closed.catch(() => {});
  current.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
  // Let the current bounded fixture finish its owned-tree cleanup on cancellation.
  // Killing its test runner immediately would strand detached contenders.
  try { await bounded(closed, 40_000, "focused validation exceeded its outer deadline"); }
  finally {
    if (child === current) {
      await killOwnedTree(current);
      await bounded(closed.catch(() => {}), 5_000, "owned validation tree did not close");
    }
  }
  const lines = output.split(/\r?\n/);
  assert.ok(lines.some((line) => /^ok \d+ - the exclusive successor elects one winner across real runner processes$/.test(line)), "the exact focused test must run");
  for (const expected of ["# tests 1", "# pass 1", "# fail 0", "# cancelled 0", "# skipped 0"]) {
    assert.ok(lines.includes(expected), `unexpected focused result: ${expected}`);
  }
}
const workerSource = `
  const { workerData, parentPort } = require("node:worker_threads");
  const fs = require("node:fs");
  const counters = new Int32Array(workerData.counters);
  const data = Buffer.alloc(16 * 1024, 1);
  let value = 1;
  while (Atomics.load(counters, 0) === 0) {
    for (let i = 0; i < 100000; i++) value = Math.imul(value ^ i, 1664525) + 1013904223;
    fs.writeFileSync(workerData.path, data);
    fs.unlinkSync(workerData.path);
    if (Atomics.add(counters, workerData.index + 1, 1) === 0) parentPort.postMessage("ready");
  }
`;
try {
  console.log(`Successor election load: ${process.platform} ${release()} ${process.arch}; Node ${process.version}; ${cpus().length} CPUs; two CPU + 16 KiB write/delete workers; five runs`);
  for (let index = 0; index < 2; index++) {
    const worker = new Worker(workerSource, { eval: true, workerData: { counters: counters.buffer, index, path: join(root, `load-${index}`) } });
    workers.push(worker);
    worker.on("error", () => { workerFailure ??= `load worker ${index} runtime-error`; });
    worker.on("exit", (code) => { if (!terminating) workerFailure ??= `load worker ${index} unexpected-exit=${code}`; });
    await bounded(new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", () => reject(new Error(`load worker ${index} startup-error`)));
      worker.once("exit", () => reject(new Error(`load worker ${index} startup-exit`)));
    }), 10_000, "load worker readiness timed out");
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    healthy();
    const before = [...counters];
    console.log(`Successor election focused load run ${attempt} of 5`);
    await run();
    healthy();
    for (let index = 1; index <= 2; index++) assert.ok(counters[index] > before[index], `load worker ${index - 1} made no progress`);
    console.log(`Load iterations: ${[...counters].slice(1).join(", ")}`);
  }
} finally {
  terminating = true;
  Atomics.store(counters, 0, 1);
  if (child) await killOwnedTree(child);
  await bounded(Promise.all(workers.map((worker) => worker.terminate())), 5_000, "load worker cleanup timed out");
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
