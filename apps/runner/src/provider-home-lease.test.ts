import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test, type TestContext } from "node:test";
const previousMask = process.umask(0o077);
after(() => process.umask(previousMask));
import { providerHomeLeaseRefusalKind, providerLaunchNeedsSharedHomeLease, ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import { killTreeAndWait, type AgentProcess, type SpawnIsolation } from "./spawn.js";
import { LEASE_WORKER_ERRORS } from "./provider-home-lease-worker-protocol.js";
import { adoptProviderProfileMarker, readProviderProfileMarker, revokeProviderProfileMarkerGrant, writeProviderProfileMarker, type ProviderProfileMarker } from "./provider-profile.js";

const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);
const LEGACY_ID = "11111111-1111-4111-8111-111111111111";

function request(home: string) {
  return {
    driver: "claude-code" as const,
    command: "claude",
    context: { kind: "native" as const },
    env: { HOME: home },
  };
}

function leasePaths(home: string) {
  const root = join(home, ".agent-manager", "provider-home-leases-v1");
  return { root, lock: join(root, "mutable-home.lock") };
}

function writeLegacyLease(home: string, overrides: Record<string, unknown> = {}): string {
  const { lock } = leasePaths(home);
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(join(lock, "lease.json"), `${JSON.stringify({
    version: 1,
    ownerHash: OWNER_A,
    leaseId: LEGACY_ID,
    pid: 101,
    hostname: "host-a",
    provider: "claude",
    createdAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  })}\n`, { mode: 0o600 });
  return lock;
}

function journalRecords(home: string): Array<Record<string, unknown>> {
  const { lock } = leasePaths(home);
  return readdirSync(lock).sort().filter((name) => name !== "checkpoint.json").map((name) =>
    JSON.parse(readFileSync(join(lock, name), "utf8")) as Record<string, unknown>);
}

function writePartialJournal(home: string, shape: "lease" | "next" | "disconnected") {
  const { lock } = leasePaths(home);
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  const genesis = {
    version: 2, state: "active", ownerHash: OWNER_A, leaseId: LEGACY_ID,
    previousLeaseId: null, previousRecordHash: null, pid: 101, hostname: "host-a",
    provider: "skills", createdAt: "2026-08-19T00:00:00.000Z",
  };
  const bytes = `${JSON.stringify(genesis)}\n`;
  if (shape !== "next") writeFileSync(join(lock, `lease-${LEGACY_ID}.json`), bytes);
  if (shape !== "lease") {
    const successor = {
      ...genesis, leaseId: "22222222-2222-4222-8222-222222222222", previousLeaseId: LEGACY_ID,
      previousRecordHash: createHash("sha256").update(bytes).digest("hex"), pid: 102,
    };
    writeFileSync(join(lock, `next-${LEGACY_ID}.json`), `${JSON.stringify(successor)}\n`);
  }
  if (shape === "disconnected") {
    writeFileSync(join(lock, "next-33333333-3333-4333-8333-333333333333.json"), `${JSON.stringify({
      ...genesis, leaseId: "44444444-4444-4444-8444-444444444444",
      previousLeaseId: "33333333-3333-4333-8333-333333333333", previousRecordHash: "c".repeat(64), pid: 103,
    })}\n`);
  }
  return lock;
}

test("abandoned lease-only, next-only, and disconnected journals recover without removing evidence", (t) => {
  for (const shape of ["lease", "next", "disconnected"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-provider-partial-${shape}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const lock = writePartialJournal(home, shape);
    const evidence = readdirSync(lock).map((name) => ({ name, bytes: readFileSync(join(lock, name)) }));
    const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
      pid: process.pid, hostname: "host-a", isProcessAlive: (pid) => pid === process.pid,
    });
    registry.acquire(request(home));
    for (const item of evidence) {
      if (shape === "lease") assert.equal(existsSync(join(leasePaths(home).root, "mutable-home.recovery.json")), true, "a complete journal enters bounded storage");
      else assert.deepEqual(readFileSync(join(lock, item.name)), item.bytes);
    }
    const competitor = new ProviderHomeLeaseRegistry(OWNER_A, {
      pid: process.pid, hostname: "host-a", isProcessAlive: (pid) => pid === process.pid,
    });
    assert.throws(() => competitor.acquire(request(home)), new RegExp(`already in use by process ${process.pid}`));
    registry.releaseAll();
    competitor.acquire(request(home));
    competitor.releaseAll();
  }
});

test("every retained partial-journal record must prove owner, host, and dead PID", (t) => {
  for (const bad of [{ ownerHash: OWNER_B }, { hostname: "host-b" }, { pid: 303 }, { previousRecordHash: "d".repeat(64) }]) {
    const home = mkdtempSync(join(tmpdir(), "wollipog-provider-partial-refuse-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const lock = writePartialJournal(home, "disconnected");
    const name = `next-${LEGACY_ID}.json`;
    writeFileSync(join(lock, name), JSON.stringify({ ...JSON.parse(readFileSync(join(lock, name), "utf8")), ...bad }));
    const before = readdirSync(lock).map((entry) => readFileSync(join(lock, entry), "utf8"));
    const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
      pid: 202, hostname: "host-a", isProcessAlive: (pid) => pid === 303,
    });
    assert.throws(() => registry.acquire(request(home)), /quarantine the entire.*do not remove individual records/);
    assert.deepEqual(readdirSync(lock).map((entry) => readFileSync(join(lock, entry), "utf8")), before);
    assert.equal(existsSync(join(leasePaths(home).root, "mutable-home.recovery.json")), false);
  }
});

test("durable initialization recovers crashes before mkdir and with an empty lock", (t) => {
  for (const directoryCreated of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), "wollipog-provider-initialization-crash-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const crashed = new ProviderHomeLeaseRegistry(OWNER_A, {
      pid: 101, hostname: "host-a",
      afterInitializationPublishForTest: () => {
        if (directoryCreated) mkdirSync(leasePaths(home).lock);
        throw new Error("simulated runner termination");
      },
    });
    assert.throws(() => crashed.acquire(request(home)), /quarantine the entire.*do not remove individual records/s);
    const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
      pid: 202, hostname: "host-a", isProcessAlive: (pid) => pid === 202,
    });
    registry.acquire(request(home));
    assert.equal(existsSync(leasePaths(home).lock), true);
    const competitor = new ProviderHomeLeaseRegistry(OWNER_A, {
      pid: 303, hostname: "host-a", isProcessAlive: (pid) => pid === 202,
    });
    assert.throws(() => competitor.acquire(request(home)), /already in use by process 202/);
    registry.releaseAll();
    competitor.acquire(request(home));
    competitor.releaseAll();
  }
});

test("the originating registry retries a real post-proof directory failure without replacing evidence", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("requires POSIX directory permissions");
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-retry-directory-"));
  const { root, lock } = leasePaths(home);
  t.after(() => { chmodSync(root, 0o700); rmSync(home, { recursive: true, force: true }); });
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
    afterInitializationPublishForTest: () => chmodSync(root, 0o500),
  });
  assert.throws(() => registry.acquireHome(home), /quarantine the entire.*do not remove individual records/s);
  assert.equal(existsSync(lock), false);
  const proof = readFileSync(join(root, "mutable-home.recovery.json"));
  chmodSync(root, 0o700);
  const otherRegistry = new ProviderHomeLeaseRegistry(OWNER_A);
  assert.throws(() => otherRegistry.acquireHome(home), /already in use by process/);
  assert.equal(registry.acquireHome(home), true);
  assert.deepEqual(readFileSync(join(root, "mutable-home.recovery.json")), proof);
  assert.equal(registry.acquireHome(home), false);
  assert.equal(registry.releaseHome(home), false);
  assert.equal(registry.releaseHome(home), true);
  assert.equal(otherRegistry.acquireHome(home), true);
  otherRegistry.releaseAll();
});

test("real checkpoint and genesis mirror failures remain retryable only by the originating registry", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("requires POSIX directory permissions");
  for (const phase of ["checkpoint", "genesis"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-provider-retry-${phase}-`));
    const { root, lock } = leasePaths(home);
    t.after(() => { chmodSync(lock, 0o700); rmSync(home, { recursive: true, force: true }); });
    let fail = true;
    const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
      beforeInitializationMirrorForTest: (name) => {
        if (fail && (phase === "checkpoint" || name.startsWith("lease-"))) chmodSync(lock, 0o500);
      },
    });
    assert.throws(() => registry.acquireHome(home), /quarantine the entire.*do not remove individual records/s);
    const proof = readFileSync(join(root, "mutable-home.recovery.json"));
    const mirrors = readdirSync(lock).map((name) => ({ name, bytes: readFileSync(join(lock, name)) }));
    assert.equal(mirrors.length, phase === "checkpoint" ? 0 : 1);
    assert.equal(registry.releaseHome(home), false, "failed initialization was never granted");
    assert.throws(() => new ProviderHomeLeaseRegistry(OWNER_A).acquireHome(home), /already in use by process/);
    fail = false;
    chmodSync(lock, 0o700);
    assert.equal(registry.acquireHome(home), true);
    assert.deepEqual(readFileSync(join(root, "mutable-home.recovery.json")), proof);
    for (const mirror of mirrors) assert.deepEqual(readFileSync(join(lock, mirror.name)), mirror.bytes);
    assert.equal(readdirSync(lock).length, 2);
    assert.equal(registry.releaseHome(home), true);
  }
});

test("whole-root quarantine requires restarting the originating failed-initialization registry", (t) => {
  for (const phase of ["directory", "mirror"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-provider-quarantine-${phase}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const { root, lock } = leasePaths(home);
    const fail = () => { throw new Error("initialization failed before grant"); };
    const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
      afterInitializationPublishForTest: phase === "directory" ? fail : undefined,
      beforeInitializationMirrorForTest: phase === "mirror" ? fail : undefined,
    });
    const refusals: string[] = [];
    const refused = () => {
      assert.throws(() => registry.acquireHome(home), (error: unknown) => {
        refusals.push(String(error));
        return true;
      });
      assert.equal(registry.releaseHome(home), false, "initialization never granted the HOME");
    };
    refused();
    assert.equal(existsSync(lock), phase === "mirror");
    const quarantine = join(home, "quarantined-provider-home-leases-v1");
    const snapshot = () => readdirSync(quarantine, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => ({ path: join(entry.parentPath, entry.name), bytes: readFileSync(join(entry.parentPath, entry.name)) }));
    renameSync(root, quarantine);
    const evidence = snapshot();
    refused();
    refused();
    assert.equal(existsSync(lock), false, "the stale registry never creates a replacement lock");
    const restarted = new ProviderHomeLeaseRegistry(OWNER_A);
    assert.equal(restarted.acquireHome(home), true, "a fresh registry can acquire after safe quarantine");
    refused();
    assert.equal(restarted.releaseHome(home), true);
    assert.deepEqual(snapshot(), evidence, "all quarantined evidence remains intact");
    for (const message of refusals) {
      assert.match(message, /quarantine the entire.*restart the runner.*do not remove individual records/s);
    }
  }
});

test("failed initialization retry refuses changed evidence, successors, and rollback directories", (t) => {
  for (const change of ["proof", "owner", "host", "live-pid", "missing", "corrupt", "retained", "directory", "successor", "during-retry"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-provider-retry-refuse-${change}-`));
    const { root, lock } = leasePaths(home);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const proofPath = join(root, "mutable-home.recovery.json");
    const mutate = () => {
      const proof = JSON.parse(readFileSync(proofPath, "utf8"));
      writeFileSync(proofPath, JSON.stringify({ ...proof, createdAt: "changed" }));
    };
    const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
      pid: 101,
      afterInitializationPublishForTest: () => { throw new Error("failed before mkdir"); },
      beforeTransitionPublishForTest: change === "during-retry" ? mutate : undefined,
    });
    assert.throws(() => registry.acquireHome(home), /quarantine the entire/);
    const proof = JSON.parse(readFileSync(proofPath, "utf8"));
    if (change === "proof") mutate();
    if (change === "owner") writeFileSync(proofPath, JSON.stringify({ ...proof, ownerHash: OWNER_B }));
    if (change === "host") writeFileSync(proofPath, JSON.stringify({ ...proof, hostname: "foreign-host" }));
    if (change === "live-pid") writeFileSync(proofPath, `${JSON.stringify({ ...proof, pid: process.pid })}\n`);
    if (change === "missing") renameSync(proofPath, join(home, "retained-proof.json"));
    if (change === "corrupt") writeFileSync(proofPath, "{");
    if (change === "retained") writeFileSync(proofPath, JSON.stringify({ ...proof, recoveredEntriesHash: "c".repeat(64) }));
    if (change === "directory") mkdirSync(lock);
    if (change === "successor") {
      const hash = createHash("sha256").update(readFileSync(proofPath)).digest("hex");
      writeFileSync(join(root, `next-${proof.leaseId}.json`), JSON.stringify({
        ...proof, leaseId: LEGACY_ID, previousLeaseId: proof.leaseId, previousRecordHash: hash,
      }));
    }
    const evidencePath = change === "missing" ? join(home, "retained-proof.json") : proofPath;
    const before = readFileSync(evidencePath);
    assert.throws(() => registry.acquireHome(home), /quarantine the entire.*restart the runner.*do not remove individual records/s);
    if (change !== "during-retry") assert.deepEqual(readFileSync(evidencePath), before);
    assert.equal(registry.releaseHome(home), false);
    assert.equal(existsSync(lock), change === "directory", "refusal does not create a directory");
  }
});

test("retry does not adopt a substituted mirror directory even with identical record bytes", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-retry-substituted-"));
  const { root, lock } = leasePaths(home);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
    beforeInitializationMirrorForTest: () => { throw new Error("mirror failed"); },
  });
  assert.throws(() => registry.acquireHome(home), /quarantine the entire/);
  renameSync(lock, join(root, "original.lock"));
  mkdirSync(lock);
  const proofPath = join(root, "mutable-home.recovery.json");
  const proof = JSON.parse(readFileSync(proofPath, "utf8"));
  linkSync(proofPath, join(lock, "checkpoint.json"));
  linkSync(proofPath, join(lock, `lease-${proof.leaseId}.json`));
  assert.throws(() => registry.acquireHome(home), /quarantine the entire/);
  assert.equal(readdirSync(lock).length, 2);
});

test("a separate live process cannot claim a failed reservation before its origin retries", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-retry-process-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
    afterInitializationPublishForTest: () => { throw new Error("failed before mkdir"); },
  });
  assert.throws(() => registry.acquireHome(home), /quarantine the entire/);
  const helper = join(home, "contender.ts");
  writeFileSync(helper, `
    import assert from "node:assert/strict";
    import { ProviderHomeLeaseRegistry } from ${JSON.stringify(new URL("./provider-home-lease.ts", import.meta.url).href)};
    assert.throws(() => new ProviderHomeLeaseRegistry(${JSON.stringify(OWNER_A)}).acquireHome(${JSON.stringify(home)}), /already in use by process/);
  `);
  const child = spawn(process.execPath, ["--import", "tsx", helper], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(registry.acquireHome(home), true);
  registry.releaseAll();
});

test("a rollback initializer colliding with the proof gets the complete remedy on the first refusal", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-rollback-initializer-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 202, hostname: "host-a",
    afterInitializationPublishForTest: () => writePartialJournal(home, "lease"),
  });
  assert.throws(() => registry.acquire(request(home)), /quarantine the entire.*do not remove individual records/s);
  assert.equal(journalRecords(home).length, 1, "the conflicting initializer's ownership record is retained");
  const retry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 303, hostname: "host-a", isProcessAlive: () => false });
  assert.throws(() => retry.acquire(request(home)), /unexpected entries.*quarantine the entire/s);
});

test("a new process reclaims a killed initializer or active holder without filesystem cleanup", async (t) => {
  for (const phase of ["before-directory", "empty-directory", "active"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-provider-killed-${phase}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const helper = join(home, "killed-holder.ts");
    const ready = join(home, "ready");
    writeFileSync(helper, `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { ProviderHomeLeaseRegistry } from ${JSON.stringify(new URL("./provider-home-lease.ts", import.meta.url).href)};
      const home = ${JSON.stringify(home)};
      const hold = () => {
        writeFileSync(${JSON.stringify(ready)}, String(process.pid));
        for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
      };
      const registry = new ProviderHomeLeaseRegistry(${JSON.stringify(OWNER_A)}, {
        afterInitializationPublishForTest: () => {
          if (${JSON.stringify(phase)} === "active") return;
          if (${JSON.stringify(phase)} === "empty-directory") mkdirSync(join(home, ".agent-manager", "provider-home-leases-v1", "mutable-home.lock"));
          hold();
        },
      });
      registry.acquireHome(home);
      hold();
    `);
    const child = spawn(process.execPath, ["--import", "tsx", helper], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // The first real Windows bootstrap includes compiling and execution-probing the fixed
    // helper. Wait for the actual publication marker before killing; protocol limits stay fixed.
    const deadline = Date.now() + 30_000;
    while (!existsSync(ready) && child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const reported = existsSync(ready);
    child.kill("SIGKILL");
    await exited;
    assert.ok(reported, stderr);
    const replacement = new ProviderHomeLeaseRegistry(OWNER_A);
    assert.equal(replacement.acquireHome(home), true);
    assert.equal(replacement.releaseHome(home), true);
  }
});

test("an empty or missing mirror directory cannot hide a live canonical successor", (t) => {
  for (const removeDirectory of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), "wollipog-provider-missing-mirrors-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const first = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a" });
    first.acquire(request(home));
    const live = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 202, hostname: "host-a", isProcessAlive: () => false });
    live.acquire(request(home));
    const { lock } = leasePaths(home);
    for (const name of readdirSync(lock)) rmSync(join(lock, name));
    if (removeDirectory) rmSync(lock, { recursive: true });
    const contender = new ProviderHomeLeaseRegistry(OWNER_A, {
      pid: 303, hostname: "host-a", isProcessAlive: (pid) => pid === 202,
    });
    assert.throws(() => contender.acquire(request(home)), /already in use by process 202/);
    assert.equal(existsSync(lock), !removeDirectory, "refusal does not recreate an unowned directory");
    live.releaseAll();
    contender.acquire(request(home));
    contender.releaseAll();
  }
});

test("two partial-journal recoverers elect one fixed recovery checkpoint", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-partial-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writePartialJournal(home, "next");
  const winner = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 202, hostname: "host-a", isProcessAlive: (pid) => pid === 202,
  });
  const loser = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 303, hostname: "host-a", isProcessAlive: (pid) => pid === 202,
    beforeTransitionPublishForTest: () => winner.acquire(request(home)),
  });
  assert.throws(() => loser.acquire(request(home)), /lease changed during recovery/);
  assert.equal(JSON.parse(readFileSync(join(leasePaths(home).root, "mutable-home.recovery.json"), "utf8")).pid, 202);
  winner.releaseAll();
});

test("retained partial evidence and external canonical records are rechecked after recovery", (t) => {
  for (const mutate of ["retained", "canonical"] as const) {
    const home = mkdtempSync(join(tmpdir(), "wollipog-provider-recovery-corruption-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const lock = writePartialJournal(home, "next");
    const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 202, hostname: "host-a", isProcessAlive: () => false });
    registry.acquire(request(home));
    registry.releaseAll();
    const root = leasePaths(home).root;
    const path = mutate === "retained" ? join(lock, `next-${LEGACY_ID}.json`)
      : join(root, "mutable-home.recovery.json");
    writeFileSync(path, `${readFileSync(path, "utf8")} `);
    const contender = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 303, hostname: "host-a", isProcessAlive: () => false });
    assert.throws(() => contender.acquire(request(home)), /quarantine the entire/);
  }
});

test("container and cloud launches never lease the host provider HOME", () => {
  const remote: SpawnIsolation[] = [
    {
      backend: "container", runtime: "docker", command: "docker", args: [], image: `x@sha256:${"a".repeat(64)}`,
      network: "deny", templateId: "tools", runnerKey: "runner-key", containerName: "session",
      hostAgentCommand: "claude", hostAgentArgs: [], agentCommand: "claude", agentArgs: [],
      verifyRuntimeIdentity: () => {},
    },
    {
      backend: "cloud", command: "cloud-proxy", args: [], env: {}, targetId: "remote",
      handoffId: "handoff", sessionId: "session", hostAgentCommand: "claude",
      hostAgentArgs: [], agentCommand: "claude", agentArgs: [],
    },
  ];
  for (const isolation of remote) assert.equal(providerLaunchNeedsSharedHomeLease(isolation), false);
  assert.equal(providerLaunchNeedsSharedHomeLease(undefined), true);
  assert.equal(
    providerLaunchNeedsSharedHomeLease({ backend: "future-host-backend" } as unknown as SpawnIsolation),
    true, "an unknown backend fails closed by retaining the shared-home lease",
  );
});

test("protected bwrap with preserved provider state retains the shared-home lease", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-preserved-provider-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const isolated: SpawnIsolation = { backend: "bwrap", command: "bwrap", args: [], network: "inherit" };
  const preserved: SpawnIsolation = { ...isolated, preservesProviderHome: true };
  assert.equal(providerLaunchNeedsSharedHomeLease(isolated), false);
  assert.equal(providerLaunchNeedsSharedHomeLease(preserved), true);
  const first = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 101, hostname: "host-a", isProcessAlive: (pid) => pid === 101,
  });
  const second = new ProviderHomeLeaseRegistry(OWNER_B, {
    pid: 202, hostname: "host-a", isProcessAlive: (pid) => pid === 101,
  });
  first.acquire({ ...request(home), isolation: preserved });
  assert.throws(() => second.acquire({ ...request(home), isolation: preserved }), /already in use by process 101/);
  first.releaseAll();
  second.acquire({ ...request(home), isolation: preserved });
  second.releaseAll();
});

test("a configured credential home is created before its first lease", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-home-create-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "new-account");
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a" });
  registry.acquire(request(home));
  assert.equal(existsSync(home), true);
  assert.equal(existsSync(leasePaths(home).lock), true);
  registry.releaseAll();
});

test("provider-home leases are process-reentrant and reject a live competing owner", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 101, hostname: "host-a", isProcessAlive: (pid) => pid === 101,
  });
  const second = new ProviderHomeLeaseRegistry(OWNER_B, {
    pid: 202, hostname: "host-a", isProcessAlive: (pid) => pid === 101,
  });
  first.acquire(request(home));
  first.acquire(request(home));
  assert.throws(() => second.acquire(request(home)), /already in use by process 101/);
  first.releaseAll();
  second.acquire(request(home));
  second.releaseAll();
  assert.deepEqual(
    journalRecords(home).map((record) => record.state).sort(),
    ["active", "active", "released", "released"],
  );
});

test("provider-specific config homes, not the process HOME, own account leases", (t) => {
  const processHome = mkdtempSync(join(tmpdir(), "wollipog-process-home-"));
  const accountHome = mkdtempSync(join(tmpdir(), "wollipog-account-home-"));
  t.after(() => rmSync(processHome, { recursive: true, force: true }));
  t.after(() => rmSync(accountHome, { recursive: true, force: true }));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a" });
  registry.acquire({
    driver: "codex-app-server",
    command: "codex",
    context: { kind: "native" },
    env: { HOME: processHome, CODEX_HOME: accountHome },
  });
  assert.equal(existsSync(leasePaths(accountHome).lock), true);
  assert.equal(existsSync(leasePaths(processHome).lock), false);
  registry.releaseAll();
});

test("a validated stale same-owner legacy lease is migrated and reclaimed without emptying the lock", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-stale-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lock = writeLegacyLease(home);
  const replacement = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: process.pid, hostname: "host-a", isProcessAlive: () => false,
  });
  replacement.acquire(request(home));
  const entries = readdirSync(lock).sort();
  assert.equal(entries[0], "lease.json", "the legacy ownership evidence is never removed");
  assert.ok(entries.includes("protocol-v4.json"), "rollback readers must refuse the bounded format");
  assert.equal(JSON.parse(readFileSync(join(leasePaths(home).root, "mutable-home.recovery.json"), "utf8")).pid, process.pid);
  replacement.releaseAll();
});

test("a stale same-owner v2 lease is reclaimed after an ungraceful restart", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-v2-stale-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const crashed = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a" });
  crashed.acquire(request(home));
  const replacement = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 202, hostname: "host-a", isProcessAlive: () => false,
  });
  replacement.acquire(request(home));
  assert.equal(journalRecords(home).at(-1)?.pid, 202);
  replacement.releaseAll();
});

test("stale leases with a foreign owner or host and live leases all fail closed", (t) => {
  for (const scenario of ["owner", "host", "live"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-provider-home-${scenario}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writeLegacyLease(home, scenario === "host" ? { hostname: "host-b" } : {});
    const registry = new ProviderHomeLeaseRegistry(scenario === "owner" ? OWNER_B : OWNER_A, {
      pid: 202,
      hostname: "host-a",
      isProcessAlive: (pid) => scenario === "live" && pid === 101,
    });
    const expected = scenario === "owner" ? /another attested owner.*manually quarantine/ :
      scenario === "host" ? /leased by host host-b/ : /already in use by process 101/;
    assert.throws(() => registry.acquire(request(home)), (error) => {
      assert.match(String(error), expected);
      assert.ok(String(error).includes(leasePaths(home).lock), "the operator can locate the refused state");
      assert.match(String(error), /quarantine the entire.*do not remove individual records/);
      assert.ok(!String(error).includes(OWNER_A) && !String(error).includes(OWNER_B));
      assert.equal(providerHomeLeaseRefusalKind(error),
        scenario === "owner" ? "foreign_owner" : scenario === "host" ? "foreign_host" : "busy");
      return true;
    });
    assert.deepEqual(readdirSync(leasePaths(home).lock), ["lease.json"]);
  }
});

test("a same-owner lease with an unprobeable pid fails closed instead of reading as dead", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-badpid-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // Number.MAX_SAFE_INTEGER passes the record shape check but makes process.kill throw
  // ERR_OUT_OF_RANGE; the default liveness probe must treat that as malformed state, not death.
  writeLegacyLease(home, { pid: Number.MAX_SAFE_INTEGER });
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 202, hostname: "host-a" });
  assert.throws(() => registry.acquire(request(home)), /already in use/);
  assert.deepEqual(readdirSync(leasePaths(home).lock), ["lease.json"]);
});

test("a version-2 released legacy marker is rejected as fabricated handoff state", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-released-legacy-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lock = writeLegacyLease(home, {
    version: 2,
    state: "released",
    ownerHash: OWNER_B,
    hostname: "host-b",
    previousLeaseId: null,
    previousRecordHash: null,
  });
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 202, hostname: "host-a", isProcessAlive: () => true,
  });
  assert.throws(() => registry.acquire(request(home)), /unexpected entries/);
  assert.deepEqual(readdirSync(lock), ["lease.json"]);
});

test("a released genesis record is rejected as fabricated handoff state", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-released-genesis-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // A genesis is only ever published `active` (release appends a `next-*` record), so a lone
  // released genesis would skip every hostname/owner/liveness check if it were trusted.
  const { lock } = leasePaths(home);
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(join(lock, `lease-${LEGACY_ID}.json`), `${JSON.stringify({
    version: 2,
    state: "released",
    ownerHash: OWNER_B,
    leaseId: LEGACY_ID,
    previousLeaseId: null,
    previousRecordHash: null,
    pid: 101,
    hostname: "host-b",
    provider: "claude",
    createdAt: "2026-08-19T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 202, hostname: "host-a", isProcessAlive: () => false,
  });
  assert.throws(() => registry.acquire(request(home)), /unexpected entries/);
  assert.deepEqual(readdirSync(lock), [`lease-${LEGACY_ID}.json`]);
});

test("a released successor that rewrites the releasing lease's identity is rejected", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-forged-release-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const holder = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a" });
  holder.acquire(request(home));
  // Forge a hash-linked "released" successor that swaps in a foreign owner, host, and pid.
  // releaseAll copies the active record's identity verbatim, so this transition is impossible.
  const { lock } = leasePaths(home);
  const genesisName = readdirSync(lock)[0]!;
  const genesisBytes = readFileSync(join(lock, genesisName));
  const genesis = JSON.parse(genesisBytes.toString("utf8")) as Record<string, unknown>;
  writeFileSync(join(lock, `next-${genesis.leaseId}.json`), `${JSON.stringify({
    ...genesis,
    state: "released",
    leaseId: LEGACY_ID,
    previousLeaseId: genesis.leaseId,
    previousRecordHash: createHash("sha256").update(genesisBytes).digest("hex"),
    ownerHash: OWNER_B,
    hostname: "host-b",
    pid: 303,
  })}\n`, { mode: 0o600 });
  const contender = new ProviderHomeLeaseRegistry("c".repeat(64), {
    pid: 404, hostname: "host-c", isProcessAlive: () => true,
  });
  assert.throws(() => contender.acquire(request(home)), /unexpected entries/);
  assert.equal(readdirSync(lock).length, 3, "the forged journal gains no successor");
});

test("an active successor that rewrites owner or host over an unreleased record is rejected", (t) => {
  // One rewritten field per scenario, so each readChain comparison is pinned independently.
  for (const forgery of [{ ownerHash: OWNER_B }, { hostname: "host-b" }]) {
    const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-forged-reclaim-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const holder = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a" });
    holder.acquire(request(home));
    // Forge active(forged identity) over the live active(A) genesis, then a clean release of the
    // forgery — reclaim can only append an active successor with the SAME owner and host, so this
    // chain is impossible; trusting its released tip would hand the HOME to any contender.
    const { lock } = leasePaths(home);
    const genesisName = readdirSync(lock)[0]!;
    const genesisBytes = readFileSync(join(lock, genesisName));
    const genesis = JSON.parse(genesisBytes.toString("utf8")) as Record<string, unknown>;
    const FORGED_ID = "22222222-2222-4222-8222-222222222222";
    const forgedActive = `${JSON.stringify({
      ...genesis,
      state: "active",
      leaseId: FORGED_ID,
      previousLeaseId: genesis.leaseId,
      previousRecordHash: createHash("sha256").update(genesisBytes).digest("hex"),
      pid: 303,
      ...forgery,
    })}\n`;
    writeFileSync(join(lock, `next-${genesis.leaseId}.json`), forgedActive, { mode: 0o600 });
    writeFileSync(join(lock, `next-${FORGED_ID}.json`), `${JSON.stringify({
      ...JSON.parse(forgedActive) as Record<string, unknown>,
      state: "released",
      leaseId: LEGACY_ID,
      previousLeaseId: FORGED_ID,
      previousRecordHash: createHash("sha256").update(Buffer.from(forgedActive)).digest("hex"),
    })}\n`, { mode: 0o600 });
    const contender = new ProviderHomeLeaseRegistry("c".repeat(64), {
      pid: 404, hostname: "host-c", isProcessAlive: () => true,
    });
    assert.throws(() => contender.acquire(request(home)), /unexpected entries/);
    assert.equal(readdirSync(lock).length, 4, "the forged journal gains no successor");
  }
});

test("one fixed successor elects exactly one of two concurrent same-owner reclaimers", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeLegacyLease(home);
  const winner = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: process.pid, hostname: "host-a", isProcessAlive: (pid) => pid === process.pid,
  });
  let raced = false;
  const loser = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 303,
    hostname: "host-a",
    isProcessAlive: (pid) => pid === process.pid,
    beforeTransitionPublishForTest: () => {
      if (!raced) {
        raced = true;
        winner.acquire(request(home));
      }
    },
  });
  assert.throws(() => loser.acquire(request(home)), /lease changed during recovery/);
  const selected = JSON.parse(readFileSync(join(leasePaths(home).root, "mutable-home.recovery.json"), "utf8"));
  assert.equal(selected.state, "active");
  assert.equal(selected.pid, process.pid);
  winner.releaseAll();
});

// The race's fixed allowance for work other than lease helper calls: process scheduling, IPC and the
// fixture's own barriers. Before readiness no helper call has been measured, so this is the whole
// deadline then.
const SUCCESSOR_REPORT_MS = 10_000;
const SUCCESSOR_CLEANUP_MS = 5_000;
// Each lease helper call is a separate process. On Linux and macOS it takes milliseconds; on
// windows-latest it starts powershell.exe and takes about half a second, more under load, so a
// fixed deadline there covered only about twenty calls (#3859). Each contender measures one call
// before it reports ready, and every helper-call allowance below scales with the slower of the two.
// The allowances are fixed counts, so a contender looping on helper calls still misses its budget.
// Measured on windows-latest: a winning acquisition makes 11 calls (5 before and 8 after a
// catch-up refusal), a losing one 2, and the loser's verification 1.
const SUCCESSOR_HELPER_CALLS = { acquisition: 16, catchUpRetry: 12, publication: 4, release: 12 } as const;
// Phases in the critical path share the fixed allowance; each still gets its own slack so a single
// slow phase is named in the failure.
const SUCCESSOR_PHASE_SLACK_MS = 3_000;
// Caps the measured call, so a broken helper cannot stretch one race past 58 seconds or its
// cleanup past 23. verify-successor-election-load.mjs sizes its enclosing timeouts from these.
const SUCCESSOR_HELPER_CALL_CEILING_MS = 1_500;

type SuccessorBudget = {
  helperCallMs: number; reportMs: number; cleanupMs: number;
  acquisitionMs: number; catchUpRetryMs: number; publicationMs: number;
};

function successorBudget(measuredCallMs: number): SuccessorBudget {
  const helperCallMs = Math.min(measuredCallMs, SUCCESSOR_HELPER_CALL_CEILING_MS);
  const calls = (count: number) => Math.ceil(count * helperCallMs);
  const { acquisition, catchUpRetry, publication, release } = SUCCESSOR_HELPER_CALLS;
  return {
    helperCallMs: Math.ceil(helperCallMs),
    reportMs: SUCCESSOR_REPORT_MS + calls(acquisition + catchUpRetry + publication),
    cleanupMs: SUCCESSOR_CLEANUP_MS + calls(release),
    acquisitionMs: SUCCESSOR_PHASE_SLACK_MS + calls(acquisition),
    catchUpRetryMs: SUCCESSOR_PHASE_SLACK_MS + calls(catchUpRetry),
    publicationMs: SUCCESSOR_PHASE_SLACK_MS + calls(publication),
  };
}

type SuccessorPhaseState = {
  phase: string; phaseAt: number; spawnedAt: number; ready: boolean; timings: Record<string, number>;
};

/** Names each phase of one contender that ran past its budget, finished or still running at `now`. */
function successorOverruns(state: SuccessorPhaseState, budget: SuccessorBudget, readinessMs: number, now: number): string[] {
  const overruns: string[] = [];
  const running = (...phases: string[]) => phases.includes(state.phase) ? now - state.phaseAt : undefined;
  const check = (label: string, ms: number | undefined, budgetMs: number, calls?: number) => {
    if (ms === undefined || ms <= budgetMs) return;
    overruns.push(`${label} ${Math.round(ms)}ms > ${budgetMs}ms${calls === undefined ? " (running)" : ` (${calls} helper calls)`}`);
  };
  const { timings } = state;
  if (!state.ready) check("startup", now - state.spawnedAt, readinessMs);
  check("acquisition", timings.initialAcquisitionMs ?? running("acquiring"), budget.acquisitionMs, timings.initialAcquisitionHelperCalls);
  check("catch-up retry", timings.catchUpRetryMs ?? running("catching-up"), budget.catchUpRetryMs, timings.catchUpRetryHelperCalls);
  // A losing contender's wait for the winner's claim is the winner's time, not its own publication.
  const publication = timings.publicationMs === undefined ? running("publishing", "verifying") : timings.publicationMs - (timings.peerWaitMs ?? 0);
  check("publication", publication, budget.publicationMs, timings.publicationHelperCalls);
  check("release", running("releasing"), budget.cleanupMs);
  return overruns;
}

type SuccessorRaceOptions = {
  startupDelayMs?: number;
  publicationDelayMs?: number;
  readinessMs?: number;
  cleanupGraceMs?: number;
  signal?: AbortSignal;
  onReady?: () => void;
  beforeRemoveRoot?: (root: string) => void;
  fault?: "before-ready" | "hang-before-ready" | "hang-in-publication" | "hang-after-report" | "both-refuse" | "both-win" | "transient-catch-up";
};

async function runSuccessorElectionRace(t: TestContext, options: SuccessorRaceOptions = {}) {
  const root = mkdtempSync(join(process.env.WOLLIPOG_SUCCESSOR_FIXTURE_PARENT ?? tmpdir(), "wollipog-provider-home-process-race-"));
  const home = join(root, "home");
  const staging = join(root, "staging");
  const start = join(root, "start");
  const release = join(root, "release");
  const helper = join(root, "race-helper.mjs");
  const moduleUrl = new URL("./provider-home-lease.ts", import.meta.url).href;
  const ioUrl = new URL("./provider-home-lease-io.ts", import.meta.url).href;
  const states: Array<{
    child: AgentProcess; name: string; phase: string; phaseAt: number; spawnedAt: number;
    ready: boolean; reported: boolean; closed: boolean; code: number | null;
    signal: NodeJS.Signals | null; stderr: string; error?: string;
    timings: Record<string, number>; outcome?: string; checkpointFailures: string[]; overBudget?: string[];
  }> = [];
  const readinessMs = options.readinessMs ?? 10_000;
  // Fixed when the start barrier is published, from the helper calls measured during readiness.
  let budget = successorBudget(0);
  const recordOverruns = () => {
    const now = performance.now();
    for (const state of states) state.overBudget = successorOverruns(state, budget, readinessMs, now);
  };
  let failure: string | undefined;
  let cleanupProved = true;
  const cleanupFailures: string[] = [];
  let outcomes: string[] = [];
  const sanitize = (text: string) => text.replaceAll(home, "<fixture-home>")
    .replaceAll(home.replaceAll("\\", "/"), "<fixture-home>")
    .replace(/\b[A-Za-z]:[\\/][^\r\n"')]+/g, "<path>")
    .replace(/\/(?:[^\s:/'")]+\/)+[^\s:'")]+/g, "<path>");
  const details = () => states.map((state) => ({
    contender: state.name, phase: state.phase,
    elapsedMs: Math.round(performance.now() - state.spawnedAt),
    phaseElapsedMs: Math.round(performance.now() - state.phaseAt),
    timings: state.timings, ...(state.overBudget && { overBudget: state.overBudget }),
    outcome: sanitize(state.outcome ?? outcomes[states.indexOf(state)] ?? "unreported"),
    exitCode: state.code, signal: state.signal, closed: state.closed,
    stderr: sanitize(state.stderr), error: state.error,
    checkpointFailures: state.checkpointFailures.map(sanitize),
  }));
  async function waitUntil(predicate: () => boolean, ms: number, monitor = false): Promise<boolean> {
    const deadline = performance.now() + ms;
    for (;;) {
      if (monitor) {
        if (t.signal.aborted || options.signal?.aborted) throw new Error("successor election cancelled");
        if (states.some((state) => state.error || (state.closed && !state.reported))) {
          throw new Error("contender failed before publishing its result");
        }
      }
      if (predicate()) return true;
      if (performance.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async function forceCleanup(state: (typeof states)[number]): Promise<boolean> {
    const child = state.child;
    if (state.closed) return true;
    const deadline = performance.now() + 5_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cleaned = await Promise.race([
        killTreeAndWait(child),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 5_000); }),
      ]);
      return cleaned && await waitUntil(() => state.closed, Math.max(0, deadline - performance.now()));
    } finally { if (timer) clearTimeout(timer); }
  }
  try {
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(staging, { mode: 0o700 });
    writeLegacyLease(home, { pid: 2_147_483_647 });
    writeFileSync(helper, `
      import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
      import { ProviderHomeLeaseRegistry } from ${JSON.stringify(moduleUrl)};
      import { ensureLeaseIoAvailable, observeLeaseIoRunsForTest, readLeaseIoSnapshot, withLeaseIoOptions, LeaseIoError } from ${JSON.stringify(ioUrl)};
      const [home, result, start, release, fault, peerResult] = process.argv.slice(2);
      const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const checkpointFailures = [];
      // Fixed-helper calls since the last phase boundary, so each phase reports the calls it made.
      const helper = { calls: 0, ms: 0, slowestMs: 0 };
      observeLeaseIoRunsForTest((run) => { helper.calls++; helper.ms += run.durationMs; helper.slowestMs = Math.max(helper.slowestMs, run.durationMs); });
      const helperWork = (name) => {
        const work = { [name + "HelperCalls"]: helper.calls, [name + "HelperMs"]: helper.ms, [name + "SlowestHelperMs"]: helper.slowestMs };
        helper.calls = 0; helper.ms = 0; helper.slowestMs = 0;
        return work;
      };
      const phase = (name, timings = {}, outcome) => new Promise((resolve, reject) => {
        process.send({ phase: name, timings, outcome, checkpointFailures }, (error) => error ? reject(error) : resolve());
      });
      // Outlasts the parent's race deadline, so a slow winner is reported by the parent's
      // phase budgets rather than as a loser's barrier timeout.
      const waitFor = (path) => {
        const deadline = performance.now() + ${successorBudget(SUCCESSOR_HELPER_CALL_CEILING_MS).reportMs + 5_000};
        while (!existsSync(path)) {
          if (performance.now() >= deadline) throw new Error("fixture barrier timed out");
          pause(5);
        }
      };
      const hang = () => {
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1_000);
        return new Promise(() => {});
      };
      let registry;
      try {
        await phase("initializing");
        if (fault === "before-ready") throw new Error("synthetic failure at " + home);
        if (fault === "hang-before-ready") await hang();
        const initializedAt = performance.now();
        withLeaseIoOptions({ providerHome: home }, ensureLeaseIoAvailable);
        const initializationMs = performance.now() - initializedAt;
        // Measure one read-only helper call on this host and load, against a private empty root.
        // Canonical like a leased HOME: the helper refuses symlinked ancestry such as macOS /var.
        mkdirSync(result + ".calibration", { mode: 0o700 });
        const calibration = realpathSync(result + ".calibration");
        helperWork("initialization");
        withLeaseIoOptions({ providerHome: home }, () => readLeaseIoSnapshot(calibration));
        const helperCallMs = helper.slowestMs;
        if (helper.calls !== 1) throw new Error("helper calibration made " + helper.calls + " calls");
        helperWork("calibration");
        registry = new ProviderHomeLeaseRegistry(${JSON.stringify(OWNER_A)}, {
          hostname: "host-a",
          disableCompactionForTest: fault === "transient-catch-up",
          onCheckpointFailureForTest: (error) => checkpointFailures.push(error instanceof Error ? error.message : String(error)),
        });
        pause(${options.startupDelayMs ?? 0});
        await phase("ready", { initializationMs, helperCallMs });
        waitFor(start);
        await phase("acquiring");
        const acquisitionAt = performance.now();
        let catchUpAt;
        const acquisitionTimings = {};
        let outcome;
        let catchUpRetries = 0;
        for (;;) {
          try {
            registry.acquire({ driver: "claude-code", command: "claude", context: { kind: "native" }, env: { HOME: home } });
            outcome = "won";
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Only the registry holding the published successor gets this refusal (#3801). The
            // product keeps its reservation and asks the runner to retry with the same registry,
            // as a runner does; the retry count and checkpoint failures stay in the diagnostics.
            if (catchUpRetries < 3 && /bounded catch-up before this HOME can be granted; preserve the acquired reservation and retry with this registry/.test(message)) {
              if (catchUpAt === undefined) {
                catchUpAt = performance.now();
                Object.assign(acquisitionTimings, { initialAcquisitionMs: catchUpAt - acquisitionAt }, helperWork("initialAcquisition"));
                await phase("catching-up", acquisitionTimings);
              }
              catchUpRetries++;
              // The fault fails only the first catch-up: re-enable the checkpoint this registry disabled.
              if (fault === "transient-catch-up") registry.disableCompactionForTest = false;
              pause(25);
              continue;
            }
            const refusal = (error instanceof Error && typeof error.reason === "string") ||
              (error instanceof LeaseIoError && error.kind === "busy");
            if (!refusal && !/already in use by process|lease changed during recovery/.test(message)) throw error;
            outcome = "lost:" + message;
            break;
          }
        }
        if (fault === "both-refuse") outcome = "lost:synthetic refusal after acquisition";
        if (fault === "both-win") outcome = "won";
        const acquiredAt = performance.now();
        const acquisitionMs = acquiredAt - acquisitionAt;
        if (catchUpAt === undefined) Object.assign(acquisitionTimings, { initialAcquisitionMs: acquisitionMs }, helperWork("initialAcquisition"));
        else Object.assign(acquisitionTimings, { catchUpRetryMs: acquiredAt - catchUpAt }, helperWork("catchUpRetry"));
        writeFileSync(result + ".claim.tmp", JSON.stringify({ outcome, pid: process.pid }));
        renameSync(result + ".claim.tmp", result + ".claim");
        await phase("publishing", { acquisitionMs, catchUpRetries, ...acquisitionTimings }, outcome);
        if (fault === "hang-in-publication") await hang();
        const publicationAt = performance.now();
        pause(${options.publicationDelayMs ?? 0});
        let verificationMs = 0;
        let peerWaitMs = 0;
        if (outcome.startsWith("lost:")) {
          // A transient verification refusal is a valid losing outcome, but after the
          // winner publishes, its canonical lease must be readable and exclude us.
          await phase("awaiting-winner");
          const peerWaitAt = performance.now();
          waitFor(peerResult + ".claim");
          const peer = JSON.parse(readFileSync(peerResult + ".claim", "utf8"));
          if (peer.outcome !== "won") throw new Error("both contenders refused; no winning claim");
          if (!Number.isInteger(peer.pid) || peer.pid === process.pid) throw new Error("invalid winning process claim");
          waitFor(peerResult);
          peerWaitMs = performance.now() - peerWaitAt;
          await phase("verifying", { peerWaitMs });
          const verificationAt = performance.now();
          const verifier = new ProviderHomeLeaseRegistry(${JSON.stringify(OWNER_A)}, { hostname: "host-a" });
          let excluded = false;
          try {
            verifier.acquire({ driver: "claude-code", command: "claude", context: { kind: "native" }, env: { HOME: home } });
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            const ownerPid = /already in use by process (\\d+)/.exec(error.message)?.[1];
            if (Number(ownerPid) !== peer.pid) throw error;
            excluded = true;
          } finally { verifier.releaseAll(); }
          if (!excluded) throw new Error("a live winning process must exclude a competing process");
          verificationMs = performance.now() - verificationAt;
        }
        writeFileSync(result, outcome);
        await phase("reported", { publicationMs: performance.now() - publicationAt, peerWaitMs, verificationMs, ...helperWork("publication") });
        if (fault === "hang-after-report") await hang();
        if (outcome === "won") {
          await phase("holding");
          waitFor(release);
          await phase("releasing");
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      } finally {
        registry?.releaseAll();
        process.disconnect();
      }
    `);
    const results = [join(root, "result-a"), join(root, "result-b")];
    for (const [index, result] of results.entries()) {
      const spawnedAt = performance.now();
      // Either contender may win, so faults that model the election itself reach both of them.
      const bothFault = options.fault === "both-refuse" || options.fault === "both-win" || options.fault === "transient-catch-up";
      const child = spawn(process.execPath, ["--import", "tsx", helper, home, result, start, release, (index === 0 || bothFault) ? options.fault ?? "" : "", results[1 - index]!], {
        env: { ...process.env, TMPDIR: staging, TMP: staging, TEMP: staging },
        detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe", "ipc"],
      }) as AgentProcess;
      const state = {
        child, name: `contender-${index === 0 ? "a" : "b"}`, phase: "launching", phaseAt: spawnedAt,
        spawnedAt, ready: false, reported: false, closed: false,
        code: null as number | null, signal: null as NodeJS.Signals | null, stderr: "",
        error: undefined as string | undefined, outcome: undefined as string | undefined, timings: {} as Record<string, number>,
        checkpointFailures: [] as string[],
      };
      states.push(state);
      child.stderr?.on("data", (chunk) => { state.stderr = (state.stderr + String(chunk)).slice(-8_192); });
      child.on("message", (message) => {
        const report = message as { phase: string; timings: Record<string, number>; outcome?: string; checkpointFailures?: string[] };
        state.phase = report.phase;
        state.phaseAt = performance.now();
        Object.assign(state.timings, report.timings);
        if (report.outcome !== undefined) state.outcome = report.outcome;
        if (Array.isArray(report.checkpointFailures)) state.checkpointFailures = report.checkpointFailures.slice(0, 8).map(String);
        if (report.phase === "ready") {
          state.ready = true;
          state.timings.startupMs = state.phaseAt - spawnedAt;
        }
        if (report.phase === "reported") state.reported = true;
      });
      child.once("error", (error) => { state.error = sanitize(error.message); });
      child.once("close", (code, signal) => {
        child.closeObserved = true;
        state.closed = true; state.code = code; state.signal = signal;
      });
      // Advisory evidence only: a PID can be reused after the fixture dies.
      writeFileSync(join(root, "contenders.json"), JSON.stringify({
        version: 1, contenders: states.map((entry) => ({ pid: entry.child.pid, detached: process.platform !== "win32" })),
      }));
    }
    // Windows measurements exceeded five seconds during both setup and actual
    // acquisition/verification. Readiness keeps its own finite bound, and the race's bound
    // scales with the helper calls measured during readiness; no production deadline changes.
    if (!await waitUntil(() => states.every((state) => state.ready), readinessMs, true)) {
      recordOverruns();
      assert.fail("contender readiness timed out");
    }
    options.onReady?.();
    if (t.signal.aborted || options.signal?.aborted) throw new Error("successor election cancelled");
    budget = successorBudget(Math.max(0, ...states.map((state) => state.timings.helperCallMs ?? 0)));
    t.diagnostic(`successor election budget: ${JSON.stringify(budget)}`);
    writeFileSync(start, "go");
    if (!await waitUntil(() => states.every((state) => state.reported), budget.reportMs, true)) {
      recordOverruns();
      assert.fail("both contenders report before the race deadline");
    }
    outcomes = results.map((result) => readFileSync(result, "utf8"));
    assert.equal(outcomes.filter((outcome) => outcome === "won").length, 1, "exactly one winner");
    assert.equal(outcomes.filter((outcome) => outcome.startsWith("lost:")).length, 1, "exactly one refusal");
  } catch (error) {
    failure = sanitize(error instanceof Error ? error.message : String(error));
  } finally {
    try { writeFileSync(release, "done"); } catch { cleanupFailures.push("fixture release publication failed"); }
    if (!await waitUntil(() => states.every((state) => state.closed), options.cleanupGraceMs ?? budget.cleanupMs)) {
      if (!failure) recordOverruns();
      failure ??= "contenders required forced cleanup";
      const cleaned = await Promise.all(states.map((state) => forceCleanup(state)));
      cleanupProved = cleaned.every(Boolean);
      if (!cleanupProved) cleanupFailures.push("fixture-owned tree cleanup incomplete");
    }
    if (cleanupProved && states.every((state) => state.closed)) {
      try {
        options.beforeRemoveRoot?.(root);
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch (error) { cleanupFailures.push("temporary fixture cleanup failed: " + sanitize(String(error))); }
    } else {
      cleanupFailures.push("fixture-owned tree cleanup incomplete; temporary HOME retained");
    }
  }
  if (cleanupFailures.length) failure = [failure, ...cleanupFailures].filter(Boolean).join("; ");
  if (states.some((state) => state.code !== 0)) failure ??= "contenders must exit successfully";
  if (failure) throw new Error(`${failure}; ${JSON.stringify(details())}`);
  const phases = states.map((state) => ({
    contender: state.name, ...state.timings, catchUpRetries: state.timings.catchUpRetries ?? 0,
    checkpointFailures: state.checkpointFailures.map(sanitize),
  }));
  t.diagnostic(`successor election phases: ${JSON.stringify(phases)}`);
  return phases;
}

function assertSuccessorFailureClosed(error: unknown, expected: RegExp): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, expected);
  assert.doesNotMatch(error.message, /cleanup incomplete|temporary fixture cleanup failed/);
  const marker = error.message.indexOf("; [");
  assert.ok(marker >= 0, "contender diagnostics are present");
  const contenders = JSON.parse(error.message.slice(marker + 2)) as Array<{ closed: boolean }>;
  assert.equal(contenders.length, 2);
  assert.ok(contenders.every((contender) => contender.closed === true), "both owned contenders closed");
  return true;
}

test("the exclusive successor elects one winner across real runner processes", async (t) => {
  await runSuccessorElectionRace(t);
});

test("successor election uses its load harness's owned fixture parent", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "wollipog-successor-parent-test-"));
  const previous = process.env.WOLLIPOG_SUCCESSOR_FIXTURE_PARENT;
  process.env.WOLLIPOG_SUCCESSOR_FIXTURE_PARENT = parent;
  t.after(() => {
    if (previous === undefined) delete process.env.WOLLIPOG_SUCCESSOR_FIXTURE_PARENT;
    else process.env.WOLLIPOG_SUCCESSOR_FIXTURE_PARENT = previous;
    rmSync(parent, { recursive: true, force: true });
  });
  let observedRoot: string | undefined;
  let recorded: { contenders: Array<{ pid: number }> } | undefined;
  await runSuccessorElectionRace(t, { beforeRemoveRoot(root) {
    observedRoot = root;
    recorded = JSON.parse(readFileSync(join(root, "contenders.json"), "utf8"));
  } });
  assert.ok(observedRoot, "the real fixture reached proved cleanup");
  assert.equal(dirname(observedRoot), parent, "the harness can locate all fixture state after an outer timeout");
  assert.equal(recorded?.contenders.length, 2);
  assert.ok(recorded.contenders.every(({ pid }) => Number.isInteger(pid) && pid > 0 && pid !== process.pid));
  assert.deepEqual(readdirSync(parent), [], "ordinary fixture cleanup leaves an empty parent");
});

test("successor election keeps slow startup out of the result deadline", async (t) => {
  // Startup must exceed the reporting window: removing only the readiness wait
  // must expire reporting before either contender can publish. Without readiness no
  // helper call has been measured, so that window is SUCCESSOR_REPORT_MS. Keep two seconds
  // of separation plus the normal ten-second setup margin for native initialization.
  const startupDelayMs = SUCCESSOR_REPORT_MS + 2_000;
  await runSuccessorElectionRace(t, { startupDelayMs, readinessMs: startupDelayMs + 10_000 });
});

test("successor election diagnoses startup failure without exposing fixture paths", async (t) => {
  await assert.rejects(runSuccessorElectionRace(t, { fault: "before-ready", cleanupGraceMs: 50 }), (error: Error) => {
    assert.match(error.message, /contender failed before publishing/);
    assert.match(error.message, /synthetic failure at <fixture-home>/);
    assert.doesNotMatch(error.message, /wollipog-provider-home-process-race-/);
    return assertSuccessorFailureClosed(error, /contender failed before publishing/);
  });
});

test("successor election bounds a hung readiness phase and reaps owned contenders", async (t) => {
  await assert.rejects(runSuccessorElectionRace(t, {
    fault: "hang-before-ready", readinessMs: 1_000, cleanupGraceMs: 50,
  }), (error) => assertSuccessorFailureClosed(error, /contender readiness timed out/));
});

// Readiness, the measured race deadline at its ceiling, and forced cleanup.
test("successor election keeps its result deadline and reaps a stalled publisher", { timeout: 90_000 }, async (t) => {
  await assert.rejects(runSuccessorElectionRace(t, {
    fault: "hang-in-publication", cleanupGraceMs: 50,
  }), (error: Error) => {
    // The stalled contender is the one named over its publication budget.
    assert.match(error.message, /"contender":"contender-a","phase":"publishing",[^\]]*"overBudget":\["publication \d+ms > \d+ms \(running\)"\]/);
    return assertSuccessorFailureClosed(error, /both contenders report before the race deadline;.*"phase":"publishing"/);
  });
});

test("successor election rejects a contender that reports but cannot exit", async (t) => {
  await assert.rejects(runSuccessorElectionRace(t, {
    fault: "hang-after-report", cleanupGraceMs: 50,
  }), (error) => assertSuccessorFailureClosed(error, /contenders required forced cleanup/));
});

test("successor election diagnoses two refusals without a publication timeout", async (t) => {
  await assert.rejects(runSuccessorElectionRace(t, { fault: "both-refuse", cleanupGraceMs: 50 }), (error: Error) => {
    assert.match(error.message, /both contenders refused; no winning claim/);
    assert.doesNotMatch(error.message, /both contenders report before the race deadline/);
    assert.equal((error.message.match(/"outcome":"lost:/g) ?? []).length, 2);
    return assertSuccessorFailureClosed(error, /contender failed before publishing/);
  });
});

test("successor election rejects two contenders that both claim the win", async (t) => {
  await assert.rejects(runSuccessorElectionRace(t, { fault: "both-win" }), (error: Error) => {
    assert.equal((error.message.match(/"outcome":"won"/g) ?? []).length, 2);
    return assertSuccessorFailureClosed(error, /exactly one winner/);
  });
});

test("successor election budget scales its helper-call allowances with the measured call", () => {
  const fast = successorBudget(4);
  assert.equal(fast.reportMs, SUCCESSOR_REPORT_MS + 4 * 32, "a millisecond-scale helper leaves the fixed allowance in charge");
  const windows = successorBudget(500);
  assert.deepEqual(windows, {
    helperCallMs: 500, reportMs: 26_000, cleanupMs: 11_000, acquisitionMs: 11_000, catchUpRetryMs: 9_000, publicationMs: 5_000,
  });
  assert.deepEqual(successorBudget(10_000), successorBudget(SUCCESSOR_HELPER_CALL_CEILING_MS), "a broken helper cannot stretch the race past its ceiling");
  assert.equal(successorBudget(10_000).reportMs, 58_000);
  assert.equal(successorBudget(10_000).cleanupMs, 23_000);
  assert.equal(successorBudget(0).reportMs, SUCCESSOR_REPORT_MS, "an unmeasured race keeps the fixed deadline");
});

test("successor election names the phase that ran past its budget", () => {
  const budget = successorBudget(500);
  const at = (phase: string, phaseAt: number, timings: Record<string, number> = {}, ready = true) =>
    successorOverruns({ phase, phaseAt, spawnedAt: 0, ready, timings }, budget, 10_000, 40_000);
  assert.deepEqual(at("initializing", 100, {}, false), ["startup 40000ms > 10000ms (running)"]);
  assert.deepEqual(at("acquiring", 28_000, { helperCallMs: 500 }), ["acquisition 12000ms > 11000ms (running)"]);
  assert.deepEqual(at("acquiring", 30_000, { helperCallMs: 500 }), [], "an acquisition inside its budget is not named");
  assert.deepEqual(at("catching-up", 30_000, { initialAcquisitionMs: 9_850, initialAcquisitionHelperCalls: 19 }),
    ["catch-up retry 10000ms > 9000ms (running)"]);
  assert.deepEqual(at("holding", 39_000, {
    initialAcquisitionMs: 12_500, initialAcquisitionHelperCalls: 25, catchUpRetryMs: 1_000, catchUpRetryHelperCalls: 2, publicationMs: 1,
  }), ["acquisition 12500ms > 11000ms (25 helper calls)"]);
  // A loser's wait for the winner's claim is the winner's time, not its own publication.
  assert.deepEqual(at("reported", 39_000, { initialAcquisitionMs: 2_000, publicationMs: 8_539, peerWaitMs: 7_600, verificationMs: 892 }), []);
  assert.deepEqual(at("verifying", 34_000), ["publication 6000ms > 5000ms (running)"]);
  assert.deepEqual(at("awaiting-winner", 0), [], "waiting for the winner names the winner's phase instead");
  assert.deepEqual(at("releasing", 28_000), ["release 12000ms > 11000ms (running)"]);
});

test("successor election lets the winning reservation finish a transient catch-up refusal", async (t) => {
  // #3801: the contender that published the successor can still fail its first bounded catch-up.
  // The product preserves that reservation and asks for a retry with the same registry; without
  // the retry neither contender wins, and the forced-cleanup case above reports the wrong failure.
  const phases = await runSuccessorElectionRace(t, { fault: "transient-catch-up" });
  assert.equal(phases.reduce((sum, phase) => sum + phase.catchUpRetries, 0), 1, "exactly the winner retried once");
  assert.deepEqual(phases.flatMap((phase) => phase.checkpointFailures), ["checkpoint disabled for unavailable-storage validation"],
    "the failed first catch-up stays visible in the diagnostics");
});

test("successor election preserves removal errors after an earlier failure", async (t) => {
  await assert.rejects(runSuccessorElectionRace(t, {
    fault: "before-ready", cleanupGraceMs: 50,
    beforeRemoveRoot: (root) => {
      t.after(() => rmSync(root, { recursive: true, force: true }));
      throw new Error("synthetic removal failure");
    },
  }), (error: Error) => {
    assert.match(error.message, /contender failed before publishing/);
    assert.match(error.message, /temporary fixture cleanup failed: Error: synthetic removal failure/);
    const contenders = JSON.parse(error.message.slice(error.message.indexOf("; [") + 2)) as Array<{ closed: boolean }>;
    assert.equal(contenders.length, 2);
    assert.ok(contenders.every((contender) => contender.closed));
    return true;
  });
});

test("successor election cancellation cleans its contenders and preserves an unrelated child", async (t) => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => unrelated.once("close", () => resolve()));
  t.after(async () => { unrelated.kill("SIGKILL"); await closed; }, { timeout: 5_000 });
  const controller = new AbortController();
  await assert.rejects(runSuccessorElectionRace(t, {
    signal: controller.signal, onReady: () => controller.abort(), cleanupGraceMs: 50,
  }), (error) => assertSuccessorFailureClosed(error, /successor election cancelled/));
  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
});

test("completing a verified canonical mirror during takeover succeeds on the first attempt", (t) => {
  for (const phase of ["checkpoint", "genesis", "release"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-provider-mirror-${phase}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const holder = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a" });
    holder.acquireHome(home);
    holder.releaseAll();
    const { root, lock } = leasePaths(home);
    const proof = JSON.parse(readFileSync(join(root, "mutable-home.recovery.json"), "utf8"));
    const name = phase === "checkpoint" ? "checkpoint.json" : phase === "genesis"
      ? `lease-${proof.leaseId}.json` : `next-${proof.leaseId}.json`;
    const source = join(root, phase === "release" ? name : "mutable-home.recovery.json");
    rmSync(join(lock, name));
    let completed = false;
    const contender = new ProviderHomeLeaseRegistry(OWNER_B, {
      pid: 202, hostname: "host-b", isProcessAlive: () => true,
      beforeTransitionPublishForTest: () => {
        assert.equal(completed, false, "only one attempt is needed");
        linkSync(source, join(lock, name));
        completed = true;
      },
    });
    assert.equal(contender.acquireHome(home), true);
    assert.equal(completed, true);
    assert.deepEqual(readFileSync(join(lock, name)), readFileSync(source));
    contender.releaseAll();
  }
});

test("canonical takeover refuses changed evidence and unsafe completed mirrors without granting or publishing", (t) => {
  for (const change of ["tip", "owner", "digest", "retained", "mirror-bytes", "mirror-malformed", "mirror-symlink", "mirror-oversized"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-provider-mirror-refusal-${change}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    writePartialJournal(home, "next");
    const holder = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a", isProcessAlive: () => false });
    holder.acquireHome(home);
    holder.releaseAll();
    const { root, lock } = leasePaths(home);
    const proofPath = join(root, "mutable-home.recovery.json");
    const proof = JSON.parse(readFileSync(proofPath, "utf8"));
    const releaseName = `next-${proof.leaseId}.json`;
    const releasePath = join(root, releaseName);
    const mirror = join(lock, releaseName);
    rmSync(mirror);
    let evidence: Array<{ directory: string; name: string; bytes: Buffer }> = [];
    const snapshot = () => [root, lock].flatMap((directory) => readdirSync(directory).sort()
      .filter((name) => name !== "mutable-home.lock")
      .map((name) => ({ directory, name, bytes: readFileSync(join(directory, name)) })));
    const contender = new ProviderHomeLeaseRegistry(OWNER_B, {
      pid: 202, hostname: "host-b", isProcessAlive: () => true,
      beforeTransitionPublishForTest: () => {
        if (change === "tip") {
          new ProviderHomeLeaseRegistry(OWNER_B, { pid: 303, hostname: "host-b" }).acquireHome(home);
        } else if (change === "owner") {
          const released = JSON.parse(readFileSync(releasePath, "utf8"));
          writeFileSync(releasePath, JSON.stringify({ ...released, ownerHash: OWNER_B }));
        } else if (change === "digest") {
          writeFileSync(proofPath, JSON.stringify({ ...proof, recoveredEntriesHash: "c".repeat(64) }));
        } else if (change === "retained") {
          const path = join(lock, `next-${LEGACY_ID}.json`);
          writeFileSync(path, `${readFileSync(path, "utf8")} `);
        } else if (change === "mirror-symlink") {
          symlinkSync(releasePath, mirror);
        } else {
          const bytes = change === "mirror-bytes" ? `${readFileSync(releasePath, "utf8")} `
            : change === "mirror-malformed" ? "{}\n" : "x".repeat(4_097);
          writeFileSync(mirror, bytes);
        }
        evidence = snapshot();
      },
    });
    assert.throws(() => contender.acquireHome(home), /lease changed|unexpected entries|metadata/);
    assert.equal(contender.releaseHome(home), false, "refused contender has no ownership grant");
    assert.deepEqual(snapshot(), evidence, "refusal leaves canonical and mirror evidence unchanged");
  }
});

test("a release racing stale recovery wins the same transition without stranding an empty lock", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-release-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const holder = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a" });
  holder.acquire(request(home));
  let released = false;
  const contender = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: () => false,
    beforeTransitionPublishForTest: () => {
      if (!released) {
        released = true;
        holder.releaseAll();
      }
    },
  });
  assert.throws(() => contender.acquire(request(home)), /lease changed during recovery/);
  assert.ok(readdirSync(leasePaths(home).lock).length >= 2);
  contender.acquire(request(home));
  contender.releaseAll();
});

test("a changed record is re-verified before successor publication", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-change-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lock = writeLegacyLease(home);
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: () => false,
    beforeTransitionPublishForTest: () => {
      writeFileSync(join(lock, "lease.json"), `${JSON.stringify({
        version: 1,
        ownerHash: OWNER_B,
        leaseId: "22222222-2222-4222-8222-222222222222",
        pid: 303,
        hostname: "host-a",
        provider: "claude",
        createdAt: "2026-08-19T00:00:01.000Z",
      })}\n`);
    },
  });
  assert.throws(() => registry.acquire(request(home)), /lease changed during recovery/);
  assert.deepEqual(readdirSync(lock), ["lease.json"], "no successor was published for the changed record");
  assert.equal(JSON.parse(readFileSync(join(lock, "lease.json"), "utf8")).pid, 303);
});

test("unexpected, orphaned, malformed, oversized, and symlinked lease state fails closed", (t) => {
  const cases = ["unexpected", "orphan", "malformed", "oversized", "marker-symlink", "lock-symlink"] as const;
  for (const scenario of cases) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-provider-home-${scenario}-`));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const { root, lock } = leasePaths(home);
    if (scenario === "lock-symlink") {
      const external = join(home, "external-lock");
      mkdirSync(external);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      symlinkSync(external, lock, "dir");
    } else {
      writeLegacyLease(home);
      if (scenario === "unexpected") writeFileSync(join(lock, "surprise"), "x");
      if (scenario === "orphan") {
        writeFileSync(join(lock, "next-22222222-2222-4222-8222-222222222222.json"), "{}\n");
      }
      if (scenario === "malformed") writeFileSync(join(lock, "lease.json"), "{}\n");
      if (scenario === "oversized") writeFileSync(join(lock, "lease.json"), "x".repeat(4_097));
      if (scenario === "marker-symlink") {
        rmSync(join(lock, "lease.json"));
        const external = join(home, "external-record");
        writeFileSync(external, "{}\n");
        symlinkSync(external, join(lock, "lease.json"));
      }
    }
    const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
      pid: 202, hostname: "host-a", isProcessAlive: () => false,
    });
    assert.throws(() => registry.acquire(request(home)));
  }
});

test("a long journal remains valid and never empties across repeated orderly handoffs", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-long-chain-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (let pass = 0; pass < 64; pass++) {
    const registry = new ProviderHomeLeaseRegistry(pass % 2 === 0 ? OWNER_A : OWNER_B);
    try { registry.acquire(request(home)); registry.releaseAll(); }
    catch (error) {
      // Fixture records contain no provider credentials. Keep physical retirement witnesses
      // visible on actual-platform failures instead of losing them in the public remedy.
      const { root, lock } = leasePaths(home);
      t.diagnostic(`failed handoff ${pass}: ${String(error)}`);
      for (const directory of [root, lock]) for (const name of readdirSync(directory)) {
        if (name === "mutable-home.lock") continue;
        const raw = readFileSync(join(directory, name), "utf8");
        t.diagnostic(`${directory === root ? "root" : "lock"}/${name}: ${raw}`);
      }
      throw error;
    }
    assert.ok(readdirSync(leasePaths(home).lock).length > 0);
    assert.deepEqual(registry.getDiagnostics(), []);
  }
  assert.ok(readdirSync(leasePaths(home).lock).length <= 34);
  assert.equal(JSON.parse(readFileSync(join(leasePaths(home).root, "mutable-home.recovery.json"), "utf8")).version, 4);
});

test("a predecessor modified after publication invalidates its hash-linked successor", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-corrupt-chain-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lock = writeLegacyLease(home);
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: process.pid, hostname: "host-a", isProcessAlive: () => false,
  });
  registry.acquire(request(home));
  writeFileSync(join(lock, "lease.json"), `${readFileSync(join(lock, "lease.json"), "utf8")} `);
  const later = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 303, hostname: "host-a", isProcessAlive: () => false,
  });
  assert.throws(() => later.acquire(request(home)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /unexpected entries/);
    assert.ok(error.message.includes(lock), "the remedy uses the stable HOME path");
    assert.doesNotMatch(error.message, /\/proc\/self\/fd\//);
    return true;
  });
});

test("hard-linked record substitution is detected after the link target is modified", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-hardlink-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const lock = writeLegacyLease(home);
  const alias = join(home, "record-alias");
  linkSync(join(lock, "lease.json"), alias);
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: process.pid, hostname: "host-a", isProcessAlive: () => false,
  });
  registry.acquire(request(home));
  writeFileSync(alias, `${readFileSync(alias, "utf8")} `);
  const later = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 303, hostname: "host-a", isProcessAlive: () => false,
  });
  assert.throws(() => later.acquire(request(home)), /unexpected entries/);
});

test("new-format artifacts make the legacy single-marker reader fail closed", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-mixed-version-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a" });
  registry.acquire(request(home));
  const entries = readdirSync(leasePaths(home).lock);
  assert.equal(entries.length, 2);
  assert.ok(entries.includes("checkpoint.json"), "a rollback journal reader sees an unexpected marker and refuses recovery");
  registry.releaseAll();
});

test("provider-home leases fail closed for both WSL Direct isolation modes", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-wsl-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "work"));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A);
  assert.throws(() => registry.acquire({
    ...request(home),
    context: { kind: "wsl", distro: "Ubuntu" },
  }), /cannot be safely owner-leased.*native, container, or cloud/);
  assert.throws(() => registry.acquire({
    ...request(home),
    context: { kind: "wsl", distro: "Ubuntu" },
    isolation: { backend: "bwrap", command: "bwrap", args: [], network: "inherit" },
  }), /target-local no-follow path handles/);
  registry.acquire({
    ...request(home),
    context: { kind: "wsl", distro: "Ubuntu" },
    isolation: {
      backend: "container", runtime: "docker", command: "docker", args: [], image: "image@sha256:test",
      network: "deny", templateId: "test", runnerKey: "runner", containerName: "test",
      hostAgentCommand: "agent", hostAgentArgs: [], agentCommand: "agent", agentArgs: [],
      verifyRuntimeIdentity: () => {},
    },
  });
});

test("the whole effective HOME is shared across providers and relative HOME fails closed", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-whole-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 101, hostname: "host-a", isProcessAlive: (pid) => pid === 101,
  });
  first.acquire(request(home));
  const second = new ProviderHomeLeaseRegistry(OWNER_B, {
    pid: 202, hostname: "host-a", isProcessAlive: (pid) => pid === 101,
  });
  assert.throws(() => second.acquire({ ...request(home), driver: "codex", command: "codex" }),
    /already in use by process 101/);
  assert.throws(() => first.acquire({ ...request(home), env: { HOME: "relative" } }), /HOME must be absolute/);
  first.releaseAll();
});

test("an incomplete provider-home lease fails closed with actionable recovery guidance", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-incomplete-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(leasePaths(home).lock, { recursive: true, mode: 0o700 });
  const registry = new ProviderHomeLeaseRegistry(OWNER_A);
  assert.throws(() => registry.acquire(request(home)), /incomplete.*proving no provider process.*quarantine/);
});

test("a short-lived login releases an unborrowed lease it acquired itself", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-login-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a" });
  assert.equal(registry.acquireHome(home, "claude"), true);
  assert.equal(registry.releaseHome(home), true);
  assert.equal(registry.releaseHome(home), false, "the exact lease can be released only once");
});

test("a login cannot release a provider-home lease after another local consumer borrows it", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-login-borrowed-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 101, hostname: "host-a", isProcessAlive: (pid) => pid === 101,
  });
  const contender = new ProviderHomeLeaseRegistry(OWNER_B, {
    pid: 202, hostname: "host-a", isProcessAlive: (pid) => pid === 101,
  });
  assert.equal(registry.acquireHome(home, "claude"), true, "the login owns the initial acquisition");
  assert.equal(registry.acquireHome(home, "claude"), false, "the provider session borrows the held lease");
  assert.equal(registry.releaseHome(home), false, "the login cannot release a lease with a live borrower");
  assert.throws(() => contender.acquireHome(home, "claude"), /already in use by process 101/);
  registry.releaseAll();
  assert.equal(contender.acquireHome(home, "claude"), true, "shutdown release permits the next attested owner");
  contender.releaseAll();
});

test("an initial publication failure unwinds only the empty lock created by that attempt", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-publish-fail-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
    beforeMarkerWriteForTest: () => { throw failure; },
  });
  assert.throws(() => registry.acquire(request(home)), /disk full/);
  assert.equal(existsSync(leasePaths(home).lock), false);
});

const PROFILE_ID = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const OTHER_PROFILE_ID = "7f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const INSTANCE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const OTHER_INSTANCE_ID = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const GRANTED = { controlPlaneSupportsProfiles: true, activeProfileIds: [PROFILE_ID] };

function profileMarker(profileId = PROFILE_ID, instances = [INSTANCE_ID]): ProviderProfileMarker {
  return {
    version: 1, kind: "wollipog-provider-profile", profileId, provider: "claude", createdAt: "2026-10-16T00:00:00.000Z",
    grants: instances.map((controlPlaneInstanceId) => ({
      controlPlaneInstanceId, grantId: "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", grantedAt: "2026-10-16T00:00:01.000Z",
    })),
  };
}

function refusalKind(action: () => unknown): string | null {
  try { action(); } catch (error) { return providerHomeLeaseRefusalKind(error); }
  return "acquired";
}

test("a non-granted or unnegotiated profile is refused before any lease journal I/O", { skip: process.platform === "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-profile-refused-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeProviderProfileMarker(home, profileMarker(PROFILE_ID, [OTHER_INSTANCE_ID]));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a", controlPlaneInstanceId: INSTANCE_ID });
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude", GRANTED)), "profile_not_granted");
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude")), "profile_unsupported_control_plane", "older callers send no profile context");
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude", { controlPlaneSupportsProfiles: false, activeProfileIds: [] })),
    "profile_unsupported_control_plane");
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude", { controlPlaneSupportsProfiles: true, activeProfileIds: [] })),
    "profile_not_granted", "the control plane's own grant is required too");
  const thrown = (() => { try { registry.acquireHome(home, "claude", GRANTED); } catch (error) { return error as Error; } })();
  assert.equal(thrown?.message, LEASE_WORKER_ERRORS.profile_not_granted, "the refusal carries only the fixed, path-free text");
  assert.equal(existsSync(leasePaths(home).root), false, "no lease root or lock was created for a refused profile");
  assert.equal(registry.releaseAll(), true);

  writeProviderProfileMarker(home, profileMarker(PROFILE_ID, [OTHER_INSTANCE_ID, INSTANCE_ID]));
  assert.equal(registry.acquireHome(home, "claude", { ...GRANTED, expectedId: PROFILE_ID }), true);
  assert.equal(existsSync(leasePaths(home).lock), true);
  assert.equal(registry.releaseAll(), true);
});

test("a marker-less home behaves exactly as before with or without profile context", (t) => {
  for (const profile of [undefined, { controlPlaneSupportsProfiles: false, activeProfileIds: [] }, GRANTED]) {
    const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-profile-legacy-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a", controlPlaneInstanceId: INSTANCE_ID });
    assert.equal(registry.acquireHome(home, "claude", profile), true);
    assert.equal(registry.acquireHome(home, "claude", profile), false);
    assert.equal(registry.releaseHome(home), false);
    assert.equal(registry.releaseHome(home), true);
    assert.deepEqual(journalRecords(home).map((record) => record.state).sort(), ["active", "released"]);
    assert.equal(existsSync(join(home, ".agent-manager", "profile-v1.json")), false, "acquisition never creates a marker");
  }
  if (process.platform === "win32") return;
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-profile-ancestry-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "elsewhere"));
  symlinkSync(join(home, "elsewhere"), join(home, ".agent-manager"));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a", controlPlaneInstanceId: INSTANCE_ID });
  assert.throws(() => registry.acquireHome(home, "claude", GRANTED), /has unsafe metadata directory ancestry/u);
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude")), "unverifiable", "unsafe ancestry keeps its existing refusal");
  assert.deepEqual(readdirSync(join(home, "elsewhere")), []);
});

test("a substituted provider HOME is refused as a changed profile", { skip: process.platform === "win32" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-provider-home-profile-substituted-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "account");
  mkdirSync(home);
  writeProviderProfileMarker(home, profileMarker());
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a", controlPlaneInstanceId: INSTANCE_ID });
  const recorded = { ...GRANTED, activeProfileIds: [PROFILE_ID, OTHER_PROFILE_ID], expectedId: PROFILE_ID };
  assert.equal(registry.acquireHome(home, "claude", recorded), true);
  assert.equal(registry.releaseAll(), true);

  renameSync(home, join(root, "original"));
  mkdirSync(home);
  writeProviderProfileMarker(home, profileMarker(OTHER_PROFILE_ID));
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude", recorded)), "profile_changed", "a different granted profile");
  rmSync(join(home, ".agent-manager"), { recursive: true });
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude", recorded)), "profile_changed", "an empty replacement directory");
  assert.equal(existsSync(leasePaths(home).root), false);
  mkdirSync(join(home, ".agent-manager"));
  writeFileSync(join(home, ".agent-manager", "profile-v1.json"), "{\"version\":2}\n", { mode: 0o600 });
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude", recorded)), "profile_unverifiable", "a newer marker format");
  assert.equal(existsSync(leasePaths(home).root), false);
});

test("a re-entrant reference re-checks the profile so a revoked grant stops new references", { skip: process.platform === "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-profile-borrowed-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeProviderProfileMarker(home, profileMarker());
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a", controlPlaneInstanceId: INSTANCE_ID });
  assert.equal(registry.acquireHome(home, "claude", GRANTED), true);
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude", { controlPlaneSupportsProfiles: true, activeProfileIds: [] })),
    "profile_not_granted", "the control plane revoked its grant");
  registry.writeProfileMarkerWhileHeld(home, profileMarker(PROFILE_ID, []));
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude", GRANTED)), "profile_not_granted", "the host-local grant was removed");
  assert.equal(registry.releaseHome(home), true, "refused borrows added no reference");
  assert.throws(() => registry.writeProfileMarkerWhileHeld(home, profileMarker()), /require this registry's completed HOME lease/u);
  assert.deepEqual(journalRecords(home).map((record) => record.state).sort(), ["active", "released"]);
});

const NEW_GRANT_ID = "3a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";

test("a marker change takes the lease without the grant check and releases what it took", { skip: process.platform === "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-profile-change-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeProviderProfileMarker(home, profileMarker(PROFILE_ID, [OTHER_INSTANCE_ID]));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a", controlPlaneInstanceId: INSTANCE_ID });
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude", GRANTED)), "profile_not_granted");
  const grant = { controlPlaneInstanceId: INSTANCE_ID, grantId: NEW_GRANT_ID, grantedAt: "2026-10-16T00:00:02.000Z" };
  const adopted = registry.changeProfileMarkerWhileHeld(home, "claude", (read) => adoptProviderProfileMarker(read, { provider: "claude", grant }));
  assert.equal(adopted.marker.profileId, PROFILE_ID, "an existing identity is kept");
  const read = readProviderProfileMarker(home);
  assert.equal(read.state, "present");
  assert.deepEqual(read.state === "present" && read.marker.grants.map((candidate) => candidate.controlPlaneInstanceId), [OTHER_INSTANCE_ID, INSTANCE_ID]);
  assert.deepEqual(journalRecords(home).map((record) => record.state).sort(), ["active", "released"], "the first reference was released");
  assert.equal(registry.acquireHome(home, "claude", { ...GRANTED, expectedId: PROFILE_ID }), true, "the new grant is usable");

  // While a session holds the HOME, the change joins its reference and leaves it held.
  const revoked = registry.changeProfileMarkerWhileHeld(home, "claude", (current) =>
    revokeProviderProfileMarkerGrant(current, { profileId: PROFILE_ID, controlPlaneInstanceId: INSTANCE_ID, grantId: NEW_GRANT_ID }));
  assert.equal(revoked.changed, true);
  assert.equal(refusalKind(() => registry.acquireHome(home, "claude", GRANTED)), "profile_not_granted", "the revoked grant stops new references");
  assert.equal(registry.releaseHome(home), true, "the session's own reference is the only one left");
  assert.equal(readProviderProfileMarker(home).state, "present");
});

test("a marker change refuses a HOME another live owner holds and an unprovable marker", { skip: process.platform === "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-profile-change-busy-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const owner = new ProviderHomeLeaseRegistry(OWNER_B, { pid: 202, hostname: "host-a", isProcessAlive: (pid) => pid === 202 });
  assert.equal(owner.acquireHome(home, "claude"), true);
  const registry = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a", isProcessAlive: (pid) => pid === 202,
    controlPlaneInstanceId: INSTANCE_ID });
  const grant = { controlPlaneInstanceId: INSTANCE_ID, grantId: NEW_GRANT_ID, grantedAt: "2026-10-16T00:00:02.000Z" };
  let called = false;
  assert.throws(() => registry.changeProfileMarkerWhileHeld(home, "claude", (read) => { called = true; return adoptProviderProfileMarker(read, { provider: "claude", grant }); }),
    /already in use/u);
  assert.equal(called, false, "nothing is read or written without the lease");
  assert.equal(readProviderProfileMarker(home).state, "absent");
  assert.equal(owner.releaseAll(), true);

  writeFileSync(join(home, ".agent-manager", "profile-v1.json"), "{\"version\":2}\n", { mode: 0o600 });
  assert.equal(providerHomeLeaseRefusalKind((() => {
    try { registry.changeProfileMarkerWhileHeld(home, "claude", (read) => adoptProviderProfileMarker(read, { provider: "claude", grant })); } catch (error) { return error; }
  })()), "profile_unverifiable");
  assert.equal(readFileSync(join(home, ".agent-manager", "profile-v1.json"), "utf8"), "{\"version\":2}\n", "an unprovable marker is never replaced");
  // A peer that treats every recorded process as alive can acquire only an orderly released lease.
  const peer = new ProviderHomeLeaseRegistry(OWNER_B, { pid: 303, hostname: "host-a", isProcessAlive: () => true });
  rmSync(join(home, ".agent-manager", "profile-v1.json"));
  assert.equal(peer.acquireHome(home, "claude"), true, "a refused change released the lease it took");
  assert.equal(peer.releaseAll(), true);
  assert.equal(registry.releaseAll(), true);
});
