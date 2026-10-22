import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import { WSL_SKILLS_HELPER } from "./wsl-skills-helper.js";

const owner = "a".repeat(64);
const missingPid = 2_147_483_647;

function helperHandoff(home: string) {
  const end = WSL_SKILLS_HELPER.lastIndexOf("\ntry:\n    main(bounded_json())");
  assert.ok(end > 0);
  const helper = spawnSync("python3", ["-c", `${WSL_SKILLS_HELPER.slice(0, end)}\nhome_fd,_=open_root(os.environ["HOME"])\nlease=acquire_lease(home_fd,"${owner}")\nrelease_lease(lease)\nos.close(home_fd)\n`],
    { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 30_000 });
  assert.equal(helper.status, 0, helper.stderr);
}

function legacyFixture(t: TestContext, transitions: number, holder = missingPid) {
  let parent = tmpdir();
  try { if (statfsSync("/dev/shm").bavail * statfsSync("/dev/shm").bsize > 64 * 1024 * 1024) parent = "/dev/shm"; } catch { /* portable fallback */ }
  const home = mkdtempSync(join(parent, "wollipog-legacy-upgrade-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, ".agent-manager", "provider-home-leases-v1");
  const lock = join(root, "mutable-home.lock");
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  let record = { version: 2, state: "active", ownerHash: owner, leaseId: randomUUID(), previousLeaseId: null as string | null,
    previousRecordHash: null as string | null, pid: holder, hostname: hostname(), provider: "claude", createdAt: "2026-10-01T00:00:00.000Z" };
  let raw = `${JSON.stringify(record)}\n`;
  writeFileSync(join(lock, `lease-${record.leaseId}.json`), raw, { mode: 0o600 });
  for (let index = 0; index < transitions; index++) {
    const next = { ...record, state: index % 2 === 0 ? "released" : "active", leaseId: randomUUID(),
      previousLeaseId: record.leaseId, previousRecordHash: createHash("sha256").update(raw).digest("hex") };
    raw = `${JSON.stringify(next)}\n`;
    writeFileSync(join(lock, `next-${record.leaseId}.json`), raw, { mode: 0o600 });
    record = next;
  }
  return { home, root, lock };
}

for (const transitions of [8, 4096]) test(`an upgrade migrates an in-lock legacy journal with ${transitions} transitions before admitting HOME`, { timeout: 180_000 }, t => {
  const { home, root, lock } = legacyFixture(t, transitions);
  assert.equal(readdirSync(lock).length, transitions + 1);
  const registry = new ProviderHomeLeaseRegistry(owner, { onCheckpointFailureForTest: error => { throw error; } });
  assert.equal(registry.acquireHome(home), true);
  assert.equal(JSON.parse(readFileSync(join(root, "mutable-home.recovery.json"), "utf8")).version, 4, "old journals must enter bounded checkpoint storage on the first upgrade");
  assert.ok(readdirSync(root).length + readdirSync(lock).length < 16, "migration must retire only verified history after durable checkpoint selection");
  assert.equal(registry.releaseHome(home), true);
  if (process.platform === "linux") helperHandoff(home);
  const replacement = new ProviderHomeLeaseRegistry("b".repeat(64));
  assert.equal(replacement.acquireHome(home), true, "an orderly upgrade handoff preserves account usability");
  assert.equal(replacement.releaseHome(home), true);
});

test("a maximal legacy journal held by a live owner remains untouched during upgrade", { timeout: 180_000 }, t => {
  const { home, lock } = legacyFixture(t, 4096, process.pid);
  const before = new Map(readdirSync(lock).map(name => [name, readFileSync(join(lock, name), "utf8")]));
  assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /already in use/);
  assert.deepEqual(new Map(readdirSync(lock).map(name => [name, readFileSync(join(lock, name), "utf8")])), before);
});

test("a version-1 lease migrates without discarding its retained ownership proof", t => {
  const { home, root, lock } = legacyFixture(t, 0);
  const genesis = readdirSync(lock)[0]!;
  const original = JSON.parse(readFileSync(join(lock, genesis), "utf8"));
  const raw = `${JSON.stringify({ version: 1, ownerHash: owner, leaseId: original.leaseId, pid: missingPid,
    hostname: hostname(), provider: "claude", createdAt: original.createdAt })}\n`;
  rmSync(join(lock, genesis)); writeFileSync(join(lock, "lease.json"), raw, { mode: 0o600 });
  const registry = new ProviderHomeLeaseRegistry(owner, { onCheckpointFailureForTest: error => { throw error; } });
  assert.equal(registry.acquireHome(home), true);
  assert.equal(readFileSync(join(lock, "lease.json"), "utf8"), raw);
  assert.equal(JSON.parse(readFileSync(join(root, "mutable-home.recovery.json"), "utf8")).version, 4);
  assert.equal(registry.releaseHome(home), true);
  if (process.platform === "linux") helperHandoff(home);
});

test("an interrupted first migration recovers at every native publication boundary", { timeout: 600_000 }, async t => {
  const boundaries = ["before-guard", "guard-temp-written", "guard-file-durable", "guard-published", "guard-durable",
    "before-candidate", "candidate-written", "candidate-file-durable", "candidate-durable", "before-selection",
    "selection-published", "selection-durable", "before-retire", "after-retire", "retirement-durable"];
  for (const boundary of boundaries) {
    const { home, root } = legacyFixture(t, 8);
    const marker = join(home, "ready"), script = join(home, "writer.mts");
    writeFileSync(script, `import{ProviderHomeLeaseRegistry}from${JSON.stringify(new URL("./provider-home-lease.ts", import.meta.url).href)};new ProviderHomeLeaseRegistry(${JSON.stringify(owner)},{nativeCheckpointBarrierForTest:{boundary:${JSON.stringify(boundary)},marker:${JSON.stringify(marker)}}}).acquireHome(${JSON.stringify(home)});`);
    const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
    const closed = new Promise(resolve => child.once("close", resolve));
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const deadline = performance.now() + 60_000;
    while (!existsSync(marker)) {
      assert.equal(child.exitCode, null, `${boundary}: ${output}`);
      assert.ok(performance.now() < deadline, `${boundary}: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /already in use/, boundary);
    child.kill("SIGKILL"); await closed;
    const next = new ProviderHomeLeaseRegistry(owner, { onCheckpointFailureForTest: error => { throw error; } });
    const recoveryDeadline = performance.now() + 5_000;
    for (;;) {
      try { assert.equal(next.acquireHome(home), true, boundary); break; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes("publication is in progress") || performance.now() >= recoveryDeadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.equal(next.releaseHome(home), true, boundary);
    assert.equal(JSON.parse(readFileSync(join(root, "mutable-home.recovery.json"), "utf8")).version, 4, boundary);
    t.diagnostic(`${process.platform}: first migration recovered at ${boundary}`);
  }
});

test("an unselected migration fence stays busy instead of entering partial-journal recovery", { skip: process.platform === "win32", timeout: 30_000 }, async t => {
  const { home, lock } = legacyFixture(t, 8);
  const record = JSON.parse(readFileSync(join(lock, readdirSync(lock).find(name => name.startsWith("lease-"))!), "utf8"));
  const guard = join(lock, "protocol-v4.json"), marker = join(home, "fence-ready");
  writeFileSync(guard, `${JSON.stringify({ ...record, version: 4, protocol: "bounded-canonical-checkpoint", fenceBackend: "flock" })}\n`, { mode: 0o600 });
  const before = new Map(readdirSync(lock).map(name => [name, readFileSync(join(lock, name), "utf8")]));
  const holder = spawn("python3", ["-c", `import fcntl,time\nf=open(${JSON.stringify(guard)},'rb')\nfcntl.flock(f,fcntl.LOCK_EX)\nopen(${JSON.stringify(marker)},'w').write('ready')\ntime.sleep(25)\n`], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise(resolve => holder.once("close", resolve));
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL"); });
  const deadline = performance.now() + 10_000;
  while (!existsSync(marker)) {
    assert.equal(holder.exitCode, null); assert.ok(performance.now() < deadline);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.throws(() => new ProviderHomeLeaseRegistry(owner).acquireHome(home), /publication is in progress/);
  assert.deepEqual(new Map(readdirSync(lock).map(name => [name, readFileSync(join(lock, name), "utf8")])), before);
  holder.kill("SIGKILL"); await closed;
  const registry = new ProviderHomeLeaseRegistry(owner);
  assert.equal(registry.acquireHome(home), true);
  assert.equal(registry.releaseHome(home), true);
});
