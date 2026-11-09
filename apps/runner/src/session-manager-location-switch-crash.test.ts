import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { SessionLaunchSpec, SessionLocationSwitchMessage } from "@wollipog/protocol";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeProjectPathKey } from "./claude-background-work.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { parseWorktreePorcelain, recoveredBranchPlacement, type WorktreeCleanupRecord } from "./worktree.js";

// #4209: a runner that really dies during a Location switch's setup leaves what a restart needs in
// order to reap it. This file re-executes itself as that runner, so SIGKILL ends a real process
// with no chance to tidy up, and the survivor is a new process's view of what it left.

const SESSION = "s_switch_crash";
const FIXTURE_ROOT = process.env.WOLLIPOG_SWITCH_CRASH_ROOT;

const git = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
  "-C", cwd, ...args,
], { encoding: "utf8" }).trim();

async function waitFor(predicate: () => boolean, message: string, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function fakeProvider() {
  const providers: Array<{ cwd: string; env: Record<string, string> | undefined; prompts: string[] }> = [];
  const factory = (_driver: unknown, launch: { cwd: string; env?: Record<string, string> }, cb: {
    onPromptAccepted?: () => void;
    onEvent: (event: unknown) => void;
  }) => {
    const provider = { cwd: launch.cwd, env: launch.env, prompts: [] as string[] };
    providers.push(provider);
    return {
      pid: providers.length, newSession: async () => {}, close: async () => {}, initialize: async () => {},
      prompt: async (text: string) => {
        provider.prompts.push(text);
        cb.onPromptAccepted?.();
        cb.onEvent({ kind: "agent_message", text: "done", final: true });
        return "end_turn" as const;
      },
      cancel: () => {}, dispose: () => {}, setConfig: () => {}, resolvePermission: () => false,
      agentSessionId: () => "provider-session-id",
    };
  };
  return { factory, providers };
}

const spec = (app: string): SessionLaunchSpec => ({ sessionId: SESSION, workspaceId: "app", workspacePath: app, agentId: "claude-code",
  command: "claude-code", args: [], env: {}, useWorktree: false, driver: "claude-code", context: { kind: "native" } });

const locations = (app: string, docs: string) => [{ id: "app", name: "App", path: app }, { id: "docs", name: "Docs", path: docs }];

const switchMessage = (docs: string): SessionLocationSwitchMessage => ({
  type: "session_location_switch", requestId: "request-1", sessionId: SESSION, workspaceId: "docs", workspacePath: docs,
  repository: "acme/docs", locationName: "Docs", occurrenceId: "occurrence-1", continuation: "Continue the docs fix here.",
  recoverBranch: "fix/install-link",
});

/** The doomed runner: it works through a real switch, trusts the setup, and stays until killed. */
async function runDoomedRunner(root: string): Promise<void> {
  const app = realpathSync(join(root, "app"));
  const docs = realpathSync(join(root, "docs"));
  const fake = fakeProvider();
  const store = new SessionStore(join(root, "data", "sessions"));
  let manager!: SessionManager;
  manager = new SessionManager((message) => {
    if (message.type === "session_event" && message.payload.kind === "permission_request" &&
        !process.env.WOLLIPOG_SWITCH_CRASH_LEAVE_CARD_OPEN) {
      const { requestId } = message.payload;
      setImmediate(() => manager.resolvePermission(SESSION, requestId, "trust"));
    }
  }, () => {}, store, "runner", undefined, fake.factory as never, join(root, "data"), 2);
  manager.configureSharedDirectories(locations(app, docs) as never);
  await manager.start(spec(app));
  manager.prompt(SESSION, "start the task");
  await waitFor(() => fake.providers[0]?.prompts.length === 1 && store.readMeta(SESSION)?.status === "idle", "the first turn did not finish");
  const projects = join(root, "claude-home", "projects", claudeProjectPathKey(app));
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, "provider-session-id.jsonl"), "{\"type\":\"user\"}\n");
  const accepted = await manager.requestLocationSwitch(switchMessage(docs));
  assert.deepEqual(accepted, { ok: true });
  setInterval(() => {}, 1000);
}

interface Crashed {
  root: string;
  app: string;
  docs: string;
  target: string;
  setupPid: number;
  runner: () => { manager: SessionManager; store: SessionStore; providers: ReturnType<typeof fakeProvider>["providers"]; journal: () => WorktreeCleanupRecord[] };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Start a runner, let its switch reach a running setup step (or, with `atTrustCard`, the trust card
 * that comes first), and SIGKILL it there. */
async function withCrashDuringSetup(
  name: string,
  body: (crashed: Crashed) => Promise<void>,
  { atTrustCard = false }: { atTrustCard?: boolean } = {},
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wollipog-switch-crash-${name}-`)));
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude-home");
  const managers: SessionManager[] = [];
  const pidFile = join(root, "setup-pid");
  let doomed: ChildProcess | undefined;
  let setupPid: number | undefined;
  try {
    for (const name of ["app", "docs"]) {
      mkdirSync(join(root, name));
      git(join(root, name), "init", "--quiet", "--initial-branch=main");
      git(join(root, name), "commit", "--quiet", "--allow-empty", "-m", "base");
      git(join(root, name), "remote", "add", "origin", `git@github.com:acme/${name}.git`);
    }
    const app = realpathSync(join(root, "app"));
    const docs = realpathSync(join(root, "docs"));
    git(docs, "checkout", "--quiet", "-b", "fix/install-link");
    // The step records its pid, then waits for a permission the second attempt finds in place.
    const step = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));` +
      `if(!fs.existsSync(${JSON.stringify(join(root, "let-it-pass"))}))setTimeout(()=>{},120000);`;
    writeFileSync(join(docs, ".wollipog.json"), JSON.stringify({
      version: 1,
      environment: { SWITCH_SETUP_VALUE: "from-setup" },
      setup: [{ name: "Long Step", command: [process.execPath, "-e", step], timeoutSeconds: 300 }],
      teardown: [{ name: "Clean Target", command: [process.execPath, "-e",
        `require('fs').appendFileSync(${JSON.stringify(join(root, "teardown-log"))},'x')`], timeoutSeconds: 30 }],
    }));
    git(docs, "add", ".wollipog.json");
    git(docs, "commit", "--quiet", "-m", "setup");
    git(docs, "checkout", "--quiet", "main");

    doomed = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url)], {
      stdio: "ignore",
      env: { ...process.env, WOLLIPOG_SWITCH_CRASH_ROOT: root, ...(atTrustCard ? { WOLLIPOG_SWITCH_CRASH_LEAVE_CARD_OPEN: "1" } : {}) },
    });
    if (atTrustCard) {
      const events = join(root, "data", "sessions", SESSION, "events.ndjson");
      await waitFor(() => existsSync(events) && readFileSync(events, "utf8").includes("Trust Worktree Setup Configuration?"),
        "the trust card never opened in the doomed runner", 5000);
    } else {
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").length > 0, "setup never started in the doomed runner", 5000);
      setupPid = Number(readFileSync(pidFile, "utf8"));
    }
    const exited = new Promise<void>((resolve) => doomed!.once("exit", () => resolve()));
    doomed.kill("SIGKILL");
    await exited;
    rmSync(pidFile, { force: true });

    const target = git(docs, "worktree", "list", "--porcelain").split("\n")
      .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length)).find((path) => path !== docs)!;
    assert.ok(target, "the crash left the target worktree registered");
    const lock = join(root, "data", "sessions", SESSION, "lock");
    if (existsSync(lock)) utimesSync(lock, new Date(0), new Date(0));

    await body({
      root, app, docs, target, setupPid: setupPid ?? -1,
      runner: () => {
        const fake = fakeProvider();
        const store = new SessionStore(join(root, "data", "sessions"));
        const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, join(root, "data"), 2);
        manager.configureSharedDirectories(locations(app, docs) as never);
        managers.push(manager);
        return { manager, store, providers: fake.providers,
          journal: () => (manager as unknown as { cleanupJournal: { list(): WorktreeCleanupRecord[] } }).cleanupJournal.list() };
      },
    });
  } finally {
    doomed?.kill("SIGKILL");
    if (setupPid !== undefined && alive(setupPid)) process.kill(setupPid, "SIGKILL");
    for (const manager of managers) manager.shutdownAll();
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    rmSync(root, { recursive: true, force: true });
  }
}

if (FIXTURE_ROOT) {
  void runDoomedRunner(FIXTURE_ROOT);
} else {
  test("a crash during setup is reaped at the next start: its process ends, its teardown runs, the worktree goes and the branch stays", async () => {
    if (process.platform === "win32") return;
    await withCrashDuringSetup("reaped", async (c) => {
      assert.equal(alive(c.setupPid), true, "setup's process outlived the runner, which is what has to be reaped");
      const { manager, store, providers, journal } = c.runner();

      // Everything needed was durable before the step ran.
      const [record] = journal();
      assert.equal(record?.worktreePath, c.target);
      assert.equal(record?.trigger, "creation_rollback");
      assert.equal(record?.preserveBranch, true);
      assert.ok(record?.processMarker, "the marker setup's processes carry");
      assert.equal(record?.hooks?.teardown[0]?.name, "Clean Target");
      assert.ok(record?.portBlock, "the port block to give back");
      assert.deepEqual(store.readMeta(SESSION)?.worktrees ?? [], [], "the old Location's records still do not name the target");

      // Before the reap, another session asking for that branch is refused, not handed the worktree.
      const internals = manager as unknown as {
        worktreeHolder: (sessionId: string, context: unknown, path: string) => { sessionId: string; removalPending?: boolean } | undefined;
      };
      const listed = parseWorktreePorcelain(git(c.docs, "worktree", "list", "--porcelain", "-z"));
      const placement = recoveredBranchPlacement({ kind: "native" }, listed, "fix/install-link", join(c.root, "other-slot"),
        (path) => internals.worktreeHolder("s_other", { kind: "native" }, path));
      assert.equal(placement.kind, "refuse");
      assert.match((placement as { reason: string }).reason, /which the runner is removing for session s_switch_crash/u);

      // The session is still in the app Location, so the teardown's boundary comes from the record.
      const isolation = manager as unknown as { resolveCleanupIsolation: (record: unknown, meta?: unknown) => Promise<unknown> };
      const resolveCleanupIsolation = isolation.resolveCleanupIsolation.bind(manager);
      const isolatedWith: unknown[] = [];
      isolation.resolveCleanupIsolation = (replayed, meta) => {
        isolatedWith.push(meta);
        return resolveCleanupIsolation(replayed, meta);
      };

      manager.reconcileStore();
      await waitFor(() => journal().length === 0, "the crash's rollback was not replayed", 3000);
      assert.deepEqual(isolatedWith, [undefined]);
      assert.equal(alive(c.setupPid), false, "setup's process was ended");
      assert.equal(readFileSync(join(c.root, "teardown-log"), "utf8"), "x", "its teardown ran once");
      assert.equal(existsSync(c.target), false, "the half-set-up worktree is gone");
      assert.ok(git(c.docs, "rev-parse", "--verify", "refs/heads/fix/install-link"), "the recovered branch stays");
      const allocator = (manager as unknown as { worktreePortAllocator: { get(owner: string): unknown } }).worktreePortAllocator;
      assert.equal(allocator.get(`${SESSION}\0${record!.worktreeId}`), undefined, "its port block is free again");

      // The approved switch is still owed, and the next launch carries it out from the start.
      const meta = store.readMeta(SESSION)!;
      assert.equal(meta.pendingLocationSwitch?.occurrenceId, "occurrence-1");
      assert.equal(meta.repoPath, c.app);
      writeFileSync(join(c.root, "let-it-pass"), "");
      await manager.start(spec(c.app));
      manager.prompt(SESSION, "carry on");
      await waitFor(() => store.readMeta(SESSION)?.repoPath === c.docs || store.readMeta(SESSION)?.locationSwitchFailure !== undefined,
        "the owed switch did not settle", 3000);
      assert.equal(store.readMeta(SESSION)?.locationSwitchFailure, undefined);
      await waitFor(() => providers.some((provider) => provider.cwd === c.target), "the provider did not relaunch in the new worktree");
      assert.equal(providers.find((provider) => provider.cwd === c.target)!.env?.SWITCH_SETUP_VALUE, "from-setup");
      assert.equal(store.readMeta(SESSION)!.worktrees![0]!.setup?.status, "completed");
      assert.deepEqual(journal(), []);
    });
  });

  test("a crash while the trust card is open is reaped too, with no teardown because no setup ever ran", async () => {
    if (process.platform === "win32") return;
    await withCrashDuringSetup("at-card", async (c) => {
      const { manager, store, journal } = c.runner();
      const [record] = journal();
      assert.equal(record?.worktreePath, c.target, "the worktree was on record before Git made it");
      assert.ok(record?.processMarker);
      assert.equal(record?.hooks, undefined, "trust was never given, so there is nothing of setup's to undo");
      manager.reconcileStore();
      await waitFor(() => journal().length === 0, "the crash's rollback was not replayed", 3000);
      assert.equal(existsSync(c.target), false);
      assert.ok(git(c.docs, "rev-parse", "--verify", "refs/heads/fix/install-link"));
      assert.equal(existsSync(join(c.root, "teardown-log")), false);
      assert.equal(store.readMeta(SESSION)?.pendingLocationSwitch?.occurrenceId, "occurrence-1");
    }, { atTrustCard: true });
  });

  test("a rollback a crash left with its proof gone still ends setup's processes, and frees its ports only then, leaving the tree alone", async () => {
    if (process.platform === "win32") return;
    for (const how of ["its registration went", "an older runner wrote it, with no proof"] as const) {
      await withCrashDuringSetup(how.includes("older") ? "older-record" : "pruned", async (c) => {
        assert.equal(alive(c.setupPid), true, "setup's process outlived the runner");
        const journalPath = join(c.root, "data", "worktree-cleanup.json");
        if (how.includes("older")) {
          const records = JSON.parse(readFileSync(journalPath, "utf8")) as WorktreeCleanupRecord[];
          for (const record of records) {
            delete record.rollbackProof;
            delete record.rollbackBranchBase;
          }
          writeFileSync(journalPath, JSON.stringify(records));
        }
        writeFileSync(join(c.target, "notes.txt"), "kept\n");
        if (how.includes("registration")) {
          renameSync(c.target, `${c.target}.away`);
          git(c.docs, "worktree", "prune");
          renameSync(`${c.target}.away`, c.target);
        }
        const { manager, journal } = c.runner();
        const [record] = journal();
        assert.ok(record?.portBlock);
        manager.reconcileStore();
        await waitFor(() => journal().length === 0, "the rollback was not ended", 3000);
        assert.equal(alive(c.setupPid), false, "setup's process was ended by its own marker");
        assert.equal(readFileSync(join(c.target, "notes.txt"), "utf8"), "kept\n", "and the tree is left alone");
        assert.equal(existsSync(join(c.root, "teardown-log")), false, "with no teardown in it");
        const allocator = (manager as unknown as { worktreePortAllocator: { get(owner: string): unknown } }).worktreePortAllocator;
        assert.equal(allocator.get(`${SESSION}\0${record!.worktreeId}`), undefined, "its ports are free now its processes have gone");
      });
    }
  });

  test("a crash that left setup's output in the tree keeps the tree, when nothing can say whose it is", async () => {
    if (process.platform === "win32") return;
    await withCrashDuringSetup("kept-output", async (c) => {
      writeFileSync(join(c.target, "output-or-work.txt"), "cannot tell which\n");
      const { manager, journal } = c.runner();
      manager.reconcileStore();
      await waitFor(() => journal().length === 0, "the rollback was not ended", 3000);
      assert.equal(alive(c.setupPid), false, "its process still ends");
      assert.equal(readFileSync(join(c.target, "output-or-work.txt"), "utf8"), "cannot tell which\n");
      assert.ok(git(c.docs, "rev-parse", "--verify", "refs/heads/fix/install-link"));
    });
  });

  test("deleting a session a crash left mid-setup leaves no worktree, process or port block behind", async () => {
    if (process.platform === "win32") return;
    await withCrashDuringSetup("deleted", async (c) => {
      const { manager, journal } = c.runner();
      const [record] = journal();
      assert.ok(record);
      await manager.delete(SESSION);
      manager.reconcileStore();
      await waitFor(() => journal().length === 0, "the crash's rollback was not replayed", 3000);
      assert.equal(alive(c.setupPid), false);
      assert.equal(existsSync(c.target), false);
      assert.ok(git(c.docs, "rev-parse", "--verify", "refs/heads/fix/install-link"));
      const allocator = (manager as unknown as { worktreePortAllocator: { get(owner: string): unknown } }).worktreePortAllocator;
      assert.equal(allocator.get(`${SESSION}\0${record.worktreeId}`), undefined);
    });
  });
}
