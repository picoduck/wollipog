import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { cpus, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

// Opt-in validation for #3045. Two owned workers continuously consume CPU and write/delete 16 KiB
// files while ten consecutive focused test runs execute. Production lock timeouts are untouched.
const root = mkdtempSync(join(tmpdir(), "wollipog-lock-publication-load-"));
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const counters = new Int32Array(new SharedArrayBuffer(8));
const workers = [];
let child;
const workerSource = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const counters = new Int32Array(workerData.counters);
const data = Buffer.alloc(16 * 1024, 1);
let value = 1;
for (;;) {
  for (let i = 0; i < 100000; i++) value = Math.imul(value ^ i, 1664525) + 1013904223;
  fs.writeFileSync(workerData.path, data);
  fs.unlinkSync(workerData.path);
  if (Atomics.add(counters, workerData.index, 1) === 0) parentPort.postMessage("ready");
}
`;

async function run() {
  let output = "";
  child = spawn(process.execPath, [
    "--import", "tsx", "--test", "--test-reporter=tap", "--test-timeout=120000",
    "--test-name-pattern=^result publication |^an acquirer that stalled right after publishing",
    "apps/runner/src/session-store-lock.test.ts",
  ], { cwd: repo, stdio: ["ignore", "pipe", "inherit"] });
  const current = child;
  current.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
  await new Promise((resolve, reject) => {
    current.once("error", reject);
    current.once("close", (code, signal) => {
      child = undefined;
      if (code === 0) resolve();
      else reject(new Error(`focused validation exit=${code} signal=${signal}`));
    });
  });
  for (const name of [
    "result publication keeps empty and split JSON private during start and resume",
    "result publication reports sanitized exit and parse failures",
    "result publication times out and cancellation cleans only fixture-owned children",
    "an acquirer that stalled right after publishing finds a takeover instead of claiming the lock",
  ]) {
    assert.ok(output.split(/\r?\n/).some((line) => /^ok \d+ - /.test(line) && line.endsWith(name)), `missing focused test: ${name}`);
  }
  for (const summary of ["# fail 0", "# cancelled 0", "# skipped 0"]) {
    assert.ok(output.split(/\r?\n/).includes(summary), `unexpected focused result: ${summary}`);
  }
}

try {
  console.log(`Lock publication load: ${process.platform} ${release()} ${process.arch}; Node ${process.version}; ${cpus().length} CPUs; two CPU + 16 KiB write/delete workers; ten runs`);
  for (let index = 0; index < 2; index++) {
    const worker = new Worker(workerSource, {
      eval: true, workerData: { counters: counters.buffer, index, path: join(root, `load-${index}`) },
    });
    workers.push(worker);
    await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  }
  for (let attempt = 1; attempt <= 10; attempt++) {
    const before = [...counters];
    console.log(`Lock publication focused load run ${attempt} of 10`);
    await run();
    for (let index = 0; index < 2; index++) assert.ok(counters[index] > before[index], `load worker ${index} made no progress`);
    console.log(`Load iterations: ${[...counters].join(", ")}`);
  }
} finally {
  if (child) {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGKILL");
    await closed;
  }
  await Promise.all(workers.map((worker) => worker.terminate()));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}
