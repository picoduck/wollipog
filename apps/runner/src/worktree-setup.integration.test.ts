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
import { WorktreeCleanupJournal } from "./worktree.js";

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
  await assert.rejects(
    manager.selectWorktree("s_setup", failed!.path),
    /must be retried before selection/u,
    "selection never becomes an implicit long-running setup retry",
  );

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
  const durable = store.readMeta("s_start_setup");
  assert.equal(durable?.worktreeHooks?.[durable.worktrees?.[0]?.id ?? ""]?.environment.PROJECT_MODE, "isolated",
    "runner-private exact config survives deletion for teardown");
  assert.equal(JSON.stringify(manager.snapshot(durable!)).includes('"isolated"'), false,
    "approved environment literals are never projected to the control plane");

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
    teardown: [{
      name: "Must Not Teardown",
      command: [process.execPath, "-e", "require('fs').writeFileSync(process.env.WOLLIPOG_PRIMARY_CHECKOUT+'/.declined-teardown','bad')"],
      timeoutSeconds: 10,
    }],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "setup config"]);

  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_decline_setup", repo);
  const sent: RunnerToControlPlane[] = [];
  let launchEnvironment: Record<string, string> | undefined;
  const factory = (_driver: unknown, options: { env: Record<string, string> }) => {
    launchEnvironment = options.env;
    return {
      pid: 1,
      initialize: async () => {}, newSession: async () => {}, prompt: async () => "end_turn" as const,
      cancel: () => {}, close: async () => {}, dispose: () => {}, setConfig: () => {},
      resolvePermission: () => false, agentSessionId: () => "provider-session",
    };
  };
  let manager!: SessionManager;
  manager = new SessionManager((message) => {
    sent.push(message);
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") {
      setImmediate(() => manager.resolvePermission("s_decline_setup", message.payload.requestId, "skip"));
    }
  }, () => {}, store, "runner", undefined, factory as never, dataDir);
  t.after(() => manager.shutdownAll());

  const created = await manager.requestWorktree("s_decline_setup", { baseRef: "HEAD", branch: "fix/setup-declined" });
  assert.equal(created.worktree.setup?.status, "declined");
  assert.equal(existsSync(join(created.worktree.path, ".env.local")), false);
  assert.equal(existsSync(join(created.worktree.path, ".ran")), false);
  assert.ok(sent.some((message) => message.type === "session_event" && message.payload.kind === "stderr" &&
    message.payload.text.includes("created without copy, environment, or setup hooks")));
  assert.equal(await manager.start({
    sessionId: "s_decline_setup", workspaceId: "repo", workspacePath: repo, agentId: "codex",
    command: process.execPath, args: [], env: {}, useWorktree: true, driver: "codex",
    context: { kind: "native" },
  }), true);
  assert.equal(launchEnvironment?.DECLINED_VALUE, undefined);
  assert.equal(launchEnvironment?.WOLLIPOG_PORT_BLOCK_START, "42000",
    "declining repo hooks does not suppress the runner-owned port identity");
  await manager.delete("s_decline_setup");
  assert.equal(existsSync(join(repo, ".declined-teardown")), false, "declined hooks never run during cleanup");
});

test("dismissed trust stays retryable and never becomes a durable decline", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-dismiss-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    setup: [{ name: "Prepare", command: [process.execPath, "-e", "require('fs').writeFileSync('.prepared','yes')"], timeoutSeconds: 10 }],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "setup config"]);

  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_dismiss_setup", repo);
  let manager!: SessionManager;
  let requests = 0;
  manager = new SessionManager((message) => {
    if (message.type !== "session_event" || message.payload.kind !== "permission_request" ||
        message.payload.context?.toolName !== "wollipog.worktree_setup") return;
    requests++;
    setImmediate(() => manager.resolvePermission(
      "s_dismiss_setup", message.payload.requestId, requests === 1 ? null : "trust",
    ));
  }, () => {}, store, "runner", undefined, undefined, dataDir);
  t.after(() => manager.shutdownAll());

  await assert.rejects(
    manager.requestWorktree("s_dismiss_setup", { baseRef: "HEAD", branch: "fix/setup-dismissed" }),
    /required worktree setup failed/u,
  );
  const failed = store.readMeta("s_dismiss_setup")?.worktrees?.find((item) => item.branch === "fix/setup-dismissed");
  assert.equal(failed?.setup?.status, "failed");
  assert.match(failed?.setup?.error ?? "", /dismissed/u);
  await manager.retryWorktreeSetup("s_dismiss_setup", failed!.path);
  assert.equal(requests, 2, "dismissal neither grants trust nor persists a decline");
  assert.equal(readFileSync(join(failed!.path, ".prepared"), "utf8"), "yes");
});

test("setup environment is bound to the exact selected worktree", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-switch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_switch_setup", repo);
  let manager!: SessionManager;
  let launch: { cwd: string; env: Record<string, string> } | undefined;
  const factory = (_driver: unknown, options: { cwd: string; env: Record<string, string> }) => {
    launch = options;
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
      setImmediate(() => manager.resolvePermission("s_switch_setup", message.payload.requestId, "trust"));
    }
  }, () => {}, store, "runner", undefined, factory as never, dataDir);
  t.after(() => manager.shutdownAll());

  const legacy = await manager.requestWorktree("s_switch_setup", { baseRef: "HEAD", branch: "fix/setup-legacy" });
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    environment: { CONFIGURED_PATH: "${WOLLIPOG_WORKTREE_PATH}" },
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "add setup config"]);
  const configured = await manager.requestWorktree("s_switch_setup", { baseRef: "HEAD", branch: "fix/setup-configured" });
  assert.equal(configured.worktree.setup?.status, "completed");
  await manager.selectWorktree("s_switch_setup", legacy.worktree.path);
  assert.equal(await manager.start({
    sessionId: "s_switch_setup", workspaceId: "repo", workspacePath: repo, agentId: "codex",
    command: process.execPath, args: [], env: {}, useWorktree: true, driver: "codex",
    context: { kind: "native" },
  }), true);
  assert.equal(launch?.cwd, legacy.worktree.path);
  assert.equal(launch?.env.CONFIGURED_PATH, undefined);
  assert.equal(launch?.env.WOLLIPOG_WORKTREE_PATH, legacy.worktree.path,
    "runner-owned port/path variables apply even without repository hooks");
  assert.equal(launch?.env.WOLLIPOG_PORT_BLOCK_START, String(legacy.worktree.portBlock?.start));
});

test("successful setup retry preserves a forked provider thread and restores idle", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-fork-retry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  const failOnce = "const fs=require('fs');const f=process.env.WOLLIPOG_PRIMARY_CHECKOUT+'/.fork-retry';if(!fs.existsSync(f)){fs.writeFileSync(f,'1');process.exit(9)}";
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    setup: [{ name: "Prepare Fork", command: [process.execPath, "-e", failOnce], timeoutSeconds: 10 }],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "setup config"]);

  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_fork_retry", repo);
  let manager!: SessionManager;
  manager = new SessionManager((message) => {
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") {
      setImmediate(() => manager.resolvePermission("s_fork_retry", message.payload.requestId, "trust"));
    }
  }, () => {}, store, "runner", undefined, undefined, dataDir);
  t.after(() => manager.shutdownAll());

  await assert.rejects(
    manager.requestWorktree("s_fork_retry", { baseRef: "HEAD", branch: "fix/fork-retry" }),
    /required worktree setup failed/u,
  );
  const failed = store.readMeta("s_fork_retry")?.worktrees?.find((item) => item.branch === "fix/fork-retry");
  store.patchMeta("s_fork_retry", {
    status: "failed",
    agentSessionId: "forked-provider-thread",
  });
  const retried = await manager.retryWorktreeSetup("s_fork_retry", failed!.path);
  assert.equal(retried.snapshot.status, "idle");
  assert.equal(store.readMeta("s_fork_retry")?.agentSessionId, "forked-provider-thread");
});

test("cancelling a setup retry leaves the interrupted step retryable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-retry-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  const script = [
    "const fs=require('fs')",
    "const f=process.env.WOLLIPOG_PRIMARY_CHECKOUT+'/.retry-count'",
    "const n=Number(fs.existsSync(f)?fs.readFileSync(f,'utf8'):0)+1",
    "fs.writeFileSync(f,String(n))",
    "if(n===1)process.exit(9)",
    "if(n===2){console.log('retry-running');setTimeout(()=>{},60_000)}",
    "if(n>2)fs.writeFileSync('.retry-complete','yes')",
  ].join(";");
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    setup: [{ name: "Retryable Step", command: [process.execPath, "-e", script], timeoutSeconds: 60 }],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "setup config"]);

  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_retry_cancel", repo);
  let manager!: SessionManager;
  let cancelled = false;
  manager = new SessionManager((message) => {
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") {
      setImmediate(() => manager.resolvePermission("s_retry_cancel", message.payload.requestId, "trust"));
    }
    if (!cancelled && message.type === "session_event" && message.payload.kind === "command_output" &&
        message.payload.text.endsWith("\nretry-running\n")) {
      cancelled = true;
      setImmediate(() => manager.cancel("s_retry_cancel"));
    }
  }, () => {}, store, "runner", undefined, undefined, dataDir);
  t.after(() => manager.shutdownAll());

  await assert.rejects(
    manager.requestWorktree("s_retry_cancel", { baseRef: "HEAD", branch: "fix/retry-cancel" }),
    /required worktree setup failed/u,
  );
  const worktreePath = store.readMeta("s_retry_cancel")?.worktrees?.find((item) => item.branch === "fix/retry-cancel")?.path;
  await assert.rejects(manager.retryWorktreeSetup("s_retry_cancel", worktreePath!), /cancelled/u);
  const cancelledState = store.readMeta("s_retry_cancel")?.worktrees?.find((item) => item.path === worktreePath)?.setup;
  assert.equal(cancelledState?.status, "failed");
  assert.equal(cancelledState?.steps[0]?.status, "failed");
  assert.match(cancelledState?.error ?? "", /cancelled/u);
  const completed = await manager.retryWorktreeSetup("s_retry_cancel", worktreePath!);
  assert.equal(completed.worktree.setup?.status, "completed");
  assert.equal(readFileSync(join(worktreePath!, ".retry-complete"), "utf8"), "yes");
});

test("stopping while trust is pending cancels instead of persisting a decline and re-prompts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-trust-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    environment: { PROJECT_MODE: "trusted" },
    setup: [],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "setup config"]);

  const store = new SessionStore(join(dataDir, "sessions"));
  let manager!: SessionManager;
  let trustRequests = 0;
  const factory = () => ({
    pid: 1,
    initialize: async () => {}, newSession: async () => {}, prompt: async () => "end_turn" as const,
    cancel: () => {}, close: async () => {}, dispose: () => {}, setConfig: () => {},
    resolvePermission: () => false, agentSessionId: () => "provider-session",
  });
  manager = new SessionManager((message) => {
    if (message.type !== "session_event" || message.payload.kind !== "permission_request" ||
        message.payload.context?.toolName !== "wollipog.worktree_setup") return;
    trustRequests++;
    if (trustRequests === 1) setImmediate(() => manager.cancel("s_cancel_trust"));
    else setImmediate(() => manager.resolvePermission("s_cancel_trust", message.payload.requestId, "trust"));
  }, () => {}, store, "runner", undefined, factory as never, dataDir);
  t.after(() => manager.shutdownAll());
  const spec = {
    sessionId: "s_cancel_trust", workspaceId: "repo", workspacePath: repo, agentId: "codex",
    command: process.execPath, args: [] as string[], env: {}, useWorktree: true, driver: "codex" as const,
    context: { kind: "native" as const },
  };
  assert.equal(await manager.start(spec), false);
  assert.equal(store.readMeta("s_cancel_trust")?.status, "stopped");
  assert.equal(store.readMeta("s_cancel_trust")?.worktrees?.some((worktree) => worktree.setup?.status === "declined") ?? false, false);

  assert.equal(await manager.start(spec), true);
  assert.equal(trustRequests, 2, "a cancellation does not become durable trust or decline");
});

test("stopping a running initial setup kills the step and cannot overwrite stopped state", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-run-cancel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  const lateMarker = join(repo, ".late-setup-write");
  const delayedWrite = `console.log('setup-running');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(lateMarker)},'late'),300)`;
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    setup: [{ name: "Long Setup", command: [process.execPath, "-e", delayedWrite], timeoutSeconds: 60 }],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "setup config"]);

  const store = new SessionStore(join(dataDir, "sessions"));
  let manager!: SessionManager;
  let cancelled = false;
  manager = new SessionManager((message) => {
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") {
      setImmediate(() => manager.resolvePermission("s_cancel_running", message.payload.requestId, "trust"));
    }
    if (!cancelled && message.type === "session_event" && message.payload.kind === "command_output" &&
        message.payload.text.includes("setup-running")) {
      cancelled = true;
      setImmediate(() => manager.cancel("s_cancel_running"));
    }
  }, () => {}, store, "runner", undefined, undefined, dataDir);
  t.after(() => manager.shutdownAll());

  assert.equal(await manager.start({
    sessionId: "s_cancel_running", workspaceId: "repo", workspacePath: repo, agentId: "codex",
    command: process.execPath, args: [], env: {}, useWorktree: true, driver: "codex",
    context: { kind: "native" },
  }), false);
  assert.equal(cancelled, true);
  assert.equal(store.readMeta("s_cancel_running")?.status, "stopped");
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  assert.equal(existsSync(lateMarker), false, "the cancelled setup process cannot keep writing");
  assert.equal(store.readMeta("s_cancel_running")?.status, "stopped", "a stale setup continuation cannot report failure");
});

test("deleting during setup waits for the child to close before reclaiming the worktree", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-delete-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  const lateMarker = join(repo, ".deleted-setup-write");
  const delayedWrite = `console.log('delete-setup-running');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(lateMarker)},'late'),300)`;
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    setup: [{ name: "Long Setup", command: [process.execPath, "-e", delayedWrite], timeoutSeconds: 60 }],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "setup config"]);

  const store = new SessionStore(join(dataDir, "sessions"));
  let manager!: SessionManager;
  let deletion: Promise<void> | undefined;
  manager = new SessionManager((message) => {
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") {
      setImmediate(() => manager.resolvePermission("s_delete_running", message.payload.requestId, "trust"));
    }
    if (!deletion && message.type === "session_event" && message.payload.kind === "command_output" &&
        message.payload.text.includes("delete-setup-running")) {
      deletion = manager.delete("s_delete_running");
    }
  }, () => {}, store, "runner", undefined, undefined, dataDir);
  t.after(() => manager.shutdownAll());

  assert.equal(await manager.start({
    sessionId: "s_delete_running", workspaceId: "repo", workspacePath: repo, agentId: "codex",
    command: process.execPath, args: [], env: {}, useWorktree: true, driver: "codex",
    context: { kind: "native" },
  }), false);
  assert.ok(deletion);
  await deletion;
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  assert.equal(existsSync(lateMarker), false, "the deleted setup process cannot write after cleanup");
  assert.equal(store.has("s_delete_running"), false);
});

test("a pre-v141 worktree with baseCommit never discovers setup retroactively", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    environment: { RETROACTIVE_VALUE: "must-not-apply" },
    setup: [{ name: "Must Not Run", command: [process.execPath, "-e", "require('fs').writeFileSync('.retroactive','bad')"], timeoutSeconds: 10 }],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "config predating feature"]);
  const baseCommit = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
  const worktreePath = join(root, "legacy-worktree");
  await exec("git", ["-C", repo, "worktree", "add", "-qb", "agent/legacy", worktreePath, baseCommit]);

  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_legacy_setup", repo);
  store.patchMeta("s_legacy_setup", {
    worktreePath,
    worktreeBranch: "agent/legacy",
    worktrees: [{
      id: "legacy-existing", path: worktreePath, branch: "agent/legacy", baseRef: "HEAD", baseCommit, source: "created",
    }],
  });
  let trustRequests = 0;
  let launchEnvironment: Record<string, string> | undefined;
  const manager = new SessionManager((message) => {
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") trustRequests++;
  }, () => {}, store, "runner", undefined, ((_driver: unknown, options: { env: Record<string, string> }) => {
    launchEnvironment = options.env;
    return {
      pid: 1,
      initialize: async () => {}, newSession: async () => {}, prompt: async () => "end_turn" as const,
      cancel: () => {}, close: async () => {}, dispose: () => {}, setConfig: () => {},
      resolvePermission: () => false, agentSessionId: () => "provider-session",
    };
  }) as never, dataDir);
  t.after(() => manager.shutdownAll());

  assert.equal(await manager.start({
    sessionId: "s_legacy_setup", workspaceId: "repo", workspacePath: repo, agentId: "codex",
    command: process.execPath, args: [], env: {}, useWorktree: true, driver: "codex",
    context: { kind: "native" },
  }), true);
  assert.equal(trustRequests, 0);
  assert.equal(launchEnvironment?.RETROACTIVE_VALUE, undefined);
  assert.equal(existsSync(join(worktreePath, ".retroactive")), false);
});

test("session deletion retires provider and terminals before frozen teardown, then releases ports", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-teardown-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  const orderFile = join(repo, "teardown-order.txt");
  const first = [
    "const fs=require('fs')",
    "const f=process.env.ORDER_FILE",
    "const prior=fs.readFileSync(f,'utf8')",
    "if(prior!=='provider\\nshell\\n')throw new Error('processes still live: '+JSON.stringify(prior))",
    "fs.appendFileSync(f,'first\\n')",
    "process.stdout.write('first stdout')",
    "process.stderr.write('first stderr')",
    "process.exit(7)",
  ].join(";");
  const last = [
    "const fs=require('fs')",
    "fs.appendFileSync(process.env.ORDER_FILE,'last:'+process.env.WOLLIPOG_PORT_BLOCK_START+'-'+process.env.WOLLIPOG_PORT_BLOCK_END+'\\n')",
    "process.stdout.write('last stdout')",
  ].join(";");
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    environment: { ORDER_FILE: "${WOLLIPOG_PRIMARY_CHECKOUT}/teardown-order.txt" },
    setup: [],
    teardown: [
      { name: "Fail After Proof", command: [process.execPath, "-e", first], timeoutSeconds: 10 },
      { name: "Release Last", command: [process.execPath, "-e", last], timeoutSeconds: 10 },
    ],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "teardown config"]);

  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_teardown", repo);
  let manager!: SessionManager;
  let launchEnvironment: Record<string, string> | undefined;
  const factory = (_driver: unknown, options: { env: Record<string, string> }) => {
    launchEnvironment = options.env;
    return {
      pid: 1,
      initialize: async () => {}, newSession: async () => {}, prompt: async () => "end_turn" as const,
      cancel: () => {},
      close: async () => { writeFileSync(orderFile, "provider\n", "utf8"); },
      dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
      agentSessionId: () => "provider-session",
    };
  };
  manager = new SessionManager((message) => {
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") {
      const review = JSON.parse(String(message.payload.context.input)) as { teardown: Array<{ name: string }> };
      assert.deepEqual(review.teardown.map((step) => step.name), ["Fail After Proof", "Release Last"]);
      setImmediate(() => manager.resolvePermission("s_teardown", message.payload.requestId, "trust"));
    }
  }, () => {}, store, "runner", undefined, factory as never, dataDir);
  manager.setWorktreeShellRetirement(async () => {
    assert.equal(readFileSync(orderFile, "utf8"), "provider\n");
    writeFileSync(orderFile, "provider\nshell\n", "utf8");
  });
  t.after(() => manager.shutdownAll());

  const created = await manager.requestWorktree("s_teardown", { baseRef: "HEAD", branch: "fix/teardown" });
  assert.deepEqual(created.worktree.portBlock, { start: 42_000, end: 42_019, size: 20 });
  assert.equal(store.readMeta("s_teardown")?.worktreeHooks?.[created.worktree.id]?.teardown.length, 2,
    "exact trusted teardown is durable before cleanup");
  const processMarker = store.readMeta("s_teardown")?.worktreeProcessMarkers?.[created.worktree.id];
  assert.match(processMarker ?? "", /^[0-9a-f-]{36}$/u,
    "runner-private descendant ownership is durable before provider launch");
  assert.equal(await manager.start({
    sessionId: "s_teardown", workspaceId: "repo", workspacePath: repo, agentId: "codex",
    command: process.execPath, args: [], env: {}, useWorktree: true, driver: "codex",
    context: { kind: "native" },
  }), true);
  assert.equal(store.readMeta("s_teardown")?.worktreeProcessMarkers?.[created.worktree.id], processMarker,
    "provider launch reuses the worktree's durable process marker");
  assert.equal(launchEnvironment?.WOLLIPOG_PORT_BLOCK_START, "42000");
  assert.equal(launchEnvironment?.WOLLIPOG_PORT_BLOCK_END, "42019");

  writeFileSync(join(created.worktree.path, ".wollipog.json"), JSON.stringify({
    version: 1,
    teardown: [{
      name: "Mutable Evil",
      command: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(join(repo, "evil.txt"))},'bad')`],
    }],
  }), "utf8");
  await manager.delete("s_teardown");

  assert.equal(existsSync(created.worktree.path), false, "teardown failure does not block force removal");
  assert.equal(existsSync(join(repo, "evil.txt")), false, "mutable worktree config is never reread");
  assert.equal(readFileSync(orderFile, "utf8"), "provider\nshell\nfirst\nlast:42000-42019\n");
  const receipt = new WorktreeCleanupJournal(dataDir).history()
    .find((entry) => entry.sessionId === "s_teardown" && entry.worktreeId === created.worktree.id);
  assert.equal(receipt?.processMarker, processMarker);
  assert.equal(receipt?.trigger, "session_delete");
  assert.equal(receipt?.teardown?.status, "completed_with_failures");
  assert.deepEqual(receipt?.teardown?.steps.map((step) => step.status), ["failed", "completed"]);
  assert.equal(receipt?.teardown?.steps[0]?.stdout, "first stdout");
  assert.equal(receipt?.teardown?.steps[0]?.stderr, "first stderr");
  const allocations = JSON.parse(readFileSync(join(dataDir, "worktree-port-allocations.json"), "utf8")) as { allocations: unknown[] };
  assert.deepEqual(allocations.allocations, []);
});

test("an activation failure after absent-config discovery leaves no ghost worktree identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-activation-failure-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_activation_failure", repo);
  store.patchMeta("s_activation_failure", {
    providerHistoryBlock: {
      version: 1,
      reason: "oversized_tool_call",
      detectedAt: 1,
      detail: { field: "arguments" },
    },
  });
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
  t.after(() => manager.shutdownAll());

  await assert.rejects(
    manager.requestWorktree("s_activation_failure", { baseRef: "HEAD", branch: "fix/activation-failure" }),
    /quarantined/u,
  );
   assert.equal(store.readMeta("s_activation_failure")?.worktrees?.some((worktree) =>
     worktree.branch === "fix/activation-failure") ?? false, false,
   "status discovery cannot publish an identity for a worktree that cleanup removed");
 });

test("malformed setup is projected with its exact key and never reaches trust or execution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  writeFileSync(join(repo, ".wollipog.json"), JSON.stringify({
    version: 1,
    setup: [{ name: "Must Not Run", command: "touch .invalid-ran" }],
  }), "utf8");
  await exec("git", ["-C", repo, "add", ".wollipog.json"]);
  await exec("git", ["-C", repo, "commit", "-qm", "malformed setup config"]);

  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_invalid_setup", repo);
  let trustRequests = 0;
  const manager = new SessionManager((message) => {
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        message.payload.context?.toolName === "wollipog.worktree_setup") trustRequests++;
  }, () => {}, store, "runner", undefined, undefined, dataDir);
  t.after(() => manager.shutdownAll());

  await assert.rejects(
    manager.requestWorktree("s_invalid_setup", { baseRef: "HEAD", branch: "fix/invalid-setup" }),
    /\.wollipog\.json\.setup\[0\]\.command/u,
  );
  const retained = store.readMeta("s_invalid_setup")?.worktrees?.find((worktree) =>
    worktree.branch === "fix/invalid-setup");
  assert.equal(retained?.setupConfig?.status, "invalid");
  assert.match(retained?.setupConfig?.status === "invalid" ? retained.setupConfig.error : "",
    /\.wollipog\.json\.setup\[0\]\.command/u);
  assert.equal(trustRequests, 0);
  assert.equal(retained ? existsSync(join(retained.path, ".invalid-ran")) : false, false);
  await assert.rejects(
    manager.requestWorktree("s_invalid_setup", { baseRef: "HEAD", branch: "fix/invalid-setup" }),
    /\.wollipog\.json\.setup\[0\]\.command/u,
    "an idempotent create cannot bypass retained invalid configuration",
  );
  await assert.rejects(
    manager.selectWorktree("s_invalid_setup", retained!.path),
    /\.wollipog\.json\.setup\[0\]\.command/u,
    "selection cannot activate a retained invalid worktree",
  );
});

test("session generation targets only its active worktree and refreshes absent to valid", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-worktree-setup-generate-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = await repository(root);
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  meta(store, "s_generate_setup", repo);
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, undefined, dataDir);
  t.after(() => manager.shutdownAll());

  const created = await manager.requestWorktree(
    "s_generate_setup", { baseRef: "HEAD", branch: "fix/generate-setup" },
  );
  assert.deepEqual(created.worktree.setupConfig, { status: "absent" });
  const generated = await manager.generateWorktreeSetupConfig("s_generate_setup");
  assert.equal(generated.worktree.setupConfig?.status, "valid");
  assert.equal(generated.worktree.setup, undefined,
    "valid means the generated checkout file parses, not that setup ran retroactively");
  assert.equal(existsSync(join(generated.worktree.path, ".wollipog.json")), true);
  assert.equal(existsSync(join(repo, ".wollipog.json")), false, "the primary checkout stays untouched");
  assert.equal((await exec("git", ["-C", generated.worktree.path, "status", "--short", "--", ".wollipog.json"]))
    .stdout.trim(), "?? .wollipog.json");
});
