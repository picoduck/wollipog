import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { runFocusedValidation, combineFailures } from "./successor-load-lifecycle.mjs";

// Opt-in #2378 validation: two owned CPU + 16 KiB write/delete workers remain active
// during five consecutive executions of the exact real-process election fixture.
const root = mkdtempSync(join(tmpdir(), "wollipog-successor-election-load-"));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const counters = new Int32Array(new SharedArrayBuffer(12));
const workers = [];
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
async function run() {
  healthy();
  await runFocusedValidation({
    cwd: repo,
    args: [
      "--import", "tsx", "--test", "--test-reporter=tap", "--test-timeout=35000",
      "--test-name-pattern=^the exclusive successor elects one winner across real runner processes$",
      "apps/runner/src/provider-home-lease.test.ts",
    ],
    onOutput: (chunk) => process.stdout.write(chunk),
  });
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
let failure;
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
} catch (error) { failure = error; }
terminating = true;
Atomics.store(counters, 0, 1);
let workersClosed = false;
try {
  await bounded(Promise.all(workers.map((worker) => worker.terminate())), 5_000, "load worker cleanup timed out");
  workersClosed = true;
} catch (error) { failure = combineFailures(failure, error); }
if (workersClosed) {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
  catch (error) { failure = combineFailures(failure, error); }
} else {
  failure = combineFailures(failure, new Error(`load worker state retained at ${root}`));
}
if (failure) throw failure;
