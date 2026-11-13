import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { isManagedProviderProfileHome, managedProviderProfileIdFor, managedProviderProfileRoot } from "./provider-profile-home.js";
import { removeProviderAccountWithProfile, type ProviderProfileCommandDeps } from "./provider-profile-commands.js";
import { ProviderProfileGrants } from "./provider-profile-grants.js";
import { writeProviderProfileMarker } from "./provider-profile.js";

const id = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455", other = "7f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const instance = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", grant = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-profile-alias-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "real-home"), alias = join(base, "alias-home");
  mkdirSync(home, { mode: 0o700 }); symlinkSync(home, alias);
  // Persisted spelling from before the upgrade; do not silently migrate this account's path.
  const directory = join(alias, ".agent-manager", "profiles", id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { alias, directory, account: { id: "old", label: "Old", provider: "claude" as const, directory, profileId: id } };
}
test("an account recorded under the trusted OS-home alias keeps its managed identity", { skip: process.platform === "win32" }, t => {
  const f = fixture(t), root = managedProviderProfileRoot(f.alias);
  assert.equal(managedProviderProfileIdFor(root, f.account), id);
  assert.equal(isManagedProviderProfileHome(root, f.directory, id), true);
});
test("removing an aliased managed account preserves a substituted profile's marker and grant", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t);
  writeProviderProfileMarker(f.directory, { version: 1, kind: "wollipog-provider-profile", profileId: other, provider: "claude",
    createdAt: "2026-10-30T00:00:00.000Z", grants: [{ controlPlaneInstanceId: instance, grantId: grant, grantedAt: "2026-10-30T00:00:00.000Z" }] });
  const markerPath = join(f.directory, ".agent-manager", "profile-v1.json"), before = readFileSync(markerPath);
  const sentinel = join(f.directory, "sentinel"); writeFileSync(sentinel, "preserved");
  let revoked = 0, retired = 0;
  const deps: ProviderProfileCommandDeps = {
    controlPlaneInstanceId: instance, profileRoot: managedProviderProfileRoot(f.alias), accounts: () => [f.account],
    grants: new ProviderProfileGrants({ controlPlaneInstanceId: instance, accounts: () => [f.account] }),
    adopt: async () => { throw Error("unexpected adoption"); },
    revoke: async () => { revoked++; return true; }, retire: async () => { retired++; return true; },
    captureAccountsPreimage: () => { throw Error("unexpected config access"); }, persistAccounts: () => { throw Error("unexpected config write"); },
    removeAccount: async (_accountId, options) => {
      assert.equal(options.retainCredentialHome, true);
      assert.equal(options.retireCredentialHome, undefined);
      return { credentialsRetained: true };
    }, publish: () => {}, log: () => {},
  };
  assert.deepEqual(await removeProviderAccountWithProfile(deps, f.account.id), { credentialsRetained: true });
  assert.equal(revoked, 0); assert.equal(retired, 0);
  assert.deepEqual(readFileSync(markerPath), before);
  assert.equal(readFileSync(sentinel, "utf8"), "preserved");
});
