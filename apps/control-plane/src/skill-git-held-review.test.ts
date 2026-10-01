import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { ControlPlaneDb } from "./db.js";
import { LOCAL_OWNER_USER_ID, PERSONAL_ORGANIZATION_ID, type HumanPrincipal } from "./identity.js";
import { SkillGitAutoUpdater } from "./skill-git-auto-update.js";
import { registerSkillGitRoutes } from "./skill-git-route.js";
import type { SkillsRouteDeps, SkillsSyncPusher } from "./skills-route.js";

const exec = promisify(execFile);
const REMOTE = "https://github.com/team/skills.git";

/**
 * #2280: Review Update… on a held automatic update reads the commit that was held, through the
 * production fetch, even after the tracked branch has moved on. A `git` shim on PATH points the
 * production launcher's GitHub address at a local repository and allows the file transport for
 * it alone; every other argument (depth, filters, hardening) reaches real Git unchanged.
 */
test("a held update is reviewed and imported at the held commit after its branch moves on", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "skill-git-held-"));
  const upstream = join(root, "upstream");
  const shim = join(root, "bin");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const priorPath = process.env.PATH;
  const db = ControlPlaneDb.open(":memory:");
  const app = Fastify();
  t.after(async () => {
    process.env.PATH = priorPath;
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(upstream, "skills/alpha"), { recursive: true });
  await mkdir(shim);
  await writeFile(join(shim, "git"), `#!${process.execPath}
const { spawn } = require("node:child_process");
const args = process.argv.slice(2).map((arg) => arg === ${JSON.stringify(REMOTE)} ? ${JSON.stringify(`file://${upstream}`)} : arg);
const child = spawn(${JSON.stringify(realGit)}, ["-c", "protocol.file.allow=always", ...args], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
`, { mode: 0o700 });
  const git = async (...args: string[]) => (await exec(realGit, ["-C", upstream, ...args], { encoding: "utf8" })).stdout.trim();
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(upstream, path, ".."), { recursive: true });
      await writeFile(join(upstream, path), content);
    }
    await git("add", ".");
    await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", message);
    return await git("rev-parse", "HEAD");
  };
  await git("init", "-q", "-b", "main", "--template=");
  const first = await commit({ "skills/alpha/SKILL.md": "---\nname: alpha\ndescription: Alpha\n---\nOne" }, "first");
  process.env.PATH = `${shim}:${priorPath}`;

  const owner: HumanPrincipal = { kind: "human", actorId: LOCAL_OWNER_USER_ID, userId: LOCAL_OWNER_USER_ID,
    userName: "Owner", organizationId: PERSONAL_ORGANIZATION_ID, organizationName: "Personal", role: "owner", deviceId: null, localBootstrap: true };
  registerSkillGitRoutes(app, { db, requestHuman: () => owner, requestPrincipal: () => owner,
    hub: {} as SkillsRouteDeps["hub"], pushSkillsSync: (() => {}) as unknown as SkillsSyncPusher });
  const preview = async (payload: object) => {
    const response = await app.inject({ method: "POST", url: "/api/skill-git/preview", payload });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { previewId: string; refCommit?: string | null;
      candidates: Array<{ path: string; commit: string; disposition: string; files: Array<{ path: string; content: string }> }> };
  };
  const importPreview = async (previewId: string) => {
    const response = await app.inject({ method: "POST", url: "/api/skill-git/import",
      payload: { previewId, path: "skills/alpha", acceptUpdate: true } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().skill as { id: string; latestVersion: { id: string } };
  };
  const source = { url: "team/skills", ref: "main", subdirectory: "skills/alpha" };

  const initial = await preview(source);
  assert.equal(initial.candidates[0]!.commit, first);
  assert.equal(initial.refCommit, undefined, "an unpinned preview reports no ref commit");
  const skill = await importPreview(initial.previewId);
  db.setSkillGitAutoUpdate(skill.id, true);
  const updater = new SkillGitAutoUpdater({ db, intervalMs: 60 * 60_000, pushSkillsSync: () => {} });

  // A commit that adds a script is held, and the branch then moves on before anyone reviews it.
  const held = await commit({ "skills/alpha/scripts/run.sh": "echo held\n" }, "add script");
  assert.equal(await updater.check(skill.id), "held");
  assert.equal(db.getSkillGitAutoUpdate(skill.id).held?.commit, held);
  const newer = await commit({ "skills/alpha/scripts/run.sh": "echo newer\n" }, "change script");

  const review = await preview({ ...source, commit: held });
  assert.equal(review.refCommit, newer, "the review names where the branch is now");
  assert.equal(review.candidates.length, 1);
  assert.equal(review.candidates[0]!.commit, held);
  assert.equal(review.candidates[0]!.disposition, "update");
  assert.equal(review.candidates[0]!.files.find((file) => file.path === "scripts/run.sh")?.content, "echo held\n");

  const imported = await importPreview(review.previewId);
  const version = db.getSkillVersion(imported.latestVersion.id)!;
  assert.equal(version.gitSource?.commit, held, "provenance records the reviewed commit");
  assert.equal(version.gitSource?.ref, "main", "the skill keeps tracking its branch");
  assert.equal(version.files.find((file) => file.path === "scripts/run.sh")?.content, "echo held\n");
  assert.deepEqual({ held: db.getSkillGitAutoUpdate(skill.id).held, checkedCommit: db.getSkillGitAutoUpdate(skill.id).checkedCommit },
    { held: null, checkedCommit: held });

  // The newer commit was never reviewed: the next check holds it rather than importing it.
  assert.equal(await updater.check(skill.id), "held");
  assert.equal(db.getSkillGitAutoUpdate(skill.id).held?.commit, newer);
  assert.equal(db.getSkill(skill.id)!.latestVersion!.id, version.id);
  const latest = await preview(source);
  assert.equal(latest.candidates[0]!.commit, newer);
  assert.equal(latest.candidates[0]!.files.find((file) => file.path === "scripts/run.sh")?.content, "echo newer\n");
  await app.inject({ method: "DELETE", url: `/api/skill-git/preview/${latest.previewId}` });

  // A held commit the source doesn't have is refused by name, not swapped for the branch's head.
  const missing = await app.inject({ method: "POST", url: "/api/skill-git/preview", payload: { ...source, commit: "f".repeat(40) } });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.json().error, /^Could not read held commit ffffffffffff from the Git source\./);
});
