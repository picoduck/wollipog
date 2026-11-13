import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import { PROTOCOL_VERSION, type SessionLaunchSpec } from "@wollipog/protocol";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { requestedSlot, requestedWorktreeBoundary, type WorktreeCleanupRecord } from "./worktree.js";
import { ProviderHomeLeaseError } from "./provider-home-lease-worker-protocol.js";
import { ProviderHomeLeaseRegistry } from "./provider-home-lease.js";
import { linuxLeaseProcessProbe, providerHomeRunnerMarker, proveLeaseAbandoned } from "./provider-home-lease-evidence.js";
import { ProviderProcessOwnership } from "./provider-process-ownership.js";
import { provisionAgentControl, removeAgentControlFiles, isCurrentAgentControlCredential } from "./agent-control.js";
import { ManagedWorktreeGuardSockets } from "./managed-worktree-guard-socket.js";
import { requestManagedWorktreeGuardVerdict } from "./managed-worktree-guard.js";

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

/** Closed-world fixture probe. Only scan is scoped; identity reads still use the real kernel. */
function fixtureProcessProbe(root: string, children: Array<{ pid: number }>) {
  const proc = join(root, "proc");
  mkdirSync(proc);
  for (const { pid } of children) symlinkSync(`/proc/${pid}`, join(proc, String(pid)));
  const kernel = linuxLeaseProcessProbe()!;
  const scoped = linuxLeaseProcessProbe(proc)!;
  return { proc, probe: { ...kernel, scan: (...args: Parameters<typeof kernel.scan>) => {
    for (const { pid } of children) {
      const link = join(proc, String(pid));
      if (!existsSync(`/proc/${pid}`)) { try { unlinkSync(link); } catch { /* already removed */ } }
    }
    return scoped.scan(...args);
  } } };
}

test("the scoped relaunch fixture proof sees real survivors and refuses an uninspectable entry", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-scoped-retirement-"));
  const directory = join(root, "ownership");
  const fixture = new URL("./fixtures/provider-owned-orphans.mjs", import.meta.url).pathname;
  try {
    // Truthy non-tree mode records two providers without acquiring a platform-dependent HOME.
    execFileSync(process.execPath, ["--import", "tsx", fixture, directory, "runner", "owned"], { timeout: 10_000 });
    const manifest = JSON.parse(readFileSync(join(root, "fixture-state.json"), "utf8")) as {
      bootId: string; runnerPid: number; runnerStartTime: string; marker: string; children: Array<{ pid: number }>;
    };
    const { proc, probe } = fixtureProcessProbe(root, manifest.children);
    const evidence = { bootId: manifest.bootId, startTime: manifest.runnerStartTime, marker: manifest.marker };
    const survivor = proveLeaseAbandoned(evidence, manifest.runnerPid, probe);
    assert.ok(!survivor.proven);
    assert.equal(survivor.reason, "marked_process");
    assert.equal((await new ProviderProcessOwnership(directory, "runner").recover()).retired, 2);
    const unknown = join(proc, "2147483646");
    mkdirSync(unknown);
    writeFileSync(join(unknown, "stat"), "uninspectable");
    writeFileSync(join(unknown, "status"), "uninspectable");
    const uninspectable = proveLeaseAbandoned(evidence, manifest.runnerPid, probe);
    assert.ok(!uninspectable.proven);
    assert.equal(uninspectable.reason, "uninspectable");
    rmSync(unknown, { recursive: true });
    assert.deepEqual(proveLeaseAbandoned(evidence, manifest.runnerPid, probe), { proven: true, proof: "process_scan" });
  } finally {
    if (existsSync(directory)) await new ProviderProcessOwnership(directory, "runner").recover();
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("an owner-admitted relaunch queues its recovery continuation before startup clears the card", async () => {
  await withSession("runner-recovery", async (h) => {
    h.spec.orchestrator = { strictProjectIsolation: false, integrationIsolation: false };
    h.store.patchMeta(h.sessionId, { orchestrator: h.spec.orchestrator, status: "running" });
    h.restart();
    h.manager.reconcileRunnerRestartRecovery([h.sessionId]);
    assert.equal(h.store.readMeta(h.sessionId)!.pendingApproval!.kind, "runner_recovery");
    assert.equal(h.manager.prompt(h.sessionId, "unadmitted continuation"), false);
    const receipt: string[] = [];
    const lifecycle = { commandId: "owner-recovery-continuation", queued: () => { receipt.push("queued"); },
      started: () => { receipt.push("started"); }, completed: () => { receipt.push("completed"); },
      failed: (error: string) => { receipt.push(`failed:${error}`); }, uncertain: (error: string) => { receipt.push(`uncertain:${error}`); } };
    const starting = h.start();
    assert.equal(h.manager.prompt(h.sessionId, "owner recovery continuation", [], undefined, undefined, lifecycle), true);
    assert.equal(await starting, true, JSON.stringify({ logs: h.logs, errors: errorText(h) }));
    await waitFor(() => h.providers.at(-1)!.prompts.includes("owner recovery continuation"), "recovery continuation was lost");
    await waitFor(() => receipt.includes("completed"), "durable recovery continuation never completed");
    assert.ok(receipt.includes("queued") && receipt.includes("started"));
    assert.ok(!receipt.some((item) => item.startsWith("failed:") || item.startsWith("uncertain:")), receipt.join(", "));
  });
});

test("a survivor lease refusal retains the owner recovery action and starts no replacement provider", async () => {
  await withSession("runner-survivor", async (h) => {
    h.spec.orchestrator = { strictProjectIsolation: false, integrationIsolation: false };
    h.store.patchMeta(h.sessionId, { orchestrator: h.spec.orchestrator, status: "running" });
    h.restart();
    h.manager.reconcileRunnerRestartRecovery([h.sessionId]);
    const requestId = h.store.readMeta(h.sessionId)!.pendingApproval!.requestId;
    const priorProviders = h.providers.length;
    Object.defineProperty(h.manager, "prepareLaunch", { value: async () => { throw new ProviderHomeLeaseError("process_survivor"); } });
    assert.equal(await h.start(), false);
    assert.equal(h.providers.length, priorProviders);
    assert.equal(h.store.readMeta(h.sessionId)!.status, "input_required");
    assert.equal(h.store.readMeta(h.sessionId)!.pendingApproval!.requestId, requestId);
  });
});

test("recorded startup retirement clears the survivor lease, then owner relaunch refreshes guard and credential and receives pending work",
  { timeout: 30_000, skip: process.platform !== "linux" ? "Linux pidfd fixture" :
    ![0, process.getuid?.()].includes(statSync("/").uid) ? "lease bootstrap rejects a root owned by a remapped foreign UID" : false }, async () => {
  await withSession("retired-survivor", async h => {
    h.spec.orchestrator = { strictProjectIsolation: false, integrationIsolation: false };
    h.store.patchMeta(h.sessionId, { orchestrator: h.spec.orchestrator, status: "running" });
    const controls = join(h.root, "controls");
    const host = { configDir: controls, platform: "linux" as const, isSea: false,
      execPath: process.execPath, execArgv: [], scriptPath: join(h.root, "inert-entry.mjs") };
    const hashes: string[] = [];
    const provision = (meta: Parameters<typeof provisionAgentControl>[0]) => provisionAgentControl(meta, {
      controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "provider", providerRelayEndpoint: "@inert-test-relay",
      registerCredential: (_id, hash) => { hashes.push(hash); },
    }, () => {}, host);
    await provision(h.spec);
    const oldGuard = new ManagedWorktreeGuardSockets(join(h.root, "old-guard"), () => []);
    const nextGuard = new ManagedWorktreeGuardSockets(join(h.root, "new-guard"), () => []);
    const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: h.app,
      tool_input: { command: "git status" } });
    const directory = join(h.root, "ownership");
    let leases: ProviderHomeLeaseRegistry | undefined;
    let newAddress = "";
    try {
      const oldAddress = await oldGuard.ensure(h.sessionId, "abstract");
      await requestManagedWorktreeGuardVerdict(oldAddress, payload);
      const orphanFixture = new URL("./fixtures/provider-owned-orphans.mjs", import.meta.url).pathname;
      assert.equal(execFileSync(process.execPath, ["--import", "tsx", orphanFixture,
        directory, "runner", "complete", h.sessionId], { encoding: "utf8", timeout: 10_000 }).trim(), "ready");
      const manifest = JSON.parse(readFileSync(join(h.root, "fixture-state.json"), "utf8")) as { home: string; children: Array<{ pid: number }> };
      // A closed-world guard/credential rehearsal: inspect real fixture processes through
      // a scoped proc view, so unrelated CI workloads cannot affect this legacy lease.
      // Production still scans the whole host; ownership retirement still uses real pidfds.
      const { proc, probe } = fixtureProcessProbe(h.root, manifest.children);
      leases = new ProviderHomeLeaseRegistry("a".repeat(64), { runnerMarker: providerHomeRunnerMarker(), processProbe: probe });
      const homeLease = leases;
      await oldGuard.closeAll();
      removeAgentControlFiles(h.sessionId, controls); // The replaced runner's memory is gone.
      await assert.rejects(requestManagedWorktreeGuardVerdict(oldAddress, payload));
      assert.throws(() => homeLease.acquireHome(manifest.home, "fixture"), /still used by a process/);
      const retired = await new ProviderProcessOwnership(directory, "runner").recover();
      assert.equal(retired.retired, 2);
      assert.equal(retired.retained, 0);
      // The scoped probe must still fail closed on an uninspectable potential survivor.
      const unknown = join(proc, "2147483646");
      mkdirSync(unknown);
      writeFileSync(join(unknown, "stat"), "uninspectable");
      writeFileSync(join(unknown, "status"), "uninspectable");
      assert.throws(() => homeLease.acquireHome(manifest.home, "fixture"), /cannot all be inspected/);
      rmSync(unknown, { recursive: true });
      assert.doesNotThrow(() => homeLease.acquireHome(manifest.home, "fixture"));
      h.restart();
      h.manager.reconcileRunnerRestartRecovery([h.sessionId]);
      assert.equal(h.store.readMeta(h.sessionId)!.pendingApproval!.kind, "runner_recovery");
      assert.equal(h.manager.prompt(h.sessionId, "automatic self-relaunch"), false);
      Object.defineProperty(h.manager, "prepareLaunch", { value: async (meta: Parameters<typeof provision>[0]) => {
        homeLease.acquireHome(manifest.home, "fixture");
        await provision(meta);
        newAddress = await nextGuard.ensure(h.sessionId, "abstract");
      } });
      const starting = h.start(); // Same admitted start dispatched by the owner-only service route.
      assert.equal(h.manager.prompt(h.sessionId, "reconcile pending requests"), true);
      assert.equal(await starting, true, JSON.stringify(h.logs));
      await waitFor(() => h.providers.at(-1)!.prompts.includes("reconcile pending requests"), "pending work was not delivered");
      assert.equal(hashes.length, 2);
      assert.notEqual(hashes[0], hashes[1]);
      assert.equal(isCurrentAgentControlCredential(controls, h.sessionId, hashes[0]!), false);
      assert.equal(isCurrentAgentControlCredential(controls, h.sessionId, hashes[1]!), true);
      assert.notEqual(newAddress, oldAddress);
      await assert.rejects(requestManagedWorktreeGuardVerdict(oldAddress, payload));
      await assert.doesNotReject(requestManagedWorktreeGuardVerdict(newAddress, payload));
    } finally {
      await oldGuard.closeAll(); await nextGuard.closeAll();
      removeAgentControlFiles(h.sessionId, controls);
      if (existsSync(directory)) await new ProviderProcessOwnership(directory, "runner").recover();
      leases?.releaseAll();
    }
  });
});

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

test("a launch that makes the selected worktree again and gives it back ends in recovery, not a silent restore", async () => {
  if (process.platform === "win32") return;
  await withSession("rolled-back-selection", async (h) => {
    const automatic = { ...h.spec, useWorktree: true };
    const releaseLease = () => {
      const lease = h.store.readWorktreeLease(h.sessionId);
      if (lease) h.store.releaseWorktreeLease(h.sessionId, lease.owner);
    };
    releaseLease();
    await h.manager.start(automatic);
    const selected = h.store.readMeta(h.sessionId)!.worktreePath!;
    assert.ok(selected, "the session works in its automatic worktree");
    // Its records name only the selection, as an older runner left them, and the directory has gone, so
    // the next launch makes that worktree again, and then its ownership claim fails and it is given back.
    h.store.patchMeta(h.sessionId, { worktrees: [] });
    git(h.app, "worktree", "remove", "--force", selected);
    const ownership = (h.manager as unknown as { checkpointRefOwnership: { claim: (...args: unknown[]) => unknown } }).checkpointRefOwnership;
    const claim = ownership.claim.bind(ownership);
    ownership.claim = () => { throw new Error("checkpoint ownership could not be claimed"); };
    releaseLease();
    await h.manager.start(automatic).catch(() => undefined);
    ownership.claim = claim;
    await waitFor(() => h.store.readMeta(h.sessionId)?.worktreeRecovery !== undefined,
      "the launch did not take the session to recovery");
    assert.equal(existsSync(selected), false, "the launch gave back the worktree it made");
    // The selection names that path only alongside the recovery card that says it has to be restored or replaced.
    assert.ok(errorText(h).some((text) => text.includes(selected) && /restore/u.test(text)), "and the session is told what to do");
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
