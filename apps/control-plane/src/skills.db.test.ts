import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunnerMetadata, SkillFile } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { PERSONAL_ORGANIZATION_ID } from "./identity.js";

function skillFiles(name: string): SkillFile[] {
  return [{
    path: "SKILL.md",
    content: `---\nname: ${name}\n---\nBody`,
    encoding: "utf8",
  }];
}

function createSkill(db: ControlPlaneDb, name: string, options: { groupId?: string | null; now?: number } = {}) {
  return db.createSkill({
    name,
    description: `${name} description`,
    groupId: options.groupId ?? null,
    files: skillFiles(name),
    manifest: `{"files":[{"path":"SKILL.md","sha256":"${name}-sha","size":10}]}`,
    digest: `${name}-digest-1`,
    now: options.now ?? 100,
  });
}

const runnerMeta = (runnerId: string): RunnerMetadata => ({
  runnerId, hostname: `${runnerId}-host`, os: "linux", version: "1.0.0", agents: [], workspaces: [],
});

test("skills CRUD: create with first version and default ownership, unique names, list/get", () => {
  const db = ControlPlaneDb.open(":memory:");
  const skill = createSkill(db, "alpha");
  assert.equal(skill.name, "alpha");
  assert.equal(skill.description, "alpha description");
  assert.equal(skill.source, "library");
  assert.equal(skill.assignmentCount, 0);
  assert.equal(skill.latestVersion?.digest, "alpha-digest-1");
  assert.deepEqual(db.skillScope(skill.id), {
    organizationId: PERSONAL_ORGANIZATION_ID,
    owner: { kind: "organization", organizationId: PERSONAL_ORGANIZATION_ID },
  });

  assert.throws(() => createSkill(db, "alpha"), /already exists/);
  assert.throws(() => createSkill(db, "grouped", { groupId: "missing-group" }), /skill group not found/);
  assert.equal(db.getSkillByName("grouped"), null, "a failed create leaves no partial rows");

  createSkill(db, "beta");
  assert.deepEqual(db.listSkills().map((row) => row.name), ["alpha", "beta"]);
  assert.equal(db.getSkill(skill.id)!.name, "alpha");
  assert.equal(db.getSkillByName("beta")!.name, "beta");
  assert.equal(db.getSkill("skill_missing"), null);

  const version = db.getSkillVersion(skill.latestVersion!.id)!;
  assert.equal(version.skillId, skill.id);
  assert.deepEqual(version.files, skillFiles("alpha"));
  assert.match(version.manifest, /"SKILL\.md"/);
});

test("skills CRUD: update, new versions track latest, and delete clears everything", () => {
  const db = ControlPlaneDb.open(":memory:");
  const group = db.createSkillGroup("Review Tools", 50);
  const skill = createSkill(db, "alpha");

  const updated = db.updateSkill(skill.id, { description: "new text", groupId: group.id }, 200)!;
  assert.equal(updated.description, "new text");
  assert.equal(updated.groupId, group.id);
  assert.equal(db.updateSkill(skill.id, { groupId: null }, 201)!.groupId, null);
  assert.throws(() => db.updateSkill(skill.id, { groupId: "missing" }), /skill group not found/);
  assert.equal(db.updateSkill("skill_missing", { description: "x" }), null);

  const second = db.addSkillVersion(skill.id, {
    files: skillFiles("alpha"),
    manifest: '{"files":[]}',
    digest: "alpha-digest-2",
    note: "second",
  }, 300)!;
  assert.equal(db.getSkill(skill.id)!.latestVersion!.id, second.id);
  assert.equal(db.getSkill(skill.id)!.latestVersion!.digest, "alpha-digest-2");
  assert.equal(second.note, "second");
  assert.equal(db.addSkillVersion("skill_missing", {
    files: [], manifest: "{}", digest: "d",
  }), null);

  const assignment = db.createSkillAssignment({
    skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" }, now: 400,
  });
  assert.equal(db.getSkill(skill.id)!.assignmentCount, 1);

  assert.equal(db.deleteSkill(skill.id), true);
  assert.equal(db.deleteSkill(skill.id), false);
  assert.equal(db.getSkill(skill.id), null);
  assert.equal(db.getSkillVersion(second.id), null);
  assert.equal(db.getSkillAssignment(assignment.id), null);
  assert.equal(db.skillScope(skill.id), null, "ownership cascades with the skill row");
});

test("skill groups order by sort_order and deletion detaches member skills", () => {
  const db = ControlPlaneDb.open(":memory:");
  const first = db.createSkillGroup("Writing", 10);
  const second = db.createSkillGroup("Coding", 20);
  assert.deepEqual(db.listSkillGroups().map((row) => row.name), ["Writing", "Coding"]);
  assert.equal(second.sortOrder, first.sortOrder + 1);
  assert.throws(() => db.createSkillGroup("   "), /name is required/);

  const skill = createSkill(db, "grouped", { groupId: first.id });
  assert.equal(skill.groupId, first.id);
  assert.equal(db.deleteSkillGroup(first.id), true);
  assert.equal(db.deleteSkillGroup(first.id), false);
  assert.equal(db.getSkill(skill.id)!.groupId, null);
  assert.deepEqual(db.listSkillGroups().map((row) => row.name), ["Coding"]);
});

test("skill assignments CRUD and per-runner scope filtering", () => {
  const db = ControlPlaneDb.open(":memory:");
  db.registerRunner(runnerMeta("runner-1"), 10, 90);
  db.registerRunner(runnerMeta("runner-2"), 10, 90);
  const skill = createSkill(db, "alpha");

  assert.throws(() => db.createSkillAssignment({
    skillId: "skill_missing", scopeKind: "instance", agentSelector: { kind: "all" },
  }), /skill not found/);

  const instanceWide = db.createSkillAssignment({
    skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" }, now: 100,
  });
  const runnerScoped = db.createSkillAssignment({
    skillId: skill.id,
    scopeKind: "runner",
    runnerId: "runner-1",
    agentSelector: { kind: "driver", driver: "codex" },
    invocation: "manual",
    enabled: false,
    now: 110,
  });
  assert.equal(instanceWide.scopeKind, "instance");
  assert.equal(instanceWide.runnerId, null);
  assert.equal(instanceWide.enabled, true);
  assert.equal(instanceWide.invocation, "agent");
  assert.equal(runnerScoped.enabled, false);
  assert.equal(runnerScoped.invocation, "manual");
  assert.deepEqual(runnerScoped.agentSelector, { kind: "driver", driver: "codex" });

  assert.equal(db.listSkillAssignments().length, 2);
  assert.equal(db.listSkillAssignments(skill.id).length, 2);
  assert.equal(db.listSkillAssignments("skill_other").length, 0);
  assert.deepEqual(db.listSkillAssignmentsForRunner("runner-1").map((row) => row.id),
    [instanceWide.id, runnerScoped.id]);
  assert.deepEqual(db.listSkillAssignmentsForRunner("runner-2").map((row) => row.id),
    [instanceWide.id], "another machine never sees a foreign runner-scoped row");

  const toggled = db.updateSkillAssignment(runnerScoped.id, { enabled: true }, 200)!;
  assert.equal(toggled.enabled, true);
  assert.equal(toggled.invocation, "manual", "an omitted field is preserved");
  const swapped = db.updateSkillAssignment(runnerScoped.id, { invocation: "agent" }, 210)!;
  assert.equal(swapped.invocation, "agent");
  assert.equal(swapped.enabled, true);
  assert.equal(db.updateSkillAssignment("skilla_missing", { enabled: false }), null);

  const removed = db.deleteSkillAssignment(runnerScoped.id)!;
  assert.equal(removed.runnerId, "runner-1", "the removed row tells the caller which machine to re-sync");
  assert.equal(db.deleteSkillAssignment(runnerScoped.id), null);
  assert.equal(db.listSkillAssignments(skill.id).length, 1);
});

test("runner skill state persists as an authoritative full replacement", () => {
  const db = ControlPlaneDb.open(":memory:");
  assert.equal(db.getRunnerSkillState("runner-1"), null);
  db.setRunnerSkillState("runner-1", {
    deployed: [{ name: "alpha", digest: "d1", links: [{ agentId: "claude", status: "linked" }] }],
    unmanaged: [{ agentId: "claude", name: "hand-rolled", description: "Local skill" }],
  }, 500);
  const first = db.getRunnerSkillState("runner-1")!;
  assert.equal(first.updatedAt, 500);
  assert.equal(first.deployed[0]!.links[0]!.status, "linked");
  assert.equal(first.error, undefined);

  db.setRunnerSkillState("runner-1", { deployed: [], unmanaged: [], error: "scan failed" }, 600);
  const second = db.getRunnerSkillState("runner-1")!;
  assert.equal(second.updatedAt, 600);
  assert.deepEqual(second.deployed, []);
  assert.equal(second.error, "scan failed");
});
