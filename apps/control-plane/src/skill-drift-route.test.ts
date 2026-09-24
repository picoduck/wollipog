import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type ControlPlaneToRunner,
  type SkillDriftMessage,
  type SkillFile,
} from "@wollipog/protocol";
import { withManualInvocationFrontmatter } from "@wollipog/protocol/skill-invocation";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import { registerSkillDriftRoutes } from "./skill-drift-route.js";
import { validateSkillPayload } from "./skills.js";
import type { SkillsSyncPusher } from "./skills-route.js";

const owner: HumanPrincipal = {
  kind: "human", actorId: LOCAL_OWNER_USER_ID, userId: LOCAL_OWNER_USER_ID, userName: "Owner",
  organizationId: PERSONAL_ORGANIZATION_ID, organizationName: "Personal", role: "owner", deviceId: null, localBootstrap: true,
};

function files(body: string): SkillFile[] {
  return [
    { path: "SKILL.md", content: `---\nname: alpha\n---\n${body}\n`, encoding: "utf8" },
    { path: "notes.md", content: "Notes\n", encoding: "utf8" },
  ];
}

function setup(t: TestContext, options: { protocolVersion?: number; assign?: boolean } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  t.after(async () => { await app.close(); db.close(); });
  const protocolVersion = options.protocolVersion ?? RUNNER_CAPABILITY_MIN_PROTOCOL.skillDrift;
  for (const runnerId of ["runner-1", "runner-2"]) {
    db.registerRunner({ runnerId, hostname: runnerId, os: "linux", version: "1", agents: [
      { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code" },
    ], workspaces: [] }, 1, protocolVersion);
  }
  const v1 = validateSkillPayload({ name: "alpha", files: files("Original") });
  if (!v1.ok) throw new Error(v1.error);
  const skill = db.createSkill({ name: "alpha", files: v1.files, manifest: v1.manifest, digest: v1.digest });
  if (options.assign !== false) {
    db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
  }
  const state = {
    principal: owner,
    online: true,
    edited: files("Original\nHand edit."),
    variant: "agent" as "agent" | "manual",
    restoreStatus: "restored" as "restored" | "rejected" | "not_needed",
    commands: [] as SkillDriftMessage[],
    pushes: [] as string[],
    solicited: [] as string[],
    onRunnerRequest: undefined as (() => void) | undefined,
  };
  const report = (drift: object[]) => db.setRunnerSkillState("runner-1", { deployed: [], unmanaged: [], drift: drift as never }, Date.now());
  const observedDigest = () => skillVersionDigest(state.edited);
  const reportEdit = () => report([{ name: "alpha", digest: v1.digest, variant: state.variant, observedDigest: observedDigest(), held: true }]);
  const push = ((runnerId: string) => { state.pushes.push(runnerId); }) as SkillsSyncPusher;
  push.request = async (runnerId: string, requestId: string) => {
    state.solicited.push(runnerId);
    return { type: "skills_state", runnerId, requestId, deployed: [], unmanaged: [], drift: [] };
  };
  registerSkillDriftRoutes(app, {
    db,
    requestHuman: () => state.principal,
    requestPrincipal: () => state.principal,
    pushSkillsSync: push,
    hub: {
      isRunnerOnline: () => state.online,
      sendToRunner: () => { throw new Error("unexpected unsolicited runner message"); },
      requestFromRunner: async (runnerId, requestId, message: ControlPlaneToRunner) => {
        assert.equal(message.type, "skill_drift");
        const command = message as SkillDriftMessage;
        state.commands.push(command);
        state.onRunnerRequest?.();
        if (command.operation === "read") {
          return { type: "skill_drift_result", runnerId, requestId, status: "read", files: state.edited, observedDigest: observedDigest() };
        }
        return { type: "skill_drift_result", runnerId, requestId, status: state.restoreStatus,
          ...(state.restoreStatus === "rejected" ? { error: "The edited copy changed\u0007 after it was reviewed." } : {}) };
      },
    },
  });
  return { db, app, skill, v1, state, report, reportEdit, observedDigest };
}

const target = (digest: string, variant: "agent" | "manual" = "agent") => ({ name: "alpha", digest, variant });

test("import previews the edited copy as a library update and captures it on the deploying machine", async (t) => {
  const { db, app, skill, v1, state, reportEdit } = setup(t);
  const preview = () => app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/preview", payload: target(v1.digest) });
  assert.equal((await preview()).statusCode, 409, "a copy the machine does not report cannot be read");
  assert.equal(state.commands.length, 0);
  reportEdit();
  state.principal = { ...owner, role: "operator" };
  assert.equal((await preview()).statusCode, 403);
  state.principal = owner;
  assert.equal(state.commands.length, 0, "authorization failures never read machine files");

  const reviewed = await preview();
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  const body = reviewed.json();
  assert.deepEqual(body.files, state.edited);
  assert.deepEqual(body.previousFiles, v1.files);
  assert.equal(body.importable, true);
  assert.equal(body.disposition, "update");
  assert.equal(body.publishedFromLatest, true);
  assert.equal(state.commands[0]!.operation, "read");

  const importIt = (acceptUpdate?: boolean) => app.inject({ method: "POST", url: `/api/skill-drift/${body.previewId}/import`,
    payload: acceptUpdate === undefined ? {} : { acceptUpdate } });
  assert.equal((await importIt()).statusCode, 409, "an update requires explicit diff acceptance");
  const imported = await importIt(true);
  assert.equal(imported.statusCode, 200, imported.body);
  const latest = db.getSkillVersion(db.getSkill(skill.id)!.latestVersion!.id)!;
  assert.equal(latest.digest, skillVersionDigest(state.edited));
  assert.match(latest.note ?? "", /edited deployed copy/);
  assert.equal(latest.machineSource?.runnerId, "runner-1");
  assert.equal(imported.json().released, false, "the machine deploys the import, so reconciliation captures the edit");
  assert.deepEqual(state.commands.map((command) => command.operation), ["read", "read"],
    "import re-reads the copy, and no restore is sent to a machine that deploys the imported bytes");
  assert.deepEqual(state.pushes, ["runner-2"]);
  assert.deepEqual(state.solicited, ["runner-1"]);
  assert.deepEqual(imported.json().state.drift, []);
  assert.equal((await importIt(true)).statusCode, 404, "a review is consumed by its import");
});

test("import moves a pinned machine to the imported version and releases an undeployed copy", async (t) => {
  const pinned = setup(t);
  pinned.db.setMachineSkillVersion(pinned.skill.id, "runner-1", pinned.skill.latestVersion!.id, null, pinned.skill.latestVersion!.id);
  pinned.reportEdit();
  const reviewed = (await pinned.app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/preview", payload: target(pinned.v1.digest) })).json();
  assert.equal(reviewed.pinned, true);
  const imported = await pinned.app.inject({ method: "POST", url: `/api/skill-drift/${reviewed.previewId}/import`, payload: { acceptUpdate: true } });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().pinMoved, true);
  assert.equal(pinned.db.getMachineSkillVersion(pinned.skill.id, "runner-1")!.versionId, imported.json().version.id);
  assert.equal(imported.json().released, false);

  const undeployed = setup(t, { assign: false });
  undeployed.reportEdit();
  const review = (await undeployed.app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/preview", payload: target(undeployed.v1.digest) })).json();
  const released = await undeployed.app.inject({ method: "POST", url: `/api/skill-drift/${review.previewId}/import`, payload: { acceptUpdate: true } });
  assert.equal(released.statusCode, 200, released.body);
  assert.equal(released.json().released, true);
  const restore = undeployed.state.commands.at(-1)!;
  assert.equal(restore.operation, "restore");
  assert.equal(restore.files, undefined, "the captured copy is discarded, not rebuilt");
  assert.equal(restore.observedDigest, undeployed.observedDigest(), "release is fenced on the imported bytes");
  assert.equal(restore.confirmation, "explicit");
});

test("a Manual Only edit imports its source content, and an edited injected line cannot be imported", async (t) => {
  const { app, v1, state, reportEdit } = setup(t);
  state.variant = "manual";
  const source = files("Original\nManual edit.");
  state.edited = [{ ...source[0]!, content: withManualInvocationFrontmatter(source[0]!.content) }, source[1]!];
  reportEdit();
  const reviewed = await app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/preview", payload: target(v1.digest, "manual") });
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  assert.deepEqual(reviewed.json().files, source);
  assert.equal(reviewed.json().digest, skillVersionDigest(source));

  state.edited = [{ ...state.edited[0]!, content: state.edited[0]!.content.replace("disable-model-invocation: true", "disable-model-invocation: false") }, source[1]!];
  reportEdit();
  const blocked = await app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/preview", payload: target(v1.digest, "manual") });
  assert.equal(blocked.statusCode, 200, blocked.body);
  assert.equal(blocked.json().importable, false);
  assert.match(blocked.json().importBlocker, /Manual Only frontmatter line/);
  const refused = await app.inject({ method: "POST", url: `/api/skill-drift/${blocked.json().previewId}/import`, payload: { acceptUpdate: true } });
  assert.equal(refused.statusCode, 409);
});

test("restore is confirmed, fenced on the reported observation, and rebuilds from library files", async (t) => {
  const { app, v1, state, report, reportEdit, observedDigest } = setup(t);
  reportEdit();
  const restore = (payload: object) => app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/restore", payload });
  assert.equal((await restore({ ...target(v1.digest), observedDigest: observedDigest() })).statusCode, 400, "confirmation is required");
  assert.equal((await restore({ ...target(v1.digest), observedDigest: "f".repeat(64), confirmation: "explicit" })).statusCode, 409,
    "a restore must name the observation the machine currently reports");
  state.principal = { ...owner, role: "viewer" };
  assert.equal((await restore({ ...target(v1.digest), observedDigest: observedDigest(), confirmation: "explicit" })).statusCode, 403);
  state.principal = owner;
  assert.equal(state.commands.length, 0);

  const restored = await restore({ ...target(v1.digest), observedDigest: observedDigest(), confirmation: "explicit" });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().status, "restored");
  const command = state.commands.at(-1)!;
  assert.deepEqual(command.files, v1.files);
  assert.equal(command.observedDigest, observedDigest());
  assert.deepEqual(state.solicited, ["runner-1"]);
  assert.equal((await restore({ ...target(v1.digest), observedDigest: observedDigest(), confirmation: "explicit" })).statusCode, 409,
    "the refreshed state no longer reports the restored copy");

  reportEdit();
  state.restoreStatus = "rejected";
  const rejected = await restore({ ...target(v1.digest), observedDigest: observedDigest(), confirmation: "explicit" });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().error, "The edited copy changed after it was reviewed.");

  report([{ name: "alpha", digest: v1.digest, variant: "agent", held: true }]);
  state.restoreStatus = "restored";
  const unreadable = await restore({ ...target(v1.digest), observedDigest: null, confirmation: "explicit" });
  assert.equal(unreadable.statusCode, 200, "an unreadable copy is restored against a null observation");
  const preview = await app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/preview", payload: target(v1.digest) });
  assert.equal(preview.statusCode, 409, "an unreadable copy offers no import");
});

test("import refuses a review whose copy was edited again, and responses are reauthorized after runner awaits", async (t) => {
  const { db, app, skill, v1, state, reportEdit } = setup(t);
  reportEdit();
  const reviewed = (await app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/preview", payload: target(v1.digest) })).json();
  state.edited = files("Original\nA second, unreviewed edit.");
  const stale = await app.inject({ method: "POST", url: `/api/skill-drift/${reviewed.previewId}/import`, payload: { acceptUpdate: true } });
  assert.equal(stale.statusCode, 409);
  assert.match(stale.json().error, /changed after you reviewed it/);
  assert.equal(db.getSkill(skill.id)!.latestVersion!.id, skill.latestVersion!.id, "the library is unchanged");
  assert.equal((await app.inject({ method: "POST", url: `/api/skill-drift/${reviewed.previewId}/import`,
    payload: { acceptUpdate: true } })).statusCode, 404, "a refused review cannot be retried");

  // A principal who loses authority while the runner request is pending receives no state.
  reportEdit();
  const commandsBefore = state.commands.length;
  state.onRunnerRequest = () => { state.principal = { ...owner, role: "viewer" }; };
  const denied = await app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/restore",
    payload: { ...target(v1.digest), observedDigest: skillVersionDigest(state.edited), confirmation: "explicit" } });
  assert.equal(state.commands.at(-1)?.operation, "restore");
  assert.equal(state.commands.length, commandsBefore + 1, "the restore was dispatched before authority changed");
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().state, undefined);
});

test("drift resolution requires a runner that negotiated it and an online machine", async (t) => {
  const older = setup(t, { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.skillDrift - 1 });
  const refused = await older.app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/restore",
    payload: { ...target(older.v1.digest), observedDigest: null, confirmation: "explicit" } });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().error, /requires protocol v183/);

  const offline = setup(t);
  offline.reportEdit();
  offline.state.online = false;
  const preview = await offline.app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/preview", payload: target(offline.v1.digest) });
  assert.equal(preview.statusCode, 409);
  assert.equal(offline.state.commands.length, 0);
});
