import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import fc from "fast-check";
import { AsyncProviderHomeLeaseRegistry } from "./provider-home-lease-async.js";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import { LEASE_WORKER_ERRORS, LEASE_WORKER_REFERENCE_LIMIT, ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";
import { readProviderProfileMarker, writeProviderProfileMarker } from "./provider-profile.js";

function worker(data: Record<string, unknown>): Worker {
  return new Worker(`require(${JSON.stringify(createRequire(import.meta.url).resolve("tsx/cjs"))});require(${JSON.stringify(fileURLToPath(new URL("./provider-home-lease-worker.ts", import.meta.url)))});`,
    { eval: true, execArgv: [], workerData: data });
}

test("cold worker acquisition and exact reference release leave the heartbeat timer responsive", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-async-lease-"));
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64));
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  let last = performance.now();
  const delays: number[] = [];
  const timer = setInterval(() => {
    const now = performance.now(); delays.push(Math.max(0, now - last - 20)); last = now;
  }, 20);
  t.after(() => clearInterval(timer));
  const home = join(root, "home");
  assert.equal(await registry.acquireHome(home), true);
  assert.equal(await registry.acquireHome(home), false);
  assert.equal(await registry.releaseHome(home), false, "borrowed reference does not release the owner");
  assert.equal(await registry.releaseHome(home), true);
  assert.ok(delays.length > 0, "heartbeats ran while initialization/acquisition were pending");
  assert.ok(Math.max(...delays) <= 500, `dispatch delay ${Math.max(...delays)} ms`);
});

test("aborted queued acquisition creates no private reference", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-async-cancel-"));
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64));
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  const home = join(root, "home");
  const first = registry.acquireHome(home);
  const cancellation = new AbortController();
  const second = registry.acquireHome(home, "skills", { signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(second, /cancelled/);
  assert.equal(await first, true);
  assert.equal(await registry.releaseHome(home), true);
});

for (const phase of ["receipt", "accepted"] as const) test(`real worker cancellation at ${phase} unwinds only its acquired reference`, async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-real-worker-cancel-")), home = join(root, "home");
  const controller = new AbortController(); let armed = false;
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { workerFactoryForTest: data => {
    const actual = worker(data);
    if (phase === "receipt") actual.on("message", reply => { if (armed && reply.kind === "receipt") { armed = false; controller.abort(); } });
    else {
      const post = actual.postMessage.bind(actual);
      actual.postMessage = message => { if (armed && message.kind === "accept") { armed = false; controller.abort(); } post(message); };
    }
    return actual;
  } });
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(await registry.acquireHome(home), true);
  armed = true;
  await assert.rejects(registry.acquireHome(home, "skills", { signal: controller.signal }), /cancelled/);
  assert.equal(await registry.releaseHome(home), true, "the original reference survives; the cancelled borrow does not");
  assert.equal(await registry.close(), true);
});

test("cancellation stays bound to its private canonical HOME after an alias is retargeted", { skip: process.platform === "win32" }, async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worker-alias-")), first = join(root, "first"), second = join(root, "second"), alias = join(root, "alias");
  mkdirSync(first); mkdirSync(second); symlinkSync(first, alias);
  const controller = new AbortController();
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { workerFactoryForTest: data => {
    const actual = worker(data);
    actual.once("message", () => {});
    const onReceipt = (reply: { kind: string }) => {
      if (reply.kind !== "receipt") return;
      actual.off("message", onReceipt); unlinkSync(alias); symlinkSync(second, alias); controller.abort();
    };
    actual.on("message", onReceipt); return actual;
  } });
  const other = new AsyncProviderHomeLeaseRegistry("b".repeat(64));
  t.after(async () => { await registry.close(); await other.close(); rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(registry.acquireHome(alias, "skills", { signal: controller.signal }), /cancelled/);
  assert.equal(await other.acquireHome(first), true, "cancel released the originally acquired HOME");
  assert.equal(await other.acquireHome(second), true, "cancel never acquired or released the new alias target");
  assert.equal(await other.close(), true);
});

test("a lost real worker poisons its registry and another worker cannot adopt its live parent's authority", async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worker-loss-")), home = join(root, "home");
  let actual!: Worker;
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { workerFactoryForTest: data => actual = worker(data) });
  const other = new AsyncProviderHomeLeaseRegistry("a".repeat(64));
  t.after(async () => { await registry.close(); await other.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal(await registry.acquireHome(home), true); await actual.terminate();
  await assert.rejects(registry.acquireHome(home), /worker unavailable/);
  assert.equal(await registry.close(), false, "worker loss proves neither rollback nor release");
  await assert.rejects(other.acquireHome(home), /already in use/, "same PID and owner hash cannot reconstruct a lost private token");
  assert.equal(await other.close(), true, "a refused acquisition owns no reference");
});

test("generated reference and cancellation sequences preserve the independent ownership count", { timeout: process.platform === "win32" ? 300_000 : 90_000 }, async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("borrow", "release", "cancel"), { maxLength: process.platform === "win32" ? 6 : 12 }), async commands => {
    const root = mkdtempSync(join(tmpdir(), "wollipog-worker-count-")), home = join(root, "home");
    let cancelAtReceipt: AbortController | undefined;
    const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { workerFactoryForTest: data => {
      const actual = worker(data); actual.on("message", reply => {
        if (reply.kind === "receipt" && cancelAtReceipt) { const controller = cancelAtReceipt; cancelAtReceipt = undefined; controller.abort(); }
      }); return actual;
    } });
    let count = 0;
    try {
      for (const command of commands) {
        if (command === "borrow") { assert.equal(await registry.acquireHome(home), count === 0); count++; }
        else if (command === "release") {
          assert.equal(await registry.releaseHome(home), count === 1);
          count = Math.max(0, count - 1);
        } else {
          const controller = new AbortController(); cancelAtReceipt = controller;
          await assert.rejects(registry.acquireHome(home, "skills", { signal: controller.signal }), /cancelled/);
        }
      }
      while (count > 0) { assert.equal(await registry.releaseHome(home), count === 1); count--; }
      assert.equal(await registry.acquireHome(home), true, "no cancelled or released request leaves an extra reference");
      assert.equal(await registry.releaseHome(home), true);
      assert.equal(await registry.close(), true);
    } finally { await registry.close(); rmSync(root, { recursive: true, force: true }); }
  }), { numRuns: process.platform === "win32" ? 3 : 15, seed: 2317 });
});

test("a reference handle releases the entry it joined even after its HOME alias is retargeted", async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-async-reference-"));
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64));
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  const homeA = join(root, "a"), homeB = join(root, "b"), alias = join(root, "alias");
  mkdirSync(homeA); mkdirSync(homeB);
  symlinkSync(homeA, alias);
  assert.equal(await registry.acquireHome(homeB, "claude"), true, "a running session holds B");
  const reference = await registry.acquireHomeReference(alias);
  assert.equal(reference.first, true, "the alias resolved to A when acquired");
  unlinkSync(alias); symlinkSync(homeB, alias);
  assert.equal(await reference.release(), true, "A's only reference is dropped");
  assert.equal(await reference.release(), true, "release is idempotent and performs no second release");
  assert.equal(await registry.acquireHome(homeA), true, "A has no reference left");
  assert.equal(await registry.releaseHome(homeA), true);
  assert.equal(await registry.releaseHome(homeB), true, "B's session reference was never touched");
});

test("retained references free their handles while unsettled handles are bounded", async t => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-async-handles-")), home = join(root, "home");
  mkdirSync(home);
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64));
  t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
  const total = LEASE_WORKER_REFERENCE_LIMIT + 8;
  for (let i = 0; i < total; i++) await (await registry.acquireHomeReference(home)).retain();
  const open = [];
  for (let i = 0; i < LEASE_WORKER_REFERENCE_LIMIT; i++) open.push(await registry.acquireHomeReference(home));
  await assert.rejects(registry.acquireHomeReference(home), (error: unknown) =>
    error instanceof ProviderHomeLeaseError && error.code === "busy");
  for (const reference of open) assert.equal(await reference.release(), true, "each handle drops its own reference");
  for (let i = 0; i < total - 1; i++) assert.equal(await registry.releaseHome(home), false, "retained references keep the HOME held");
  assert.equal(await registry.releaseHome(home), true, "every retained reference was exactly counted");
  assert.equal(await registry.acquireHome(home), true);
  assert.equal(await registry.releaseHome(home), true);
});

test("foreign-owner and foreign-host refusals keep their typed code across the worker boundary", async t => {
  // Above every platform's pid_max, so the recorded holder is provably gone.
  const deadPid = 2 ** 22 + 1;
  for (const scenario of ["foreign_owner", "foreign_host"] as const) {
    const root = mkdtempSync(join(tmpdir(), `wollipog-async-${scenario}-`)), home = join(root, "home");
    mkdirSync(home);
    const previous = new ProviderHomeLeaseRegistry("b".repeat(64), {
      pid: deadPid,
      ...(scenario === "foreign_host" ? { hostname: "another-host.invalid" } : {}),
    });
    assert.equal(previous.acquireHome(home, "claude"), true); // never released: the runner was replaced
    const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64));
    t.after(async () => { await registry.close(); rmSync(root, { recursive: true, force: true }); });
    await assert.rejects(registry.acquireHome(home, "claude"), (error: unknown) => {
      assert.ok(error instanceof ProviderHomeLeaseError);
      assert.equal(error.code, scenario);
      assert.equal(error.message, LEASE_WORKER_ERRORS[scenario]);
      assert.ok(!error.message.includes(root), "no lock path crosses the boundary");
      return true;
    });
  }
});

test("profile refusals cross the real worker boundary as fixed codes before any lease journal I/O", { skip: process.platform === "win32" }, async t => {
  const profileId = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455", instance = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
  const root = mkdtempSync(join(tmpdir(), "wollipog-async-profile-")), home = join(root, "home");
  mkdirSync(home);
  writeProviderProfileMarker(home, { version: 1, kind: "wollipog-provider-profile", profileId, provider: "claude", createdAt: "2026-10-16T00:00:00.000Z",
    grants: [{ controlPlaneInstanceId: instance, grantId: "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", grantedAt: "2026-10-16T00:00:01.000Z" }] });
  let access = { controlPlaneSupportsProfiles: false, activeProfileIds: [] as string[] };
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { controlPlaneInstanceId: instance, profileAccess: () => access });
  const unrelated = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { controlPlaneInstanceId: "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3",
    profileAccess: () => ({ controlPlaneSupportsProfiles: true, activeProfileIds: [profileId] }) });
  t.after(async () => { await registry.close(); await unrelated.close(); rmSync(root, { recursive: true, force: true }); });
  const refused = (code: string) => (error: unknown) => {
    assert.ok(error instanceof ProviderHomeLeaseError);
    assert.equal(error.code, code);
    assert.equal(error.message, LEASE_WORKER_ERRORS[error.code]);
    assert.ok(!error.message.includes(root), "no HOME path crosses the boundary");
    return true;
  };
  await assert.rejects(registry.acquireHome(home, "claude"), refused("profile_unsupported_control_plane"));
  await assert.rejects(unrelated.acquireHome(home, "claude"), refused("profile_not_granted"));
  await assert.rejects(registry.acquireHomeReference(home, "claude", {}, { expectedProfileId: "7f1c2d3e-4a5b-4c6d-8e7f-001122334455" }), refused("profile_changed"));
  assert.equal(existsSync(join(home, ".agent-manager", "provider-home-leases-v1")), false);
  access = { controlPlaneSupportsProfiles: true, activeProfileIds: [profileId] };
  const reference = await registry.acquireHomeReference(home, "claude", {}, { expectedProfileId: profileId });
  assert.equal(reference.first, true);
  assert.equal(await reference.release(), true);
});

test("an invalid control-plane instance id fails worker startup closed", async () => {
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { controlPlaneInstanceId: "not-an-instance" });
  await assert.rejects(registry.acquireHome(join(tmpdir(), "wollipog-never-created")), /worker unavailable/);
  assert.equal(await registry.close(), false);
});

test("profile adoption and revocation run under the HOME lease in the real worker", { skip: process.platform === "win32" }, async t => {
  const instance = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", otherInstance = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
  const grant = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", otherGrant = "3a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
  const root = mkdtempSync(join(tmpdir(), "wollipog-async-profile-adopt-")), home = join(root, "home");
  mkdirSync(home);
  let active: string[] = [];
  let expected: string | undefined;
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { controlPlaneInstanceId: instance,
    profileAccess: () => ({ controlPlaneSupportsProfiles: true, activeProfileIds: active }), expectedProfileIdForHome: () => expected });
  const other = new AsyncProviderHomeLeaseRegistry("b".repeat(64), { controlPlaneInstanceId: otherInstance,
    profileAccess: () => ({ controlPlaneSupportsProfiles: true, activeProfileIds: active }) });
  t.after(async () => { await registry.close(); await other.close(); rmSync(root, { recursive: true, force: true }); });

  const { profileId } = await registry.adoptProfile(home, "claude", grant);
  const first = readProviderProfileMarker(home);
  assert.equal(first.state, "present");
  assert.equal(first.state === "present" && first.marker.profileId, profileId);
  assert.deepEqual(first.state === "present" && first.marker.grants.map(g => [g.controlPlaneInstanceId, g.grantId]), [[instance, grant]]);
  assert.equal((await registry.adoptProfile(home, "claude", grant)).profileId, profileId, "repeating the same grant is idempotent");

  // A second control plane adopting the same HOME adds its grant and keeps the identity.
  assert.deepEqual(await other.adoptProfile(home, "claude", otherGrant), { profileId });
  const shared = readProviderProfileMarker(home);
  assert.deepEqual(shared.state === "present" && shared.marker.grants.map(g => g.controlPlaneInstanceId), [instance, otherInstance]);

  active = [profileId]; expected = profileId;
  const reference = await registry.acquireHomeReference(home, "claude");
  assert.equal(reference.first, true);
  // Revocation while this runner holds the HOME joins the held lease instead of being refused.
  assert.equal(await registry.revokeProfileGrant(home, "claude", profileId, grant), true);
  assert.equal(await registry.revokeProfileGrant(home, "claude", profileId, grant), false, "nothing left to revoke");
  const revoked = readProviderProfileMarker(home);
  assert.deepEqual(revoked.state === "present" && revoked.marker.grants.map(g => g.controlPlaneInstanceId), [otherInstance], "only this grant was removed");
  await assert.rejects(registry.acquireHome(home, "claude"), (error: unknown) => error instanceof ProviderHomeLeaseError && error.code === "profile_not_granted");
  assert.equal(await reference.release(), true);
  await assert.rejects(other.adoptProfile(home, "codex", otherGrant), (error: unknown) => error instanceof ProviderHomeLeaseError &&
    error.code === "profile_unverifiable", "a marker for another provider is never extended");

  // A substituted HOME at the account's path is refused against the account's recorded id.
  renameSync(home, join(root, "original"));
  mkdirSync(home);
  await assert.rejects(registry.acquireHome(home, "claude"), (error: unknown) => error instanceof ProviderHomeLeaseError && error.code === "profile_changed");
  assert.equal(existsSync(join(home, ".agent-manager", "provider-home-leases-v1")), false);
});

test("removed-account HOME retirement decides under the lease in the real worker", { skip: process.platform === "win32" }, async t => {
  const instance = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", otherInstance = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
  const grant = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", otherGrant = "3a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
  const root = mkdtempSync(join(tmpdir(), "wollipog-async-profile-retire-"));
  const shared = join(root, "shared"), held = join(root, "held"), plain = join(root, "plain");
  for (const home of [shared, held, plain]) mkdirSync(home);
  let active: string[] = [];
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { controlPlaneInstanceId: instance,
    profileAccess: () => ({ controlPlaneSupportsProfiles: true, activeProfileIds: active }) });
  const other = new AsyncProviderHomeLeaseRegistry("b".repeat(64), { controlPlaneInstanceId: otherInstance });
  t.after(async () => { await registry.close(); await other.close(); rmSync(root, { recursive: true, force: true }); });
  const grantsOf = (home: string) => {
    const read = readProviderProfileMarker(home);
    return read.state === "present" ? read.marker.grants.map(g => g.controlPlaneInstanceId) : read.state;
  };

  await registry.adoptProfile(shared, "claude", grant);
  await other.adoptProfile(shared, "claude", otherGrant);
  assert.equal(await registry.retireProfileHome(shared, "claude"), false, "another control plane's grant keeps the HOME");
  assert.deepEqual(grantsOf(shared), [otherInstance], "and only this control plane's grant was dropped");

  const { profileId } = await registry.adoptProfile(held, "claude", grant);
  active = [profileId];
  const reference = await registry.acquireHomeReference(held, "claude");
  assert.equal(await registry.retireProfileHome(held, "claude"), false, "a HOME a session still holds is kept");
  assert.deepEqual(grantsOf(held), [], "though this control plane's grant is gone");
  assert.equal(await reference.release(), true);
  assert.equal(await registry.retireProfileHome(held, "claude"), true, "once nothing holds it, it may be deleted");

  assert.equal(await registry.retireProfileHome(plain, "claude"), true, "a marker-less HOME keeps today's rule");
  assert.equal(grantsOf(plain), "absent", "and gains no marker");
  // The lease was released: another runner can take the HOME now.
  assert.equal(await other.acquireHome(plain, "claude"), true);
  assert.equal(await other.releaseHome(plain), true);
});
