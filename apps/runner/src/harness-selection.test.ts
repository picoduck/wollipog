import assert from "node:assert/strict";
import { test } from "node:test";
import type { HarnessInstallationChoice } from "@wollipog/protocol";
import { synchronizedHarnessChoices } from "./harness-selection.js";

test("background selection remains compatible with pre-selection control planes but waits for v175 choices", () => {
  const choice: HarnessInstallationChoice = {
    family: "codex", context: { kind: "native" }, installationId: "selected",
  };
  assert.deepEqual(synchronizedHarnessChoices(174, undefined), [],
    "v174 cannot store a choice, so legacy usage and native adoption remain available");
  assert.equal(synchronizedHarnessChoices(175, undefined), null,
    "v175 can store a choice but cannot synchronize it, so background work fails closed");
  assert.equal(synchronizedHarnessChoices(176, undefined), null,
    "a current control plane must include its authoritative choices");
  assert.deepEqual(synchronizedHarnessChoices(176, [choice]), [choice]);
});
