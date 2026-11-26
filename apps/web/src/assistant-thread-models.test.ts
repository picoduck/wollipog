import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantThreadHarnessOption } from "@wollipog/protocol";
import { assistantEffortChoices, effortAfterModelChange, effortsFor, modelEffortProblem } from "./assistant-thread-models.js";

// Codex discovery lists the union of its models' efforts as the installation's.
const codex: AssistantThreadHarnessOption = {
  id: "codex", label: "Codex", available: true, effortLevels: ["low", "medium", "high", "xhigh"],
  models: [
    { id: "gpt-default", displayName: "Default", default: true, efforts: ["medium", "high"] },
    { id: "gpt-deep", displayName: "Deep", efforts: ["medium", "high", "xhigh"] },
  ],
};

test("Automatic offers only the efforts of the model the launch will pick", () => {
  assert.deepEqual(effortsFor(codex, null), ["medium", "high"]);
  assert.deepEqual(assistantEffortChoices(codex, null, null).map((choice) => choice.value), ["__automatic__", "medium", "high"]);
  // An effort only another model supports is not offered, and a saved one says why.
  assert.equal(modelEffortProblem(codex, null, "xhigh")?.field, "effort");
  assert.equal(effortAfterModelChange(codex, null, "xhigh"), null);
  assert.deepEqual(effortsFor(codex, "gpt-deep"), ["medium", "high", "xhigh"]);
});

test("without an advertised default, Automatic offers only efforts every model accepts", () => {
  const option = { ...codex, models: codex.models!.map((model) => ({ ...model, default: false })) };
  assert.deepEqual(effortsFor(option, null), ["medium", "high"]);
  // A model without its own list accepts the installation's.
  assert.deepEqual(effortsFor({ ...option, models: [{ id: "plain" }] }, null), ["low", "medium", "high", "xhigh"]);
});

test("a model the harness no longer reports is a problem, and Automatic never is", () => {
  assert.equal(modelEffortProblem(codex, "retired", null)?.field, "model");
  assert.equal(modelEffortProblem(codex, null, null), null);
  // An older control plane reports no models, and nothing is offered or checked.
  assert.equal(modelEffortProblem({ id: "codex", label: "Codex", available: true }, "anything", "xhigh"), null);
});
