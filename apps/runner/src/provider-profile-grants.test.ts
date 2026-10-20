import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import type { RunnerProviderAccount } from "./config.js";
import { captureProviderAccountsConfigPreimage, writeProviderAccountsConfig } from "./config.js";
import { AccountConfigPublicationError, publishAccountConfig } from "./provider-account-config-publication.js";
import { validateProviderAccounts } from "./config.js";
import { providerAccountDefinition, skillReconciliationProviderAccountPlan } from "./provider-accounts.js";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import { AsyncProviderHomeLeaseRegistry } from "./provider-home-lease-async.js";
import { ProviderLoginSupervisor } from "./provider-login.js";
import { ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";
import {
  adoptProviderProfileCommand,
  removeProviderAccountWithProfile,
  revokeProviderProfileGrantCommand,
  revokeStaleProviderProfileGrants,
  type ProviderProfileCommandDeps,
} from "./provider-profile-commands.js";
import { ProviderProfileGrants } from "./provider-profile-grants.js";
import {
  adoptProviderProfileMarker,
  readProviderProfileMarker,
  revokeProviderProfileMarkerGrant,
  writeProviderProfileMarker,
  type ProviderProfileMarker,
} from "./provider-profile.js";

const posixOnly = { skip: process.platform === "win32" };
const INSTANCE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const OTHER_INSTANCE = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const PROFILE = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const GRANT = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const OTHER_GRANT = "3a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const STALE_GRANT = "4a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";

function marker(grants: Array<[string, string]>, profileId = PROFILE): ProviderProfileMarker {
  return {
    version: 1, kind: "wollipog-provider-profile", profileId, provider: "claude", createdAt: "2026-10-16T00:00:00.000Z",
    grants: grants.map(([controlPlaneInstanceId, grantId]) => ({ controlPlaneInstanceId, grantId, grantedAt: "2026-10-16T00:00:01.000Z" })),
  };
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-profile-grants-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const accounts: RunnerProviderAccount[] = [
    { id: "work", label: "Work", provider: "claude", directory: join(root, "work") },
    { id: "legacy", label: "Legacy", provider: "claude", directory: join(root, "legacy") },
  ];
  for (const account of accounts) mkdirSync(account.directory);
  const configPath = join(root, "runner.json");
  writeFileSync(configPath, `${JSON.stringify({ runnerId: "runner-1", providerAccounts: accounts })}\n`, { mode: 0o600 });
  const grants = new ProviderProfileGrants({ controlPlaneInstanceId: INSTANCE, accounts: () => accounts });
  // The worker's own logic, run in-process against the real lease registry.
  const registry = new ProviderHomeLeaseRegistry("a".repeat(64), { pid: process.pid, hostname: "host-a", controlPlaneInstanceId: INSTANCE });
  t.after(() => { registry.releaseAll(); });
  const published: number[] = [];
  const removals: Array<{ accountId: string; retainCredentialHome?: boolean; retired?: boolean }> = [];
  const deps: ProviderProfileCommandDeps = {
    controlPlaneInstanceId: INSTANCE,
    accounts: () => accounts,
    grants,
    adopt: async (home, provider, grantId) => {
      const grant = { controlPlaneInstanceId: INSTANCE, grantId, grantedAt: "2026-10-16T00:00:02.000Z" };
      return { profileId: registry.changeProfileMarkerWhileHeld(home, provider, (read) => adoptProviderProfileMarker(read, { provider, grant })).marker.profileId };
    },
    revoke: async (home, provider, profileId, grantId) => registry.changeProfileMarkerWhileHeld(home, provider, (read) =>
      revokeProviderProfileMarkerGrant(read, { profileId, controlPlaneInstanceId: INSTANCE, grantId })).changed,
    retire: async (home, provider) => registry.retireProfileHomeWhileHeld(home, provider, INSTANCE),
    captureAccountsPreimage: () => captureProviderAccountsConfigPreimage(configPath, accounts),
    persistAccounts: (next, preimage) => writeProviderAccountsConfig(configPath, next, preimage),
    removeAccount: async (accountId, options) => {
      const account = accounts.find((candidate) => candidate.id === accountId)!;
      removals.push({ accountId, ...(options.retainCredentialHome ? { retainCredentialHome: true } : {}),
        ...(options.retireCredentialHome ? { retired: true } : {}) });
      accounts.splice(accounts.indexOf(account), 1);
      // Model the supervisor: keep grant retirement, but its boolean cannot authorize deletion.
      if (options.retainCredentialHome !== true) await options.retireCredentialHome?.(account);
      return { credentialsRetained: true };
    },
    publish: () => { published.push(Date.now()); },
    log: () => {},
  };
  return { root, accounts, configPath, grants, deps, published, removals, registry };
}

function definition(account: RunnerProviderAccount) {
  return providerAccountDefinition(account);
}

test("an adoption keeps ambiguous publication evidence without activating or restoring a grant", posixOnly, async t => {
  for (const phase of ["before_rename", "renamed"] as const) {
    const f = fixture(t); f.grants.synchronize(225, []);
    const work = f.accounts[0]!;
    const deps: ProviderProfileCommandDeps = { ...f.deps, persistAccounts: (accounts, preimage) => {
      // A CP revocation received while adoption was pending remains effective even if the config
      // may have published. The uncertain branch must never recordAdopted or revoke the marker.
      f.grants.recordRevoked(undefined, GRANT);
      publishAccountConfig(preimage, accounts, validateProviderAccounts, {
        boundary: reached => { if (reached === phase) throw new Error("synthetic boundary failure"); },
      });
    } };
    const result = await adoptProviderProfileCommand(deps, { type: "adopt_provider_profile", requestId: "uncertain", accountId: "work", grantId: GRANT });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /publication is unknown|was published/u);
    const read = readProviderProfileMarker(work.directory);
    assert.equal(read.state, "present");
    assert.deepEqual(read.state === "present" && read.marker.grants.map(grant => grant.grantId), [GRANT]);
    assert.equal(work.profileId, undefined);
    assert.equal(f.grants.usable(work), false);
    assert.deepEqual(f.grants.access().activeProfileIds, []);
    assert.equal(existsSync(join(f.root, ".runner.json.account-publications-v1", "guard.json")), true);
    const persisted = JSON.parse(readFileSync(f.configPath, "utf8")).providerAccounts;
    assert.equal(persisted[0].profileId !== undefined, phase === "renamed");
  }
});

test("an adoption resumed after another config writer cannot overwrite the new account decision", posixOnly, async t => {
  const f = fixture(t); f.grants.synchronize(225, []);
  let markerWritten!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { markerWritten = resolve; });
  const waiting = new Promise<void>(resolve => { resume = resolve; });
  const adoption = adoptProviderProfileCommand({ ...f.deps, adopt: async (...args) => {
    const result = await f.deps.adopt(...args); markerWritten(); await waiting; return result;
  } }, { type: "adopt_provider_profile", requestId: "stale", accountId: "work", grantId: GRANT });
  let published!: Buffer;
  try {
    await Promise.race([ready, adoption.then((result) => { assert.fail(result.error ?? "Adoption ended before the marker-written barrier"); })]);
    const next = f.accounts.map(account => ({ ...account, label: "New Decision" }));
    writeProviderAccountsConfig(f.configPath, next, captureProviderAccountsConfigPreimage(f.configPath, f.accounts));
    published = readFileSync(f.configPath);
  } finally { resume(); }
  assert.equal((await adoption).ok, false);
  assert.deepEqual(readFileSync(f.configPath), published);
  const read = readProviderProfileMarker(f.accounts[0]!.directory);
  assert.deepEqual(read.state === "present" && read.marker.grants.map(grant => grant.grantId), [GRANT], "a stale config decision retains marker evidence rather than racing a newer CP grant with rollback");
  assert.deepEqual(f.grants.access().activeProfileIds, []);
});

test("adoption writes this control plane's grant, persists the profile id, and makes the account usable", posixOnly, async (t) => {
  const f = fixture(t);
  f.grants.synchronize(225, []);
  const work = f.accounts[0]!;
  assert.equal(f.grants.usable(work), true, "a marker-less HOME is usable as before");
  const result = await adoptProviderProfileCommand(f.deps, { type: "adopt_provider_profile", requestId: "r1", accountId: "work", grantId: GRANT });
  assert.equal(result.ok, true);
  const read = readProviderProfileMarker(work.directory);
  assert.equal(read.state, "present");
  assert.equal(read.state === "present" && read.marker.profileId, result.profileId);
  assert.deepEqual(read.state === "present" && read.marker.grants.map((grant) => [grant.controlPlaneInstanceId, grant.grantId]), [[INSTANCE, GRANT]]);
  assert.equal(work.profileId, result.profileId);
  const persisted = JSON.parse(readFileSync(f.configPath, "utf8")) as { providerAccounts: RunnerProviderAccount[] };
  assert.equal(persisted.providerAccounts.find((account) => account.id === "work")?.profileId, result.profileId);
  assert.equal(f.grants.usable(work), true);
  assert.deepEqual(f.grants.accountProfile(work), { id: result.profileId, access: "granted" });
  assert.deepEqual(f.grants.access().activeProfileIds, [result.profileId]);
  assert.equal(f.grants.expectedProfileIdForHome(`${work.directory}/`), result.profileId);
  assert.equal(f.published.length, 1);
  assert.equal(f.registry.releaseAll(), true, "adoption released the lease it took");
});

test("adopting a HOME another control plane already adopted adds a grant and keeps the identity", posixOnly, async (t) => {
  const f = fixture(t);
  const work = f.accounts[0]!;
  writeProviderProfileMarker(work.directory, marker([[OTHER_INSTANCE, OTHER_GRANT]]));
  f.grants.synchronize(225, []);
  assert.equal(f.grants.usable(work), false, "another control plane's profile is not usable here");
  assert.deepEqual(f.grants.accountProfile(work), { id: PROFILE, access: "not_granted" });
  const result = await adoptProviderProfileCommand(f.deps, { type: "adopt_provider_profile", requestId: "r1", accountId: "work", grantId: GRANT });
  assert.deepEqual(result, { type: "adopt_provider_profile_result", requestId: "r1", ok: true, profileId: PROFILE });
  const read = readProviderProfileMarker(work.directory);
  assert.deepEqual(read.state === "present" && read.marker.grants.map((grant) => grant.controlPlaneInstanceId), [OTHER_INSTANCE, INSTANCE]);
  assert.equal(f.grants.usable(work), true);
});

test("adoption refusals carry the protocol's codes", posixOnly, async (t) => {
  const f = fixture(t);
  f.grants.synchronize(225, []);
  const adopt = (accountId: string, deps: ProviderProfileCommandDeps = f.deps) =>
    adoptProviderProfileCommand(deps, { type: "adopt_provider_profile", requestId: "r", accountId, grantId: GRANT });
  assert.equal((await adopt("work", { ...f.deps, platform: "win32" })).code, "UNSUPPORTED_HOME");
  assert.equal((await adopt("missing")).ok, false);
  assert.equal((await adopt("work", { ...f.deps, adopt: async () => { throw new ProviderHomeLeaseError("busy"); } })).code, "HOME_IN_USE");
  assert.equal((await adopt("work", { ...f.deps, adopt: async () => { throw new ProviderHomeLeaseError("profile_grant_limit"); } })).code, "PROFILE_EXISTS");
  const old = fixture(t);
  old.grants.synchronize(223, undefined);
  assert.equal((await adopt("work", old.deps)).ok, false, "never without a negotiated control plane");
  assert.equal(readProviderProfileMarker(f.accounts[0]!.directory).state, "absent");
});

test("revocation removes only this control plane's grant and stops use at once", posixOnly, async (t) => {
  const f = fixture(t);
  const work = f.accounts[0]!;
  writeProviderProfileMarker(work.directory, marker([[INSTANCE, GRANT], [OTHER_INSTANCE, OTHER_GRANT]]));
  work.profileId = PROFILE;
  f.grants.synchronize(225, [{ grantId: GRANT, profileId: PROFILE, status: "active" }]);
  assert.equal(f.grants.usable(work), true);
  const result = await revokeProviderProfileGrantCommand(f.deps, { type: "revoke_provider_profile_grant", requestId: "r", profileId: PROFILE, grantId: GRANT });
  assert.deepEqual(result, { type: "revoke_provider_profile_grant_result", requestId: "r", ok: true, markerUpdated: true });
  const read = readProviderProfileMarker(work.directory);
  assert.deepEqual(read.state === "present" && read.marker.grants.map((grant) => grant.controlPlaneInstanceId), [OTHER_INSTANCE]);
  assert.equal(f.grants.usable(work), false);
  assert.deepEqual(f.grants.access().activeProfileIds, []);
});

test("registration removes grants the control plane no longer lists, and an absent list changes nothing", posixOnly, async (t) => {
  const f = fixture(t);
  const [work, legacy] = f.accounts as [RunnerProviderAccount, RunnerProviderAccount];
  writeProviderProfileMarker(work.directory, marker([[INSTANCE, STALE_GRANT], [OTHER_INSTANCE, OTHER_GRANT]]));
  writeProviderProfileMarker(legacy.directory, marker([[INSTANCE, GRANT]], "7f1c2d3e-4a5b-4c6d-8e7f-001122334455"));
  f.grants.reportedProfileIds(); // the register frame these `registered` lists answer
  assert.deepEqual(f.grants.synchronize(225, undefined), [], "an absent list never means revoke all");
  assert.deepEqual(f.grants.synchronize(225, [{ grantId: "not-a-grant", status: "active" }]), [], "a malformed list is ignored as a whole");
  assert.equal(readProviderProfileMarker(work.directory).state, "present");
  // The control plane lists GRANT (pending: it never saw the adoption reply) but not STALE_GRANT.
  const stale = f.grants.synchronize(225, [{ grantId: GRANT, status: "pending" }]);
  assert.deepEqual(stale.map((entry) => [entry.account.id, entry.grantId]), [["work", STALE_GRANT]]);
  await revokeStaleProviderProfileGrants(f.deps, stale);
  const read = readProviderProfileMarker(work.directory);
  assert.deepEqual(read.state === "present" && read.marker.grants.map((grant) => grant.controlPlaneInstanceId), [OTHER_INSTANCE],
    "another control plane's grant survives");
  assert.equal(f.grants.usable(work), false);
  assert.equal(f.grants.usable(legacy), true, "a pending grant this HOME records is usable");
  assert.deepEqual(f.grants.accountProfile(legacy), { id: "7f1c2d3e-4a5b-4c6d-8e7f-001122334455", access: "pending" });
  // A control plane below v225 grants nothing.
  assert.deepEqual(f.grants.synchronize(223, [{ grantId: GRANT, status: "pending" }]), []);
  assert.deepEqual(f.grants.access(), { controlPlaneSupportsProfiles: false, activeProfileIds: [] });
  assert.equal(f.grants.usable(legacy), false);
});

test("v225 control planes see each account's profile; older ones never see a profile-bearing account", posixOnly, (t) => {
  const f = fixture(t);
  const [work] = f.accounts as [RunnerProviderAccount];
  writeProviderProfileMarker(work.directory, marker([[INSTANCE, GRANT]]));
  assert.deepEqual(f.grants.project(f.accounts, definition).map((account) => account.id), ["legacy"],
    "before any registration the peer's version is unknown, so the profile-bearing account is hidden");
  assert.deepEqual(f.grants.reportedProfileIds(), [PROFILE], "but registration still reports its profile id");
  f.grants.synchronize(223, undefined);
  assert.deepEqual(f.grants.project(f.accounts, definition).map((account) => account.id), ["legacy"]);
  f.grants.synchronize(225, [{ grantId: GRANT, profileId: PROFILE, status: "active" }]);
  assert.deepEqual(f.grants.project(f.accounts, definition).map((account) => [account.id, account.profile]),
    [["work", { id: PROFILE, access: "granted" }], ["legacy", undefined]]);
  f.grants.synchronize(225, []);
  assert.deepEqual(f.grants.project(f.accounts, definition)[0]?.profile, { id: PROFILE, access: "not_granted" });
});

test("an Add Account grant stays usable across a reconnect during the sign-in and is active once recorded", posixOnly, (t) => {
  const f = fixture(t);
  f.grants.synchronize(225, []);
  f.grants.recordCreated(PROFILE, GRANT);
  assert.deepEqual(f.grants.access().activeProfileIds, [PROFILE]);
  // The new HOME is not a configured account yet, so only the in-flight creation names its profile.
  f.grants.synchronize(225, [{ grantId: GRANT, status: "pending" }]);
  assert.deepEqual(f.grants.access().activeProfileIds, [PROFILE], "the control plane still lists the pending grant");
  const [work] = f.accounts as [RunnerProviderAccount];
  writeProviderProfileMarker(work.directory, marker([[INSTANCE, GRANT]]));
  work.profileId = PROFILE;
  f.grants.settleCreated(PROFILE, GRANT, true);
  assert.deepEqual(f.grants.accountProfile(work), { id: PROFILE, access: "granted" });

  const revokedCreation = "7f1c2d3e-4a5b-4c6d-8e7f-001122334455";
  f.grants.recordCreated(revokedCreation, OTHER_GRANT);
  f.grants.synchronize(225, [{ grantId: GRANT, status: "active", profileId: PROFILE }]);
  f.grants.settleCreated(revokedCreation, OTHER_GRANT, true);
  assert.deepEqual(f.grants.access().activeProfileIds, [PROFILE], "a grant the control plane stopped listing is not revived");
  f.grants.recordCreated(PROFILE, STALE_GRANT);
  f.grants.settleCreated(PROFILE, STALE_GRANT, false);
  f.grants.synchronize(225, [{ grantId: STALE_GRANT, status: "pending" }]);
  assert.deepEqual(f.grants.access().activeProfileIds, [], "a discarded creation's grant is never used again");
});

test("skill reconciliation skips an account this control plane may not use", posixOnly, (t) => {
  const f = fixture(t);
  const [work] = f.accounts as [RunnerProviderAccount];
  writeProviderProfileMarker(work.directory, marker([[OTHER_INSTANCE, OTHER_GRANT]]));
  f.grants.synchronize(225, []);
  const agents = [{ id: "claude", driver: "claude-code", command: "claude", args: [] }] as unknown as AgentDefinition[];
  const plan = skillReconciliationProviderAccountPlan(agents, f.accounts, true, (account) => f.grants.usable(account));
  assert.deepEqual(plan.accountScopes.map((scope) => scope.account.id), ["legacy"]);
  assert.deepEqual(plan.baseAgents, [], "the skipped account's provider still has no legacy base scope");
});

test("a substituted account HOME is unusable against the account's recorded id", posixOnly, (t) => {
  const f = fixture(t);
  const [work] = f.accounts as [RunnerProviderAccount];
  writeProviderProfileMarker(work.directory, marker([[INSTANCE, GRANT]]));
  work.profileId = PROFILE;
  f.grants.synchronize(225, [{ grantId: GRANT, profileId: PROFILE, status: "active" }]);
  assert.equal(f.grants.usable(work), true);
  renameSync(work.directory, `${work.directory}.original`);
  mkdirSync(work.directory);
  assert.equal(f.grants.usable(work), false);
  assert.deepEqual(f.grants.accountProfile(work), { id: PROFILE, access: "not_granted" });
});

test("removing a shared profile's account keeps the HOME and drops only this grant", posixOnly, async (t) => {
  const f = fixture(t);
  const [work] = f.accounts as [RunnerProviderAccount];
  const directory = work.directory;
  writeProviderProfileMarker(directory, marker([[INSTANCE, GRANT], [OTHER_INSTANCE, OTHER_GRANT]]));
  work.profileId = PROFILE;
  f.grants.synchronize(225, [{ grantId: GRANT, profileId: PROFILE, status: "active" }]);
  assert.deepEqual(await removeProviderAccountWithProfile(f.deps, "work"), { credentialsRetained: true });
  assert.deepEqual(f.removals, [{ accountId: "work", retainCredentialHome: true }]);
  const read = readProviderProfileMarker(directory);
  assert.deepEqual(read.state === "present" && read.marker.grants.map((grant) => grant.controlPlaneInstanceId), [OTHER_INSTANCE]);
  assert.deepEqual(f.grants.access().activeProfileIds, []);

  // A profile only this control plane holds is retained too, after grant retirement.
  const g = fixture(t);
  const [solo] = g.accounts as [RunnerProviderAccount];
  writeProviderProfileMarker(solo.directory, marker([[INSTANCE, GRANT]]));
  g.grants.synchronize(225, [{ grantId: GRANT, profileId: PROFILE, status: "active" }]);
  assert.deepEqual(await removeProviderAccountWithProfile(g.deps, "work"), { credentialsRetained: true });
  assert.deepEqual(g.removals, [{ accountId: "work", retired: true }], "the verdict is taken under the HOME's lease");
  assert.equal(g.registry.releaseAll(), true, "the decision released the lease it took");
});

test("a revocation that follows a completed adoption stops use without a reconnect", posixOnly, async (t) => {
  const f = fixture(t);
  const [work] = f.accounts as [RunnerProviderAccount];
  f.grants.synchronize(225, []);
  const adopted = await adoptProviderProfileCommand(f.deps, { type: "adopt_provider_profile", requestId: "r1", accountId: "work", grantId: GRANT });
  assert.equal(adopted.ok, true);
  const profileId = adopted.profileId!;
  assert.equal(f.grants.usable(work), true, "the runner uses the grant as soon as it wrote it");
  // The control plane found the pending grant revoked and names the profile the runner returned.
  const revoked = await revokeProviderProfileGrantCommand(f.deps, { type: "revoke_provider_profile_grant", requestId: "r2", profileId, grantId: GRANT });
  assert.deepEqual(revoked, { type: "revoke_provider_profile_grant_result", requestId: "r2", ok: true, markerUpdated: true });
  assert.equal(f.grants.usable(work), false);
  assert.throws(() => f.registry.acquireHome(work.directory, "claude", { expectedId: profileId, ...f.grants.access() }),
    (error: unknown) => error instanceof Error && /not granted to this control plane/u.test(error.message));
});

test("an adoption whose configuration write fails retains marker evidence without activating a new grant", posixOnly, async (t) => {
  const f = fixture(t);
  const [work] = f.accounts as [RunnerProviderAccount];
  f.grants.synchronize(225, []);
  // This synthetic write refusal does not inject a CP revocation. It must not invent a local
  // activation or dispatch a compensating worker revoke that could race a later CP snapshot.
  const deps: ProviderProfileCommandDeps = { ...f.deps, persistAccounts: () => { throw new Error("EROFS: read-only file system"); } };
  const result = await adoptProviderProfileCommand(deps, { type: "adopt_provider_profile", requestId: "r1", accountId: "work", grantId: GRANT });
  assert.deepEqual(result, { type: "adopt_provider_profile_result", requestId: "r1", ok: false, error: "The runner configuration could not be updated." });
  const read = readProviderProfileMarker(work.directory);
  assert.equal(read.state, "present", "the identity the adoption created stays");
  assert.deepEqual(read.state === "present" && read.marker.grants.map(grant => grant.grantId), [GRANT], "retain the marker until independently authorized retirement, without local activation");
  assert.equal(work.profileId, undefined, "and the account records no profile");
  assert.equal(f.grants.usable(work), false, "the grant was never usable, with no reconnect");
  assert.deepEqual(f.grants.access().activeProfileIds, []);
  assert.deepEqual(f.grants.accountProfile(work), { id: read.state === "present" ? read.marker.profileId : "", access: "not_granted" },
    "so the account report neither completes nor keeps the grant");
  assert.throws(() => f.registry.acquireHome(work.directory, "claude", f.grants.access()),
    (error: unknown) => error instanceof Error && /not granted to this control plane/u.test(error.message));
  assert.equal(f.published.length, 1);
});

test("registration cleanup is limited to the profiles its register frame reported", posixOnly, async (t) => {
  const f = fixture(t); // runner B
  const [work, legacy] = f.accounts as [RunnerProviderAccount, RunnerProviderAccount];
  const legacyProfile = "7f1c2d3e-4a5b-4c6d-8e7f-001122334455";
  writeProviderProfileMarker(legacy.directory, marker([[INSTANCE, STALE_GRANT]], legacyProfile));
  // B's register frame: the shared work HOME has no marker yet.
  assert.deepEqual(f.grants.reportedProfileIds(), [legacyProfile]);
  // Before the control plane answers, runner A on the same OS account adopts that HOME (a real marker
  // write under A's lease), and the control plane activates A's grant.
  const runnerA = new ProviderHomeLeaseRegistry("b".repeat(64), { pid: process.pid, hostname: "host-a", controlPlaneInstanceId: INSTANCE });
  t.after(() => { runnerA.releaseAll(); });
  const adoptedByA = runnerA.changeProfileMarkerWhileHeld(work.directory, "claude", (read) => adoptProviderProfileMarker(read,
    { provider: "claude", grant: { controlPlaneInstanceId: INSTANCE, grantId: GRANT, grantedAt: "2026-10-16T00:00:03.000Z" } })).marker.profileId;
  // B's `registered` list was built for B's snapshot: neither A's grant nor the revoked STALE_GRANT.
  const stale = f.grants.synchronize(225, []);
  assert.deepEqual(stale.map((entry) => [entry.account.id, entry.profileId, entry.grantId]), [["legacy", legacyProfile, STALE_GRANT]],
    "only the reported profile's omitted grant is stale");
  await revokeStaleProviderProfileGrants(f.deps, [...stale, { account: work, profileId: adoptedByA, grantId: GRANT }]);
  const shared = readProviderProfileMarker(work.directory);
  assert.deepEqual(shared.state === "present" && shared.marker.grants.map((grant) => [grant.controlPlaneInstanceId, grant.grantId]),
    [[INSTANCE, GRANT]], "A's active grant survives, even when named to the removal");
  const omitted = readProviderProfileMarker(legacy.directory);
  assert.deepEqual(omitted.state === "present" && omitted.marker.grants, [], "the reported profile's omitted grant is removed");
  // The next registration reports the shared profile, and its list carries A's grant.
  assert.deepEqual(f.grants.reportedProfileIds(), [adoptedByA, legacyProfile]);
  assert.deepEqual(f.grants.synchronize(225, [{ grantId: GRANT, profileId: adoptedByA, status: "active" }]), []);
  assert.equal(f.grants.usable(work), true);
});

test("a refused account removal still revokes this control plane's grant on the runner", posixOnly, async (t) => {
  const f = fixture(t);
  const [work] = f.accounts as [RunnerProviderAccount];
  writeProviderProfileMarker(work.directory, marker([[INSTANCE, GRANT]]));
  work.profileId = PROFILE;
  f.grants.synchronize(225, [{ grantId: GRANT, profileId: PROFILE, status: "active" }]);
  assert.equal(f.grants.usable(work), true);
  const supervisor = new ProviderLoginSupervisor({
    dataDir: f.root, configPath: f.configPath, accounts: f.accounts, agents: () => [], resolveEnv: () => ({}),
    acquireLease: () => true, releaseLease: () => true, onUpdate: () => {}, onAccountAdded: () => {},
    removalBlocker: () => "Agent 'claude' uses this account as its default in the runner configuration. Change that setting before removing the account.",
  });
  const deps: ProviderProfileCommandDeps = { ...f.deps, removeAccount: (accountId, options) => supervisor.removeAccount(accountId, options) };
  await assert.rejects(removeProviderAccountWithProfile(deps, "work"), /uses this account as its default/u, "the removal returns its error");
  assert.equal(f.accounts.includes(work), true, "the account stays configured");
  assert.equal(f.grants.usable(work), false, "but this control plane may no longer use its HOME");
  assert.deepEqual(f.grants.access().activeProfileIds, []);
  const read = readProviderProfileMarker(work.directory);
  assert.deepEqual(read.state === "present" && read.marker.grants, [], "and the marker no longer grants it");
  assert.throws(() => f.registry.acquireHome(work.directory, "claude", { expectedId: PROFILE, ...f.grants.access() }),
    (error: unknown) => error instanceof Error && /not granted to this control plane/u.test(error.message));
});

test("account removal retains unshared HOMEs and a grant recorded by another control plane while settlement waits", posixOnly, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-profile-retire-"));
  const managed = join(root, "provider-accounts");
  mkdirSync(managed);
  const accounts: RunnerProviderAccount[] = [
    { id: "work", label: "Work", provider: "claude", directory: join(managed, "work") },
    { id: "solo", label: "Solo", provider: "claude", directory: join(managed, "solo") },
  ];
  for (const account of accounts) mkdirSync(account.directory);
  const configPath = join(root, "runner.json");
  writeFileSync(configPath, `${JSON.stringify({ runnerId: "runner-1", providerAccounts: accounts })}\n`, { mode: 0o600 });
  const grants = new ProviderProfileGrants({ controlPlaneInstanceId: INSTANCE, accounts: () => accounts });
  const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { controlPlaneInstanceId: INSTANCE,
    profileAccess: () => grants.access(), expectedProfileIdForHome: (home) => grants.expectedProfileIdForHome(home) });
  // Another runner on the same OS account, connected to another control plane.
  const other = new AsyncProviderHomeLeaseRegistry("b".repeat(64), { controlPlaneInstanceId: OTHER_INSTANCE });
  t.after(async () => { await registry.close(); await other.close(); rmSync(root, { recursive: true, force: true }); });

  grants.synchronize(225, []);
  const work = (await registry.adoptProfile(accounts[0]!.directory, "claude", GRANT)).profileId;
  const solo = (await registry.adoptProfile(accounts[1]!.directory, "claude", STALE_GRANT)).profileId;
  accounts[0]!.profileId = work; accounts[1]!.profileId = solo;
  writeFileSync(configPath, `${JSON.stringify({ runnerId: "runner-1", providerAccounts: accounts })}\n`, { mode: 0o600 });
  grants.synchronize(225, [{ grantId: GRANT, profileId: work, status: "active" }, { grantId: STALE_GRANT, profileId: solo, status: "active" }]);

  let releaseRetirement!: () => void;
  let retirementWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => { retirementWaiting = resolve; });
  let hold = false;
  const supervisor = new ProviderLoginSupervisor({
    dataDir: root, configPath, accounts, agents: () => [], resolveEnv: () => ({}),
    acquireLease: (directory, provider) => registry.acquireHome(directory, provider),
    releaseLease: (directory) => registry.releaseHome(directory),
    onUpdate: () => {}, onAccountAdded: () => {},
    serializeHomeRetirement: async (work) => {
      if (hold) await new Promise<void>((resolve) => { releaseRetirement = resolve; retirementWaiting(); });
      return work();
    },
  });
  const deps: ProviderProfileCommandDeps = {
    controlPlaneInstanceId: INSTANCE, accounts: () => accounts, grants,
    adopt: (home, provider, grantId) => registry.adoptProfile(home, provider, grantId),
    revoke: (home, provider, profileId, grantId) => registry.revokeProfileGrant(home, provider, profileId, grantId),
    retire: (home, provider) => registry.retireProfileHome(home, provider),
    captureAccountsPreimage: () => captureProviderAccountsConfigPreimage(configPath, accounts),
    persistAccounts: (next, preimage) => writeProviderAccountsConfig(configPath, next, preimage),
    removeAccount: (accountId, options) => supervisor.removeAccount(accountId, options),
    publish: () => {}, log: () => {},
  };

  // Even an unshared marker cannot prove physical retirement authority.
  assert.deepEqual(await removeProviderAccountWithProfile(deps, "solo"), { credentialsRetained: true });
  assert.equal(existsSync(join(managed, "solo")), true);

  // Removal reads the marker (only this grant), then waits; meanwhile another control plane adopts.
  hold = true;
  const removal = removeProviderAccountWithProfile(deps, "work");
  await waiting;
  assert.deepEqual(await other.adoptProfile(join(managed, "work"), "claude", OTHER_GRANT), { profileId: work });
  releaseRetirement();
  assert.deepEqual(await removal, { credentialsRetained: true });
  const read = readProviderProfileMarker(join(managed, "work"));
  assert.equal(read.state, "present", "the HOME survives");
  assert.deepEqual(read.state === "present" && read.marker.grants.map((grant) => [grant.controlPlaneInstanceId, grant.grantId]),
    [[OTHER_INSTANCE, OTHER_GRANT]], "with the other control plane's grant, and without this one");
  assert.deepEqual(grants.access().activeProfileIds, []);
});

test("adoption tickets are bounded, one-shot capabilities and complete CP snapshots fence ABA", () => {
  const grants = new ProviderProfileGrants({ controlPlaneInstanceId: INSTANCE, accounts: () => [] });
  grants.synchronize(225, []);
  const tickets = Array.from({ length: 32 }, () => grants.captureAdoptionTicket(GRANT)!);
  assert.equal(tickets.every(Boolean), true);
  assert.equal(grants.captureAdoptionTicket(GRANT), undefined);
  grants.releaseAdoptionTicket(tickets.pop()!);
  const fresh = grants.captureAdoptionTicket(GRANT)!;
  assert.equal(grants.activateAdoption(PROFILE, fresh), true);
  assert.equal(grants.activateAdoption(PROFILE, fresh), false);
  assert.equal(grants.activateAdoption(PROFILE, { ...tickets[0]! }), false, "a cloned ticket is not an admitted capability");
  const stale = tickets[0]!;
  grants.synchronize(225, []);
  grants.synchronize(225, [{ grantId: GRANT, profileId: PROFILE, status: "pending" }]);
  assert.equal(grants.adoptionTicketCurrent(stale), false);
  assert.equal(grants.activateAdoption(PROFILE, stale), false);
  for (const ticket of tickets) grants.releaseAdoptionTicket(ticket);
  const beforeUnsupported = grants.captureAdoptionTicket(GRANT)!;
  grants.synchronize(223, undefined); grants.synchronize(225, []);
  assert.equal(grants.activateAdoption(PROFILE, beforeUnsupported), false);
  grants.releaseAdoptionTicket(beforeUnsupported);
  const malformed = grants.captureAdoptionTicket(GRANT)!;
  grants.synchronize(225, [{ bad: true }]);
  assert.equal(grants.adoptionTicketCurrent(malformed), true, "malformed is not an authoritative replacement");
  grants.releaseAdoptionTicket(malformed);
});

test("initial and retry adoption never activate across revocation, snapshot ABA or unrelated fences", posixOnly, async t => {
  for (const retry of [false, true]) {
    for (const event of ["revoke", "snapshot-aba", "unrelated-revoke", "same-snapshot", "support-transition"] as const) {
      const f = fixture(t); f.grants.synchronize(225, []);
      const msg = { type: "adopt_provider_profile" as const, requestId: "first", accountId: "work", grantId: GRANT };
      if (retry) assert.equal((await adoptProviderProfileCommand(f.deps, msg)).ok, true);
      let writes = 0, removals = 0, expected: unknown;
      const deps: ProviderProfileCommandDeps = { ...f.deps,
        adopt: async (...args) => {
          const result = await f.deps.adopt(...args);
          if (event === "revoke") f.grants.recordRevoked(result.profileId, GRANT);
          if (event === "unrelated-revoke") f.grants.recordRevoked(undefined, OTHER_GRANT);
          if (event === "snapshot-aba" || event === "same-snapshot") {
            if (event === "snapshot-aba") f.grants.synchronize(225, []);
            f.grants.synchronize(225, [{ grantId: GRANT, profileId: result.profileId, status: "pending" }]);
          }
          if (event === "support-transition") { f.grants.synchronize(223, undefined); f.grants.synchronize(225, []); }
          expected = f.grants.accountProfile(f.accounts[0]!);
          return result;
        },
        persistAccounts: () => { writes++; },
        revoke: async () => { removals++; return false; },
      };
      const result = await adoptProviderProfileCommand(deps, { ...msg, requestId: "pending" });
      assert.equal(result.ok, false);
      assert.equal(writes, 0); assert.equal(removals, 0, "a stale command cannot delete a current grant");
      assert.deepEqual(f.grants.accountProfile(f.accounts[0]!), expected, "old completion cannot activate or remove the newer CP state");
      const marker = readProviderProfileMarker(f.accounts[0]!.directory);
      assert.deepEqual(marker.state === "present" && marker.marker.grants.map(g => g.grantId), [GRANT]);
    }
  }
});

test("initial and retry activation recheck the ticket after synchronous config publication", posixOnly, async t => {
  for (const retry of [false, true]) {
    const f = fixture(t); f.grants.synchronize(225, []);
    const msg = { type: "adopt_provider_profile" as const, requestId: "first", accountId: "work", grantId: GRANT };
    if (retry) assert.equal((await adoptProviderProfileCommand(f.deps, msg)).ok, true);
    let profile!: string;
    const deps = { ...f.deps, adopt: async (...args: Parameters<ProviderProfileCommandDeps["adopt"]>) => {
      const value = await f.deps.adopt(...args); profile = value.profileId; return value;
    }, persistAccounts: (accounts: RunnerProviderAccount[], preimage: Parameters<ProviderProfileCommandDeps["persistAccounts"]>[1]) => {
      f.deps.persistAccounts(accounts, preimage);
      f.grants.recordRevoked(profile, GRANT);
      f.grants.synchronize(225, [{ grantId: GRANT, profileId: profile, status: "pending" }]);
    } };
    assert.equal((await adoptProviderProfileCommand(deps, { ...msg, requestId: "pending" })).ok, false);
    assert.deepEqual(f.grants.accountProfile(f.accounts[0]!), { id: profile, access: "pending" });
  }
});

test("a refused recorded retry retains its exact current grant even when marker observation is unverifiable", posixOnly, async t => {
  for (const unreadable of [false, true]) {
    const f = fixture(t); f.grants.synchronize(225, []);
    const msg = { type: "adopt_provider_profile" as const, requestId: "first", accountId: "work", grantId: GRANT };
    const first = await adoptProviderProfileCommand(f.deps, msg); assert.equal(first.ok, true);
    const bytes = readFileSync(f.configPath); let removals = 0;
    const deps: ProviderProfileCommandDeps = { ...f.deps,
      ...(unreadable ? { readMarker: () => ({ state: "unverifiable" as const, cause: "marker" as const }) } : {}),
      persistAccounts: () => { throw new AccountConfigPublicationError("not_published", "SOURCE_BUSY"); },
      revoke: async () => { removals++; return false; },
    };
    assert.equal((await adoptProviderProfileCommand(deps, { ...msg, requestId: "retry" })).ok, false);
    assert.equal(removals, 0); assert.equal(f.grants.hasKnownGrant(first.profileId!, GRANT), true);
    assert.equal(f.grants.usable(f.accounts[0]!), true); assert.deepEqual(readFileSync(f.configPath), bytes);
  }
});

test("a refused initial adoption never dispatches asynchronous compensating revocation", posixOnly, async t => {
  const f = fixture(t); f.grants.synchronize(225, []);
  let removals = 0;
  const deps: ProviderProfileCommandDeps = { ...f.deps,
    persistAccounts: () => { throw new AccountConfigPublicationError("not_published", "SOURCE_BUSY"); },
    revoke: async () => { removals++; return false; },
  };
  const result = await adoptProviderProfileCommand(deps, { type: "adopt_provider_profile", requestId: "refused", accountId: "work", grantId: GRANT });
  assert.equal(result.ok, false); assert.equal(removals, 0);
  assert.deepEqual(f.grants.access().activeProfileIds, []);
  const marker = readProviderProfileMarker(f.accounts[0]!.directory);
  assert.deepEqual(marker.state === "present" && marker.marker.grants.map(g => g.grantId), [GRANT]);
});
