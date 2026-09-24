import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  codexCommandSkillName,
  codexSkillInputNames,
  codexSkillPathIndex,
  codexSkillsFromList,
} from "./codex-skill-catalog.js";

const read = (path: string) => ({ type: "read", command: `sed -n '1,200p' ${path}`, name: "SKILL.md", path });

test("codexSkillsFromList keeps enabled skills with a name and path across cwd entries", () => {
  const skills = codexSkillsFromList({ data: [
    { cwd: "/repo", errors: [], skills: [
      { name: "review", path: "/repo/.agents/skills/review/SKILL.md", scope: "repo", enabled: true },
      { name: "off", path: "/repo/.agents/skills/off/SKILL.md", scope: "repo", enabled: false },
      { name: "", path: "/repo/.agents/skills/blank/SKILL.md", enabled: true },
      { name: "no-path", enabled: true },
    ] },
    { cwd: "/other", errors: [], skills: [
      { name: "review-again", path: "/repo/.agents/skills/review/SKILL.md", scope: "repo", enabled: true },
      { name: "deploy", path: "/home/u/.codex/skills/deploy/SKILL.md", scope: "user", enabled: true },
    ] },
  ] });
  assert.deepEqual(skills, [
    { name: "review", path: "/repo/.agents/skills/review/SKILL.md" },
    { name: "deploy", path: "/home/u/.codex/skills/deploy/SKILL.md" },
  ]);
  assert.deepEqual(codexSkillsFromList(null), []);
  assert.deepEqual(codexSkillsFromList({ data: "nope" }), []);
});

test("codexSkillInputNames returns only explicit skill entries", () => {
  assert.deepEqual(codexSkillInputNames([
    { type: "text", text: "$review please", text_elements: [] },
    { type: "skill", name: "review", path: "/s/review/SKILL.md" },
    { type: "mention", name: "file", path: "/f" },
    { type: "skill", name: "" },
    { type: "skill", name: "deploy", path: "/s/deploy/SKILL.md" },
  ]), ["review", "deploy"]);
  assert.deepEqual(codexSkillInputNames(undefined), []);
});

test("codexCommandSkillName matches only commands that purely read one registered SKILL.md", () => {
  const index = codexSkillPathIndex([
    { name: "review", path: "/repo/.agents/skills/review/SKILL.md" },
    { name: "deploy", path: "/home/u/.codex/skills/deploy/SKILL.md" },
  ]);
  const none = false;
  assert.equal(codexCommandSkillName([read("/repo/.agents/skills/review/SKILL.md")], "/repo", index, none), "review");
  assert.equal(codexCommandSkillName([read(".agents/skills/review/SKILL.md")], "/repo", index, none), "review",
    "a relative read resolves against the command's cwd");
  assert.equal(codexCommandSkillName([
    read("/repo/.agents/skills/review/SKILL.md"), read("/repo/.agents/skills/review/SKILL.md"),
  ], "/repo", index, none), "review");
  assert.equal(codexCommandSkillName([
    read("/repo/.agents/skills/review/SKILL.md"), read("/home/u/.codex/skills/deploy/SKILL.md"),
  ], "/repo", index, none), undefined, "two different skills are not one invocation");
  assert.equal(codexCommandSkillName([
    read("/repo/.agents/skills/review/SKILL.md"), { type: "unknown", command: "rm -rf x" },
  ], "/repo", index, none), undefined, "a mixed command stays a command");
  assert.equal(codexCommandSkillName([read("/repo/skills/review/SKILL.md")], "/repo", index, none), undefined,
    "an unregistered SKILL.md with a registered name is not a skill use");
  const sameName = codexSkillPathIndex([
    { name: "review", path: "/repo/.agents/skills/review/SKILL.md" },
    { name: "review", path: "/home/u/.codex/skills/review/SKILL.md" },
  ]);
  assert.equal(codexCommandSkillName([
    read("/repo/.agents/skills/review/SKILL.md"), read("/home/u/.codex/skills/review/SKILL.md"),
  ], "/repo", sameName, none), undefined, "same-named skills in different scopes are different skills");
  assert.equal(codexCommandSkillName([read("SKILL.md")], undefined, index, none), undefined);
  assert.equal(codexCommandSkillName([], "/repo", index, none), undefined);
  assert.equal(codexCommandSkillName(undefined, "/repo", index, none), undefined);
  assert.equal(codexCommandSkillName([read("/repo/.agents/skills/review/SKILL.md")], "/repo", new Map(), none), undefined);
  assert.equal(codexCommandSkillName([read("C:\\u\\.codex\\skills\\deploy\\SKILL.md")], "C:\\repo",
    codexSkillPathIndex([{ name: "deploy", path: "C:\\u\\.codex\\skills\\deploy\\SKILL.md" }]), none), "deploy");
});

test("codexCommandSkillName canonicalizes a symlinked skill root only when allowed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "codex-skill-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, "store", "review");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "SKILL.md"), "---\nname: review\n---\n");
  mkdirSync(join(root, "skills"));
  symlinkSync(store, join(root, "skills", "review"), process.platform === "win32" ? "junction" : "dir");
  // skills/list reports the canonical target; the model reads through the root it was shown.
  const index = codexSkillPathIndex([{ name: "review", path: join(realpathSync(store), "SKILL.md") }]);
  const shown = [read(join(root, "skills", "review", "SKILL.md"))];
  assert.equal(codexCommandSkillName(shown, root, index, true), "review");
  assert.equal(codexCommandSkillName(shown, root, index, false), undefined);
  assert.equal(codexCommandSkillName([read(join(root, "skills", "missing", "SKILL.md"))], root, index, true), undefined);
  symlinkSync(join(store, "SKILL.md"), join(root, "alias.md"));
  assert.equal(codexCommandSkillName([read(join(root, "alias.md"))], root, index, true), undefined,
    "only a SKILL.md read is resolved on the host");
});
