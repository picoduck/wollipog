import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import { registerMachineSkillRoutes } from "./skill-machine-route.js";
import { validateSkillPayload } from "./skills.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import type { SkillsSyncPusher } from "./skills-route.js";

test("adoption preflight revalidates the source and current authority, rejects stale reads, and never deploys", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  t.after(async () => { await app.close(); db.close(); });
  const owner: HumanPrincipal = { kind: "human", actorId: LOCAL_OWNER_USER_ID, userId: LOCAL_OWNER_USER_ID, userName: "Owner", organizationId: PERSONAL_ORGANIZATION_ID,
    organizationName: "Personal", role: "owner", deviceId: null, localBootstrap: true };
  let principal = owner;
  let online = true;
  let content = "Original";
  let reads = 0;
  let beforeRead = async () => {};
  let corrupt = false;
  const candidate = { id: "opaque-id", name: "alpha", sourceDirectory: ".codex/skills", generation: "generation-1" };
  db.registerRunner({ runnerId: "runner-1", hostname: "host", os: "linux", version: "1", agents: [
    { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" },
  ], workspaces: [] }, 1, 111);
  registerMachineSkillRoutes(app, { db, requestHuman: () => principal, requestPrincipal: () => principal,
    pushSkillsSync: (() => { throw new Error("unexpected deployment"); }) as SkillsSyncPusher,
    hub: { isRunnerOnline: () => online, sendToRunner: () => { throw new Error("unexpected mutation"); },
      requestFromRunner: async (runnerId, requestId, request) => {
        assert.equal(request.type, "skill_snapshot");
        if (request.type !== "skill_snapshot") throw new Error();
        if (request.operation === "list") return { type: "skill_snapshot_result", runnerId, requestId, candidates: [candidate] };
        assert.equal(request.operation, "read");
        assert.equal(request.candidateId, candidate.id);
        reads++;
        await beforeRead();
        const payload = validateSkillPayload({ name: "alpha", files: [{ path: "SKILL.md", encoding: "utf8", content: `---\nname: alpha\n---\n${content}` }] });
        if (!payload.ok) throw new Error();
        return { type: "skill_snapshot_result", runnerId, requestId, snapshot: { candidate, files: payload.files, digest: corrupt ? "bad" : payload.digest } };
      } },
  });
  const id = (await app.inject({ method: "POST", url: "/api/runners/runner-1/skill-snapshots" })).json().discoveryId;
  const preview = () => app.inject({ method: "POST", url: `/api/skill-machine/${id}/preview`, payload: { candidateId: candidate.id } });
  let previewId = (await preview()).json().previewId;
  const check = (token = previewId) => app.inject({ method: "POST", url: `/api/skill-machine/${id}/adoption-preflight`, payload: { previewId: token } });
  assert.equal((await check("old-token")).statusCode, 409);
  assert.equal(reads, 1);
  principal = { ...owner, role: "operator" };
  assert.equal((await check()).statusCode, 403);
  principal = { ...owner, userId: "other-admin", actorId: "other-admin", role: "admin" };
  assert.equal((await check()).statusCode, 404);
  principal = owner;
  online = false;
  assert.equal((await check()).statusCode, 409);
  online = true;
  assert.equal(reads, 1, "authorization/token/availability failures do not read host files");
  const missing = await check();
  assert.equal(missing.statusCode, 200, missing.body);
  assert.ok(missing.json().blockers.includes("library_skill_missing"));
  const imported = (await app.inject({ method: "POST", url: `/api/skill-machine/${id}/import`, payload: { previewId } })).json().skill;
  assert.equal((await check()).statusCode, 404, "import consumes the old preview");
  previewId = (await preview()).json().previewId;
  const assignment = db.createSkillAssignment({ skillId: imported.id, scopeKind: "runner", runnerId: "runner-1", agentSelector: { kind: "agent", agentId: "codex" } });
  const ready = await check();
  assert.equal(ready.statusCode, 200, ready.body);
  assert.equal(ready.json().status, "prerequisites_met");
  assert.equal(ready.json().mutationSupported, false);
  assert.match(ready.json().notice, /No directory was changed/);
  assert.equal(ready.json().source.digest, imported.latestVersion.digest);
  content = "Changed since preview";
  assert.equal((await check()).statusCode, 502, "generation alone cannot hide edited nested file contents");
  content = "Original";
  corrupt = true;
  assert.equal((await check()).statusCode, 502);
  corrupt = false;
  beforeRead = async () => { db.updateSkillAssignment(assignment.id, { enabled: false }); };
  assert.ok((await check()).json().blockers.includes("effective_assignment_missing"), "targeting is resolved after the source read");
  beforeRead = async () => { online = false; };
  assert.equal((await check()).statusCode, 409, "disconnect during the source read prevents a ready report");
  online = true;
  beforeRead = async () => { principal = { ...owner, role: "operator" }; };
  assert.equal((await check()).statusCode, 403, "authority is checked again after the source read");
  principal = owner;
  beforeRead = async () => { throw new Error("secret transport diagnostics"); };
  const failed = await check();
  assert.equal(failed.statusCode, 502);
  assert.doesNotMatch(failed.body, /secret|transport diagnostics/);
  let release!: () => void;
  let entered!: () => void;
  const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  beforeRead = async () => { entered(); await held; };
  const inFlight = check().then((response) => response);
  await enteredRead;
  assert.equal((await check()).statusCode, 429, "content reads are bounded to one in flight");
  await app.inject({ method: "DELETE", url: `/api/skill-machine/${id}` });
  release();
  assert.equal((await inFlight).statusCode, 409, "cancelled preview cannot return a usable report");
  assert.equal(db.listSkills().length, 1);
  assert.equal(db.getSkill(imported.id)!.latestVersion!.id, imported.latestVersion.id);
  assert.equal(db.listSkillAssignments(imported.id).length, 1);
});

test("machine discovery, preview and import are authorized, immutable, deduplicated, version-fenced and non-adopting", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  t.after(async () => { await app.close(); db.close(); });
  const owner: HumanPrincipal = { kind: "human", actorId: LOCAL_OWNER_USER_ID, userId: LOCAL_OWNER_USER_ID, userName: "Owner", organizationId: PERSONAL_ORGANIZATION_ID,
    organizationName: "Personal", role: "owner", deviceId: null, localBootstrap: true };
  let principal = owner;
  let online = true;
  let content = "Original";
  let corrupt = false;
  let reads = 0;
  const pushes: string[] = [];
  const candidate = { id: "opaque-id", name: "alpha", sourceDirectory: ".codex/skills", generation: "generation-1" };
  let candidates = [candidate];
  db.registerRunner({ runnerId: "runner-1", hostname: "host", os: "linux", version: "1", agents: [], workspaces: [] }, 1, 111);
  registerMachineSkillRoutes(app, { db, requestHuman: () => principal, requestPrincipal: () => principal,
    pushSkillsSync: ((id: string) => { pushes.push(id); }) as SkillsSyncPusher,
    hub: { isRunnerOnline: () => online, sendToRunner: () => { throw new Error("unexpected deployment"); },
      requestFromRunner: async (runnerId, requestId, request) => {
        assert.equal(request.type, "skill_snapshot");
        if (request.type !== "skill_snapshot") throw new Error();
        reads++;
        if (request.operation === "list") return { type: "skill_snapshot_result", runnerId, requestId, candidates };
        assert.equal(request.candidateId, candidate.id);
        const payload = validateSkillPayload({ name: "alpha", files: [{ path: "SKILL.md", encoding: "utf8", content: `---\nname: alpha\n---\n${content}` }] });
        if (!payload.ok) throw new Error();
        return { type: "skill_snapshot_result", runnerId, requestId, snapshot: { candidate, files: payload.files, digest: corrupt ? "bad" : payload.digest } };
      } },
  });
  const discover = () => app.inject({ method: "POST", url: "/api/runners/runner-1/skill-snapshots" });
  const preview = (id: string, candidateId = candidate.id) => app.inject({ method: "POST", url: `/api/skill-machine/${id}/preview`, payload: { candidateId } });
  const accept = (id: string, previewId: string, acceptUpdate = false) => app.inject({ method: "POST", url: `/api/skill-machine/${id}/import`, payload: { previewId, acceptUpdate } });
  principal = { ...owner, role: "operator" };
  assert.equal((await discover()).statusCode, 403);
  principal = { ...owner, organizationId: "other-org", userId: "other", actorId: "other", localBootstrap: false };
  assert.equal((await discover()).statusCode, 404);
  assert.equal(reads, 0);
  principal = owner;
  online = false;
  assert.equal((await discover()).statusCode, 409);
  online = true;
  db.registerRunner({ runnerId: "runner-1", hostname: "host", os: "linux", version: "1", agents: [], workspaces: [] }, 2, 110);
  assert.equal((await discover()).statusCode, 409);
  assert.equal(reads, 0);
  db.registerRunner({ runnerId: "runner-1", hostname: "host", os: "darwin", version: "1", agents: [], workspaces: [] }, 3, 111);
  assert.equal((await discover()).statusCode, 409);
  assert.equal(reads, 0, "unsupported platform never reaches the runner");
  db.registerRunner({ runnerId: "runner-1", hostname: "host", os: "linux", version: "1", agents: [], workspaces: [] }, 3, 111);
  for (const malformed of [[{ ...candidate, sourceDirectory: "/etc" }], [candidate, candidate],
    [{ ...candidate, id: "a".repeat(65) }], [{ ...candidate, name: "../escape" }],
    [{ ...candidate, generation: "x".repeat(201) }], Array.from({ length: 65 }, (_, i) => ({ ...candidate, id: String(i) }))]) {
    candidates = malformed;
    assert.equal((await discover()).statusCode, 502);
  }
  candidates = [{ ...candidate, ...{ unexpected: "must not be cached or returned" } }];
  const listed = await discover();
  assert.equal(listed.statusCode, 200, listed.body);
  assert.doesNotMatch(listed.body, /unexpected|must not/);
  const id = listed.json().discoveryId;
  assert.equal((await preview(id, "/arbitrary/path")).statusCode, 400);
  const first = await preview(id);
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(db.listSkills(), []);
  assert.deepEqual(pushes, []);
  principal = { ...owner, userId: "another-admin", actorId: "another-admin", role: "admin" };
  assert.equal((await preview(id)).statusCode, 404);
  assert.equal((await accept(id, first.json().previewId)).statusCode, 404);
  principal = owner;
  content = "Changed on source after preview";
  online = false;
  const created = await accept(id, first.json().previewId);
  assert.equal(created.statusCode, 200, created.body);
  const skill = created.json().skill;
  const version = db.getSkillVersion(skill.latestVersion.id)!;
  assert.match(version.files[0]!.content, /Original/);
  assert.equal(version.machineSource?.digest, version.digest);
  assert.equal(version.machineSource?.runnerId, "runner-1");
  assert.equal(db.listSkillAssignments(skill.id).length, 0);
  assert.deepEqual(pushes, []);
  assert.equal((await accept(id, first.json().previewId)).statusCode, 404);
  online = true;
  content = "Original";
  const identical = (await preview(id)).json();
  assert.equal(identical.disposition, "identical");
  assert.equal((await accept(id, identical.previewId)).json().skill.latestVersion.id, version.id);
  content = "Updated";
  const update = (await preview(id)).json();
  assert.equal(update.disposition, "update");
  assert.equal((await accept(id, update.previewId)).statusCode, 409);
  const newer = (await preview(id)).json();
  assert.equal((await accept(id, update.previewId, true)).statusCode, 409, "old UI cannot import a replaced preview");
  assert.equal((await accept(id, newer.previewId, true)).statusCode, 200);
  assert.deepEqual(pushes, ["runner-1"]);
  const stale = (await preview(id)).json();
  db.addSkillVersion(skill.id, { files: version.files, digest: version.digest, manifest: version.manifest });
  assert.equal((await accept(id, stale.previewId, true)).statusCode, 409);
  corrupt = true;
  assert.equal((await preview(id)).statusCode, 502);
  assert.equal((await accept(id, stale.previewId, true)).statusCode, 404, "failed preview revokes the previous acceptance token");
  corrupt = false;
  const failure = (await preview(id)).json();
  db.importMachineSkill = () => { throw new Error("secret SQL details"); };
  const rejected = await accept(id, failure.previewId, true);
  assert.equal(rejected.statusCode, 500);
  assert.doesNotMatch(rejected.body, /secret|SQL/);
  await app.inject({ method: "DELETE", url: `/api/skill-machine/${id}` });
  assert.equal((await preview(id)).statusCode, 404);
});
