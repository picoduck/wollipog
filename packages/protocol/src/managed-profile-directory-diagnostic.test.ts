import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { normalizeManagedProfileDirectoryDiagnostic as normalize, safeProviderLoginStartError,
  PROVIDER_LOGIN_START_FAILURE } from "./managed-profile-directory-diagnostic.js";

test("closed directory diagnostics validate component/reason and uncertainty consistency", () => {
  const base = { code: "managed_profile_directory", component: "profiles_root" };
  for (const reason of ["symlink", "not_directory", "wrong_owner", "group_or_other_write", "unavailable",
    "unsupported_layout", "unsupported_acl", "identity_changed", "may_have_changed"]) {
    assert.deepEqual(normalize({ ...base, reason, path: "/private", cause: { token: "secret" } }), { ...base, reason });
  }
  assert.deepEqual(normalize({ ...base, reason: "may_have_changed", failureReason: "unsupported_acl" }),
    { ...base, reason: "may_have_changed", failureReason: "unsupported_acl" });
  for (const value of [null, [], "private", {}, { ...base, code: "other", reason: "unavailable" },
    { ...base, component: "/private", reason: "unavailable" }, { ...base, reason: "created" }, { ...base, reason: "repaired" },
    { ...base, reason: "unavailable", failureReason: "identity_changed" },
    { ...base, reason: "unavailable", failureReason: undefined },
    { ...base, reason: "may_have_changed", failureReason: "may_have_changed" },
    { ...base, reason: "may_have_changed", failureReason: "created" },
    { ...base, reason: "may_have_changed", failureReason: { message: "secret" } }]) {
    assert.equal(normalize(value), undefined);
  }
  for (const reason of ["already_exists", "unsupported_helper", "unsupported_platform"]) {
    assert.equal(normalize({ ...base, reason }), undefined);
    assert.equal(normalize({ ...base, reason: "may_have_changed", failureReason: reason }), undefined);
    assert.deepEqual(normalize({ ...base, component: "profile_home", reason }), { ...base, component: "profile_home", reason });
  }
  let getterCalls = 0;
  assert.equal(normalize({ ...base, get reason() { getterCalls++; return "unavailable"; } }), undefined);
  assert.equal(getterCalls, 0);
  assert.equal(normalize(Object.create({ ...base, reason: "unavailable" })), undefined);
});

test("all accepted wire observations survive serialization; arbitrary extra data is always discarded", () => {
  const component = fc.constantFrom("os_home", "manager_root", "profiles_root", "profile_home");
  const reason = fc.constantFrom("symlink", "not_directory", "wrong_owner", "group_or_other_write", "unavailable",
    "unsupported_layout", "unsupported_acl", "identity_changed");
  fc.assert(fc.property(component, reason, fc.boolean(), fc.jsonValue(), (component, failure, uncertain, secret) => {
    const expected = { code: "managed_profile_directory", component,
      ...(uncertain ? { reason: "may_have_changed", failureReason: failure } : { reason: failure }) };
    const actual = normalize({ ...expected, path: secret, cause: secret, message: secret, credentials: secret });
    assert.deepEqual(actual, expected);
    assert.deepEqual(normalize(JSON.parse(JSON.stringify(actual))), expected);
    assert.deepEqual(Object.keys(actual!).sort(), Object.keys(expected).sort());
  }));
});

test("business errors are exact fixed sentences, never arbitrary peer text", () => {
  const safe = "Account label must contain 1 to 100 characters.";
  assert.equal(safeProviderLoginStartError(safe), safe);
  for (const value of [safe + " /private", { message: safe }, undefined, "ENOENT /private secret"])
    assert.equal(safeProviderLoginStartError(value), PROVIDER_LOGIN_START_FAILURE);
});
