import assert from "node:assert/strict";
import test from "node:test";
import { antigravityVersionNewer, safeAntigravitySignInUrl, validAntigravityOperationId, validAntigravitySetupView } from "./antigravity-setup.js";

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

const managedRelease = {
  version: "1.5.14",
  activatedAt: 1_795_000_000_000,
  installerSha256: "a".repeat(64),
  manifestUrl: "https://fixture-updater-000000000000.us-central1.run.app/manifests/linux_amd64.json",
  archiveUrl: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-1/linux-x64/cli_linux_x64.tar.gz",
  archiveSha512: "b".repeat(128),
};
const failedUpdate = {
  operationId: "agy_install_0f6c", kind: "update", status: "failed", startedAt: 1, finishedAt: 2,
  failure: "validation_failed", targetVersion: "1.6.0",
};
const managedInstall = {
  available: true,
  active: managedRelease,
  previousVersion: "1.5.10",
  latest: { version: "1.6.0", checkedAt: 3 },
  pathExecutable: "/home/fixture/.local/bin/agy",
  operation: failedUpdate,
};
const managed = {
  ...ready,
  executable: { path: "/var/lib/wollipog/antigravity-managed/current/agy", version: "1.5.14", source: "managed" },
  managedInstall,
};

test("v404 managed install reports are accepted only with verified provenance and a consistent operation", () => {
  assert.ok(validAntigravitySetupView(managed));
  assert.ok(validAntigravitySetupView({ ...ready, executable: { ...ready.executable, source: "path" }, managedInstall: { available: true } }));
  assert.ok(validAntigravitySetupView({ version: 1, status: "missing_runtime", checkedAt: 1, credentialStore: "shared_os_keyring",
    managedInstall: { available: true, operation: { operationId: "agy_install_1", kind: "install", status: "running", stage: "downloading", startedAt: 1 } } }));
  assert.ok(validAntigravitySetupView({ ...managed, managedInstall: { ...managedInstall,
    operation: { operationId: "agy_install_1", kind: "install", status: "succeeded", startedAt: 1, finishedAt: 2, targetVersion: "1.5.14" } } }));

  const running = { ...failedUpdate, status: "running", stage: "validating", failure: undefined, finishedAt: undefined };
  const refused: unknown[] = [
    { ...managed, executable: { ...managed.executable, source: "bundled" } },
    // A managed executable is the active managed release.
    { ...managed, managedInstall: { ...managedInstall, active: undefined } },
    { ...managed, managedInstall: { ...managedInstall, available: "yes" } },
    { ...managed, managedInstall: { ...managedInstall, available: false } },
    { ...managed, managedInstall: { ...managedInstall, output: "log" } },
    { ...managed, managedInstall: { ...managedInstall, activeCheckFailed: false } },
    { ...managed, managedInstall: { ...managedInstall, active: { ...managedRelease, archiveUrl: "https://example.com/cli.tar.gz" } } },
    { ...managed, managedInstall: { ...managedInstall, active: { ...managedRelease, archiveUrl: managedRelease.archiveUrl.replace("https:", "http:") } } },
    { ...managed, managedInstall: { ...managedInstall, active: { ...managedRelease, manifestUrl: "https://updates.example.com/manifests/linux_amd64.json" } } },
    { ...managed, managedInstall: { ...managedInstall, active: { ...managedRelease, archiveSha512: "B".repeat(128) } } },
    { ...managed, managedInstall: { ...managedInstall, active: { ...managedRelease, installerSha256: "a".repeat(63) } } },
    { ...managed, managedInstall: { ...managedInstall, latest: { version: "1.6 beta", checkedAt: 1 } } },
    { ...managed, managedInstall: { ...managedInstall, operation: { ...failedUpdate, operationId: "agy_login_1" } } },
    { ...managed, managedInstall: { ...managedInstall, operation: { ...failedUpdate, failure: "bad_luck" } } },
    { ...managed, managedInstall: { ...managedInstall, operation: { ...failedUpdate, stage: "validating" } } },
    { ...managed, managedInstall: { ...managedInstall, operation: { ...running, stage: undefined } } },
    { ...managed, managedInstall: { ...managedInstall, operation: { ...running, failure: "timed_out" } } },
    { ...managed, managedInstall: { ...managedInstall, operation: { ...running, log: "x" } } },
    { ...managed, managedInstall: { ...managedInstall, operation: { ...failedUpdate, status: "succeeded", failure: undefined, targetVersion: undefined } } },
    { ...managed, managedInstall: { ...managedInstall, operation: { ...failedUpdate, status: "succeeded" } } },
  ];
  for (const value of refused) assert.equal(validAntigravitySetupView(value), false, JSON.stringify(value));
});

test("release versions compare numerically, and anything else offers no update", () => {
  assert.equal(antigravityVersionNewer("1.6.0", "1.5.14"), true);
  assert.equal(antigravityVersionNewer("1.5.14", "1.5.9"), true);
  assert.equal(antigravityVersionNewer("1.5.14", "1.5.14"), false);
  assert.equal(antigravityVersionNewer("1.5", "1.5.0"), false);
  assert.equal(antigravityVersionNewer("1.4.99", "1.5.0"), false);
  assert.equal(antigravityVersionNewer("1.6.0-beta", "1.5.0"), undefined);
});
