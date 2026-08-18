import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { providerLaunchNeedsSharedHomeLease, ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import type { SpawnIsolation } from "./spawn.js";

function request(home: string) {
  return {
    driver: "claude-code" as const,
    command: "claude",
    context: { kind: "native" as const },
    env: { HOME: home },
  };
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
  const first = new ProviderHomeLeaseRegistry("a".repeat(64), {
    pid: 101,
    hostname: "host-a",
    isProcessAlive: (pid) => pid === 101,
  });
  const second = new ProviderHomeLeaseRegistry("b".repeat(64), {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: (pid) => pid === 101,
  });
  first.acquire(request(home));
  first.acquire(request(home));
  assert.throws(() => second.acquire(request(home)), /already in use by process 101/);
  first.releaseAll();
  second.acquire(request(home));
  second.releaseAll();
});

function leaseRoot(home: string): string {
  return join(home, ".agent-manager", "provider-home-leases-v1");
}

function readLease(home: string) {
  return JSON.parse(readFileSync(join(leaseRoot(home), "mutable-home.lock", "lease.json"), "utf8"));
}

test("a crashed runner's own stale lease is reclaimed without manual filesystem recovery", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-stale-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const crashed = new ProviderHomeLeaseRegistry("a".repeat(64), { pid: 101, hostname: "host-a" });
  crashed.acquire(request(home));
  const restarted = new ProviderHomeLeaseRegistry("a".repeat(64), {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: () => false,
  });
  restarted.acquire(request(home));
  assert.equal(readLease(home).pid, 202);
  assert.deepEqual(readdirSync(leaseRoot(home)), ["mutable-home.lock"], "reclaim leaves no residue behind");
  // A late release from the crashed instance must never delete the live replacement's lock.
  crashed.releaseAll();
  assert.equal(readLease(home).pid, 202);
  restarted.releaseAll();
  assert.equal(existsSync(join(leaseRoot(home), "mutable-home.lock")), false);
});

test("provider-home leases never automatically recover a foreign owner's stale record", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-foreign-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stale = new ProviderHomeLeaseRegistry("a".repeat(64), { pid: 101, hostname: "host-a" });
  stale.acquire(request(home));
  const foreign = new ProviderHomeLeaseRegistry("b".repeat(64), {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: () => false,
  });
  assert.throws(() => foreign.acquire(request(home)), /stale lease.*another attested owner.*manually quarantine/);
  assert.equal(readLease(home).pid, 101, "the foreign record is left exactly as found");
  stale.releaseAll();
});

test("provider-home leases never reclaim a record written by another host", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-other-host-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stale = new ProviderHomeLeaseRegistry("a".repeat(64), { pid: 101, hostname: "host-a" });
  stale.acquire(request(home));
  const elsewhere = new ProviderHomeLeaseRegistry("a".repeat(64), {
    pid: 202,
    hostname: "host-b",
    isProcessAlive: () => false,
  });
  assert.throws(() => elsewhere.acquire(request(home)), /leased by host host-a.*isolated OS account/);
  assert.equal(readLease(home).pid, 101, "the remote host's record is left exactly as found");
  stale.releaseAll();
});

test("a reclaim never vacates the lock path a competing owner is excluded by", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-reclaim-window-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const crashed = new ProviderHomeLeaseRegistry("a".repeat(64), { pid: 101, hostname: "host-a" });
  crashed.acquire(request(home));
  let foreignError = "";
  const reclaimer = new ProviderHomeLeaseRegistry("a".repeat(64), {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: () => false,
    // Stand in for a different attested owner racing the reclaim at its most exposed moment.
    beforeReclaimPublishForTest: () => {
      const foreign = new ProviderHomeLeaseRegistry("b".repeat(64), {
        pid: 303,
        hostname: "host-a",
        isProcessAlive: () => false,
      });
      try {
        foreign.acquire(request(home));
      } catch (error) {
        foreignError = (error as Error).message;
      }
    },
  });
  reclaimer.acquire(request(home));
  assert.match(foreignError, /incomplete.*quarantine/, "a foreign owner must never publish mid-reclaim");
  assert.equal(readLease(home).pid, 202, "the reclaiming owner still ends up holding the lease");
  reclaimer.releaseAll();
});

test("a same-owner reclaim loser reports against the winner instead of double-publishing", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-reclaim-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const crashed = new ProviderHomeLeaseRegistry("a".repeat(64), { pid: 101, hostname: "host-a" });
  crashed.acquire(request(home));
  // Stand in for a second reclaimer that passed the same inspection and won the exclusive create.
  const winner = { ...readLease(home), leaseId: randomUUID(), pid: 999 };
  const loser = new ProviderHomeLeaseRegistry("a".repeat(64), {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: (pid) => pid === 999,
    beforeReclaimPublishForTest: (lockDir) => {
      writeFileSync(join(lockDir, "lease.json"), `${JSON.stringify(winner)}\n`, { flag: "wx", mode: 0o600 });
    },
  });
  assert.throws(() => loser.acquire(request(home)), /already in use by process 999/);
  assert.equal(readLease(home).pid, 999, "the winner keeps the lease it published");
  assert.deepEqual(readdirSync(leaseRoot(home)), ["mutable-home.lock"]);
});

test("an entry appearing during a reclaim surrenders the lease instead of launching beside it", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-reclaim-entry-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const crashed = new ProviderHomeLeaseRegistry("a".repeat(64), { pid: 101, hostname: "host-a" });
  crashed.acquire(request(home));
  const reclaimer = new ProviderHomeLeaseRegistry("a".repeat(64), {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: () => false,
    beforeReclaimPublishForTest: (lockDir) => writeFileSync(join(lockDir, "unexpected"), "x"),
  });
  assert.throws(() => reclaimer.acquire(request(home)), /unexpected entries.*refusing unsafe recovery/);
  assert.equal(existsSync(join(leaseRoot(home), "mutable-home.lock", "lease.json")), false,
    "the surrendered marker must not stay behind as a lease this runner never held");
  assert.deepEqual(readdirSync(leaseRoot(home)), ["mutable-home.lock"], "no reclaim residue is created");
});

test("a symlinked lock directory is never reclaimed through to its target", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-symlink-"));
  const target = mkdtempSync(join(tmpdir(), "wollipog-provider-home-symlink-target-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
  mkdirSync(leaseRoot(home), { recursive: true, mode: 0o700 });
  writeFileSync(join(target, "lease.json"), `${JSON.stringify({
    version: 1,
    ownerHash: "a".repeat(64),
    leaseId: randomUUID(),
    pid: 101,
    hostname: "host-a",
    provider: "codex",
    createdAt: new Date(0).toISOString(),
  })}\n`);
  symlinkSync(target, join(leaseRoot(home), "mutable-home.lock"));
  const registry = new ProviderHomeLeaseRegistry("a".repeat(64), {
    pid: 202,
    hostname: "host-a",
    isProcessAlive: () => false,
  });
  assert.throws(() => registry.acquire(request(home)), /is not a directory.*refusing unsafe recovery/);
  assert.equal(existsSync(join(target, "lease.json")), true, "the symlink target is left untouched");
});

test("provider-home leases fail closed for WSL direct mode and bypass redirected bwrap homes", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-wsl-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "work"));
  const registry = new ProviderHomeLeaseRegistry("a".repeat(64));
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
  const first = new ProviderHomeLeaseRegistry("a".repeat(64), {
    pid: 101, hostname: "host-a", isProcessAlive: (pid) => pid === 101,
  });
  first.acquire(request(home));
  const second = new ProviderHomeLeaseRegistry("b".repeat(64), {
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
  mkdirSync(join(home, ".agent-manager", "provider-home-leases-v1", "mutable-home.lock"), {
    recursive: true,
  });
  const registry = new ProviderHomeLeaseRegistry("a".repeat(64));
  assert.throws(() => registry.acquire(request(home)), /incomplete.*proving no provider process.*quarantine/);
});

test("a marker publication failure unwinds only the lock directory created by that attempt", (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-publish-fail-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const registry = new ProviderHomeLeaseRegistry("a".repeat(64), {
    beforeMarkerWriteForTest: () => { throw failure; },
  });
  assert.throws(() => registry.acquire(request(home)), /disk full/);
  assert.equal(
    existsSync(join(home, ".agent-manager", "provider-home-leases-v1", "mutable-home.lock")),
    false,
  );
});
