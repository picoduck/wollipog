import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  codexApiKeyFromRecord, codexApiKeyRecord, codexUsesFileCredentialStore, providerCredentialImportHostSupported,
  ProviderCredentialImportRefusal, publishCodexCredential, readCodexCredentialSource, PROVIDER_CREDENTIAL_IMPORT_LIMITS,
} from "./provider-credential-import.js";

const posixOnly = { skip: process.platform === "win32" };
// Synthetic fixtures only. CLI_API_KEY_RECORD is byte-for-byte what codex-cli 0.165.0 wrote for
// `printf 'sk-fake-test' | CODEX_HOME=<temp> codex login --with-api-key` (63 bytes, no newline).
const FAKE_KEY = "sk-fake-test";
const CLI_API_KEY_RECORD = "{\n  \"auth_mode\": \"apikey\",\n  \"OPENAI_API_KEY\": \"sk-fake-test\"\n}";
const LEGACY_API_KEY_RECORD = "{\"OPENAI_API_KEY\":\"sk-fake-test\",\"tokens\":null,\"last_refresh\":null}";
const OAUTH_RECORD = JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
  tokens: { id_token: "fake.id.token", access_token: "fake-access", refresh_token: "fake-refresh", account_id: "fake-account" },
  last_refresh: "2026-10-30T00:00:00Z" });

function refusal(code: string) {
  return (error: unknown) => error instanceof ProviderCredentialImportRefusal && error.code === code;
}

function codexHome(t: TestContext, auth: string | null = CLI_API_KEY_RECORD, config?: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-credential-import-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "codex");
  mkdirSync(home, { mode: 0o700 });
  if (auth !== null) writeFileSync(join(home, "auth.json"), auth, { mode: 0o600 });
  if (config !== undefined) writeFileSync(join(home, "config.toml"), config, { mode: 0o600 });
  return home;
}

test("only an API-key-only Codex record yields its key", () => {
  assert.equal(codexApiKeyFromRecord(Buffer.from(CLI_API_KEY_RECORD)), FAKE_KEY);
  assert.equal(codexApiKeyFromRecord(Buffer.from(LEGACY_API_KEY_RECORD)), FAKE_KEY);
  assert.equal(codexApiKeyFromRecord(Buffer.from(JSON.stringify({ OPENAI_API_KEY: FAKE_KEY }))), FAKE_KEY);
  for (const record of [
    OAUTH_RECORD,
    // Mixed: an API key next to OAuth tokens or a refresh time is not API-key-only.
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: FAKE_KEY, tokens: { refresh_token: "fake-refresh" } }),
    JSON.stringify({ OPENAI_API_KEY: FAKE_KEY, last_refresh: "2026-10-30T00:00:00Z" }),
    JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: FAKE_KEY }),
    // Unknown keys are newer authentication types this runner cannot classify.
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: FAKE_KEY, agent_identity: { id: "x" } }),
    JSON.stringify({ auth_mode: "apikey" }),
    JSON.stringify({ OPENAI_API_KEY: "" }),
    JSON.stringify({ OPENAI_API_KEY: "sk fake" }),
    JSON.stringify({ OPENAI_API_KEY: "sk-fäke" }),
    JSON.stringify({ OPENAI_API_KEY: "s".repeat(PROVIDER_CREDENTIAL_IMPORT_LIMITS.apiKeyBytes + 1) }),
    JSON.stringify([FAKE_KEY]), "null", "not json",
  ]) assert.equal(codexApiKeyFromRecord(Buffer.from(record)), undefined, record.slice(0, 80));
  assert.equal(codexApiKeyFromRecord(Buffer.from([0x7b, 0xff, 0x7d])), undefined);
});

test("the imported record is exactly what codex login --with-api-key writes", () => {
  assert.equal(codexApiKeyRecord(FAKE_KEY).toString("utf8"), CLI_API_KEY_RECORD);
  assert.throws(() => codexApiKeyRecord("sk fake"));
});

test("only file credential storage is importable", () => {
  assert.equal(codexUsesFileCredentialStore(undefined), true);
  assert.equal(codexUsesFileCredentialStore(Buffer.from("model = \"gpt-5\"\n")), true);
  assert.equal(codexUsesFileCredentialStore(Buffer.from("cli_auth_credentials_store = \"file\"\n")), true);
  for (const mode of ["keyring", "auto", "ephemeral"]) {
    assert.equal(codexUsesFileCredentialStore(Buffer.from(`cli_auth_credentials_store = "${mode}"\n`)), false, mode);
  }
  assert.equal(codexUsesFileCredentialStore(Buffer.from("[profiles.work]\ncli_auth_credentials_store = \"keyring\"\n")), false);
  assert.equal(codexUsesFileCredentialStore(Buffer.from("cli_auth_credentials_store = [\"file\"]\n")), false);
  assert.equal(codexUsesFileCredentialStore(Buffer.from("this is = = not toml")), false);
});

test("a private API-key record is read; anything unverifiable is refused", posixOnly, (t) => {
  assert.equal(readCodexCredentialSource(codexHome(t)).apiKey, FAKE_KEY);
  assert.equal(readCodexCredentialSource(codexHome(t, CLI_API_KEY_RECORD, "cli_auth_credentials_store = \"file\"\n")).apiKey, FAKE_KEY);
  assert.throws(() => readCodexCredentialSource(join(codexHome(t), "absent")), refusal("import_source_missing"));
  assert.throws(() => readCodexCredentialSource(codexHome(t, null)), refusal("import_source_missing"));
  assert.throws(() => readCodexCredentialSource(codexHome(t, OAUTH_RECORD)), refusal("import_source_unsupported"));
  assert.throws(() => readCodexCredentialSource(codexHome(t, CLI_API_KEY_RECORD, "cli_auth_credentials_store = \"keyring\"\n")),
    refusal("import_source_unsupported"));
  assert.throws(() => readCodexCredentialSource(codexHome(t, `${CLI_API_KEY_RECORD}${" ".repeat(PROVIDER_CREDENTIAL_IMPORT_LIMITS.credentialBytes)}`)),
    refusal("import_source_unsupported"));

  const loose = codexHome(t);
  chmodSync(join(loose, "auth.json"), 0o644);
  assert.throws(() => readCodexCredentialSource(loose), refusal("import_source_unsafe"));

  const writableDirectory = codexHome(t);
  chmodSync(writableDirectory, 0o770);
  assert.throws(() => readCodexCredentialSource(writableDirectory), refusal("import_source_unsafe"));

  const linkedRecord = codexHome(t, null);
  writeFileSync(join(linkedRecord, "real.json"), CLI_API_KEY_RECORD, { mode: 0o600 });
  symlinkSync(join(linkedRecord, "real.json"), join(linkedRecord, "auth.json"));
  assert.throws(() => readCodexCredentialSource(linkedRecord), refusal("import_source_unsafe"));

  const hardLinked = codexHome(t);
  linkSync(join(hardLinked, "auth.json"), join(hardLinked, "second.json"));
  assert.throws(() => readCodexCredentialSource(hardLinked), refusal("import_source_unsafe"));

  const linkedDirectory = codexHome(t);
  symlinkSync(linkedDirectory, `${linkedDirectory}-link`);
  t.after(() => rmSync(`${linkedDirectory}-link`, { force: true }));
  assert.throws(() => readCodexCredentialSource(`${linkedDirectory}-link`), refusal("import_source_unsafe"));

  const linkedConfig = codexHome(t);
  writeFileSync(join(linkedConfig, "real.toml"), "", { mode: 0o600 });
  symlinkSync(join(linkedConfig, "real.toml"), join(linkedConfig, "config.toml"));
  assert.throws(() => readCodexCredentialSource(linkedConfig), refusal("import_source_unsafe"));

  const directoryRecord = codexHome(t, null);
  mkdirSync(join(directoryRecord, "auth.json"));
  assert.throws(() => readCodexCredentialSource(directoryRecord), refusal("import_source_unsafe"));
});

test("a source replaced after it was read is refused as changed", posixOnly, (t) => {
  const home = codexHome(t);
  const source = readCodexCredentialSource(home);
  source.verifyUnchanged();
  writeFileSync(join(home, "replacement.json"), CLI_API_KEY_RECORD, { mode: 0o600 });
  renameSync(join(home, "replacement.json"), join(home, "auth.json"));
  assert.throws(() => source.verifyUnchanged(), refusal("import_source_changed"));

  const configured = codexHome(t);
  const read = readCodexCredentialSource(configured);
  writeFileSync(join(configured, "config.toml"), "cli_auth_credentials_store = \"keyring\"\n", { mode: 0o600 });
  assert.throws(() => read.verifyUnchanged(), refusal("import_source_changed"));
});

test("publication writes a private record and never replaces one", posixOnly, (t) => {
  const home = codexHome(t, null);
  publishCodexCredential(home, codexApiKeyRecord(FAKE_KEY));
  assert.equal(readFileSync(join(home, "auth.json"), "utf8"), CLI_API_KEY_RECORD);
  assert.equal(statSync(join(home, "auth.json")).mode & 0o777, 0o600);
  assert.throws(() => publishCodexCredential(home, codexApiKeyRecord("sk-fake-other")), /already holds a credential/u);
  assert.equal(readFileSync(join(home, "auth.json"), "utf8"), CLI_API_KEY_RECORD);
});

test("only native Linux and macOS hosts outside WSL and containers can import", () => {
  const none = () => false;
  assert.equal(providerCredentialImportHostSupported({ platform: "darwin", env: {}, release: "25.0.0", exists: none }), true);
  assert.equal(providerCredentialImportHostSupported({ platform: "linux", env: {}, release: "6.8.0-generic", exists: none }), true);
  assert.equal(providerCredentialImportHostSupported({ platform: "win32", env: {}, release: "10.0", exists: none }), false);
  assert.equal(providerCredentialImportHostSupported({ platform: "freebsd", env: {}, release: "14", exists: none }), false);
  assert.equal(providerCredentialImportHostSupported({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" }, release: "6.8.0", exists: none }), false);
  assert.equal(providerCredentialImportHostSupported({ platform: "linux", env: {}, release: "5.15.153.1-microsoft-standard-WSL2", exists: none }), false);
  assert.equal(providerCredentialImportHostSupported({ platform: "linux", env: {}, release: "6.8.0", exists: (path) => path === "/.dockerenv" }), false);
  assert.equal(providerCredentialImportHostSupported({ platform: "linux", env: {}, release: "6.8.0", exists: (path) => path === "/run/.containerenv" }), false);
});
