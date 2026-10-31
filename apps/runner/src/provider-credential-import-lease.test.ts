import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { AsyncProviderHomeLeaseRegistry } from "./provider-home-lease-async.js";
import { ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";
import { ProviderProfileGrants } from "./provider-profile-grants.js";
import { managedProviderProfileRoot } from "./provider-profile-home.js";
import { PROVIDER_PROFILE_DIRECTORY, PROVIDER_PROFILE_MARKER, readProviderProfileMarker, writeProviderProfileMarker } from "./provider-profile.js";

/**
 * #3719: the import runs in the real lease worker. Each refusal must leave the source's credential
 * files and the destination exactly as they were; lease-journal bookkeeping in the source's
 * `.agent-manager` is not a credential change, so the snapshots below exclude it.
 */
const posixOnly = { skip: process.platform === "win32" };
const INSTANCE = "0a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const GRANT = "2a1b2c3d-4e5f-4a6b-8c7d-8e9fa0b1c2d3";
const PROFILE = "6f1c2d3e-4a5b-4c6d-8e7f-001122334455";
const SOURCE_PROFILE = "7f1c2d3e-4a5b-4c6d-8e7f-001122334455";
// Synthetic fixtures only: the shape codex-cli 0.165.0 writes for a fake key, and an OAuth record.
const API_KEY_RECORD = "{\n  \"auth_mode\": \"apikey\",\n  \"OPENAI_API_KEY\": \"sk-fake-test\"\n}";
const OAUTH_RECORD = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "fake-refresh", access_token: "fake-access" }, last_refresh: "2026-10-30T00:00:00Z" });

function machine(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-import-lease-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const user = join(root, "user");
  mkdirSync(user, { mode: 0o700 });
  const accounts: Array<{ id: string; label: string; provider: "claude" | "codex"; directory: string; profileId?: string }> = [];
  const grants = new ProviderProfileGrants({ controlPlaneInstanceId: INSTANCE, accounts: () => accounts });
  grants.synchronize(PROTOCOL_VERSION, []);
  const leases = new AsyncProviderHomeLeaseRegistry("a".repeat(64), { controlPlaneInstanceId: INSTANCE,
    profileAccess: () => grants.access(), expectedProfileIdForHome: (home) => grants.expectedProfileIdForHome(home) });
  t.after(() => leases.close());
  return { root, user, profiles: managedProviderProfileRoot(user), accounts, grants, leases };
}

function codexDirectory(path: string, files: Record<string, string>): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(path, name), content, { mode: 0o600 });
  return path;
}

/** Every credential, configuration or transcript file under `home`, outside lease bookkeeping. */
function snapshot(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (relative.startsWith(`${PROVIDER_PROFILE_DIRECTORY}/provider-home-leases-v1`)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${relative}/`);
      else out[relative] = `${statSync(path).mode & 0o777}:${readFileSync(path, "utf8")}`;
    }
  };
  walk(home, "");
  return out;
}

function refused(code: string) {
  return (error: unknown) => error instanceof ProviderHomeLeaseError && error.code === code;
}

test("an API-key sign-in is copied into a fresh profile, and only its key", posixOnly, async (t) => {
  const m = machine(t);
  const source = codexDirectory(join(m.user, ".codex"), {
    "auth.json": API_KEY_RECORD, "config.toml": "model = \"gpt-5\"\n", "history.jsonl": "{\"session\":\"transcript\"}\n",
  });
  mkdirSync(join(source, "skills", "local"), { recursive: true });
  writeFileSync(join(source, "skills", "local", "SKILL.md"), "# skill\n");
  const before = snapshot(m.user);
  await m.leases.importCodexCredential(m.user, "user_home", m.profiles, PROFILE, GRANT);
  assert.deepEqual(snapshot(m.user), { ...before, ...Object.fromEntries(Object.entries(snapshot(join(m.profiles, PROFILE)))
    .map(([name, value]) => [`.agent-manager/profiles/${PROFILE}/${name}`, value])) });
  const destination = join(m.profiles, PROFILE);
  // The new HOME holds exactly a reconstructed private record and its marker: no config, transcript or skill.
  assert.deepEqual(Object.keys(snapshot(destination)).sort(), [`${PROVIDER_PROFILE_DIRECTORY}/${PROVIDER_PROFILE_MARKER}`, "auth.json"]);
  assert.equal(readFileSync(join(destination, "auth.json"), "utf8"), API_KEY_RECORD);
  assert.equal(statSync(join(destination, "auth.json")).mode & 0o777, 0o600);
  const marker = readProviderProfileMarker(destination, { provider: "codex" });
  assert.ok(marker.state === "present");
  assert.equal(marker.marker.profileId, PROFILE);
  assert.deepEqual(marker.marker.grants.map((grant) => [grant.controlPlaneInstanceId, grant.grantId]), [[INSTANCE, GRANT]]);
  // The source is left as it was, and its lease is released again.
  assert.equal(readFileSync(join(source, "auth.json"), "utf8"), API_KEY_RECORD);
  assert.equal(await m.leases.acquireHome(m.user, "codex"), true);
  assert.equal(await m.leases.releaseHome(m.user), true);
});

test("a configured account HOME is its own credential directory", posixOnly, async (t) => {
  const m = machine(t);
  const account = codexDirectory(join(m.root, "accounts", "work"), { "auth.json": API_KEY_RECORD });
  await m.leases.importCodexCredential(account, "codex_home", m.profiles, PROFILE, GRANT);
  assert.equal(readFileSync(join(m.profiles, PROFILE, "auth.json"), "utf8"), API_KEY_RECORD);
});

test("an unverifiable or unsupported source is refused and both HOMEs stay unchanged", posixOnly, async (t) => {
  const m = machine(t);
  const cases: Array<[string, (dir: string) => { home: string; layout: "codex_home" | "user_home" }, string]> = [
    ["OAuth sign-in", (dir) => ({ home: codexDirectory(dir, { "auth.json": OAUTH_RECORD }), layout: "codex_home" }), "import_source_unsupported"],
    ["keyring storage", (dir) => ({ home: codexDirectory(dir, { "auth.json": API_KEY_RECORD, "config.toml": "cli_auth_credentials_store = \"keyring\"\n" }), layout: "codex_home" }), "import_source_unsupported"],
    ["no sign-in", (dir) => ({ home: codexDirectory(dir, {}), layout: "codex_home" }), "import_source_missing"],
    ["no .codex directory", (dir) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); return { home: dir, layout: "user_home" }; }, "import_source_missing"],
    ["a linked source root", (dir) => {
      const real = codexDirectory(`${dir}-real`, { "auth.json": API_KEY_RECORD });
      symlinkSync(real, dir);
      return { home: dir, layout: "codex_home" };
    }, "import_source_unsafe"],
    ["another provider's profile", (dir) => {
      const home = codexDirectory(dir, { "auth.json": API_KEY_RECORD });
      writeProviderProfileMarker(home, { version: 1, kind: "wollipog-provider-profile", profileId: SOURCE_PROFILE, provider: "claude",
        createdAt: "2026-10-30T00:00:00.000Z", grants: [{ controlPlaneInstanceId: INSTANCE, grantId: GRANT, grantedAt: "2026-10-30T00:00:00.000Z" }] });
      return { home, layout: "codex_home" };
    }, "import_source_foreign"],
    ["a profile not granted here", (dir) => {
      const home = codexDirectory(dir, { "auth.json": API_KEY_RECORD });
      writeProviderProfileMarker(home, { version: 1, kind: "wollipog-provider-profile", profileId: SOURCE_PROFILE, provider: "codex",
        createdAt: "2026-10-30T00:00:00.000Z", grants: [] });
      return { home, layout: "codex_home" };
    }, "profile_not_granted"],
  ];
  for (const [name, setup, code] of cases) {
    const { home, layout } = setup(join(m.root, "sources", name.replaceAll(" ", "-")));
    const before = snapshot(home);
    await assert.rejects(m.leases.importCodexCredential(home, layout, m.profiles, PROFILE, GRANT), refused(code), name);
    assert.deepEqual(snapshot(home), before, name);
    assert.equal(existsSync(join(m.profiles, PROFILE)), false, name);
  }
  // A missing source is never created.
  const missing = join(m.root, "sources", "absent");
  await assert.rejects(m.leases.importCodexCredential(missing, "codex_home", m.profiles, PROFILE, GRANT), refused("import_source_missing"));
  assert.equal(existsSync(missing), false);
});

test("a source this runner holds, even by its own reference, is refused rather than borrowed", posixOnly, async (t) => {
  const m = machine(t);
  const home = codexDirectory(join(m.root, "held"), { "auth.json": API_KEY_RECORD });
  const reference = await m.leases.acquireHomeReference(home, "codex");
  const before = snapshot(home);
  await assert.rejects(m.leases.importCodexCredential(home, "codex_home", m.profiles, PROFILE, GRANT), refused("import_source_held"));
  assert.deepEqual(snapshot(home), before);
  assert.equal(existsSync(join(m.profiles, PROFILE)), false);
  assert.equal(await reference.release(), true);
  await m.leases.importCodexCredential(home, "codex_home", m.profiles, PROFILE, GRANT);
  assert.equal(existsSync(join(m.profiles, PROFILE, "auth.json")), true);
});

test("a source another runner holds is refused with that lease's code", posixOnly, async (t) => {
  const m = machine(t);
  const home = codexDirectory(join(m.root, "other-runner"), { "auth.json": API_KEY_RECORD });
  const other = new AsyncProviderHomeLeaseRegistry("b".repeat(64), { controlPlaneInstanceId: INSTANCE,
    profileAccess: () => m.grants.access() });
  t.after(() => other.close());
  assert.equal(await other.acquireHome(home, "codex"), true);
  const before = snapshot(home);
  await assert.rejects(m.leases.importCodexCredential(home, "codex_home", m.profiles, PROFILE, GRANT),
    (error: unknown) => error instanceof ProviderHomeLeaseError && ["busy", "holder_alive"].includes(error.code));
  assert.deepEqual(snapshot(home), before);
  assert.equal(existsSync(join(m.profiles, PROFILE)), false);
  assert.equal(await other.releaseHome(home), true);
});

test("an existing destination identity is never replaced", posixOnly, async (t) => {
  const m = machine(t);
  const home = codexDirectory(join(m.root, "source"), { "auth.json": API_KEY_RECORD });
  mkdirSync(join(m.profiles, PROFILE), { recursive: true, mode: 0o700 });
  writeFileSync(join(m.profiles, PROFILE, "auth.json"), "{\"other\":true}", { mode: 0o600 });
  await assert.rejects(m.leases.importCodexCredential(home, "codex_home", m.profiles, PROFILE, GRANT), ProviderHomeLeaseError);
  assert.equal(readFileSync(join(m.profiles, PROFILE, "auth.json"), "utf8"), "{\"other\":true}");
});
