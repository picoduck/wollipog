import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_HOME_RECOVERY_CAUSES, PROVIDER_HOME_RECOVERY_CAUSE_CODES, runnerSupportsProtocol, validProviderHomeBlockingProcess, validProviderHomeLaunchRefusal } from "./index.js";

test("specific launch causes require v235 and must agree with their v233 category", () => {
  assert.equal(runnerSupportsProtocol(234, "providerHomeRecoveryDetails"), false);
  assert.equal(runnerSupportsProtocol(235, "providerHomeRecoveryDetails"), true);
  for (const cause of PROVIDER_HOME_RECOVERY_CAUSES) {
    const refusal = { code: PROVIDER_HOME_RECOVERY_CAUSE_CODES[cause], cause, provider: "codex", detectedAt: 1 };
    assert.deepEqual(validProviderHomeLaunchRefusal(refusal), refusal);
    assert.equal(validProviderHomeLaunchRefusal({ ...refusal, code: "foreign_host" }), null);
    assert.equal(validProviderHomeLaunchRefusal({ ...refusal, blockingProcess: { pid: 1 } }), null, "process facts never belong in a session view");
  }
  assert.equal(validProviderHomeLaunchRefusal({ code: "busy", cause: "/private/path", provider: "codex", detectedAt: 1 }), null);
});

test("blocking process facts admit only bounded identity and membership values", () => {
  const valid = { pid: 42, startTime: "123", kind: "uninspectable", cgroupMembership: "unavailable" };
  assert.equal(validProviderHomeBlockingProcess(valid), true);
  const { startTime: _start, ...withoutStart } = valid;
  assert.equal(validProviderHomeBlockingProcess(withoutStart), true);
  for (const invalid of [null, [], { ...valid, pid: -1 }, { ...valid, pid: 2 ** 31 }, { ...valid, pid: 1.5 },
    { ...valid, startTime: "123\n/private/path" }, { ...valid, kind: "ssh" }, { ...valid, cgroupMembership: "/private/path" },
    { ...valid, environment: "secret" }, { ...valid, command: "secret" }, { ...valid, home: "/private/path" }]) {
    assert.equal(validProviderHomeBlockingProcess(invalid), false);
  }
});
