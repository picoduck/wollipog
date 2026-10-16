import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionReviewJobCommand, SessionReviewJobUpdate } from "@wollipog/protocol";
import {
  discoverSessionReviewInstallation, reviewerForDriver, SessionReviewJobs, trustedPath,
  type PullRequestFacts, type SessionReviewDependencies, type SessionReviewInstallation,
} from "./session-review-jobs.js";
import type { SessionMeta } from "./session-store.js";

const uid = process.getuid?.() ?? -1;
/** Inside a user namespace host root shows as the overflow uid; the runner itself sees 0. */
const rootUid = statSync("/").uid;
const posixOnly = { skip: process.platform === "win32" };

function executable(path: string, body = "#!/bin/sh\nexit 0\n"): string {
  writeFileSync(path, body, { mode: 0o755 });
  return path;
}

test("trusted paths refuse session-writable roots and other-user-writable components", posixOnly, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-review-trust-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const safe = join(root, "safe"); mkdirSync(safe, { mode: 0o755 });
  const codexHome = join(root, "home", ".codex", "bin"); mkdirSync(codexHome, { recursive: true });
  const tool = executable(join(safe, "tool"));
  const planted = executable(join(codexHome, "codex"));
  assert.equal(trustedPath(tool, [join(root, "home", ".codex")], uid, rootUid), tool);
  assert.throws(() => trustedPath(planted, [join(root, "home", ".codex")], uid, rootUid), /a session can write/);
  chmodSync(tool, 0o757);
  assert.throws(() => trustedPath(tool, [], uid, rootUid), /writable by every user/);
  chmodSync(tool, 0o775);
  assert.equal(trustedPath(tool, [], uid, rootUid), tool, "group-write is fine below a private (0700) ancestor");
  const link = join(root, "link"); symlinkSync(planted, link);
  assert.throws(() => trustedPath(link, [join(root, "home", ".codex")], uid, rootUid), /a session can write/, "symlinks are resolved first");
});

function fakeHome(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-review-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
  const release = join(root, "devbox", "releases", "abc", "skills", "cross-model-review");
  mkdirSync(join(release, "scripts"), { recursive: true });
  executable(join(release, "scripts", "review.py"), "#!/usr/bin/env python3\n");
  writeFileSync(join(release, "scripts", "review_core.py"), "# core\n");
  writeFileSync(join(release, "reviewers.json"), "{}\n");
  writeFileSync(join(release, "workflow-contract.json"), JSON.stringify({ contract_version: 1 }));
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(release, join(home, ".claude", "skills", "cross-model-review"));
  const bin = join(root, "bin"); mkdirSync(bin, { mode: 0o755 });
  for (const name of ["python3", "git", "claude"]) executable(join(bin, name));
  const codexBin = join(home, ".codex", "bin"); mkdirSync(codexBin, { recursive: true });
  executable(join(codexBin, "codex"));
  return { root, home, dataDir: join(root, "data"), pathEnv: `${bin}:${codexBin}` };
}

test("discovery verifies the controller and refuses a reviewer a session could replace", posixOnly, (t) => {
  const f = fakeHome(t);
  mkdirSync(f.dataDir);
  const install = discoverSessionReviewInstallation({ home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv: f.pathEnv });
  assert.ok(install?.controller.endsWith("scripts/review.py"));
  if (!install) return;
  assert.match(install.controllerDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(install.capability.reviewers, ["claude-code"], "claude passes; codex under ~/.codex does not");
  assert.match(install.capability.unavailable?.codex ?? "", /a session can write/);
  assert.equal(install.reviewers.codex, undefined);
});

test("discovery reports an unsupported controller contract instead of using it", posixOnly, (t) => {
  const f = fakeHome(t);
  mkdirSync(f.dataDir);
  const skill = join(f.root, "devbox", "releases", "abc", "skills", "cross-model-review");
  writeFileSync(join(skill, "workflow-contract.json"), JSON.stringify({ contract_version: 2 }));
  const install = discoverSessionReviewInstallation({ home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv: f.pathEnv });
  assert.equal(install?.controller, "");
  assert.match(install?.capability.unavailable?.controller ?? "", /unsupported contract/);
});

test("each implementer gets the other model family as its reviewer", () => {
  assert.equal(reviewerForDriver("claude-code"), "codex");
  assert.equal(reviewerForDriver("codex-app-server"), "claude-code");
  assert.equal(reviewerForDriver("codex"), "claude-code");
  assert.equal(reviewerForDriver("acp"), null);
});

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

interface Harness {
  jobs: SessionReviewJobs;
  updates: SessionReviewJobUpdate[];
  spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv }>;
  execs: string[][];
  root: string;
  command(overrides?: Partial<SessionReviewJobCommand["request"]>, jobId?: string): SessionReviewJobCommand;
}

function harness(t: { after(fn: () => void): void }, options: {
  meta?: Partial<SessionMeta>;
  pr?: Partial<PullRequestFacts>;
  reviewers?: SessionReviewInstallation["reviewers"];
  complete?: boolean;
  liveChild?: boolean;
  attached?: boolean;
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "wollipog-review-jobs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree"); mkdirSync(worktree);
  const meta = {
    sessionId: "s_review", driver: "claude-code", context: { kind: "native" },
    worktreePath: worktree,
    worktrees: [{ id: "wt", path: worktree, branch: "fix/feature", source: options.attached ? "attached" : "created" }],
    ...options.meta,
  } as unknown as SessionMeta;
  const updates: SessionReviewJobUpdate[] = [];
  const spawned: Harness["spawned"] = [];
  const execs: string[][] = [];
  const install: SessionReviewInstallation = {
    controller: "/trusted/review.py", controllerDigest: "d".repeat(64), python: "/usr/bin/python3", git: "/usr/bin/git",
    reviewers: options.reviewers ?? { codex: "/trusted/codex", "claude-code": "/trusted/claude" },
    capability: { reviewers: ["claude-code", "codex"] },
  };
  const deps: SessionReviewDependencies = {
    exec: async (_command, args) => {
      execs.push(args);
      if (args.includes("get-url")) return "https://github.com/acme/widget.git\n";
      if (args.includes("--git-common-dir")) return `${join(root, "repo.git")}\n`;
      if (args.includes("clone")) { mkdirSync(args.at(-1)!, { recursive: true }); return ""; }
      return "";
    },
    pullRequest: async () => ({
      state: "open", baseRepository: "acme/widget", headRepository: "acme/widget", headRef: "fix/feature",
      headSha: HEAD, baseSha: BASE, ...options.pr,
    }),
    spawnController: (_python, args, spawnOptions) => {
      spawned.push({ args, env: spawnOptions.env });
      if (options.complete !== false) {
        const attemptDir = args[args.indexOf("--attempt-dir") + 1]!;
        mkdirSync(attemptDir, { recursive: true });
        writeFileSync(join(attemptDir, "summary.json"), JSON.stringify({
          status: "complete", attempt_valid: true, attempt_consumed: true, effective_vote: "UPVOTE",
        }));
        writeFileSync(join(attemptDir, "report.json"), JSON.stringify({ findings: [] }));
      }
      return Object.assign(new EventEmitter(), { pid: options.liveChild ? process.pid : undefined }) as unknown as ChildProcess;
    },
    installation: () => install,
    now: () => Date.now(),
    log: () => {},
  };
  const jobs = new SessionReviewJobs(join(root, "reviews"), { readMeta: () => meta }, (update) => updates.push(update), deps);
  t.after(() => jobs.close());
  return {
    jobs, updates, spawned, execs, root,
    command: (overrides = {}, jobId = "srj_00000001") => ({
      type: "session_review_job", jobId, nonce: "nonce-1", sessionId: "s_review",
      request: { pullRequest: { repository: "acme/widget", number: 7 }, headSha: HEAD, brief: "Intent and checks.", ...overrides },
    }),
  };
}

async function settled(h: Harness, jobId: string): Promise<SessionReviewJobUpdate> {
  for (let i = 0; i < 200; i++) {
    const done = h.updates.find((update) => update.jobId === jobId && update.state !== "running");
    if (done) return done;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`job ${jobId} never settled`);
}

test("a completed review returns the controller's summary, report and ledger", posixOnly, async (t) => {
  const h = harness(t);
  await h.jobs.dispatch(h.command());
  const done = await settled(h, "srj_00000001");
  assert.equal(done.state, "completed");
  assert.equal(done.reviewer, "codex");
  assert.equal(done.round, 1);
  assert.match(done.summary ?? "", /"attempt_valid":true/);
  assert.match(done.report ?? "", /findings/);
  assert.match(done.ledger ?? "", /Cross-Model Review: acme\/widget#7/);
  assert.equal(h.updates[0]?.state, "running");
  const { args, env } = h.spawned[0]!;
  assert.deepEqual(args.slice(0, 2), ["/trusted/review.py", "run"]);
  assert.equal(args[args.indexOf("--reviewer") + 1], "codex");
  assert.equal(args[args.indexOf("--expected-head") + 1], HEAD);
  assert.equal(args[args.indexOf("--base-ref") + 1], BASE);
  assert.equal(args.includes("--previous-attempt"), false, "round 1 is a full review");
  assert.notEqual(args[args.indexOf("--repo") + 1], join(h.root, "worktree"), "the reviewer reads a private snapshot");
  assert.equal(env.CLAUDECODE, "1");
  assert.match(env.PATH ?? "", /^.+\/bin-srj_00000001:\/usr\/bin:\/bin$/u);
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  assert.ok(h.execs.every((args) => args.includes("core.hooksPath=/dev/null")), "every git call disables session hooks");
  assert.equal(existsSync(args[args.indexOf("--repo") + 1]!), false, "the snapshot is removed when the job ends");
});

test("a second round reviews the delta since the last valid round", posixOnly, async (t) => {
  const h = harness(t);
  await h.jobs.dispatch(h.command());
  await settled(h, "srj_00000001");
  await h.jobs.dispatch(h.command({ brief: undefined }, "srj_00000002"));
  const done = await settled(h, "srj_00000002");
  assert.equal(done.state, "completed");
  assert.equal(done.round, 2);
  const args = h.spawned[1]!.args;
  assert.match(args[args.indexOf("--previous-attempt") + 1] ?? "", /e1-r1-a1$/u);
  assert.ok(readFileSync(args[args.indexOf("--brief") + 1]!, "utf8").includes("Intent and checks."), "the stored brief is reused");
});

for (const [label, options, overrides, reason] of [
  ["another repository's pull request", { pr: { baseRepository: "other/repo", headRepository: "other/repo" } }, {}, /not this session's/],
  ["a fork pull request", { pr: { headRepository: "someone/widget" } }, {}, /not this session's/],
  ["another branch's pull request", { pr: { headRef: "unrelated" } }, {}, /not this session's/],
  ["a closed pull request", { pr: { state: "closed" } }, {}, /not this session's/],
  ["an unpushed head", { pr: { headSha: "c".repeat(40) } }, {}, /pushed head/],
  ["a first round without a brief", {}, { brief: undefined }, /needs a brief/],
  ["an attached worktree", { attached: true }, {}, /native managed worktree/],
  ["a harness whose reviewer is untrusted", { reviewers: { "claude-code": "/trusted/claude" } }, {}, /reviewer for this session's harness is unavailable/],
] as const) {
  test(`a review of ${label} is refused before anything launches`, posixOnly, async (t) => {
    const h = harness(t, options as never);
    await h.jobs.dispatch(h.command(overrides as never));
    const done = await settled(h, "srj_00000001");
    assert.equal(done.state, "not_launched");
    assert.match(done.reason ?? "", reason);
    assert.equal(h.spawned.length, 0);
  });
}

test("one review per session runs at a time", posixOnly, async (t) => {
  const h = harness(t, { complete: false, liveChild: true });
  await h.jobs.dispatch(h.command());
  await h.jobs.dispatch(h.command({}, "srj_00000002"));
  const refused = await settled(h, "srj_00000002");
  assert.equal(refused.state, "not_launched");
  assert.match(refused.reason ?? "", /already running/);
  assert.equal(h.spawned.length, 1);
});

test("a controller that dies without a result is recovered once, then reported failed", posixOnly, async (t) => {
  const h = harness(t, { complete: false });
  await h.jobs.dispatch(h.command());
  const done = await settled(h, "srj_00000001");
  assert.equal(done.state, "failed");
  assert.match(done.reason ?? "", /ended without a result/);
  assert.ok(h.execs.some((args) => args.includes("recover")), "the controller's recover step ran");
});

test("a job restored after a runner restart in `prepared` reports that it never launched", posixOnly, async (t) => {
  const h = harness(t);
  const jobsDir = join(h.root, "reviews", "jobs");
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "srj_00000009.json"), JSON.stringify({
    command: h.command({}, "srj_00000009"), phase: "prepared", prDir: join(h.root, "reviews", "pr"),
  }));
  const updates: SessionReviewJobUpdate[] = [];
  const restored = new SessionReviewJobs(join(h.root, "reviews"), { readMeta: () => null }, (update) => updates.push(update), {
    exec: async () => "", pullRequest: async () => { throw new Error("unused"); },
    spawnController: () => { throw new Error("unused"); }, installation: () => null, now: () => Date.now(), log: () => {},
  });
  t.after(() => restored.close());
  assert.equal(updates[0]?.state, "not_launched");
});
