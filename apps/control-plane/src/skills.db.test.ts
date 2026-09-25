import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNNER_CAPABILITY_MIN_PROTOCOL, type RunnerMetadata, type SkillFile } from "@wollipog/protocol";
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

for (const deletion of ["box", "runner"] as const) {
  test(`${deletion} deletion clears only its machine skill records, atomically`, () => {
    const db = ControlPlaneDb.open(":memory:");
    try {
      db.createBox({ boxId: "box", runnerId: "removed", sshTarget: "user@host", sshPort: 22,
        workspaces: [], autoReconnect: false, runnerDataDir: null, now: 10 });
      db.registerRunner(runnerMeta("removed"), 10, 90);
      db.registerRunner(runnerMeta("other"), 10, 90);
      const skill = createSkill(db, "shared");
      const version = db.getSkillVersion(skill.latestVersion!.id);
      const instance = db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
      const removed = db.createSkillAssignment({ skillId: skill.id, scopeKind: "runner", runnerId: "removed", agentSelector: { kind: "all" } });
      const other = db.createSkillAssignment({ skillId: skill.id, scopeKind: "runner", runnerId: "other", agentSelector: { kind: "all" } });
      for (const runnerId of ["removed", "other"]) {
        db.setRunnerSkillState(runnerId, { deployed: [], unmanaged: [] }, 20);
        db.raw().prepare("INSERT INTO skill_machine_versions VALUES (?, ?, ?, ?)").run(skill.id, runnerId, version!.id, runnerId);
      }
      const otherState = db.getRunnerSkillState("other");
      const remove = () => deletion === "box" ? db.deleteBox("box") : db.deleteRunner("removed");

      // Fail after skill cleanup to prove the enclosing transaction restores it.
      db.raw().exec("CREATE TRIGGER reject_runner_delete BEFORE DELETE ON runners BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END");
      assert.throws(remove, /injected deletion failure/);
      assert.ok(db.getBox("box"));
      assert.ok(db.getSkillAssignment(removed.id));
      assert.ok(db.getRunnerSkillState("removed"));
      assert.ok(db.getMachineSkillVersion(skill.id, "removed"));
      db.raw().exec("DROP TRIGGER reject_runner_delete");

      assert.ok(remove());
      assert.equal(db.getBox("box"), null);
      assert.equal(db.getSkillAssignment(removed.id), null);
      assert.equal(db.getRunnerSkillState("removed"), null);
      assert.equal(db.getMachineSkillVersion(skill.id, "removed"), null);
      assert.deepEqual(db.getSkillAssignment(instance.id), instance);
      assert.deepEqual(db.getSkillAssignment(other.id), other);
      assert.deepEqual(db.getRunnerSkillState("other"), otherState);
      assert.ok(db.getMachineSkillVersion(skill.id, "other"));
      assert.deepEqual(db.getSkillVersion(version!.id), version);
      assert.equal(db.getSkill(skill.id)!.assignmentCount, 2);

      db.registerRunner(runnerMeta("removed"), 30, 90);
      assert.equal(db.getSkillAssignment(removed.id), null);
      assert.equal(db.getRunnerSkillState("removed"), null);
      assert.equal(db.getMachineSkillVersion(skill.id, "removed"), null);
    } finally {
      db.close();
    }
  });
}

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

test("runner skill inventory replaces fully while latest non-empty removal history persists", () => {
  const db = ControlPlaneDb.open(":memory:");
  assert.equal(db.getRunnerSkillState("runner-1"), null);
  db.setRunnerSkillState("runner-1", {
    deployed: [{ name: "alpha", digest: "d1", links: [{ agentId: "claude", status: "linked" }] }],
    unmanaged: [{ agentId: "claude", name: "hand-rolled", description: "Local skill" }],
    removals: [
      { path: "~/.codex/skills/retired", reason: "No longer in the desired skill list." },
      { path: "~/.codex/skills/retired-wsl (WSL Ubuntu)", reason: "No longer in the desired skill list." },
    ],
  }, 500);
  const first = db.getRunnerSkillState("runner-1")!;
  assert.equal(first.updatedAt, 500);
  assert.equal(first.deployed[0]!.links[0]!.status, "linked");
  assert.deepEqual(first.removals, [
    { path: "~/.codex/skills/retired", reason: "No longer in the desired skill list." },
    { path: "~/.codex/skills/retired-wsl (WSL Ubuntu)", reason: "No longer in the desired skill list." },
  ]);
  assert.equal(first.removalsUpdatedAt, 500);
  assert.equal(first.error, undefined);

  // An empty subsequent reconcile updates deployment truth without erasing the latest removal event.
  db.setRunnerSkillState("runner-1", { deployed: [], unmanaged: [], error: "scan failed" }, 600);
  const second = db.getRunnerSkillState("runner-1")!;
  assert.equal(second.updatedAt, 600);
  assert.deepEqual(second.deployed, []);
  assert.deepEqual(second.removals, first.removals);
  assert.equal(second.removalsUpdatedAt, 500);
  assert.equal(second.error, "scan failed");

  // This shape is what control planes persisted before removal reporting existed.
  db.setRunnerSkillState("runner-legacy", { deployed: [], unmanaged: [] }, 610);
  const legacy = db.getRunnerSkillState("runner-legacy")!;
  assert.deepEqual(legacy.removals, []);
  assert.equal(legacy.removalsUpdatedAt, undefined);

  db.setRunnerSkillState("runner-1", {
    deployed: [],
    unmanaged: [],
    removals: [{ path: "~/.claude/skills/newer", reason: "A newer removal." }],
  }, 700);
  const replaced = db.getRunnerSkillState("runner-1")!;
  assert.deepEqual(replaced.removals, [{ path: "~/.claude/skills/newer", reason: "A newer removal." }]);
  assert.equal(replaced.removalsUpdatedAt, 700);

  db.setRunnerSkillState("runner-malformed", {
    deployed: [],
    unmanaged: [],
    removals: [{ path: {} as never, reason: 1 as never }],
  }, 800);
  assert.deepEqual(db.getRunnerSkillState("runner-malformed")!.removals, []);
});

test("drift is authoritative replacement, normalized, and accepted only from runners that negotiated it", () => {
  const db = ControlPlaneDb.open(":memory:");
  const register = (runnerId: string, protocolVersion: number) => db.registerRunner(
    { runnerId, hostname: runnerId, os: "linux", version: "1", agents: [], workspaces: [] }, 1, protocolVersion);
  register("runner-current", RUNNER_CAPABILITY_MIN_PROTOCOL.skillDrift);
  register("runner-old", RUNNER_CAPABILITY_MIN_PROTOCOL.skillDrift - 1);
  const drift = [
    { name: "alpha", digest: "a".repeat(64), variant: "agent" as const, observedDigest: "b".repeat(64), held: true,
      detail: "Held\u0000 until resolved." },
    { name: "alpha", digest: "a".repeat(64), variant: "agent" as const, held: false },
    { name: "../escape", digest: "a".repeat(64), variant: "agent" as const, held: true },
    { name: "beta", digest: "short", variant: "agent" as const, held: true },
    { name: "gamma", digest: "c".repeat(64), variant: "other" as never, held: true },
    { name: "delta", digest: "d".repeat(64), variant: "manual" as const, held: false, extra: "dropped" },
  ];
  db.setRunnerSkillState("runner-current", { deployed: [], unmanaged: [], drift }, 10);
  assert.deepEqual(db.getRunnerSkillState("runner-current")!.drift, [
    { name: "alpha", digest: "a".repeat(64), variant: "agent", observedDigest: "b".repeat(64), held: true, detail: "Held until resolved." },
    { name: "delta", digest: "d".repeat(64), variant: "manual", held: false },
  ]);
  db.setRunnerSkillState("runner-current", { deployed: [], unmanaged: [] }, 20);
  assert.deepEqual(db.getRunnerSkillState("runner-current")!.drift, [], "a later report without drift clears it");

  db.setRunnerSkillState("runner-old", { deployed: [], unmanaged: [], drift }, 30);
  assert.deepEqual(db.getRunnerSkillState("runner-old")!.drift, [], "an older runner can never produce a drift result");

  const retained = Array.from({ length: 300 }, (_, index) => ({
    name: `retained-${index}`, digest: "e".repeat(64), variant: "agent" as const, held: false,
  }));
  db.setRunnerSkillState("runner-current", { deployed: [], unmanaged: [],
    drift: [...retained, { name: "live", digest: "f".repeat(64), variant: "agent", held: true }] }, 40);
  const bounded = db.getRunnerSkillState("runner-current")!.drift;
  assert.equal(bounded.length, 1 + 256, "retained copies are bounded; the held one is additional");
  assert.equal(bounded[0]!.name, "live", "the storage bound never hides a held, actionable copy");

  const heldEverywhere = Array.from({ length: 257 }, (_, index) => ({
    name: `held-${index}`, digest: "e".repeat(64), variant: "agent" as const, held: true,
  }));
  db.setRunnerSkillState("runner-current", { deployed: [], unmanaged: [], drift: [...retained, ...heldEverywhere] }, 50);
  const allHeld = db.getRunnerSkillState("runner-current")!.drift;
  assert.equal(allHeld.length, 257 + 256, "every held copy stays resolvable beside the bounded retained ones");
  assert.equal(allHeld.filter((entry) => entry.held).length, 257);

  // A held copy reported after thousands of retained ones is still stored.
  const manyRetained = Array.from({ length: 5000 }, (_, index) => ({
    name: `old-${index}`, digest: "e".repeat(64), variant: "agent" as const, held: false,
  }));
  db.setRunnerSkillState("runner-current", { deployed: [], unmanaged: [],
    drift: [...manyRetained, { name: "late-held", digest: "f".repeat(64), variant: "manual", held: true }] }, 60);
  const late = db.getRunnerSkillState("runner-current")!.drift;
  assert.equal(late[0]!.name, "late-held");
  assert.equal(late.length, 1 + 256);
});

test("kept-aside copies are authoritative replacement, normalized, and accepted only from runners that negotiated them", () => {
  const db = ControlPlaneDb.open(":memory:");
  const register = (runnerId: string, protocolVersion: number) => db.registerRunner(
    { runnerId, hostname: runnerId, os: "linux", version: "1", agents: [], workspaces: [] }, 1, protocolVersion);
  register("runner-current", RUNNER_CAPABILITY_MIN_PROTOCOL.skillKeptAsideCopies);
  register("runner-old", RUNNER_CAPABILITY_MIN_PROTOCOL.skillKeptAsideCopies - 1);
  const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const keptAside = [
    { id, name: "alpha", digest: "a".repeat(64), variant: "manual" as const, keptAsideAt: 7, observedDigest: "b".repeat(64),
      detail: "Kept\u0000 aside.", extra: "dropped" },
    { id, name: "duplicate" },
    { id: "not-a-uuid" },
    { id: "1f0e0d0c-0b0a-4908-8706-050403020100", name: "../escape" },
    { id: "2f0e0d0c-0b0a-4908-8706-050403020100", observedDigest: "b".repeat(64), observedFingerprint: "c".repeat(64) },
    { id: "3f0e0d0c-0b0a-4908-8706-050403020100", keptAsideAt: -1 },
    { id: "4f0e0d0c-0b0a-4908-8706-050403020100", observedFingerprint: "c".repeat(64) },
  ];
  db.setRunnerSkillState("runner-current", { deployed: [], unmanaged: [], keptAside: keptAside as never }, 10);
  assert.deepEqual(db.getRunnerSkillState("runner-current")!.keptAside, [
    { id, name: "alpha", digest: "a".repeat(64), variant: "manual", keptAsideAt: 7, observedDigest: "b".repeat(64), detail: "Kept aside." },
    { id: "4f0e0d0c-0b0a-4908-8706-050403020100", observedFingerprint: "c".repeat(64) },
  ]);
  db.setRunnerSkillState("runner-current", { deployed: [], unmanaged: [] }, 20);
  assert.deepEqual(db.getRunnerSkillState("runner-current")!.keptAside, [], "a later report without the field clears it");
  db.setRunnerSkillState("runner-old", { deployed: [], unmanaged: [], keptAside: keptAside as never }, 30);
  assert.deepEqual(db.getRunnerSkillState("runner-old")!.keptAside, [], "an older runner can never produce a kept-aside result");
  const many = Array.from({ length: 300 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }));
  db.setRunnerSkillState("runner-current", { deployed: [], unmanaged: [], keptAside: many, keptAsideOmitted: 5 }, 40);
  assert.equal(db.getRunnerSkillState("runner-current")!.keptAside.length, 256);
  assert.equal(db.getRunnerSkillState("runner-current")!.keptAsideOmitted, 5 + 44,
    "copies the runner or the storage bound left out are counted, never dropped silently");
  db.setRunnerSkillState("runner-current", { deployed: [], unmanaged: [], keptAside: [], keptAsideOmitted: -3 }, 50);
  assert.equal(db.getRunnerSkillState("runner-current")!.keptAsideOmitted, undefined);
  db.setRunnerSkillState("runner-old", { deployed: [], unmanaged: [], keptAsideOmitted: 7 }, 60);
  assert.equal(db.getRunnerSkillState("runner-old")!.keptAsideOmitted, undefined);
});
