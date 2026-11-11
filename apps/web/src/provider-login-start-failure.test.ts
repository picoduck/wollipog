import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_LOGIN_START_FAILURE, PROVIDER_LOGIN_START_UNCERTAIN } from "@wollipog/protocol";
import { ApiError, createApiClient } from "./api.js";
import { providerLoginStartFailure } from "./provider-login-start-failure.js";

const diagnostic = (component: string, reason: string) => ({ code: "managed_profile_directory", component, reason });
const failure = (value: unknown, message = "secret /home/private") =>
  providerLoginStartFailure(new ApiError(message, 409, undefined, { directoryDiagnostic: value }));

test("all current producer components and reasons have fixed readable copy without peer fields", () => {
  for (const component of ["manager_root", "profiles_root", "profile_home"]) {
    for (const reason of ["symlink", "not_directory", "wrong_owner", "group_or_other_write", "unavailable"]) {
      const result = failure({ ...diagnostic(component, reason), path: "/private", cause: "credential" });
      assert.notEqual(result.message, PROVIDER_LOGIN_START_FAILURE);
      assert.doesNotMatch(JSON.stringify(result), /secret|\/private|credential|undefined/);
      assert.match(result.guidance!, /remote Machine, not the control-plane host/);
      assert.equal(!!result.inspectCommand, component !== "profile_home");
      assert.equal(!!result.repairCommand, component !== "profile_home" && reason === "group_or_other_write");
    }
  }
});

test("missing, malformed, unknown and string-inferred diagnostics fall back safely", () => {
  for (const value of [undefined, null, [], "wrong_owner", diagnostic("new", "symlink"),
    diagnostic("manager_root", "new"), { ...diagnostic("manager_root", "symlink"), failureReason: "unavailable" }]) {
    assert.deepEqual(failure(value), { message: PROVIDER_LOGIN_START_FAILURE });
  }
  assert.deepEqual(providerLoginStartFailure(new Error("manager_root wrong_owner /private")), { message: PROVIDER_LOGIN_START_FAILURE });
});

test("reserved compatibility observations never imply repair or no-write guarantees", () => {
  for (const reason of ["unsupported_layout", "unsupported_acl", "identity_changed"]) {
    assert.equal(failure(diagnostic("os_home", reason)).repairCommand, undefined);
  }
  for (const reason of ["unsupported_platform", "unsupported_helper", "already_exists"]) {
    assert.equal(failure(diagnostic("profile_home", reason)).inspectCommand, undefined);
  }
  for (const failureReason of [undefined, "wrong_owner", "identity_changed"]) {
    const result = failure({ ...diagnostic("profiles_root", "may_have_changed"), ...(failureReason ? { failureReason } : {}) });
    assert.equal(result.message, PROVIDER_LOGIN_START_UNCERTAIN);
    assert.match(result.message, /Preserve them.*Do not retry automatically/);
    assert.equal(result.inspectCommand, undefined);
    assert.equal(result.repairCommand, undefined);
  }
});

test("exact business errors stay useful but appended peer text is discarded", () => {
  for (const message of ["This Machine already has 32 provider accounts.", "No Codex agent is available on this Machine.",
    "Account label must contain 1 to 100 characters.", "The profile grant is invalid."]) {
    assert.equal(failure(undefined, message).message, message);
    assert.equal(failure(undefined, `${message} /private`).message, PROVIDER_LOGIN_START_FAILURE);
  }
  assert.match(providerLoginStartFailure(new ApiError("secret", 403)).message, /permission/);
});

test("the real API start409 seam retains the DTO for local normalization and performs one POST", async () => {
  const calls: unknown[] = [];
  const api = createApiClient({ instanceId: "fixture", publicOrigin: "https://fixture.invalid", close() {},
    async request(path, init) {
      calls.push({ path, method: init?.method, body: init?.body });
      return new Response(JSON.stringify({ error: "secret", directoryDiagnostic: diagnostic("profiles_root", "wrong_owner") }), { status: 409 });
    },
  });
  await assert.rejects(api.startProviderLogin("remote", { provider: "codex", label: "Draft" }), (cause: unknown) => {
    assert.match(providerLoginStartFailure(cause).message, /provider profiles directory belongs to a different OS user/);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { path: "/api/runners/remote/provider-logins", method: "POST", body: JSON.stringify({ provider: "codex", label: "Draft" }) });
});
