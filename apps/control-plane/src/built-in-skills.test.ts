import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition, RunnerMetadata, SkillFile } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { PERSONAL_ORGANIZATION_ID } from "./identity.js";
import { builtInSkills, seedBuiltInSkills, type BuiltInSkill } from "./built-in-skills.js";
import { repairLegacySkillDescriptions, resolveDesiredSkillSnapshot, validateSkillPayload } from "./skills.js";

const AGENTS: AgentDefinition[] = [
  { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" },
  { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" },
];

const runnerMeta = (runnerId: string): RunnerMetadata => ({
  runnerId, hostname: `${runnerId}-host`, os: "linux", version: "1.0.0", agents: AGENTS, workspaces: [],
});

function files(name: string, body: string): SkillFile[] {
  return [{ path: "SKILL.md", encoding: "utf8", content: `---\nname: ${name}\ndescription: ${name} guide.\n---\n${body}\n` }];
}

/** A release's built-in skill, exactly as builtInSkills() would compile it. */
function release(version: string, body: string, name = "using-wollipog"): BuiltInSkill {
  const [skill] = builtInSkills([{ name, files: files(name, body) }], version);
  return skill!;
}

function versionCount(db: ControlPlaneDb, skillId: string): number {
  return db.listSkillVersions(skillId).versions.length;
}

function desiredDigest(db: ControlPlaneDb, runnerId: string, name: string): string | undefined {
  return resolveDesiredSkillSnapshot(db, runnerId).find((entry) => entry.name === name)?.versionDigest;
}

test("the release ships using-wollipog and orchestrate-issues as valid library skills", () => {
  const skills = builtInSkills();
  assert.deepEqual(skills.map((skill) => skill.name), ["orchestrate-issues", "using-wollipog"]);
  for (const skill of skills) {
    assert.ok(skill.description, `${skill.name} has a frontmatter description`);
    const validated = validateSkillPayload({ name: skill.name, files: skill.files });
    assert.ok(validated.ok);
    assert.equal(validated.digest, skill.digest);
  }
});

test("a fresh installation lists built-in skills unassigned and writes nothing to any machine", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    db.registerRunner(runnerMeta("laptop"), 10, 90);
    const outcomes = seedBuiltInSkills(db, builtInSkills(), 100);
    assert.deepEqual(outcomes, { "orchestrate-issues": "created", "using-wollipog": "created" });
    for (const skill of db.listSkills()) {
      assert.equal(skill.source, "builtin");
      assert.equal(skill.assignmentCount, 0);
      assert.deepEqual(skill.builtIn, { release: builtInSkills()[0]!.release, heldUpdate: null });
      assert.equal(skill.builtInOffer, undefined);
      assert.deepEqual(db.skillScope(skill.id), {
        organizationId: PERSONAL_ORGANIZATION_ID,
        owner: { kind: "organization", organizationId: PERSONAL_ORGANIZATION_ID },
      });
      const version = db.getSkillVersion(skill.latestVersion!.id)!;
      assert.equal(version.builtInSource?.digest, version.digest);
    }
    assert.deepEqual(resolveDesiredSkillSnapshot(db, "laptop"), []);

    // Restarting the same release changes nothing.
    assert.deepEqual(seedBuiltInSkills(db, builtInSkills(), 200), { "orchestrate-issues": "unchanged", "using-wollipog": "unchanged" });
    for (const skill of db.listSkills()) assert.equal(versionCount(db, skill.id), 1);
  } finally {
    db.close();
  }
});

test("an upgrade that changes a built-in reaches track-latest machines and not pinned ones", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    for (const id of ["tracking", "pinned"]) db.registerRunner(runnerMeta(id), 10, 90);
    seedBuiltInSkills(db, [release("1.0.0", "First.")], 100);
    const skill = db.getSkillByName("using-wollipog")!;
    const first = skill.latestVersion!;
    db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
    db.setMachineSkillVersion(skill.id, "pinned", first.id, null, first.id);

    assert.deepEqual(seedBuiltInSkills(db, [release("1.1.0", "Second.")], 200), { "using-wollipog": "updated" });
    const updated = db.getSkill(skill.id)!;
    const second = db.getSkillVersion(updated.latestVersion!.id)!;
    assert.notEqual(second.digest, first.digest);
    assert.equal(second.note, "Built-in skill from Wollipog 1.1.0");
    assert.deepEqual(second.builtInSource, { release: "1.1.0", digest: second.digest });
    assert.deepEqual(updated.builtIn, { release: "1.1.0", heldUpdate: null });
    assert.equal(desiredDigest(db, "tracking", "using-wollipog"), second.digest);
    assert.equal(desiredDigest(db, "pinned", "using-wollipog"), first.digest);
  } finally {
    db.close();
  }
});

test("release content waits for review when the library's latest version has local changes", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    db.registerRunner(runnerMeta("laptop"), 10, 90);
    seedBuiltInSkills(db, [release("1.0.0", "First.")], 100);
    const skill = db.getSkillByName("using-wollipog")!;
    db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
    const edited = validateSkillPayload({ name: "using-wollipog", files: files("using-wollipog", "Edited locally.") });
    assert.ok(edited.ok);
    db.addSkillVersion(skill.id, edited, 150);

    // A local edit alone is not a release update.
    assert.deepEqual(seedBuiltInSkills(db, [release("1.0.0", "First.")], 160), { "using-wollipog": "unchanged" });
    assert.equal(db.getSkill(skill.id)!.builtIn!.heldUpdate, null);

    const next = release("1.1.0", "Second.");
    assert.deepEqual(seedBuiltInSkills(db, [next], 200), { "using-wollipog": "held" });
    const held = db.getSkill(skill.id)!;
    assert.deepEqual(held.builtIn, { release: "1.1.0", heldUpdate: { release: "1.1.0", digest: next.digest } });
    assert.equal(versionCount(db, skill.id), 2);
    assert.equal(desiredDigest(db, "laptop", "using-wollipog"), edited.digest);

    const { changed } = db.acceptBuiltInSkillVersion({ skillId: skill.id, ...next, expectedLatestVersionId: held.latestVersion!.id });
    assert.equal(changed, true);
    assert.deepEqual(db.getSkill(skill.id)!.builtIn, { release: "1.1.0", heldUpdate: null });
    assert.equal(desiredDigest(db, "laptop", "using-wollipog"), next.digest);
    assert.deepEqual(seedBuiltInSkills(db, [next], 300), { "using-wollipog": "unchanged" });
  } finally {
    db.close();
  }
});

test("a same-name user-managed skill is never modified by seeding and can adopt the built-in on acceptance", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    for (const id of ["tracking", "pinned"]) db.registerRunner(runnerMeta(id), 10, 90);
    const imported = validateSkillPayload({ name: "using-wollipog", files: files("using-wollipog", "From Git.") });
    assert.ok(imported.ok);
    const gitSource = { url: "https://example.test/wollipog.git", ref: "main", subdirectory: "skills", path: "skills/using-wollipog", commit: "a".repeat(40) };
    const userSkill = db.importGitSkill({ ...imported, source: gitSource, expectedVersionId: null,
      scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "organization", organizationId: PERSONAL_ORGANIZATION_ID } } });
    db.setSkillGitAutoUpdate(userSkill.id, true, 50);
    const assignment = db.createSkillAssignment({ skillId: userSkill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
    const userVersion = userSkill.latestVersion!;
    db.setMachineSkillVersion(userSkill.id, "pinned", userVersion.id, null, userVersion.id);
    const before = db.getSkill(userSkill.id)!;

    const first = release("1.0.0", "First.");
    assert.deepEqual(seedBuiltInSkills(db, [first], 100), { "using-wollipog": "user_managed" });
    const offered = db.getSkill(userSkill.id)!;
    assert.deepEqual(offered.builtInOffer, { release: "1.0.0", digest: first.digest });
    assert.equal(offered.builtIn, undefined);
    assert.deepEqual({ ...offered, builtInOffer: undefined }, { ...before, builtInOffer: undefined });
    assert.equal(versionCount(db, userSkill.id), 1);
    assert.equal(offered.gitAutoUpdate?.enabled, true);

    // A stale review is refused.
    assert.throws(() => db.acceptBuiltInSkillVersion({ skillId: userSkill.id, ...first, expectedLatestVersionId: "skillv_stale" }),
      /changed/);

    const { skill: adopted, changed } = db.acceptBuiltInSkillVersion({ skillId: userSkill.id, ...first, expectedLatestVersionId: userVersion.id });
    assert.equal(changed, true);
    assert.equal(adopted.source, "builtin");
    assert.deepEqual(adopted.builtIn, { release: "1.0.0", heldUpdate: null });
    assert.equal(adopted.builtInOffer, undefined);
    assert.equal(adopted.gitAutoUpdate?.enabled, false);
    assert.deepEqual(db.getSkillAssignment(assignment.id), assignment);
    assert.equal(db.getMachineSkillVersion(userSkill.id, "pinned")?.versionId, userVersion.id);
    assert.equal(desiredDigest(db, "tracking", "using-wollipog"), first.digest);
    assert.equal(desiredDigest(db, "pinned", "using-wollipog"), imported.digest);

    // From now on releases update it like a fresh install.
    const second = release("1.1.0", "Second.");
    assert.deepEqual(seedBuiltInSkills(db, [second], 200), { "using-wollipog": "updated" });
    assert.equal(desiredDigest(db, "tracking", "using-wollipog"), second.digest);
    assert.equal(desiredDigest(db, "pinned", "using-wollipog"), imported.digest);
  } finally {
    db.close();
  }
});

test("a same-name private or foreign-organization skill is not offered the built-in, so it can never become one", () => {
  for (const scope of [
    { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user" as const, userId: "usr_private" } },
    { organizationId: "org_foreign", owner: { kind: "organization" as const, organizationId: "org_foreign" } },
  ]) {
    const db = ControlPlaneDb.open(":memory:");
    try {
      const first = release("1.0.0", "First.");
      const mine = db.createSkill({ ...release("0.0.1", "Mine."), scope, now: 10 });
      assert.deepEqual(seedBuiltInSkills(db, [first], 100), { "using-wollipog": "user_managed" });
      assert.equal(db.getSkill(mine.id)!.builtInOffer, undefined);
      assert.throws(() => db.acceptBuiltInSkillVersion({ skillId: mine.id, ...first, expectedLatestVersionId: mine.latestVersion!.id }),
        /changed/);
      // Its deletion frees the name for the organization-owned built-in instead of declining it.
      db.deleteSkill(mine.id);
      assert.deepEqual(seedBuiltInSkills(db, [first], 200), { "using-wollipog": "created" });
    } finally {
      db.close();
    }
  }
});

test("adopting identical content records provenance without adding a version", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const first = release("1.0.0", "Same.");
    const userSkill = db.createSkill({ ...first, now: 10 });
    seedBuiltInSkills(db, [first], 100);
    const { skill, changed } = db.acceptBuiltInSkillVersion({ skillId: userSkill.id, ...first, expectedLatestVersionId: userSkill.latestVersion!.id });
    assert.equal(changed, false);
    assert.equal(versionCount(db, skill.id), 1);
    assert.deepEqual(db.getSkillVersion(skill.latestVersion!.id)!.builtInSource, { release: "1.0.0", digest: first.digest });
  } finally {
    db.close();
  }
});

test("a deleted built-in is never re-created, and a later same-name skill is only offered it", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const first = release("1.0.0", "First.");
    seedBuiltInSkills(db, [first], 100);
    const skill = db.getSkillByName("using-wollipog")!;
    db.setSkillRecommendationDismissed("usr_a", skill.id, true, 110);
    assert.ok(db.deleteSkill(skill.id));
    assert.deepEqual(db.skillRecommendationDismissals("usr_a"), new Set());

    assert.deepEqual(seedBuiltInSkills(db, [release("1.1.0", "Second.")], 200), { "using-wollipog": "deleted" });
    assert.equal(db.getSkillByName("using-wollipog"), null);

    const mine = db.createSkill({ ...release("0.0.1", "Mine."), now: 300 });
    assert.deepEqual(seedBuiltInSkills(db, [first], 400), { "using-wollipog": "deleted" });
    const current = db.getSkill(mine.id)!;
    assert.deepEqual(current.builtInOffer, { release: "1.0.0", digest: first.digest });
    assert.equal(versionCount(db, mine.id), 1);
  } finally {
    db.close();
  }
});

test("a name freed by deleting the user-managed skill becomes the built-in at the next start", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const first = release("1.0.0", "First.");
    const mine = db.createSkill({ ...release("0.0.1", "Mine."), now: 10 });
    assert.deepEqual(seedBuiltInSkills(db, [first], 100), { "using-wollipog": "user_managed" });
    db.deleteSkill(mine.id);
    assert.deepEqual(seedBuiltInSkills(db, [first], 200), { "using-wollipog": "created" });
    assert.ok(db.getSkillByName("using-wollipog")!.builtIn);
  } finally {
    db.close();
  }
});

test("a release that stops shipping a built-in leaves an ordinary library skill", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedBuiltInSkills(db, [release("1.0.0", "First."), release("1.0.0", "Other.", "orchestrate-issues")], 100);
    assert.deepEqual(seedBuiltInSkills(db, [release("1.1.0", "First.")], 200), { "using-wollipog": "unchanged" });
    const withdrawn = db.getSkillByName("orchestrate-issues")!;
    assert.equal(withdrawn.builtIn, undefined);
    assert.equal(withdrawn.builtInOffer, undefined);
    assert.ok(db.getSkillByName("using-wollipog")!.builtIn);
  } finally {
    db.close();
  }
});

test("restoring an earlier release version keeps its built-in provenance", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedBuiltInSkills(db, [release("1.0.0", "First.")], 100);
    const skill = db.getSkillByName("using-wollipog")!;
    const first = skill.latestVersion!;
    seedBuiltInSkills(db, [release("1.1.0", "Second.")], 200);
    const restored = db.restoreSkillVersion(skill.id, first.id, db.getSkill(skill.id)!.latestVersion!.id)!;
    assert.deepEqual(restored.builtInSource, { release: "1.0.0", digest: first.digest });
    // The next release therefore still applies on its own.
    assert.deepEqual(seedBuiltInSkills(db, [release("1.2.0", "Third.")], 300), { "using-wollipog": "updated" });
  } finally {
    db.close();
  }
});

test("recommendation dismissal is per user", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    seedBuiltInSkills(db, [release("1.0.0", "First.")], 100);
    const skill = db.getSkillByName("using-wollipog")!;
    db.setSkillRecommendationDismissed("usr_a", skill.id, true, 110);
    assert.deepEqual(db.skillRecommendationDismissals("usr_a"), new Set([skill.id]));
    assert.deepEqual(db.skillRecommendationDismissals("usr_b"), new Set());
    db.setSkillRecommendationDismissed("usr_a", skill.id, false, 120);
    assert.deepEqual(db.skillRecommendationDismissals("usr_a"), new Set());
  } finally {
    db.close();
  }
});

const SCOPE = { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "organization" as const, organizationId: PERSONAL_ORGANIZATION_ID } };

function describedFiles(name: string, description: string): SkillFile[] {
  return [{ path: "SKILL.md", encoding: "utf8", content: `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n` }];
}

test("the built-in orchestrate-issues description is kept whole, not cut at 280 characters", () => {
  const skill = builtInSkills().find((entry) => entry.name === "orchestrate-issues")!;
  const frontmatter = /^description: (.*)$/m.exec(skill.files.find((file) => file.path === "SKILL.md")!.content)![1]!;
  assert.ok(frontmatter.length > 280);
  assert.equal(skill.description, frontmatter);
});

test("startup restores descriptions an earlier release cut at 280 characters and nothing else", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    db.registerRunner(runnerMeta("laptop"), 10, 90);
    // An installation seeded by the earlier release stored the hard 280-character cut.
    seedBuiltInSkills(db, builtInSkills(), 100);
    const builtIn = db.getSkillByName("orchestrate-issues")!;
    const fullBuiltIn = builtIn.description!;
    db.updateSkill(builtIn.id, { description: fullBuiltIn.slice(0, 280) }, 110);

    const gitText = "Imported from Git with a long description. ".repeat(12).trim();
    const git = validateSkillPayload({ name: "git-skill", files: describedFiles("git-skill", gitText) });
    assert.ok(git.ok);
    const gitSkill = db.importGitSkill({ ...git, scope: SCOPE, expectedVersionId: null,
      source: { url: "https://example.test/skills.git", ref: "main", subdirectory: "", path: "", commit: "b".repeat(40) } });
    db.updateSkill(gitSkill.id, { description: gitText.slice(0, 280) }, 120);

    // Longer than the new limit: restored as a word-boundary cut with an ellipsis.
    const hugeText = "Every word here is ordinary and short. ".repeat(40).trim();
    const huge = validateSkillPayload({ name: "huge-skill", files: describedFiles("huge-skill", hugeText) });
    assert.ok(huge.ok);
    const hugeSkill = db.createSkill({ ...huge, description: hugeText.slice(0, 280), now: 130 });

    // A user edit, even one exactly 280 characters long, is never replaced.
    const editedText = "Edited by a person. ".repeat(20).trim();
    const edited = validateSkillPayload({ name: "edited-skill", files: describedFiles("edited-skill", editedText) });
    assert.ok(edited.ok);
    const editedSkill = db.createSkill({ ...edited, description: "My own summary.", now: 140 });
    const edited280 = validateSkillPayload({ name: "edited-280", files: describedFiles("edited-280", editedText) });
    assert.ok(edited280.ok);
    const edited280Skill = db.createSkill({ ...edited280, description: "y".repeat(280), now: 150 });

    // A frontmatter description of exactly 280 characters was never cut.
    const exactText = "z".repeat(280);
    const exact = validateSkillPayload({ name: "exact-skill", files: describedFiles("exact-skill", exactText) });
    assert.ok(exact.ok);
    const exactSkill = db.createSkill({ ...exact, description: exact.description, now: 160 });

    // An old cut that split a surrogate pair was persisted with U+FFFD in place of the lone half.
    const emojiText = `${"a".repeat(279)}😀 and more words after the emoji`;
    const emoji = validateSkillPayload({ name: "emoji-skill", files: describedFiles("emoji-skill", emojiText) });
    assert.ok(emoji.ok);
    const emojiSkill = db.createSkill({ ...emoji, description: emojiText.slice(0, 280), now: 170 });
    assert.equal(db.getSkill(emojiSkill.id)!.description, `${"a".repeat(279)}\uFFFD`);

    const versionsBefore = db.listSkills().map((skill) => [skill.name, skill.latestVersion!.id, skill.latestVersion!.digest]);

    assert.deepEqual(repairLegacySkillDescriptions(db, 200), ["emoji-skill", "git-skill", "huge-skill", "orchestrate-issues"]);
    assert.equal(db.getSkill(emojiSkill.id)!.description, emojiText);
    assert.equal(db.getSkill(builtIn.id)!.description, fullBuiltIn);
    assert.equal(db.getSkill(gitSkill.id)!.description, gitText);
    const hugeDescription = db.getSkill(hugeSkill.id)!.description!;
    assert.ok(hugeDescription.length <= 1024 && hugeDescription.endsWith("…"));
    assert.ok(hugeText.startsWith(hugeDescription.slice(0, -1)));
    assert.equal(db.getSkill(editedSkill.id)!.description, "My own summary.");
    assert.equal(db.getSkill(edited280Skill.id)!.description, "y".repeat(280));
    assert.equal(db.getSkill(exactSkill.id)!.description, exactText);

    // Descriptions are library metadata: no version, digest, or deployed state changes.
    assert.deepEqual(db.listSkills().map((skill) => [skill.name, skill.latestVersion!.id, skill.latestVersion!.digest]), versionsBefore);
    for (const skill of db.listSkills()) assert.equal(versionCount(db, skill.id), 1);
    assert.deepEqual(resolveDesiredSkillSnapshot(db, "laptop"), []);

    // Idempotent: a second start finds nothing to repair.
    assert.deepEqual(repairLegacySkillDescriptions(db, 300), []);
    assert.deepEqual(seedBuiltInSkills(db, builtInSkills(), 400), { "orchestrate-issues": "unchanged", "using-wollipog": "unchanged" });
  } finally {
    db.close();
  }
});
