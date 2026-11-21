import assert from "node:assert/strict";
import test from "node:test";
import { safeAntigravitySignInUrl, validAntigravityOperationId, validAntigravitySetupView } from "./antigravity-setup.js";

const ready = {
  version: 1,
  status: "ready",
  checkedAt: 1_795_000_000_000,
  executable: { path: "/home/fixture/.local/bin/agy", version: "1.4.2" },
  models: [{ id: "fixture-pro", name: "Fixture Pro" }],
  credentialStore: "shared_os_keyring",
};

test("a runner's setup report is accepted only in its exact secret-free shape", () => {
  assert.ok(validAntigravitySetupView(ready));
  assert.ok(validAntigravitySetupView({ version: 1, status: "missing_runtime", checkedAt: 1, credentialStore: "shared_os_keyring" }));
  assert.ok(validAntigravitySetupView({ ...ready, status: "sign_in_required", models: undefined, signIn: {
    operationId: "agy_login_0f6c", status: "awaiting_code", startedAt: 2,
    verificationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=fixture",
  } }));

  const refused: unknown[] = [
    { ...ready, version: 2 },
    { ...ready, status: "signed_in" },
    { ...ready, credentialStore: "per_account" },
    { ...ready, output: "token=secret" },
    { ...ready, executable: undefined },
    { ...ready, models: [] },
    { ...ready, models: undefined },
    { ...ready, status: "sign_in_required" },
    { ...ready, failure: "session_check_failed" },
    { ...ready, executable: { path: "/bin/agy\nINJECTED" } },
    { ...ready, executable: { path: "/bin/agy", version: "1.0 beta" } },
    { ...ready, models: [{ id: "a", name: "A" }, { id: "a", name: "B" }] },
    { ...ready, models: Array.from({ length: 65 }, (_, index) => ({ id: `m${index}`, name: `M${index}` })) },
    { ...ready, signIn: { operationId: "login_1", status: "starting", startedAt: 1 } },
    { ...ready, signIn: { operationId: "agy_login_1", status: "starting", startedAt: 1, code: "secret" } },
    { ...ready, signIn: { operationId: "agy_login_1", status: "awaiting_code", startedAt: 1, verificationUrl: "http://accounts.google.com" } },
    // The link is shown only while the sign-in waits for its code.
    { ...ready, signIn: { operationId: "agy_login_1", status: "waiting_for_provider", startedAt: 1, verificationUrl: "https://accounts.google.com" } },
    { ...ready, signIn: { operationId: "agy_login_1", status: "failed", startedAt: 1, failure: "bad_password" } },
  ];
  for (const value of refused) assert.equal(validAntigravitySetupView(value), false, JSON.stringify(value));
});

test("sign-in links and operation ids are bounded and credential-free", () => {
  assert.ok(safeAntigravitySignInUrl("https://accounts.google.com/x?y=1"));
  assert.equal(safeAntigravitySignInUrl("https://user:secret@accounts.google.com/"), false);
  assert.equal(safeAntigravitySignInUrl(`https://accounts.google.com/${"a".repeat(2_100)}`), false);
  assert.ok(validAntigravityOperationId("agy_login_123e4567-e89b-12d3-a456-426614174000"));
  assert.equal(validAntigravityOperationId("agy_login_../x"), false);
});
