import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { providerHomeLeaseRefusalKind, ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import type { LeaseProcessProbe } from "./provider-home-lease-evidence.js";
import type { LeaseContainmentEvidence, LeaseContainmentResult } from "./provider-home-lease-containment.js";
import { adoptProviderProfileMarker, writeProviderProfileMarker, type ProviderProfileMarker } from "./provider-profile.js";

const previousMask = process.umask(0o077);
test.after(() => process.umask(previousMask));

// #3241: an authorized owner recovers another owner's abandoned lease only with proof that nothing
// the old runner launched survives, through an explicit, hash-linked recovery record.

const OWNER_A = "a".repeat(64);
const OWNER_B = "b".repeat(64);
const BOOT = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const NEW_BOOT = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const MARKER_A = "0123456789abcdef0123456789abcdef";
const MARKER_B = "fedcba9876543210fedcba9876543210";
const PROFILE_ID = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const INSTANCE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const GRANTED = { controlPlaneSupportsProfiles: true, activeProfileIds: [PROFILE_ID] };
const skip = process.platform === "win32";

interface World { boot: string; running: Map<number, string>; marked: number[]; uninspectable: number[]; boundary?: LeaseContainmentResult }

function probe(world: World): LeaseProcessProbe {
  return {
    bootId: () => world.boot,
    startTime: (pid) => world.running.get(pid) ?? null,
    scan: (marker) => ({ marked: marker === MARKER_A ? world.marked : [], uninspectable: world.uninspectable }),
    containment: () => world.boundary ?? "unverifiable",
  };
}

function profileMarker(): ProviderProfileMarker {
  return {
    version: 1, kind: "wollipog-provider-profile", profileId: PROFILE_ID, provider: "claude", createdAt: "2026-10-16T00:00:00.000Z",
    grants: [{ controlPlaneInstanceId: INSTANCE_ID, grantId: "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", grantedAt: "2026-10-16T00:00:01.000Z" }],
  };
}

function leaseRoot(home: string): string {
  return join(home, ".agent-manager", "provider-home-leases-v1");
}

/** Every canonical record (root journal), oldest first by chain order. */
function chain(home: string): Array<Record<string, unknown> & { hash: string }> {
  const root = leaseRoot(home);
  const read = (name: string): Record<string, unknown> & { hash: string } => { const raw = readFileSync(join(root, name), "utf8"); return { ...JSON.parse(raw) as Record<string, unknown>, hash: createHash("sha256").update(raw).digest("hex") }; };
  const records = [read("mutable-home.recovery.json")];
  for (;;) {
    const name = `next-${records.at(-1)!.leaseId as string}.json`;
    if (!readdirSync(root).includes(name)) return records;
    records.push(read(name));
  }
}

/** A runner of owner A on this host that crashed while holding the profiled HOME. */
function crashedHome(t: { after: (fn: () => void) => void }, options: { profiled?: boolean; evidence?: boolean; containment?: LeaseContainmentEvidence } = {}) {
  const home = mkdtempSync(join(tmpdir(), "wollipog-provider-home-recovery-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (options.profiled !== false) writeProviderProfileMarker(home, profileMarker());
  const world: World = { boot: BOOT, running: new Map([[101, "500"]]), marked: [], uninspectable: [] };
  const crashed = new ProviderHomeLeaseRegistry(OWNER_A, {
    pid: 101, hostname: "host-a", controlPlaneInstanceId: INSTANCE_ID, processProbe: probe(world),
    ...(options.evidence === false ? {} : { runnerMarker: MARKER_A }),
    ...(options.containment ? { containment: options.containment } : {}),
  });
  crashed.acquireHome(home, "claude", options.profiled === false ? undefined : GRANTED);
  world.running.delete(101); // the runner died without releasing
  return { home, world };
}

function replacement(world: World, owner = OWNER_B, pid = 202) {
  world.running.set(pid, String(pid * 10));
  return new ProviderHomeLeaseRegistry(owner, {
    pid, hostname: "host-a", controlPlaneInstanceId: INSTANCE_ID, runnerMarker: MARKER_B, processProbe: probe(world),
    isProcessAlive: () => false,
  });
}

function refusal(action: () => unknown): { kind: string | null; message: string } | "acquired" {
  try { action(); } catch (error) { return { kind: providerHomeLeaseRefusalKind(error), message: String(error) }; }
  return "acquired";
}

test("a crashed runner records lifecycle evidence, and a granted replacement recovers its lease through an explicit record", { skip }, (t) => {
  const { home, world } = crashedHome(t);
  const [stale] = chain(home);
  assert.deepEqual(stale!.process, { bootId: BOOT, startTime: "500", marker: MARKER_A });
  const next = replacement(world);
  next.acquireHome(home, "claude", GRANTED);
  const records = chain(home);
  assert.equal(records.length, 2, "the stale record is kept and the recovery is appended, never a fabricated release");
  assert.equal(records[0]!.hash, stale!.hash);
  assert.equal(records[0]!.state, "active");
  assert.deepEqual({ owner: records[1]!.ownerHash, state: records[1]!.state, previous: records[1]!.previousRecordHash, recovery: records[1]!.recovery },
    { owner: OWNER_B, state: "active", previous: stale!.hash, recovery: { proof: "process_scan", profileId: PROFILE_ID } });
  // The recovered lease behaves like any other: it releases cleanly and a third owner can follow.
  assert.equal(next.releaseAll(), true);
  const released = chain(home).at(-1)!;
  assert.equal(released.state, "released");
  assert.equal(released.recovery, undefined, "a release never carries the recovery note");
  const third = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 303, hostname: "host-a", controlPlaneInstanceId: INSTANCE_ID, processProbe: probe(world) });
  third.acquireHome(home, "claude", GRANTED);
  assert.equal(third.releaseAll(), true);
});

test("a reboot proves abandonment even when the recorded PID and start time reappear", { skip }, (t) => {
  const { home, world } = crashedHome(t);
  world.boot = NEW_BOOT;
  world.running.set(101, "500");
  world.marked = [77];
  const next = replacement(world);
  next.acquireHome(home, "claude", GRANTED);
  assert.deepEqual(chain(home).at(-1)!.recovery, { proof: "reboot", profileId: PROFILE_ID });
  next.releaseAll();
});

test("a live runner, a surviving descendant, or an uninspectable process prevents the handoff", { skip }, (t) => {
  for (const scenario of ["runner", "descendant", "uninspectable"] as const) {
    const { home, world } = crashedHome(t);
    if (scenario === "runner") world.running.set(101, "500");
    if (scenario === "descendant") world.marked = [4242];
    if (scenario === "uninspectable") world.uninspectable = [4343];
    const before = chain(home);
    const result = refusal(() => replacement(world).acquireHome(home, "claude", GRANTED));
    assert.notEqual(result, "acquired", scenario);
    if (result === "acquired") continue;
    assert.equal(result.kind, scenario === "uninspectable" ? "process_uninspectable" : scenario === "runner" ? "holder_alive" : "process_survivor", scenario);
    if (scenario === "descendant") assert.match(result.message, /still used by a process the leasing runner launched/u);
    assert.deepEqual(chain(home), before, `${scenario}: nothing is published`);
  }
});

test("a reused PID with a different start time does not keep the stale lease alive", { skip }, (t) => {
  const { home, world } = crashedHome(t);
  world.running.set(101, "999");
  const next = replacement(world);
  next.acquireHome(home, "claude", GRANTED);
  assert.deepEqual(chain(home).at(-1)!.recovery, { proof: "process_scan", profileId: PROFILE_ID });
  next.releaseAll();
});

test("recovery needs this control plane's profile grant: unprofiled HOMEs and marker changes stay refused", { skip }, (t) => {
  {
    const { home, world } = crashedHome(t, { profiled: false });
    const result = refusal(() => replacement(world).acquireHome(home));
    assert.ok(result !== "acquired" && result.kind === "foreign_owner", "a HOME without a profile grant is not recovered automatically");
  }
  {
    const { home, world } = crashedHome(t);
    const before = chain(home);
    const result = refusal(() => replacement(world).changeProfileMarkerWhileHeld(home, "claude", (read) =>
      adoptProviderProfileMarker(read, { provider: "claude", grant: { controlPlaneInstanceId: INSTANCE_ID, grantId: "4a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", grantedAt: "2026-10-18T00:00:00.000Z" } })));
    assert.ok(result !== "acquired" && result.kind === "foreign_owner", "adoption and revocation never recover another owner's lease");
    assert.deepEqual(chain(home), before);
  }
});

test("a stale lease without lifecycle evidence is never recovered by another owner", { skip }, (t) => {
  const { home, world } = crashedHome(t, { evidence: false });
  assert.equal(chain(home)[0]!.process, undefined);
  const result = refusal(() => replacement(world).acquireHome(home, "claude", GRANTED));
  assert.ok(result !== "acquired" && result.kind === "foreign_owner");
});

test("the same owner's restart needs the same proof: a surviving descendant blocks reclaim", { skip }, (t) => {
  const { home, world } = crashedHome(t);
  world.marked = [4242];
  const restarted = replacement(world, OWNER_A, 303);
  const blocked = refusal(() => restarted.acquireHome(home, "claude", GRANTED));
  assert.ok(blocked !== "acquired" && blocked.kind === "process_survivor", "a dead runner PID alone no longer reclaims an evidenced lease");
  world.marked = [];
  restarted.acquireHome(home, "claude", GRANTED);
  const tip = chain(home).at(-1)!;
  assert.deepEqual({ owner: tip.ownerHash, pid: tip.pid, recovery: tip.recovery }, { owner: OWNER_A, pid: 303, recovery: { proof: "process_scan" } },
    "a same-owner reclaim also records its recovery proof");
  restarted.releaseAll();
});

test("versioned boundary recovery retains journal history and profile authorization across replacement and reboot", { skip }, (t) => {
  const containment = { kind: "linux-cgroup-v2" as const, bootId: BOOT, mountRoot: "/", cgroupPath: "runner/providers", inode: "123" };
  for (const reboot of [false, true]) {
    const { home, world } = crashedHome(t, { containment });
    const before = chain(home);
    world.uninspectable = [444];
    world.running.set(101, "999");
    world.boundary = "empty";
    if (reboot) { world.boot = NEW_BOOT; world.boundary = "populated"; world.running.set(101, "500"); }
    const next = replacement(world);
    next.acquireHome(home, "claude", GRANTED);
    assert.deepEqual(chain(home).slice(0, 1), before);
    assert.deepEqual(chain(home).at(-1)!.recovery, { proof: reboot ? "reboot" : "linux_cgroup", profileId: PROFILE_ID });
    assert.equal(next.releaseAll(), true);
  }
  const { home, world } = crashedHome(t, { profiled: false, containment }); world.boundary = "empty";
  const result = refusal(() => replacement(world).acquireHome(home));
  assert.ok(result !== "acquired" && result.kind === "foreign_owner", "empty cgroup never grants profile authority");
});

test("version-5 ownership and recovery remain verifiable through canonical checkpoint compaction", { skip, timeout: 120_000 }, (t) => {
  const containment = { kind: "linux-cgroup-v2" as const, bootId: BOOT, mountRoot: "/", cgroupPath: "runner/providers", inode: "123" };
  const { home, world } = crashedHome(t, { containment });
  // The first holder has exited. A same-owner successor uses the same recorded process view and
  // versioned evidence through enough ordinary releases/acquisitions to publish a checkpoint.
  world.boundary = "empty";
  world.running.set(404, "4040");
  const holder = new ProviderHomeLeaseRegistry(OWNER_A, { pid: 404, hostname: "host-a", controlPlaneInstanceId: INSTANCE_ID,
    runnerMarker: MARKER_B, processProbe: probe(world), containment });
  for (let turn = 0; turn < 12; turn++) {
    holder.acquireHome(home, "claude", GRANTED);
    assert.equal(holder.releaseAll(), true);
  }
  holder.acquireHome(home, "claude", GRANTED);
  const raw = readFileSync(join(leaseRoot(home), "mutable-home.recovery.json"), "utf8");
  const anchor = JSON.parse(raw) as { version: number; checkpoint: { previousTip: string }; process: unknown };
  assert.equal(anchor.version, 4, "the test actually crosses checkpoint publication");
  assert.equal(JSON.parse(anchor.checkpoint.previousTip).version, 5, "checkpoint retains the incompatible tip version for old readers");
  world.running.delete(404);
  world.uninspectable = [444];
  const next = replacement(world);
  next.acquireHome(home, "claude", GRANTED);
  assert.equal(next.releaseAll(), true, "a different runner recovers and releases the checkpointed v5 chain");
});

test("surviving or unverifiable recorded boundaries refuse without falling back to a clean process scan", { skip }, (t) => {
  const containment = { kind: "linux-cgroup-v2" as const, bootId: BOOT, mountRoot: "/", cgroupPath: "runner/providers", inode: "123" };
  for (const boundary of ["populated", "unverifiable"] as const) {
    const { home, world } = crashedHome(t, { containment }); world.boundary = boundary;
    const before = chain(home);
    const result = refusal(() => replacement(world).acquireHome(home, "claude", GRANTED));
    assert.ok(result !== "acquired" && result.kind === (boundary === "populated" ? "boundary_survivor" : "boundary_unverifiable"));
    assert.deepEqual(chain(home), before);
  }
});

test("legacy and non-delegated leases retain scan-based proof and explain why boundary recovery is unavailable", { skip }, (t) => {
  for (const delegated of [false, true]) {
    const { home, world } = crashedHome(t, delegated ? { containment: { kind: "marker-parent-links", reason: "cgroup-not-delegated" } } : {});
    world.uninspectable = [444];
    const before = chain(home);
    const next = replacement(world);
    const result = refusal(() => next.acquireHome(home, "claude", GRANTED));
    assert.notEqual(result, "acquired"); if (result === "acquired") continue;
    assert.equal(result.kind, delegated ? "process_uninspectable_not_delegated" : "process_uninspectable");
    assert.match(result.message, delegated ? /systemd unit is not delegated/u : /legacy lease has no recorded boundary evidence/u);
    assert.deepEqual(chain(home), before);
    world.uninspectable = [];
    next.acquireHome(home, "claude", GRANTED);
    assert.deepEqual(chain(home).at(-1)!.recovery, { proof: "process_scan", profileId: PROFILE_ID });
    assert.equal(next.releaseAll(), true);
  }
});

test("forged recovery records and malformed evidence are refused", { skip }, (t) => {
  const rewrite = (home: string, name: string, change: (record: Record<string, unknown>) => void) => {
    const path = join(leaseRoot(home), name);
    const record = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    change(record);
    rmSync(path);
    writeFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  };
  const cases: Array<[string, (home: string, records: Array<Record<string, unknown>>) => void]> = [
    // Control: the same setup without a forgery leaves a valid recovered tip that the next granted
    // owner recovers in turn, so every refusal below comes from its forgery.
    ["no forgery", () => {}],
    ["malformed evidence", (home) => rewrite(home, "mutable-home.recovery.json", (record) => { (record.process as Record<string, unknown>).bootId = "not-a-boot"; })],
    ["a recovery note on the genesis anchor", (home) => rewrite(home, "mutable-home.recovery.json", (record) => { record.recovery = { proof: "reboot", profileId: PROFILE_ID }; })],
    ["a recovery over a lease that carried no evidence", (home, records) => {
      // Strip the predecessor's evidence and re-link the successor to its new bytes.
      rewrite(home, "mutable-home.recovery.json", (record) => { delete record.process; });
      const raw = readFileSync(join(leaseRoot(home), "mutable-home.recovery.json"), "utf8");
      rewrite(home, `next-${records[0]!.leaseId as string}.json`, (record) => { record.previousRecordHash = createHash("sha256").update(raw).digest("hex"); });
    }],
    ["a malformed recovery note", (home, records) => rewrite(home, `next-${records[0]!.leaseId as string}.json`, (record) => { record.recovery = { proof: "guess", profileId: PROFILE_ID }; })],
  ];
  for (const [name, forge] of cases) {
    const { home, world } = crashedHome(t);
    const recovered = replacement(world);
    recovered.acquireHome(home, "claude", GRANTED);
    recovered.releaseAll();
    world.running.delete(202);
    const records = chain(home);
    // Turn the release into nothing: forge state at rest, then a fresh owner reads it.
    rmSync(join(leaseRoot(home), `next-${records[1]!.leaseId as string}.json`));
    rmSync(join(leaseRoot(home), "mutable-home.lock", `next-${records[1]!.leaseId as string}.json`), { force: true });
    forge(home, records);
    const result = refusal(() => new ProviderHomeLeaseRegistry(OWNER_A, { pid: 404, hostname: "host-a", controlPlaneInstanceId: INSTANCE_ID, processProbe: probe(world) })
      .acquireHome(home, "claude", GRANTED));
    if (name === "no forgery") { assert.equal(result, "acquired"); continue; }
    assert.ok(result !== "acquired" && result.kind === "unverifiable", `${name}: ${result === "acquired" ? "acquired" : result.message}`);
  }
});
