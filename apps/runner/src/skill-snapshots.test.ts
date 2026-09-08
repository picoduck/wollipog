import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentDefinition, SKILL_MAX_FILE_BYTES } from "@wollipog/protocol";
import { MachineSkillSnapshots } from "./skill-snapshots.js";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";

const agents: AgentDefinition[] = [{ id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex", available: true }];
const message = { type: "skill_snapshot" as const, runnerId: "runner", requestId: "request", operation: "list" as const };
test("machine snapshot discovery is bounded metadata; reading pins parents and returns immutable content without writes", { skip: process.platform !== "linux" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "skill-snapshot-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, ".codex/skills/alpha");
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "SKILL.md"), "---\nname: alpha\n---\nInstructions");
  writeFileSync(join(root, "scripts/a.sh"), "echo never-executed", { mode: 0o755 });
  writeFileSync(join(root, "binary"), Buffer.from([0, 255, 254]));
  const snapshots = new MachineSkillSnapshots({ home, agents: () => agents });
  const listed = snapshots.handle(message);
  assert.equal(listed.candidates?.length, 1);
  assert.equal(listed.snapshot, undefined);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(home));
  const candidate = listed.candidates![0]!;
  assert.equal(candidate.sourceDirectory, ".codex/skills");
  const read = snapshots.handle({ ...message, operation: "read", candidateId: candidate.id });
  assert.equal(read.error, undefined);
  assert.equal(read.snapshot?.files.length, 3);
  assert.equal(read.snapshot?.digest, skillVersionDigest(read.snapshot!.files));
  assert.equal(read.snapshot!.files.find((file) => file.path === "binary")!.encoding, "base64");
  assert.deepEqual(read.snapshot!.executablePaths, ["scripts/a.sh"]);
  assert.equal(readFileSync(join(root, "scripts/a.sh"), "utf8"), "echo never-executed");
  assert.ok(snapshots.handle({ ...message, operation: "read", candidateId: root }).error);
  renameSync(root, `${root}-old`);
  symlinkSync(`${root}-old`, root);
  assert.ok(snapshots.handle({ ...message, operation: "read", candidateId: candidate.id }).error);
});

for (const unsafe of ["file-link", "directory-link", "hard-link", "oversized", "too-many", "stale", "expired", "parent-link"]) {
  test(`machine snapshots reject ${unsafe}`, { skip: process.platform !== "linux" }, (t) => {
    const home = mkdtempSync(join(tmpdir(), "skill-snapshot-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const root = join(home, ".codex/skills/alpha");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "---\nname: alpha\n---\nInstructions");
    writeFileSync(join(home, "secret"), "secret");
    if (unsafe === "file-link") symlinkSync(join(home, "secret"), join(root, "leak"));
    if (unsafe === "directory-link") symlinkSync(home, join(root, "leak"));
    if (unsafe === "hard-link") linkSync(join(home, "secret"), join(root, "leak"));
    if (unsafe === "oversized") writeFileSync(join(root, "large"), Buffer.alloc(SKILL_MAX_FILE_BYTES + 1));
    if (unsafe === "too-many") for (let i = 0; i < 65; i++) writeFileSync(join(root, `file-${i}`), "x");
    let now = 1;
    if (unsafe === "stale") {
      // CI filesystems can coarsen directory timestamps. Force identical timestamps so adding
      // a directory entry must be caught by the generation's metadata listing, not clock luck.
      const original = fs.fstatSync;
      t.mock.method(fs, "fstatSync", (fd: number) => {
        const stat = original(fd);
        if (stat.isDirectory()) { stat.ctimeMs = 0; stat.mtimeMs = 0; }
        return stat;
      });
      syncBuiltinESMExports();
      t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    }
    const snapshots = new MachineSkillSnapshots({ home, agents: () => agents, now: () => now });
    const candidate = snapshots.handle(message).candidates![0]!;
    if (unsafe === "stale") writeFileSync(join(root, "new-file"), "changed generation");
    if (unsafe === "expired") now += 600_001;
    if (unsafe === "parent-link") {
      renameSync(join(home, ".codex"), join(home, "moved"));
      symlinkSync(join(home, "moved"), join(home, ".codex"));
    }
    const result = snapshots.handle({ ...message, operation: "read", candidateId: candidate.id });
    assert.ok(result.error);
    assert.equal(result.snapshot, undefined);
    assert.doesNotMatch(result.error!, /secret/);
  });
}
test("unsupported platforms never attempt filesystem discovery", () => {
  const snapshots = new MachineSkillSnapshots({ home: "/does-not-exist", agents: () => agents, platform: "win32" });
  assert.match(snapshots.handle(message).error!, /Linux or macOS/);
});

test("the macOS descriptor adapter discovers and reads through /dev/fd", { skip: process.platform === "win32" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "skill-snapshot-darwin-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, ".codex/skills/alpha");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), "---\nname: alpha\n---\nmacOS snapshot");
  const snapshots = new MachineSkillSnapshots({ home, agents: () => agents, platform: "darwin" });
  const candidate = snapshots.handle(message).candidates?.[0];
  assert.ok(candidate);
  const read = snapshots.handle({ ...message, operation: "read", candidateId: candidate.id });
  assert.equal(read.error, undefined);
  assert.match(read.snapshot?.files[0]?.content ?? "", /macOS snapshot/);
});

test("machine discovery keeps separate hard raw and useful-entry bounds", { skip: process.platform !== "linux" }, (t) => {
  const home = mkdtempSync(join(tmpdir(), "skill-snapshot-bounds-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const skills = join(home, ".codex/skills");
  mkdirSync(skills, { recursive: true });
  for (let index = 0; index < 256; index++) {
    mkdirSync(join(skills, `.wollipog-adoption-${String(index).padStart(3, "0")}`));
  }
  for (let index = 0; index < 64; index++) {
    const root = join(skills, `skill-${String(index).padStart(3, "0")}`);
    mkdirSync(root);
    writeFileSync(join(root, "SKILL.md"), `---\nname: skill-${index}\n---\nBody`);
  }
  const snapshots = new MachineSkillSnapshots({ home, agents: () => agents });
  assert.equal(snapshots.handle(message).candidates?.length, 64,
    "private journals do not consume the 256 useful-entry or 64 candidate budget");

  const hardBound = new MachineSkillSnapshots({ home, agents: () => agents, maxRawEntriesPerDirectory: 0 });
  assert.deepEqual(hardBound.handle(message).candidates, [], "raw directory iteration remains independently bounded");
});
