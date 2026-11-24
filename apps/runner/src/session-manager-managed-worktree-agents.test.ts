/** Agents a managed worktree's sandbox cannot run are refused before anything is lost (#4901), and a
 * worktree switch whose relaunch fails anyway leaves the session usable (#4902). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverCallbacks } from "./drivers/driver.js";
import { resolveExecutionIsolation } from "./execution-isolation.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore, type SessionMeta } from "./session-store.js";

const REFUSAL = /can't run in a managed worktree on this machine: .* Start the session In Place instead\./u;

function worktreeCount(repoPath: string): number {
  return execFileSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], { encoding: "utf8" })
    .split("\n").filter((line) => line.startsWith("worktree ")).length;
}

/** A provider-isolation Linux runner with one session running in place in a Git repository, which
 * also owns a runner-created worktree (`created`) it has not moved into. */
async function fixture(agent: { driver: SessionMeta["driver"]; agentId: string },
  options: { failRelaunch?: boolean; exitDuringRelaunch?: boolean; attached?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-managed-worktree-agents-")));
  const home = mkdtempSync(join(tmpdir(), "wollipog-managed-worktree-agents-home-"));
  const repoPath = join(root, "repo");
  const created = join(root, "created");
  execFileSync("git", ["init", "-q", repoPath]);
  execFileSync("git", ["-C", repoPath, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoPath, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repoPath, "commit", "-q", "--allow-empty", "-m", "base"]);
  execFileSync("git", ["-C", repoPath, "worktree", "add", "-q", "-b", "agent/s1", created]);
  const operatorCheckout = join(root, "operator");
  execFileSync("git", ["-C", repoPath, "worktree", "add", "-q", "-b", "operator", operatorCheckout]);
  const store = new SessionStore(join(root, "sessions"));
  store.create({
    sessionId: "s1", agentId: agent.agentId, workspaceId: "repo", repoPath, worktreePath: null,
    driver: agent.driver, command: "agent", args: [], env: { HOME: home }, context: { kind: "native" },
    agentSessionId: null, status: "starting", title: "s1", config: {}, tokensIn: 0, tokensOut: 0,
    costUsd: 0, preview: null, pendingApproval: null, seq: 0, createdAt: 1, updatedAt: 1,
    // An attached worktree is the operator's checkout, reattached as it is and never sandboxed.
    worktrees: [
      { id: "created", path: created, branch: "agent/s1", source: options.attached ? "attached" : "created" },
      { id: "operator", path: operatorCheckout, branch: "operator", source: "attached" },
    ],
  });
  const drivers: Array<{ disposed: boolean; cb: DriverCallbacks; cwd?: string }> = [];
  const statuses: string[] = [];
  const factory = (_driver: unknown, launch: { cwd?: string }, cb: DriverCallbacks) => {
    const driver = { disposed: false, cb, cwd: launch?.cwd };
    drivers.push(driver);
    const relaunch = drivers.length > 1;
    return {
      pid: drivers.length,
      initialize: async () => {
        // Failures nobody could predict before retiring the first process (#4902): a rejected
        // start, or the replacement process exiting during its handshake.
        if (relaunch && options.exitDuringRelaunch) {
          cb.onExit(1);
          throw new Error("agent process exited");
        }
        if (relaunch && options.failRelaunch) throw new Error("provider rejected the resume");
      },
      newSession: async () => "provider-1",
      prompt: async () => "end_turn" as const, cancel: () => {}, dispose: () => { driver.disposed = true; },
      setConfig: () => {}, resolvePermission: () => false, agentSessionId: () => "provider-1",
    };
  };
  const manager = new SessionManager(
    (message) => { if (message.type === "session_status" && message.sessionId === "s1") statuses.push(message.status); },
    () => {}, store, "runner", undefined, factory as never, join(root, "state"), 2,
    undefined, undefined, { agentLimits: {}, agentWeights: {} },
    { mode: "provider", network: "inherit" }, async (policy, context, _deps, state) =>
      resolveExecutionIsolation(policy, context, {
        platform: "linux", uid: () => 1000, nativeEnvironment: () => ({ HOME: home }),
        resolveNative: async () => ({ path: "/usr/bin/bwrap", via: "path", launch: { command: "/usr/bin/bwrap", args: [] } }),
      }, state),
    async () => {}, async () => {}, async () => {},
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = manager as any;
  internals.verifySelectedWorktreeBeforeLaunch = async () => true;
  return {
    root, repoPath, created, operatorCheckout, store, manager, internals, drivers, statuses,
    errors: () => store.readEvents("s1").filter((event) => event.payload.kind === "error")
      .map((event) => (event.payload as { message: string }).message),
    /** Launch in place, as a session that has not moved into a worktree yet runs. */
    launchInPlace: async () => {
      assert.equal(await internals.acquireAdmission("s1"), true);
      assert.equal(await internals.launch(store.readMeta("s1")), true);
    },
    cleanup: () => {
      manager.shutdownAll();
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("a generic ACP agent is refused a new or selected managed worktree before one is made or moved to (#4901)", async () => {
  if (process.platform !== "linux") return;
  const f = await fixture({ driver: "acp", agentId: "gemini-cli" });
  try {
    const before = worktreeCount(f.repoPath);
    await assert.rejects(f.manager.requestWorktree("s1", { baseRef: "HEAD", branch: "agent/second" }), REFUSAL);
    assert.equal(worktreeCount(f.repoPath), before, "no worktree is created for a launch that would be refused");
    await assert.rejects(f.manager.selectWorktree("s1", f.created), REFUSAL);
    assert.equal(f.store.readMeta("s1")?.worktreePath, null, "the session keeps working where it is");
  } finally {
    f.cleanup();
  }
});

test("Antigravity and drivers with a known state directory still get managed worktrees", async () => {
  if (process.platform !== "linux") return;
  for (const agent of [{ driver: "acp" as const, agentId: "google-antigravity" }, { driver: "claude-code" as const, agentId: "claude" }]) {
    const f = await fixture(agent);
    try {
      const made = await f.manager.requestWorktree("s1", { baseRef: "HEAD", branch: "agent/second" });
      assert.ok(existsSync(made.worktree.path), agent.agentId);
    } finally {
      f.cleanup();
    }
  }
});

test("starting a generic ACP session in a managed worktree is refused, published, and creates none (#4901)", async () => {
  if (process.platform !== "linux") return;
  const f = await fixture({ driver: "acp", agentId: "gemini-cli" });
  try {
    const before = worktreeCount(f.repoPath);
    // A plain start_session frame carries no durable lifecycle: the refusal must reach the
    // dashboard as the session's own status, or it would stay Starting.
    const started = await f.manager.start({
      sessionId: "s1", workspaceId: "repo", workspacePath: f.repoPath, agentId: "gemini-cli",
      driver: "acp", command: "gemini", args: ["--acp"], env: {}, useWorktree: true,
      title: "", titleSource: "generated", config: {},
    });
    assert.equal(started, false);
    assert.equal(worktreeCount(f.repoPath), before, "nothing is left behind");
    assert.equal(f.drivers.length, 0, "no provider is constructed");
    assert.equal(f.statuses.at(-1), "failed");
    assert.equal(f.store.readMeta("s1")?.worktreePending, false);
    assert.ok(f.errors().some((message) => REFUSAL.test(message)), f.errors().join("\n"));
  } finally {
    f.cleanup();
  }
});

test("restarting an ACP session whose selected worktree is attached starts there, unsandboxed", async () => {
  if (process.platform !== "linux") return;
  const f = await fixture({ driver: "acp", agentId: "gemini-cli" }, { attached: true });
  try {
    f.store.patchMeta("s1", { worktreePath: f.created, worktreeBranch: "agent/s1" });
    // The control plane's restart asks for a worktree whenever one is selected.
    const started = await f.manager.start({
      sessionId: "s1", workspaceId: "repo", workspacePath: f.repoPath, agentId: "gemini-cli",
      driver: "acp", command: "gemini", args: ["--acp"], env: {}, useWorktree: true,
      title: "", titleSource: "generated", config: {},
    });
    assert.equal(started, true, f.errors().join("\n"));
    assert.equal(f.drivers.length, 1);
    assert.equal(f.store.readMeta("s1")?.worktreePath, f.created);
    assert.ok(!f.errors().some((message) => REFUSAL.test(message)));
  } finally {
    f.cleanup();
  }
});

const restartSpec = (repoPath: string) => ({
  sessionId: "s1", workspaceId: "repo", workspacePath: repoPath, agentId: "gemini-cli",
  driver: "acp" as const, command: "gemini", args: ["--acp"], env: {}, useWorktree: true,
  title: "", titleSource: "generated" as const, config: {},
});

test("a refused restart keeps the session's selected runner-created worktree", async () => {
  if (process.platform !== "linux") return;
  const f = await fixture({ driver: "acp", agentId: "gemini-cli" });
  try {
    f.store.patchMeta("s1", { worktreePath: f.created, worktreeBranch: "agent/s1" });
    const before = worktreeCount(f.repoPath);
    assert.equal(await f.manager.start(restartSpec(f.repoPath)), false);
    assert.equal(f.statuses.at(-1), "failed");
    assert.equal(worktreeCount(f.repoPath), before);
    const meta = f.store.readMeta("s1");
    assert.equal(meta?.worktreePath, f.created, "Files and shells still open in its worktree, never the shared base");
    assert.equal(meta?.worktreeBranch, "agent/s1");
    assert.equal(meta?.worktreePending, false);
  } finally {
    f.cleanup();
  }
});

test("a restart follows a selection that moved to an attached checkout before its serialized write", async () => {
  if (process.platform !== "linux") return;
  const f = await fixture({ driver: "acp", agentId: "gemini-cli" });
  try {
    f.store.patchMeta("s1", { worktreePath: f.created, worktreeBranch: "agent/s1" });
    // An attach queued ahead of the restart's serialized write commits first: after the restart
    // read the session (and its runner-created selection), before its write refreshes that read.
    // For an existing session start() runs two worktree operations: the remap check, then (after
    // reading the session) the serialized write. The attach lands just ahead of the second.
    const runWorktreeOperation = f.internals.runWorktreeOperation.bind(f.internals);
    let calls = 0;
    let attached = false;
    f.internals.runWorktreeOperation = (sessionId: string, operation: () => Promise<unknown>) => {
      if (++calls === 2) {
        attached = true;
        f.store.patchMeta("s1", { worktreePath: f.operatorCheckout, worktreeBranch: "operator" });
      }
      return runWorktreeOperation(sessionId, operation);
    };
    const starting = f.manager.start(restartSpec(f.repoPath));
    assert.equal(await starting, true, f.errors().join("\n"));
    assert.equal(attached, true, "the attach landed inside the restart's window");
    assert.equal(f.store.readMeta("s1")?.worktreePath, f.operatorCheckout);
    assert.equal(f.drivers.length, 1);
  } finally {
    f.cleanup();
  }
});

test("an operator-configured agent that reuses Antigravity's id is refused like any other ACP agent", async () => {
  if (process.platform !== "linux") return;
  const f = await fixture({ driver: "acp", agentId: "google-antigravity" });
  try {
    f.manager.setConfiguredAgentIds(["google-antigravity"]);
    const before = worktreeCount(f.repoPath);
    await assert.rejects(f.manager.requestWorktree("s1", { baseRef: "HEAD", branch: "agent/second" }), REFUSAL);
    assert.equal(worktreeCount(f.repoPath), before);
  } finally {
    f.cleanup();
  }
});

test("a switch the new launch cannot run is refused before the running provider is retired (#4902)", async () => {
  if (process.platform !== "linux") return;
  const f = await fixture({ driver: "acp", agentId: "gemini-cli" });
  try {
    await f.launchInPlace();
    // What the in-place launch recorded: resume works there, which the switch must not trust.
    f.store.patchMeta("s1", { acpCapabilities: { sessionResume: true, loadSession: false } as never });
    // A selection recorded by a path that predates the refusal at selection time.
    f.store.patchMeta("s1", { worktreePath: f.created, worktreeBranch: "agent/s1" });
    const entry = f.internals.active.get("s1");
    entry.pendingWorktreeRebind = f.created;
    await f.internals.rebindSelectedWorktree("s1", entry);

    assert.equal(f.drivers.length, 1, "no replacement provider is launched");
    assert.equal(f.drivers[0]!.disposed, false, "the running provider keeps the conversation");
    assert.equal(f.internals.active.get("s1"), entry);
    assert.notEqual(f.store.readMeta("s1")?.status, "failed");
    assert.ok(f.errors().some((message) => message.startsWith("The session stays where it is.") && REFUSAL.test(message)),
      f.errors().join("\n"));
  } finally {
    f.cleanup();
  }
});

for (const [failure, option, evidence] of [
  ["rejects its start", { failRelaunch: true }, "provider rejected the resume"],
  ["exits during its handshake", { exitDuringRelaunch: true }, "agent process exited"],
] as const) {
  test(`a relaunch that ${failure} after a worktree switch leaves the session idle with the error, never Failed (#4902)`, async () => {
    if (process.platform !== "linux") return;
    const f = await fixture({ driver: "claude-code", agentId: "claude" }, option);
    try {
      await f.launchInPlace();
      f.internals.captureAgentSessionId("s1", f.internals.active.get("s1").client);
      await f.manager.selectWorktree("s1", f.created);
      const deadline = Date.now() + 5_000;
      while (f.drivers.length < 2 || f.internals.worktreeRebindings.has("s1")) {
        if (Date.now() > deadline) throw new Error("the relaunch did not finish");
        await new Promise((done) => setTimeout(done, 20));
      }
      assert.equal(f.store.readMeta("s1")?.status, "idle", "the next message or Restart can retry");
      assert.ok(!f.statuses.includes("failed"), `a terminal Failed was published: ${f.statuses.join(", ")}`);
      assert.ok(f.errors().some((message) => message.includes(evidence)), f.errors().join("\n"));
    } finally {
      f.cleanup();
    }
  });
}
