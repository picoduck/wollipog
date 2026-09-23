import assert from "node:assert/strict";
import { test } from "node:test";
import { automaticAccountSwitchForRunner } from "./automatic-account-switch-compatibility.js";

test("saved switching remains enabled only when a runner can honor a selected installation", () => {
  const saved = { enabled: true, revision: 4 };
  const selectedCodex = [{ family: "codex" as const }];
  assert.equal(automaticAccountSwitchForRunner(saved, 172, selectedCodex), undefined);
  assert.deepEqual(automaticAccountSwitchForRunner(saved, 174, []), saved);
  assert.deepEqual(automaticAccountSwitchForRunner(saved, 177, [{ family: "pi" }]), saved);
  assert.deepEqual(automaticAccountSwitchForRunner(saved, 177, selectedCodex), {
    enabled: false, revision: 5,
  });
  assert.deepEqual(automaticAccountSwitchForRunner(saved, 178, selectedCodex), saved);
  assert.deepEqual(saved, { enabled: true, revision: 4 }, "compatibility must not mutate the saved preference");
});

test("a selection disables an older runner even without a saved preference", () => {
  const selectedClaude = [{ family: "claude" as const }];
  assert.deepEqual(automaticAccountSwitchForRunner(null, 177, selectedClaude), {
    enabled: false, revision: 1,
  });
  assert.equal(automaticAccountSwitchForRunner(null, 178, selectedClaude), undefined);
});
