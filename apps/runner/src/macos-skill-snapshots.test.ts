import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  listMacosSkillCandidates,
  parseMacosSkillCandidates,
  parseMacosSkillSnapshot,
  readMacosSkillCandidate,
} from "./macos-skill-snapshots.js";

const u32 = (value: number) => {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
};
const blob = (value: string | Buffer) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
};

test("macOS helper candidate output is strictly projected", () => {
  const output = Buffer.concat([
    Buffer.from("WMS1L"), u32(1), blob(".agents/skills"), blob("review"), blob("a".repeat(64)),
  ]);
  assert.deepEqual(parseMacosSkillCandidates(output, [".agents/skills"]), [{
    sourceDirectory: ".agents/skills", name: "review", generation: "a".repeat(64),
  }]);
  assert.throws(() => parseMacosSkillCandidates(Buffer.concat([output, Buffer.from("extra")]), [".agents/skills"]));
  assert.throws(() => parseMacosSkillCandidates(Buffer.concat([
    Buffer.from("WMS1L"), u32(1), blob(".other/skills"), blob("review"), blob("a".repeat(64)),
  ]), [".agents/skills"]));
});

test("macOS helper snapshot output enforces paths, bounds, and canonical bytes", () => {
  const output = Buffer.concat([
    Buffer.from("WMS1R"), blob("b".repeat(64)), u32(2),
    blob("SKILL.md"), Buffer.from([0]), blob("---\nname: review\n---\n"),
    blob("scripts/check.sh"), Buffer.from([1]), blob("#!/bin/sh\n"),
  ]);
  assert.deepEqual(parseMacosSkillSnapshot(output), {
    generation: "b".repeat(64),
    files: [
      { path: "SKILL.md", encoding: "base64", content: Buffer.from("---\nname: review\n---\n").toString("base64") },
      { path: "scripts/check.sh", encoding: "base64", content: Buffer.from("#!/bin/sh\n").toString("base64") },
    ],
    executablePaths: ["scripts/check.sh"],
  });
  const invalidPath = Buffer.concat([
    Buffer.from("WMS1R"), blob("b".repeat(64)), u32(1), blob("../SKILL.md"), Buffer.from([0]), blob("x"),
  ]);
  assert.throws(() => parseMacosSkillSnapshot(invalidPath));
});

test("native macOS snapshots use descriptor-relative no-follow traversal", {
  skip: process.platform !== "darwin",
}, (t) => {
  const home = mkdtempSync(join(tmpdir(), "wollipog-macos-snapshot-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, ".agents", "skills", "review");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "SKILL.md"), "---\nname: review\n---\n");
  writeFileSync(join(root, "scripts", "check.sh"), "#!/bin/sh\n");
  chmodSync(join(root, "scripts", "check.sh"), 0o755);
  symlinkSync(root, join(home, ".agents", "skills", "linked"));

  const candidates = listMacosSkillCandidates(home, [".agents/skills"]);
  assert.deepEqual(candidates.map((entry) => entry.name), ["review"]);
  const candidate = { id: "opaque", ...candidates[0]! };
  const snapshot = readMacosSkillCandidate(home, candidate);
  assert.deepEqual(snapshot.files.map((file) => file.path), ["SKILL.md", "scripts/check.sh"]);
  assert.deepEqual(snapshot.executablePaths, ["scripts/check.sh"]);

  linkSync(join(root, "SKILL.md"), join(root, "duplicate.md"));
  assert.throws(() => readMacosSkillCandidate(home, candidate), /./u);
});
