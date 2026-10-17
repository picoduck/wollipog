import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import type { RunnerProviderAccount } from "./config.js";
import { writeProviderAccountsConfig } from "./config.js";
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
  writeFileSync(configPath, `${JSON.stringify({ runnerId: "runner-1", providerAccounts: accounts })}\n`);
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
    persistAccounts: (next) => writeProviderAccountsConfig(configPath, next),
    removeAccount: async (accountId, options) => {
      const account = accounts.find((candidate) => candidate.id === accountId)!;
      removals.push({ accountId, ...(options.retainCredentialHome ? { retainCredentialHome: true } : {}),
        ...(options.retireCredentialHome ? { retired: true } : {}) });
      accounts.splice(accounts.indexOf(account), 1);
      // The HOME is left in place; only the supervisor's verdict is modelled here.
      const deletable = options.retainCredentialHome !== true && (await options.retireCredentialHome?.(account) ?? true) &&
        options.retainCredentialHomeIf?.(account) !== true;
      return { credentialsRetained: !deletable };
    },
    publish: () => { published.push(Date.now()); },
    log: () => {},
  };
  return { root, accounts, configPath, grants, deps, published, removals, registry };
}

function definition(account: RunnerProviderAccount) {
  return providerAccountDefinition(account);
}

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

  // A profile only this control plane holds keeps today's deletion decision.
  const g = fixture(t);
  const [solo] = g.accounts as [RunnerProviderAccount];
  writeProviderProfileMarker(solo.directory, marker([[INSTANCE, GRANT]]));
  g.grants.synchronize(225, [{ grantId: GRANT, profileId: PROFILE, status: "active" }]);
  assert.deepEqual(await removeProviderAccountWithProfile(g.deps, "work"), { credentialsRetained: false });
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

test("a grant another control plane records while removal waits keeps the HOME, decided under the real lease", posixOnly, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-profile-retire-"));
  const managed = join(root, "provider-accounts");
  mkdirSync(managed);
  const accounts: RunnerProviderAccount[] = [
    { id: "work", label: "Work", provider: "claude", directory: join(managed, "work") },
    { id: "solo", label: "Solo", provider: "claude", directory: join(managed, "solo") },
  ];
  for (const account of accounts) mkdirSync(account.directory);
  const configPath = join(root, "runner.json");
  writeFileSync(configPath, `${JSON.stringify({ runnerId: "runner-1", providerAccounts: accounts })}\n`);
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
    persistAccounts: (next) => writeProviderAccountsConfig(configPath, next),
    removeAccount: (accountId, options) => supervisor.removeAccount(accountId, options),
    publish: () => {}, log: () => {},
  };

  // A HOME only this control plane was granted is still deleted.
  assert.deepEqual(await removeProviderAccountWithProfile(deps, "solo"), { credentialsRetained: false });
  assert.equal(existsSync(join(managed, "solo")), false);

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
