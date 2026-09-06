import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import { registerSkillGitRoutes } from "./skill-git-route.js";
import { validateSkillPayload } from "./skills.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import type { SkillsRouteDeps, SkillsSyncPusher } from "./skills-route.js";

test("Git preview is read-only; acceptance is scoped, deduplicated, atomic and guarded by the previewed version", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  t.after(async () => { await app.close(); db.close(); });
  let principal: HumanPrincipal = { kind: "human", actorId: LOCAL_OWNER_USER_ID, userId: LOCAL_OWNER_USER_ID,
    userName: "Owner", organizationId: PERSONAL_ORGANIZATION_ID, organizationName: "Personal", role: "owner", deviceId: null, localBootstrap: true };
  let content = "Original";
  let discoveries = 0;
  const pushes: string[] = [];
  db.registerRunner({ runnerId: "runner-1", hostname: "host", os: "linux", version: "1", agents: [], workspaces: [] }, 1, 108);
  registerSkillGitRoutes(app, { db, requestHuman: () => principal, requestPrincipal: () => principal,
    hub: {} as SkillsRouteDeps["hub"], pushSkillsSync: ((id: string) => { pushes.push(id); }) as SkillsSyncPusher }, async (source) => {
    discoveries++;
    const payload = validateSkillPayload({ name: "alpha", files: [{ path: "SKILL.md", encoding: "utf8", content: `---\nname: alpha\n---\n${content}` }] });
    assert.equal(payload.ok, true);
    if (!payload.ok) throw new Error(payload.error);
    return [{ ...payload, source, path: "skills/alpha", commit: "a".repeat(40), executablePaths: [] }];
  });
  const preview = async () => {
    const response = await app.inject({ method: "POST", url: "/api/skill-git/preview", payload: { url: "team/repo" } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const accept = (previewId: string, acceptUpdate = false) => app.inject({ method: "POST", url: "/api/skill-git/import", payload: { previewId, path: "skills/alpha", acceptUpdate } });
  const first = await preview();
  assert.equal(db.listSkills().length, 0);
  const owner = principal;
  principal = { ...owner, organizationId: "other-org" };
  assert.equal((await accept(first.previewId)).statusCode, 404);
  principal = owner;
  const created = await accept(first.previewId);
  assert.equal(created.statusCode, 200, created.body);
  const skill = created.json().skill;
  const version = db.getSkillVersion(skill.latestVersion.id)!;
  assert.equal(version.gitSource?.commit, "a".repeat(40));
  assert.equal(db.listSkillAssignments(skill.id).length, 0);
  assert.deepEqual(pushes, []);
  assert.equal((await accept(first.previewId)).statusCode, 404);
  const duplicate = await preview();
  assert.equal(duplicate.candidates[0].disposition, "identical");
  assert.equal((await accept(duplicate.previewId)).json().skill.latestVersion.id, version.id);
  assert.deepEqual(pushes, []);
  content = "Changed";
  const update = await preview();
  assert.equal(update.candidates[0].previousFiles[0].content, version.files[0]!.content);
  assert.equal((await accept(update.previewId)).statusCode, 409);
  assert.deepEqual(pushes, []);
  assert.equal(db.getSkill(skill.id)!.latestVersion!.id, version.id);
  const newer = await preview();
  assert.equal((await accept(newer.previewId, true)).statusCode, 200);
  assert.deepEqual(pushes, ["runner-1"]);
  assert.equal((await accept(update.previewId, true)).statusCode, 409);
  const final = db.getSkill(skill.id)!;
  assert.notEqual(final.latestVersion!.id, version.id);
  assert.equal(db.getSkillVersion(version.id)!.files[0]!.content, version.files[0]!.content);
  db.addSkillVersion(skill.id, { files: version.files, manifest: version.manifest, digest: version.digest });
  assert.equal(db.getSkill(skill.id)!.gitSource?.url, "https://github.com/team/repo.git", "manual edits retain the upstream for later update checks");
  principal = { ...owner, role: "operator" };
  assert.equal((await app.inject({ method: "POST", url: "/api/skill-git/preview", payload: { url: "team/repo" } })).statusCode, 403);
  assert.equal(discoveries, 4);
  for (const role of ["admin", "owner"] as const) {
    principal = { ...owner, userId: "usr_foreign", actorId: "usr_foreign", organizationId: "org_foreign", role, localBootstrap: false };
    assert.equal((await app.inject({ method: "POST", url: "/api/skill-git/preview", payload: { url: "team/private" } })).statusCode, 403);
    assert.equal((await accept(update.previewId, true)).statusCode, 403);
  }
  assert.equal(discoveries, 4, "foreign organization admins and owners never reach ambient credentials");
  principal = owner;
  content = "Another update";
  const failing = await preview();
  db.importGitSkill = () => { throw new Error("sensitive internal SQL details"); };
  const failure = await accept(failing.previewId, true);
  assert.equal(failure.statusCode, 500);
  assert.doesNotMatch(failure.body, /sensitive|SQL/);
});
