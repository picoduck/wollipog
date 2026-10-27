import assert from "node:assert/strict";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { EventEmitter, once } from "node:events";
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import vm from "node:vm";
import { transformSync } from "esbuild";
import type { SessionReviewJobCommand, SessionReviewJobUpdate } from "@wollipog/protocol";
import {
  configuredSessionWritablePaths, defaultSessionReviewDependencies, discoverSessionReviewInstallation, reviewerForDriver,
  sessionReviewLaunchArgs, SessionReviewJobs, trustedPath,
  type PullRequestFacts, type SessionReviewDependencies, type SessionReviewInstallation,
} from "./session-review-jobs.js";
import type { SessionMeta } from "./session-store.js";
import { reviewSessionDiscoveryReason } from "./review-sessions.js";

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
  assert.equal(trustedPath(tool, [], uid, rootUid, undefined, () => true), tool, "proven user-private group writes are safe");
  assert.throws(() => trustedPath(tool, [], uid, rootUid, undefined, () => false), /writable by its group/,
    "shared groups remain untrusted even below a private ancestor");
  const link = join(root, "link"); symlinkSync(planted, link);
  assert.throws(() => trustedPath(link, [join(root, "home", ".codex")], uid, rootUid), /a session can write/, "symlinks are resolved first");
  // A trusted target reached through a link a session could repoint is refused too.
  const hop = join(root, "home", ".codex", "hop"); symlinkSync(tool, hop);
  assert.throws(() => trustedPath(hop, [join(root, "home", ".codex")], uid, rootUid), /a session can write/);
  const chained = join(safe, "chained"); symlinkSync(hop, chained);
  assert.throws(() => trustedPath(chained, [join(root, "home", ".codex")], uid, rootUid), /a session can write/,
    "every hop's directory is checked, not only the final path");
});

test("a sticky shared directory like /tmp is a safe ancestor even when its group can write it", posixOnly, (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-review-sticky-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(root, 0o755); // no private ancestor below the system temporary directory, as on CI
  const shared = join(root, "shared"); mkdirSync(shared); chmodSync(shared, 0o1777);
  const safe = join(shared, "safe"); mkdirSync(safe, { mode: 0o755 });
  const tool = executable(join(safe, "tool"));
  assert.equal(trustedPath(tool, [], uid, rootUid), tool);
  chmodSync(safe, 0o1777);
  assert.throws(() => trustedPath(safe, [], uid, rootUid), /writable by every user/, "the path itself never may be writable");
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
  mkdirSync(join(home, ".devbox"), { recursive: true });
  symlinkSync(join(root, "devbox", "releases", "abc", "skills"), join(home, ".devbox", "skills"));
  const bin = join(root, "bin"); mkdirSync(bin, { mode: 0o755 });
  for (const name of ["python3", "git", "gh", "claude"]) executable(join(bin, name));
  const codexBin = join(home, ".codex", "bin"); mkdirSync(codexBin, { recursive: true });
  executable(join(codexBin, "codex"));
  return { root, home, bin, codexBin, dataDir: join(root, "data"), pathEnv: `${bin}:${codexBin}`, release };
}

/** Fixtures live under the system temporary directory, which real discovery treats as writable. */
const temporaryRoots: string[] = [];

test("discovery verifies the controller and refuses a reviewer a session could replace", posixOnly, (t) => {
  const f = fakeHome(t);
  mkdirSync(f.dataDir);
  const install = discoverSessionReviewInstallation({ home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv: f.pathEnv, temporaryRoots });
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
  const install = discoverSessionReviewInstallation({ home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv: f.pathEnv, temporaryRoots });
  assert.equal(install?.controller, "");
  assert.match(install?.capability.unavailable?.controller ?? "", /unsupported contract/);
});

test("bridge discovery admits the statically protected standalone Codex installation", posixOnly, (t) => {
  const f = fakeHome(t);
  const bin = join(f.home, ".codex", "packages", "standalone", "version", "bin");
  mkdirSync(bin, { recursive: true });
  const binary = executable(join(bin, "codex"));
  const env = { home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv: `${f.bin}:${bin}`, temporaryRoots };
  assert.equal(discoverSessionReviewInstallation(env)?.reviewers.codex, undefined);
  assert.equal(discoverSessionReviewInstallation({ ...env, codexProtection: { home: f.home } })?.reviewers.codex, binary);
});

test("discovery never finds the controller through a provider home's skills directory", posixOnly, (t) => {
  const f = fakeHome(t);
  mkdirSync(f.dataDir);
  rmSync(join(f.home, ".devbox"), { recursive: true });
  mkdirSync(join(f.home, ".claude", "skills"), { recursive: true });
  symlinkSync(f.release, join(f.home, ".claude", "skills", "cross-model-review"));
  assert.equal(discoverSessionReviewInstallation({ home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv: f.pathEnv, temporaryRoots }), null);
});

test("discovery refuses an installation under a session-writable root", posixOnly, (t) => {
  const f = fakeHome(t);
  mkdirSync(f.dataDir);
  const install = discoverSessionReviewInstallation({
    home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv: f.pathEnv, temporaryRoots, extraRoots: [join(f.root, "devbox")],
  });
  assert.equal(install?.controller, "");
  assert.match(install?.capability.unavailable?.controller ?? "", /a session can write/);
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
  /** The environment each exec ran with, in the same order as `execs`. */
  execEnvs: Array<NodeJS.ProcessEnv | undefined>;
  /** The gh path each pull request read used. */
  ghCalls: string[];
  /** The environment each pull request read ran with. */
  ghEnvs: Array<NodeJS.ProcessEnv | undefined>;
  root: string;
  deps: SessionReviewDependencies;
  meta: SessionMeta;
  command(overrides?: Partial<SessionReviewJobCommand["request"]>, jobId?: string): SessionReviewJobCommand;
}

function harness(t: { after(fn: () => void): void }, options: {
  meta?: Partial<SessionMeta>;
  pr?: Partial<PullRequestFacts>;
  reviewers?: SessionReviewInstallation["reviewers"];
  complete?: boolean;
  liveChild?: boolean;
  attached?: boolean;
  /** Commits the mirror lacks until they are fetched from the forge. */
  missing?: Set<string>;
  /** How many launches fail the controller's preflight first: a summary on stdout only. */
  preflightFailures?: number;
  /** Start a real controller process instead of the in-process fake. */
  controller?: (args: string[], options: { stdout: number }) => ChildProcess;
  /** Overrides of the trusted installation. */
  install?: Partial<SessionReviewInstallation>;
  /** The project checkout's origin URL. */
  origin?: string;
  /** The controller's recovery step. */
  recover?: (args: string[]) => Promise<string>;
  /** No earlier head is an ancestor of a later one (a rebase). */
  notAncestor?: boolean;
  /** Replace the fake exec entirely (a real git). */
  exec?: SessionReviewDependencies["exec"];
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "wollipog-review-jobs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree"); mkdirSync(worktree);
  const repo = join(root, "repo"); mkdirSync(join(repo, ".git"), { recursive: true });
  const meta = {
    sessionId: "s_review", driver: "claude-code", context: { kind: "native" },
    repoPath: repo,
    worktreePath: worktree,
    worktrees: [{ id: "wt", path: worktree, branch: "fix/feature", source: options.attached ? "attached" : "created" }],
    ...options.meta,
  } as unknown as SessionMeta;
  const updates: SessionReviewJobUpdate[] = [];
  const spawned: Harness["spawned"] = [];
  const execs: string[][] = [];
  const execEnvs: Harness["execEnvs"] = [];
  const ghCalls: string[] = [];
  const ghEnvs: Harness["ghEnvs"] = [];
  let preflightFailures = options.preflightFailures ?? 0;
  const install: SessionReviewInstallation = {
    controller: "/trusted/review.py", controllerDigest: "d".repeat(64), python: "/usr/bin/python3", git: "/usr/bin/git",
    gh: "/trusted/gh",
    reviewers: options.reviewers ?? { codex: "/trusted/codex", "claude-code": "/trusted/claude" },
    capability: { reviewers: ["claude-code", "codex"] },
    ...options.install,
  };
  const deps: SessionReviewDependencies = {
    exec: async (command, args, execOptions) => {
      execs.push(args);
      execEnvs.push(execOptions?.env);
      if (options.exec) return options.exec(command, args, execOptions);
      if (args.includes("recover") && options.recover) return options.recover(args);
      if (args.includes("get-url")) return `${options.origin ?? "https://github.com/acme/widget.git"}\n`;
      if (args.includes("clone")) { mkdirSync(args.at(-1)!, { recursive: true }); return ""; }
      if (args.includes("cat-file") && options.missing?.has(args.at(-1)!.slice(0, 40))) throw new Error("missing");
      if (args.includes("merge-base") && options.notAncestor) throw new Error("not an ancestor");
      if (args.includes("fetch") && args.some((arg) => arg.startsWith("https://") || arg.startsWith("git@"))) {
        for (const sha of args.slice(args.indexOf("--end-of-options") + 2)) options.missing?.delete(sha);
      }
      return "";
    },
    pullRequest: async (gh, _repository, _number, env) => (ghCalls.push(gh), ghEnvs.push(env), {
      state: "open", baseRepository: "acme/widget", headRepository: "acme/widget", headRef: "fix/feature",
      headSha: HEAD, baseSha: BASE, ...options.pr,
    }),
    spawnController: (_python, args, spawnOptions) => {
      spawned.push({ args, env: spawnOptions.env });
      if (options.controller) return options.controller(args, spawnOptions);
      if (preflightFailures > 0) {
        preflightFailures -= 1;
        // What review.py's preflight_failure prints; it creates no attempt directory.
        writeSync(spawnOptions.stdout, `${JSON.stringify({
          schema_version: 1, phase: "preflight", launched: false, attempt_consumed: false, attempt_valid: false,
          effective_vote: null, failure_class: "environment", validation_errors: ["codex is not signed in"],
        })}\n`);
      } else if (options.complete !== false) {
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
    jobs, updates, spawned, execs, execEnvs, ghCalls, ghEnvs, root, deps, meta,
    command: (overrides = {}, jobId = "srj_00000001") => ({
      type: "session_review_job", jobId, nonce: "nonce-1", sessionId: "s_review",
      request: { pullRequest: { repository: "acme/widget", number: 7 }, headSha: HEAD, brief: "Intent and checks.", ...overrides },
    }),
  };
}

function attemptRecords(h: Harness): Array<{ round: number; attempt: number; consumed: boolean; valid: boolean }> {
  const path = join(h.root, "reviews", "sessions", "s_review", "acme__widget", "pr-7", "attempts.json");
  return (JSON.parse(readFileSync(path, "utf8")) as { attempts: Array<{ round: number; attempt: number; consumed: boolean; valid: boolean }> }).attempts;
}

async function settled(h: Harness, jobId: string, timeoutMs = 2_000): Promise<SessionReviewJobUpdate> {
  for (let i = 0; i < timeoutMs / 10; i++) {
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
  assert.deepEqual(h.ghCalls, ["/trusted/gh"], "pull request facts are read with the verified gh");
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

for (const scenario of ["owned", "missing", "foreign", "attached", "switched", "unregistered"] as const) {
  test(`automatic worktree bridge admission: ${scenario}`, posixOnly, async (t) => {
    const branch = "agent/s_review";
    const h = harness(t, { pr: { headRef: branch } });
    h.meta.worktreeBranch = branch;
    h.meta.worktrees = [{ id: "legacy", path: h.meta.worktreePath!, branch,
      source: scenario === "attached" ? "attached" : "legacy" }];
    h.meta.launchWorktreeProof = scenario === "missing" ? undefined : {
      sessionId: scenario === "foreign" ? "s_other" : h.meta.sessionId,
      repoPath: h.meta.repoPath, path: h.meta.worktreePath!, branch,
    };
    const exec = h.deps.exec;
    h.deps.exec = async (command, args, options) => args.includes("--git-common-dir")
      ? `${join(h.meta.repoPath, ".git")}\nrefs/heads/${branch}\n`
      : args.includes("list")
      ? `worktree ${h.meta.repoPath}\0HEAD ${BASE}\0branch refs/heads/main\0\0` +
        (scenario === "unregistered" ? "" : `worktree ${h.meta.worktreePath}\0HEAD ${HEAD}\0branch refs/heads/${scenario === "switched" ? "other" : branch}\0\0`)
      : exec(command, args, options);
    await h.jobs.dispatch(h.command());
    const done = await settled(h, "srj_00000001");
    assert.equal(done.state, scenario === "owned" ? "completed" : "not_launched");
    assert.equal(h.spawned.length, scenario === "owned" ? 1 : 0);
    if (scenario === "missing" || scenario === "foreign") assert.match(done.reason!, /resume this session once/);
    if (scenario === "switched" || scenario === "unregistered") assert.match(done.reason!, /no longer registered.*expected branch/);
  });
}

test("the snapshot comes from a runner-owned mirror, never from session-controlled git state", posixOnly, async (t) => {
  const h = harness(t, { missing: new Set([HEAD]) });
  await h.jobs.dispatch(h.command());
  assert.equal((await settled(h, "srj_00000001")).state, "completed");
  const location = h.execs.filter((args) => args.includes("get-url"));
  assert.ok(location.length && location.every((args) => args[args.indexOf("-C") + 1] === join(h.root, "repo")),
    "the repository is read from the runner-recorded checkout, not the worktree");
  const fetches = h.execs.filter((args) => args.includes("fetch"));
  assert.equal(fetches.length, 2);
  assert.deepEqual(fetches.map((args) => args[args.indexOf("--end-of-options") + 1]), [
    `file://${join(h.root, "repo", ".git")}`, "https://github.com/acme/widget.git",
  ], "local objects pass through the pack protocol; the forge URL is built by the runner");
  assert.ok(fetches.every((args) => args.includes("protocol.allow=never") && args.includes("transfer.fsckObjects=true")));
  assert.deepEqual(fetches[0]!.slice(fetches[0]!.indexOf("--end-of-options") + 2), ["+refs/heads/fix/feature:refs/session/heads/fix/feature"],
    "only the session's own branch is read from the checkout");
  assert.equal(fetches[1]!.at(-1), HEAD);
  const clone = h.execs.find((args) => args.includes("clone"))!;
  assert.match(clone.at(-2)!, /reviews\/mirrors\/acme__widget\.git$/u);
});

for (const [label, redirect] of [
  ["a gitdir file", (git: string) => { rmSync(git, { recursive: true }); writeFileSync(git, "gitdir: /elsewhere/.git\n"); }],
  ["a commondir indirection", (git: string) => writeFileSync(join(git, "commondir"), "/elsewhere/.git\n")],
] as const) {
  test(`a project checkout whose git directory is redirected through ${label} is never read`, posixOnly, async (t) => {
    const h = harness(t);
    redirect(join(h.root, "repo", ".git"));
    await h.jobs.dispatch(h.command());
    const done = await settled(h, "srj_00000001");
    assert.equal(done.state, "not_launched");
    assert.match(done.reason ?? "", /snapshot could not be prepared/);
    assert.equal(h.execs.some((args) => args.includes("fetch")), false);
  });
}

test("repository names map to one review directory whatever their case", posixOnly, async (t) => {
  const h = harness(t);
  await h.jobs.dispatch(h.command());
  await settled(h, "srj_00000001");
  await h.jobs.dispatch(h.command({ brief: undefined, pullRequest: { repository: "ACME/Widget", number: 7 } }, "srj_00000002"));
  const done = await settled(h, "srj_00000002");
  assert.equal(done.round, 2, "the round count follows the repository, not its spelling");
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
  ["a malformed repository name", {}, { pullRequest: { repository: "acme/..", number: 7 } }, /not this session's/],
  ["an option-shaped repository name", {}, { pullRequest: { repository: "--upload-pack=x/widget", number: 7 } }, /not this session's/],
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
  assert.deepEqual(attemptRecords(h).map((attempt) => attempt.consumed), [true],
    "an attempt that left no summary anywhere stays consumed");
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

/** Run the runner's own advertisement functions from index.ts without booting a runner. */
function advertisedRuntime(platform: string, capability: () => unknown, runtime: Record<string, unknown>,
  reviewCapability: () => unknown = () => undefined, update = false): Record<string, unknown> {
  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const start = index.indexOf("function sessionReviewCapability(");
  const end = index.indexOf("\nfunction startTrackedSession(", start);
  assert.ok(start > 0 && end > start, "index.ts defines the session review advertisement");
  const context = vm.createContext({ process: { platform }, sessionReviewJobs: { capability }, reviewSessionLauncher: { capability: reviewCapability },
    reviewSessionDiscoveryReason, log: () => {},
    config: { runnerId: "runner" }, ws: null, outbox: { enqueue: (message: unknown) => { context.result = message; } },
    errText: (error: unknown) => String(error) });
  const sendStart = index.indexOf("function sendUp(");
  const sendEnd = index.indexOf("\n/** Agent Control answers", sendStart);
  const source = index.slice(start, end) + (update ? index.slice(sendStart, sendEnd) : "");
  vm.runInContext(`${transformSync(source, { loader: "ts", format: "cjs" }).code}
    ${update ? 'sendUp({ type: "agents_updated", runnerId: "runner", agents: [] });'
      : `globalThis.result = withSessionReviewRuntime(${JSON.stringify(runtime)});`}`, context);
  return JSON.parse(JSON.stringify(context.result)) as Record<string, unknown>;
}

test("review-session advertisement publishes a discovery failure and recovers at the next publication", () => {
  let failed = true;
  const reviewCapability = () => {
    if (failed) throw new Error("tool discovery failed during startup");
    return { reviewers: [{ harness: "claude-code", agentId: "claude" }] };
  };
  assert.deepEqual(advertisedRuntime("linux", () => undefined, {}, reviewCapability), {
    reviewSession: { reviewers: [], unavailable: { tools: "tool discovery failed during startup" } },
  });
  assert.deepEqual(advertisedRuntime("linux", () => undefined, {}, reviewCapability, true), {
    type: "agents_updated", runnerId: "runner", agents: [],
    reviewSession: { reviewers: [], unavailable: { tools: "tool discovery failed during startup" } },
  });
  failed = false;
  assert.deepEqual(advertisedRuntime("linux", () => undefined, {}, reviewCapability), { reviewSession: reviewCapability() });
  assert.deepEqual(advertisedRuntime("linux", () => undefined, {}, reviewCapability, true), {
    type: "agents_updated", runnerId: "runner", agents: [], reviewSession: reviewCapability(),
  });
  assert.deepEqual(advertisedRuntime("darwin", () => undefined, {}, reviewCapability), {});
});

test("the runner advertises session review on Linux only and wires its commands (#3306)", () => {
  const capability = { controllerDigest: "d".repeat(64), reviewers: ["codex"] };
  const base = { dataDir: "/runner", maxConcurrentSessions: 2 };
  assert.deepEqual(advertisedRuntime("linux", () => capability, base), { ...base, sessionReview: capability });
  assert.deepEqual(advertisedRuntime("darwin", () => capability, base), base, "job liveness reads /proc");
  assert.deepEqual(advertisedRuntime("win32", () => capability, base), base);
  assert.deepEqual(advertisedRuntime("linux", () => undefined, { ...base, sessionReview: capability }), base,
    "a removed installation stops being advertised at the next registration");
  assert.deepEqual(advertisedRuntime("linux", () => { throw new Error("boom"); }, base), base);

  const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(index, /new SessionReviewJobs\(resolve\(config\.dataDir, "session-review-jobs"\), store, sendUp,\s+sessionReviewDependencies, undefined, reviewSnapshots\);/u);
  assert.match(index, /const sessionWritablePaths = \(\) => configuredSessionWritablePaths\(\{\s+workspaces: config\.workspaces, providerAccounts: config\.providerAccounts, agents: config\.agents,\s+sessions: store\.listSessions\(\), hostEnv: process\.env,/u,
    "discovery treats every configured and persisted provider home as session-writable");
  assert.match(index, /defaultSessionReviewDependencies\(config\.dataDir, log, sessionWritablePaths, codexProtection\)/u);
  assert.match(index, /defaultReviewSessionDependencies\(config\.dataDir, log, sessionWritablePaths, agentsForControlPlane,/u,
    "review sessions trust their reviewer CLI against the same session-writable roots");
  assert.match(index, /case "session_review_job":\s+runCommandTask\("session_review_job", sessionReviewJobs\.dispatch\(msg\)\);/u);
  assert.match(index, /case "cancel_session_review_job":\s+sessionReviewJobs\.cancel\(msg\.jobId, msg\.nonce\);/u);
  assert.match(index, /runtime: withSessionReviewRuntime\(metadata\.runtime\)/u);
  assert.match(index, /bestEffort\("stop session review polling", \(\) => sessionReviewJobs\.close\(\)\)/u);
});

const PULL_REQUEST_JSON = JSON.stringify({
  state: "open", base: { sha: BASE, repo: { full_name: "acme/widget" } },
  head: { sha: HEAD, ref: "fix/feature", repo: { full_name: "acme/widget" } },
});

test("discovery skips a gh a session could plant earlier on PATH, and the runner runs only the trusted one", posixOnly, async (t) => {
  const f = fakeHome(t);
  mkdirSync(f.dataDir);
  const marker = join(f.root, "planted-gh-ran");
  executable(join(f.codexBin, "gh"), `#!/bin/sh\ntouch '${marker}'\nprintf '%s' '${PULL_REQUEST_JSON}'\n`);
  executable(join(f.bin, "gh"), `#!/bin/sh\n[ "$1" = api ] && [ "$2" = repos/acme/widget/pulls/7 ] || exit 3\nprintf '%s' '${PULL_REQUEST_JSON}'\n`);
  const pathEnv = `${f.codexBin}:${f.bin}`;
  const install = discoverSessionReviewInstallation({ home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv, temporaryRoots });
  assert.ok(install?.controller, "the controller is available with a trusted gh later on PATH");
  assert.equal(install.gh, realpathSync(join(f.bin, "gh")));
  const facts = await defaultSessionReviewDependencies(f.dataDir, () => {}).pullRequest(install.gh, "acme/widget", 7);
  assert.deepEqual(facts, {
    state: "open", baseRepository: "acme/widget", headRepository: "acme/widget", headRef: "fix/feature", headSha: HEAD, baseSha: BASE,
  });
  assert.equal(existsSync(marker), false, "the planted gh never ran");

  rmSync(join(f.bin, "gh"));
  const planted = discoverSessionReviewInstallation({ home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv, temporaryRoots });
  assert.equal(planted?.controller, "", "without a trusted gh nothing is runnable");
  assert.equal(planted?.gh, "");
  assert.match(planted?.capability.unavailable?.controller ?? "", /a session can write/);
  rmSync(join(f.codexBin, "gh"));
  const missing = discoverSessionReviewInstallation({ home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv, temporaryRoots });
  assert.match(missing?.capability.unavailable?.controller ?? "", /gh is not installed/);
  await assert.rejects(defaultSessionReviewDependencies(f.dataDir, () => {}).pullRequest("gh", "acme/widget", 7), /not verified/,
    "a bare command name is never looked up on PATH");
  assert.equal(existsSync(marker), false);
});

test("provider account, agent, session and host provider homes are session-writable roots", posixOnly, (t) => {
  const f = fakeHome(t);
  mkdirSync(f.dataDir);
  const at = (name: string) => join(f.root, name);
  const paths = configuredSessionWritablePaths({
    workspaces: [{ path: at("project"), additionalDirectoryGrants: [at("grant")] }],
    providerAccounts: [{ directory: at("account-claude") }],
    agents: [
      { id: "codex-custom", env: { CODEX_HOME: at("agent-codex"), HOME: at("agent-home") } },
      { id: "from-env", env: { CLAUDE_CONFIG_DIR: { fromEnv: "WOLLIPOG_TEST_CLAUDE_HOME" }, CODEX_HOME: { fromEnv: "WOLLIPOG_TEST_UNSET" } } },
      { id: "relative", env: { CODEX_HOME: "relative/codex" } },
    ],
    sessions: [{
      repoPath: at("project"), worktreePath: at("worktree"),
      worktrees: [{ id: "wt", path: at("attached"), branch: "b", source: "attached" }] as SessionMeta["worktrees"],
      env: { CLAUDE_CONFIG_DIR: at("session-env-claude"), HOME: at("session-home") },
      providerCredentialHome: at("session-credentials"), providerConversationHome: at("session-conversation"),
      pendingProviderCredentialHome: at("session-pending"),
    }],
    hostEnv: { CODEX_HOME: at("host-codex"), WOLLIPOG_TEST_CLAUDE_HOME: at("agent-claude-from-env") },
  });
  for (const expected of [
    "project", "grant", "account-claude", "agent-codex", "agent-home/.claude", "agent-home/.codex", "agent-home/.cache",
    "agent-claude-from-env", "worktree", "attached", "session-env-claude", "session-home/.codex", "session-credentials",
    "session-conversation", "session-pending", "host-codex",
  ]) assert.ok(paths.includes(at(expected)), `${expected} is a session-writable root`);
  assert.ok(paths.every((path) => path.startsWith("/")), "relative values are dropped");
});

test("discovery refuses a CLI inside a custom provider home, including through a symlink hop", posixOnly, (t) => {
  const f = fakeHome(t);
  mkdirSync(f.dataDir);
  // A configured account's credential home, configured through a link, and a session's own home.
  const accountHome = join(f.root, "accounts", "claude-work");
  mkdirSync(join(accountHome, "bin"), { recursive: true });
  symlinkSync(accountHome, join(f.root, "account-link"));
  executable(join(accountHome, "bin", "claude"));
  rmSync(join(f.bin, "claude"));
  symlinkSync(join(accountHome, "bin", "claude"), join(f.bin, "claude"));
  const sessionHome = join(f.root, "session-homes", "codex-a");
  mkdirSync(sessionHome, { recursive: true });
  executable(join(sessionHome, "gh"));
  const discover = (extraRoots: string[]) =>
    discoverSessionReviewInstallation({ home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv: f.pathEnv, temporaryRoots, extraRoots });

  assert.deepEqual(discover([])?.capability.reviewers, ["claude-code"], "outside any session home the link is trusted");
  const roots = configuredSessionWritablePaths({ providerAccounts: [{ directory: join(f.root, "account-link") }] });
  const refused = discover(roots);
  assert.equal(refused?.reviewers["claude-code"], undefined);
  assert.match(refused?.capability.unavailable?.["claude-code"] ?? "", /a session can write/);

  rmSync(join(f.bin, "gh"));
  symlinkSync(join(sessionHome, "gh"), join(f.bin, "gh"));
  const sessionRoots = configuredSessionWritablePaths({
    sessions: [{ repoPath: join(f.root, "project"), worktreePath: null, env: {}, providerCredentialHome: sessionHome }],
  });
  assert.ok(discover([])?.controller, "the gh link is trusted while no session names that home");
  const ghRefused = discover(sessionRoots);
  assert.equal(ghRefused?.controller, "");
  assert.match(ghRefused?.capability.unavailable?.controller ?? "", /a session can write/);
});

function findPython(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "python3"))) return join(dir, "python3");
  }
  return undefined;
}

test("the controller launches under python3 -I with only its own directory added for sibling imports", posixOnly, async (t) => {
  const python = findPython();
  if (!python) { t.skip("python3 is not installed"); return; }
  const root = mkdtempSync(join(tmpdir(), "wollipog-review-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "skill", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "review_core.py"), "VALUE = 'sibling'\n");
  const controller = join(scripts, "review.py");
  writeFileSync(controller, [
    "import json, sys",
    "import review_core",
    "try:",
    "    import decoy",
    "    decoy = True",
    "except ImportError:",
    "    decoy = False",
    "summary = {'command': sys.argv[1], 'argv0': sys.argv[0], 'sibling': review_core.VALUE, 'main': __name__,",
    "           'decoy': decoy, 'isolated': sys.flags.isolated}",
    "open(sys.argv[sys.argv.index('--attempt-dir') + 1], 'w').write(json.dumps(summary))",
    "print(json.dumps(summary))",
    "sys.exit(0)",
    "",
  ].join("\n"));
  // The working directory and PYTHONPATH must not reach sys.path.
  const cwd = join(root, "cwd");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "decoy.py"), "");
  const deps = defaultSessionReviewDependencies(join(root, "data"), () => {});
  const stdoutPath = join(root, "stdout.jsonl");
  const marker = join(root, "ran.json");
  const stdout = openSync(stdoutPath, "w", 0o600);
  let child: ChildProcess;
  try {
    child = deps.spawnController(python, [controller, "run", "--attempt-dir", marker], {
      cwd, env: { PATH: "/usr/bin:/bin", PYTHONPATH: cwd }, stdout,
    });
  } finally {
    closeSync(stdout);
  }
  const [code] = await once(child, "exit") as [number | null];
  assert.equal(code, 0);
  const ran = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
  assert.deepEqual(ran, { command: "run", argv0: controller, sibling: "sibling", main: "__main__", decoy: false, isolated: 1 });
  assert.deepEqual(JSON.parse(readFileSync(stdoutPath, "utf8").trim()), ran, "stdout reaches the runner-owned file");

  // Recovery uses the same launcher.
  const recovered = join(root, "recovered.json");
  const out = await deps.exec(python, sessionReviewLaunchArgs([controller, "recover", "--attempt-dir", recovered]), { cwd });
  assert.equal((JSON.parse(out) as { command: string; sibling: string }).command, "recover");
  assert.equal((JSON.parse(readFileSync(recovered, "utf8")) as { sibling: string }).sibling, "sibling");
  assert.equal(existsSync(join(scripts, "__pycache__")), false, "nothing is written into the installed skill");
});

test("preflight failures consume no attempt and return the controller's diagnostic summary", posixOnly, async (t) => {
  const h = harness(t, { preflightFailures: 2 });
  for (const [index, jobId] of ["srj_00000001", "srj_00000002"].entries()) {
    await h.jobs.dispatch(h.command(index ? { brief: undefined } : {}, jobId));
    const done = await settled(h, jobId);
    assert.equal(done.state, "completed");
    assert.equal(done.round, 1);
    assert.equal(done.attempt, index + 1);
    const summary = JSON.parse(done.summary ?? "{}") as Record<string, unknown>;
    assert.equal(summary.phase, "preflight");
    assert.equal(summary.attempt_consumed, false);
    assert.equal(summary.failure_class, "environment");
    assert.deepEqual(summary.validation_errors, ["codex is not signed in"]);
  }
  assert.equal(h.execs.some((args) => args.includes("recover")), false, "a preflight failure needs no recovery");
  await h.jobs.dispatch(h.command({ brief: undefined }, "srj_00000003"));
  const third = await settled(h, "srj_00000003");
  assert.equal(third.state, "completed", "two preflight failures leave the round's attempts unused");
  assert.equal(third.round, 1);
  assert.equal(third.attempt, 3);
  assert.match(third.summary ?? "", /"attempt_valid":true/);
  assert.equal(h.spawned.length, 3);
  assert.deepEqual(attemptRecords(h).map((attempt) => [attempt.consumed, attempt.valid]), [[false, false], [false, false], [true, true]]);
});

test("only a genuine preflight summary on stdout can refund an attempt", posixOnly, async (t) => {
  const h = harness(t, {
    controller: (args, { stdout }) => {
      // A launched attempt that died, plus a line claiming nothing was consumed: not a preflight.
      mkdirSync(args[args.indexOf("--attempt-dir") + 1]!, { recursive: true });
      writeSync(stdout, `${JSON.stringify({ phase: "execution", launched: true, attempt_consumed: false, attempt_valid: false })}\n`);
      return Object.assign(new EventEmitter(), { pid: undefined }) as unknown as ChildProcess;
    },
  });
  await h.jobs.dispatch(h.command());
  const done = await settled(h, "srj_00000001");
  assert.equal(done.state, "failed");
  assert.match(done.reason ?? "", /ended without a result/);
  assert.deepEqual(attemptRecords(h).map((attempt) => attempt.consumed), [true], "the attempt stays charged");
});

/** Alive and not a zombie. */
function processRunning(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^[ZX]$/u.test(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "");
  } catch { return false; }
}

test("a reviewer that outlives its controller keeps the job supervised, across a restart, until it is gone", { skip: process.platform !== "linux" }, async (t) => {
  const children: ChildProcess[] = [];
  const h = harness(t, {
    // Like review.py: the reviewer is a plain child in the controller's process group, and its pid
    // is written to the running summary once it starts.
    controller: (args, { stdout }) => {
      const attemptDir = args[args.indexOf("--attempt-dir") + 1]!;
      const child = spawnProcess("/bin/sh", ["-c", [
        'mkdir -p "$1"',
        "sleep 300 &",
        `printf '{"phase":"execution","status":"running","pid":%s}' "$!" > "$1/summary.next"`,
        'mv "$1/summary.next" "$1/summary.json"',
        "wait",
      ].join("\n"), "controller", attemptDir], { detached: true, stdio: ["ignore", stdout, "ignore"] });
      children.push(child);
      return child;
    },
  });
  t.after(() => {
    for (const child of children) {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
    }
  });
  await h.jobs.dispatch(h.command());
  const jobPath = join(h.root, "reviews", "jobs", "srj_00000001.json");
  let job: { pid?: number; reviewerPid?: number; checkout?: string } = {};
  for (let i = 0; i < 100 && !job.reviewerPid; i++) {
    await delay(100);
    job = JSON.parse(readFileSync(jobPath, "utf8")) as typeof job;
  }
  const reviewer = job.reviewerPid!;
  assert.ok(reviewer && reviewer !== job.pid, "the reviewer from the running summary is recorded");

  const exited = once(children[0]!, "exit");
  process.kill(job.pid!, "SIGKILL"); // the controller alone, as an OOM kill would
  await exited;
  await delay(300);
  assert.ok(processRunning(reviewer));
  assert.equal(h.updates.some((update) => update.state !== "running"), false, "the job stays supervised");
  assert.ok(existsSync(job.checkout!), "the snapshot stays while the reviewer can read it");
  assert.equal(h.execs.some((args) => args.includes("recover")), false, "recovery waits for the reviewer");

  // A restarted runner restores the job and keeps supervising it.
  h.jobs.close();
  const updates: SessionReviewJobUpdate[] = [];
  const restored = new SessionReviewJobs(join(h.root, "reviews"), { readMeta: () => h.meta }, (update) => updates.push(update), h.deps);
  t.after(() => restored.close());
  await delay(300);
  assert.equal(updates.length, 0, "the restored job is still running");
  assert.ok(existsSync(job.checkout!));

  restored.cancel("srj_00000001", "nonce-1");
  for (let i = 0; i < 1000 && !updates.length; i++) await delay(10);
  const done = updates.find((update) => update.state !== "running");
  assert.equal(done?.state, "failed");
  assert.match(done?.reason ?? "", /cancelled/);
  assert.equal(processRunning(reviewer), false, "cancel ended the reviewer through the controller's process group");
  assert.equal(existsSync(job.checkout!), false, "the snapshot is removed once nothing runs");
});

const PR_DIR = ["reviews", "sessions", "s_review", "acme__widget", "pr-7"] as const;

test("snapshot and pull request commands find helpers only through verified links, and SSH runs the verified ssh", posixOnly, async (t) => {
  const h = harness(t, { origin: "git@github.com:acme/widget.git", missing: new Set([HEAD]), install: { ssh: "/trusted/ssh" } });
  await h.jobs.dispatch(h.command());
  assert.equal((await settled(h, "srj_00000001")).state, "completed");
  const forge = h.execs.find((args) => args.includes("fetch") && args.includes(HEAD))!;
  assert.equal(forge[forge.indexOf("--end-of-options") + 1], "git@github.com:acme/widget.git");
  assert.ok(forge.includes("protocol.ssh.allow=always"));
  const envs = [...h.execEnvs, ...h.ghEnvs];
  assert.equal(envs.length, h.execs.length + h.ghCalls.length);
  const bins = new Set<string>();
  for (const env of envs) {
    const match = /^(.+\/reviews\/tools\/[0-9a-f]{24}):\/usr\/bin:\/bin$/u.exec(env?.PATH ?? "");
    assert.ok(match, `PATH holds only the runner's links and the system directories: ${env?.PATH}`);
    bins.add(match[1]!);
    assert.equal(env?.GIT_SSH_COMMAND, "'/trusted/ssh'", "git runs the verified ssh by its path");
    assert.equal(Object.keys(env ?? {}).some((name) => name.endsWith("ASKPASS")), false);
  }
  assert.equal(bins.size, 1);
  const [bin] = [...bins];
  assert.deepEqual(readdirSync(bin!).sort(), ["gh", "git", "ssh"]);
  assert.equal(readlinkSync(join(bin!, "ssh")), "/trusted/ssh");
  assert.equal(readlinkSync(join(bin!, "git")), "/usr/bin/git");
});

test("without a verified ssh the mirror is filled over HTTPS only, whatever the origin's spelling", posixOnly, async (t) => {
  const h = harness(t, { origin: "git@github.com:acme/widget.git", missing: new Set([HEAD]) });
  await h.jobs.dispatch(h.command());
  assert.equal((await settled(h, "srj_00000001")).state, "completed");
  const fetches = h.execs.filter((args) => args.includes("fetch"));
  assert.equal(fetches[1]![fetches[1]!.indexOf("--end-of-options") + 1], "https://github.com/acme/widget.git");
  assert.ok(fetches.every((args) => args.includes("protocol.ssh.allow=never")));
  assert.ok(h.execEnvs.every((env) => env?.GIT_SSH_COMMAND === "/bin/false"));
  const bin = /^([^:]+):/u.exec(h.execEnvs[0]?.PATH ?? "")![1]!;
  assert.deepEqual(readdirSync(bin).sort(), ["gh", "git"]);
});

test("an ssh planted on the runner's PATH never runs for an SSH-origin fetch with a real git", { skip: process.platform !== "linux" }, async (t) => {
  let git: string;
  try { git = realpathSync(execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim()); }
  catch { t.skip("git is not installed"); return; }
  const fixture = mkdtempSync(join(tmpdir(), "wollipog-review-ssh-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const planted = join(fixture, "session-bin"); mkdirSync(planted);
  const plantedRan = join(fixture, "planted-ssh-ran");
  executable(join(planted, "ssh"), `#!/bin/sh\ntouch '${plantedRan}'\nexit 255\n`);
  const trusted = join(fixture, "trusted"); mkdirSync(trusted);
  const trustedRan = join(fixture, "trusted-ssh-ran");
  const ssh = executable(join(trusted, "ssh"), `#!/bin/sh\necho "$@" > '${trustedRan}'\nexit 255\n`);
  // An isolated HOME keeps the user's own git configuration (url rewrites) out of the test.
  const home = join(fixture, "home"); mkdirSync(home);
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.PATH = `${planted}:${saved.PATH ?? "/usr/bin:/bin"}`;
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const repo = join(fixture, "repo");
  const run = (...args: string[]) => execFileSync(git, args, { cwd: repo, env: { ...process.env, PATH: "/usr/bin:/bin" } });
  mkdirSync(repo);
  run("init", "--quiet", "-b", "fix/feature");
  run("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "c");
  run("remote", "add", "origin", "git@github.com:acme/widget.git");
  const real = defaultSessionReviewDependencies(join(fixture, "data"), () => {});
  const h = harness(t, { meta: { repoPath: repo }, install: { git, ssh }, exec: real.exec });
  await h.jobs.dispatch(h.command());
  const done = await settled(h, "srj_00000001", 30_000);
  assert.equal(done.state, "not_launched", "the head exists nowhere, so the fetch fails");
  assert.match(readFileSync(trustedRan, "utf8"), /git@github\.com git-upload-pack 'acme\/widget\.git'/u, "the verified ssh ran");
  assert.equal(existsSync(plantedRan), false, "the planted ssh never ran");
});

test("a reviewer npm installs with an env node shebang runs under a verified node linked into the controller's PATH", posixOnly, async (t) => {
  if (!existsSync("/usr/bin/env")) { t.skip("/usr/bin/env is not installed"); return; }
  const f = fakeHome(t);
  mkdirSync(f.dataDir);
  executable(join(f.bin, "claude"), "#!/usr/bin/env node\nconsole.log('claude');\n");
  const nodeBin = join(f.root, "nvm", "versions", "node", "v24", "bin"); mkdirSync(nodeBin, { recursive: true });
  const node = executable(join(nodeBin, "node"));
  const discover = (pathEnv: string) =>
    discoverSessionReviewInstallation({ home: f.home, dataDir: f.dataDir, uid, rootUid, pathEnv, temporaryRoots });
  const install = discover(`${f.bin}:${nodeBin}:${f.codexBin}`);
  assert.equal(install?.reviewers["claude-code"], realpathSync(join(f.bin, "claude")));
  assert.deepEqual(install?.reviewerInterpreters?.["claude-code"], { name: "node", path: realpathSync(node) });

  const h = harness(t, {
    meta: { driver: "codex" },
    install: { reviewers: install!.reviewers, reviewerInterpreters: install!.reviewerInterpreters },
  });
  await h.jobs.dispatch(h.command());
  const done = await settled(h, "srj_00000001");
  assert.equal(done.state, "completed");
  assert.equal(done.reviewer, "claude-code");
  const bin = join(h.root, ...PR_DIR, "bin-srj_00000001");
  assert.equal(readlinkSync(join(bin, "node")), realpathSync(node), "env finds the verified node first");
  assert.equal(readlinkSync(join(bin, "claude")), realpathSync(join(f.bin, "claude")));

  // A node only a session could have planted makes the reviewer unavailable, with the reason.
  rmSync(node);
  executable(join(f.codexBin, "node"));
  const untrusted = discover(`${f.bin}:${f.codexBin}`);
  assert.equal(untrusted?.reviewers["claude-code"], undefined);
  assert.match(untrusted?.capability.unavailable?.["claude-code"] ?? "", /runs under node, which is unavailable: .*a session can write/u);
  const missing = discover(f.bin);
  assert.match(missing?.capability.unavailable?.["claude-code"] ?? "", /runs under node, which is unavailable: node is not installed/u);
});

test("a recovery in flight is not cut short by a redispatch or a cancel, and its result is published", posixOnly, async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = harness(t, {
    complete: false,
    recover: async (args) => {
      await gate;
      const attemptDir = args[args.indexOf("--attempt-dir") + 1]!;
      mkdirSync(attemptDir, { recursive: true });
      writeFileSync(join(attemptDir, "summary.json"), JSON.stringify({ status: "complete", attempt_valid: true, attempt_consumed: true }));
      writeFileSync(join(attemptDir, "report.json"), JSON.stringify({ findings: ["recovered"] }));
      return "";
    },
  });
  await h.jobs.dispatch(h.command());
  for (let i = 0; i < 200 && !h.execs.some((args) => args.includes("recover")); i++) await delay(10);
  assert.ok(h.execs.some((args) => args.includes("recover")), "recovery started");
  await h.jobs.dispatch(h.command());
  h.jobs.cancel("srj_00000001", "nonce-1");
  await delay(100);
  assert.equal(h.updates.some((update) => update.state !== "running"), false, "nothing finishes the job while recovery runs");
  release();
  const done = await settled(h, "srj_00000001");
  assert.equal(done.state, "completed");
  assert.match(done.report ?? "", /recovered/);
  assert.equal(h.execs.filter((args) => args.includes("recover")).length, 1);
  assert.deepEqual(attemptRecords(h).map((attempt) => [attempt.consumed, attempt.valid]), [[true, true]]);
  assert.equal(h.updates.filter((update) => update.state !== "running").length, 1);
});

/** A job saved as `launching` by a runner that stopped before recording its controller. */
function launchingJob(h: Harness, marker: string, attempt: "none" | "complete"): void {
  const prDir = join(h.root, ...PR_DIR);
  mkdirSync(prDir, { recursive: true });
  const attemptDir = join(prDir, "e1-r1-a1");
  const ledger = join(prDir, "ledger.md");
  writeFileSync(ledger, "# Cross-Model Review: acme/widget#7\n");
  const stdoutPath = join(prDir, "stdout-srj_00000009.jsonl");
  writeFileSync(stdoutPath, "");
  writeFileSync(join(prDir, "attempts.json"), JSON.stringify({
    epoch: 1, attempts: [{ epoch: 1, round: 1, attempt: 1, dir: attemptDir, head: HEAD, valid: false, consumed: true }],
  }));
  if (attempt === "complete") {
    mkdirSync(attemptDir);
    writeFileSync(join(attemptDir, "summary.json"), JSON.stringify({ status: "complete", attempt_valid: true, attempt_consumed: true }));
  }
  writeFileSync(join(h.root, "reviews", "jobs", "srj_00000009.json"), JSON.stringify({
    command: h.command({}, "srj_00000009"), phase: "launching", prDir, attemptDir, epoch: 1, round: 1, attempt: 1, reviewer: "codex",
    args: ["/trusted/review.py", "run", "--attempt-dir", attemptDir, "--ledger", ledger, "--round", "1"],
    stdoutPath, marker, startedAt: Date.now(), controllerDigest: "d".repeat(64),
  }));
}

/** Wait until each process shows the marker in /proc/<pid>/environ: it reads empty while the
 * process is still exec'ing, which a shell that has already exited does not wait for. */
async function waitForMarker(marker: string, ...pids: number[]): Promise<void> {
  const marked = (pid: number) => {
    try { return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`WOLLIPOG_SESSION_REVIEW_JOB=${marker}`); }
    catch { return false; }
  };
  for (let i = 0; i < 500 && !pids.every(marked); i++) await delay(2);
  assert.ok(pids.every(marked), "every marked process shows the marker in /proc");
}

function restart(h: Harness, t: { after(fn: () => void): void }): { jobs: SessionReviewJobs; updates: SessionReviewJobUpdate[] } {
  h.jobs.close();
  const updates: SessionReviewJobUpdate[] = [];
  const jobs = new SessionReviewJobs(join(h.root, "reviews"), { readMeta: () => h.meta }, (update) => updates.push(update), h.deps);
  t.after(() => jobs.close());
  return { jobs, updates };
}

test("a restart between the spawn and the running record adopts the controller found by its marker", { skip: process.platform !== "linux" }, async (t) => {
  const h = harness(t);
  const marker = "srj_00000009:0123456789abcdef0123456789abcdef";
  const controller = spawnProcess("sleep", ["300"], {
    detached: true, stdio: "ignore", env: { ...process.env, WOLLIPOG_SESSION_REVIEW_JOB: marker },
  });
  t.after(() => { try { process.kill(-controller.pid!, "SIGKILL"); } catch { /* gone */ } });
  const exited = once(controller, "exit");
  await waitForMarker(marker, controller.pid!);
  launchingJob(h, marker, "none");
  const { jobs, updates } = restart(h, t);
  const job = JSON.parse(readFileSync(join(h.root, "reviews", "jobs", "srj_00000009.json"), "utf8")) as { phase: string; pid?: number };
  assert.equal(job.phase, "running");
  assert.equal(job.pid, controller.pid, "the marked process group leader is the controller");
  await delay(200);
  assert.deepEqual(updates.map((update) => update.state), ["running"], "the adopted job stays supervised");
  assert.deepEqual(attemptRecords(h).map((attempt) => attempt.consumed), [true]);

  jobs.cancel("srj_00000009", "nonce-1");
  await exited;
  for (let i = 0; i < 500 && updates.length < 2; i++) await delay(10);
  const done = updates.at(-1);
  assert.equal(done?.state, "failed");
  assert.match(done?.reason ?? "", /cancelled/);
  assert.equal(processRunning(controller.pid!), false, "cancel signalled the adopted controller's group");
});

test("a restart keeps supervising the summary's reviewer when a short-lived marked helper is found first", { skip: process.platform !== "linux" }, async (t) => {
  const h = harness(t);
  const marker = "srj_00000009:aaaabbbbccccddddeeeeffff00001111";
  const pids = join(h.root, "pids");
  // The controller (group leader) exits at once, leaving a helper that lives briefly and was started
  // first (so it is enumerated first) and the long-lived reviewer, both carrying the marker.
  const controller = spawnProcess("sh", ["-c", `sleep 0.8 & h=$!; sleep 300 & r=$!; echo "$h $r" > ${pids}; exit 0`], {
    detached: true, stdio: "ignore", env: { ...process.env, WOLLIPOG_SESSION_REVIEW_JOB: marker },
  });
  t.after(() => { try { process.kill(-controller.pid!, "SIGKILL"); } catch { /* gone */ } });
  await once(controller, "exit");
  for (let i = 0; i < 100 && !existsSync(pids); i++) await delay(10);
  const [helper, reviewer] = readFileSync(pids, "utf8").trim().split(" ").map(Number) as [number, number];
  assert.ok(helper < reviewer, "the helper is enumerated before the reviewer");
  // The shell exits without waiting for its children to finish exec'ing; a restart that reads /proc
  // before then sees neither marker.
  await waitForMarker(marker, helper, reviewer);
  launchingJob(h, marker, "none");
  const job = JSON.parse(readFileSync(join(h.root, "reviews", "jobs", "srj_00000009.json"), "utf8")) as { attemptDir: string };
  mkdirSync(job.attemptDir);
  writeFileSync(join(job.attemptDir, "summary.json"), JSON.stringify({ phase: "execution", status: "running", pid: reviewer }));

  const { jobs, updates } = restart(h, t);
  const adopted = JSON.parse(readFileSync(join(h.root, "reviews", "jobs", "srj_00000009.json"), "utf8")) as { pid?: number; reviewerPid?: number };
  assert.equal(adopted.pid, controller.pid, "the group is the dead controller's");
  assert.equal(adopted.reviewerPid, reviewer, "the summary's reviewer is recorded, not the helper found first");
  await delay(2_500); // the helper exits and the job polls past it
  assert.equal(processRunning(helper), false);
  assert.deepEqual(updates.map((update) => update.state), ["running"], "the job stays supervised while its reviewer runs");
  assert.equal(existsSync(job.attemptDir), true);

  jobs.cancel("srj_00000009", "nonce-1");
  for (let i = 0; i < 500 && updates.length < 2; i++) await delay(10);
  assert.equal(updates.at(-1)?.state, "failed");
  assert.equal(processRunning(reviewer), false, "cancel reached the surviving reviewer");
});

test("a restart finds no controller and no attempt for a launching job: not launched, and the attempt is returned", posixOnly, (t) => {
  const h = harness(t);
  launchingJob(h, "srj_00000009:fedcba9876543210fedcba9876543210", "none");
  const { updates } = restart(h, t);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.state, "not_launched");
  assert.match(updates[0]?.reason ?? "", /ended without a result/);
  assert.deepEqual(attemptRecords(h), [], "an attempt that never launched is not charged");
});

test("a restart finds an attempt directory but no controller for a launching job: its result is reported", posixOnly, async (t) => {
  const h = harness(t);
  launchingJob(h, "srj_00000009:00112233445566778899aabbccddeeff", "complete");
  const { updates } = restart(h, t);
  for (let i = 0; i < 200 && !updates.some((update) => update.state !== "running"); i++) await delay(10);
  const done = updates.find((update) => update.state !== "running");
  assert.equal(done?.state, "completed");
  assert.match(done?.summary ?? "", /"attempt_valid":true/);
  assert.deepEqual(attemptRecords(h).map((attempt) => [attempt.consumed, attempt.valid]), [[true, true]]);
});

test("a controller whose running record cannot be saved is stopped and reported failed", { skip: process.platform !== "linux" || uid === 0 }, async (t) => {
  const children: ChildProcess[] = [];
  let jobsDir = "";
  const h = harness(t, {
    controller: () => {
      chmodSync(jobsDir, 0o500); // the next save fails
      const child = spawnProcess("sleep", ["300"], { detached: true, stdio: "ignore" });
      children.push(child);
      return child;
    },
  });
  jobsDir = join(h.root, "reviews", "jobs");
  t.after(() => {
    for (const child of children) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }
  });
  try {
    await h.jobs.dispatch(h.command());
  } finally {
    chmodSync(jobsDir, 0o700); // before the harness removes its directory
  }
  const done = await settled(h, "srj_00000001");
  assert.equal(done.state, "failed");
  assert.match(done.reason ?? "", /ended without a result/);
  const [child] = children;
  if (child!.exitCode === null && child!.signalCode === null) await once(child!, "exit");
  assert.equal(child!.signalCode, "SIGKILL", "the unrecorded controller was stopped");
});

test("a rebase before any valid round starts a new epoch instead of charging the old round", posixOnly, async (t) => {
  const OTHER = "c".repeat(40);
  const seed = (h: Harness) => {
    const prDir = join(h.root, ...PR_DIR);
    mkdirSync(prDir, { recursive: true });
    writeFileSync(join(prDir, "attempts.json"), JSON.stringify({
      epoch: 1, attempts: [1, 2].map((attempt) => ({
        epoch: 1, round: 1, attempt, dir: join(prDir, `e1-r1-a${attempt}`), head: HEAD, valid: false, consumed: true,
      })),
    }));
  };
  const rebased = harness(t, { pr: { headSha: OTHER }, notAncestor: true });
  seed(rebased);
  await rebased.jobs.dispatch(rebased.command({ headSha: OTHER }));
  const done = await settled(rebased, "srj_00000001");
  assert.equal(done.state, "completed");
  assert.equal(done.round, 1);
  assert.equal(done.attempt, 1);
  const args = rebased.spawned[0]!.args;
  assert.match(args[args.indexOf("--attempt-dir") + 1]!, /e2-r1-a1$/u);
  const mergeBase = rebased.execs.find((call) => call.includes("merge-base"))!;
  assert.deepEqual(mergeBase.slice(-2), [HEAD, OTHER], "the reference is the most recent attempt's head");

  // A descendant head stays in the epoch, whose round has used its attempts.
  const descendant = harness(t, { pr: { headSha: OTHER } });
  seed(descendant);
  await descendant.jobs.dispatch(descendant.command({ headSha: OTHER }));
  const refused = await settled(descendant, "srj_00000001");
  assert.equal(refused.state, "not_launched");
  assert.match(refused.reason ?? "", /used its attempts/);
});
