import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentDefinition,
  ControlPlaneToRunner,
  RunnerMetadata,
  SkillsSyncManifestMessage,
  SkillsStateMessage,
  SkillsSyncMessage,
} from "@wollipog/protocol";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import type { RunnerRequestResult } from "./hub.js";
import { RunnerRequestTimeoutError } from "./hub.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import {
  resolveDesiredSkills,
  SKILLS_SYNC_MAX_TOTAL_BYTES,
  skillsSyncMessageBytes,
} from "./skills.js";
import { makeSkillsSyncPusher, registerSkillRoutes, type SkillsHub, type SkillsLog } from "./skills-route.js";

const AGENTS: AgentDefinition[] = [
  { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" },
  { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" },
];

const runnerMeta = (runnerId: string): RunnerMetadata => ({
  runnerId, hostname: `${runnerId}-host`, os: "linux", version: "1.0.0", agents: AGENTS, workspaces: [],
});

function principal(): HumanPrincipal {
  return {
    kind: "human",
    actorId: LOCAL_OWNER_USER_ID,
    userId: LOCAL_OWNER_USER_ID,
    userName: "Owner",
    organizationId: PERSONAL_ORGANIZATION_ID,
    organizationName: PERSONAL_ORGANIZATION_ID,
    role: "owner",
    deviceId: null,
    localBootstrap: true,
  };
}

function humanPrincipal(userId: string, organizationId: string, role: "admin" | "operator"): HumanPrincipal {
  return {
    kind: "human",
    actorId: userId,
    userId,
    userName: userId,
    organizationId,
    organizationName: organizationId,
    role,
    deviceId: null,
    localBootstrap: false,
  };
}

function skillPayload(name: string) {
  return {
    name,
    files: [{ path: "SKILL.md", content: `---\nname: ${name}\ndescription: From frontmatter.\n---\nBody`, encoding: "utf8" }],
  };
}

async function fixture() {
  const db = ControlPlaneDb.open(":memory:");
  const online = new Set<string>();
  const pushed: Array<{ runnerId: string; msg: ControlPlaneToRunner }> = [];
  let nextRequestResult: ((msg: SkillsSyncMessage) => Promise<RunnerRequestResult>) | null = null;
  const hub: SkillsHub = {
    isRunnerOnline: (runnerId: string) => online.has(runnerId),
    sendToRunner: (runnerId: string, msg: ControlPlaneToRunner) => {
      pushed.push({ runnerId, msg });
      return true;
    },
    requestFromRunner: (_runnerId, _requestId, msg) => {
      if (!nextRequestResult) throw new Error("test forgot to stub requestFromRunner");
      return nextRequestResult(msg as SkillsSyncMessage);
    },
  } as SkillsHub;
  const app = Fastify();
  registerSkillRoutes(app, {
    db,
    hub,
    requestHuman: () => principal(),
    requestPrincipal: () => principal(),
    pushSkillsSync: makeSkillsSyncPusher({ db, hub }),
  });
  await app.ready();
  return {
    app, db, online, pushed,
    stubRequest(fn: (msg: SkillsSyncMessage) => Promise<RunnerRequestResult>) { nextRequestResult = fn; },
  };
}

test("POST /api/skills validates, creates skill + first version, and rejects duplicates", async (t) => {
  const { app, db } = await fixture();
  t.after(() => app.close());

  const created = await app.inject({ method: "POST", url: "/api/skills", payload: skillPayload("alpha-skill") });
  assert.equal(created.statusCode, 201);
  const { skill } = created.json();
  assert.equal(skill.name, "alpha-skill");
  assert.equal(skill.description, "From frontmatter.");
  assert.ok(skill.latestVersion.digest);
  assert.deepEqual(db.skillScope(skill.id), {
    organizationId: PERSONAL_ORGANIZATION_ID,
    owner: { kind: "organization", organizationId: PERSONAL_ORGANIZATION_ID },
  });

  const duplicate = await app.inject({ method: "POST", url: "/api/skills", payload: skillPayload("alpha-skill") });
  assert.equal(duplicate.statusCode, 409);

  const invalid = await app.inject({
    method: "POST",
    url: "/api/skills",
    payload: { name: "no-manifest", files: [{ path: "notes.md", content: "x", encoding: "utf8" }] },
  });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.json().error, /SKILL\.md/);

  const badGroup = await app.inject({
    method: "POST",
    url: "/api/skills",
    payload: { ...skillPayload("grouped-skill"), groupId: "missing" },
  });
  assert.equal(badGroup.statusCode, 400);

  const listed = await app.inject({ method: "GET", url: "/api/skills" });
  assert.deepEqual(listed.json().skills.map((row: { name: string }) => row.name), ["alpha-skill"]);

  const detail = await app.inject({ method: "GET", url: `/api/skills/${skill.id}` });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().latestVersion.files[0].path, "SKILL.md");
  assert.deepEqual(detail.json().assignments, []);
});

test("assignment mutations push a fire-and-forget skills_sync to affected capable runners only", async (t) => {
  const { app, db, online, pushed } = await fixture();
  t.after(() => app.close());
  db.registerRunner(runnerMeta("capable"), 10, 90);
  db.registerRunner(runnerMeta("legacy"), 10, 89);
  db.registerRunner(runnerMeta("offline"), 10, 90);
  online.add("capable");
  online.add("legacy");

  const created = await app.inject({ method: "POST", url: "/api/skills", payload: skillPayload("alpha-skill") });
  const skillId = created.json().skill.id as string;
  pushed.length = 0;

  const assigned = await app.inject({
    method: "POST",
    url: "/api/skill-assignments",
    payload: { skillId, scopeKind: "instance", agentSelector: { kind: "all" } },
  });
  assert.equal(assigned.statusCode, 201);
  assert.deepEqual(pushed.map((entry) => entry.runnerId), ["capable"],
    "offline and pre-v90 runners are skipped by the pusher");
  const sync = pushed[0]!.msg as SkillsSyncMessage;
  assert.equal(sync.type, "skills_sync");
  assert.equal(sync.requestId, undefined, "push-on-change is uncorrelated");
  assert.equal(sync.skills[0]!.name, "alpha-skill");
  assert.deepEqual(sync.skills[0]!.targets.map((target) => target.agentId), ["claude", "codex"]);

  // A runner-scoped mutation re-syncs only its machine.
  pushed.length = 0;
  const scoped = await app.inject({
    method: "POST",
    url: "/api/skill-assignments",
    payload: { skillId, scopeKind: "runner", runnerId: "capable", agentSelector: { kind: "agent", agentId: "codex" } },
  });
  assert.equal(scoped.statusCode, 201);
  assert.deepEqual(pushed.map((entry) => entry.runnerId), ["capable"]);

  const badSelector = await app.inject({
    method: "POST",
    url: "/api/skill-assignments",
    payload: { skillId, scopeKind: "instance", agentSelector: { kind: "everything" } },
  });
  assert.equal(badSelector.statusCode, 400);
  const missingRunner = await app.inject({
    method: "POST",
    url: "/api/skill-assignments",
    payload: { skillId, scopeKind: "runner", runnerId: "nope", agentSelector: { kind: "all" } },
  });
  assert.equal(missingRunner.statusCode, 404);

  pushed.length = 0;
  const toggled = await app.inject({
    method: "PATCH",
    url: `/api/skill-assignments/${scoped.json().assignment.id}`,
    payload: { enabled: false },
  });
  assert.equal(toggled.statusCode, 200);
  assert.equal(toggled.json().assignment.enabled, false);
  assert.deepEqual(pushed.map((entry) => entry.runnerId), ["capable"]);
});

test("POST /api/runners/:id/skills/sync gates offline and capability, persists the correlated state", async (t) => {
  const { app, db, online, stubRequest } = await fixture();
  t.after(() => app.close());
  db.registerRunner(runnerMeta("runner-1"), 10, 90);

  const missing = await app.inject({ method: "POST", url: "/api/runners/nope/skills/sync" });
  assert.equal(missing.statusCode, 404);

  const offline = await app.inject({ method: "POST", url: "/api/runners/runner-1/skills/sync" });
  assert.equal(offline.statusCode, 409);
  assert.match(offline.json().error, /offline/);

  online.add("runner-1");
  db.registerRunner(runnerMeta("runner-1"), 20, 89);
  const incapable = await app.inject({ method: "POST", url: "/api/runners/runner-1/skills/sync" });
  assert.equal(incapable.statusCode, 409);
  assert.match(incapable.json().error, /update/i);

  db.registerRunner(runnerMeta("runner-1"), 30, 90);
  const created = await app.inject({ method: "POST", url: "/api/skills", payload: skillPayload("alpha-skill") });
  await app.inject({
    method: "POST",
    url: "/api/skill-assignments",
    payload: { skillId: created.json().skill.id, scopeKind: "instance", agentSelector: { kind: "all" } },
  });

  stubRequest(async (msg) => {
    assert.equal(msg.type, "skills_sync");
    assert.equal(msg.runnerId, "runner-1");
    assert.equal(msg.skills[0]!.name, "alpha-skill");
    assert.ok(msg.requestId);
    const state: SkillsStateMessage & { requestId: string } = {
      type: "skills_state",
      runnerId: "runner-1",
      requestId: msg.requestId!,
      deployed: [{
        name: "alpha-skill",
        digest: msg.skills[0]!.versionDigest,
        links: [{ agentId: "claude", status: "linked" }, { agentId: "codex", status: "linked" }],
      }],
      unmanaged: [],
    };
    return state;
  });
  const synced = await app.inject({ method: "POST", url: "/api/runners/runner-1/skills/sync" });
  assert.equal(synced.statusCode, 200);
  assert.equal(synced.json().state.deployed[0].name, "alpha-skill");
  assert.equal(db.getRunnerSkillState("runner-1")!.deployed[0]!.name, "alpha-skill");

  const view = await app.inject({ method: "GET", url: "/api/runners/runner-1/skills" });
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().desired[0].name, "alpha-skill");
  assert.equal(view.json().desired[0].files, undefined, "the listing omits file contents");
  assert.equal(view.json().reported.deployed[0].name, "alpha-skill");

  stubRequest(async () => { throw new RunnerRequestTimeoutError(); });
  const timedOut = await app.inject({ method: "POST", url: "/api/runners/runner-1/skills/sync" });
  assert.equal(timedOut.statusCode, 504);

  stubRequest(async (msg) => ({
    type: "git_result", requestId: msg.requestId!, ok: true,
  } as unknown as RunnerRequestResult));
  const unexpected = await app.inject({ method: "POST", url: "/api/runners/runner-1/skills/sync" });
  assert.equal(unexpected.statusCode, 502);
});

// REGRESSION (P1): every skill route used to trust any authenticated member — including an admin
// of a DIFFERENT organization — with the entire library (list, full version files, update,
// version, delete, assignments). Per-resource ownership now mirrors /api/projects exactly:
// listings filter to accessible scopes and an inaccessible id answers 404, never 403.
test("skill and assignment routes are ownership-scoped per resource: foreign org and foreign user get 404", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  const hub: SkillsHub = {
    isRunnerOnline: () => false,
    sendToRunner: () => true,
    requestFromRunner: async () => { throw new Error("unused"); },
  } as SkillsHub;
  let current: HumanPrincipal = principal();
  const app = Fastify();
  registerSkillRoutes(app, {
    db,
    hub,
    requestHuman: () => current,
    requestPrincipal: () => current,
    pushSkillsSync: makeSkillsSyncPusher({ db, hub }),
  });
  await app.ready();
  t.after(() => app.close());

  // The personal-organization owner creates an org-scoped skill with an instance assignment.
  const created = await app.inject({ method: "POST", url: "/api/skills", payload: skillPayload("home-skill") });
  assert.equal(created.statusCode, 201);
  const skillId = created.json().skill.id as string;
  const assigned = await app.inject({
    method: "POST",
    url: "/api/skill-assignments",
    payload: { skillId, scopeKind: "instance", agentSelector: { kind: "all" } },
  });
  assert.equal(assigned.statusCode, 201);
  const assignmentId = assigned.json().assignment.id as string;

  // A user-scoped skill belonging to another ordinary member of the same organization.
  const privateSkill = db.createSkill({
    name: "private-skill",
    files: [{ path: "SKILL.md", content: "---\nname: private-skill\n---\nBody", encoding: "utf8" }],
    manifest: '{"files":[]}',
    digest: "private-digest",
    scope: { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user", userId: "usr_private_owner" } },
  });

  /* ------------- an admin of a DIFFERENT organization sees and touches nothing ------------- */
  current = humanPrincipal("usr_foreign_admin", "org_foreign", "admin");
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/skills" })).json().skills, [],
    "the listing filters out every foreign-organization skill");
  assert.equal((await app.inject({ method: "GET", url: `/api/skills/${skillId}` })).statusCode, 404,
    "reading a foreign skill (with its full version files) is a 404, not a 403");
  assert.equal((await app.inject({
    method: "PUT", url: `/api/skills/${skillId}`, payload: { description: "defaced" },
  })).statusCode, 404);
  assert.equal((await app.inject({
    method: "POST", url: `/api/skills/${skillId}/versions`, payload: skillPayload("home-skill"),
  })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/skills/${skillId}` })).statusCode, 404);
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/skill-assignments" })).json().assignments, [],
    "assignment listings filter by the referenced skill's ownership");
  assert.equal((await app.inject({
    method: "POST",
    url: "/api/skill-assignments",
    payload: { skillId, scopeKind: "instance", agentSelector: { kind: "all" } },
  })).statusCode, 404, "assigning a foreign skill is a 404 on the skill");
  assert.equal((await app.inject({
    method: "PATCH", url: `/api/skill-assignments/${assignmentId}`, payload: { enabled: false },
  })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/skill-assignments/${assignmentId}` })).statusCode, 404);

  /* --------- an ordinary member cannot read another member's user-scoped skill --------- */
  current = humanPrincipal("usr_other_member", PERSONAL_ORGANIZATION_ID, "operator");
  assert.deepEqual(
    ((await app.inject({ method: "GET", url: "/api/skills" })).json().skills as Array<{ name: string }>)
      .map((row) => row.name),
    ["home-skill"],
    "an ordinary member sees org-scoped skills but not another user's user-scoped skill",
  );
  assert.equal((await app.inject({ method: "GET", url: `/api/skills/${privateSkill.id}` })).statusCode, 404);

  /* ------- runner-scoped assignments demand runner access like other per-runner routes ------- */
  db.registerRunner(runnerMeta("private-runner"), 10, 90,
    { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "user", userId: "usr_private_owner" } });
  assert.equal((await app.inject({
    method: "POST",
    url: "/api/skill-assignments",
    payload: { skillId, scopeKind: "runner", runnerId: "private-runner", agentSelector: { kind: "all" } },
  })).statusCode, 404, "the caller can access the skill but not this private machine");

  /* ----------------- none of the denied calls touched the owner's resources ----------------- */
  current = principal();
  assert.equal((await app.inject({ method: "GET", url: `/api/skills/${skillId}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/api/skills/${privateSkill.id}` })).statusCode, 200,
    "an organization admin still reaches a member's user-scoped skill");
  assert.equal(db.getSkillAssignment(assignmentId)!.enabled, true, "the foreign PATCH never landed");
});

// REGRESSION (P2): per-skill payloads are capped, but enough of them assigned to one machine used
// to assemble an unbounded skills_sync that would blow the runner websocket frame limit and close
// the connection on a routine push. The aggregate must fail closed — a truncated authoritative
// list would make the runner delete deployed skills — so nothing is sent at all.
test("an over-budget aggregate skills_sync fails closed: push skipped, manual sync 409", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  const pushed: Array<{ runnerId: string; msg: ControlPlaneToRunner }> = [];
  const requested: SkillsSyncMessage[] = [];
  const errors: string[] = [];
  const log: SkillsLog = { debug: () => {}, warn: () => {}, error: (message) => errors.push(message) };
  const hub: SkillsHub = {
    isRunnerOnline: () => true,
    sendToRunner: (runnerId: string, msg: ControlPlaneToRunner) => {
      pushed.push({ runnerId, msg });
      return true;
    },
    requestFromRunner: async (_runnerId, requestId, msg) => {
      requested.push(msg as SkillsSyncMessage);
      const state: SkillsStateMessage & { requestId: string } = {
        type: "skills_state", runnerId: "runner-1", requestId, deployed: [], unmanaged: [],
      };
      return state;
    },
  } as SkillsHub;
  const pushSkillsSync = makeSkillsSyncPusher({ db, hub, log });
  const app = Fastify();
  registerSkillRoutes(app, {
    db, hub, requestHuman: () => principal(), requestPrincipal: () => principal(), pushSkillsSync,
  });
  await app.ready();
  t.after(() => app.close());
  db.registerRunner(runnerMeta("runner-1"), 10, 90);

  // Four ~7.875 MiB skills stay just under the 32 MiB budget even with JSON envelope overhead.
  const contentBytes = SKILLS_SYNC_MAX_TOTAL_BYTES / 4 - 128 * 1024;
  const addSkill = (index: number) => {
    const skill = db.createSkill({
      name: `bulk-${index}`,
      description: null,
      groupId: null,
      files: [{ path: "SKILL.md", content: "x".repeat(contentBytes), encoding: "utf8" }],
      manifest: '{"files":[]}',
      digest: `bulk-${index}-digest`,
    });
    db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
  };
  for (let index = 0; index < 4; index++) addSkill(index);

  pushSkillsSync("runner-1");
  assert.equal(pushed.length, 1, "a just-under-budget aggregate is pushed normally");
  assert.equal((pushed[0]!.msg as SkillsSyncMessage).skills.length, 4);
  assert.deepEqual(errors, []);
  const underBudget = await app.inject({ method: "POST", url: "/api/runners/runner-1/skills/sync" });
  assert.equal(underBudget.statusCode, 200, "a just-under-budget aggregate syncs normally");
  assert.equal(requested.length, 1);

  // A fifth max-size skill tips the aggregate over the budget.
  addSkill(4);
  pushed.length = 0;
  requested.length = 0;
  pushSkillsSync("runner-1");
  assert.equal(pushed.length, 0, "an over-budget aggregate is never pushed, not even truncated");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /bytes/);
  assert.ok(errors[0]!.includes(String(SKILLS_SYNC_MAX_TOTAL_BYTES)), "the error names the budget");

  const overBudget = await app.inject({ method: "POST", url: "/api/runners/runner-1/skills/sync" });
  assert.equal(overBudget.statusCode, 409);
  assert.match(overBudget.json().error, /bytes/);
  assert.ok(overBudget.json().error.includes(String(SKILLS_SYNC_MAX_TOTAL_BYTES)),
    "the 409 names the machine's aggregate size and the budget");
  assert.equal(requested.length, 0, "the oversized frame never reaches the runner");
});

test("a v96 runner receives an over-budget desired set as manifest plus requested digest frames", () => {
  const db = ControlPlaneDb.open(":memory:");
  const pushed: Array<{ runnerId: string; msg: ControlPlaneToRunner }> = [];
  const hub: SkillsHub = {
    isRunnerOnline: () => true,
    sendToRunner: (runnerId: string, msg: ControlPlaneToRunner) => {
      pushed.push({ runnerId, msg });
      return true;
    },
    requestFromRunner: async () => { throw new Error("unused"); },
  } as SkillsHub;
  db.registerRunner(runnerMeta("runner-v96"), 10, 96);
  const contentBytes = 2 * 1024 * 1024 - 16 * 1024;
  for (let index = 0; index < 17; index += 1) {
    const skill = db.createSkill({
      name: `chunked-${index}`,
      description: null,
      groupId: null,
      files: [{ path: "SKILL.md", content: "x".repeat(contentBytes), encoding: "utf8" }],
      manifest: '{"files":[]}',
      digest: index.toString(16).padStart(64, "0"),
    });
    db.createSkillAssignment({
      skillId: skill.id,
      scopeKind: "instance",
      agentSelector: { kind: "all" },
    });
  }

  const sync = makeSkillsSyncPusher({ db, hub });
  sync("runner-v96");
  assert.equal(pushed.length, 1);
  const manifest = pushed[0]!.msg as SkillsSyncManifestMessage;
  assert.equal(manifest.type, "skills_sync_manifest");
  assert.equal(manifest.skills.length, 17);
  assert.equal("files" in manifest.skills[0]!, false, "the authoritative list carries no content bytes");

  // The runner reports only two missing digests; the other fifteen are already in its store and
  // must not be transferred again.
  sync.handleNeed({
    type: "skills_sync_need",
    runnerId: "runner-v96",
    syncId: manifest.syncId,
    missing: manifest.skills.slice(0, 2).map(({ name, versionDigest }) => ({ name, versionDigest })),
  });
  const content = pushed.filter((entry) => entry.msg.type === "skills_sync_content");
  assert.equal(content.length, 2);
  assert.deepEqual(
    content.map((entry) => (entry.msg as Extract<ControlPlaneToRunner, { type: "skills_sync_content" }>).name),
    manifest.skills.slice(0, 2).map((entry) => entry.name),
  );
  assert.equal(pushed.at(-1)!.msg.type, "skills_sync_complete");

  const legacyShape: SkillsSyncMessage = {
    type: "skills_sync",
    runnerId: "runner-v96",
    skills: resolveDesiredSkills(db, "runner-v96"),
  };
  assert.ok(skillsSyncMessageBytes(legacyShape) > SKILLS_SYNC_MAX_TOTAL_BYTES,
    "the same authoritative state exceeds the retired aggregate frame budget");

  const sentBeforeStaleNeed = pushed.length;
  sync.handleNeed({
    type: "skills_sync_need",
    runnerId: "runner-v96",
    syncId: manifest.syncId,
    missing: [],
  });
  assert.equal(pushed.length, sentBeforeStaleNeed, "a completed transaction cannot be requested again");
});

test("a push superseding a solicited v96 sync preserves its request correlation", () => {
  const db = ControlPlaneDb.open(":memory:");
  const pushed: ControlPlaneToRunner[] = [];
  const hub: SkillsHub = {
    isRunnerOnline: () => true,
    sendToRunner: (_runnerId: string, msg: ControlPlaneToRunner) => {
      pushed.push(msg);
      return true;
    },
    requestFromRunner: async (_runnerId: string, _requestId: string, msg: ControlPlaneToRunner) => {
      pushed.push(msg);
      return await new Promise<RunnerRequestResult>(() => {});
    },
  } as SkillsHub;
  db.registerRunner(runnerMeta("runner-v96"), 10, 96);
  const sync = makeSkillsSyncPusher({ db, hub });

  void sync.request("runner-v96", "request-original");
  sync("runner-v96");
  const manifests = pushed.filter(
    (msg): msg is SkillsSyncManifestMessage => msg.type === "skills_sync_manifest",
  );
  assert.equal(manifests.length, 2);
  assert.equal(manifests[1]!.requestId, "request-original");
});

test("orphaned v96 deliveries expire and reject duplicate digest requests", async () => {
  const db = ControlPlaneDb.open(":memory:");
  const pushed: ControlPlaneToRunner[] = [];
  const warnings: string[] = [];
  const hub: SkillsHub = {
    isRunnerOnline: () => true,
    sendToRunner: (_runnerId: string, msg: ControlPlaneToRunner) => {
      pushed.push(msg);
      return true;
    },
    requestFromRunner: async () => { throw new Error("unused"); },
  } as SkillsHub;
  db.registerRunner(runnerMeta("runner-v96"), 10, 96);
  const skill = db.createSkill({
    name: "alpha",
    description: null,
    groupId: null,
    files: [{ path: "SKILL.md", content: "alpha", encoding: "utf8" }],
    manifest: '{"files":[]}',
    digest: "a".repeat(64),
  });
  db.createSkillAssignment({
    skillId: skill.id,
    scopeKind: "instance",
    agentSelector: { kind: "all" },
  });
  const log: SkillsLog = { debug: () => {}, error: () => {}, warn: (message) => warnings.push(message) };
  const sync = makeSkillsSyncPusher({ db, hub, log, deliveryTtlMs: 10 });

  sync("runner-v96");
  const expired = pushed[0] as SkillsSyncManifestMessage;
  await delay(25);
  sync.handleNeed({
    type: "skills_sync_need",
    runnerId: "runner-v96",
    syncId: expired.syncId,
    missing: expired.skills.map(({ name, versionDigest }) => ({ name, versionDigest })),
  });
  assert.equal(pushed.length, 1);
  assert.ok(warnings.some((message) => message.includes("expired incomplete skills delivery")));

  sync("runner-v96");
  const duplicate = pushed.at(-1) as SkillsSyncManifestMessage;
  const missing = duplicate.skills.map(({ name, versionDigest }) => ({ name, versionDigest }));
  sync.handleNeed({
    type: "skills_sync_need",
    runnerId: "runner-v96",
    syncId: duplicate.syncId,
    missing: [missing[0]!, missing[0]!],
  });
  assert.equal(pushed.filter((msg) => msg.type === "skills_sync_content").length, 1);
  assert.equal(pushed.some((msg) => msg.type === "skills_sync_complete" && msg.syncId === duplicate.syncId), false);
});

test("runner-scoped assignments require machine access and scope containment", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  const hub: SkillsHub = {
    isRunnerOnline: () => false,
    sendToRunner: () => true,
    requestFromRunner: async () => { throw new Error("unused"); },
  } as SkillsHub;
  let current: HumanPrincipal = principal();
  const app = Fastify();
  registerSkillRoutes(app, {
    db,
    hub,
    requestHuman: () => current,
    requestPrincipal: () => current,
    pushSkillsSync: makeSkillsSyncPusher({ db, hub }),
  });
  await app.ready();
  t.after(() => app.close());

  // A machine privately scoped to one ordinary member.
  db.registerRunner(runnerMeta("runner-private"), 10, 90, {
    organizationId: PERSONAL_ORGANIZATION_ID,
    owner: { kind: "user", userId: "usr_b" },
  });

  // The owner publishes an org-scoped skill.
  const created = await app.inject({ method: "POST", url: "/api/skills", payload: skillPayload("org-skill") });
  assert.equal(created.statusCode, 201);
  const skillId = created.json().skill.id as string;

  // Assigning a skill whose audience is wider than the machine's is rejected up front — the
  // delivery-time containment rule would silently drop it, so a 201 here could never deploy.
  current = humanPrincipal("usr_b", PERSONAL_ORGANIZATION_ID, "operator");
  const rejected = await app.inject({
    method: "POST",
    url: "/api/skill-assignments",
    payload: { skillId, scopeKind: "runner", runnerId: "runner-private", agentSelector: { kind: "all" } },
  });
  assert.equal(rejected.statusCode, 409, "scope-incompatible runner assignments are rejected, not accepted inertly");

  // A runner-scoped row referencing a machine the caller cannot access is invisible and
  // immutable even though the skill itself is org-visible. Seeded directly: route-level guards
  // cannot retroactively fix rows whose ownership drifted after creation.
  const seeded = db.createSkillAssignment({
    skillId, scopeKind: "runner", runnerId: "runner-private", agentSelector: { kind: "all" }, invocation: "agent",
  });
  current = humanPrincipal("usr_other", PERSONAL_ORGANIZATION_ID, "operator");
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/skill-assignments" })).json().assignments, [],
    "a member without machine access cannot see the private-runner assignment");
  assert.deepEqual((await app.inject({ method: "GET", url: `/api/skills/${skillId}` })).json().assignments, [],
    "the skill detail hides assignments on inaccessible machines");
  assert.equal((await app.inject({
    method: "PATCH", url: `/api/skill-assignments/${seeded.id}`, payload: { enabled: false },
  })).statusCode, 404);
  assert.equal((await app.inject({ method: "DELETE", url: `/api/skill-assignments/${seeded.id}` })).statusCode, 404);

  // The machine's own user still sees and manages the row.
  current = humanPrincipal("usr_b", PERSONAL_ORGANIZATION_ID, "operator");
  assert.equal((await app.inject({ method: "GET", url: "/api/skill-assignments" })).json().assignments.length, 1,
    "the machine's user sees the assignment");
  assert.equal((await app.inject({
    method: "PATCH", url: `/api/skill-assignments/${seeded.id}`, payload: { enabled: false },
  })).statusCode, 200);
});
