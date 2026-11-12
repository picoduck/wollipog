import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_LOGIN_START_FAILURE, PROVIDER_LOGIN_START_UNCERTAIN } from "@wollipog/protocol";
import { providerLoginStartFailure } from "./provider-login-start-failure.js";

test("start409 projection strips peer error/source fields and preserves validated uncertainty only", () => {
  const directoryDiagnostic = { code: "managed_profile_directory", component: "os_home",
    reason: "may_have_changed", failureReason: "identity_changed" };
  assert.deepEqual(providerLoginStartFailure({ error: "secret /private", directoryDiagnostic: {
    ...directoryDiagnostic, path: "/private", cause: "secret", message: "raw" } }),
  { error: PROVIDER_LOGIN_START_UNCERTAIN, directoryDiagnostic });
  assert.deepEqual(providerLoginStartFailure({ error: "secret", directoryDiagnostic: {
    code: "managed_profile_directory", component: "profiles_root", reason: "group_or_other_write" } }),
  { error: PROVIDER_LOGIN_START_FAILURE, directoryDiagnostic: {
    code: "managed_profile_directory", component: "profiles_root", reason: "group_or_other_write" } });
  for (const diagnostic of [undefined, null, {}, { ...directoryDiagnostic, failureReason: "may_have_changed" },
    { ...directoryDiagnostic, reason: "wrong_owner" }, { ...directoryDiagnostic, component: "/private" }]) {
    assert.deepEqual(providerLoginStartFailure({ error: "Account label must contain 1 to 100 characters.", directoryDiagnostic: diagnostic }),
      { error: PROVIDER_LOGIN_START_FAILURE });
  }
});

test("older/missing/unknown peer failures use fixed guidance; exact business errors remain useful", () => {
  for (const error of [undefined, "ENOENT /private secret", "The managed provider profile directory could not be created.",
    { message: "secret" }, "Account label must contain 1 to 100 characters. secret"])
    assert.deepEqual(providerLoginStartFailure({ error }), { error: PROVIDER_LOGIN_START_FAILURE });
  const error = "A sign-in for an account with this label is already running.";
  assert.deepEqual(providerLoginStartFailure({ error }), { error });
});

test("older peers keep exact safe plugin guidance while prefix matches and appended secrets stay generic", () => {
  for (const error of [
    "Codex sign-in could not identify a supported launcher form. Use a supported Codex launcher form; see docs/codex-plugin-launchers.md.",
    "Codex plugin inheritance could not identify a supported launcher form. Use a supported Codex launcher form; see docs/codex-plugin-launchers.md.",
    "Codex plugin inheritance could not read the default config.toml.",
    "Codex plugin inheritance could not read the account config.toml.",
    "Codex plugin inheritance could not reconcile the account plugin cache.",
    "Claude plugin inheritance could not read plugin settings or installation records.",
    "Claude plugin inheritance could not read this plugin registry version.",
    "Claude plugin inheritance could not read plugin installation records.",
    "Claude plugin inheritance could not reconcile the account plugin cache.",
    "A managed provider profile with this identity already exists.",
    "The managed provider profile path is invalid.",
    "Managed provider profiles are not supported on this Machine.",
  ]) {
    assert.deepEqual(providerLoginStartFailure({ error }), { error });
    assert.deepEqual(providerLoginStartFailure({ error: error + " secret /private" }), { error: PROVIDER_LOGIN_START_FAILURE });
  }
  assert.deepEqual(providerLoginStartFailure({ error: "Claude plugin inheritance could not read /private secret" }),
    { error: PROVIDER_LOGIN_START_FAILURE });
});
