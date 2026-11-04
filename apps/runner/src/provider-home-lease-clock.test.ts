import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import fc from "fast-check";
import { leaseWorkerDeadline, leaseWorkerDelay, leaseWorkerNow, parseLeaseWorkerDeadline } from "./provider-home-lease-clock.js";
import { LEASE_WORKER_LIMITS } from "./provider-home-lease-worker-protocol.js";

const U64 = (1n << 64n) - 1n;
test("canonical wire deadlines round-trip the unsigned 64-bit domain without JSON BigInt", () => {
  fc.assert(fc.property(fc.bigInt({ min: 0n, max: U64 }), value => {
    const wire = JSON.parse(JSON.stringify({ deadline: value.toString() })) as { deadline: unknown };
    assert.equal(parseLeaseWorkerDeadline(wire.deadline), value);
  }), { examples: [[0n], [U64], [9_007_199_254_740_993n]] });
  fc.assert(fc.property(fc.bigInt({ min: 0n, max: U64 }), value => {
    const canonical = value.toString();
    for (const malformed of [`0${canonical}`, `+${canonical}`, `-${canonical}`, ` ${canonical}`, `${canonical}\n`, `${canonical}.0`, `${canonical}e0`]) {
      assert.equal(parseLeaseWorkerDeadline(malformed), undefined);
    }
  }));
  for (const value of [undefined, null, 0, 300_000, 1n, {}, [], "", "18446744073709551616", "9".repeat(65_536)]) {
    assert.equal(parseLeaseWorkerDeadline(value), undefined);
  }
});

test("the enqueue budget is exactly 300000 ms and independent of wall time", t => {
  let monotonic = 123_456_789n;
  t.mock.method(process.hrtime, "bigint", () => monotonic);
  t.mock.method(Date, "now", () => { throw new Error("wall clock consulted"); });
  const deadline = leaseWorkerDeadline(LEASE_WORKER_LIMITS.deadlineMs);
  assert.equal(deadline, monotonic + 300_000_000_000n);
  for (const [offset, delay] of [[-1n, 1], [0n, 0], [1n, 0]] as const) {
    monotonic = deadline + offset; assert.equal(leaseWorkerDelay(deadline), delay);
  }
  for (const invalid of [0, -1, 0.5, NaN, Infinity, 300_001]) assert.throws(() => leaseWorkerDeadline(invalid));
  monotonic = U64 - 1n;
  assert.throws(() => leaseWorkerDeadline(1), /clock range/);
});

test("timer wakeups cover the remaining interval with less than one millisecond rounding", t => {
  let monotonic = 10_000_000_000_000n;
  t.mock.method(process.hrtime, "bigint", () => monotonic);
  fc.assert(fc.property(fc.bigInt({ min: 1n, max: 300_000_000_000n }), remaining => {
    const delay = leaseWorkerDelay(monotonic + remaining);
    assert.ok(delay > 0 && delay <= 300_000);
    assert.ok(BigInt(delay) * 1_000_000n >= remaining);
    assert.ok(BigInt(delay) * 1_000_000n - remaining < 1_000_000n);
    monotonic += 1n;
  }), { examples: [[1n], [999_999n], [1_000_001n], [300_000_000_000n]] });
  assert.equal(leaseWorkerDelay(monotonic + U64), 300_000);
});

test("the actual clock coordinate brackets samples in another worker and process", async t => {
  const clock = new URL("./provider-home-lease-clock.ts", import.meta.url);
  const before = leaseWorkerNow();
  const worker = new Worker(`require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/cjs"))});const {parentPort}=require('node:worker_threads');parentPort.postMessage(require(${JSON.stringify(fileURLToPath(clock))}).leaseWorkerNow().toString());`, { eval: true, execArgv: [] });
  t.after(() => worker.terminate());
  const sample = await new Promise<string>((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
  const after = leaseWorkerNow();
  assert.ok(BigInt(sample) >= before && BigInt(sample) <= after, "worker uses the host coordinate, not its startup origin");
  const childBefore = leaseWorkerNow();
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {leaseWorkerNow} from ${JSON.stringify(clock.href)};process.stdout.write(leaseWorkerNow().toString());`]);
  assert.ok(BigInt(stdout) >= childBefore && BigInt(stdout) <= leaseWorkerNow(), "same-host process sample is comparable without process uptime translation");
});
