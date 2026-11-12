import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { SessionLaunchSpec } from "@wollipog/protocol";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { requestedSlot, requestedWorktreeBoundary, type WorktreeCleanupRecord } from "./worktree.js";

// #4209 follow-ups to #4413, #4418 and #4419: a worktree launch, and what it leaves when it fails.

const git = (cwd: string, ...args: string[]) => execFileSync("git", [
  "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
  "-C", cwd, ...args,
], { encoding: "utf8" }).trim();

async function waitFor(predicate: () => boolean, message: string, attempts = 1500): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

/** Every entry under `root`, byte for byte, including Git's own files and links. */
function bytes(root: string, prefix = ""): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(found, bytes(root, path));
    else if (entry.isSymbolicLink()) found[path] = `link:${readlinkSync(join(root, path))}`;
    else found[path] = readFileSync(join(root, path)).toString("base64");
  }
  return found;
}

interface Provider { cwd: string; prompts: string[] }

function fakeProvider() {
  const providers: Provider[] = [];
  const factory = (_driver: unknown, launch: { cwd: string }, cb: { onPromptAccepted?: () => void; onEvent: (event: unknown) => void }) => {
    const provider: Provider = { cwd: launch.cwd, prompts: [] };
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

interface Harness {
  manager: SessionManager;
  store: SessionStore;
  sessionId: string;
  providers: Provider[];
  app: string;
  root: string;
  logs: string[];
  spec: SessionLaunchSpec;
  /** A new runner process over the same state, running its startup reconciliation. */
  restart: () => void;
  /** Launch the session again, as a message after a restart does. */
  start: () => Promise<boolean>;
}

async function withSession(name: string, body: (h: Harness) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wollipog-launch-hardening-${name}-`)));
  const fake = fakeProvider();
  const dataDir = join(root, "data");
  const managers: SessionManager[] = [];
  const logs: string[] = [];
  const app = join(root, "app");
  mkdirSync(app);
  git(app, "init", "--quiet", "--initial-branch=main");
  git(app, "commit", "--quiet", "--allow-empty", "-m", "base");
  const locations = [{ id: "app", name: "App", path: realpathSync(app) }];
  const runner = () => {
    const store = new SessionStore(join(dataDir, "sessions"));
    const manager = new SessionManager(() => {}, (line: string) => { logs.push(line); }, store, "runner", undefined,
      fake.factory as never, dataDir, 2);
    manager.configureSharedDirectories(locations as never);
    managers.push(manager);
    return { manager, store };
  };
  try {
    const { manager, store } = runner();
    const sessionId = `s_launch_${name.replaceAll("-", "_")}`;
    const spec: SessionLaunchSpec = { sessionId, workspaceId: "app", workspacePath: realpathSync(app), agentId: "claude-code",
      command: "claude-code", args: [], env: {}, useWorktree: false, driver: "claude-code", context: { kind: "native" } };
    await manager.start(spec);
    const harness: Harness = {
      manager, store, sessionId, providers: fake.providers, app: realpathSync(app), root, logs, spec,
      restart: () => {
        harness.manager.shutdownAll();
        const lock = join(dataDir, "sessions", sessionId, "lock");
        if (existsSync(lock)) utimesSync(lock, new Date(0), new Date(0));
        const next = runner();
        harness.manager = next.manager;
        harness.store = next.store;
        next.manager.reconcileStore();
      },
      start: () => {
        // A dead process's lease is reclaimed by its pid. This "restart" shares the test's pid, so model that.
        const lease = harness.store.readWorktreeLease(sessionId);
        if (lease) harness.store.releaseWorktreeLease(sessionId, lease.owner);
        return harness.manager.start(spec);
      },
    };
    await body(harness);
  } finally {
    for (const manager of managers) manager.shutdownAll();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    rmSync(root, { recursive: true, force: true });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const payloads = (h: Harness, kind: string): any[] => h.store.readEvents(h.sessionId)
  .map((event) => event.payload).filter((payload) => payload.kind === kind);
const errorText = (h: Harness) => payloads(h, "error").map((payload) => String(payload.message));

interface Internals {
  prepareWorktreeSetup: (...args: unknown[]) => Promise<string>;
  cleanupRecordForWorktree: (meta: unknown, worktree: unknown, trigger: string, mode: string) => WorktreeCleanupRecord;
  cleanupJournal: { add(record: WorktreeCleanupRecord): void; list(): WorktreeCleanupRecord[] };
}
const internalsOf = (h: Harness) => h.manager as unknown as Internals;

const registered = (repo: string) => git(repo, "worktree", "list", "--porcelain").split("\n")
  .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));

test("a worktree launch that fails keeps the session selecting the worktree it had, so the next launch runs there", async () => {
  await withSession("keeps-selection", async (h) => {
    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/selected" });
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, worktree.path);

    h.restart();
    // Preparing the worktree fails once, as a port block nobody can have did before #4413.
    const internals = internalsOf(h);
    const prepare = internals.prepareWorktreeSetup.bind(h.manager);
    internals.prepareWorktreeSetup = async () => { throw new Error("worktree port range is exhausted"); };
    await h.start().catch(() => undefined);
    await waitFor(() => errorText(h).some((text) => /exhausted/u.test(text)), "the launch did not fail");
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, worktree.path, "the session still selects its worktree");

    internals.prepareWorktreeSetup = prepare;
    const launched = h.providers.length;
    await h.start();
    h.manager.prompt(h.sessionId, "carry on");
    await waitFor(() => h.providers[launched]?.prompts.length === 1, "the next launch did not run a turn");
    assert.equal(h.providers[launched]!.cwd, worktree.path, "and the next launch runs there, not in the Location's checkout");
  });
});

test("a requested worktree whose directory was deleted by hand is made again on its branch, dropping only its own registration", async () => {
  if (process.platform === "win32") return;
  await withSession("stale-registration", async (h) => {
    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/gone" });
    writeFileSync(join(worktree.path, "work.txt"), "committed work\n");
    git(worktree.path, "add", "work.txt");
    git(worktree.path, "commit", "--quiet", "-m", "the session's work");
    const tip = git(worktree.path, "rev-parse", "HEAD");
    await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/other" });
    // Another worktree of the repository whose directory is only away for now, as on an unmounted volume.
    const away = join(h.root, "on-a-volume");
    git(h.app, "worktree", "add", "--quiet", "-b", "volume-work", away);
    const awayAdmin = git(away, "rev-parse", "--absolute-git-dir");
    renameSync(away, `${away}.unmounted`);
    const awayBytes = bytes(awayAdmin);
    // A person deletes the directory by hand. Its registration is left behind.
    rmSync(worktree.path, { recursive: true, force: true });
    assert.ok(registered(h.app).includes(worktree.path));

    const again = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/gone" });
    assert.equal(again.worktree.path, worktree.path);
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, worktree.path, "the session works there again");
    assert.equal(git(worktree.path, "rev-parse", "HEAD"), tip, "on its branch as it stands, commits and all");
    assert.equal(readFileSync(join(worktree.path, "work.txt"), "utf8"), "committed work\n");
    assert.deepEqual(bytes(awayAdmin), awayBytes, "the worktree that is only away keeps its registration, byte for byte");
  });
});

/** Selecting a worktree relaunches the provider there. Under a managed sandbox that launch reserves an
 * empty `config.worktree` in each of the session's other managed worktrees, so a test comparing their
 * Git admin directories byte for byte waits for it first. */
async function relaunchedIn(h: Harness, path: string): Promise<void> {
  await waitFor(() => h.providers.at(-1)?.cwd === path && h.store.readMeta(h.sessionId)?.status !== "starting",
    `the session did not relaunch in ${path}`);
}

for (const holder of ["a person, with no row of this session's", "another session that lists it"] as const) {
  test(`a requested slot whose directory went is left byte for byte when ${holder} has it`, async () => {
    if (process.platform === "win32") return;
    await withSession(`stale-registration-${holder.startsWith("a person") ? "unowned" : "held"}`, async (h) => {
      const branch = "fix/held";
      let path: string;
      if (holder.startsWith("a person")) {
        // The person makes the worktree at the session's slot by hand and stages work there.
        path = join(await requestedWorktreeBoundary(h.app, h.sessionId, { dataDir: join(h.root, "data") }), requestedSlot(branch));
        git(h.app, "worktree", "add", "--quiet", "-b", branch, path);
      } else {
        ({ worktree: { path } } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch }));
        const { worktree: elsewhere } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/other" });
        await relaunchedIn(h, elsewhere.path);
        // Another session lists the same worktree as one it attached.
        const other = { ...h.spec, sessionId: `${h.sessionId}_other` };
        await h.manager.start(other);
        h.store.patchMeta(other.sessionId, { worktrees: [{ id: "attached-id", path, branch, source: "attached" }] });
      }
      writeFileSync(join(path, "notes.txt"), "staged work\n");
      git(path, "add", "notes.txt");
      const admin = git(path, "rev-parse", "--absolute-git-dir");
      renameSync(path, `${path}.away`);
      const before = bytes(admin);

      await assert.rejects(h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch }),
        /nothing shows this session made it, so it was left as it is/u);
      assert.deepEqual(bytes(admin), before, "its registration, index and reflog stay");
      renameSync(`${path}.away`, path);
      assert.equal(git(path, "status", "--porcelain"), "A  notes.txt");
    });
  });
}

test("a requested slot whose directory went is refused by name when its registration is locked, and left byte for byte", async () => {
  if (process.platform === "win32") return;
  await withSession("stale-registration-locked", async (h) => {
    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/locked" });
    const { worktree: elsewhere } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/other" });
    await relaunchedIn(h, elsewhere.path);
    git(h.app, "worktree", "lock", "--reason", "on a removable disk", worktree.path);
    const admin = git(worktree.path, "rev-parse", "--absolute-git-dir");
    rmSync(worktree.path, { recursive: true, force: true });
    const before = bytes(admin);

    await assert.rejects(h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/locked" }),
      new RegExp(`it is locked, so unlock it \\(git worktree unlock ${worktree.path.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\)`, "u"));
    assert.deepEqual(bytes(admin), before, "the locked registration stays as it was");
    assert.ok(registered(h.app).includes(worktree.path));
  });
});

test("a worktree made again on its own branch that fails to activate is given back, and the branch stays", async () => {
  if (process.platform === "win32") return;
  await withSession("stale-registration-rollback", async (h) => {
    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/gone" });
    await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/other" });
    rmSync(worktree.path, { recursive: true, force: true });
    const tip = git(h.app, "rev-parse", "refs/heads/fix/gone");
    const internals = h.manager as unknown as { activateWorktreeWithNotice: (...args: unknown[]) => Promise<unknown> };
    internals.activateWorktreeWithNotice = async () => { throw new Error("activation failed"); };

    await assert.rejects(h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/gone" }), /activation failed/u);
    assert.equal(existsSync(worktree.path), false, "the worktree this attempt made is given back");
    // The branch was there before this attempt, even at its base with nothing on it, so it is not this attempt's to delete.
    assert.equal(git(h.app, "rev-parse", "refs/heads/fix/gone"), tip);
  });
});

test("a restart that finds the selected worktree on another branch keeps it, and ends an earlier launch's rollback of it", async () => {
  if (process.platform === "win32") return;
  await withSession("recovery-ends-rollback", async (h) => {
    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/selected" });
    // An earlier launch's rollback of this worktree is still on record, as one whose removal was refused stays.
    const internals = internalsOf(h);
    const row = h.store.readMeta(h.sessionId)!.worktrees!.find((item) => item.path === worktree.path)!;
    // A launch's own rollback is marked disposable, as each one that unwinds a worktree it made is.
    internals.cleanupJournal.add({ ...internals.cleanupRecordForWorktree(h.store.readMeta(h.sessionId), row, "creation_rollback", "force"),
      checkpointGenerationDisposable: true });
    // A person moves the worktree to another branch and works there.
    git(worktree.path, "checkout", "--quiet", "-b", "fix/by-hand");
    writeFileSync(join(worktree.path, "notes.txt"), "a person's notes\n");
    const before = bytes(worktree.path);

    await h.start().catch(() => undefined);
    await waitFor(() => h.store.readMeta(h.sessionId)?.worktreeRecovery !== undefined, "the restart did not ask for recovery");
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, worktree.path, "the session still selects it");
    assert.deepEqual(internalsOf(h).cleanupJournal.list(), [], "and the earlier launch's rollback is over");

    h.restart();
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    assert.deepEqual(bytes(worktree.path), before, "so a runner restart replays nothing against it");
  });
});
