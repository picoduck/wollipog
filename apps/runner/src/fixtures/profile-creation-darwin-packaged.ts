import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSea } from "node:sea";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { ProviderLoginSupervisor } from "../provider-login.js";
import { AsyncProviderHomeLeaseRegistry } from "../provider-home-lease-async.js";
import { ProviderProfileGrants } from "../provider-profile-grants.js";
import { createProviderProfileLoginSettlement } from "../provider-profile-login-settlement.js";
import { managedProviderProfileRoot } from "../provider-profile-home.js";
import { readProviderProfileMarker } from "../provider-profile.js";
import type { RunnerProviderAccount } from "../config.js";

/** Runs unchanged production modules inside the actual SEA process. Creation extracts the
 * embedded native asset; the facade loads the embedded worker asset for subsequent admission.
 * The only provider spawn is an injected throwing function; no provider executable is run. */
export async function verifyPackagedDarwinProfileCreation(root: string, setter: string): Promise<void> {
  assert.equal(process.platform, "darwin"); assert.equal(isSea(), true);
  const instance = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3", grant = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
  for (const kind of ["absent", "empty", "deny", "deny_inherit"]) {
    const home = join(root, kind), data = join(root, `${kind}-data`);
    mkdirSync(home, { mode: 0o700 }); mkdirSync(data, { mode: 0o700 });
    if (kind !== "absent") execFileSync(setter, [home, kind]);
    writeFileSync(join(home, "sentinel"), "preserved");
    const accounts: RunnerProviderAccount[] = [];
    const grants = new ProviderProfileGrants({ controlPlaneInstanceId: instance, accounts: () => accounts });
    grants.synchronize(PROTOCOL_VERSION, []);
    const registry = new AsyncProviderHomeLeaseRegistry("a".repeat(64), {
      helperDataDir: data, controlPlaneInstanceId: instance, profileAccess: () => grants.access(),
      expectedProfileIdForHome: directory => grants.expectedProfileIdForHome(directory),
    });
    const profileRoot = managedProviderProfileRoot(home), configPath = join(data, "config.json");
    writeFileSync(configPath, JSON.stringify({ runnerId: "fixture", providerAccounts: [] }), { mode: 0o600 });
    let spawned = 0, acquired = 0;
    const supervisor = new ProviderLoginSupervisor({
      dataDir: data, configPath, accounts,
      agents: () => [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code", context: { kind: "native" } }],
      resolveEnv: () => ({}),
      acquireLease: async (directory, provider) => { const result = await registry.acquireHome(directory, provider); acquired++; return result; },
      releaseLease: directory => registry.releaseHome(directory), onUpdate: () => {}, onAccountAdded: () => {},
      spawn: () => { spawned++; throw Error("synthetic provider boundary"); },
      profiles: {
        root: profileRoot,
        create: async (directory, provider, profileId, grantId) => { await registry.createProfile(directory, provider, profileId, grantId); grants.recordCreated(profileId, grantId); },
        settle: createProviderProfileLoginSettlement({
          settleCreated: (profileId, grantId, recorded) => grants.settleCreated(profileId, grantId, recorded),
          revoke: (directory, provider, profileId, grantId) => registry.revokeProfileGrant(directory, provider, profileId, grantId),
          log: () => {},
        }),
      },
      imports: {
        defaultCodexHome: () => ({ home, layout: "user_home" }),
        copyCodex: async input => {
          await registry.importCodexCredential(input.source.home, input.source.layout, input.root, input.profileId, input.grantId);
          grants.recordCreated(input.profileId, input.grantId);
        },
      },
    });
    try {
      await assert.rejects(supervisor.startAccount({ provider: "claude", label: "Fixture", profileGrantId: grant }), /sign-in command could not be started/);
      assert.equal(spawned, 1); assert.equal(acquired, 1, "creation and the real marker/lease admission must succeed before the fake spawn boundary");
      const first = readdirSync(profileRoot); assert.equal(first.length, 1);
      const failedMarker = readProviderProfileMarker(join(profileRoot, first[0]!));
      assert.equal(failedMarker.state, "present");
      assert.deepEqual(failedMarker.state === "present" && failedMarker.marker.grants, [], "real failed-login settlement retains identity and retires its grant");
      const source = join(home, ".codex"); mkdirSync(source, { mode: 0o700 });
      const auth = JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-fake-darwin-fixture" });
      writeFileSync(join(source, "auth.json"), auth, { mode: 0o600 });
      const imported = await supervisor.importAccount({ provider: "codex", label: "Imported", source: { kind: "default_home" }, profileGrantId: grant });
      const importedHome = join(profileRoot, imported.profileId);
      // Import reconstructs the canonical key-only record; it does not copy source formatting.
      assert.deepEqual(JSON.parse(readFileSync(join(importedHome, "auth.json"), "utf8")),
        { auth_mode: "apikey", OPENAI_API_KEY: "sk-fake-darwin-fixture" }, "target contains exactly the allowed fields");
      assert.deepEqual(readFileSync(join(source, "auth.json")), Buffer.from(auth), "synthetic source bytes are unchanged");
      assert.ok(accounts.some(account => account.id === imported.accountId && account.profileId === imported.profileId));
      assert.equal(await registry.acquireHome(importedHome, "codex"), true, "post-import marker/grant admission succeeds");
      assert.equal(await registry.releaseHome(importedHome), true);
      assert.equal(spawned, 1, "import never invokes a provider");
      assert.deepEqual(readFileSync(join(home, "sentinel")), Buffer.from("preserved"), "existing payload bytes are unchanged");
      assert.ok(existsSync(join(importedHome, ".agent-manager", "profile-v1.json")));
    } finally { await registry.close(); }
  }
}
