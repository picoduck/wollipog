import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectView } from "@wollipog/protocol";
import {
  draftAfterSave,
  projectSettingsChanges,
  projectSettingsDirty,
  projectSettingsErrors,
  projectSettingsValues,
  revealedAfterSave,
} from "./project-settings-draft.js";

function project(options: Partial<ProjectView> = {}): ProjectView {
  return {
    id: "project-1",
    name: "Alpha",
    hidden: false,
    locations: [],
    activeSessionCount: 0,
    unarchivedSessionCount: 0,
    totalSessionCount: 0,
    createdAt: 1,
    updatedAt: 1,
    childSessionDefaults: { costBudgetUsd: 5, maxToolCalls: 100 },
    ...options,
  };
}

test("a field nobody edited follows the saved project, and only an edit that differs is dirty", () => {
  const saved = project();
  assert.deepEqual(projectSettingsValues(saved, {}), { name: "Alpha", cost: "5", tools: "100" });
  assert.deepEqual(projectSettingsValues(project({ childSessionDefaults: null }), { name: "Beta" }), { name: "Beta", cost: "", tools: "" });
  assert.equal(projectSettingsDirty(saved, {}), false);
  assert.equal(projectSettingsDirty(saved, { name: "Alpha", cost: "5" }), false, "typed back to the saved value");
  assert.equal(projectSettingsDirty(saved, { tools: "" }), true);
});

test("each field says what is wrong in one sentence, and the two limits are set together or not at all", () => {
  const errors = (name: string, cost: string, tools: string) => projectSettingsErrors({ name, cost, tools });
  assert.deepEqual(errors("Alpha", "", ""), {}, "both empty is no limits");
  assert.deepEqual(errors("Alpha", "2.5", "30"), {});
  assert.deepEqual(errors("  ", "", ""), { name: "Enter a name for the project." });
  assert.deepEqual(errors("x".repeat(120), "", ""), {});
  assert.deepEqual(errors("x".repeat(121), "", ""), { name: "Use 120 characters or fewer." });
  assert.deepEqual(errors("Alpha", "-2", "30"), { cost: "Enter an amount above 0." });
  assert.deepEqual(errors("Alpha", "0", "30"), { cost: "Enter an amount above 0." });
  assert.deepEqual(errors("Alpha", "1e", "30"), { cost: "Enter an amount above 0." }, "text that is not a number is an error, never empty");
  assert.deepEqual(errors("Alpha", "2", "0"), { tools: "Enter a whole number above 0." });
  assert.deepEqual(errors("Alpha", "2", "1.5"), { tools: "Enter a whole number above 0." });
  assert.deepEqual(errors("Alpha", "2", ""), { tools: "Enter a tool-call limit too, or clear both for no limits." });
  assert.deepEqual(errors("Alpha", "", "30"), { cost: "Enter a cost limit too, or clear both for no limits." });
  assert.deepEqual(errors("Alpha", "-2", ""), {
    cost: "Enter an amount above 0.",
    tools: "Enter a tool-call limit too, or clear both for no limits.",
  });
});

test("the update carries only what changed: a trimmed name, and both limits or null", () => {
  const saved = project();
  const changes = (name: string, cost: string, tools: string, base = saved) => projectSettingsChanges(base, { name, cost, tools });
  assert.deepEqual(changes("Alpha", "5", "100"), {});
  assert.deepEqual(changes("Alpha ", "5.0", "100"), {}, "nothing that reads differently once parsed");
  assert.deepEqual(changes(" Beta ", "5", "100"), { name: "Beta" });
  assert.deepEqual(changes("Alpha", "2.5", "100"), { childSessionDefaults: { costBudgetUsd: 2.5, maxToolCalls: 100 } });
  assert.deepEqual(changes("Alpha", "", ""), { childSessionDefaults: null });
  assert.deepEqual(changes("Beta", "1", "2"), { name: "Beta", childSessionDefaults: { costBudgetUsd: 1, maxToolCalls: 2 } });
  assert.deepEqual(changes("Alpha", "", "", project({ childSessionDefaults: null })), {});
  assert.deepEqual(changes("Beta", "", "", project({ childSessionDefaults: undefined })), { name: "Beta" },
    "an older server, which sends no limits, is never sent any");
});

test("after a save, a field still showing what was sent leaves the draft, and one typed into meanwhile stays", () => {
  const sent = { name: "Beta", cost: "2", tools: "30" };
  assert.deepEqual(draftAfterSave({ name: "Beta", cost: "2", tools: "30" }, sent), {});
  assert.deepEqual(draftAfterSave({ name: "Betamax", cost: "2" }, sent), { name: "Betamax" });
});

test("after a save, only fields still in the draft keep their errors shown", () => {
  const revealed = new Set(["name", "cost", "tools"] as const);
  assert.deepEqual([...revealedAfterSave(revealed, { cost: "-2" })], ["cost"]);
  assert.deepEqual([...revealedAfterSave(revealed, {})], []);
  assert.deepEqual([...revealedAfterSave(new Set(["name"] as const), { cost: "-2" })], [],
    "a field typed into but never left keeps waiting for its leave");
});
