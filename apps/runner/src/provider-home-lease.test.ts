import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
  mkdirSync(lock, { recursive: true });
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
  return readdirSync(lock).sort().map((name) =>
    JSON.parse(readFileSync(join(lock, name), "utf8")) as Record<string, unknown>);
}

test("container and cloud launches never lease the host provider HOME", () => {
  const remote: SpawnIsolation[] = [
    {
      backend: "container", command: "docker", args: [], image: `x@sha256:${"a".repeat(64)}`,
      network: "deny", templateId: "tools", runnerKey: "runner-key", containerName: "session",
      hostAgentCommand: "claude", hostAgentArgs: [], agentCommand: "claude", agentArgs: [],
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
    assert.throws(() => registry.acquire(request(home)), expected);
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
  mkdirSync(lock, { recursive: true });
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
  assert.equal(readdirSync(lock).length, 2, "the forged journal gains no successor");
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
    assert.equal(readdirSync(lock).length, 3, "the forged journal gains no successor");
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
      mkdirSync(root, { recursive: true });
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
  for (let pid = 100; pid < 164; pid++) {
    const registry = new ProviderHomeLeaseRegistry(pid % 2 === 0 ? OWNER_A : OWNER_B, {
      pid,
      hostname: "host-a",
      isProcessAlive: () => false,
    });
    registry.acquire(request(home));
    registry.releaseAll();
    assert.ok(readdirSync(leasePaths(home).lock).length > 0);
  }
  assert.equal(readdirSync(leasePaths(home).lock).length, 128);
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
  assert.throws(() => later.acquire(request(home)), /unexpected entries/);
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
  assert.equal(entries.length, 1);
  assert.notEqual(entries[0], "lease.json", "a rollback binary sees an unexpected marker and refuses recovery");
  registry.releaseAll();
});

test("provider-home leases fail closed for WSL direct mode and bypass redirected bwrap homes", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-wsl-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "work"));
  const registry = new ProviderHomeLeaseRegistry(OWNER_A);
  assert.throws(() => registry.acquire({
    ...request(home),
    context: { kind: "wsl", distro: "Ubuntu" },
  }), /cannot be safely owner-leased.*bwrap/);
  registry.acquire({
    ...request(home),
    context: { kind: "wsl", distro: "Ubuntu" },
    isolation: { backend: "bwrap", command: "bwrap", args: [], network: "inherit" },
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
  mkdirSync(leasePaths(home).lock, { recursive: true });
  const registry = new ProviderHomeLeaseRegistry(OWNER_A);
  assert.throws(() => registry.acquire(request(home)), /incomplete.*proving no provider process.*quarantine/);
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
