import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runStateDoctor } from "./state-doctor.js";

const skip = process.platform !== "linux";
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-home-doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), data = join(root, "data");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(data, { mode: 0o700 });
  writeFileSync(join(data, ".wollipog-runner-owner-v2.json"), JSON.stringify({ version: 2, ownerHash: "b".repeat(64) }), { mode: 0o600 });
  // This maintenance command must work alongside the live runner without taking its data lease.
  writeFileSync(join(data, ".wollipog-runner-active-v1.lock"), "live runner", { mode: 0o600 });
  const args = (command: string, ...extra: string[]) => ["node", "cli.ts", "--state-doctor", "provider-home", command,
    "--data-dir", data, "--home", home, "--expected-pid-namespace", readlinkSync("/proc/self/ns/pid"), ...extra];
  return { root, home, data, args };
}

test("provider HOME doctor inspects alongside the runner without creating a lease or leaking paths", { skip }, async t => {
  const f = fixture(t); let output = "";
  await runStateDoctor(f.args("inspect"), text => { output += text; });
  assert.deepEqual(JSON.parse(output), { state: "none" });
  assert.equal(readdirSync(f.home).length, 0);
  assert.equal(readFileSync(join(f.data, ".wollipog-runner-active-v1.lock"), "utf8"), "live runner");
  assert.ok(!output.includes(f.root));
});

test("provider HOME doctor refuses a different PID namespace and missing exact authorization", { skip }, async t => {
  const f = fixture(t);
  const bad = f.args("inspect"); bad[bad.length - 1] = "pid:[1]";
  await assert.rejects(runStateDoctor(bad), /namespace/i);
  await assert.rejects(runStateDoctor(f.args("recover")), /exact.*authorization/i);
  assert.equal(readdirSync(f.home).length, 0);
});

import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import { runProviderHomeDoctor } from "./provider-home-doctor.js";
import type { LeaseProcessProbe } from "./provider-home-lease-evidence.js";

const OLD_BOOT = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const NEW_BOOT = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
function crashed(t: { after(fn: () => void): void }) {
  const f = fixture(t);
  let boot = OLD_BOOT;
  const view: LeaseProcessProbe = { bootId: () => boot, startTime: p => p === 101 ? "100" : "900", scan: () => ({ marked: [], uninspectable: [] }) };
  const old = new ProviderHomeLeaseRegistry("a".repeat(64), { pid: 101, runnerMarker: "1".repeat(32), processProbe: view });
  old.acquireHome(f.home);
  boot = NEW_BOOT;
  const replacement = () => new ProviderHomeLeaseRegistry("b".repeat(64), { runnerMarker: "2".repeat(32), processProbe: view });
  const tip = replacement().inspectHome(f.home).tipHash!;
  const files = () => {
    const root = join(f.home, ".agent-manager", "provider-home-leases-v1");
    return [root, join(root, "mutable-home.lock")].flatMap(dir => readdirSync(dir).filter(n => n.endsWith(".json")).map(n => readFileSync(join(dir, n))));
  };
  return { ...f, replacement, tip, files };
}

test("doctor recovers a foreign exact tip through the real registry and preserves recovery evidence", { skip }, t => {
  const f = crashed(t), authorization = randomUUID();
  const before = f.files().map(raw => createHash("sha256").update(raw).digest("hex"));
  let output = "";
  runProviderHomeDoctor(f.args("recover", "--stale-tip-hash", f.tip, "--authorization-id", authorization).slice(4), text => { output += text; }, f.replacement);
  assert.deepEqual(JSON.parse(output), { state: "released", authorizationId: authorization });
  assert.equal(f.replacement().inspectHome(f.home).state, "released");
  const records = f.files().map(raw => JSON.parse(raw.toString()) as { recovery?: { proof?: string; authorizationId?: string }; checkpoint?: { previousTip: string } });
  assert.ok(records.some(r => r.recovery?.proof === "authorized" && r.recovery.authorizationId === authorization));
  const retained = new Set(f.files().map(raw => createHash("sha256").update(raw).digest("hex")));
  for (const r of records) if (r.checkpoint) retained.add(createHash("sha256").update(r.checkpoint.previousTip).digest("hex"));
  assert.ok(before.every(hash => retained.has(hash)), "old lease bytes survive directly or in the checkpoint");
});

test("doctor rejects a changed exact tip without publishing anything", { skip }, t => {
  const f = crashed(t), before = f.files().map(raw => raw.toString()).sort();
  assert.throws(() => runProviderHomeDoctor(f.args("recover", "--stale-tip-hash", "f".repeat(64), "--authorization-id", randomUUID()).slice(4), () => {}, f.replacement), /stale_tip_changed/);
  assert.deepEqual(f.files().map(raw => raw.toString()).sort(), before);
});

test("doctor keeps a genuine surviving provider protected and emits no private coordinates", { skip }, t => {
  const f = crashed(t), before = f.files().map(raw => raw.toString()).sort();
  const view: LeaseProcessProbe = { bootId: () => OLD_BOOT, startTime: p => p === 101 ? null : "900", scan: () => ({ marked: [4242], uninspectable: [] }) };
  const replacement = () => new ProviderHomeLeaseRegistry("b".repeat(64), { runnerMarker: "2".repeat(32), processProbe: view });
  assert.throws(() => runProviderHomeDoctor(f.args("recover", "--stale-tip-hash", f.tip, "--authorization-id", randomUUID()).slice(4), () => {}, replacement), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /process_survivor/); assert.ok(!error.message.includes(f.home)); return true;
  });
  assert.deepEqual(f.files().map(raw => raw.toString()).sort(), before);
});
