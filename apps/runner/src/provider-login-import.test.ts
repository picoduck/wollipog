import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { RunnerProviderAccount } from "./config.js";
import { AccountConfigPublicationError } from "./provider-account-config-publication.js";
import { ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";
import {
  ProviderCredentialImportError, ProviderLoginSupervisor,
  type ProviderCredentialImportOptions, type ProviderCredentialImportSourceHome, type ProviderLoginProfileOptions,
} from "./provider-login.js";

const GRANT = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";

/** The supervisor's side of an import (#3719); the lease worker's copy is replaced by `copy`. */
function importFixture(t: TestContext, options: {
  copy?: ProviderCredentialImportOptions["copyCodex"];
  defaultHome?: ProviderCredentialImportSourceHome | undefined;
  accounts?: RunnerProviderAccount[];
  imports?: boolean;
  writeFails?: boolean;
  writeError?: Error;
  platform?: NodeJS.Platform;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-login-import-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "runner.config.json");
  const accounts: RunnerProviderAccount[] = options.accounts ?? [];
  // The configuration records the accounts the supervisor starts with, as a runner's does; a
  // publication refuses a preimage that differs from them (#3506).
  writeFileSync(configPath, `${JSON.stringify({ runnerId: "machine", ...(accounts.length ? { providerAccounts: accounts } : {}) })}\n`, { mode: 0o600 });
  const copies: Array<Parameters<ProviderCredentialImportOptions["copyCodex"]>[0]> = [];
  const settled: Array<Parameters<ProviderLoginProfileOptions["settle"]>[0]> = [];
  const added: string[] = [];
  const profilesRoot = join(root, "home", ".agent-manager", "profiles");
  const supervisor = new ProviderLoginSupervisor({
    dataDir: root, configPath, accounts, agents: () => [], resolveEnv: () => ({}),
    acquireLease: () => true, releaseLease: () => true, onUpdate: () => {},
    onAccountAdded: (account) => { added.push(account.id); },
    profiles: { root: profilesRoot, create: async () => { throw new Error("not used"); }, settle: async (input) => { settled.push(input); } },
    ...(options.imports === false ? {} : { imports: {
      defaultCodexHome: () => "defaultHome" in options ? options.defaultHome : { home: join(root, "user"), layout: "user_home" },
      copyCodex: async (input) => { copies.push(input); await options.copy?.(input); },
    } }),
    ...(options.writeFails || options.writeError
      ? { writeAccounts: (() => { throw options.writeError ?? new Error("disk full"); }) as never } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  return { root, configPath, supervisor, accounts, copies, settled, added, profilesRoot };
}

function refused(code: string) {
  return (error: unknown) => error instanceof ProviderCredentialImportError && error.code === code;
}

test("an import records a managed Codex profile account from the Machine's own sign-in", async (t) => {
  const f = importFixture(t);
  const result = await f.supervisor.importAccount({ provider: "codex", label: " Work ", source: { kind: "default_home" }, profileGrantId: GRANT });
  assert.deepEqual(f.copies.map((copy) => ({ ...copy, profileId: "" })),
    [{ source: { home: join(f.root, "user"), layout: "user_home" }, root: f.profilesRoot, profileId: "", grantId: GRANT }]);
  assert.equal(f.copies[0]!.profileId, result.profileId);
  const account = { id: result.accountId, label: "Work", provider: "codex", directory: join(f.profilesRoot, result.profileId), profileId: result.profileId };
  assert.deepEqual(f.accounts, [account]);
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, "utf8")).providerAccounts, [account]);
  assert.deepEqual(f.settled.map((s) => [s.profileId, s.grantId, s.recorded]), [[result.profileId, GRANT, true]]);
  assert.deepEqual(f.added, [result.accountId]);
});

test("a configured Codex account is copied from its own HOME with its recorded profile", async (t) => {
  const profileId = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
  const f = importFixture(t, { accounts: [{ id: "legacy", label: "Legacy", provider: "codex", directory: "/legacy/home", profileId }] });
  await f.supervisor.importAccount({ provider: "codex", label: "Managed", source: { kind: "account", accountId: "legacy" }, profileGrantId: GRANT });
  assert.deepEqual(f.copies[0]!.source, { home: "/legacy/home", layout: "codex_home", expectedProfileId: profileId });
  assert.equal(f.accounts.length, 2);
});

test("unsupported providers, hosts and sources are refused before anything is copied", async (t) => {
  const claude = { id: "claude-work", label: "Claude", provider: "claude" as const, directory: "/claude/home" };
  const f = importFixture(t, { accounts: [claude] });
  const attempt = (input: Partial<Parameters<ProviderLoginSupervisor["importAccount"]>[0]>) => f.supervisor.importAccount({
    provider: "codex", label: "New", source: { kind: "default_home" }, profileGrantId: GRANT, ...input });
  await assert.rejects(attempt({ provider: "claude" }), refused("UNSUPPORTED"));
  await assert.rejects(attempt({ source: { kind: "account", accountId: "missing" } }), refused("SOURCE_NOT_FOUND"));
  await assert.rejects(attempt({ source: { kind: "account", accountId: "claude-work" } }), refused("SOURCE_FOREIGN"));
  await assert.rejects(attempt({ label: "Claude" }).then(() => attempt({ label: "claude " })), refused("LABEL_IN_USE"));
  await assert.rejects(attempt({ label: "" }), refused("LABEL_IN_USE"));
  await assert.rejects(attempt({ profileGrantId: "not-a-grant" }), refused("FAILED"));
  await assert.rejects(attempt({ source: { kind: "path", path: "/home/user/.codex" } as never }), refused("FAILED"));
  assert.equal(f.copies.length, 1, "only the first valid import reached the copy");
  await assert.rejects(importFixture(t, { imports: false }).supervisor.importAccount({ provider: "codex", label: "New",
    source: { kind: "default_home" }, profileGrantId: GRANT }), refused("UNSUPPORTED"));
  await assert.rejects(importFixture(t, { platform: "win32" }).supervisor.importAccount({ provider: "codex", label: "New",
    source: { kind: "default_home" }, profileGrantId: GRANT }), refused("UNSUPPORTED"));
  await assert.rejects(importFixture(t, { defaultHome: undefined }).supervisor.importAccount({ provider: "codex", label: "New",
    source: { kind: "default_home" }, profileGrantId: GRANT }), refused("SOURCE_NOT_FOUND"));
});

test("a second import of the same source, or of the same label, is refused while one runs", async (t) => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const f = importFixture(t, { copy: () => gate, accounts: [{ id: "other", label: "Other", provider: "codex", directory: "/other" }] });
  const first = f.supervisor.importAccount({ provider: "codex", label: "First", source: { kind: "default_home" }, profileGrantId: GRANT });
  await assert.rejects(f.supervisor.importAccount({ provider: "codex", label: "Second", source: { kind: "default_home" }, profileGrantId: GRANT }),
    refused("SOURCE_IN_USE"));
  await assert.rejects(f.supervisor.importAccount({ provider: "codex", label: "first", source: { kind: "account", accountId: "other" }, profileGrantId: GRANT }),
    refused("LABEL_IN_USE"));
  finish();
  await first;
  assert.equal(f.copies.length, 1);
});

test("a worker refusal keeps its code and fixed text and records nothing", async (t) => {
  for (const [worker, code] of [
    ["import_source_unsupported", "SOURCE_UNSUPPORTED"], ["import_source_held", "SOURCE_IN_USE"], ["busy", "SOURCE_IN_USE"],
    ["foreign_owner", "SOURCE_IN_USE"], ["import_source_unsafe", "SOURCE_UNSAFE"], ["profile_changed", "SOURCE_UNSAFE"],
    ["import_source_missing", "SOURCE_MISSING"], ["import_source_foreign", "SOURCE_FOREIGN"], ["import_source_changed", "SOURCE_CHANGED"],
    ["profile_not_granted", "SOURCE_NOT_GRANTED"], ["unavailable", "FAILED"],
  ] as const) {
    const f = importFixture(t, { copy: async () => { throw new ProviderHomeLeaseError(worker); } });
    await assert.rejects(f.supervisor.importAccount({ provider: "codex", label: "Work", source: { kind: "default_home" }, profileGrantId: GRANT }),
      (error: unknown) => error instanceof ProviderCredentialImportError && error.code === code && error.message === new ProviderHomeLeaseError(worker).message,
      worker);
    assert.deepEqual(f.accounts, [], worker);
    assert.deepEqual(f.settled.map((s) => s.recorded), [false], worker);
  }
  const f = importFixture(t, { copy: async () => { throw new Error("/secret/path/auth.json is unreadable"); } });
  await assert.rejects(f.supervisor.importAccount({ provider: "codex", label: "Work", source: { kind: "default_home" }, profileGrantId: GRANT }),
    (error: unknown) => error instanceof ProviderCredentialImportError && error.code === "FAILED" && !error.message.includes("/secret"));
});

test("a copy whose account cannot be recorded settles the grant as unrecorded", async (t) => {
  const f = importFixture(t, { writeFails: true });
  await assert.rejects(f.supervisor.importAccount({ provider: "codex", label: "Work", source: { kind: "default_home" }, profileGrantId: GRANT }),
    refused("FAILED"));
  assert.deepEqual(f.accounts, []);
  assert.deepEqual(f.settled.map((s) => s.recorded), [false]);
  assert.deepEqual(f.added, []);
});

test("an unpublished account write is a refusal, and an unknown one is never reported as a success (#3506)", async (t) => {
  const refused = importFixture(t, { writeError: new AccountConfigPublicationError("not_published", "SOURCE_CHANGED") });
  await assert.rejects(refused.supervisor.importAccount({ provider: "codex", label: "Work", source: { kind: "default_home" }, profileGrantId: GRANT }),
    (error: unknown) => error instanceof ProviderCredentialImportError && error.code === "FAILED" &&
      error.message === "The sign-in was copied, but the runner configuration could not be updated.");
  assert.deepEqual(refused.accounts, []);
  assert.deepEqual(refused.settled.map((s) => s.recorded), [false], "a definitely unpublished account drops the grant");
  assert.deepEqual(refused.added, []);

  for (const publication of ["unknown", "committed"] as const) {
    const f = importFixture(t, { writeError: new AccountConfigPublicationError(publication, "IO") });
    await assert.rejects(f.supervisor.importAccount({ provider: "codex", label: "Work", source: { kind: "default_home" }, profileGrantId: GRANT }),
      (error: unknown) => error instanceof ProviderCredentialImportError && error.code === "PUBLICATION_UNKNOWN" &&
        error.message === new AccountConfigPublicationError(publication, "IO").message, publication);
    assert.deepEqual(f.accounts, [], `${publication}: not admitted as a usable account here`);
    assert.deepEqual(f.settled.map((s) => s.recorded), ["unknown"], `${publication}: settled as unknown, not revoked`);
    assert.deepEqual(f.added, [], `${publication}: no account report claims it`);
  }
});

test("a copied account is published through the fenced configuration write", async (t) => {
  const f = importFixture(t);
  const first = await f.supervisor.importAccount({ provider: "codex", label: "Work", source: { kind: "default_home" }, profileGrantId: GRANT });
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, "utf8")).providerAccounts.map((a: { id: string }) => a.id), [first.accountId]);
  // A second publication starts from the first one's recorded preimage.
  const second = await f.supervisor.importAccount({ provider: "codex", label: "Second", source: { kind: "default_home" }, profileGrantId: GRANT });
  assert.deepEqual(JSON.parse(readFileSync(f.configPath, "utf8")).providerAccounts.map((a: { id: string }) => a.id),
    [first.accountId, second.accountId]);
});

test("an import records the account under the id the control plane chose, and refuses one that is taken or malformed", async (t) => {
  const f = importFixture(t, { accounts: [{ id: "taken", label: "Taken", provider: "codex", directory: "/taken" }] });
  const result = await f.supervisor.importAccount({ provider: "codex", label: "Work", source: { kind: "default_home" },
    profileGrantId: GRANT, accountId: "import-1a2b3c4d" });
  assert.equal(result.accountId, "import-1a2b3c4d");
  assert.ok(f.accounts.some((account) => account.id === "import-1a2b3c4d"));
  for (const accountId of ["taken", "import-1a2b3c4d", "../escape", ""]) {
    await assert.rejects(f.supervisor.importAccount({ provider: "codex", label: `Other ${accountId}`, source: { kind: "default_home" },
      profileGrantId: GRANT, accountId }), refused("FAILED"), accountId);
  }
  assert.equal(f.copies.length, 1, "a refused id copies nothing");
});
