import assert from "node:assert/strict";
import { test } from "node:test";
import { SKILL_TOOL_KIND, skillToolTitle } from "./skill-tool.js";

test("skillToolTitle names the skill and clips a one-line argument preview", () => {
  assert.equal(SKILL_TOOL_KIND, "skill");
  assert.equal(skillToolTitle("codex-review"), "Skill: codex-review");
  assert.equal(skillToolTitle("plugin:deploy", "  --env\tstaging\n"), "Skill: plugin:deploy --env staging");
  assert.equal(skillToolTitle("review", "a".repeat(61)), `Skill: review ${"a".repeat(60)}…`);
  assert.equal(skillToolTitle("n".repeat(81)), `Skill: ${"n".repeat(80)}…`);
});

test("skillToolTitle neutralizes control and bidi characters and degrades without a name", () => {
  assert.equal(skillToolTitle("evil‮name\u0007"), "Skill: evil name");
  assert.equal(skillToolTitle(undefined, "args"), "Skill");
  assert.equal(skillToolTitle("   "), "Skill");
  assert.equal(skillToolTitle(42), "Skill");
  assert.equal(skillToolTitle("review", { nested: true }), "Skill: review");
});
