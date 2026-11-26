import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantThreadHarnessOption } from "@wollipog/protocol";
import { assistantEffortChoices, effortAfterModelChange, effortsFor, modelEffortProblem } from "./assistant-thread-models.js";

// Codex discovery lists the union of its models' efforts as the installation's.
const codex: AssistantThreadHarnessOption = {
  id: "codex", label: "Codex", available: true, driver: "codex-app-server", effortLevels: ["low", "medium", "high", "xhigh"],
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

test("without an advertised default, Automatic follows the model the launch prefers", () => {
  // Claude Code's launch prefers Opus; the other model accepts only Low.
  const claude: AssistantThreadHarnessOption = {
    id: "claude-code", label: "Claude Code", available: true, driver: "claude-code", effortLevels: ["low", "high"],
    models: [{ id: "claude-sonnet-4-6", efforts: ["low"] }, { id: "claude-opus-4-7", efforts: ["high"] }],
  };
  assert.deepEqual(effortsFor(claude, null), ["high"]);
  assert.equal(modelEffortProblem(claude, null, "high"), null);
  // With no preferred model either, the first compatible model by id.
  const plain = { ...codex, models: codex.models!.map((model) => ({ ...model, default: false })) };
  assert.deepEqual(effortsFor(plain, null), ["medium", "high", "xhigh"]);
});

test("a model the harness no longer reports is a problem, and Automatic never is", () => {
  assert.equal(modelEffortProblem(codex, "retired", null)?.field, "model");
  assert.equal(modelEffortProblem(codex, null, null), null);
  // An older control plane reports no models, and nothing is offered or checked.
  assert.equal(modelEffortProblem({ id: "codex", label: "Codex", available: true }, "anything", "xhigh"), null);
});
