import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import { readLeaseIoSnapshot } from "./provider-home-lease-io.js";

const owner = "a".repeat(64);
const modulePath = new URL("./provider-home-lease.ts", import.meta.url).href;
const commonBoundaries = ["before-guard", "guard-temp-written", "guard-file-durable", "guard-published", "guard-durable",
  "before-candidate", "candidate-written", "candidate-file-durable", "candidate-durable", "before-selection",
  "selection-published", "selection-durable", "before-retire", "after-retire", "retirement-durable"];

function holdFence(guard: string, marker: string, exclusive: boolean, seconds: number): ChildProcess {
  if (process.platform !== "win32") return spawn("python3", ["-c", `import fcntl,time;f=open(${JSON.stringify(guard)},'rb');fcntl.flock(f,fcntl.${exclusive ? "LOCK_EX" : "LOCK_SH"});open(${JSON.stringify(marker)},'w').write('ready');time.sleep(${seconds})`], { stdio: ["ignore", "pipe", "pipe"] });
  const quote = (value: string) => `'${value.replace(/'/gu, "''")}'`;
  const types = `using System;using System.Runtime.InteropServices;public class FenceTest{[StructLayout(LayoutKind.Sequential)]public struct O{public IntPtr I,H;public uint Offset,High;public IntPtr Event;}[DllImport("kernel32.dll",SetLastError=true)]public static extern bool LockFileEx(IntPtr f,uint flags,uint reserved,uint low,uint high,ref O o);}`;
  return spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Add-Type -TypeDefinition ${quote(types)};$f=[IO.File]::Open(${quote(guard)},[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete));$o=New-Object FenceTest+O;$o.Offset=[uint32]::MaxValue;if(-not [FenceTest]::LockFileEx($f.SafeFileHandle.DangerousGetHandle(),${exclusive ? 3 : 1},0,1,0,[ref]$o)){throw 'test fence unavailable'};[IO.File]::WriteAllText(${quote(marker)},'ready');Start-Sleep -Milliseconds ${seconds * 1000};$f.Dispose()`], { stdio: ["ignore", "pipe", "pipe"] });
}

async function fenceReady(child: ChildProcess, marker: string): Promise<void> {
  let output = ""; child.stderr?.on("data", (value) => { output += value; });
  const deadline = performance.now() + 30_000;
  while (!existsSync(marker)) {
    assert.equal(child.exitCode, null, output);
    assert.ok(performance.now() < deadline, `test fence timeout: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function leaseEvidence(root: string): Array<[string, string]> {
  return [root, join(root, "mutable-home.lock")].flatMap((directory) => readdirSync(directory).filter((name) => name !== "mutable-home.lock")
    .map((name): [string, string] => [join(directory, name), createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")]));
}

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

test("orderly release waits for a real shared-fence reader and hands off after the origin exits", { timeout: 120_000 }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-lease-release-reader-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = seed(home), ownerReady = join(home, "owner-ready"), go = join(home, "release-go"), script = join(home, "owner.mts");
  writeFileSync(script, `import{ProviderHomeLeaseRegistry}from${JSON.stringify(modulePath)};import{existsSync,writeFileSync}from'node:fs';const r=new ProviderHomeLeaseRegistry(${JSON.stringify(owner)});r.acquireHome(${JSON.stringify(home)});writeFileSync(${JSON.stringify(ownerReady)},'ready');while(!existsSync(${JSON.stringify(go)}))await new Promise(r=>setTimeout(r,10));if(!r.releaseHome(${JSON.stringify(home)}))throw Error('orderly release failed');console.log('released');`);
  const origin = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (origin.exitCode === null && origin.signalCode === null) origin.kill("SIGKILL"); });
  let originOutput = ""; origin.stdout?.on("data", b => { originOutput += b; }); origin.stderr?.on("data", b => { originOutput += b; });
  const exited = new Promise<number | null>(resolve => origin.once("close", code => resolve(code)));
  await fenceReady(origin, ownerReady);
  const marker = join(home, "reader-ready"), reader = holdFence(join(root, "mutable-home.lock", "protocol-v4.json"), marker, false, 2);
  t.after(() => { if (reader.exitCode === null && reader.signalCode === null) reader.kill("SIGKILL"); });
  await fenceReady(reader, marker); writeFileSync(go, "go");
  assert.equal(await exited, 0, originOutput); assert.match(originOutput, /released/);
  const next = new ProviderHomeLeaseRegistry("b".repeat(64));
  assert.equal(next.acquireHome(home), true); assert.equal(next.releaseHome(home), true);
});

test("post-publication deadline retains an immutable completion token without adding references or records", { timeout: 120_000 }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-lease-pending-fence-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = seed(home), setup = new ProviderHomeLeaseRegistry(owner);
  setup.acquireHome(home); assert.equal(setup.releaseHome(home), true);
  const marker = join(home, "writer-ready"); let writer: ChildProcess | undefined;
  const registry = new ProviderHomeLeaseRegistry(owner, { afterTransitionPublishForTest: () => {
    writer = holdFence(join(root, "mutable-home.lock", "protocol-v4.json"), marker, true, 13);
    const deadline = performance.now() + 30_000;
    while (!existsSync(marker)) { assert.ok(performance.now() < deadline); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  } });
  t.after(() => { if (writer && writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL"); });
  const started = performance.now();
  assert.throws(() => registry.acquireHome(home), (error: unknown) => {
    assert.ok(error instanceof Error); assert.match(error.message, /publication is in progress/); assert.doesNotMatch(error.message, /quarantine/); return true;
  });
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 9_900 && elapsed < 30_000, `finite fence grace: ${elapsed}`);
  const before = leaseEvidence(root);
  assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /publication is in progress/);
  assert.deepEqual(leaseEvidence(root), before);
  await new Promise<void>(resolve => writer!.once("close", () => resolve()));
  assert.equal(registry.acquireHome(home), true, "same registry completes its own publication");
  const after = leaseEvidence(root);
  assert.deepEqual(after.filter(([path]) => dirname(path) === root),
    before.filter(([path]) => dirname(path) === root), "no republished canonical successor or checkpoint");
  for (const [path, hash] of before) assert.equal(new Map(after).get(path), hash, "existing proof bytes preserved; exact mirror completion is allowed");
  assert.equal(registry.releaseHome(home), true, "retry did not add a borrowed reference");
});

test("releaseAll preserves failed tokens and unchanged evidence until the finite reader grace expires", { timeout: 120_000 }, async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-lease-release-deadline-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = seed(home), registry = new ProviderHomeLeaseRegistry(owner);
  registry.acquireHome(home);
  const before = leaseEvidence(root), marker = join(home, "reader-ready");
  const reader = holdFence(join(root, "mutable-home.lock", "protocol-v4.json"), marker, false, 13);
  t.after(() => { if (reader.exitCode === null && reader.signalCode === null) reader.kill("SIGKILL"); });
  await fenceReady(reader, marker); const ended = new Promise<void>(resolve => reader.once("close", () => resolve()));
  const started = performance.now(); registry.releaseAll();
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 9_900 && elapsed < 30_000, `finite release grace: ${elapsed}`);
  assert.deepEqual(leaseEvidence(root), before);
  assert.equal(registry.getDiagnostics().filter(message => message.includes("release unpublished")).length, 1);
  await ended; registry.releaseAll();
  const next = new ProviderHomeLeaseRegistry("b".repeat(64));
  assert.equal(next.acquireHome(home), true); assert.equal(next.releaseHome(home), true);
});

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
    const evidence = () => [root, join(root, "mutable-home.lock")].flatMap((directory) =>
      readdirSync(directory).filter((name) => name !== "mutable-home.lock").map((name) =>
        [directory, name, createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")]));
    const before = evidence();
    assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /already in use/, `${boundary}: live writer/fence`);
    assert.deepEqual(evidence(), before, `${boundary}: contender changed live writer evidence`);
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

test("a published guard staging hard link is readable without another process or writer", (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-lease-guard-alias-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = seed(home), registry = new ProviderHomeLeaseRegistry(owner);
  registry.acquireHome(home);
  const guard = join(root, "mutable-home.lock", "protocol-v4.json");
  const staging = join(root, `.provider-home-lease-${randomUUID()}.tmp`);
  linkSync(guard, staging);
  const guardIdentity = lstatSync(guard, { bigint: true });
  const stagingIdentity = lstatSync(staging, { bigint: true });
  assert.equal(stagingIdentity.dev, guardIdentity.dev);
  assert.equal(stagingIdentity.ino, guardIdentity.ino);
  const before = leaseEvidence(root);
  const snapshot = readLeaseIoSnapshot(root);
  const namedGuard = snapshot.entries.find(entry => entry.directory === "lock" && entry.name === "protocol-v4.json")!;
  const namedStaging = snapshot.entries.find(entry => entry.directory === "root" && entry.name === staging.slice(root.length + 1))!;
  assert.equal(namedStaging.device, namedGuard.device);
  assert.equal(namedStaging.inode, namedGuard.inode);
  assert.deepEqual(namedStaging.raw, namedGuard.raw);
  assert.deepEqual(leaseEvidence(root), before);
  assert.equal(registry.releaseHome(home), true);
});

test("portable selected checkpoints preserve unsafe evidence and reject foreign or substituted authority", { timeout: 600_000 }, (t) => {
  const cases = ["owner", "host", "live-pid", "guard", "anchor", "unknown", "ancestry", ...(process.platform === "win32" ? ["alias", "alias-inode"] : [])];
  for (const scenario of cases) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-portable-refusal-")));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const root = seed(home), lock = join(root, "mutable-home.lock");
    const registry = new ProviderHomeLeaseRegistry(owner, { onCheckpointFailureForTest: (error) => { throw error; } });
    registry.acquireHome(home); assert.equal(registry.releaseHome(home), true);
    assert.deepEqual(registry.getDiagnostics(), []);
    const anchor = join(root, "mutable-home.recovery.json");
    const tipPath = readdirSync(root).filter((name) => name.startsWith("next-")).map((name) => join(root, name))
      .find((path) => JSON.parse(readFileSync(path, "utf8")).state === "released")!;
    if (["owner", "host", "live-pid"].includes(scenario)) {
      const tip = JSON.parse(readFileSync(tipPath, "utf8"));
      writeFileSync(tipPath, `${JSON.stringify({ ...tip, state: "active", pid: scenario === "live-pid" ? process.pid : 999999,
        ...(scenario === "owner" ? { ownerHash: "b".repeat(64) } : {}), ...(scenario === "host" ? { hostname: "foreign-host" } : {}) })}\n`);
    } else if (scenario === "guard") writeFileSync(join(lock, "protocol-v4.json"), `${readFileSync(join(lock, "protocol-v4.json"), "utf8")} `);
    else if (scenario === "anchor") writeFileSync(anchor, `${readFileSync(anchor, "utf8")} `);
    else if (scenario === "unknown") writeFileSync(join(root, "unproven.json"), "{}", { mode: 0o600 });
    else if (scenario === "alias") writeFileSync(join(root, ".mutable-home.retired"), "corrupt selected-manifest alias");
    else if (scenario === "alias-inode") {
      const alias = join(root, ".mutable-home.retired"), bytes = readFileSync(alias);
      renameSync(alias, join(home, "preserved-alias")); writeFileSync(alias, bytes, { mode: 0o600 });
    } else {
      const preserved = join(home, "preserved-lock"); renameSync(lock, preserved);
      symlinkSync(preserved, lock, process.platform === "win32" ? "junction" : "dir");
    }
    const evidence = () => [root, scenario === "ancestry" ? join(home, "preserved-lock") : lock].flatMap((directory) =>
      readdirSync(directory).filter((name) => name !== "mutable-home.lock").map((name) =>
        [directory, name, createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")]));
    const before = evidence();
    assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /quarantine the entire/, scenario);
    assert.deepEqual(evidence(), before, scenario);
    t.diagnostic(`${process.platform}: ${scenario} refused without evidence changes`);
  }
});
