import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { PERSONAL_ORGANIZATION_ID } from "./identity.js";
import { skillAdoptionPreflight } from "./skill-adoption-preflight.js";
import { validateSkillPayload } from "./skills.js";

const agents: AgentDefinition[] = [
  { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" },
  { id: "app", name: "App", command: "codex", args: [], env: {}, driver: "codex-app-server" },
  { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code" },
];
const candidate = { id: "opaque", name: "alpha", sourceDirectory: ".codex/skills", generation: "one" };
function payload(content = "Original") {
  const result = validateSkillPayload({ name: "alpha", files: [{ path: "SKILL.md", encoding: "utf8", content: `---\nname: alpha\n---\n${content}` }] });
  if (!result.ok) throw new Error();
  return result;
}
test("adoption prerequisites use effective targets and pins, and disclose shared readers without changing state", (t) => {
  const db = ControlPlaneDb.open(":memory:"); t.after(() => db.close());
  db.registerRunner({ runnerId: "one", hostname: "host", os: "linux", version: "1", agents, workspaces: [] }, 1, 111);
  const original = payload();
  const check = (sourceDirectory = candidate.sourceDirectory) => skillAdoptionPreflight(db, "one", { ...candidate, sourceDirectory }, original.digest);
  assert.ok(check().blockers.includes("library_skill_missing"));
  const skill = db.createSkill(original);
  assert.ok(check().blockers.includes("effective_assignment_missing"));
  const assignment = db.createSkillAssignment({ skillId: skill.id, scopeKind: "runner", runnerId: "one", agentSelector: { kind: "agent", agentId: "codex" } });
  assert.equal(check().status, "prerequisites_met");
  assert.equal(check().mutationSupported, false);
  assert.deepEqual(check().sharedReaders, ["app"]);
  assert.ok(check(".claude/skills").blockers.includes("source_not_targeted"));
  assert.equal(check(".agents/skills").status, "prerequisites_met");
  db.updateSkillAssignment(assignment.id, { invocation: "manual" });
  assert.ok(check().blockers.includes("invocation_unsupported"));
  db.updateSkillAssignment(assignment.id, { invocation: "agent", enabled: false });
  assert.ok(check().blockers.includes("effective_assignment_missing"));
  db.updateSkillAssignment(assignment.id, { enabled: true });
  db.addSkillVersion(skill.id, payload("Newer"));
  assert.ok(check().blockers.includes("assigned_version_mismatch"));
  db.setMachineSkillVersion(skill.id, "one", skill.latestVersion!.id, null, db.getSkill(skill.id)!.latestVersion!.id);
  assert.equal(check().status, "prerequisites_met", "a matching explicit pin wins over newer library content");
  assert.equal(check().version!.id, skill.latestVersion!.id);
  assert.equal(db.listSkillAssignments(skill.id).length, 1);
  assert.equal(db.getSkill(skill.id)!.latestVersion!.digest, payload("Newer").digest);
});
test("adoption preflight respects group inheritance, direct disables, audience containment and invalid library bytes", (t) => {
  const db = ControlPlaneDb.open(":memory:"); t.after(() => db.close());
  db.registerRunner({ runnerId: "one", hostname: "host", os: "linux", version: "1", agents, workspaces: [] }, 1, 111);
  const scope = { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "organization" as const, organizationId: PERSONAL_ORGANIZATION_ID } };
  const group = db.createSkillGroup("Tools", 1, scope);
  const skill = db.createSkill({ ...payload(), groupId: group.id, scope });
  db.createSkillGroupAssignment({ groupId: group.id, scopeKind: "runner", runnerId: "one", agentSelector: { kind: "agent", agentId: "codex" }, enabled: true, invocation: "agent" });
  const check = () => skillAdoptionPreflight(db, "one", candidate, payload().digest);
  assert.equal(check().status, "prerequisites_met");
  const disabled = db.createSkillAssignment({ skillId: skill.id, scopeKind: "runner", runnerId: "one", agentSelector: { kind: "agent", agentId: "codex" }, enabled: false, now: 0 });
  assert.ok(check().blockers.includes("effective_assignment_missing"));
  db.deleteSkillAssignment(disabled.id);
  db.addSkillVersion(skill.id, { ...payload("Corrupt"), digest: payload().digest });
  assert.ok(check().blockers.includes("library_version_invalid"));
  const originalScope = db.skillScope.bind(db);
  db.skillScope = () => ({ organizationId: "foreign", owner: { kind: "organization", organizationId: "foreign" } });
  assert.ok(check().blockers.includes("effective_assignment_missing"));
  db.skillScope = originalScope;
});
