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
