import assert from "node:assert/strict";
import test from "node:test";
import { launchModelChoice, managedModelChoices } from "./managed-model-choice.js";

test("Pi Latest uses only visible fixed releases from the family's provider", () => {
  const opus = "wollipog:latest:opus";
  const models = [
    { id: "anthropic/claude-opus-4-5" },
    { id: "anthropic/claude-opus-4-8" },
    { id: "anthropic/claude-opus-5-10", efforts: ["high"] },
    { id: "anthropic/claude-opus-5-9" },
    { id: "anthropic/claude-opus-6", hidden: true },
    { id: "anthropic/claude-opus-6-preview" },
    { id: "openrouter/anthropic/claude-opus-6" },
    { id: "zai/glm-5.3" },
  ];
  const live = { modelSource: "live" as const, models };
  assert.deepEqual(managedModelChoices("pi", live).map(choice => [choice.id, choice.resolvedModelId]), [
    [opus, "anthropic/claude-opus-5-10"],
    ["wollipog:latest:glm-flagship", "zai/glm-5.3"],
  ]);
  assert.deepEqual(launchModelChoice("pi", live, opus)?.efforts, ["high"]);
  assert.equal(launchModelChoice("pi", { ...live, modelSource: "cached" }, opus), undefined);
  assert.equal(launchModelChoice("acp", live, opus), undefined);
  assert.deepEqual(managedModelChoices("pi", { ...live, models: [models[0]!, models[6]!] }), []);
  assert.equal(launchModelChoice("pi", live, "anthropic/claude-opus-4-5")?.id, "anthropic/claude-opus-4-5");
});
