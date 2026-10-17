import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import type { RunnerProviderAccount } from "./config.js";
import { validateProviderAccounts, writeProviderAccountsConfig } from "./config.js";
import { AsyncProviderHomeLeaseRegistry } from "./provider-home-lease-async.js";
import { ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";
import { ProviderLoginSupervisor } from "./provider-login.js";
import { removeProviderAccountWithProfile, type ProviderProfileCommandDeps } from "./provider-profile-commands.js";
import { ProviderProfileGrants } from "./provider-profile-grants.js";
import { createManagedProviderProfileHome, isManagedProviderProfileHome, managedProviderProfileRoot } from "./provider-profile-home.js";
import { PROVIDER_PROFILE_DIRECTORY, PROVIDER_PROFILE_MARKER, readProviderProfileMarker } from "./provider-profile.js";

const posixOnly = { skip: process.platform === "win32" };
const INSTANCE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const OTHER_INSTANCE = "1a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const GRANT = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const OTHER_GRANT = "3a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const SECOND_GRANT = "4a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const IDS = [
  "6f1c2d3e-4a5b-4c6d-8e7f-001122334455", "7f1c2d3e-4a5b-4c6d-8e7f-001122334455", "8f1c2d3e-4a5b-4c6d-8e7f-001122334455",
  "9f1c2d3e-4a5b-4c6d-8e7f-001122334455", "af1c2d3e-4a5b-4c6d-8e7f-001122334455",
];

function sshAccount(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-managed-profile-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  const configPath = join(root, "runner.config.json");
  writeFileSync(configPath, `${JSON.stringify({ runnerId: "runner-1" })}\n`);
  return { root, home, profiles: managedProviderProfileRoot(home), configPath };
}

/** One runner process on the SSH account: its own owner hash and data directory, one control plane. */
function runnerOn(t: TestContext, ssh: ReturnType<typeof sshAccount>, input: {
  ownerHash: string; instance: string; accounts: RunnerProviderAccount[]; dataDir: string;
}) {
  const grants = new ProviderProfileGrants({ controlPlaneInstanceId: input.instance, accounts: () => input.accounts });
  const leases = new AsyncProviderHomeLeaseRegistry(input.ownerHash, { controlPlaneInstanceId: input.instance,
    profileAccess: () => grants.access(), expectedProfileIdForHome: (home) => grants.expectedProfileIdForHome(home) });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await leases.close(); } };
  t.after(close);
  const supervisor = new ProviderLoginSupervisor({
    dataDir: input.dataDir, configPath: ssh.configPath, accounts: input.accounts, agents: () => [], resolveEnv: () => ({}),
    acquireLease: (directory, provider) => leases.acquireHome(directory, provider),
    releaseLease: (directory) => leases.releaseHome(directory),
    onUpdate: () => {}, onAccountAdded: () => {},
    profiles: { root: ssh.profiles, create: async () => { throw new Error("not used"); }, settle: async () => {} },
  });
  const deps: ProviderProfileCommandDeps = {
    controlPlaneInstanceId: input.instance, accounts: () => input.accounts, grants,
    adopt: (home, provider, grantId) => leases.adoptProfile(home, provider, grantId),
    revoke: (home, provider, profileId, grantId) => leases.revokeProfileGrant(home, provider, profileId, grantId),
    retire: (home, provider) => leases.retireProfileHome(home, provider),
    persistAccounts: (next) => writeProviderAccountsConfig(ssh.configPath, next),
    removeAccount: (accountId, options) => supervisor.removeAccount(accountId, options),
    publish: () => {}, log: () => {},
  };
  return { grants, leases, supervisor, deps, close };
}

/** A managed profile HOME created the way Add Account creates one: the directory, then the first
 * marker under the HOME's lease. */
async function managedHome(ssh: ReturnType<typeof sshAccount>, leases: AsyncProviderHomeLeaseRegistry, profileId: string, grantId = GRANT) {
  const home = createManagedProviderProfileHome(ssh.profiles, profileId);
  await leases.createProfile(home, "claude", profileId, grantId);
  writeFileSync(join(home, ".credentials.json"), "{}");
  return home;
}

test("a managed profile HOME's first marker is created under the lease and never replaces an identity", posixOnly, async (t) => {
  const ssh = sshAccount(t);
  const runner = runnerOn(t, ssh, { ownerHash: "a".repeat(64), instance: INSTANCE, accounts: [], dataDir: join(ssh.root, "data") });
  const home = await managedHome(ssh, runner.leases, IDS[0]!);
  const read = readProviderProfileMarker(home);
  assert.equal(read.state === "present" && read.marker.profileId, IDS[0]);
  await assert.rejects(runner.leases.createProfile(home, "claude", IDS[1]!, OTHER_GRANT),
    (error: unknown) => error instanceof ProviderHomeLeaseError && error.code === "profile_changed");
  assert.deepEqual(readProviderProfileMarker(home), read, "the existing identity is untouched");
  assert.throws(() => createManagedProviderProfileHome(ssh.profiles, IDS[0]!), /already exists/u);
});

test("removing a managed profile account deletes its HOME only when no other control plane is granted, from any runner", posixOnly, async (t) => {
  const ssh = sshAccount(t);
  const accounts: RunnerProviderAccount[] = [];
  const creator = runnerOn(t, ssh, { ownerHash: "a".repeat(64), instance: INSTANCE, accounts, dataDir: join(ssh.root, "data") });
  const solo = await managedHome(ssh, creator.leases, IDS[0]!);
  const shared = await managedHome(ssh, creator.leases, IDS[1]!, SECOND_GRANT);
  accounts.push({ id: "solo", label: "Solo", provider: "claude", directory: solo, profileId: IDS[0] },
    { id: "shared", label: "Shared", provider: "claude", directory: shared, profileId: IDS[1] });
  writeProviderAccountsConfig(ssh.configPath, accounts);
  await creator.close();
  // Another control plane on the same SSH account was granted the second profile.
  const other = runnerOn(t, ssh, { ownerHash: "c".repeat(64), instance: OTHER_INSTANCE, accounts: [], dataDir: join(ssh.root, "other") });
  await other.leases.adoptProfile(shared, "claude", OTHER_GRANT);
  await other.close();

  // A replacement runner (new runner id: new owner hash and data directory) removes the accounts.
  const replacement = runnerOn(t, ssh, { ownerHash: "b".repeat(64), instance: INSTANCE, accounts,
    dataDir: join(ssh.root, "data", "runner-instances", "b".repeat(64)) });
  replacement.grants.reportedProfileIds();
  replacement.grants.synchronize(PROTOCOL_VERSION, [
    { grantId: GRANT, status: "active", profileId: IDS[0]! }, { grantId: SECOND_GRANT, status: "active", profileId: IDS[1]! },
  ]);
  assert.deepEqual(await removeProviderAccountWithProfile(replacement.deps, "solo"), { credentialsRetained: false });
  assert.equal(existsSync(solo), false, "the HOME is outside the data directory, so the replacement may retire it");
  assert.deepEqual(await removeProviderAccountWithProfile(replacement.deps, "shared"), { credentialsRetained: true });
  const kept = readProviderProfileMarker(shared);
  assert.deepEqual(kept.state === "present" && kept.marker.grants.map((grant) => grant.controlPlaneInstanceId), [OTHER_INSTANCE],
    "the other control plane keeps its HOME and grant; this control plane's grant is gone");
  assert.deepEqual(readdirSync(ssh.profiles), [IDS[1]]);
});

test("nothing outside the exact managed profile HOME is ever deleted", posixOnly, async (t) => {
  const ssh = sshAccount(t);
  const accounts: RunnerProviderAccount[] = [];
  const runner = runnerOn(t, ssh, { ownerHash: "a".repeat(64), instance: INSTANCE, accounts, dataDir: join(ssh.root, "data") });
  runner.grants.synchronize(PROTOCOL_VERSION, []);
  // An operator HOME that records a profile id but lives outside the managed roots.
  const operator = join(ssh.root, "operator-claude");
  mkdirSync(operator);
  writeFileSync(join(operator, ".credentials.json"), "{}");
  // A managed-root directory whose name is not the account's profile id.
  const misnamed = await managedHome(ssh, runner.leases, IDS[1]!);
  // A profile id under the root that is a link to a directory elsewhere.
  const victim = join(ssh.root, "victim");
  mkdirSync(victim);
  writeFileSync(join(victim, ".credentials.json"), "{}");
  const linked = join(ssh.profiles, IDS[3]!);
  symlinkSync(victim, linked);
  accounts.push(
    { id: "operator", label: "Operator", provider: "claude", directory: operator, profileId: IDS[0] },
    { id: "misnamed", label: "Misnamed", provider: "claude", directory: misnamed, profileId: IDS[2] },
    { id: "linked", label: "Linked", provider: "claude", directory: linked, profileId: IDS[3] },
  );
  writeProviderAccountsConfig(ssh.configPath, accounts);
  for (const id of ["operator", "misnamed", "linked"]) {
    assert.deepEqual(await removeProviderAccountWithProfile(runner.deps, id), { credentialsRetained: true }, id);
  }
  assert.equal(existsSync(join(operator, ".credentials.json")), true);
  assert.equal(existsSync(join(misnamed, ".credentials.json")), true);
  assert.equal(existsSync(join(victim, ".credentials.json")), true);
  assert.equal(existsSync(join(victim, PROVIDER_PROFILE_DIRECTORY)), false, "no lease or marker is written through the link");

  // A `profiles` root replaced by a link is never trusted either, even for an exact id.
  const real = await managedHome(ssh, runner.leases, IDS[4]!);
  const renamedRoot = `${ssh.profiles}-real`;
  renameSync(ssh.profiles, renamedRoot);
  symlinkSync(renamedRoot, ssh.profiles);
  assert.equal(isManagedProviderProfileHome(ssh.profiles, real, IDS[4]), false);
  accounts.push({ id: "real", label: "Real", provider: "claude", directory: real, profileId: IDS[4] });
  writeProviderAccountsConfig(ssh.configPath, accounts);
  assert.deepEqual(await runner.supervisor.removeAccount("real"), { credentialsRetained: true });
  assert.equal(existsSync(join(renamedRoot, IDS[4]!, ".credentials.json")), true);
});

test("a replacement runner reuses the profile and its grant; another control plane is refused", posixOnly, async (t) => {
  const ssh = sshAccount(t);
  const firstAccounts: RunnerProviderAccount[] = [];
  const first = runnerOn(t, ssh, { ownerHash: "a".repeat(64), instance: INSTANCE, accounts: firstAccounts,
    dataDir: join(ssh.root, "data", "runner-instances", "a".repeat(64)) });
  first.grants.synchronize(PROTOCOL_VERSION, []);
  const home = await managedHome(ssh, first.leases, IDS[0]!);
  firstAccounts.push({ id: "work", label: "Work", provider: "claude", directory: home, profileId: IDS[0] });
  writeProviderAccountsConfig(ssh.configPath, firstAccounts);
  // The control plane completed the grant from the account report; the first runner uses the HOME.
  const activeGrants = [{ grantId: GRANT, status: "active" as const, profileId: IDS[0]! }];
  first.grants.reportedProfileIds();
  assert.deepEqual(first.grants.synchronize(PROTOCOL_VERSION, activeGrants), []);
  assert.equal(await first.leases.acquireHome(home, "claude"), true);
  assert.equal(await first.leases.releaseHome(home), true);
  await first.close(); // the old runner's orderly release
  const markerPath = join(home, PROVIDER_PROFILE_DIRECTORY, PROVIDER_PROFILE_MARKER);
  const markerBefore = readFileSync(markerPath);
  const filesBefore = readdirSync(home).sort();

  // The replacement: a new runner id (owner hash and data directory), the same control-plane
  // instance and the same runner configuration. The control plane lists the same grant to it,
  // because grants are by profile, instance and scope, not by runner.
  const accounts = validateProviderAccounts(JSON.parse(readFileSync(ssh.configPath, "utf8")).providerAccounts);
  const replacement = runnerOn(t, ssh, { ownerHash: "b".repeat(64), instance: INSTANCE, accounts,
    dataDir: join(ssh.root, "data", "runner-instances", "b".repeat(64)) });
  assert.deepEqual(replacement.grants.reportedProfileIds(), [IDS[0]]);
  assert.deepEqual(replacement.grants.synchronize(PROTOCOL_VERSION, activeGrants), [], "nothing is stale");
  assert.deepEqual(replacement.grants.accountProfile(accounts[0]!), { id: IDS[0], access: "granted" });
  assert.equal(replacement.grants.bindingProfileId({ id: "work", provider: "claude", credentialHome: home }), IDS[0],
    "new sessions bind the same profile");
  assert.equal(await replacement.leases.acquireHome(home, "claude"), true, "the HOME is usable without filesystem changes");
  assert.equal(await replacement.leases.releaseHome(home), true);
  assert.deepEqual(readFileSync(markerPath), markerBefore, "the identity and grant are unchanged");
  assert.deepEqual(readdirSync(home).sort(), filesBefore);
  await replacement.close();

  // Another control plane on the same SSH account was never granted this profile.
  const foreign = runnerOn(t, ssh, { ownerHash: "c".repeat(64), instance: OTHER_INSTANCE, accounts,
    dataDir: join(ssh.root, "data", "runner-instances", "c".repeat(64)) });
  foreign.grants.reportedProfileIds();
  foreign.grants.synchronize(PROTOCOL_VERSION, []);
  assert.equal(foreign.grants.usable(accounts[0]!), false);
  assert.deepEqual(foreign.grants.accountProfile(accounts[0]!), { id: IDS[0], access: "not_granted" });
  await assert.rejects(foreign.leases.acquireHome(home, "claude"),
    (error: unknown) => error instanceof ProviderHomeLeaseError && error.code === "profile_not_granted");
  // Even a forged active grant list does not help: the marker lists only the granted instance.
  foreign.grants.synchronize(PROTOCOL_VERSION, activeGrants);
  await assert.rejects(foreign.leases.acquireHome(home, "claude"),
    (error: unknown) => error instanceof ProviderHomeLeaseError && error.code === "profile_not_granted");
  assert.deepEqual(readFileSync(markerPath), markerBefore);
});
