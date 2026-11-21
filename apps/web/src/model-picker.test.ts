import assert from "node:assert/strict";
import test from "node:test";
import { buildModelPicker, parseModelPickerCatalog } from "./model-picker.js";

const rows = [
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "opus", label: "Opus 5.5 (opus)" },
  { value: "claude-opus-5", label: "Opus 5" },
  { value: "claude-opus-5-5", label: "Opus 5.5 (claude-opus-5-5)" },
  { value: "new-unknown-model", label: "New Model" },
];

test("launch settings show the alias first with a distinct label and retain the saved older release", () => {
  const picker = buildModelPicker(rows, "claude-opus-5", { mode: "launch", driver: "claude-code" });
  assert.deepEqual(picker.groups.map(group => group.name), ["Opus"]);
  assert.deepEqual(picker.groups[0]!.options.map(row => [row.value, row.label, Boolean(row.legacy)]), [
    ["opus", "Opus Latest", false],
    ["claude-opus-5-5", "Opus 5.5", false],
    ["claude-opus-5", "Opus 5", true],
    ["claude-opus-4-8", "Opus 4.8", true],
  ]);
  assert.deepEqual(picker.trailing.map(option => option.value), ["new-unknown-model"]);
});

test("exact picker retains a saved alias without offering it and never invents missing pins", () => {
  const picker = buildModelPicker(rows, "opus", { mode: "exact", driver: "claude-code" });
  assert.equal(picker.groups[0]!.options[0]!.value, "claude-opus-5-5");
  assert.equal(picker.groups.flatMap(group => group.options).some(option => option.value === "opus"), false);
  assert.equal(picker.trailing.find(option => option.value === "opus")?.retained, true);
  const missing = buildModelPicker([rows[1]!], "claude-opus-5-5", { mode: "exact", driver: "claude-code" });
  assert.equal(missing.groups.length, 0);
  assert.equal(missing.trailing[0]?.retained, true);
});

test("Gemini siblings keep independently selectable IDs without a Latest route", () => {
  const ids = ["gemini-4-hydrogen", "gemini-4-neon", "gemini-4-carbon"];
  const picker = buildModelPicker(ids.map(id => ({ value: id, label: id })), null, { mode: "launch", driver: "acp" });
  assert.deepEqual(picker.groups[0]?.options.map(option => [option.value, option.legacy]),
    [["gemini-4-neon", false], ["gemini-4-carbon", false], ["gemini-4-hydrogen", false]]);
});

test("catalog edits must have unique names and exact IDs, with only supported native aliases", () => {
  const family = { label: "Opus", alias: "opus", releases: ["claude-opus-5-5"] };
  const valid = { version: 2, families: [family] };
  assert.deepEqual(parseModelPickerCatalog(valid), valid);
  assert.equal(parseModelPickerCatalog({ version: 2, families: [family, { ...family, label: "Other" }] }), null);
  assert.equal(parseModelPickerCatalog({ version: 2, families: [{ ...family, alias: "gpt-latest" }] }), null);
});
