import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { RunnerToControlPlane } from "@wollipog/protocol";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

const exec = promisify(execFile);

async function repository(root: string): Promise<string> {
  const repo = join(root, "repo");
  await exec("git", ["init", "-q", repo]);
  await exec("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  await exec("git", ["-C", repo, "config", "user.name", "Wollipog Test"]);
  writeFileSync(join(repo, ".gitignore"), ".env.local\n", "utf8");
  writeFileSync(join(repo, "tracked.txt"), "base\n", "utf8");
  await exec("git", ["-C", repo, "add", ".gitignore", "tracked.txt"]);
  await exec("git", ["-C", repo, "commit", "-qm", "base"]);
  return repo;
}

function meta(store: SessionStore, sessionId: string, repo: string): void {
  store.create({
    sessionId, agentId: "codex", workspaceId: "repo", repoPath: repo,
    worktreePath: null, driver: "codex", command: process.execPath, args: [], env: {},
    context: { kind: "native" }, agentSessionId: null, status: "idle", title: "setup",
    config: {}, tokensIn: 0, tokensOut: 0, costUsd: 0, preview: null, pendingApproval: null,
    seq: 0, createdAt: 1, updatedAt: 1,
  });
}

test("requested worktree setup retains required failures, resumes, and re-prompts only for a changed hash", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  writeFileSync(join(repo, ".env.local"), "PRIVATE_VALUE=never-exported\n", "utf8");
  const failOnce = "const fs=require('fs');const f=process.env.WOLLIPOG_PRIMARY_CHECKOUT+'/.setup-attempt';if(!fs.existsSync(f)){fs.writeFileSync(f,'1');console.error('first attempt failed');process.exit(5)}console.log('retry completed')";
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    copyFiles: [{ source: ".env.local", destination: ".env.local" }],
    environment: { PROJECT_ROOT: "${WOLLIPOG_WORKTREE_PATH}" },
    setup: [
      { name: "Prepare Once", command: [process.execPath, "-e", failOnce], timeoutSeconds: 10 },
      { name: "Finish", command: [process.execPath, "-e", "require('fs').writeFileSync('.setup-done', process.env.PROJECT_ROOT)"], timeoutSeconds: 10 },
    ],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "setup config"]);

  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_setup", repo);
  const sent: RunnerToControlPlane[] = [];
  let manager!: SessionManager;
  let trustRequests = 0;
  manager = new SessionManager((message) => {
    sent.push(message);
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") {
      trustRequests++;
      const review = JSON.parse(String(message.payload.context.input)) as {
        copyFiles: Array<{ source: string; destination: string }>;
        setup: Array<{ name: string; command: string[] }>;
        environmentKeys: string[];
      };
      assert.deepEqual(review.copyFiles, [{ source: ".env.local", destination: ".env.local" }]);
      assert.deepEqual(review.setup.map((step) => [step.name, step.command]), [
        ["Prepare Once", [process.execPath, "-e", failOnce]],
        [trustRequests === 1 ? "Finish" : "Finish Changed", [process.execPath, "-e", "require('fs').writeFileSync('.setup-done', process.env.PROJECT_ROOT)"]],
      ]);
      assert.deepEqual(review.environmentKeys, ["PROJECT_ROOT"]);
      assert.equal(String(message.payload.context.input).includes("never-exported"), false);
      setImmediate(() => manager.resolvePermission("s_setup", message.payload.requestId, "trust"));
    }
  }, () => {}, store, "runner", undefined, undefined, dataDir);
  t.after(() => manager.shutdownAll());

  await assert.rejects(
    manager.requestWorktree("s_setup", { baseRef: "HEAD", branch: "fix/setup-failure" }),
    /required worktree setup failed/u,
  );
  const failed = store.readMeta("s_setup")?.worktrees?.find((worktree) => worktree.branch === "fix/setup-failure");
  assert.equal(failed?.setup?.status, "failed");
  assert.ok(failed && existsSync(failed.path), "failed setup retains its worktree");
  assert.equal(JSON.stringify(failed).includes("PRIVATE_VALUE"), false);

  const retried = await manager.retryWorktreeSetup("s_setup", failed!.path);
  assert.equal(retried.worktree.setup?.status, "completed");
  assert.equal(readFileSync(join(retried.worktree.path, ".setup-done"), "utf8"), retried.worktree.path);
  assert.equal((await exec("git", ["-C", retried.worktree.path, "status", "--porcelain", "--", ".env.local"])).stdout, "");

  await manager.requestWorktree("s_setup", { baseRef: "HEAD", branch: "fix/setup-trusted" });
  assert.equal(trustRequests, 1, "the same Project and config hash reuses durable trust");

  const changed = JSON.parse(readFileSync(join(repo, ".wollipog.json"), "utf8"));
  changed.setup[1].name = "Finish Changed";
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify(changed), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "change setup config"]);
  await manager.requestWorktree("s_setup", { baseRef: "HEAD", branch: "fix/setup-changed" });
  assert.equal(trustRequests, 2, "a changed config hash requests trust again");
  assert.ok(sent.some((message) => message.type === "session_event" && message.payload.kind === "command_output" &&
    /\[Worktree Setup — Finish(?: Changed)?\]\nCompleted \(Exit 0\) in \d+ ms/u.test(message.payload.text)),
  JSON.stringify(sent.flatMap((message) => message.type === "session_event" && message.payload.kind === "command_output"
    ? [message.payload.text] : [])));
});

test("new session setup finishes before provider launch and injects runner-owned variables", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-start-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    environment: { PROJECT_MODE: "isolated", PROJECT_ROOT: "${WOLLIPOG_WORKTREE_PATH}" },
    setup: [{ name: "Prepare", command: [process.execPath, "-e", "require('fs').writeFileSync('.setup-ready','yes')"], timeoutSeconds: 10 }],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "setup config"]);

  const store = new SessionStore(join(dataDir, "sessions"));
  let manager!: SessionManager;
  let launch: { cwd: string; env: Record<string, string> } | undefined;
  let trustRequests = 0;
  const factory = (_driver: unknown, options: { cwd: string; env: Record<string, string> }) => {
    launch = options;
    assert.equal(readFileSync(join(options.cwd, ".setup-ready"), "utf8"), "yes", "setup completed before provider construction");
    return {
      pid: 1,
      initialize: async () => {}, newSession: async () => {}, prompt: async () => "end_turn" as const,
      cancel: () => {}, close: async () => {}, dispose: () => {}, setConfig: () => {},
      resolvePermission: () => false, agentSessionId: () => "provider-session",
    };
  };
  manager = new SessionManager((message) => {
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") {
      trustRequests++;
      setImmediate(() => manager.resolvePermission("s_start_setup", message.payload.requestId, "trust"));
    }
  }, () => {}, store, "runner", undefined, factory as never, dataDir);
  t.after(() => manager.shutdownAll());
  const started = await manager.start({
    sessionId: "s_start_setup", workspaceId: "repo", workspacePath: repo, agentId: "codex",
    command: process.execPath, args: [], env: {}, useWorktree: true, driver: "codex",
    context: { kind: "native" },
  });
  assert.equal(started, true);
  assert.ok(launch);
  assert.equal(launch.env.PROJECT_MODE, "isolated");
  assert.equal(launch.env.PROJECT_ROOT, launch.cwd);
  assert.equal(launch.env.WOLLIPOG_WORKTREE_PATH, launch.cwd);
  assert.equal(JSON.stringify(store.readMeta("s_start_setup")).includes('"isolated"'), false,
    "setup environment values never persist in session metadata");

  manager.stop("s_start_setup");
  await new Promise((resolveStop) => setImmediate(resolveStop));
  manager.shutdownAll();
  launch = undefined;
  const restartLogs: string[] = [];
  manager = new SessionManager((message) => {
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") {
      trustRequests++;
      setImmediate(() => manager.resolvePermission("s_start_setup", message.payload.requestId, "trust"));
    }
  }, (line) => restartLogs.push(line), store, "runner-restarted", undefined, factory as never, dataDir);
  const restarted = await manager.start({
    sessionId: "s_start_setup", workspaceId: "repo", workspacePath: repo, agentId: "codex",
    command: process.execPath, args: [], env: {}, useWorktree: true, driver: "codex",
    context: { kind: "native" },
  });
  assert.equal(restarted, true, `${restartLogs.join("\n")}\n${JSON.stringify(store.readMeta("s_start_setup"))}`);
  assert.equal(launch?.env.PROJECT_MODE, "isolated", "a runner restart rehydrates setup environment from the approved config");
  assert.equal(trustRequests, 1, "rehydration neither reruns setup nor requests trust again");
});

test("declining setup retains the worktree while applying no copies, environment, or commands", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-decline-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  writeFileSync(join(repo, ".env.local"), "PRIVATE_VALUE=must-not-copy\n", "utf8");
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    copyFiles: [{ source: ".env.local", destination: ".env.local" }],
    environment: { DECLINED_VALUE: "must-not-inject" },
    setup: [{ name: "Must Not Run", command: [process.execPath, "-e", "require('fs').writeFileSync('.ran','bad')"], timeoutSeconds: 10 }],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "setup config"]);

  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_decline_setup", repo);
  const sent: RunnerToControlPlane[] = [];
  let manager!: SessionManager;
  manager = new SessionManager((message) => {
    sent.push(message);
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") {
      setImmediate(() => manager.resolvePermission("s_decline_setup", message.payload.requestId, "skip"));
    }
  }, () => {}, store, "runner", undefined, undefined, dataDir);
  t.after(() => manager.shutdownAll());

  const created = await manager.requestWorktree("s_decline_setup", { baseRef: "HEAD", branch: "fix/setup-declined" });
  assert.equal(created.worktree.setup?.status, "declined");
  assert.equal(existsSync(join(created.worktree.path, ".env.local")), false);
  assert.equal(existsSync(join(created.worktree.path, ".ran")), false);
  assert.ok(sent.some((message) => message.type === "session_event" && message.payload.kind === "stderr" &&
    message.payload.text.includes("created without copy, environment, or setup hooks")));
});
