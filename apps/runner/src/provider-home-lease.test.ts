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
import { join } from "node:path";
import { after, test } from "node:test";
const previousMask = process.umask(0o077);
after(() => process.umask(previousMask));
import { providerLaunchNeedsSharedHomeLease, ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import type { SpawnIsolation } from "./spawn.js";

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
      pid: 202, hostname: "host-a", isProcessAlive: (pid) => pid === 202,
    });
    registry.acquire(request(home));
    for (const item of evidence) assert.deepEqual(readFileSync(join(lock, item.name)), item.bytes);
    const competitor = new ProviderHomeLeaseRegistry(OWNER_A, {
      pid: 303, hostname: "host-a", isProcessAlive: (pid) => pid === 202,
    });
    assert.throws(() => competitor.acquire(request(home)), /already in use by process 202/);
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

test("failed initialization retry refuses changed evidence, successors, and rollback directories", (t) => {
  for (const change of ["proof", "corrupt", "retained", "directory", "successor", "during-retry"] as const) {
    const home = mkdtempSync(join(tmpdir(), `wollipog-provider-retry-refuse-${change}-`));
    const { root, lock } = leasePaths(home);
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const proofPath = join(root, "mutable-home.recovery.json");
    const mutate = () => {
      const proof = JSON.parse(readFileSync(proofPath, "utf8"));
      writeFileSync(proofPath, JSON.stringify({ ...proof, createdAt: "changed" }));
    };
    const registry = new ProviderHomeLeaseRegistry(OWNER_A, {
      afterInitializationPublishForTest: () => { throw new Error("failed before mkdir"); },
      beforeTransitionPublishForTest: change === "during-retry" ? mutate : undefined,
    });
    assert.throws(() => registry.acquireHome(home), /quarantine the entire/);
    const proof = JSON.parse(readFileSync(proofPath, "utf8"));
    if (change === "proof") mutate();
    if (change === "corrupt") writeFileSync(proofPath, "{");
    if (change === "retained") writeFileSync(proofPath, JSON.stringify({ ...proof, recoveredEntriesHash: "c".repeat(64) }));
    if (change === "directory") mkdirSync(lock);
    if (change === "successor") {
      const hash = createHash("sha256").update(readFileSync(proofPath)).digest("hex");
      writeFileSync(join(root, `next-${proof.leaseId}.json`), JSON.stringify({
        ...proof, leaseId: LEGACY_ID, previousLeaseId: proof.leaseId, previousRecordHash: hash,
      }));
    }
    const before = readFileSync(proofPath);
    assert.throws(() => registry.acquireHome(home), /quarantine the entire.*do not remove individual records/s);
    if (change !== "during-retry") assert.deepEqual(readFileSync(proofPath), before);
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
    pid: 202, hostname: "host-a", isProcessAlive: () => false,
  });
  replacement.acquire(request(home));
  const entries = readdirSync(lock).sort();
  assert.equal(entries[0], "lease.json", "the legacy ownership evidence is never removed");
  assert.match(entries[1]!, /^next-11111111-1111-4111-8111-111111111111\.json$/u);
  assert.equal(journalRecords(home).at(-1)?.pid, 202);
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
    pid: 202, hostname: "host-a", isProcessAlive: (pid) => pid === 202,
  });
  let raced = false;
  const loser = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 303,
    hostname: "host-a",
    isProcessAlive: (pid) => pid === 202,
    beforeTransitionPublishForTest: () => {
      if (!raced) {
        raced = true;
        winner.acquire(request(home));
      }
    },
  });
  assert.throws(() => loser.acquire(request(home)), /lease changed during recovery/);
  assert.equal(journalRecords(home).filter((record) => record.state === "active").length, 1);
  assert.equal(journalRecords(home).at(-1)?.pid, 202);
  winner.releaseAll();
});

test("the exclusive successor elects one winner across real runner processes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-process-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeLegacyLease(home, { pid: 2_147_483_647 });
  const start = join(home, "start");
  const release = join(home, "release");
  const helper = join(home, "race-helper.ts");
  const moduleUrl = new URL("./provider-home-lease.ts", import.meta.url).href;
  writeFileSync(helper, `
    import { existsSync, writeFileSync } from "node:fs";
    import { ProviderHomeLeaseRegistry } from ${JSON.stringify(moduleUrl)};
    const [home, result, start, release] = process.argv.slice(2);
    while (!existsSync(start)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const registry = new ProviderHomeLeaseRegistry(${JSON.stringify(OWNER_A)}, { hostname: "host-a" });
    try {
      registry.acquire({ driver: "claude-code", command: "claude", context: { kind: "native" }, env: { HOME: home } });
      writeFileSync(result, "won");
      while (!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      registry.releaseAll();
    } catch (error) {
      writeFileSync(result, \`lost:\${error instanceof Error ? error.message : String(error)}\`);
    }
  `);
  const results = [join(home, "result-a"), join(home, "result-b")];
  const children = results.map((result) => spawn(process.execPath, ["--import", "tsx", helper, home, result, start, release], {
    stdio: ["ignore", "pipe", "pipe"],
  }));
  const exits = children.map((child) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("exit", (code) => resolve({ code, stderr }));
  }));
  writeFileSync(start, "go");
  const deadline = Date.now() + 5_000;
  while (results.some((result) => !existsSync(result)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const allReported = results.every(existsSync);
  writeFileSync(release, "done");
  const statuses = await Promise.all(exits);
  assert.ok(allReported, "both contenders report before the race deadline");
  const outcomes = results.map((result) => readFileSync(result, "utf8"));
  assert.deepEqual(statuses.map((status) => status.code), [0, 0], statuses.map((status) => status.stderr).join("\n"));
  assert.equal(outcomes.filter((outcome) => outcome === "won").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.startsWith("lost:")).length, 1);
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
    pid: 202, hostname: "host-a", isProcessAlive: () => false,
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
    pid: 202, hostname: "host-a", isProcessAlive: () => false,
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
