import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { acquireCheckpointLock, advance, bumpVersions, notesPath, prepare, saveCheckpoint, validateCheckpoint, verifyMergedPreparation, verifyReleaseJobs } from "./release.mjs";
import { FINALIZER_JOB, NATIVE_RELEASE_JOBS } from "./release-timings.mjs";

const head = "a".repeat(40), merge = "b".repeat(40), base = "c".repeat(40);
const notes = "# Wollipog v0.35.0\n\nRelease notes.\n\n";
const state = () => ({ schema: 1, repository: "example/project", version: "0.35.0", tag: "v0.35.0",
  branch: "release/v0.35.0", baseSha: base, headSha: head, prNumber: 42, notesPath: notesPath("0.35.0"),
  notesSha256: createHash("sha256").update(notes).digest("hex"), stage: "review" });
const grants = { reviewedHead: head, allowTag: true, allowPublish: true };

/** Inert forge: API mutations update observable state, including a crash after an accepted PATCH. */
function fixture() {
  const calls = [], saved = [];
  const pr = { number: 42, state: "MERGED", isDraft: false, headRefOid: head, headRefName: "release/v0.35.0",
    baseRefName: "main", headRepository: { nameWithOwner: "example/project" }, mergeCommit: { oid: merge }, mergeQueueEntry: null };
  const run = { id: 100, run_attempt: 1, status: "completed", conclusion: "success", path: ".github/workflows/release.yml",
    repository: { full_name: "example/project" }, event: "push", head_branch: "v0.35.0", head_sha: merge };
  const release = { id: 200, tag_name: "v0.35.0", draft: true, prerelease: false };
  let tag = { object: { type: "commit", sha: merge } };
  const controls = { failVerification: false, crashAfterPublish: false, changedPreparation: false, runs: [run], latestId: 200, previousTag: "v0.34.0" };
  const io = {
    api(path, body, method) {
      calls.push({ path, body, method });
      if (path === "graphql") return { data: { repository: { nameWithOwner: "example/project", pullRequest: structuredClone(pr) } } };
      if (path.includes("/compare/")) return { status: "ahead" };
      if (path.endsWith("/git/refs")) { tag = { object: { type: "commit", sha: body.sha } }; return tag; }
      if (path.endsWith("/actions/runs/100")) return structuredClone(run);
      if (path.endsWith("/releases/latest")) return { id: controls.latestId, tag_name: "v0.35.0" };
      if (path.endsWith("/releases/200")) {
        if (method === "PATCH") {
          Object.assign(release, body, { published_at: "2026-10-20T12:00:00Z", html_url: "https://github.com/example/project/releases/tag/v0.35.0" });
          if (controls.crashAfterPublish) throw new Error("lost connection after GitHub accepted publication");
        }
        return structuredClone(release);
      }
      if (path.includes("/git/tags/")) return { object: { type: "commit", sha: merge } };
      throw new Error(`Unexpected fixture request: ${path}`);
    },
    optional(path) { calls.push({ path }); return path.endsWith("/releases/latest") ? { id: 199, tag_name: controls.previousTag } : structuredClone(tag); },
    pages(path) {
      calls.push({ path });
      if (path.includes("/actions/workflows/")) return structuredClone(controls.runs);
      if (path.endsWith("/releases")) return [structuredClone(release)];
      throw new Error(`Unexpected fixture listing: ${path}`);
    },
    git(args) { calls.push({ git: args }); return args[0] === "diff" && controls.changedPreparation ? "package.json" : ""; },
    run(program, args) {
      assert.equal(program, "git"); assert.equal(args[0], "show");
      const path = args[1].slice(41);
      if (path === notesPath("0.35.0")) return notes;
      const originals = Object.fromEntries(["package.json", "apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/Cargo.lock", "apps/runner/src/version.ts", "apps/control-plane/src/release-version.ts"].map((file) => [file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8")]));
      const files = bumpVersions(originals, JSON.parse(originals["package.json"]).version, "0.35.0");
      return controls.changedPreparation && path === "package.json"
        ? JSON.stringify({ ...JSON.parse(files[path]), version: "0.0.0-drift" }) : files[path];
    },
    notes() { return notes; },
    gates() { verifyReleaseJobs({ runId: 100, runAttempt: run.run_attempt, mergeSha: merge }, releaseJobs()); },
    timings() { return { runId: 100, attempt: run.run_attempt, headSha: merge, conclusion: run.conclusion, jobs: [{ conclusion: run.conclusion }] }; },
    verify() { calls.push({ verify: true }); if (controls.failVerification) throw new Error("bad signature or digest"); return () => calls.push({ recheck: true }); },
  };
  return { io, pr, run, release, controls, calls, saved,
    save: (s) => saved.push(structuredClone(s)),
    setTag: (next) => { tag = next; },
    mutations: () => calls.filter((c) => c.body && c.path !== "graphql"),
  };
}

const releaseJobs = () => [...NATIVE_RELEASE_JOBS, FINALIZER_JOB].map((name) => ({ name, run_id: 100,
  head_sha: merge, run_attempt: 1, status: "completed", conclusion: "success" }));

test("checkpoints are private atomic snapshots and carry no publication grant", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-state-test-"));
  try {
    const path = join(directory, "state.json"); saveCheckpoint(path, state());
    assert.deepEqual(JSON.parse(readFileSync(path)), state());
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    for (const edit of [{ repository: "../wrong" }, { branch: "--bad" }, { notesPath: "../private" }, { headSha: "bad" }, { tag: "v1.2.3" }, { releaseId: 0 }])
      assert.throws(() => validateCheckpoint({ ...state(), ...edit }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("version preparation changes each release field, retains dependencies, and recovers partial edits", () => {
  const paths = ["package.json", "apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/Cargo.lock", "apps/runner/src/version.ts", "apps/control-plane/src/release-version.ts"];
  const originals = Object.fromEntries(paths.map((path) => [path, readFileSync(new URL(`../${path}`, import.meta.url), "utf8")]));
  const currentVersion = JSON.parse(originals["package.json"]).version;
  const changed = bumpVersions(originals, currentVersion, "0.35.0");
  assert.equal(JSON.parse(changed["package.json"]).version, "0.35.0");
  assert.deepEqual(JSON.parse(changed["package.json"]).devDependencies, JSON.parse(originals["package.json"]).devDependencies);
  assert.match(changed["apps/runner/src/version.ts"], /VERSION = "0.35.0"/);
  assert.match(changed["apps/desktop/src-tauri/Cargo.lock"], /name = "wollipog-desktop"\nversion = "0.35.0"/);
  assert.deepEqual(bumpVersions(changed, currentVersion, "0.35.0"), changed);
  const inconsistent = { ...originals, "apps/runner/src/version.ts": 'export const VERSION = "99.0.0";' };
  assert.throws(() => bumpVersions(inconsistent, currentVersion, "0.35.0"));
  assert.throws(() => bumpVersions(originals, currentVersion, "0.35.0-rc.1"));
});

test("queue supervision follows replacement integrations and never treats disappearance as merge", () => {
  const f = fixture(), s = state(); f.pr.state = "OPEN";
  f.pr.mergeQueueEntry = { state: "AWAITING_CHECKS", position: 1, headCommit: { oid: base } };
  assert.equal(advance(s, grants, f.io).integrationSha, base);
  f.pr.mergeQueueEntry.headCommit.oid = merge;
  assert.equal(advance(s, grants, f.io).integrationSha, merge);
  assert.deepEqual(s.integrationHistory.map((entry) => entry.sha), [base, merge]);
  f.pr.mergeQueueEntry = { state: "QUEUED", position: 2, headCommit: null };
  assert.equal(advance(s, grants, f.io).stage, "merge-queue");
  f.pr.mergeQueueEntry = null;
  assert.equal(advance(s, grants, f.io).stage, "enqueue-approval");
  assert.equal(f.mutations().length, 0);
});

test("changed, forked, closed, or differently based PRs cannot advance the release", () => {
  for (const edit of [{ headRefOid: base }, { headRefName: "other" }, { baseRefName: "other" }, { headRepository: { nameWithOwner: "fork/project" } }, { state: "CLOSED" }]) {
    const f = fixture(); Object.assign(f.pr, edit);
    assert.throws(() => advance(state(), grants, f.io));
    assert.equal(f.mutations().length, 0);
  }
});

test("tag creation requires current narrow authority and never moves a conflicting tag", () => {
  const f = fixture(), s = state(); f.setTag(null);
  assert.equal(advance(s, {}, f.io).stage, "tag-approval");
  assert.equal(advance(s, { reviewedHead: base, allowTag: true }, f.io).stage, "tag-approval");
  assert.equal(f.mutations().length, 0);
  assert.equal(advance(s, grants, f.io).stage, "tag-created");
  assert.deepEqual(f.mutations()[0].body, { ref: "refs/tags/v0.35.0", sha: merge });
  advance(s, {}, f.io); // A crash after creating the tag is reconciled without a second POST.
  assert.equal(f.mutations().length, 1);
  f.setTag({ object: { type: "commit", sha: base } });
  assert.throws(() => advance(s, grants, f.io), /will not be moved/);
});

test("current workflow identity and every completed gate must pass before publication", () => {
  for (const edit of [{ status: "in_progress" }, { conclusion: "failure" }, { head_sha: base }, { path: ".github/workflows/other.yml" }, { head_branch: "v9.0.0" }, { event: "workflow_dispatch" }]) {
    const f = fixture(); Object.assign(f.run, edit); f.controls.runs = [f.run];
    if (edit.status) assert.equal(advance(state(), grants, f.io).stage, "native-builds-and-verification");
    else if (edit.head_sha || edit.head_branch) assert.equal(advance(state(), grants, f.io).stage, "await-release-workflow");
    else assert.throws(() => advance(state(), grants, f.io));
    assert.equal(f.mutations().length, 0);
  }
  const f = fixture(); f.controls.failVerification = true;
  assert.throws(() => advance(state(), grants, f.io), /bad signature/);
  assert.equal(f.mutations().length, 0);
});

test("duplicate workflows, release replacement, and merge-preparation drift block mutation", () => {
  const f = fixture(); f.controls.runs.push({ ...f.run, id: 101 });
  assert.throws(() => advance(state(), grants, f.io), /Multiple tag workflows/);
  f.controls.runs[1].event = "workflow_dispatch";
  assert.throws(() => advance(state(), grants, f.io), /Multiple tag workflows/);
  f.controls.runs.pop(); f.controls.changedPreparation = true;
  assert.throws(() => advance(state(), grants, f.io), /versions differ from the reviewed preparation/);
  f.controls.changedPreparation = false;
  assert.throws(() => advance({ ...state(), releaseId: 201 }, grants, f.io), /Release ID changed/);
  assert.equal(f.mutations().length, 0);
});

test("successful checks do not substitute for publication authority", () => {
  const f = fixture(), s = state();
  assert.equal(advance(s, {}, f.io, f.save).stage, "publish-approval");
  assert.equal(f.mutations().length, 0);
  assert.ok(f.calls.some((call) => call.verify));
  assert.equal(f.saved.at(-1).releaseId, 200);
});

test("missing timing metadata does not weaken or replace semantic release gates", () => {
  const f = fixture(), s = state();
  f.io.timings = () => { throw new Error("missing timestamps"); };
  assert.equal(advance(s, grants, f.io).stage, "publication-requested");
  assert.equal(advance(s, {}, f.io).stage, "published");
  assert.equal(s.timings.status, "unmeasured");
  const other = fixture();
  other.io.gates = () => { throw new Error("required job failed"); };
  assert.throws(() => advance(state(), grants, other.io), /required job failed/);
  assert.equal(other.mutations().length, 0);
});

test("required release jobs retain identity and success gates without requiring timestamps", () => {
  const s = { runId: 100, runAttempt: 2, mergeSha: merge };
  verifyReleaseJobs(s, releaseJobs()); // Successful jobs copied by a failed-job rerun remain valid.
  for (const edit of [{ conclusion: "failure" }, { status: "in_progress" }, { run_id: 101 }, { head_sha: base }, { run_attempt: 3 }]) {
    const jobs = releaseJobs(); Object.assign(jobs[0], edit);
    assert.throws(() => verifyReleaseJobs(s, jobs), /has not succeeded/);
  }
  assert.throws(() => verifyReleaseJobs(s, releaseJobs().slice(1)), /Missing or ambiguous/);
  assert.throws(() => verifyReleaseJobs(s, [...releaseJobs(), releaseJobs()[0]]), /Missing or ambiguous/);
});

test("checkpoint locking serializes stale recovery and preserves live or ambiguous owners", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-lock-test-"));
  const checkpoint = join(directory, "state.json"), lock = checkpoint + ".lock";
  try {
    const unlock = acquireCheckpointLock(checkpoint);
    assert.throws(() => acquireCheckpointLock(checkpoint), /Another release process/);
    assert.equal(readFileSync(lock, "utf8"), String(process.pid)); unlock();
    // A process known to have exited provides an actual stale owner, without guessing a PID.
    const deadPid = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    writeFileSync(lock, deadPid);
    writeFileSync(lock + ".recovery", "another recovery owner");
    assert.throws(() => acquireCheckpointLock(checkpoint), /recovery may be active/);
    assert.equal(readFileSync(lock, "utf8"), deadPid);
    rmSync(lock + ".recovery");
    acquireCheckpointLock(checkpoint)();
    writeFileSync(lock, "ambiguous");
    assert.throws(() => acquireCheckpointLock(checkpoint), /operator inspection/);
    assert.equal(readFileSync(lock, "utf8"), "ambiguous");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("accepted publication is recovered after interruption without another PATCH", () => {
  const f = fixture(), s = state(); f.controls.crashAfterPublish = true;
  assert.throws(() => advance(s, grants, f.io, f.save), /lost connection/);
  assert.equal(f.saved.at(-1).releaseId, 200);
  assert.equal(f.release.draft, false);
  const recovered = structuredClone(f.saved.at(-1));
  assert.equal(advance(recovered, {}, f.io, f.save).stage, "published");
  assert.equal(f.mutations().length, 1);
  assert.deepEqual(f.mutations()[0].body, { tag_name: "v0.35.0", target_commitish: merge,
    name: "Wollipog v0.35.0", body: notes, prerelease: false, draft: false, make_latest: "true" });
});

test("resume refuses a published release whose contents or latest identity differ", () => {
  const f = fixture(); advance(state(), grants, f.io);
  f.release.body = "other notes";
  assert.throws(() => advance(state(), {}, f.io), /reviewed metadata/);
  f.release.body = notes; f.controls.latestId = 201;
  assert.throws(() => advance(state(), {}, f.io), /not the latest/);
  assert.equal(f.mutations().length, 1);
});

test("a rerun starting during final verification invalidates publication", () => {
  const f = fixture();
  f.io.verify = () => { f.run.run_attempt++; f.run.status = "in_progress"; };
  assert.throws(() => advance(state(), grants, f.io), /changed before publication/);
  assert.equal(f.mutations().length, 0);
});

test("last-moment tag changes, changed assets, and newer stable releases block publication", () => {
  for (const change of ["tag", "assets", "latest"]) {
    const f = fixture();
    if (change === "tag") f.io.verify = () => { f.setTag({ object: { type: "commit", sha: base } }); return () => {}; };
    if (change === "assets") f.io.verify = () => () => { throw new Error("Hosted assets changed after verification"); };
    if (change === "latest") f.controls.previousTag = "v0.36.0";
    assert.throws(() => advance(state(), grants, f.io));
    assert.equal(f.mutations().length, 0);
  }
});

test("preparation recovers accepted commits and PR creation without repeating either", () => {
  const directory = mkdtempSync(join(tmpdir(), "release-prepare-test-"));
  const primary = join(directory, "primary"), worktree = join(directory, "release"), checkpoint = join(directory, "state.json");
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "gitconfig") };
  writeFileSync(environment.GIT_CONFIG_GLOBAL, "");
  const git = (args, cwd = worktree) => execFileSync("git", args, { cwd, env: environment, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    mkdirSync(primary); git(["init", "--initial-branch=main"], primary);
    git(["config", "user.name", "Release Test"], primary); git(["config", "user.email", "release-test@example.invalid"], primary);
    const paths = ["package.json", "apps/desktop/package.json", "apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/src-tauri/Cargo.toml", "apps/desktop/src-tauri/Cargo.lock", "apps/runner/src/version.ts", "apps/control-plane/src/release-version.ts"];
    for (const path of paths) {
      const target = join(primary, path); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(new URL(`../${path}`, import.meta.url)));
    }
    git(["add", "."], primary); git(["commit", "-m", "Initial fixture"], primary);
    git(["remote", "add", "origin", "https://github.com/example/project.git"], primary);
    const targetVersion = "99999.0.0";
    const fixtureNotes = notes.replaceAll("0.35.0", targetVersion);
    git(["worktree", "add", "-b", `release/v${targetVersion}`, worktree], primary);
    const notesFile = join(worktree, notesPath(targetVersion)); mkdirSync(dirname(notesFile), { recursive: true }); writeFileSync(notesFile, fixtureNotes);
    let pushed = false, created = false, lostResponse = true;
    const checks = [], creations = [];
    const io = {
      cwd: worktree,
      git(args) {
        if (args.includes("push")) { pushed = true; return ""; }
        return git(args);
      },
      gh(args) {
        if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "example/project", defaultBranchRef: { name: "main" } });
        const pr = { number: 42, headRefOid: git(["rev-parse", "HEAD"]), baseRefName: "main" };
        if (args[1] === "list") return JSON.stringify(created ? [pr] : []);
        if (args[1] === "create") { assert.ok(pushed); created = true; creations.push(args); return "fixture PR"; }
        if (args[1] === "view") { if (lostResponse) { lostResponse = false; throw new Error("interrupted after accepted PR creation"); } return JSON.stringify(pr); }
        throw new Error("Unexpected fixture gh command");
      },
      run(program, args) {
        if (program === "pnpm") { checks.push(args[0]); return ""; }
        return execFileSync(program, args, { cwd: worktree, env: environment, encoding: "utf8" });
      },
    };
    const initialHead = git(["rev-parse", "HEAD"]);
    writeFileSync(join(worktree, "unrelated.txt"), "staged user work");
    git(["add", "unrelated.txt"]); rmSync(join(worktree, "unrelated.txt"));
    assert.equal(git(["diff", "--name-only", "HEAD"]), "");
    assert.throws(() => prepare(targetVersion, checkpoint, io), /Unrelated working-tree changes/);
    assert.equal(git(["rev-parse", "HEAD"]), initialHead);
    assert.equal(git(["show", ":unrelated.txt"]), "staged user work");
    assert.deepEqual(checks, []);
    git(["reset", "--", "unrelated.txt"]);

    const initialPackage = readFileSync(join(worktree, "package.json"), "utf8");
    const stagedPackage = JSON.parse(initialPackage); stagedPackage.scripts.unrelated = "staged user work";
    writeFileSync(join(worktree, "package.json"), JSON.stringify(stagedPackage, null, 2) + "\n");
    git(["add", "package.json"]); writeFileSync(join(worktree, "package.json"), initialPackage);
    assert.equal(git(["diff", "--name-only", "HEAD"]), "");
    assert.throws(() => prepare(targetVersion, checkpoint, io), /Unrelated staged edits within package.json/);
    assert.equal(git(["rev-parse", "HEAD"]), initialHead);
    assert.equal(JSON.parse(git(["show", ":package.json"])).scripts.unrelated, "staged user work");
    assert.deepEqual(checks, []);
    git(["reset", "--", "package.json"]);

    assert.throws(() => prepare(targetVersion, checkpoint, io), /interrupted/);
    const committedHead = git(["rev-parse", "HEAD"]);
    const resumed = prepare(targetVersion, checkpoint, io);
    assert.equal(resumed.prNumber, 42); assert.equal(resumed.headSha, committedHead);
    assert.deepEqual(checks, ["typecheck", "test"]); assert.equal(creations.length, 1);
    assert.equal(git(["rev-list", "--count", "HEAD"]), "2");
    assert.equal(readFileSync(join(primary, "package.json"), "utf8"), readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(resumed.notesSha256, createHash("sha256").update(fixtureNotes).digest("hex"));
    const packagePath = join(worktree, "package.json");
    const packageText = readFileSync(packagePath, "utf8");
    const edited = JSON.parse(packageText); edited.scripts.unrelated = "preserve this edit";
    writeFileSync(packagePath, JSON.stringify(edited, null, 2) + "\n");
    assert.throws(() => prepare(targetVersion, checkpoint, io), /Unrelated edits within package.json/);
    git(["add", "package.json"]); git(["commit", "-m", "Concurrent dependency-bearing change"]);
    // The actual merged tree may contain main's unrelated edits in release-bearing files.
    const merged = { ...resumed, mergeSha: git(["rev-parse", "HEAD"]) };
    verifyMergedPreparation(merged, io);
    assert.notEqual(git(["diff", resumed.headSha, merged.mergeSha, "--", "package.json"]), "");
    edited.version = "1.0.0"; writeFileSync(packagePath, JSON.stringify(edited));
    git(["add", "package.json"]); git(["commit", "-m", "Wrong release version"]);
    assert.throws(() => verifyMergedPreparation({ ...merged, mergeSha: git(["rev-parse", "HEAD"]) }, io), /versions differ/);
    git(["reset", "--hard", resumed.headSha]);
    writeFileSync(notesFile, fixtureNotes + "Changed after review\n");
    git(["add", notesPath(targetVersion)]); git(["commit", "-m", "Changed notes"]);
    assert.throws(() => verifyMergedPreparation({ ...merged, mergeSha: git(["rev-parse", "HEAD"]) }, io), /notes differ/);
    git(["reset", "--hard", resumed.headSha]);
    writeFileSync(packagePath, packageText);
    writeFileSync(join(worktree, "unrelated.txt"), "preserve this work");
    assert.throws(() => prepare(targetVersion, checkpoint, io), /Unrelated working-tree changes/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
