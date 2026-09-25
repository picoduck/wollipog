import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  collectBuiltInSkills,
  GENERATED_MODULE,
  renderBuiltInSkillsModule,
} from "./generate-built-in-skills.mjs";

test("the checked-in built-in skills module matches the skills directory", () => {
  assert.equal(
    readFileSync(GENERATED_MODULE, "utf8"),
    renderBuiltInSkillsModule(collectBuiltInSkills()),
    "skills/ changed without regenerating the control plane's copy: run `pnpm generate:built-in-skills`",
  );
});

test("the shipped Wollipog skills are collected", () => {
  const skills = collectBuiltInSkills();
  assert.deepEqual(skills.map((skill) => skill.name), ["orchestrate-issues", "using-wollipog"]);
  assert.deepEqual(skills[0].files.map((file) => file.path), ["SKILL.md", "references/child-assignment.md"]);
});

test("collection keeps exact bytes, skips hidden entries and non-skill directories, and refuses links", () => {
  const root = mkdtempSync(join(tmpdir(), "built-in-skills-"));
  try {
    mkdirSync(join(root, "alpha", "nested"), { recursive: true });
    writeFileSync(join(root, "README.md"), "not a skill");
    writeFileSync(join(root, "alpha", "SKILL.md"), "---\nname: alpha\n---\r\nBody with `${x}` and \"quotes\"\n");
    writeFileSync(join(root, "alpha", "nested", "data.bin"), Buffer.from([0, 255, 1]));
    writeFileSync(join(root, "alpha", ".DS_Store"), "junk");
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "todo.md"), "no SKILL.md here");
    const skills = collectBuiltInSkills(root);
    assert.deepEqual(skills, [{
      name: "alpha",
      files: [
        { path: "SKILL.md", encoding: "utf8", content: "---\nname: alpha\n---\r\nBody with `${x}` and \"quotes\"\n" },
        { path: "nested/data.bin", encoding: "base64", content: Buffer.from([0, 255, 1]).toString("base64") },
      ],
    }]);

    // The rendered module evaluates back to the same bytes.
    const rendered = renderBuiltInSkillsModule(skills);
    const body = rendered.slice(rendered.indexOf("= [") + 2).replace(/;\s*$/, "");
    assert.deepEqual(new Function(`return ${body};`)(), skills);

    symlinkSync(join(root, "alpha", "SKILL.md"), join(root, "alpha", "link.md"));
    assert.throws(() => collectBuiltInSkills(root), /cannot contain links/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
