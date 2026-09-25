import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type ControlPlaneToRunner,
  type SkillDriftMessage,
  type SkillFile,
  type SkillKeptAsideMessage,
} from "@wollipog/protocol";
import { withManualInvocationFrontmatter } from "@wollipog/protocol/skill-invocation";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import { registerSkillDriftRoutes } from "./skill-drift-route.js";
import { listOrphanedSkillCopies } from "./skill-orphan-route.js";
import { validateSkillPayload } from "./skills.js";
import type { SkillsSyncPusher } from "./skills-route.js";

const owner: HumanPrincipal = {
  kind: "human", actorId: LOCAL_OWNER_USER_ID, userId: LOCAL_OWNER_USER_ID, userName: "Owner",
  organizationId: PERSONAL_ORGANIZATION_ID, organizationName: "Personal", role: "owner", deviceId: null, localBootstrap: true,
};

function files(name: string, body: string): SkillFile[] {
  return [
    { path: "SKILL.md", content: `---\nname: ${name}\n---\n${body}\n`, encoding: "utf8" },
    { path: "notes.md", content: "Notes\n", encoding: "utf8" },
  ];
}

function payload(name: string, body: string) {
  const validated = validateSkillPayload({ name, files: files(name, body) });
  if (!validated.ok) throw new Error(validated.error);
  return validated;
}

function setup(t: TestContext, options: { protocolVersion?: number } = {}) {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  t.after(async () => { await app.close(); db.close(); });
  const protocolVersion = options.protocolVersion ?? RUNNER_CAPABILITY_MIN_PROTOCOL.skillKeptAsideCopies;
  for (const runnerId of ["runner-1", "runner-2"]) {
    db.registerRunner({ runnerId, hostname: runnerId, os: "linux", version: "1", agents: [
      { id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code" },
    ], workspaces: [] }, 1, protocolVersion);
  }
  const state = {
    principal: owner,
    online: true,
    /** Files of the copy on the machine, keyed by kept-aside id or `<name>/<digest>/<variant>`. */
    copies: new Map<string, SkillFile[]>(),
    discardStatus: "discarded" as "discarded" | "not_found" | "rejected",
    restoreStatus: "restored" as "restored" | "not_needed" | "rejected",
    commands: [] as Array<SkillKeptAsideMessage | SkillDriftMessage>,
    pushes: [] as string[],
    solicited: [] as string[],
    onRunnerRequest: undefined as (() => void) | undefined,
  };
  const report = (value: { keptAside?: object[]; drift?: object[] }) =>
    db.setRunnerSkillState("runner-1", { deployed: [], unmanaged: [], ...value } as never, Date.now());
  const push = ((runnerId: string) => { state.pushes.push(runnerId); }) as SkillsSyncPusher;
  push.request = async (runnerId: string, requestId: string) => {
    state.solicited.push(runnerId);
    return { type: "skills_state", runnerId, requestId, deployed: [], unmanaged: [], drift: [], keptAside: [] };
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
        state.onRunnerRequest?.();
        if (message.type === "skill_kept_aside") {
          state.commands.push(message);
          const copy = state.copies.get(message.id);
          if (message.operation === "read") {
            return copy
              ? { type: "skill_kept_aside_result", runnerId, requestId, status: "read", files: copy, observedDigest: skillVersionDigest(copy) }
              : { type: "skill_kept_aside_result", runnerId, requestId, status: "not_found" };
          }
          return { type: "skill_kept_aside_result", runnerId, requestId, status: state.discardStatus,
            ...(state.discardStatus === "rejected" ? { error: "The kept-aside copy changed\u0007 after it was reviewed." } : {}) };
        }
        assert.equal(message.type, "skill_drift");
        const command = message as SkillDriftMessage;
        state.commands.push(command);
        if (command.operation === "read") {
          const copy = state.copies.get(`${command.name}/${command.digest}/${command.variant}`)!;
          return { type: "skill_drift_result", runnerId, requestId, status: "read", files: copy, observedDigest: skillVersionDigest(copy) };
        }
        return { type: "skill_drift_result", runnerId, requestId, status: state.restoreStatus,
          ...(state.restoreStatus === "rejected" ? { error: "The edited copy changed after it was reviewed." } : {}) };
      },
    },
  });
  return { db, app, state, report };
}

const preview = (app: ReturnType<typeof Fastify>, body: object) =>
  app.inject({ method: "POST", url: "/api/runners/runner-1/orphaned-skill-copies/preview", payload: body });
const importIt = (app: ReturnType<typeof Fastify>, previewId: string, acceptUpdate?: boolean) =>
  app.inject({ method: "POST", url: `/api/orphaned-skill-copies/${previewId}/import`, payload: acceptUpdate === undefined ? {} : { acceptUpdate } });
const discard = (app: ReturnType<typeof Fastify>, body: object) =>
  app.inject({ method: "POST", url: "/api/runners/runner-1/orphaned-skill-copies/discard", payload: body });

test("orphaned copies are kept-aside copies and edited copies of deleted skills, filtered by skill access", (t) => {
  const { db, report } = setup(t);
  const existing = payload("alpha", "Library");
  const alpha = db.createSkill({ name: "alpha", files: existing.files, manifest: existing.manifest, digest: existing.digest });
  const foreign = payload("foreign", "Other organization");
  db.createSkill({ name: "foreign", files: foreign.files, manifest: foreign.manifest, digest: foreign.digest,
    scope: { organizationId: "org-other", owner: { kind: "organization", organizationId: "org-other" } } });
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  report({
    keptAside: [
      { id: ids[0], name: "alpha", digest: "a".repeat(64), variant: "agent", keptAsideAt: 5, observedDigest: "b".repeat(64), detail: "kept\u0007" },
      { id: ids[1], name: "gone", observedFingerprint: "c".repeat(64) },
      { id: ids[2], name: "foreign", observedDigest: "d".repeat(64) },
      { id: ids[3] },
      { id: "../escape", name: "alpha" },
      { id: ids[0], name: "duplicate" },
      { id: randomUUID(), observedDigest: "e".repeat(64), observedFingerprint: "f".repeat(64) },
    ],
    drift: [
      { name: "alpha", digest: "1".repeat(64), variant: "agent", observedDigest: "2".repeat(64), held: true },
      { name: "deleted", digest: "3".repeat(64), variant: "manual", held: false, detail: "retained" },
    ],
  });
  const listed = listOrphanedSkillCopies(db, owner, "runner-1");
  assert.deepEqual(listed, [
    { kind: "kept_aside", id: ids[0], name: "alpha", digest: "a".repeat(64), variant: "agent", keptAsideAt: 5,
      observedDigest: "b".repeat(64), detail: "kept", skillId: alpha.id },
    { kind: "kept_aside", id: ids[1], name: "gone", observedFingerprint: "c".repeat(64) },
    { kind: "kept_aside", id: ids[3] },
    { kind: "deleted_skill", name: "deleted", digest: "3".repeat(64), variant: "manual", held: false, detail: "retained" },
  ], "a copy of another organization's skill, malformed entries, and drift of an existing skill are not orphaned here");
});

test("an older runner's kept-aside report is never stored", (t) => {
  const { db, report } = setup(t, { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.skillDrift });
  report({ keptAside: [{ id: randomUUID(), name: "alpha", observedDigest: "b".repeat(64) }] });
  assert.deepEqual(db.getRunnerSkillState("runner-1")?.keptAside, []);
});

test("a kept-aside copy of a missing skill imports as a new skill and is then discarded against its reviewed digest", async (t) => {
  const { db, app, state, report } = setup(t);
  const id = randomUUID();
  state.copies.set(id, files("beta", "Recovered"));
  const observedDigest = skillVersionDigest(files("beta", "Recovered"));
  const ref = { kind: "kept_aside", id };
  assert.equal((await preview(app, ref)).statusCode, 409, "a copy the machine does not report cannot be read");
  report({ keptAside: [{ id, name: "beta", digest: "a".repeat(64), variant: "agent", keptAsideAt: 5, observedDigest }] });
  state.principal = { ...owner, role: "operator" };
  assert.equal((await preview(app, ref)).statusCode, 403);
  state.principal = owner;
  assert.equal((await preview(app, { kind: "kept_aside", id: "../x" })).statusCode, 400);
  assert.equal(state.commands.length, 0, "authorization and validation failures never read machine files");

  const reviewed = await preview(app, ref);
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  const body = reviewed.json();
  assert.equal(body.disposition, "new");
  assert.equal(body.name, "beta");
  assert.equal(body.importable, true);
  assert.deepEqual(body.files, files("beta", "Recovered"));
  assert.deepEqual(body.previousFiles, []);

  const imported = await importIt(app, body.previewId);
  assert.equal(imported.statusCode, 200, imported.body);
  const skill = db.getSkillByName("beta")!;
  const version = db.getSkillVersion(skill.latestVersion!.id)!;
  assert.equal(version.digest, observedDigest);
  assert.match(version.note ?? "", /kept-aside edited copy/);
  assert.deepEqual(version.machineSource && { ...version.machineSource, importedAt: 0 },
    { runnerId: "runner-1", sourceDirectory: "skills/store", name: `.drift-${id}`, digest: observedDigest, importedAt: 0 });
  assert.equal(imported.json().released, true);
  assert.deepEqual(state.commands.map((command) => command.operation), ["read", "read", "discard"],
    "import re-reads the copy, then releases it");
  const release = state.commands.at(-1) as SkillKeptAsideMessage;
  assert.equal(release.observedDigest, observedDigest, "the release is fenced on the imported bytes");
  assert.equal(release.confirmation, "explicit");
  assert.deepEqual(state.pushes, [], "a new skill has no assignments to deploy");
  assert.deepEqual(state.solicited, ["runner-1"]);
  assert.equal((await importIt(app, body.previewId)).statusCode, 404, "a review is consumed by its import");
});

test("a kept-aside copy of an existing skill imports as a new version only after the diff is accepted", async (t) => {
  const { db, app, state, report } = setup(t);
  const v1 = payload("alpha", "Library");
  const skill = db.createSkill({ name: "alpha", files: v1.files, manifest: v1.manifest, digest: v1.digest });
  db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
  const id = randomUUID();
  const source = files("alpha", "Library\nKept edit.");
  state.copies.set(id, [{ ...source[0]!, content: withManualInvocationFrontmatter(source[0]!.content) }, source[1]!]);
  report({ keptAside: [{ id, name: "alpha", digest: v1.digest, variant: "manual", keptAsideAt: 5,
    observedDigest: skillVersionDigest(state.copies.get(id)!) }] });

  const body = (await preview(app, { kind: "kept_aside", id })).json();
  assert.equal(body.disposition, "update");
  assert.deepEqual(body.files, source, "the Manual Only line is left out of the library content");
  assert.deepEqual(body.previousFiles, v1.files);
  assert.equal(body.assignmentCount, 1);
  assert.equal((await importIt(app, body.previewId)).statusCode, 409, "an update requires explicit diff acceptance");

  // A library change after the review fences the import.
  const v2 = payload("alpha", "Library v2");
  db.addSkillVersion(skill.id, { files: v2.files, manifest: v2.manifest, digest: v2.digest });
  const conflicted = await importIt(app, body.previewId, true);
  assert.equal(conflicted.statusCode, 409);
  assert.equal(db.getSkill(skill.id)!.latestVersion!.digest, v2.digest);

  const again = (await preview(app, { kind: "kept_aside", id })).json();
  const imported = await importIt(app, again.previewId, true);
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(db.getSkill(skill.id)!.latestVersion!.digest, skillVersionDigest(source));
  assert.deepEqual(state.pushes, ["runner-2"], "machines that deploy the skill receive the new version");
});

test("an import refuses a copy changed since review and a skill created since review", async (t) => {
  const { db, app, state, report } = setup(t);
  const id = randomUUID();
  state.copies.set(id, files("beta", "Reviewed"));
  report({ keptAside: [{ id, name: "beta", observedDigest: skillVersionDigest(files("beta", "Reviewed")) }] });
  const body = (await preview(app, { kind: "kept_aside", id })).json();
  state.copies.set(id, files("beta", "Changed after review"));
  const stale = await importIt(app, body.previewId);
  assert.equal(stale.statusCode, 409);
  assert.match(stale.json().error, /changed after you reviewed it/);
  assert.equal(db.getSkillByName("beta"), null, "nothing is committed");
  assert.equal(state.commands.some((command) => command.operation === "discard"), false, "nothing is discarded");

  state.copies.set(id, files("beta", "Reviewed"));
  const second = (await preview(app, { kind: "kept_aside", id })).json();
  const concurrent = payload("beta", "Created elsewhere");
  db.createSkill({ name: "beta", files: concurrent.files, manifest: concurrent.manifest, digest: concurrent.digest });
  const raced = await importIt(app, second.previewId);
  assert.equal(raced.statusCode, 409);
  assert.equal(db.getSkillByName("beta")!.latestVersion!.digest, concurrent.digest);
});

test("an unidentified or invalid copy can be previewed but not imported", async (t) => {
  const { app, state, report } = setup(t);
  const id = randomUUID();
  state.copies.set(id, [{ path: "SKILL.md", content: "No frontmatter\n", encoding: "utf8" }]);
  report({ keptAside: [{ id, observedDigest: skillVersionDigest(state.copies.get(id)!) }] });
  const body = (await preview(app, { kind: "kept_aside", id })).json();
  assert.equal(body.importable, false);
  assert.match(body.importBlocker, /does not name a valid skill/);
  assert.equal((await importIt(app, body.previewId)).statusCode, 409);

  const unreadable = randomUUID();
  report({ keptAside: [{ id: unreadable, name: "beta", observedFingerprint: "c".repeat(64) }] });
  const refused = await preview(app, { kind: "kept_aside", id: unreadable });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.json().error, /can still be discarded/);
});

test("an edited copy of a deleted skill imports as a new skill through the drift read and is released", async (t) => {
  const { db, app, state, report } = setup(t);
  const digest = "a".repeat(64);
  const copy = files("gone", "Edited before deletion");
  state.copies.set(`gone/${digest}/agent`, copy);
  report({ drift: [{ name: "gone", digest, variant: "agent", observedDigest: skillVersionDigest(copy), held: true }] });
  const ref = { kind: "deleted_skill", name: "gone", digest, variant: "agent" };
  const body = (await preview(app, ref)).json();
  assert.equal(body.disposition, "new");
  const imported = await importIt(app, body.previewId);
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(db.getSkillByName("gone")!.latestVersion!.digest, skillVersionDigest(copy));
  const release = state.commands.at(-1) as SkillDriftMessage;
  assert.equal(release.type, "skill_drift");
  assert.equal(release.operation, "restore");
  assert.equal(release.files, undefined, "the released copy is discarded, not rebuilt");
  assert.equal(release.observedDigest, skillVersionDigest(copy));
  assert.equal(imported.json().released, true);
});

test("a deleted skill's drift is no longer orphaned once a skill with its name exists", async (t) => {
  const { db, app, state, report } = setup(t);
  const digest = "a".repeat(64);
  state.copies.set(`gone/${digest}/agent`, files("gone", "Edit"));
  report({ drift: [{ name: "gone", digest, variant: "agent", observedDigest: skillVersionDigest(files("gone", "Edit")), held: false }] });
  const recreated = payload("gone", "Recreated");
  db.createSkill({ name: "gone", files: recreated.files, manifest: recreated.manifest, digest: recreated.digest });
  const ref = { kind: "deleted_skill", name: "gone", digest, variant: "agent" };
  assert.equal((await preview(app, ref)).statusCode, 409);
  assert.equal((await discard(app, { ...ref, observedDigest: skillVersionDigest(files("gone", "Edit")), confirmation: "explicit" })).statusCode, 409);
  assert.equal(state.commands.length, 0);
});

test("discard needs confirmation and the reported observation, and the runner fences it again", async (t) => {
  const { app, state, report } = setup(t);
  const readable = randomUUID();
  const unreadable = randomUUID();
  const oversized = randomUUID();
  const observedDigest = "b".repeat(64);
  const observedFingerprint = "c".repeat(64);
  report({ keptAside: [
    { id: readable, name: "beta", observedDigest },
    { id: unreadable, name: "beta", observedFingerprint },
    { id: oversized, name: "beta" },
  ] });
  assert.equal((await discard(app, { kind: "kept_aside", id: readable, observedDigest })).statusCode, 400, "confirmation is required");
  assert.equal((await discard(app, { kind: "kept_aside", id: readable, observedDigest, observedFingerprint, confirmation: "explicit" })).statusCode, 400);
  assert.equal((await discard(app, { kind: "kept_aside", id: readable, observedDigest: "f".repeat(64), confirmation: "explicit" })).statusCode, 409,
    "a discard must name the observation the machine currently reports");
  assert.equal((await discard(app, { kind: "kept_aside", id: unreadable, observedDigest, confirmation: "explicit" })).statusCode, 409);
  const tooLarge = await discard(app, { kind: "kept_aside", id: oversized, observedFingerprint, confirmation: "explicit" });
  assert.equal(tooLarge.statusCode, 409);
  assert.match(tooLarge.json().error, /too large to verify/);
  state.principal = { ...owner, role: "viewer" };
  assert.equal((await discard(app, { kind: "kept_aside", id: readable, observedDigest, confirmation: "explicit" })).statusCode, 403);
  state.principal = owner;
  assert.equal(state.commands.length, 0);

  const discarded = await discard(app, { kind: "kept_aside", id: readable, observedDigest, confirmation: "explicit" });
  assert.equal(discarded.statusCode, 200, discarded.body);
  assert.equal(discarded.json().status, "discarded");
  assert.equal(discarded.json().state.keptAside, undefined, "responses carry kept-aside copies only through the filtered list");
  assert.deepEqual(state.commands.at(-1), { type: "skill_kept_aside", runnerId: "runner-1", requestId: state.commands.at(-1)!.requestId,
    operation: "discard", id: readable, observedDigest, confirmation: "explicit" });
  report({ keptAside: [{ id: unreadable, name: "beta", observedFingerprint }] });
  const fingerprinted = await discard(app, { kind: "kept_aside", id: unreadable, observedFingerprint, confirmation: "explicit" });
  assert.equal(fingerprinted.statusCode, 200, fingerprinted.body);
  assert.equal((state.commands.at(-1) as SkillKeptAsideMessage).observedFingerprint, observedFingerprint);

  report({ keptAside: [{ id: unreadable, name: "beta", observedFingerprint }] });
  state.discardStatus = "rejected";
  const rejected = await discard(app, { kind: "kept_aside", id: unreadable, observedFingerprint, confirmation: "explicit" });
  assert.equal(rejected.statusCode, 409);
  assert.equal(rejected.json().error, "The kept-aside copy changed after it was reviewed.");
});

test("discarding a deleted skill's copy sends a fenced restore without library files", async (t) => {
  const { app, state, report } = setup(t);
  const digest = "a".repeat(64);
  const ref = { kind: "deleted_skill", name: "gone", digest, variant: "manual" };
  report({ drift: [{ name: "gone", digest, variant: "manual", observedDigest: "b".repeat(64), held: true }] });
  assert.equal((await discard(app, { ...ref, observedDigest: null, confirmation: "explicit" })).statusCode, 409);
  const discarded = await discard(app, { ...ref, observedDigest: "b".repeat(64), confirmation: "explicit" });
  assert.equal(discarded.statusCode, 200, discarded.body);
  assert.equal(discarded.json().status, "discarded");
  const command = state.commands.at(-1) as SkillDriftMessage;
  assert.equal(command.operation, "restore");
  assert.equal(command.files, undefined);
  assert.equal(command.observedDigest, "b".repeat(64));

  report({ drift: [{ name: "gone", digest, variant: "manual", held: true }] });
  const movedAside = await discard(app, { ...ref, observedDigest: null, confirmation: "explicit" });
  assert.equal(movedAside.statusCode, 200, movedAside.body);
  assert.equal(movedAside.json().status, "kept_aside", "an unreadable copy is moved aside, not deleted");
});

test("orphan resolution requires a capable, online runner and reauthorizes after runner awaits", async (t) => {
  const older = setup(t, { protocolVersion: RUNNER_CAPABILITY_MIN_PROTOCOL.skillDrift });
  const id = randomUUID();
  older.db.setRunnerSkillState("runner-1", { deployed: [], unmanaged: [], drift: [
    { name: "gone", digest: "a".repeat(64), variant: "agent", observedDigest: "b".repeat(64), held: false },
  ] });
  // An older runner with drift still resolves a deleted skill's drift; it cannot report kept-aside copies.
  assert.equal(listOrphanedSkillCopies(older.db, owner, "runner-1").length, 1);
  const kept = await discard(older.app, { kind: "kept_aside", id, observedDigest: "b".repeat(64), confirmation: "explicit" });
  assert.equal(kept.statusCode, 409, "an older runner never reports kept-aside copies");

  const current = setup(t);
  current.report({ keptAside: [{ id, name: "beta", observedDigest: "b".repeat(64) }] });
  current.state.online = false;
  assert.equal((await discard(current.app, { kind: "kept_aside", id, observedDigest: "b".repeat(64), confirmation: "explicit" })).statusCode, 409);
  current.state.online = true;
  current.state.onRunnerRequest = () => { current.state.principal = { ...owner, role: "viewer" }; };
  const denied = await discard(current.app, { kind: "kept_aside", id, observedDigest: "b".repeat(64), confirmation: "explicit" });
  assert.equal(current.state.commands.length, 1, "the discard was dispatched before authority changed");
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().state, undefined);
});
