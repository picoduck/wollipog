import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import { readLeaseIoSnapshot } from "./provider-home-lease-io.js";

const owner = "a".repeat(64);
const modulePath = new URL("./provider-home-lease.ts", import.meta.url).href;
const commonBoundaries = ["before-guard", "guard-temp-written", "guard-file-durable", "guard-published", "guard-durable",
  "before-candidate", "candidate-written", "candidate-file-durable", "candidate-durable", "before-selection",
  "selection-published", "selection-durable", "before-retire", "after-retire", "retirement-durable"];

/** A real v2 chain avoids spending eight provider lifetimes preparing each crash fixture. */
function seed(home: string): string {
  const root = join(home, ".agent-manager", "provider-home-leases-v1");
  const lock = join(root, "mutable-home.lock");
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  let record = { version: 2, state: "active", ownerHash: owner, leaseId: randomUUID(), previousLeaseId: null as string | null,
    previousRecordHash: null as string | null, recoveredEntriesHash: createHash("sha256").update("[]").digest("hex") as string | undefined,
    pid: 999999, hostname: hostname(), provider: "skills", createdAt: "2026-10-01" };
  let raw = `${JSON.stringify(record)}\n`;
  const anchor = join(root, "mutable-home.recovery.json");
  writeFileSync(anchor, raw, { mode: 0o600 });
  linkSync(anchor, join(lock, "checkpoint.json")); linkSync(anchor, join(lock, `lease-${record.leaseId}.json`));
  for (let index = 0; index < 15; index++) {
    const name = `next-${record.leaseId}.json`;
    record = { ...record, recoveredEntriesHash: undefined, state: index % 2 === 0 ? "released" : "active", leaseId: randomUUID(),
      previousLeaseId: record.leaseId, previousRecordHash: createHash("sha256").update(raw).digest("hex") };
    raw = `${JSON.stringify(record)}\n`;
    writeFileSync(join(root, name), raw, { mode: 0o600 }); linkSync(join(root, name), join(lock, name));
  }
  return root;
}

test("native POSIX and Windows checkpoints recover actual killed-parent publication boundaries", { timeout: 600_000 }, async (t) => {
  const boundaries = process.platform === "win32" ? [...commonBoundaries, "retirement-moved", "retirement-flushed"] : commonBoundaries;
  for (const boundary of boundaries) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-portable-lease-")));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const root = seed(home); const marker = join(home, "ready"); const script = join(home, "writer.mts");
    // Keep fixed-source compiler errors visible in test evidence before public lease refusals
    // intentionally replace internal exceptions with the stable operator remedy.
    readLeaseIoSnapshot(root);
    writeFileSync(script, `import {ProviderHomeLeaseRegistry} from ${JSON.stringify(modulePath)};const registry=new ProviderHomeLeaseRegistry(${JSON.stringify(owner)},{nativeCheckpointBarrierForTest:{boundary:${JSON.stringify(boundary)},marker:${JSON.stringify(marker)}}});registry.acquireHome(${JSON.stringify(home)});registry.releaseAll();`);
    const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (value) => { output += value; }); child.stderr.on("data", (value) => { output += value; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const deadline = performance.now() + 60_000;
    while (!existsSync(marker)) {
      assert.equal(child.exitCode, null, `${boundary}: ${output}`);
      assert.ok(performance.now() < deadline, `${boundary}: barrier timeout ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const ended = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill("SIGKILL"); await ended;
    const registry = new ProviderHomeLeaseRegistry(owner, { onCheckpointFailureForTest: (error) => { throw error; } });
    const recoveryDeadline = performance.now() + 5_000;
    for (;;) {
      try { registry.acquireHome(home); break; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("publication is in progress") || performance.now() >= recoveryDeadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.deepEqual(registry.getDiagnostics(), [], boundary);
    assert.equal(registry.releaseHome(home), true, boundary);
    assert.equal(JSON.parse(readFileSync(join(root, "mutable-home.recovery.json"), "utf8")).version, 4);
    assert.ok(readdirSync(root).length <= 36);
    assert.ok(readdirSync(join(root, "mutable-home.lock")).length <= 36);
    t.diagnostic(`${process.platform}: ${boundary} recovered`);
  }
});
