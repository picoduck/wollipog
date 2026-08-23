import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentDefinition,
  ControlPlaneToRunner,
  RunnerMetadata,
  SkillsStateMessage,
  SkillsSyncMessage,
} from "@wollipog/protocol";
import Fastify from "fastify";
import { ControlPlaneDb } from "./db.js";
import type { RunnerRequestResult } from "./hub.js";
import { RunnerRequestTimeoutError } from "./hub.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import { makeSkillsSyncPusher, registerSkillRoutes, type SkillsHub } from "./skills-route.js";

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
