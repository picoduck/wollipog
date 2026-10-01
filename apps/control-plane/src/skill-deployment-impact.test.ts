/**
 * The deployment-impact fence (#2129) on every review that accepts a new latest version of a skill:
 * Import from Git, Import from Machine, Import Edit as New Version, Review Orphaned Copy, the
 * built-in accept and Version History restore. Each route runs the same sequence: an accept is
 * refused when the skill's assignments grew from 0, grew from 2, or shrank after its preview; it
 * succeeds when they are unchanged; and an accept without the recorded impact, from an older
 * dashboard, keeps the behavior it had before.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import Fastify from "fastify";
import {
  RUNNER_CAPABILITY_MIN_PROTOCOL,
  type AgentDefinition,
  type ControlPlaneToRunner,
  type SkillFile,
} from "@wollipog/protocol";
import { skillVersionDigest } from "@wollipog/protocol/skills-digest";
import { builtInSkills, seedBuiltInSkills, type BuiltInSkill } from "./built-in-skills.js";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import { DEPLOYMENT_IMPACT_CHANGED, DEPLOYMENT_IMPACT_CHANGED_CODE } from "./skill-deployment-impact.js";
import { registerSkillDriftRoutes } from "./skill-drift-route.js";
import { registerSkillGitRoutes } from "./skill-git-route.js";
import { registerMachineSkillRoutes } from "./skill-machine-route.js";
import { makeSkillsSyncPusher, registerSkillRoutes, type SkillsHub, type SkillsRouteDeps, type SkillsSyncPusher } from "./skills-route.js";
import { validateSkillPayload } from "./skills.js";

const owner: HumanPrincipal = {
  kind: "human", actorId: LOCAL_OWNER_USER_ID, userId: LOCAL_OWNER_USER_ID, userName: "Owner",
  organizationId: PERSONAL_ORGANIZATION_ID, organizationName: "Personal", role: "owner", deviceId: null, localBootstrap: true,
};
const AGENTS: AgentDefinition[] = [{ id: "claude", name: "Claude", command: "claude", args: [], env: {}, driver: "claude-code" }];

function files(name: string, body: string): SkillFile[] {
  return [{ path: "SKILL.md", encoding: "utf8", content: `---\nname: ${name}\ndescription: ${name} guide.\n---\n${body}\n` }];
}

function payload(name: string, body: string) {
  const validated = validateSkillPayload({ name, files: files(name, body) });
  if (!validated.ok) throw new Error(validated.error);
  return validated;
}

type Preview = { assignmentCount?: number; deploymentImpact: string };
type Response = { statusCode: number; body: string; json(): any };

/** One review route, previewing a new latest version of `skillId` each time it is asked to. */
interface Route {
  db: ControlPlaneDb;
  skillId: string;
  preview(): Promise<Preview>;
  /** Accept the preview, carrying `expected` back as `expectedDeploymentImpact` unless omitted. */
  accept(preview: Preview, expected?: unknown): Promise<Response>;
  /** Close a preview the accept refused, where the route bounds open previews. */
  discard?(preview: Preview): Promise<unknown>;
  /** How many syncs the route has sent machines so far. */
  syncs(): number;
}

async function assertDeploymentImpactFence(route: Route, options: { counts?: boolean } = {}) {
  const { db, skillId } = route;
  const latest = () => db.getSkill(skillId)!.latestVersion!.id;
  const assign = () => db.createSkillAssignment({ skillId, scopeKind: "instance", agentSelector: { kind: "all" } }).id;
  const reviewed = async (assignments: number) => {
    const shown = await route.preview();
    // Version History's consent names no count, so its preview does not report one.
    if (options.counts !== false) assert.equal(shown.assignmentCount, assignments, "the preview names the current count");
    assert.match(shown.deploymentImpact, /^[0-9a-f]{64}$/);
    return shown;
  };
  const refused = async (label: string, assignments: number, change: () => void) => {
    const shown = await reviewed(assignments);
    change();
    const [version, syncs] = [latest(), route.syncs()];
    const response = await route.accept(shown, shown.deploymentImpact);
    assert.equal(response.statusCode, 409, `${label}: ${response.body}`);
    assert.deepEqual(response.json(), { error: DEPLOYMENT_IMPACT_CHANGED, code: DEPLOYMENT_IMPACT_CHANGED_CODE }, label);
    assert.equal(latest(), version, `${label}: nothing is committed`);
    assert.equal(route.syncs(), syncs, `${label}: nothing is deployed`);
    await route.discard?.(shown);
  };
  const accepted = async (label: string, shown: Preview, expected?: unknown) => {
    const version = latest();
    const syncs = route.syncs();
    const response = await route.accept(shown, expected);
    assert.equal(response.statusCode, 200, `${label}: ${response.body}`);
    assert.notEqual(latest(), version, `${label}: the new version is the latest`);
    assert.ok(route.syncs() > syncs, `${label}: machines are told to sync`);
  };

  // A preview with no assignments shows no consent; an assignment added before the accept is refused.
  await refused("grown from 0", 0, assign);
  assign();
  await refused("grown from 2 to 3", 2, () => { assign(); });
  const third = db.listSkillAssignments(skillId).at(-1)!.id;
  await refused("shrunk from 3 to 2", 3, () => { db.deleteSkillAssignment(third); });
  // A machine pinned to an earlier version does not receive the new latest one (#2281), so pinning,
  // re-pinning or unpinning a machine for the skill is refused too.
  const runnerId = db.listRunners().at(-1)!.runnerId;
  const pinned = () => db.getMachineSkillVersion(skillId, runnerId);
  const pin = (versionId: string | null) =>
    db.setMachineSkillVersion(skillId, runnerId, versionId, pinned()?.revision ?? null, latest());
  await refused("pinned", 2, () => pin(latest()));
  await refused("re-pinned to the same version", 2, () => pin(pinned()!.versionId));
  await refused("unpinned", 2, () => pin(null));
  // Another skill's pin does not change where this one deploys.
  const other = payload("unrelated", "Other");
  const unrelated = db.createSkill({ name: "unrelated", files: other.files, manifest: other.manifest, digest: other.digest });
  const elsewhere = await reviewed(2);
  db.setMachineSkillVersion(unrelated.id, runnerId, unrelated.latestVersion!.id, null, unrelated.latestVersion!.id);
  await accepted("another skill's pin", elsewhere, elsewhere.deploymentImpact);
  // A fresh preview names the current count, and accepting it unchanged succeeds.
  const unchanged = await reviewed(2);
  await accepted("unchanged", unchanged, unchanged.deploymentImpact);
  // The value must be one the preview reported.
  const shown = await reviewed(2);
  const invalid = await route.accept(shown, 42);
  assert.equal(invalid.statusCode, 400, invalid.body);
  await route.discard?.(shown);
  // An older dashboard sends no recorded impact and keeps today's behavior, even when assignments changed.
  const legacy = await reviewed(2);
  assign();
  await accepted("missing value", legacy);
}

test("the deployment impact digests the direct and group assignments' targets", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    const scope = { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "organization" as const, organizationId: PERSONAL_ORGANIZATION_ID } };
    const v1 = payload("alpha", "Original");
    const skill = db.createSkill({ name: "alpha", files: v1.files, manifest: v1.manifest, digest: v1.digest, scope });
    const other = payload("beta", "Other");
    const unrelated = db.createSkill({ name: "beta", files: other.files, manifest: other.manifest, digest: other.digest });
    const impact = () => db.skillDeploymentImpact(skill.id).deploymentImpact;
    const none = impact();
    assert.deepEqual(db.skillDeploymentImpact(null), { assignmentCount: 0, deploymentImpact: none },
      "a skill that does not exist yet has no assignments");
    db.createSkillAssignment({ skillId: unrelated.id, scopeKind: "instance", agentSelector: { kind: "all" } });
    assert.equal(impact(), none, "another skill's assignments do not count");

    const direct = db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" }, now: 10 });
    const one = impact();
    assert.notEqual(one, none);
    assert.equal(db.skillDeploymentImpact(skill.id).assignmentCount, 1);
    db.updateSkillAssignment(direct.id, { enabled: false }, 10);
    assert.notEqual(impact(), one, "disabling an assignment changes where the skill deploys");
    db.updateSkillAssignment(direct.id, { enabled: true }, 10);
    assert.equal(impact(), one);
    // Between two equal rules the later edit wins, so any edit can change where the skill deploys.
    db.updateSkillAssignment(direct.id, { invocation: "manual" }, 11);
    assert.notEqual(impact(), one, "an edit that only moves the rule's edit time changes the impact");

    // Replacing an assignment with another keeps the count but not the impact.
    db.deleteSkillAssignment(direct.id);
    db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
    const replaced = impact();
    assert.notEqual(replaced, one);
    assert.equal(db.skillDeploymentImpact(skill.id).assignmentCount, 1);

    const group = db.createSkillGroup("Tools", 1, scope);
    db.createSkillGroupAssignment({ groupId: group.id, scopeKind: "instance", runnerId: null, agentSelector: { kind: "all" },
      enabled: true, invocation: "agent" });
    assert.equal(impact(), replaced, "a group the skill is not in does not count");
    db.updateSkill(skill.id, { groupId: group.id });
    assert.notEqual(impact(), replaced, "joining a group adds the group's assignments");
    assert.equal(db.skillDeploymentImpact(skill.id).assignmentCount, 2);
    assert.equal(db.getSkill(skill.id)!.assignmentCount, 2, "the count is the one the skill reports");
  } finally { db.close(); }
});

test("the deployment impact digests the skill's machine version pins (#2281)", () => {
  const db = ControlPlaneDb.open(":memory:");
  try {
    for (const runnerId of ["runner-1", "runner-2"]) {
      db.registerRunner({ runnerId, hostname: runnerId, os: "linux", version: "1", agents: AGENTS, workspaces: [] }, 1, 90);
    }
    const v1 = payload("alpha", "Original");
    const skill = db.createSkill({ name: "alpha", files: v1.files, manifest: v1.manifest, digest: v1.digest });
    const first = skill.latestVersion!.id;
    const latest = db.addSkillVersion(skill.id, payload("alpha", "Second"))!.id;
    const other = payload("beta", "Other");
    const unrelated = db.createSkill({ name: "beta", files: other.files, manifest: other.manifest, digest: other.digest });
    db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
    const impact = () => db.skillDeploymentImpact(skill.id).deploymentImpact;
    const pin = (runnerId: string, versionId: string | null) => db.setMachineSkillVersion(skill.id, runnerId, versionId,
      db.getMachineSkillVersion(skill.id, runnerId)?.revision ?? null, latest);

    const unpinned = impact();
    // A skill without pins keeps the digest of its assignments alone, as before pins counted.
    const [assignment] = db.listSkillAssignments(skill.id);
    const targets = [["skill", assignment!.id, "instance", null, JSON.stringify({ kind: "all" }), 1, assignment!.updatedAt]];
    assert.equal(unpinned, createHash("sha256").update(JSON.stringify(targets)).digest("hex"));

    db.setMachineSkillVersion(unrelated.id, "runner-1", unrelated.latestVersion!.id, null, unrelated.latestVersion!.id);
    assert.equal(impact(), unpinned, "another skill's pin does not count");

    pin("runner-1", first);
    const pinned = impact();
    assert.notEqual(pinned, unpinned, "pinning a machine changes where the skill deploys");
    assert.equal(db.skillDeploymentImpact(skill.id).assignmentCount, 1, "pins are not assignments");
    pin("runner-1", first);
    const repinned = impact();
    assert.notEqual(repinned, pinned, "re-pinning to the same version counts");
    pin("runner-1", latest);
    assert.notEqual(impact(), repinned, "moving a pin counts");
    const moved = impact();
    pin("runner-1", null);
    assert.notEqual(impact(), moved, "unpinning counts");
    assert.notEqual(impact(), unpinned, "an unpinned policy row is still a write since the preview");
    const tracking = impact();
    pin("runner-2", first);
    assert.notEqual(impact(), tracking, "every machine's pin counts");
    db.deleteRunner("runner-2");
    assert.equal(impact(), tracking, "removing a pinned machine drops its pin");
  } finally { db.close(); }
});

test("Import from Git refuses an accept whose previewed deployment impact changed", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  t.after(async () => { await app.close(); db.close(); });
  let body = "Original";
  let syncs = 0;
  db.registerRunner({ runnerId: "runner-1", hostname: "host", os: "linux", version: "1", agents: [], workspaces: [] }, 1, 108);
  registerSkillGitRoutes(app, { db, requestHuman: () => owner, requestPrincipal: () => owner,
    hub: {} as SkillsRouteDeps["hub"], pushSkillsSync: (() => { syncs++; }) as unknown as SkillsSyncPusher }, async (source) => {
    const candidate = payload("alpha", body);
    return [{ ...candidate, source, path: "skills/alpha", commit: "a".repeat(40), executablePaths: [] }];
  });
  const v1 = payload("alpha", body);
  const skill = db.createSkill({ name: "alpha", files: v1.files, manifest: v1.manifest, digest: v1.digest });
  await assertDeploymentImpactFence({
    db, skillId: skill.id,
    async preview() {
      body = `Revision ${randomUUID()}`;
      const response = await app.inject({ method: "POST", url: "/api/skill-git/preview", payload: { url: "team/repo" } });
      assert.equal(response.statusCode, 200, response.body);
      const { previewId, candidates: [candidate] } = response.json();
      assert.equal(candidate.disposition, "update");
      return { ...candidate, previewId };
    },
    accept: (preview, expected) => app.inject({ method: "POST", url: "/api/skill-git/import", payload: {
      previewId: (preview as Preview & { previewId: string }).previewId, path: "skills/alpha", acceptUpdate: true,
      ...(expected === undefined ? {} : { expectedDeploymentImpact: expected }) } }),
    discard: (preview) => app.inject({ method: "DELETE", url: `/api/skill-git/preview/${(preview as Preview & { previewId: string }).previewId}` }),
    syncs: () => syncs,
  });
});

test("Import from Machine refuses an accept whose previewed deployment impact changed", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  t.after(async () => { await app.close(); db.close(); });
  let body = "Original";
  let syncs = 0;
  const candidate = { id: "opaque-id", name: "alpha", sourceDirectory: ".codex/skills", generation: "generation-1" };
  db.registerRunner({ runnerId: "runner-1", hostname: "host", os: "linux", version: "1", agents: [
    { id: "codex", name: "Codex", command: "codex", args: [], env: {}, driver: "codex" },
  ], workspaces: [] }, 1, 111);
  registerMachineSkillRoutes(app, { db, requestHuman: () => owner, requestPrincipal: () => owner,
    pushSkillsSync: (() => { syncs++; }) as unknown as SkillsSyncPusher,
    hub: { isRunnerOnline: () => true, sendToRunner: () => { throw new Error("unexpected mutation"); },
      requestFromRunner: async (runnerId, requestId, request) => {
        if (request.type !== "skill_snapshot") throw new Error("unexpected request");
        if (request.operation === "list") return { type: "skill_snapshot_result", runnerId, requestId, candidates: [candidate] };
        const snapshot = payload("alpha", body);
        return { type: "skill_snapshot_result", runnerId, requestId, snapshot: { candidate, files: snapshot.files, digest: snapshot.digest } };
      } },
  });
  const v1 = payload("alpha", body);
  const skill = db.createSkill({ name: "alpha", files: v1.files, manifest: v1.manifest, digest: v1.digest });
  const discovery = (await app.inject({ method: "POST", url: "/api/runners/runner-1/skill-snapshots" })).json().discoveryId;
  await assertDeploymentImpactFence({
    db, skillId: skill.id,
    async preview() {
      body = `Revision ${randomUUID()}`;
      const response = await app.inject({ method: "POST", url: `/api/skill-machine/${discovery}/preview`, payload: { candidateId: candidate.id } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().disposition, "update");
      return response.json();
    },
    accept: (preview, expected) => app.inject({ method: "POST", url: `/api/skill-machine/${discovery}/import`, payload: {
      previewId: (preview as Preview & { previewId: string }).previewId, acceptUpdate: true,
      ...(expected === undefined ? {} : { expectedDeploymentImpact: expected }) } }),
    syncs: () => syncs,
  });
});

/** Edited copies on runner-1, read through the drift and kept-aside routes. */
function editedCopyFixture(t: TestContext) {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  t.after(async () => { await app.close(); db.close(); });
  const protocolVersion = Math.max(RUNNER_CAPABILITY_MIN_PROTOCOL.skillDrift, RUNNER_CAPABILITY_MIN_PROTOCOL.skillKeptAsideCopies);
  for (const runnerId of ["runner-1", "runner-2"]) {
    db.registerRunner({ runnerId, hostname: runnerId, os: "linux", version: "1", agents: AGENTS, workspaces: [] }, 1, protocolVersion);
  }
  const v1 = payload("alpha", "Original");
  const skill = db.createSkill({ name: "alpha", files: v1.files, manifest: v1.manifest, digest: v1.digest });
  const state = { edited: files("alpha", "Original"), keptAside: new Map<string, SkillFile[]>(), syncs: 0,
    onRead: undefined as (() => void) | undefined };
  const push = (() => { state.syncs++; }) as unknown as SkillsSyncPusher;
  push.request = async (runnerId: string, requestId: string) =>
    ({ type: "skills_state", runnerId, requestId, deployed: [], unmanaged: [], drift: [], keptAside: [] });
  registerSkillDriftRoutes(app, { db, requestHuman: () => owner, requestPrincipal: () => owner, pushSkillsSync: push,
    hub: {
      isRunnerOnline: () => true,
      sendToRunner: () => { throw new Error("unexpected unsolicited runner message"); },
      requestFromRunner: async (runnerId, requestId, message: ControlPlaneToRunner) => {
        if ((message.type === "skill_kept_aside" || message.type === "skill_drift") && message.operation === "read") state.onRead?.();
        if (message.type === "skill_kept_aside") {
          const copy = state.keptAside.get(message.id)!;
          return message.operation === "read"
            ? { type: "skill_kept_aside_result", runnerId, requestId, status: "read", files: copy,
              observedDigest: skillVersionDigest(copy), observedFingerprint: "9".repeat(64) }
            : { type: "skill_kept_aside_result", runnerId, requestId, status: "discarded" };
        }
        if (message.type !== "skill_drift") throw new Error("unexpected request");
        return message.operation === "read"
          ? { type: "skill_drift_result", runnerId, requestId, status: "read", files: state.edited, observedDigest: skillVersionDigest(state.edited) }
          : { type: "skill_drift_result", runnerId, requestId, status: "restored" };
      },
    },
  });
  return { db, app, skill, v1, state };
}

test("Import Edit as New Version refuses an accept whose previewed deployment impact changed", async (t) => {
  const { db, app, skill, v1, state } = editedCopyFixture(t);
  const target = { name: "alpha", digest: v1.digest, variant: "agent" as const };
  await assertDeploymentImpactFence({
    db, skillId: skill.id,
    async preview() {
      state.edited = files("alpha", `Hand edit ${randomUUID()}`);
      db.setRunnerSkillState("runner-1", { deployed: [], unmanaged: [], drift: [{ ...target,
        observedDigest: skillVersionDigest(state.edited), held: true }] as never }, Date.now());
      const response = await app.inject({ method: "POST", url: "/api/runners/runner-1/skill-drift/preview", payload: target });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().disposition, "update");
      return response.json();
    },
    accept: (preview, expected) => app.inject({ method: "POST", url: `/api/skill-drift/${(preview as Preview & { previewId: string }).previewId}/import`,
      payload: { acceptUpdate: true, ...(expected === undefined ? {} : { expectedDeploymentImpact: expected }) } }),
    syncs: () => state.syncs,
  });
});

test("Review Orphaned Copy refuses an accept whose previewed deployment impact changed", async (t) => {
  const { db, app, skill, v1, state } = editedCopyFixture(t);
  await assertDeploymentImpactFence({
    db, skillId: skill.id,
    async preview() {
      const id = randomUUID();
      const copy = files("alpha", `Kept edit ${id}`);
      state.keptAside.set(id, copy);
      db.setRunnerSkillState("runner-1", { deployed: [], unmanaged: [], keptAside: [{ id, name: "alpha", digest: v1.digest,
        variant: "agent", keptAsideAt: 5, observedDigest: skillVersionDigest(copy) }] } as never, Date.now());
      const response = await app.inject({ method: "POST", url: "/api/runners/runner-1/orphaned-skill-copies/preview", payload: { kind: "kept_aside", id } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().disposition, "update");
      return response.json();
    },
    accept: (preview, expected) => app.inject({ method: "POST",
      url: `/api/orphaned-skill-copies/${(preview as Preview & { previewId: string }).previewId}/import`,
      payload: { acceptUpdate: true, ...(expected === undefined ? {} : { expectedDeploymentImpact: expected }) } }),
    syncs: () => state.syncs,
  });
});

/** The full skills routes, with one online machine that every instance assignment deploys to. */
async function libraryFixture(t: TestContext, releases: BuiltInSkill[] = []) {
  const db = ControlPlaneDb.open(":memory:");
  let syncs = 0;
  const hub = {
    isRunnerOnline: () => true,
    sendToRunner: () => { syncs++; return true; },
    requestFromRunner: () => { throw new Error("unexpected runner request"); },
  } as SkillsHub;
  const app = Fastify();
  registerSkillRoutes(app, { db, hub, requestHuman: () => owner, requestPrincipal: () => owner,
    pushSkillsSync: makeSkillsSyncPusher({ db, hub }), builtInSkills: releases });
  await app.ready();
  t.after(async () => { await app.close(); db.close(); });
  db.registerRunner({ runnerId: "laptop", hostname: "laptop", os: "linux", version: "1", agents: AGENTS, workspaces: [] }, 10, 90);
  return { db, app, syncs: () => syncs };
}

test("the built-in accept refuses an accept whose previewed deployment impact changed", async (t) => {
  // The route reads the running release from this list, so each round can add the next release.
  const releases: BuiltInSkill[] = [];
  const { db, app, syncs } = await libraryFixture(t, releases);
  seedBuiltInSkills(db, builtInSkills([{ name: "using-wollipog", files: files("using-wollipog", "Release 0.") }], "0.0.0"), 10);
  const skill = db.getSkillByName("using-wollipog")!;
  let round = 0;
  await assertDeploymentImpactFence({
    db, skillId: skill.id,
    async preview() {
      const pending = await app.inject({ method: "GET", url: `/api/skills/${skill.id}/built-in-version` });
      if (pending.statusCode === 200) return pending.json();
      // A local edit holds the next release for review.
      round++;
      db.addSkillVersion(skill.id, payload("using-wollipog", `Local edit ${round}.`), 10 + round);
      const [release] = builtInSkills([{ name: "using-wollipog", files: files("using-wollipog", `Release ${round}.`) }], `1.0.${round}`);
      releases.push(release!);
      seedBuiltInSkills(db, [release!], 10 + round);
      const review = await app.inject({ method: "GET", url: `/api/skills/${skill.id}/built-in-version` });
      assert.equal(review.statusCode, 200, review.body);
      assert.equal(review.json().kind, "update");
      return review.json();
    },
    accept: (preview, expected) => {
      const review = preview as Preview & { digest: string; expectedLatestVersionId: string };
      return app.inject({ method: "POST", url: `/api/skills/${skill.id}/built-in-version`, payload: {
        digest: review.digest, expectedLatestVersionId: review.expectedLatestVersionId, accepted: true,
        ...(expected === undefined ? {} : { expectedDeploymentImpact: expected }) } });
    },
    syncs,
  });
});

test("Version History restore refuses an accept whose previewed deployment impact changed", async (t) => {
  const { db, app, syncs } = await libraryFixture(t);
  const first = payload("alpha", "First");
  const skill = db.createSkill({ name: "alpha", files: first.files, manifest: first.manifest, digest: first.digest });
  const second = db.addSkillVersion(skill.id, payload("alpha", "Second"))!;
  const firstId = db.listSkillVersions(skill.id).versions.find((version) => version.digest === first.digest)!.id!;
  await assertDeploymentImpactFence({
    db, skillId: skill.id,
    async preview() {
      // Alternate, so the restored content always differs from the latest version.
      const target = db.getSkill(skill.id)!.latestVersion!.digest === first.digest ? second.id : firstId;
      const response = await app.inject({ method: "GET", url: `/api/skills/${skill.id}/versions/${target}` });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    },
    accept: (preview, expected) => {
      const shown = preview as Preview & { version: { id: string }; currentVersion: { id: string } };
      return app.inject({ method: "POST", url: `/api/skills/${skill.id}/restore`, payload: {
        versionId: shown.version.id, expectedLatestVersionId: shown.currentVersion.id,
        ...(expected === undefined ? {} : { expectedDeploymentImpact: expected }) } });
    },
    syncs,
  }, { counts: false });
});

test("an accept that deploys nothing new is not fenced", async (t) => {
  const { db, app } = await libraryFixture(t);
  const first = payload("alpha", "First");
  const skill = db.createSkill({ name: "alpha", files: first.files, manifest: first.manifest, digest: first.digest });
  // Restoring an older version with the latest version's content changes nothing deployed.
  const older = skill.latestVersion!.id;
  const latest = db.addSkillVersion(skill.id, first)!;
  const shown = (await app.inject({ method: "GET", url: `/api/skills/${skill.id}/versions/${older}` })).json();
  db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
  const restored = await app.inject({ method: "POST", url: `/api/skills/${skill.id}/restore`,
    payload: { versionId: older, expectedLatestVersionId: latest.id, expectedDeploymentImpact: shown.deploymentImpact } });
  assert.equal(restored.statusCode, 200, restored.body);
});

test("an assignment added while an edited-copy import re-reads the machine is still refused", async (t) => {
  const { db, app, skill, v1, state } = editedCopyFixture(t);
  const id = randomUUID();
  const copy = files("alpha", "Kept edit");
  state.keptAside.set(id, copy);
  state.edited = files("alpha", "Hand edit");
  const drift = { name: "alpha", digest: v1.digest, variant: "agent" as const };
  db.setRunnerSkillState("runner-1", { deployed: [], unmanaged: [],
    drift: [{ ...drift, observedDigest: skillVersionDigest(state.edited), held: true }],
    keptAside: [{ id, name: "alpha", digest: v1.digest, variant: "agent", keptAsideAt: 5, observedDigest: skillVersionDigest(copy) }] } as never, Date.now());
  for (const [previewUrl, previewBody, importUrl] of [
    ["/api/runners/runner-1/skill-drift/preview", drift, "/api/skill-drift"],
    ["/api/runners/runner-1/orphaned-skill-copies/preview", { kind: "kept_aside", id }, "/api/orphaned-skill-copies"],
  ] as const) {
    state.onRead = undefined;
    const shown = (await app.inject({ method: "POST", url: previewUrl, payload: previewBody })).json();
    assert.equal(shown.assignmentCount, 0);
    // The import's re-read of the machine is the last await before the commit.
    state.onRead = () => { db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } }); };
    const response = await app.inject({ method: "POST", url: `${importUrl}/${shown.previewId}/import`,
      payload: { acceptUpdate: true, expectedDeploymentImpact: shown.deploymentImpact } });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, DEPLOYMENT_IMPACT_CHANGED_CODE);
    assert.equal(db.getSkill(skill.id)!.latestVersion!.digest, v1.digest);
    assert.equal(state.syncs, 0);
    db.listSkillAssignments(skill.id).forEach((assignment) => db.deleteSkillAssignment(assignment.id));
  }
});

test("an edited-copy preview reports the count and impact of the assignments after its machine read", async (t) => {
  const { db, app, skill, v1, state } = editedCopyFixture(t);
  const id = randomUUID();
  const copy = files("alpha", "Kept edit");
  state.keptAside.set(id, copy);
  state.edited = files("alpha", "Hand edit");
  const drift = { name: "alpha", digest: v1.digest, variant: "agent" as const };
  db.setRunnerSkillState("runner-1", { deployed: [], unmanaged: [],
    drift: [{ ...drift, observedDigest: skillVersionDigest(state.edited), held: true }],
    keptAside: [{ id, name: "alpha", digest: v1.digest, variant: "agent", keptAsideAt: 5, observedDigest: skillVersionDigest(copy) }] } as never, Date.now());
  for (const [previewUrl, previewBody] of [
    ["/api/runners/runner-1/skill-drift/preview", drift],
    ["/api/runners/runner-1/orphaned-skill-copies/preview", { kind: "kept_aside", id }],
  ] as const) {
    db.listSkillAssignments(skill.id).forEach((assignment) => db.deleteSkillAssignment(assignment.id));
    // An assignment added while the preview reads the machine is in both the count and the digest,
    // so a consent-free preview never carries a digest that already includes an assignment.
    state.onRead = () => { db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } }); };
    const shown = (await app.inject({ method: "POST", url: previewUrl, payload: previewBody })).json();
    state.onRead = undefined;
    assert.equal(shown.assignmentCount, 1, previewUrl);
    assert.equal(shown.deploymentImpact, db.skillDeploymentImpact(skill.id).deploymentImpact, previewUrl);
  }
});
