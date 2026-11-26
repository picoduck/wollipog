import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantThreadAccountChoices } from "@wollipog/protocol";
import { MACHINE_ACCOUNT_POLICY, assistantAccountOptions } from "./AssistantThreadAccountField.js";

const refused: AssistantThreadAccountChoices = {
  accounts: [{ accountRef: "acct:saved", label: "Saved", reason: "signed_out" }, { accountRef: "acct:work", label: "Work" }],
  policyRefusal: "The Machine's policy has no account it can use right now.",
};

test("a launch offers Machine Policy only while the Machine would use it", () => {
  const values = assistantAccountOptions(refused, ["Saved", "Work"]).map((option) => option.value);
  assert.deepEqual(values, ["acct:work", "acct:saved"]);
});

test("the saved default keeps Machine Policy, the way back from an unavailable saved account", () => {
  const options = assistantAccountOptions(refused, ["Saved", "Work"], "default");
  assert.deepEqual(options.map((option) => option.value), [MACHINE_ACCOUNT_POLICY, "acct:work", "acct:saved"]);
  assert.equal(options[0]!.disabled, undefined);
  assert.equal(options[2]!.disabled, true);
  assert.match(options[2]!.disabledReason!, /needs sign-in/);
});
