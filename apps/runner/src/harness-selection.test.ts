import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessInstallationChoice } from "@wollipog/protocol";
import { automaticAccountSwitchAuthorityReady, synchronizedHarnessChoices } from "./harness-selection.js";

test("background selection remains compatible with pre-selection control planes but waits for v175 choices", () => {
  const choice: HarnessInstallationChoice = {
    family: "codex", context: { kind: "native" }, installationId: "selected",
  };
  assert.deepEqual(synchronizedHarnessChoices(174, undefined), [],
    "v174 cannot store a choice, so legacy usage and native adoption remain available");
  assert.equal(synchronizedHarnessChoices(175, undefined), null,
    "v175 can store a choice but cannot synchronize it, so background work fails closed");
  assert.equal(synchronizedHarnessChoices(176, [choice]), null,
    "v176 target-bound installations do not imply background selection support");
  assert.equal(synchronizedHarnessChoices(177, undefined), null,
    "a current control plane must include its authoritative choices");
  assert.deepEqual(synchronizedHarnessChoices(177, [choice]), [choice]);
});

test("automatic switching needs an authoritative setting and representable harness choices", () => {
  const choice: HarnessInstallationChoice = {
    family: "codex", context: { kind: "native" }, installationId: "selected",
  };
  assert.equal(automaticAccountSwitchAuthorityReady(172, [], true), false,
    "a pre-v173 control plane cannot establish the switching preference");
  assert.equal(automaticAccountSwitchAuthorityReady(174, [], true), true,
    "pre-selection peers can safely send the existing switching preference");
  assert.equal(automaticAccountSwitchAuthorityReady(176, null, true), false,
    "v175–176 peers can store choices but cannot synchronize them");
  assert.equal(automaticAccountSwitchAuthorityReady(178, [choice], false), false,
    "a missing or rejected configuration cannot revive a prior enabled value");
  assert.equal(automaticAccountSwitchAuthorityReady(178, [choice], true), true);
});
