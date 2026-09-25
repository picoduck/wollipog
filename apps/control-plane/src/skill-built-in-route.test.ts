import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentDefinition, ControlPlaneToRunner, RunnerMetadata, SkillFile } from "@wollipog/protocol";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import {
  LOCAL_OWNER_USER_ID,
  mutationAuthorizationError,
  PERSONAL_ORGANIZATION_ID,
  type AgentPrincipal,
  type AuthPrincipal,
  type HumanPrincipal,
} from "./identity.js";
import { builtInSkills, seedBuiltInSkills } from "./built-in-skills.js";
import { makeSkillsSyncPusher, registerSkillRoutes, type SkillsHub } from "./skills-route.js";
import { validateSkillPayload } from "./skills.js";

const AGENTS: AgentDefinition[] = [
  { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" },
];

const runnerMeta = (runnerId: string): RunnerMetadata => ({
  runnerId, hostname: `${runnerId}-host`, os: "linux", version: "1.0.0", agents: AGENTS, workspaces: [],
});

function human(userId: string, role: HumanPrincipal["role"]): HumanPrincipal {
  return {
    kind: "human", actorId: userId, userId, userName: userId, organizationId: PERSONAL_ORGANIZATION_ID,
    organizationName: PERSONAL_ORGANIZATION_ID, role, deviceId: null, localBootstrap: userId === LOCAL_OWNER_USER_ID,
  };
}

function files(name: string, body: string): SkillFile[] {
  return [{ path: "SKILL.md", encoding: "utf8", content: `---\nname: ${name}\ndescription: ${name} guide.\n---\n${body}\n` }];
}

async function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  const pushed: Array<{ runnerId: string; msg: ControlPlaneToRunner }> = [];
  const online = new Set<string>();
  const hub = {
    isRunnerOnline: (runnerId: string) => online.has(runnerId),
    sendToRunner: (runnerId: string, msg: ControlPlaneToRunner) => { pushed.push({ runnerId, msg }); return true; },
    requestFromRunner: () => { throw new Error("unexpected runner request"); },
  } as SkillsHub;
  const release = builtInSkills([{ name: "using-wollipog", files: files("using-wollipog", "Release content.") }], "1.0.0");
  let current: AuthPrincipal = human(LOCAL_OWNER_USER_ID, "owner");
  const app = Fastify();
  registerSkillRoutes(app, {
    db, hub, requestHuman: () => current.kind === "human" ? current : null, requestPrincipal: () => current,
    pushSkillsSync: makeSkillsSyncPusher({ db, hub }), builtInSkills: release,
  });
  await app.ready();
  return {
    app, db, pushed, online, release,
    as(principal: AuthPrincipal) { current = principal; },
  };
}

test("recommendations are listed per user, and dismissing one hides it only for that user", async (t) => {
  const { app, db, release, as } = await fixture();
  t.after(async () => { await app.close(); db.close(); });
  seedBuiltInSkills(db, release, 100);
  const alice = human("usr_alice", "operator");
  const bob = human("usr_bob", "viewer");
  as(alice);
  const [listed] = (await app.inject({ method: "GET", url: "/api/skills" })).json().skills;
  assert.deepEqual(listed.recommendation, { dismissed: false });
  assert.deepEqual(listed.builtIn, { release: "1.0.0", heldUpdate: null });

  const dismissed = await app.inject({ method: "PUT", url: `/api/skills/${listed.id}/recommendation`, payload: { dismissed: true } });
  assert.equal(dismissed.statusCode, 200);
  assert.deepEqual(dismissed.json().skill.recommendation, { dismissed: true });
  assert.deepEqual((await app.inject({ method: "GET", url: `/api/skills/${listed.id}` })).json().skill.recommendation, { dismissed: true });
  // The library entry stays.
  assert.ok(db.getSkill(listed.id));

  as(bob);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/skills" })).json().skills[0].recommendation, { dismissed: false });
  // Read-only members may dismiss for themselves.
  assert.equal(mutationAuthorizationError("PUT", "/api/skills/:id/recommendation", bob), null);
  assert.notEqual(mutationAuthorizationError("POST", "/api/skills/:id/built-in-version", bob), null);

  as(alice);
  const restored = await app.inject({ method: "PUT", url: `/api/skills/${listed.id}/recommendation`, payload: { dismissed: false } });
  assert.deepEqual(restored.json().skill.recommendation, { dismissed: false });
  assert.equal((await app.inject({ method: "PUT", url: `/api/skills/${listed.id}/recommendation`, payload: {} })).statusCode, 400);
});

// The Inbox notice and the Skills view both recommend exactly what this listing marks, so it decides
// who sees the notice.
test("recommendations reach viewers of the personal organization, but not other organizations or agents", async (t) => {
  const { app, db, release, as } = await fixture();
  t.after(async () => { await app.close(); db.close(); });
  seedBuiltInSkills(db, release, 100);
  const listed = async () => (await app.inject({ method: "GET", url: "/api/skills" })).json().skills as
    Array<{ id: string; recommendation?: { dismissed: boolean } }>;

  as(human("usr_viewer", "viewer"));
  const [skill] = await listed();
  assert.deepEqual(skill?.recommendation, { dismissed: false });

  as({ ...human("usr_elsewhere", "owner"), organizationId: "org_other", organizationName: "Other" });
  assert.deepEqual(await listed(), [], "another organization cannot read the personal organization's built-ins");
  const foreign = await app.inject({ method: "PUT", url: `/api/skills/${skill!.id}/recommendation`, payload: { dismissed: true } });
  assert.equal(foreign.statusCode, 404);

  const agent: AgentPrincipal = {
    kind: "agent", actorId: "agent_1", organizationId: PERSONAL_ORGANIZATION_ID,
    delegatedScope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "organization", organizationId: PERSONAL_ORGANIZATION_ID } },
  };
  as(agent);
  const [readByAgent] = await listed();
  assert.equal(readByAgent?.id, skill!.id);
  assert.equal(readByAgent?.recommendation, undefined, "an agent is never recommended a skill");
  const byAgent = await app.inject({ method: "PUT", url: `/api/skills/${skill!.id}/recommendation`, payload: { dismissed: true } });
  assert.equal(byAgent.statusCode, 403);
  assert.deepEqual([...db.skillRecommendationDismissals("usr_viewer")], []);
});

test("only built-in skills have a recommendation to dismiss", async (t) => {
  const { app, db } = await fixture();
  t.after(async () => { await app.close(); db.close(); });
  const created = await app.inject({ method: "POST", url: "/api/skills", payload: { name: "mine", files: files("mine", "Mine.") } });
  const id = created.json().skill.id;
  assert.equal(created.json().skill.recommendation, undefined);
  const response = await app.inject({ method: "PUT", url: `/api/skills/${id}/recommendation`, payload: { dismissed: true } });
  assert.equal(response.statusCode, 409);
  assert.equal((await app.inject({ method: "PUT", url: "/api/skills/skill_missing/recommendation", payload: { dismissed: true } })).statusCode, 404);
});

test("a same-name user-managed skill reviews and adopts the built-in version through an explicit diff acceptance", async (t) => {
  const { app, db, pushed, online, release } = await fixture();
  t.after(async () => { await app.close(); db.close(); });
  db.registerRunner(runnerMeta("laptop"), 10, 90);
  online.add("laptop");
  const created = await app.inject({ method: "POST", url: "/api/skills", payload: { name: "using-wollipog", files: files("using-wollipog", "Mine.") } });
  const skill = created.json().skill;
  assert.equal((await app.inject({ method: "GET", url: `/api/skills/${skill.id}/built-in-version` })).statusCode, 404);

  seedBuiltInSkills(db, release, 100);
  pushed.length = 0;
  const detail = (await app.inject({ method: "GET", url: `/api/skills/${skill.id}` })).json().skill;
  assert.deepEqual(detail.builtInOffer, { release: "1.0.0", digest: release[0]!.digest });
  assert.equal(detail.recommendation, undefined);

  const review = (await app.inject({ method: "GET", url: `/api/skills/${skill.id}/built-in-version` })).json();
  assert.equal(review.kind, "adopt");
  assert.equal(review.release, "1.0.0");
  assert.equal(review.digest, release[0]!.digest);
  assert.deepEqual(review.files, release[0]!.files);
  assert.equal(review.currentVersion.id, skill.latestVersion.id);
  assert.equal(review.expectedLatestVersionId, skill.latestVersion.id);
  assert.equal(review.gitAutoUpdate, false);

  const accept = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/skills/${skill.id}/built-in-version`, payload });
  assert.equal((await accept({ digest: review.digest, expectedLatestVersionId: review.expectedLatestVersionId })).statusCode, 400);
  assert.equal((await accept({ digest: "0".repeat(64), expectedLatestVersionId: review.expectedLatestVersionId, accepted: true })).statusCode, 409);
  assert.equal((await accept({ digest: review.digest, expectedLatestVersionId: "skillv_stale", accepted: true })).statusCode, 409);
  assert.equal(pushed.length, 0);

  const adopted = await accept({ digest: review.digest, expectedLatestVersionId: review.expectedLatestVersionId, accepted: true });
  assert.equal(adopted.statusCode, 200);
  assert.deepEqual(adopted.json().skill.builtIn, { release: "1.0.0", heldUpdate: null });
  assert.deepEqual(adopted.json().skill.recommendation, { dismissed: false });
  assert.deepEqual(pushed.map((entry) => entry.runnerId), ["laptop"]);
  assert.equal((await app.inject({ method: "GET", url: `/api/skills/${skill.id}/built-in-version` })).statusCode, 404);
});

test("adopting a skill with Git automatic updates, which it turns off, needs the instance owner", async (t) => {
  const { app, db, release, as } = await fixture();
  t.after(async () => { await app.close(); db.close(); });
  const imported = validateSkillPayload({ name: "using-wollipog", files: files("using-wollipog", "From Git.") });
  assert.ok(imported.ok);
  const skill = db.importGitSkill({ ...imported, expectedVersionId: null,
    source: { url: "https://example.test/w.git", ref: "main", subdirectory: "skills", path: "skills/using-wollipog", commit: "b".repeat(40) },
    scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "organization", organizationId: PERSONAL_ORGANIZATION_ID } } });
  db.setSkillGitAutoUpdate(skill.id, true);
  seedBuiltInSkills(db, release, 100);
  const payload = { digest: release[0]!.digest, expectedLatestVersionId: skill.latestVersion!.id, accepted: true };
  const review = (await app.inject({ method: "GET", url: `/api/skills/${skill.id}/built-in-version` })).json();
  assert.equal(review.gitAutoUpdate, true);

  as(human("usr_admin", "admin"));
  const refused = await app.inject({ method: "POST", url: `/api/skills/${skill.id}/built-in-version`, payload });
  assert.equal(refused.statusCode, 403);
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate?.enabled, true);

  as(human(LOCAL_OWNER_USER_ID, "owner"));
  const adopted = await app.inject({ method: "POST", url: `/api/skills/${skill.id}/built-in-version`, payload });
  assert.equal(adopted.statusCode, 200);
  assert.equal(adopted.json().skill.gitAutoUpdate.enabled, false);
  assert.ok(adopted.json().skill.builtIn);
});

test("a held release update is reviewed as an update of the built-in entry", async (t) => {
  const { app, db, release } = await fixture();
  t.after(async () => { await app.close(); db.close(); });
  const [first] = builtInSkills([{ name: "using-wollipog", files: files("using-wollipog", "Earlier release.") }], "0.9.0");
  seedBuiltInSkills(db, [first!], 50);
  const skill = db.getSkillByName("using-wollipog")!;
  const local = validateSkillPayload({ name: "using-wollipog", files: files("using-wollipog", "Local edit.") });
  assert.ok(local.ok);
  db.addSkillVersion(skill.id, local, 60);
  seedBuiltInSkills(db, release, 100);

  const review = (await app.inject({ method: "GET", url: `/api/skills/${skill.id}/built-in-version` })).json();
  assert.equal(review.kind, "update");
  assert.equal(review.currentVersion.digest, local.digest);
  const accepted = await app.inject({ method: "POST", url: `/api/skills/${skill.id}/built-in-version`,
    payload: { digest: review.digest, expectedLatestVersionId: review.expectedLatestVersionId, accepted: true } });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json().skill.builtIn, { release: "1.0.0", heldUpdate: null });
  assert.equal(db.getSkill(skill.id)!.latestVersion!.digest, release[0]!.digest);
});
