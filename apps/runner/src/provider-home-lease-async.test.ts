import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import fc from "fast-check";
import { AsyncProviderHomeLeaseRegistry } from "./provider-home-lease-async.js";

function worker(data: Record<string, unknown>): Worker {
  return new Worker(`require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/cjs"))});require(${JSON.stringify(fileURLToPath(new URL("./provider-home-lease-worker.ts", import.meta.url)))});`,
    { eval: true, execArgv: [], workerData: data });
}

test("cold worker acquisition and exact reference release leave the heartbeat timer responsive", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-async-lease-"));
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64));
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  let last = performance.now();
  const delays: number[] = [];
  const timer = setInterval(() => {
    const now = performance.now(); delays.push(Math.max(0, now - last - 20)); last = now;
  }, 20);
  t.after(() => clearInterval(timer));
  const home = join(root, "home");
  assert.equal(await registry.acquireHome(home), true);
  assert.equal(await registry.acquireHome(home), false);
  assert.equal(await registry.releaseHome(home), false, "borrowed reference does not release the owner");
  assert.equal(await registry.releaseHome(home), true);
  assert.ok(delays.length > 0, "heartbeats ran while initialization/acquisition were pending");
  assert.ok(Math.max(...delays) <= 500, `dispatch delay ${Math.max(...delays)} ms`);
});

test("aborted queued acquisition creates no private reference", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-async-cancel-"));
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64));
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  const home = join(root, "home");
  const first = registry.acquireHome(home);
  const cancellation = new AbortController();
  const second = registry.acquireHome(home, "skills", { signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(second, /cancelled/);
  assert.equal(await first, true);
  assert.equal(await registry.releaseHome(home), true);
});

for (const phase of ["receipt", "accepted"] as const) test(`real worker cancellation at ${phase} unwinds only its acquired reference`, async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-real-worker-cancel-")), home = join(root, "home");
  const controller = new AbortController(); let armed = false;
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { workerFactoryForTest: data => {
    const actual = worker(data);
    if (phase === "receipt") actual.on("message", reply => { if (armed && reply.kind === "receipt") { armed = false; controller.abort(); } });
    else {
      const post = actual.postMessage.bind(actual);
      actual.postMessage = message => { if (armed && message.kind === "accept") { armed = false; controller.abort(); } post(message); };
    }
    return actual;
  } });
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(await registry.acquireHome(home), true);
  armed = true;
  await assert.rejects(registry.acquireHome(home, "skills", { signal: controller.signal }), /cancelled/);
  assert.equal(await registry.releaseHome(home), true, "the original reference survives; the cancelled borrow does not");
  assert.equal(await registry.close(), true);
});

test("cancellation stays bound to its private canonical HOME after an alias is retargeted", { skip: process.platform === "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worker-alias-")), first = join(root, "first"), second = join(root, "second"), alias = join(root, "alias");
  mkdirSync(first); mkdirSync(second); symlinkSync(first, alias);
  const controller = new AbortController();
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { workerFactoryForTest: data => {
    const actual = worker(data);
    actual.once("message", () => {});
    const onReceipt = (reply: { kind: string }) => {
      if (reply.kind !== "receipt") return;
      actual.off("message", onReceipt); unlinkSync(alias); symlinkSync(second, alias); controller.abort();
    };
    actual.on("message", onReceipt); return actual;
  } });
  const other = new AsyncProviderHomeLeaseRegistry("b".repeat(64));
  t.after(async () => { await registry.close(); await other.close(); rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(registry.acquireHome(alias, "skills", { signal: controller.signal }), /cancelled/);
  assert.equal(await other.acquireHome(first), true, "cancel released the originally acquired HOME");
  assert.equal(await other.acquireHome(second), true, "cancel never acquired or released the new alias target");
  assert.equal(await other.close(), true);
});

test("a lost real worker poisons its registry and another worker cannot adopt its live parent's authority", async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worker-loss-")), home = join(root, "home");
  let actual!: Worker;
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { workerFactoryForTest: data => actual = worker(data) });
  const other = new AsyncProviderHomeLeaseRegistry("a".repeat(64));
  t.after(async () => { await registry.close(); await other.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(await registry.acquireHome(home), true); await actual.terminate();
  await assert.rejects(registry.acquireHome(home), /worker unavailable/);
  assert.equal(await registry.close(), false, "worker loss proves neither rollback nor release");
  await assert.rejects(other.acquireHome(home), /already in use/, "same PID and owner hash cannot reconstruct a lost private token");
  assert.equal(await other.close(), true, "a refused acquisition owns no reference");
});

test("generated reference and cancellation sequences preserve the independent ownership count", { timeout: process.platform === "win32" ? 300_000 : 90_000 }, async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("borrow", "release", "cancel"), { maxLength: process.platform === "win32" ? 6 : 12 }), async commands => {
    const root = mkdtempSync(join(tmpdir(), "wollipog-worker-count-")), home = join(root, "home");
    let cancelAtReceipt: AbortController | undefined;
    const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { workerFactoryForTest: data => {
      const actual = worker(data); actual.on("message", reply => {
        if (reply.kind === "receipt" && cancelAtReceipt) { const controller = cancelAtReceipt; cancelAtReceipt = undefined; controller.abort(); }
      }); return actual;
    } });
    let count = 0;
    try {
      for (const command of commands) {
        if (command === "borrow") { assert.equal(await registry.acquireHome(home), count === 0); count++; }
        else if (command === "release") {
          assert.equal(await registry.releaseHome(home), count === 1);
          count = Math.max(0, count - 1);
        } else {
          const controller = new AbortController(); cancelAtReceipt = controller;
          await assert.rejects(registry.acquireHome(home, "skills", { signal: controller.signal }), /cancelled/);
        }
      }
      while (count > 0) { assert.equal(await registry.releaseHome(home), count === 1); count--; }
      assert.equal(await registry.acquireHome(home), true, "no cancelled or released request leaves an extra reference");
      assert.equal(await registry.releaseHome(home), true);
      assert.equal(await registry.close(), true);
    } finally { await registry.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: process.platform === "win32" ? 3 : 15, seed: 2317 });
});
