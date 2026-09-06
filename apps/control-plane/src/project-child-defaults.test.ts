import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlPlaneDb } from "./db.js";

test("project defaults persist independently and reset without changing other project fields", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const project = db.createProject({ name: "Children" });
    assert.equal(project.childSessionDefaults, null);
    const defaults = { costBudgetUsd: 2.5, maxToolCalls: 30 };
    assert.deepEqual(db.updateProject(project.id, { childSessionDefaults: defaults })!.childSessionDefaults, defaults);
    db.updateProject(project.id, { name: "Renamed", hidden: true });
    assert.deepEqual(db.projectChildSessionDefaults(project.id), defaults);
    assert.throws(() => db.updateProject(project.id, {
      childSessionDefaults: { costBudgetUsd: Infinity, maxToolCalls: 3 },
    }), /invalid/);
    assert.deepEqual(db.projectChildSessionDefaults(project.id), defaults);
    const reset = db.updateProject(project.id, { childSessionDefaults: null })!;
    assert.equal(reset.childSessionDefaults, null);
    assert.equal(reset.name, "Renamed");
    assert.equal(reset.hidden, true);
  } finally { db.close(); }
});
