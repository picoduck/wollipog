import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDarwinBootTime } from "./provider-home-lease-boot.js";
import type { LeaseProcessProbe } from "./provider-home-lease-evidence.js";
import { providerHomeLeaseRefusalKind, ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import { writeProviderProfileMarker, type ProviderProfileMarker } from "./provider-profile.js";

const previousMask = process.umask(0o077);
test.after(() => process.umask(previousMask));

// #3241 part 2: an Owner or Admin authorizes succeeding one exact stale lease record. A record
// without lifecycle evidence needs a boot after it was written; one with evidence still needs it.

const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);
const LEGACY_ID = "11111111-1111-4111-8111-111111111111";
const AUTHORIZATION = "5a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const OTHER_AUTHORIZATION = "6a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const BOOT = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const MARKER_A = "0123456789abcdef0123456789abcdef";
const PROFILE_ID = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const INSTANCE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const OTHER_INSTANCE_ID = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const WRITTEN = Date.parse("2026-08-19T00:00:00.000Z");
const skip = process.platform === "win32";

function leasePaths(home: string) {
  const root = join(home, ".agent-manager", "provider-home-leases-v1");
  return { root, lock: join(root, "mutable-home.lock") };
}

/** A v1 lease of owner A on host-a, written at `WRITTEN`, whose runner is gone. */
function legacyHome(t: { after: (fn: () => void) => void }, overrides: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-authorized-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const { lock } = leasePaths(home);
  mkdirSync(lock, { recursive: true, mode: 0o700 });
  writeFileSync(join(lock, "lease.json"), `${JSON.stringify({
    version: 1, ownerHash: OWNER_A, leaseId: LEGACY_ID, pid: 101, hostname: "host-a", provider: "claude",
    createdAt: new Date(WRITTEN).toISOString(), ...overrides,
  })}\n`, { mode: 0o600 });
  return home;
}

function registry(options: { owner?: string; bootedAt?: number | null; probe?: LeaseProcessProbe; alive?: boolean; instance?: string } = {}) {
  return new ProviderHomeLeaseRegistry(options.owner ?? OWNER_B, {
    pid: 202, hostname: "host-a", controlPlaneInstanceId: options.instance ?? INSTANCE_ID,
    isProcessAlive: () => options.alive ?? false,
    bootTimeMs: () => (options.bootedAt === undefined ? WRITTEN + 3_600_000 : options.bootedAt),
    processProbe: options.probe ?? null,
  });
}

function refusal(action: () => unknown): string | null {
  try { action(); } catch (error) { return providerHomeLeaseRefusalKind(error) ?? `untyped: ${String(error)}`; }
  return null;
}

function successor(home: string, leaseId: string): Record<string, unknown> | undefined {
  for (const directory of [leasePaths(home).root, leasePaths(home).lock]) {
    const path = join(directory, `next-${leaseId}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  }
  return undefined;
}

test("an authorized recovery of a lease without evidence needs a boot after it was written", { skip }, (t) => {
  const home = legacyHome(t);
  const recovering = registry();
  const inspection = recovering.inspectHome(home);
  assert.deepEqual({ ...inspection, tipHash: typeof inspection.tipHash },
    { state: "stale", tipHash: "string", createdAt: new Date(WRITTEN).toISOString(), sameHost: true, hasEvidence: false, refusal: null });
  assert.equal(refusal(() => recovering.acquireHome(home, "claude")), "foreign_owner", "without authorization it stays refused");
  recovering.recoverStaleLease(home, "claude", { staleTipHash: inspection.tipHash!, authorizationId: AUTHORIZATION });
  const recovered = successor(home, LEGACY_ID)!;
  assert.deepEqual({ owner: recovered.ownerHash, state: recovered.state, recovery: recovered.recovery },
    { owner: OWNER_B, state: "active", recovery: { proof: "authorized", authorizationId: AUTHORIZATION, basis: "booted_after" } });
  const release = successor(home, recovered.leaseId as string)!;
  assert.equal(release.state, "released", "the recovery releases the HOME again at once");
  assert.equal(release.recovery, undefined);
  assert.equal(recovering.inspectHome(home).state, "released");
  // Later launches, by anyone, now acquire through the ordinary handoff.
  const next = registry({ owner: OWNER_A });
  next.acquireHome(home, "claude");
  assert.equal(next.releaseAll(), true);
  // The authorization is spent: the record it named is no longer the tip.
  assert.equal(refusal(() => registry().recoverStaleLease(home, "claude", { staleTipHash: inspection.tipHash!, authorizationId: AUTHORIZATION })),
    "stale_tip_changed");
});

test("a lease written during the current boot, or with an unknown boot time, is not recovered even when authorized", { skip }, (t) => {
  for (const bootedAt of [WRITTEN - 1_000, WRITTEN + 30_000, null]) {
    const home = legacyHome(t);
    const recovering = registry({ bootedAt });
    const inspection = recovering.inspectHome(home);
    assert.equal(inspection.refusal, "no_reboot_proof", String(bootedAt));
    assert.equal(refusal(() => recovering.recoverStaleLease(home, "claude", { staleTipHash: inspection.tipHash!, authorizationId: AUTHORIZATION })),
      "no_reboot_proof");
    assert.equal(successor(home, LEGACY_ID), undefined, "nothing is published");
  }
});

test("an authorization names one exact record: another hash, a released lease, a missing journal or a lease held here are refused", { skip }, (t) => {
  const home = legacyHome(t);
  const recovering = registry();
  assert.equal(refusal(() => recovering.recoverStaleLease(home, "claude", { staleTipHash: "f".repeat(64), authorizationId: AUTHORIZATION })),
    "stale_tip_changed");
  assert.equal(successor(home, LEGACY_ID), undefined);

  const fresh = mkdtempSync(join(tmpdir(), "wollipog-provider-home-authorized-fresh-"));
  t.after(() => rmSync(fresh, { recursive: true, force: true }));
  assert.deepEqual(recovering.inspectHome(fresh), { state: "none" });
  assert.equal(refusal(() => recovering.recoverStaleLease(fresh, "claude", { staleTipHash: "f".repeat(64), authorizationId: AUTHORIZATION })),
    "stale_tip_changed", "an authorization never initializes a journal");
  assert.equal(existsSync(leasePaths(fresh).root), false);

  const holder = registry({ owner: OWNER_A });
  holder.acquireHome(fresh, "claude");
  assert.deepEqual(holder.inspectHome(fresh), { state: "held" });
  assert.equal(refusal(() => holder.recoverStaleLease(fresh, "claude", { staleTipHash: "f".repeat(64), authorizationId: AUTHORIZATION })),
    "stale_tip_changed");
  holder.releaseAll();
  assert.equal(registry().inspectHome(fresh).state, "released");
  assert.equal(refusal(() => registry().recoverStaleLease(fresh, "claude", { staleTipHash: "f".repeat(64), authorizationId: AUTHORIZATION })),
    "stale_tip_changed", "a released lease needs no recovery");
});

test("an authorization never bypasses the host, profile grant, or a record's own lifecycle evidence", { skip }, (t) => {
  {
    const home = legacyHome(t, { hostname: "host-b" });
    const inspection = registry().inspectHome(home);
    assert.deepEqual([inspection.sameHost, inspection.refusal], [false, "foreign_host"]);
    assert.equal(refusal(() => registry().recoverStaleLease(home, "claude", { staleTipHash: inspection.tipHash!, authorizationId: AUTHORIZATION })), "foreign_host");
  }
  {
    const home = legacyHome(t);
    const marker: ProviderProfileMarker = {
      version: 1, kind: "wollipog-provider-profile", profileId: PROFILE_ID, provider: "claude", createdAt: "2026-10-16T00:00:00.000Z",
      grants: [{ controlPlaneInstanceId: OTHER_INSTANCE_ID, grantId: "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", grantedAt: "2026-10-16T00:00:01.000Z" }],
    };
    writeProviderProfileMarker(home, marker);
    const access = { controlPlaneSupportsProfiles: true, activeProfileIds: [PROFILE_ID] };
    const inspection = registry().inspectHome(home, access);
    assert.equal(inspection.refusal, "profile_not_granted", "a HOME whose profile does not grant this control plane stays refused");
    assert.equal(refusal(() => registry().recoverStaleLease(home, "claude", { staleTipHash: inspection.tipHash!, authorizationId: AUTHORIZATION }, access)),
      "profile_not_granted");
  }
  {
    // An evidenced lease on a HOME without a profile: the authorization replaces the missing grant,
    // never the evidence. A surviving marked process still blocks; a clean scan recovers.
    const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-authorized-evidence-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const world = { running: new Map([[101, "500"]]), marked: [4242] as number[] };
    const probe: LeaseProcessProbe = {
      bootId: () => BOOT, startTime: (pid) => world.running.get(pid) ?? null,
      scan: (marker) => ({ marked: marker === MARKER_A ? world.marked : [], uninspectable: [] }),
    };
    new ProviderHomeLeaseRegistry(OWNER_A, { pid: 101, hostname: "host-a", runnerMarker: MARKER_A, processProbe: probe }).acquireHome(home, "claude");
    world.running.delete(101);
    const recovering = registry({ probe, bootedAt: Date.now() + 3_600_000 });
    const blocked = recovering.inspectHome(home);
    assert.deepEqual([blocked.hasEvidence, blocked.refusal], [true, "busy"], "a later boot time never overrides surviving evidence");
    assert.equal(refusal(() => recovering.recoverStaleLease(home, "claude", { staleTipHash: blocked.tipHash!, authorizationId: AUTHORIZATION })), "busy");
    world.marked = [];
    assert.equal(recovering.inspectHome(home).refusal, null);
    recovering.recoverStaleLease(home, "claude", { staleTipHash: blocked.tipHash!, authorizationId: OTHER_AUTHORIZATION });
    const recoveredId = JSON.parse(readFileSync(join(leasePaths(home).root, "mutable-home.recovery.json"), "utf8")).leaseId as string;
    assert.deepEqual(successor(home, recoveredId)!.recovery, { proof: "authorized", authorizationId: OTHER_AUTHORIZATION, basis: "process_scan" });
  }
});

test("the same owner's lease stuck behind a reused PID is recovered after a reboot", { skip }, (t) => {
  const home = legacyHome(t);
  const restarted = registry({ owner: OWNER_A, alive: true });
  assert.equal(refusal(() => restarted.acquireHome(home, "claude")), "busy", "a live (reused) PID blocks the ordinary reclaim");
  const inspection = restarted.inspectHome(home);
  assert.equal(inspection.refusal, null);
  restarted.recoverStaleLease(home, "claude", { staleTipHash: inspection.tipHash!, authorizationId: AUTHORIZATION });
  assert.equal((successor(home, LEGACY_ID)!.recovery as Record<string, unknown>).basis, "booted_after");
});

test("forged authorized notes are refused by readers", { skip }, (t) => {
  const forge = (note: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
    const home = legacyHome(t);
    const recovering = registry();
    const inspection = recovering.inspectHome(home);
    recovering.recoverStaleLease(home, "claude", { staleTipHash: inspection.tipHash!, authorizationId: AUTHORIZATION });
    const { lock } = leasePaths(home);
    const recovered = successor(home, LEGACY_ID)!;
    // Drop the release so the forged recovery is the tip, then rewrite the recovery note.
    rmSync(join(lock, `next-${recovered.leaseId as string}.json`), { force: true });
    rmSync(join(leasePaths(home).root, `next-${recovered.leaseId as string}.json`), { force: true });
    const path = join(lock, `next-${LEGACY_ID}.json`);
    rmSync(path);
    writeFileSync(path, `${JSON.stringify({ ...recovered, ...overrides, recovery: note })}\n`, { mode: 0o600 });
    // The chain reader decides: a verified journal shows the recovered record as a stale tip.
    return registry({ owner: OWNER_A }).inspectHome(home).state;
  };
  const valid = { proof: "authorized", authorizationId: AUTHORIZATION, basis: "booted_after" };
  assert.equal(forge(valid), "stale", "control: an unforged recovered tip verifies");
  assert.equal(forge({ ...valid, basis: "process_scan" }), "unverifiable", "an evidence basis over a record without evidence");
  assert.equal(forge({ ...valid, authorizationId: "not-a-uuid" }), "unverifiable");
  assert.equal(forge({ ...valid, extra: true }), "unverifiable");
  assert.equal(forge(valid, { hostname: "host-b" }), "unverifiable", "a recovery is never across hosts");
});

test("macOS kern.boottime output is parsed exactly", () => {
  assert.equal(parseDarwinBootTime("{ sec = 1792300000, usec = 123456 } Fri Oct 17 09:00:00 2026\n"), 1_792_300_000_000);
  assert.equal(parseDarwinBootTime("garbage"), null);
  assert.equal(parseDarwinBootTime("{ sec = 0, usec = 1 }"), null);
});
