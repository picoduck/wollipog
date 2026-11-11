import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_LOGIN_START_FAILURE } from "@wollipog/protocol";
import { ManagedProfileDirectoryError } from "./provider-profile-home.js";
import { providerLoginStartFailure } from "./provider-login-start-failure.js";

test("only genuine landed errors emit fixed fields, omitting source fields and toJSON", () => {
  for (const component of ["manager_root", "profiles_root", "profile_home"] as const) {
    for (const reason of ["symlink", "not_directory", "wrong_owner", "group_or_other_write", "unavailable"] as const) {
      const error = Object.assign(new ManagedProfileDirectoryError(component, reason), {
        message: "secret /private", cause: { token: "secret" }, path: "/private", failureReason: "secret",
        toJSON() { throw new Error("must not serialize exceptions"); },
      });
      assert.deepEqual(providerLoginStartFailure(error), { error: PROVIDER_LOGIN_START_FAILURE,
        directoryDiagnostic: { code: "managed_profile_directory", component, reason } });
    }
  }
});

test("lookalikes, wrapped causes, raw filesystem failures and unlanded producer variants stay generic", () => {
  const genuine = new ManagedProfileDirectoryError("manager_root", "wrong_owner");
  for (const error of [{ ...genuine }, genuine.toJSON(), new Error("secret /private", { cause: genuine }),
    Object.assign(new Error("ENOENT /private"), { code: "managed_profile_directory", component: "manager_root", reason: "wrong_owner" }),
    Object.assign(new ManagedProfileDirectoryError("manager_root", "unavailable"), { reason: "may_have_changed" }),
    Object.assign(new ManagedProfileDirectoryError("manager_root", "unavailable"), { component: "os_home" }),
    "secret /private", undefined]) {
    assert.deepEqual(providerLoginStartFailure(error), { error: PROVIDER_LOGIN_START_FAILURE });
  }
  const sentence = "Account label must contain 1 to 100 characters.";
  assert.deepEqual(providerLoginStartFailure(new Error(sentence)), { error: sentence });
  assert.deepEqual(providerLoginStartFailure({ message: sentence }), { error: PROVIDER_LOGIN_START_FAILURE });
});

test("fixed launcher/plugin and managed-profile refusals retain their operator guidance", () => {
  const messages = [
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
  ];
  for (const message of messages) {
    assert.deepEqual(providerLoginStartFailure(new Error(message)), { error: message });
    assert.deepEqual(providerLoginStartFailure(new Error(message + " secret /private")), { error: PROVIDER_LOGIN_START_FAILURE });
  }
  assert.deepEqual(providerLoginStartFailure(new Error("Codex plugin inheritance could not read /private secret")),
    { error: PROVIDER_LOGIN_START_FAILURE });
});
