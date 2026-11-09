import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionLocationSwitchMessage, SessionWorktreeView } from "@wollipog/protocol";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeProjectPathKey } from "./claude-background-work.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { requestedSlot, requestedWorktreeBoundary, type WorktreeCleanupRecord } from "./worktree.js";

// #4209: a live Location switch applies the target repository's worktree setup exactly as a
// requested worktree does, before the old provider retires, and only with #637's trust approval.

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

function repository(root: string, name: string, origin: string): string {
  const path = join(root, name);
  mkdirSync(path);
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "commit", "--quiet", "--allow-empty", "-m", "base");
  git(path, "remote", "add", "origin", origin);
  return realpathSync(path);
}

interface Provider { cwd: string; env: Record<string, string> | undefined; disposed: boolean; prompts: string[] }

function fakeProvider() {
  const providers: Provider[] = [];
  const factory = (_driver: unknown, launch: { cwd: string; env?: Record<string, string> }, cb: {
    onPromptAccepted?: () => void;
    onEvent: (event: unknown) => void;
  }) => {
    const provider: Provider = { cwd: launch.cwd, env: launch.env, disposed: false, prompts: [] };
    providers.push(provider);
    return {
      pid: providers.length, newSession: async () => {}, close: async () => {}, initialize: async () => {},
      prompt: async (text: string) => {
        provider.prompts.push(text);
        cb.onPromptAccepted?.();
        cb.onEvent({ kind: "agent_message", text: "done", final: true });
        return "end_turn" as const;
      },
      cancel: () => {}, dispose: () => { provider.disposed = true; }, setConfig: () => {}, resolvePermission: () => false,
      agentSessionId: () => "provider-session-id",
    };
  };
  return { factory, providers };
}

/** Each step writes through Node so the tests share one shell-free, cross-platform command form. */
const write = (path: string, value: string) => [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(path)},${value})`];
const fail = [process.execPath, "-e", "process.exit(3)"];
const sleep = [process.execPath, "-e", "setTimeout(()=>{},60000)"];

interface Harness {
  manager: SessionManager;
  store: SessionStore;
  sessionId: string;
  providers: Provider[];
  sent: RunnerToControlPlane[];
  app: string;
  docs: string;
  root: string;
  message: (overrides?: Partial<SessionLocationSwitchMessage>) => SessionLocationSwitchMessage;
  /** A new runner process over the same state, running its startup reconciliation. */
  restart: () => void;
}

async function withSession(name: string, body: (h: Harness) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wollipog-switch-setup-${name}-`)));
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  const claudeHome = join(root, "claude-home");
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const fake = fakeProvider();
  const sent: RunnerToControlPlane[] = [];
  const dataDir = join(root, "data");
  const managers: SessionManager[] = [];
  const runner = (locations: unknown) => {
    const store = new SessionStore(join(dataDir, "sessions"));
    const manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
      fake.factory as never, dataDir, 2);
    manager.configureSharedDirectories(locations as never);
    managers.push(manager);
    return { manager, store };
  };
  try {
    const app = repository(root, "app", "git@github.com:acme/app.git");
    const docs = repository(root, "docs", "git@github.com:acme/docs.git");
    git(docs, "branch", "fix/install-link");
    const locations = [{ id: "app", name: "App", path: app }, { id: "docs", name: "Docs", path: docs }];
    const { manager, store } = runner(locations);
    const sessionId = `s_switch_setup_${name.replaceAll("-", "_")}`;
    const spec: SessionLaunchSpec = { sessionId, workspaceId: "app", workspacePath: app, agentId: "claude-code", command: "claude-code",
      args: [], env: {}, useWorktree: false, driver: "claude-code", context: { kind: "native" } };
    await manager.start(spec);
    manager.prompt(sessionId, "start the task");
    await waitFor(() => fake.providers[0]?.prompts.length === 1 && store.readMeta(sessionId)?.status === "idle",
      "the first turn did not finish");
    const projects = join(claudeHome, "projects", claudeProjectPathKey(app));
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "provider-session-id.jsonl"), "{\"type\":\"user\"}\n");
    const harness: Harness = {
      manager, store, sessionId, providers: fake.providers, sent, app, docs, root,
      message: (overrides = {}) => ({
        type: "session_location_switch", requestId: "request-1", sessionId, workspaceId: "docs", workspacePath: docs,
        repository: "acme/docs", locationName: "Docs", occurrenceId: "occurrence-1", continuation: "Continue the docs fix here.",
        recoverBranch: "fix/install-link", ...overrides,
      }),
      restart: () => {
        harness.manager.shutdownAll();
        // A crashed process's session lock goes stale; model that rather than wait a minute.
        const lock = join(dataDir, "sessions", sessionId, "lock");
        if (existsSync(lock)) utimesSync(lock, new Date(0), new Date(0));
        const next = runner(locations);
        harness.manager = next.manager;
        harness.store = next.store;
        next.manager.reconcileStore();
      },
    };
    await body(harness);
  } finally {
    for (const manager of managers) manager.shutdownAll();
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    rmSync(root, { recursive: true, force: true });
  }
}

/** The configuration lives on the branch the switch recovers, as the base commit setup reads. */
function commitSetup(h: Harness, config: unknown, branch = "fix/install-link"): void {
  git(h.docs, "checkout", "--quiet", branch);
  writeFileSync(join(h.docs, ".wollipog.json"), typeof config === "string" ? config : JSON.stringify({ version: 1, ...config as object }));
  writeFileSync(join(h.docs, ".gitignore"), ".env.local\n");
  git(h.docs, "add", ".wollipog.json", ".gitignore");
  git(h.docs, "commit", "--quiet", "-m", "setup");
  git(h.docs, "checkout", "--quiet", "main");
}

/** The target's origin still names acme/docs, and a local bare copy answers its fetches, so a switch
 * that recovers no branch can take its base from the remote default branch. */
function serveOriginLocally(h: Harness): void {
  const bare = join(h.root, "docs-origin.git");
  git(h.root, "clone", "--quiet", "--bare", h.docs, bare);
  const shim = join(h.root, "origin-ssh.sh");
  writeFileSync(shim, `#!/bin/sh\nexec git upload-pack ${JSON.stringify(bare)}\n`, { mode: 0o755 });
  git(h.docs, "config", "core.sshCommand", shim);
  git(h.docs, "fetch", "--quiet", "origin");
  git(h.docs, "remote", "set-head", "origin", "main");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const payloads = (h: Harness, kind: string): any[] => h.store.readEvents(h.sessionId)
  .map((event) => event.payload).filter((payload) => payload.kind === kind);

const stderrText = (h: Harness) => payloads(h, "stderr").map((payload) => String(payload.text));
const docsWorktrees = (h: Harness) => git(h.docs, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length));

/** Wait for the trust card and answer it the way a person's decision arrives. */
async function answerTrust(h: Harness, optionId: "trust" | "skip" | null): Promise<void> {
  await waitFor(() => payloads(h, "permission_request").length > 0, "no trust card was shown");
  const [card] = payloads(h, "permission_request");
  assert.equal(card.title, "Trust Worktree Setup Configuration?");
  h.manager.resolvePermission(h.sessionId, card.requestId, optionId);
}

const failure = (h: Harness) => h.store.readMeta(h.sessionId)?.locationSwitchFailure;

/** The rollback records the runner is holding, read from its durable journal. */
const journal = (h: Harness) => (h.manager as unknown as { cleanupJournal: { list(): WorktreeCleanupRecord[] } }).cleanupJournal.list();

/** Every file in a worktree, byte for byte, without its Git link. */
function files(root: string, prefix = ""): Record<string, string> {
  const found: Record<string, string> = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.name === ".git") continue;
    if (entry.isDirectory()) Object.assign(found, files(root, path));
    else found[path] = readFileSync(join(root, path), "utf8");
  }
  return found;
}

const FAILING_STEP = { setup: [{ name: "Install Packages", command: fail, timeoutSeconds: 30 }] };

/** The session is where it was, with no trace of the target in its records. */
function assertStayed(h: Harness): void {
  const meta = h.store.readMeta(h.sessionId)!;
  assert.equal(meta.workspaceId, "app");
  assert.equal(meta.repoPath, h.app);
  assert.equal(meta.pendingLocationSwitch, undefined);
  assert.equal(meta.locationHistory, undefined);
  assert.equal(meta.worktrees?.some((worktree) => worktree.path.includes("requested")) ?? false, false,
    "the old Location's records never name the target");
  assert.deepEqual(Object.keys(meta.worktreeHooks ?? {}), []);
  assert.deepEqual(Object.keys(meta.worktreeProcessMarkers ?? {}), []);
}

test("a trusted setup runs its steps, copies and environment before the provider continues, and the relaunch sees the environment", async () => {
  await withSession("runs", async (h) => {
    writeFileSync(join(h.docs, ".env.local"), "copied");
    commitSetup(h, {
      copyFiles: [{ source: ".env.local", destination: ".env.local" }],
      environment: { SWITCH_SETUP_VALUE: "from-setup" },
      setup: [
        { name: "Prepare Target", command: write(".setup-ran", "process.env.SWITCH_SETUP_VALUE"), timeoutSeconds: 30 },
        { name: "Record Environment", command: write(join(h.root, "setup-environment"), "JSON.stringify(process.env)"), timeoutSeconds: 30 },
      ],
      teardown: [{ name: "Clean Target", command: write(join(h.root, "teardown-ran"), "'yes'"), timeoutSeconds: 30 }],
    });
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => h.providers[1]?.prompts.length === 1 || failure(h) !== undefined, "the switch did not settle");
    assert.equal(failure(h), undefined);

    const meta = h.store.readMeta(h.sessionId)!;
    const worktree = meta.worktrees![0]!;
    assert.equal(meta.repoPath, h.docs);
    assert.equal(readFileSync(join(worktree.path, ".setup-ran"), "utf8"), "from-setup", "the step ran in the target worktree");
    assert.equal(readFileSync(join(worktree.path, ".env.local"), "utf8"), "copied", "the declared file was copied");
    assert.equal(h.providers[1]!.cwd, worktree.path);
    assert.equal(h.providers[1]!.env?.SWITCH_SETUP_VALUE, "from-setup", "the relaunched provider sees the environment");
    assert.equal(h.providers[1]!.env?.WOLLIPOG_WORKTREE_PATH, worktree.path);
    assert.deepEqual(journal(h), [], "the move commits the worktree, so no rollback remains after the launch either");

    // The outcome is on the session as a requested worktree's is, with what removing it needs.
    assert.equal(worktree.setup?.status, "completed");
    assert.deepEqual(worktree.setup?.steps.map((step) => [step.name, step.status]),
      [["Prepare Target", "completed"], ["Record Environment", "completed"]]);
    assert.equal(worktree.setupConfig?.status, "valid");
    assert.ok(worktree.portBlock);
    assert.equal(meta.worktreeHooks?.[worktree.id]?.teardown[0]?.name, "Clean Target");
    // The marker setup's processes ran under is the one recorded, so retiring the worktree finds them.
    const marker = meta.worktreeProcessMarkers?.[worktree.id];
    assert.ok(marker);
    if (process.platform !== "win32") {
      const environment = JSON.parse(readFileSync(join(h.root, "setup-environment"), "utf8")) as Record<string, string>;
      assert.ok(Object.values(environment).includes(marker), "setup's processes carry the marker the moved session records");
    }

    // Setup finished before anything moved: its report comes ahead of the old provider's retirement.
    const events = h.store.readEvents(h.sessionId).map((event) => event.payload);
    const completed = events.findIndex((payload) => payload.kind === "command_output" &&
      String(payload.text).startsWith("[Worktree Setup — Prepare Target]\nCompleted"));
    const moved = events.findIndex((payload) => payload.kind === "stderr" && String(payload.text).startsWith("Moved this session"));
    assert.ok(completed >= 0 && moved > completed, "setup reported before the move");
    assert.ok(stderrText(h).some((text) => text === 'Running worktree setup before this session moves to Location "Docs".'));

    // The worktree's teardown is the snapshot taken at setup, carried across the move.
    h.manager.stop(h.sessionId);
    await h.manager.delete(h.sessionId);
    await waitFor(() => existsSync(join(h.root, "teardown-ran")), "the teardown snapshot did not reach the moved session");
  });
});

test("a required step that fails leaves the session in place, names the failure, releases the worktree and keeps the branch", async () => {
  await withSession("fails", async (h) => {
    commitSetup(h, {
      setup: [
        { name: "Leave a File", command: write("untracked-by-setup", "'x'"), timeoutSeconds: 30 },
        { name: "Install Packages", command: fail, timeoutSeconds: 30 },
      ],
      teardown: [{ name: "Clean Target", command: write(join(h.root, "teardown-ran"), "'yes'"), timeoutSeconds: 30 }],
    });
    const branchHead = git(h.docs, "rev-parse", "fix/install-link");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");

    assertStayed(h);
    assert.match(failure(h)!.reason!, /^the target's required worktree setup failed: .*Install Packages/u);
    assert.equal(failure(h)!.state, "failed");
    assert.ok(payloads(h, "error").some((payload) => /^The Location switch to "Docs" failed: /u.test(payload.message)));
    assert.equal(h.providers.length, 1, "the provider was never replaced");
    assert.equal(h.providers[0]!.disposed, false);

    // Released even though setup left a file behind, after its teardown; the branch stays.
    assert.deepEqual(docsWorktrees(h), [h.docs]);
    assert.equal(git(h.docs, "rev-parse", "fix/install-link"), branchHead);
    assert.equal(readFileSync(join(h.root, "teardown-ran"), "utf8"), "yes");

    // The snapshot the person sees agrees, and the session keeps working where it was.
    const snapshot = h.sent.filter((message) => message.type === "session_runtime_updated").at(-1);
    assert.equal(snapshot?.type === "session_runtime_updated" && snapshot.snapshot.locationSwitch?.state, "failed");
    h.manager.prompt(h.sessionId, "keep working");
    await waitFor(() => h.providers[0]!.prompts.length === 2, "the session stopped working in its current Location");
    assert.equal(h.providers[0]!.cwd, h.app);
  });
});

test("a switch that recovers no branch sets up its new worktree, and a failed setup removes the worktree and the branch it made", async () => {
  if (process.platform === "win32") return;
  await withSession("new-branch", async (h) => {
    commitSetup(h, {
      environment: { SWITCH_SETUP_VALUE: "from-setup" },
      setup: [
        { name: "Prepare Target", command: write(".setup-ran", "'yes'"), timeoutSeconds: 30 },
        { name: "Maybe Fail", command: [process.execPath, "-e",
          `process.exit(require('fs').existsSync(${JSON.stringify(join(h.root, "let-it-pass"))}) ? 0 : 3)`], timeoutSeconds: 30 },
      ],
    }, "main");
    serveOriginLocally(h);
    const branch = `agent/${h.sessionId}`;
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined })), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    assertStayed(h);
    assert.match(failure(h)!.reason!, /required worktree setup failed/u);
    assert.deepEqual(docsWorktrees(h), [h.docs], "the worktree is gone");
    assert.equal(git(h.docs, "branch", "--list", branch), "", "the branch this switch made is gone with it");

    // The same switch asked again, with setup now able to pass: nothing asks for trust a second time.
    writeFileSync(join(h.root, "let-it-pass"), "");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined, occurrenceId: "occurrence-2" })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 || failure(h) !== undefined, "the second switch did not settle");
    assert.equal(failure(h), undefined);
    const worktree = h.store.readMeta(h.sessionId)!.worktrees![0]!;
    assert.deepEqual([worktree.branch, worktree.source, worktree.branchPreexisted], [branch, "created", undefined]);
    assert.equal(worktree.setup?.status, "completed");
    assert.equal(readFileSync(join(worktree.path, ".setup-ran"), "utf8"), "yes");
    assert.equal(h.providers[1]!.env?.SWITCH_SETUP_VALUE, "from-setup");
    assert.equal(payloads(h, "permission_request").length, 1, "trust stays with the repository and the configuration's hash");
  });
});

test("an invalid setup configuration fails the switch visibly, and nothing runs", async () => {
  await withSession("invalid", async (h) => {
    commitSetup(h, "{\"version\":99}");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the invalid configuration did not fail the switch");
    assertStayed(h);
    assert.match(failure(h)!.reason!, /^the target's worktree setup configuration is invalid: /u);
    assert.deepEqual(payloads(h, "permission_request"), [], "an invalid configuration is never offered for trust");
    assert.deepEqual(docsWorktrees(h), [h.docs]);
    assert.ok(git(h.docs, "rev-parse", "--verify", "refs/heads/fix/install-link"));
    assert.equal(h.providers.length, 1);
  });
});

test("an untrusted configuration does not run on the switch's approval: the switch says it is waiting, and trust runs it", async () => {
  await withSession("waits", async (h) => {
    commitSetup(h, { setup: [{ name: "Prepare Target", command: write(join(h.root, "setup-ran"), "'yes'"), timeoutSeconds: 30 }] });
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => payloads(h, "permission_request").length > 0, "no trust card was shown");

    // Waiting, not moved: nothing ran, the provider is untouched, and the session says why.
    assert.equal(existsSync(join(h.root, "setup-ran")), false, "the switch's approval does not grant setup trust");
    assert.equal(h.providers.length, 1);
    assert.equal(h.providers[0]!.disposed, false);
    assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.app);
    assert.equal(h.store.readMeta(h.sessionId)?.pendingLocationSwitch?.occurrenceId, "occurrence-1");
    assert.ok(stderrText(h).some((text) => text.startsWith('The switch to Location "Docs" is waiting for a decision') &&
      text.endsWith("Approving the switch does not approve its setup.")));
    const [card] = payloads(h, "permission_request");
    assert.equal(card.context.path, h.docs, "the card names the target repository's configuration");
    assert.equal(card.context.toolName, "wollipog.worktree_setup");

    h.manager.resolvePermission(h.sessionId, card.requestId, "trust");
    await waitFor(() => h.providers[1]?.prompts.length === 1, "trust did not let the switch finish");
    assert.equal(readFileSync(join(h.root, "setup-ran"), "utf8"), "yes");
    assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.docs);
  });
});

test("dismissing the trust card fails the switch with the reason, and nothing runs", async () => {
  await withSession("dismissed", async (h) => {
    commitSetup(h, { setup: [{ name: "Prepare Target", command: write(join(h.root, "setup-ran"), "'yes'"), timeoutSeconds: 30 }] });
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, null);
    await waitFor(() => failure(h) !== undefined, "the dismissed card did not fail the switch");
    assertStayed(h);
    assert.match(failure(h)!.reason!, /setup trust decision was dismissed/u);
    assert.equal(existsSync(join(h.root, "setup-ran")), false);
    assert.deepEqual(docsWorktrees(h), [h.docs]);
    assert.ok(git(h.docs, "rev-parse", "--verify", "refs/heads/fix/install-link"));
  });
});

test("declining setup moves the session without it, as Create Without Setup does for a requested worktree", async () => {
  await withSession("declined", async (h) => {
    commitSetup(h, {
      environment: { SWITCH_SETUP_VALUE: "from-setup" },
      setup: [{ name: "Prepare Target", command: write(join(h.root, "setup-ran"), "'yes'"), timeoutSeconds: 30 }],
    });
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "skip");
    await waitFor(() => h.providers[1]?.prompts.length === 1, "declining setup did not let the switch finish");
    const worktree = h.store.readMeta(h.sessionId)!.worktrees![0]!;
    assert.equal(existsSync(join(h.root, "setup-ran")), false);
    assert.equal(worktree.setup?.status, "declined");
    assert.equal(h.providers[1]!.env?.SWITCH_SETUP_VALUE, undefined);
    assert.equal(h.providers[1]!.env?.WOLLIPOG_WORKTREE_PATH, worktree.path, "the runner's own identity still arrives");
    assert.equal(payloads(h, "permission_request").length, 1, "the relaunch does not ask again");
  });
});

test("a Stop that cancels setup fails the switch visibly, and the worktree goes with its running step", async () => {
  await withSession("cancelled", async (h) => {
    commitSetup(h, { setup: [{ name: "Long Step", command: sleep, timeoutSeconds: 300 }] });
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => stderrText(h).some((text) => text.startsWith("Running worktree setup")), "setup did not start");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    h.manager.stop(h.sessionId);
    await waitFor(() => failure(h) !== undefined, "the canceled setup did not fail the switch");
    assertStayed(h);
    assert.equal(failure(h)!.reason, "the target's worktree setup was canceled");
    assert.equal(h.store.readMeta(h.sessionId)?.status, "stopped");
    await waitFor(() => docsWorktrees(h).length === 1, "the worktree was not released");
    assert.ok(git(h.docs, "rev-parse", "--verify", "refs/heads/fix/install-link"));
    assert.equal(h.providers.length, 1, "no provider was launched for a stopped session");
  });
});

test("while setup runs, another session's switch to the same branch is refused rather than taking the half-set-up worktree", async () => {
  await withSession("claimed", async (h) => {
    commitSetup(h, { setup: [{ name: "Long Step", command: sleep, timeoutSeconds: 300 }] });
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => stderrText(h).some((text) => text.startsWith("Running worktree setup")), "setup did not start");
    const [, target] = docsWorktrees(h);
    assert.ok(target);

    const other = "s_switch_setup_other";
    await h.manager.start({ sessionId: other, workspaceId: "app", workspacePath: h.app, agentId: "claude-code", command: "claude-code",
      args: [], env: {}, useWorktree: false, driver: "claude-code", context: { kind: "native" } });
    h.manager.prompt(other, "start the other task");
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(other)?.status === "idle" &&
      !!h.store.readMeta(other)?.agentSessionId, "the other session did not finish a turn");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ sessionId: other, occurrenceId: "occurrence-other" })), { ok: true });
    await waitFor(() => h.store.readMeta(other)?.locationSwitchFailure !== undefined || h.store.readMeta(other)?.repoPath === h.docs,
      "the other switch did not settle");

    const meta = h.store.readMeta(other)!;
    assert.equal(meta.repoPath, h.app, "the other session stays where it was");
    assert.match(meta.locationSwitchFailure!.reason!, new RegExp(`which session ${h.sessionId} is using`, "u"),
      "the refusal names the session setting it up, and that it is in use rather than being removed");
    assert.equal(h.store.readMeta(h.sessionId)?.pendingLocationSwitch?.occurrenceId, "occurrence-1", "the first switch is unaffected");
    assert.deepEqual(docsWorktrees(h), [h.docs, target]);
  });
});

test("a target another switch has claimed is refused before Git creates anything: no setup, no removal, no takeover", async () => {
  await withSession("claimed-first", async (h) => {
    commitSetup(h, { setup: [{ name: "Prepare Target", command: write(join(h.root, "setup-ran"), "'yes'"), timeoutSeconds: 30 }] });
    // Model the other switch getting there first: the first holder this switch sees for the path it
    // is about to create is that session.
    const runner = h.manager as unknown as {
      worktreeHolder: (sessionId: string, context: unknown, path: string) => unknown;
      reusedWorktreeClaims: Map<string, string>;
    };
    const holder = runner.worktreeHolder.bind(h.manager);
    let contested: string | undefined;
    runner.worktreeHolder = (sessionId, context, path) => {
      if (sessionId === h.sessionId && !contested) {
        contested = path;
        runner.reusedWorktreeClaims.set(path, "s_switch_setup_first");
      }
      return holder(sessionId, context, path);
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the losing switch was not refused");

    assert.match(failure(h)!.reason!, /is held by session s_switch_setup_first/u);
    assertStayed(h);
    assert.equal(runner.reusedWorktreeClaims.get(contested!), "s_switch_setup_first", "the winner's claim is not overwritten");
    assert.deepEqual(docsWorktrees(h), [h.docs], "this switch made nothing");
    assert.deepEqual(journal(h), [], "and left no rollback that could take the winner's worktree later");
    assert.equal(existsSync(join(h.root, "setup-ran")), false, "no setup runs in another session's worktree");
    assert.deepEqual(payloads(h, "permission_request"), []);
    assert.equal(h.providers.length, 1);
  });
});

/** Move into docs, do real work in that worktree, and move away again, leaving the worktree behind
 * as this session's own from an earlier Location. `config` is committed there as part of the work,
 * so it is what a setup would read at the worktree's head on the way back. */
async function leaveWorkBehind(h: Harness, recoverBranch: string | undefined, config: unknown): Promise<string> {
  if (!recoverBranch) serveOriginLocally(h);
  git(h.app, "branch", "away");
  assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch })), { ok: true });
  await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the first move did not finish");
  const worktree = h.store.readMeta(h.sessionId)!.worktreePath!;
  writeFileSync(join(worktree, "tracked.txt"), "committed\n");
  writeFileSync(join(worktree, ".wollipog.json"), typeof config === "string" ? config : JSON.stringify({ version: 1, ...config as object }));
  git(worktree, "add", "tracked.txt", ".wollipog.json");
  git(worktree, "commit", "--quiet", "-m", "unpushed work");
  writeFileSync(join(worktree, "tracked.txt"), "edited, never committed\n");
  writeFileSync(join(worktree, "staged.txt"), "staged only\n");
  git(worktree, "add", "staged.txt");
  writeFileSync(join(worktree, "untracked.txt"), "untracked notes\n");
  if (!recoverBranch) {
    // On its own branch a setup would read the remote default branch, so the configuration goes there too.
    writeFileSync(join(h.docs, ".wollipog.json"), typeof config === "string" ? config : JSON.stringify({ version: 1, ...config as object }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "setup on the default branch");
    git(join(h.root, "docs-origin.git"), "fetch", "--quiet", h.docs, "main:main");
  }
  assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ workspaceId: "app", workspacePath: h.app, repository: "acme/app",
    locationName: "App", occurrenceId: "occurrence-away", recoverBranch: "away" })), { ok: true });
  await waitFor(() => h.providers[2]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move away did not finish");
  assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.app);
  return worktree;
}

function workState(worktree: string, branch: string) {
  return { files: files(worktree), head: git(worktree, "rev-parse", "HEAD"), branch: git(worktree, "rev-parse", "--abbrev-ref", "HEAD"),
    status: git(worktree, "status", "--porcelain=v1", "--untracked-files=all"), tip: git(worktree, "rev-parse", `refs/heads/${branch}`),
    log: git(worktree, "log", "--format=%s", "-1") };
}

for (const { path, recoverBranch } of [{ path: "recovered branch", recoverBranch: "fix/install-link" }, { path: "own branch", recoverBranch: undefined }]) {
  for (const { failure: kind, config, answer } of [
    { failure: "failing required step", config: FAILING_STEP, answer: "trust" as const },
    { failure: "dismissed trust card", config: FAILING_STEP, answer: null },
    { failure: "invalid configuration", config: "{\"version\":99}", answer: null },
  ]) {
    test(`switching back to its own worktree (${path}) with a ${kind} there leaves its work byte for byte, and runs no setup`, async () => {
      if (!recoverBranch && process.platform === "win32") return;
      await withSession(`back-${path}-${kind}`.replaceAll(" ", "-"), async (h) => {
        const worktree = await leaveWorkBehind(h, recoverBranch, config);
        const branch = recoverBranch ?? `agent/${h.sessionId}`;
        const before = workState(worktree, branch);
        assert.equal(before.log, "unpushed work");
        assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch, occurrenceId: "occurrence-back" })), { ok: true });
        // If setup ever ran here, this is the person's decision that would drive its failure.
        const settled = () => h.providers[3]?.prompts.length === 1 || failure(h) !== undefined;
        await waitFor(() => settled() || payloads(h, "permission_request").length > 0, "the switch back did not settle");
        if (!settled()) {
          h.manager.resolvePermission(h.sessionId, payloads(h, "permission_request")[0].requestId, answer);
          await waitFor(settled, "the switch back did not settle after the card");
        }
        assert.deepEqual(workState(worktree, branch), before, "nothing in the worktree or on its branch changed");
        assert.deepEqual(docsWorktrees(h), [h.docs, worktree]);
        assert.equal(failure(h), undefined, "continuing in its own worktree needs no setup, so nothing fails");
        assert.deepEqual(payloads(h, "permission_request"), [], "no trust is asked for, because no setup runs");
        assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, worktree);
        assert.deepEqual(journal(h), [], "no rollback was ever recorded for a worktree this attempt did not make");
      });
    });
  }

  test(`a later failure on the way back to its own worktree (${path}) fails the switch and removes nothing`, async () => {
    if (!recoverBranch && process.platform === "win32") return;
    await withSession(`back-late-${path}`.replaceAll(" ", "-"), async (h) => {
      const worktree = await leaveWorkBehind(h, recoverBranch, {});
      const branch = recoverBranch ?? `agent/${h.sessionId}`;
      const before = workState(worktree, branch);
      // The conversation can no longer be carried over: the failure lands after preparation.
      rmSync(join(h.root, "claude-home", "projects"), { recursive: true, force: true });
      assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch, occurrenceId: "occurrence-back" })), { ok: true });
      await waitFor(() => failure(h) !== undefined, "the switch back did not fail");
      assert.match(failure(h)!.reason!, /the conversation could not be carried over/u);
      assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.app);
      assert.deepEqual(workState(worktree, branch), before);
      assert.deepEqual(docsWorktrees(h), [h.docs, worktree]);
      assert.doesNotMatch(failure(h)!.reason!, /still at/u, "nothing was to be removed, so nothing is reported as left behind");
    });
  });
}

test("back in a worktree set up earlier, the provider gets its environment again and setup does not repeat", async () => {
  await withSession("back-set-up", async (h) => {
    const ranLog = join(h.root, "ran");
    commitSetup(h, {
      environment: { SWITCH_SETUP_VALUE: "from-setup" },
      setup: [{ name: "Prepare Target", command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(ranLog)},'x')`], timeoutSeconds: 30 }],
    });
    git(h.app, "branch", "away");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the first move did not finish");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ workspaceId: "app", workspacePath: h.app, repository: "acme/app",
      locationName: "App", occurrenceId: "occurrence-away", recoverBranch: "away" })), { ok: true });
    await waitFor(() => h.providers[2]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move away did not finish");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-back" })), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1, "the move back did not finish");
    assert.equal(readFileSync(ranLog, "utf8"), "x", "setup ran once, when the worktree was made");
    assert.equal(h.providers[3]!.env?.SWITCH_SETUP_VALUE, "from-setup");
    assert.equal(h.store.readMeta(h.sessionId)!.worktrees![0]!.setup?.status, "completed");
  });
});

test("a rollback that cannot finish says the worktree is still there, and no switch moves into it until the removal is done", async () => {
  await withSession("removal-pending", async (h) => {
    const letItPass = join(h.root, "let-it-pass");
    commitSetup(h, { setup: [
      { name: "Leave a File", command: write("from-setup", "'x'"), timeoutSeconds: 30 },
      { name: "Maybe Fail", command: [process.execPath, "-e", `process.exit(require('fs').existsSync(${JSON.stringify(letItPass)}) ? 0 : 3)`], timeoutSeconds: 30 },
    ] });
    // A process that will not die is what keeps a removal from finishing.
    const internals = h.manager as unknown as { retireWorktreeProcesses: (...args: unknown[]) => Promise<void> };
    const retire = internals.retireWorktreeProcesses.bind(h.manager);
    let stuck = true;
    internals.retireWorktreeProcesses = async (...args) => {
      if (stuck) throw new Error("worktree descendant process retirement is unconfirmed");
      return retire(...args);
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    const [, target] = docsWorktrees(h);
    assert.ok(target, "the worktree is still there");
    assert.match(failure(h)!.reason!, /^the target's required worktree setup failed: /u, "the cause comes first");
    assert.ok(failure(h)!.reason!.includes(`The target worktree could not be removed and is still at ${target}.`), "and then what is left, and where");
    assertStayed(h);
    assert.equal(journal(h).length, 1);

    // Asked again with the removal still stuck: refused, and the session stays out.
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-2" })), { ok: true });
    await waitFor(() => failure(h)?.reason?.includes("still removing") === true, "the retry was not refused");
    assert.ok(failure(h)!.reason!.includes(target), "the refusal says where");
    assertStayed(h);
    assert.equal(h.providers.length, 1);
    assert.equal(existsSync(join(target, "from-setup")), true);

    // Once the removal can finish, asking again carries it out first and then moves as new.
    stuck = false;
    writeFileSync(letItPass, "");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-3" })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 || h.store.readMeta(h.sessionId)?.pendingLocationSwitch === undefined &&
      failure(h)?.at !== undefined && !failure(h)!.reason!.includes("still removing"), "the third attempt did not settle");
    assert.equal(failure(h), undefined);
    assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.docs);
    assert.deepEqual(journal(h), [], "the move commits the worktree, so no rollback remains");
  });
});

/** In docs on fix/install-link, with a trusted setup whose teardown logs where it ran. */
async function inSetUpWorktree(h: Harness, teardownLog: string): Promise<{ id: string; path: string; marker: string; hooks: unknown }> {
  commitSetup(h, {
    setup: [{ name: "Prepare Docs", command: write("from-docs-setup", "'x'"), timeoutSeconds: 30 }],
    teardown: [{ name: "Clean Docs", command: [process.execPath, "-e",
      `require('fs').appendFileSync(${JSON.stringify(teardownLog)},process.cwd()+'\\n')`], timeoutSeconds: 30 }],
  });
  assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
  await answerTrust(h, "trust");
  await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move to docs did not finish");
  const meta = h.store.readMeta(h.sessionId)!;
  const worktree = meta.worktrees![0]!;
  return { id: worktree.id, path: worktree.path, marker: meta.worktreeProcessMarkers![worktree.id]!, hooks: meta.worktreeHooks![worktree.id] };
}

/** The same branch name in the app repository, whose setup fails as `config` says. */
function appBranchWithConfig(h: Harness, config: unknown): SessionLocationSwitchMessage {
  git(h.app, "checkout", "--quiet", "-b", "fix/install-link");
  writeFileSync(join(h.app, ".wollipog.json"), typeof config === "string" ? config : JSON.stringify({ version: 1, ...config as object }));
  git(h.app, "add", ".wollipog.json");
  git(h.app, "commit", "--quiet", "-m", "setup");
  git(h.app, "checkout", "--quiet", "main");
  return h.message({ workspaceId: "app", workspacePath: h.app, repository: "acme/app", locationName: "App", occurrenceId: "occurrence-app" });
}

test("a switch to the same branch name in another repository inherits nothing from the worktree it is leaving", async () => {
  await withSession("same-branch-card", async (h) => {
    const teardownLog = join(h.root, "teardown-log");
    const current = await inSetUpWorktree(h, teardownLog);
    assert.deepEqual(await h.manager.requestLocationSwitch(appBranchWithConfig(h, { setup: [{ name: "Prepare App", command: fail, timeoutSeconds: 30 }] })), { ok: true });
    await waitFor(() => payloads(h, "permission_request").length === 2, "the app's trust card did not open");
    const [record] = journal(h);
    assert.notEqual(record?.worktreeId, current.id, "two repositories never share a worktree identity");
    assert.equal(record?.hooks, undefined, "before its own setup is trusted, the attempt has no teardown at all");
    assert.notEqual(record?.processMarker, current.marker);

    // Dismissing the card gives the worktree back without running the docs teardown in it.
    h.manager.resolvePermission(h.sessionId, payloads(h, "permission_request")[1].requestId, null);
    await waitFor(() => failure(h) !== undefined, "the dismissed card did not fail the switch");
    await waitFor(() => journal(h).length === 0, "the app worktree was not given back");
    assert.equal(existsSync(teardownLog), false, "no teardown ran anywhere");
  });
});

for (const { kind, config, trust } of [
  { kind: "an invalid configuration", config: "{\"version\":99}", trust: false },
  { kind: "a failing required step", config: { setup: [{ name: "Prepare App", command: fail, timeoutSeconds: 30 }] }, trust: true },
]) {
  test(`${kind} on the same branch name elsewhere leaves the current worktree's hooks, marker and port block alone`, async () => {
    await withSession(`same-branch-${trust ? "step" : "invalid"}`, async (h) => {
      const teardownLog = join(h.root, "teardown-log");
      const current = await inSetUpWorktree(h, teardownLog);
      const allocator = (h.manager as unknown as { worktreePortAllocator: { get(owner: string): unknown } }).worktreePortAllocator;
      const owner = `${h.sessionId}\0${current.id}`;
      const block = allocator.get(owner);
      assert.ok(block);

      assert.deepEqual(await h.manager.requestLocationSwitch(appBranchWithConfig(h, config)), { ok: true });
      if (trust) {
        await waitFor(() => payloads(h, "permission_request").length === 2, "the app's trust card did not open");
        h.manager.resolvePermission(h.sessionId, payloads(h, "permission_request")[1].requestId, "trust");
      }
      await waitFor(() => failure(h) !== undefined, "the switch did not fail");
      await waitFor(() => journal(h).length === 0, "the app worktree was not given back");

      const meta = h.store.readMeta(h.sessionId)!;
      assert.equal(meta.worktreePath, current.path, "the session stays where it was");
      assert.deepEqual(meta.worktreeHooks?.[current.id], current.hooks);
      assert.equal(meta.worktreeProcessMarkers?.[current.id], current.marker);
      assert.deepEqual(allocator.get(owner), block);
      assert.equal(existsSync(teardownLog), false, "the docs teardown did not run in the app worktree");
      assert.equal(existsSync(join(current.path, "from-docs-setup")), true);

      // That teardown is still there for when the worktree really goes.
      h.manager.stop(h.sessionId);
      await h.manager.delete(h.sessionId);
      await waitFor(() => existsSync(teardownLog), "the current worktree lost its teardown");
      assert.equal(readFileSync(teardownLog, "utf8").trim(), current.path, "and it ran where it belongs");
    });
  });
}

test("a worktree remade on a path this session used before takes no teardown from the worktree that was there", async () => {
  await withSession("remade-path", async (h) => {
    const teardownLog = join(h.root, "teardown-log");
    const earlier = await inSetUpWorktree(h, teardownLog);
    git(h.app, "branch", "away");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ workspaceId: "app", workspacePath: h.app, repository: "acme/app",
      locationName: "App", occurrenceId: "occurrence-away", recoverBranch: "away" })), { ok: true });
    await waitFor(() => h.providers[2]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move away did not finish");
    // The worktree is gone from disk, though the session's records still hold its teardown.
    git(h.docs, "worktree", "remove", "--force", earlier.path);
    commitSetup(h, "{\"version\":99}");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-back" })), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the switch did not fail");
    await waitFor(() => journal(h).length === 0, "the new worktree was not given back");
    assert.match(failure(h)!.reason!, /configuration is invalid/u);
    assert.equal(existsSync(teardownLog), false, "the old worktree's teardown never ran on the new one");
    assert.deepEqual(docsWorktrees(h), [h.docs]);
  });
});

test("a worktree remade with no setup keeps no teardown or marker from the worktree that was on that path", async () => {
  await withSession("remade-no-setup", async (h) => {
    const teardownLog = join(h.root, "teardown-log");
    const earlier = await inSetUpWorktree(h, teardownLog);
    git(h.app, "branch", "away");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ workspaceId: "app", workspacePath: h.app, repository: "acme/app",
      locationName: "App", occurrenceId: "occurrence-away", recoverBranch: "away" })), { ok: true });
    await waitFor(() => h.providers[2]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move away did not finish");
    git(h.docs, "worktree", "remove", "--force", earlier.path);
    git(h.docs, "checkout", "--quiet", "fix/install-link");
    git(h.docs, "rm", "--quiet", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "no setup any more");
    git(h.docs, "checkout", "--quiet", "main");

    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-back" })), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1, "the move back did not finish");
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.worktreePath, earlier.path, "the new worktree is on the same path");
    assert.equal(meta.worktreeHooks?.[earlier.id], undefined, "the old worktree's teardown is not this one's");
    assert.notEqual(meta.worktreeProcessMarkers?.[earlier.id], earlier.marker);
    assert.deepEqual(journal(h), []);

    h.manager.stop(h.sessionId);
    await h.manager.delete(h.sessionId);
    await waitFor(() => !existsSync(earlier.path), "the worktree was not removed with the session");
    assert.equal(existsSync(teardownLog), false, "no teardown from the old worktree ran on the new one");
  });
});

test("the worktree is claimed and on record before Git makes it, so no crash or other session finds it unaccounted for", async () => {
  await withSession("write-ahead", async (h) => {
    const internals = h.manager as unknown as {
      cleanupJournal: { add(record: WorktreeCleanupRecord): void };
      reusedWorktreeClaims: Map<string, string>;
    };
    const add = internals.cleanupJournal.add.bind(internals.cleanupJournal);
    let first: { worktrees: string[]; claim: string | undefined; marker: string | undefined } | undefined;
    internals.cleanupJournal.add = (record) => {
      first ??= { worktrees: docsWorktrees(h), claim: internals.reusedWorktreeClaims.get(record.worktreePath), marker: record.processMarker };
      add(record);
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the move did not finish");
    assert.deepEqual(first?.worktrees, [h.docs], "Git had not made the worktree yet");
    assert.equal(first?.claim, h.sessionId, "the claim was already in place");
    assert.ok(first?.marker, "the marker setup's processes will carry was already on record");
  });
});

test("a recovered branch that cannot be checked out fails the switch and leaves no record, worktree or claim behind", async () => {
  if (process.platform === "win32") return;
  await withSession("never-checked-out", async (h) => {
    // The branch is on neither side, and asking the remote fails at once.
    const shim = join(h.root, "no-remote.sh");
    writeFileSync(shim, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    git(h.docs, "config", "core.sshCommand", shim);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: "fix/no-such-branch" })), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the switch did not fail");
    assert.match(failure(h)!.reason!, /^the target worktree could not be prepared: /u);
    assert.doesNotMatch(failure(h)!.reason!, /still at/u, "nothing was made, so nothing is reported as left behind");
    assertStayed(h);
    assert.deepEqual(journal(h), [], "the reservation is given back");
    assert.deepEqual(docsWorktrees(h), [h.docs]);
    const claims = (h.manager as unknown as { reusedWorktreeClaims: Map<string, string> }).reusedWorktreeClaims;
    assert.equal(claims.size, 0);
  });
});

test("after a real restart, a forced removal is never replayed against a worktree a session now uses", async () => {
  await withSession("replay-in-use", async (h) => {
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const meta = h.store.readMeta(h.sessionId)!;
    const worktree = meta.worktrees![0]!;
    writeFileSync(join(worktree.path, "uncommitted.txt"), "the session's work\n");
    const before = files(worktree.path);
    // What an earlier runner left, or a crash between the move's write and clearing its rollback.
    const internals = h.manager as unknown as {
      cleanupRecordForWorktree: (meta: unknown, worktree: unknown, trigger: string, mode: string) => WorktreeCleanupRecord;
      cleanupJournal: { add(record: WorktreeCleanupRecord): void };
    };
    const stale = internals.cleanupRecordForWorktree(meta, worktree, "creation_rollback", "force");
    stale.auxiliaryWorktreeRollback = true;
    internals.cleanupJournal.add(stale);

    h.restart();
    await waitFor(() => journal(h).length === 0, "the stale rollback was not dropped");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(files(worktree.path), before, "the worktree is untouched");
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, worktree.path, "and the session still has it selected");
    assert.deepEqual(docsWorktrees(h), [h.docs, worktree.path]);
  });
});

test("a runner going down during setup keeps the approved switch owed, and gives the worktree back", async () => {
  await withSession("shutdown", async (h) => {
    commitSetup(h, { setup: [{ name: "Long Step", command: sleep, timeoutSeconds: 300 }] });
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => stderrText(h).some((text) => text.startsWith("Running worktree setup")), "setup did not start");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    h.manager.shutdownAll();
    await waitFor(() => docsWorktrees(h).length === 1, "the worktree was not released");
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.pendingLocationSwitch?.occurrenceId, "occurrence-1", "the switch runs again once the runner is back");
    assert.equal(meta.locationSwitchFailure, undefined);
    assert.equal(meta.repoPath, h.app);
  });
});

test("a turn that begins once setup has finished defers the switch: the worktree goes back through teardown and setup runs again", async () => {
  await withSession("deferred", async (h) => {
    const teardownLog = join(h.root, "teardown-log");
    commitSetup(h, {
      setup: [{ name: "Prepare Target", command: write(join(h.root, "setup-ran"), "'yes'"), timeoutSeconds: 30 }],
      teardown: [{ name: "Clean Target", command: [process.execPath, "-e",
        `require('fs').appendFileSync(${JSON.stringify(teardownLog)},'x')`], timeoutSeconds: 30 }],
    });
    // Model a provider-initiated turn beginning during setup: the readiness check after it says no once.
    const manager = h.manager as unknown as { worktreeRebindCanProceed: (sessionId: string, entry: unknown) => boolean };
    const canProceed = manager.worktreeRebindCanProceed.bind(h.manager);
    let refused = false;
    manager.worktreeRebindCanProceed = (sessionId, entry) => {
      if (!refused && existsSync(join(h.root, "setup-ran")) && !h.store.readMeta(sessionId)?.pendingApproval) {
        refused = true;
        return false;
      }
      return canProceed(sessionId, entry);
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => refused, "setup never finished");
    await waitFor(() => existsSync(teardownLog), "the given-back worktree's teardown did not run");
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the deferred switch did not finish");

    assert.equal(readFileSync(teardownLog, "utf8"), "x", "torn down once, and the moved worktree is still set up");
    const meta = h.store.readMeta(h.sessionId)!;
    assert.equal(meta.repoPath, h.docs);
    assert.equal(meta.worktrees![0]!.setup?.status, "completed");
    assert.equal(existsSync(meta.worktrees![0]!.path), true);
  });
});

test("a worktree reused in place never runs setup, even with a configuration on its branch", async () => {
  await withSession("reused", async (h) => {
    commitSetup(h, {
      environment: { SWITCH_SETUP_VALUE: "from-setup" },
      setup: [{ name: "Prepare Target", command: write("setup-ran", "'yes'"), timeoutSeconds: 30 }],
      copyFiles: [{ source: ".env.local", destination: ".env.local" }],
    });
    writeFileSync(join(h.docs, ".env.local"), "copied");
    const existing = join(h.root, "someone-elses-worktree");
    git(h.docs, "worktree", "add", "--quiet", existing, "fix/install-link");
    writeFileSync(join(existing, "their-work.txt"), "uncommitted");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the session did not continue in the existing worktree");

    const meta = h.store.readMeta(h.sessionId)!;
    const worktree = meta.worktrees![0]!;
    assert.deepEqual([worktree.path, worktree.source, worktree.reusedInPlace], [realpathSync(existing), "attached", true]);
    assert.deepEqual(payloads(h, "permission_request"), [], "nothing asks for trust");
    assert.equal(existsSync(join(existing, "setup-ran")), false, "no step ran");
    assert.equal(existsSync(join(existing, ".env.local")), false, "nothing was copied");
    assert.equal(readFileSync(join(existing, "their-work.txt"), "utf8"), "uncommitted");
    assert.equal(worktree.setup, undefined);
    assert.equal(worktree.setupConfig, undefined);
    assert.equal(worktree.portBlock, undefined);
    assert.deepEqual(Object.keys(meta.worktreeHooks ?? {}), []);
    assert.equal(h.providers[1]!.env?.SWITCH_SETUP_VALUE, undefined);
    assert.equal(stderrText(h).some((text) => text.includes("worktree setup")), false);
  });
});

test("a repository with no setup configuration switches as before: no card, no setup, no hooks", async () => {
  await withSession("absent", async (h) => {
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the session did not continue in its new Location");
    const worktree = h.store.readMeta(h.sessionId)!.worktrees![0]!;
    assert.deepEqual(payloads(h, "permission_request"), []);
    assert.equal(worktree.setup, undefined);
    assert.deepEqual(worktree.setupConfig, { status: "absent" });
    assert.deepEqual(h.providers[1]!.prompts, ["Continue the docs fix here."]);
    assert.equal(stderrText(h).some((text) => text.includes("worktree setup")), false);
    assert.deepEqual(Object.keys(h.store.readMeta(h.sessionId)!.worktreeHooks ?? {}), []);
  });
});

test("a failure before any setup ran gives back the port block the target reserved", async () => {
  await withSession("port", async (h) => {
    commitSetup(h, "{\"version\":99}");
    const allocator = (h.manager as unknown as {
      worktreePortAllocator: { allocate(owner: string, preferred?: unknown): unknown; get(owner: string): unknown };
    }).worktreePortAllocator;
    const allocate = allocator.allocate.bind(allocator);
    const owners: string[] = [];
    allocator.allocate = (owner, preferred) => {
      owners.push(owner);
      return allocate(owner, preferred);
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the invalid configuration did not fail the switch");
    assert.equal(owners.length, 1, "preparing the target reserved a port block");
    assert.equal(allocator.get(owners[0]!), undefined, "a worktree that is gone holds no ports");
  });
});

// The rest of #4209: what can still lose work or leave a session stuck on the way into a Location.

interface Internals {
  retireWorktreeProcesses: (...args: unknown[]) => Promise<void>;
  replayDeferredWorktreeRetirements: () => Promise<void>;
  worktreeRebindCanProceed: (sessionId: string, entry: unknown) => boolean;
  replaceProviderProcess: (...args: unknown[]) => Promise<{ status: string }>;
  activateWorktreeWithNotice: (...args: unknown[]) => Promise<unknown>;
  discoverUnlinkedMergedWorktree: (...args: unknown[]) => Promise<unknown>;
  proveMergedPullRequestContainment: (...args: unknown[]) => Promise<unknown>;
  worktreePullRequestDiscoveryNow: () => number;
  removeWorktreeCleanupRecord: (...args: unknown[]) => boolean;
  worktreePortAllocator: { allocate(owner: string, preferred?: unknown): { start: number; end: number; size: number };
    release(owner: string): boolean; get(owner: string): unknown };
  cleanupRecordForWorktree: (meta: unknown, worktree: unknown, trigger: string, mode: string) => WorktreeCleanupRecord;
  cleanupJournal: { add(record: WorktreeCleanupRecord): void };
}
const internalsOf = (h: Harness) => h.manager as unknown as Internals;

const errorText = (h: Harness) => payloads(h, "error").map((payload) => String(payload.message));

/** A removal that cannot finish, because a process will not die, until `free` is called. */
function stickRemoval(h: Harness): { free: () => void; attempts: () => number } {
  const internals = internalsOf(h);
  const retire = internals.retireWorktreeProcesses.bind(h.manager);
  let stuck = true;
  let attempts = 0;
  internals.retireWorktreeProcesses = async (...args) => {
    attempts++;
    if (stuck) throw new Error("worktree descendant process retirement is unconfirmed");
    return retire(...args);
  };
  return { free: () => { stuck = false; }, attempts: () => attempts };
}

const backToDocs = (h: Harness, recoverBranch: string | undefined, occurrenceId = "occurrence-back") =>
  h.manager.requestLocationSwitch(h.message({ recoverBranch, occurrenceId }));

const moveAway = (h: Harness, occurrenceId = "occurrence-away") => h.manager.requestLocationSwitch(h.message({
  workspaceId: "app", workspacePath: h.app, repository: "acme/app", locationName: "App", occurrenceId, recoverBranch: "away",
}));

/** Where this session's worktree for `branch` goes in the docs repository. */
async function docsSlot(h: Harness, branch: string): Promise<string> {
  return join(await requestedWorktreeBoundary(h.docs, h.sessionId, { dataDir: join(h.root, "data") }), requestedSlot(branch));
}

/** After a restart, a message is what launches the provider again, and it finishes a turn there. */
async function relaunch(h: Harness, workspaceId: string, workspacePath: string): Promise<void> {
  const launched = h.providers.length;
  // A dead process's lease is reclaimed by its pid. This "restart" shares the test's pid, so model that.
  const lease = h.store.readWorktreeLease(h.sessionId);
  if (lease) h.store.releaseWorktreeLease(h.sessionId, lease.owner);
  await h.manager.start({ sessionId: h.sessionId, workspaceId, workspacePath, agentId: "claude-code", command: "claude-code",
    args: [], env: {}, useWorktree: false, driver: "claude-code", context: { kind: "native" } });
  h.manager.prompt(h.sessionId, "carry on");
  await waitFor(() => h.providers[launched]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the relaunch did not finish a turn");
}

/** The admin entry goes while the volume is away and the directory comes back with everything in it. */
function pruneWhileUnmounted(h: Harness, worktree: string): void {
  const away = `${worktree}.unmounted`;
  renameSync(worktree, away);
  git(h.docs, "worktree", "prune");
  renameSync(away, worktree);
  assert.deepEqual(docsWorktrees(h), [h.docs], "Git no longer lists it");
}

test("a directory whose registration is gone is refused byte for byte on the way back, and says what to do", async () => {
  await withSession("stale-marker", async (h) => {
    const worktree = await leaveWorkBehind(h, "fix/install-link", {});
    const before = files(worktree);
    const marker = readFileSync(join(worktree, ".git"), "utf8");
    const tip = git(h.docs, "rev-parse", "refs/heads/fix/install-link");
    pruneWhileUnmounted(h, worktree);

    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    await waitFor(() => failure(h) !== undefined || h.providers[3]?.prompts.length === 1, "the switch back did not settle");

    assert.deepEqual(files(worktree), before, "every file is still there, unchanged");
    assert.equal(readFileSync(join(worktree, ".git"), "utf8"), marker);
    assert.equal(git(h.docs, "rev-parse", "refs/heads/fix/install-link"), tip);
    assert.ok(failure(h)!.reason!.includes(worktree), "it names the directory");
    assert.match(failure(h)!.reason!, /no longer registered/u);
    assert.match(failure(h)!.reason!, /move anything you want to keep/iu);
    assert.doesNotMatch(failure(h)!.reason!, /still at/u, "the switch made nothing, so it reports nothing left behind");
    assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.app);
    assert.deepEqual(journal(h), [], "no record is left to retry against someone's files");

    // Following what it says works, and nothing was stuck in the meantime.
    h.restart();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(files(worktree), before, "a restart does not touch it either");
    rmSync(worktree, { recursive: true, force: true });
    await relaunch(h, "app", h.app);
    assert.deepEqual(await backToDocs(h, "fix/install-link", "occurrence-after"), { ok: true });
    // A new worktree on a branch with a configuration: it is set up as any other new one is.
    await answerTrust(h, "trust");
    await waitFor(() => h.store.readMeta(h.sessionId)?.repoPath === h.docs, "the switch did not succeed once the directory was gone");
    assert.equal(failure(h), undefined);
    assert.deepEqual(journal(h), []);
  });
});

for (const { replay, older } of [
  { replay: "restart", older: false },
  { replay: "periodic sweep", older: false },
  { replay: "restart", older: true },
  { replay: "periodic sweep", older: true },
] as const) {
  test(`a rollback ${older ? "an older runner wrote" : "left by a foreign directory"} never removes the session's own new worktree on that slot (${replay})`, async () => {
    if (process.platform === "win32") return;
    await withSession(`proof-${replay}-${older}`.replaceAll(" ", "-"), async (h) => {
      serveOriginLocally(h);
      const branch = `agent/${h.sessionId}`;
      const slot = await docsSlot(h, branch);
      mkdirSync(slot, { recursive: true });
      writeFileSync(join(slot, "not-ours.txt"), "someone's file\n");

      assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined })), { ok: true });
      await waitFor(() => failure(h) !== undefined, "the foreign directory did not fail the switch");
      assert.equal(readFileSync(join(slot, "not-ours.txt"), "utf8"), "someone's file\n");
      assert.match(failure(h)!.reason!, /move or delete/iu, "it says what to do");

      // The person deletes the directory; the session arrives another way and then makes that slot its own.
      rmSync(slot, { recursive: true, force: true });
      assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-2" })), { ok: true });
      await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
      const first = h.store.readMeta(h.sessionId)!.worktreePath!;
      await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch });
      writeFileSync(join(slot, "tracked.txt"), "committed\n");
      git(slot, "add", "tracked.txt");
      git(slot, "commit", "--quiet", "-m", "the session's own commit");
      writeFileSync(join(slot, "uncommitted.txt"), "the session's own work\n");
      await h.manager.selectWorktree(h.sessionId, first);

      if (older) {
        // A record from before proofs existed, for the same slot: it carries none.
        const meta = h.store.readMeta(h.sessionId)!;
        const row = meta.worktrees!.find((item) => item.path === slot)!;
        const stale = internalsOf(h).cleanupRecordForWorktree(meta, row, "creation_rollback", "force");
        stale.auxiliaryWorktreeRollback = true;
        internalsOf(h).cleanupJournal.add(stale);
      }
      const owned = h.store.readMeta(h.sessionId)!.worktrees!.find((item) => item.path === slot)!;
      const before = workState(slot, branch);

      if (replay === "restart") h.restart();
      else {
        const later = Date.now() + 24 * 60 * 60 * 1000;
        internalsOf(h).worktreePullRequestDiscoveryNow = () => later;
        await internalsOf(h).replayDeferredWorktreeRetirements();
      }
      await waitFor(() => journal(h).length === 0, "the mismatched record was not dropped");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(workState(slot, branch), before, "the session's worktree and its branch are untouched");
      assert.ok(h.store.readMeta(h.sessionId)!.worktrees!.some((item) => item.path === slot), "and it still owns it");
      assert.deepEqual(internalsOf(h).worktreePortAllocator.get(`${h.sessionId}\0${owned.id}`), owned.portBlock, "with its ports");
    });
  });
}

test("a rollback with no proof and nothing at its path leaves the branch of that name alone", async () => {
  await withSession("no-proof-absent", async (h) => {
    const branch = "agent/someone-elses-work";
    git(h.docs, "branch", branch);
    const tip = git(h.docs, "rev-parse", `refs/heads/${branch}`);
    const slot = await docsSlot(h, branch);
    const meta = h.store.readMeta(h.sessionId)!;
    // Reserved, and then Git never made it: this attempt made no branch either.
    const record = internalsOf(h).cleanupRecordForWorktree(
      { ...meta, repoPath: h.docs, worktreePath: slot, worktreeBranch: branch, worktrees: [] },
      { id: "reservation", path: slot, branch, baseRef: "main", source: "created" },
      "creation_rollback", "force");
    record.auxiliaryWorktreeRollback = true;
    internalsOf(h).cleanupJournal.add(record);
    h.restart();
    await waitFor(() => journal(h).length === 0, "the record was not settled");
    assert.equal(git(h.docs, "rev-parse", `refs/heads/${branch}`), tip);
  });
});

test("a registered worktree no proof ties to the rollback is kept: a restart removes nothing and drops the record", async () => {
  await withSession("no-proof-registered", async (h) => {
    // A crash between Git making the worktree and the proof being written leaves exactly this.
    const slot = await docsSlot(h, "fix/install-link");
    git(h.docs, "worktree", "add", "--quiet", slot, "fix/install-link");
    writeFileSync(join(slot, "notes.txt"), "kept\n");
    const meta = h.store.readMeta(h.sessionId)!;
    const record = internalsOf(h).cleanupRecordForWorktree(
      { ...meta, repoPath: h.docs, worktreePath: slot, worktreeBranch: "fix/install-link", worktrees: [] },
      { id: "reservation", path: slot, branch: "fix/install-link", baseRef: "fix/install-link", source: "created", branchPreexisted: true },
      "creation_rollback", "force");
    record.auxiliaryWorktreeRollback = true;
    internalsOf(h).cleanupJournal.add(record);
    const before = workState(slot, "fix/install-link");
    h.restart();
    await waitFor(() => journal(h).length === 0, "the unproved record was not dropped");
    assert.deepEqual(workState(slot, "fix/install-link"), before);
    assert.deepEqual(docsWorktrees(h), [h.docs, slot]);
  });
});

test("a rollback still pending for a branch refuses a request for that branch, and the request succeeds once it is done", async () => {
  await withSession("request-pending", async (h) => {
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const internals = internalsOf(h);
    const activate = internals.activateWorktreeWithNotice.bind(h.manager);
    internals.activateWorktreeWithNotice = async () => { throw new Error("activation failed"); };
    const removal = stickRemoval(h);
    await assert.rejects(h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/other" }), /activation failed/u);
    internals.activateWorktreeWithNotice = activate;
    assert.equal(journal(h).length, 1, "the failed request's rollback is stuck");

    await assert.rejects(h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/other" }), /still removing/u);
    assert.equal(journal(h).length, 1);

    removal.free();
    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/other" });
    assert.equal(existsSync(worktree.path), true);
    assert.deepEqual(journal(h), []);
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, worktree.path);
  });
});

test("a worktree that a stuck rollback names cannot be selected, so a later replay cannot take it from under the session", async () => {
  await withSession("select-pending", async (h) => {
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const first = h.store.readMeta(h.sessionId)!.worktreePath!;
    const internals = internalsOf(h);
    const activate = internals.activateWorktreeWithNotice.bind(h.manager);
    internals.activateWorktreeWithNotice = async () => { throw new Error("activation failed"); };
    const removal = stickRemoval(h);
    await assert.rejects(h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/other" }), /activation failed/u);
    internals.activateWorktreeWithNotice = activate;
    const [record] = journal(h);
    assert.ok(h.store.readMeta(h.sessionId)!.worktrees!.some((row) => row.path === record!.worktreePath), "the row is still listed");

    await assert.rejects(h.manager.selectWorktree(h.sessionId, record!.worktreePath), /still removing/u);
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, first, "the selection did not move");

    removal.free();
    const later = Date.now() + 24 * 60 * 60 * 1000;
    internals.worktreePullRequestDiscoveryNow = () => later;
    await internals.replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.equal(existsSync(record!.worktreePath), false);
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, first);
  });
});

for (const trigger of ["explicit_discard", "pull_request_reconciliation"] as const) {
  for (const replay of ["periodic sweep", "restart", "the switch itself"] as const) {
    test(`a ${trigger} deferred on a dirty worktree never blocks the session's way back, and never loses the work (${replay})`, async () => {
      if (process.platform === "win32") return;
      await withSession(`safe-${trigger}-${replay}`.replaceAll(" ", "-").replaceAll("_", "-"), async (h) => {
        serveOriginLocally(h);
        git(h.app, "branch", "away");
        assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined })), { ok: true });
        await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
        const meta = h.store.readMeta(h.sessionId)!;
        const worktree = meta.worktreePath!;
        const branch = `agent/${h.sessionId}`;
        writeFileSync(join(worktree, "tracked.txt"), "committed\n");
        git(worktree, "add", "tracked.txt");
        git(worktree, "commit", "--quiet", "-m", "unpushed work");
        writeFileSync(join(worktree, "tracked.txt"), "edited, never committed\n");
        writeFileSync(join(worktree, "untracked.txt"), "untracked notes\n");

        // The safe removal this deferred: the provider held it then, and the tree is dirty now.
        const internals = internalsOf(h);
        const record = internals.cleanupRecordForWorktree(meta, meta.worktrees![0], trigger, "safe");
        internals.cleanupJournal.add(record);
        await internals.replayDeferredWorktreeRetirements();
        assert.equal(journal(h).length, 1, "the worktree was in use, so the record waits");

        assert.deepEqual(await moveAway(h), { ok: true });
        await waitFor(() => h.providers[2]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move away did not finish");
        const before = workState(worktree, branch);

        if (replay === "periodic sweep") {
          await internalsOf(h).replayDeferredWorktreeRetirements();
          assert.deepEqual(journal(h), [], "a record that can no longer finish does not stay");
          assert.ok(errorText(h).some((text) => text.includes(worktree) && /stays/u.test(text)), "and the session is told");
        } else if (replay === "restart") {
          h.restart();
          await waitFor(() => journal(h).length === 0, "a restart did not settle the record");
          await relaunch(h, "app", h.app);
        }
        assert.deepEqual(workState(worktree, branch), before, "the work is untouched while the session is away");

        const providers = h.providers.length;
        assert.deepEqual(await backToDocs(h, undefined), { ok: true });
        await waitFor(() => h.providers[providers]?.prompts.length === 1 || failure(h) !== undefined, "the switch back did not settle");
        assert.equal(failure(h), undefined, "it is not refused");
        assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, worktree);
        assert.deepEqual(workState(worktree, branch), before, "and the dirty work that deferred it is all there");
        assert.deepEqual(journal(h), []);
      });
    });
  }
}

test("a port block another session took meanwhile is replaced before the move, so the session still launches", async () => {
  await withSession("port-taken", async (h) => {
    const worktree = await leaveWorkBehind(h, "fix/install-link", {});
    const row = h.store.readMeta(h.sessionId)!.locationHistory!.flatMap((left) => left.worktrees).find((item) => item.path === worktree)!;
    const held = row.portBlock!;
    assert.ok(held, "the row carries a block");
    // A shared-owner discard released it, and another session then took exactly that block.
    const allocator = internalsOf(h).worktreePortAllocator;
    allocator.release(`${h.sessionId}\0${row.id}`);
    allocator.allocate("s_other\0other-worktree", held);

    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1 || failure(h) !== undefined, "the switch back did not settle");
    assert.equal(failure(h), undefined);
    const current = h.store.readMeta(h.sessionId)!.worktrees![0]!;
    assert.equal(current.path, worktree);
    assert.notDeepEqual(current.portBlock, held, "it does not keep what another session holds");
    assert.deepEqual(allocator.get("s_other\0other-worktree"), held, "and the other session keeps it");
    assert.deepEqual(allocator.get(`${h.sessionId}\0${current.id}`), current.portBlock);
    assert.equal(h.providers[3]!.env?.WOLLIPOG_PORT_BLOCK_START, String(current.portBlock!.start));
    assert.match(h.providers[3]!.prompts[0]!, new RegExp(`port block changed to ${current.portBlock!.start}-${current.portBlock!.end}`, "u"));

    // And the next launch, with no switch involved, does not throw either.
    h.restart();
    assert.deepEqual(h.store.readMeta(h.sessionId)!.worktrees![0]!.portBlock, current.portBlock);
  });
});

test("a port block that cannot be replaced fails the switch before the move, with the session where it was", async () => {
  await withSession("port-exhausted", async (h) => {
    const worktree = await leaveWorkBehind(h, "fix/install-link", {});
    const row = h.store.readMeta(h.sessionId)!.locationHistory!.flatMap((left) => left.worktrees).find((item) => item.path === worktree)!;
    const allocator = internalsOf(h).worktreePortAllocator;
    allocator.release(`${h.sessionId}\0${row.id}`);
    allocator.allocate("s_other\0other-worktree", row.portBlock);
    const allocate = allocator.allocate.bind(allocator);
    allocator.allocate = (owner, preferred) => {
      if (owner.startsWith(h.sessionId) && !preferred) throw new Error("worktree port range is exhausted");
      return allocate(owner, preferred);
    };
    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the switch back did not fail");
    assert.match(failure(h)!.reason!, /exhausted/u);
    assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.app, "nothing moved");
    assert.equal(existsSync(worktree), true);
  });
});

/** In docs with a trusted setup that logs each run, then away again: the row is this session's own. */
async function leaveSetUpWorktree(h: Harness, ranLog: string): Promise<string> {
  commitSetup(h, {
    environment: { SWITCH_SETUP_VALUE: "from-setup" },
    setup: [{ name: "Log the Run", command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(ranLog)},'x')`], timeoutSeconds: 30 }],
  });
  git(h.app, "branch", "away");
  assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
  await answerTrust(h, "trust");
  await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the first move did not finish");
  const worktree = h.store.readMeta(h.sessionId)!.worktreePath!;
  writeFileSync(join(worktree, "uncommitted.txt"), "the session's work\n");
  assert.deepEqual(await moveAway(h), { ok: true });
  await waitFor(() => h.providers[2]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move away did not finish");
  assert.equal(readFileSync(ranLog, "utf8"), "x");
  return worktree;
}

function rewriteLeftRow(h: Harness, worktree: string, rewrite: (row: SessionWorktreeView) => SessionWorktreeView): void {
  const meta = h.store.readMeta(h.sessionId)!;
  h.store.patchMeta(h.sessionId, { locationHistory: meta.locationHistory!.map((left) => ({ ...left,
    worktrees: left.worktrees.map((row) => row.path === worktree ? rewrite(row) : row) })) });
}

for (const status of ["failed", "running", "awaiting_trust"] as const) {
  test(`a worktree whose setup ${status === "failed" ? "failed" : `stopped at ${status}`} never runs setup on its way back, and launches without its environment`, async () => {
    await withSession(`return-${status}`.replaceAll("_", "-"), async (h) => {
      const ranLog = join(h.root, "ran");
      const worktree = await leaveSetUpWorktree(h, ranLog);
      rewriteLeftRow(h, worktree, (row) => ({ ...row, setup: { ...row.setup!, status, completedAt: undefined } as SessionWorktreeView["setup"] }));
      const before = files(worktree);

      assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
      await waitFor(() => h.providers[3]?.prompts.length === 1 || failure(h) !== undefined, "the switch back did not settle");

      assert.equal(failure(h), undefined);
      assert.equal(readFileSync(ranLog, "utf8"), "x", "setup did not run again");
      assert.deepEqual(payloads(h, "permission_request").length, 1, "and asked for nothing new");
      assert.deepEqual(files(worktree), before);
      assert.equal(h.providers[3]!.env?.SWITCH_SETUP_VALUE, undefined, "its setup environment is not there");
      assert.ok(h.providers[3]!.env?.WOLLIPOG_PORT_BLOCK_START, "its runner-owned environment still is");
      assert.match(h.providers[3]!.prompts[0]!, /setup environment is not available/u, "and the session is told");

      // The relaunch after a restart holds to the same rule.
      h.restart();
      await relaunch(h, "docs", h.docs);
      assert.equal(h.providers.at(-1)!.cwd, worktree, "the relaunch is in that worktree");
      assert.equal(readFileSync(ranLog, "utf8"), "x", "not after a restart either");
    });
  });
}

test("an earlier invalid setup configuration does not refuse the launch on the way back", async () => {
  await withSession("return-invalid", async (h) => {
    const ranLog = join(h.root, "ran");
    const worktree = await leaveSetUpWorktree(h, ranLog);
    rewriteLeftRow(h, worktree, ({ setup: _setup, ...row }) => ({ ...row, setupConfig: { status: "invalid", error: "version 99 is not supported" } }));
    const before = files(worktree);
    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1 || failure(h) !== undefined || h.store.readMeta(h.sessionId)?.status === "failed",
      "the switch back did not settle");
    assert.equal(failure(h), undefined);
    assert.equal(h.providers[3]?.cwd, worktree, "the provider launched");
    assert.equal(readFileSync(ranLog, "utf8"), "x");
    assert.deepEqual(files(worktree), before);
    assert.match(h.providers[3]!.prompts[0]!, /setup environment is not available/u);
  });
});

test("a retained worktree whose required setup really failed launches on the way back without running setup again", async () => {
  await withSession("return-real-failed", async (h) => {
    const ranLog = join(h.root, "ran");
    git(h.docs, "checkout", "--quiet", "-b", "config-base");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, setup: [{ name: "Log and Fail",
      command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(ranLog)},'x');process.exit(3)`], timeoutSeconds: 30 }] }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "failing setup");
    git(h.docs, "checkout", "--quiet", "main");
    git(h.app, "branch", "away");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the first move did not finish");
    const creating = h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/other" });
    await answerTrust(h, "trust");
    await assert.rejects(creating, /required worktree setup failed/u);
    assert.equal(readFileSync(ranLog, "utf8"), "x");
    const retained = h.store.readMeta(h.sessionId)!.worktrees!.find((row) => row.branch === "fix/other")!;
    assert.equal(retained.setup?.status, "failed");
    writeFileSync(join(retained.path, "uncommitted.txt"), "work on the retained worktree\n");

    assert.deepEqual(await moveAway(h), { ok: true });
    await waitFor(() => h.providers[2]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move away did not finish");
    const before = files(retained.path);
    assert.deepEqual(await backToDocs(h, "fix/other"), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1 || failure(h) !== undefined, "the switch back did not settle");
    assert.equal(failure(h), undefined);
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, retained.path);
    assert.equal(readFileSync(ranLog, "utf8"), "x", "the failing setup did not run over the work");
    assert.deepEqual(files(retained.path), before);
  });
});

test("a completed setup whose configuration can no longer be read still launches on the way back, and says its environment is gone", async () => {
  await withSession("return-unreadable", async (h) => {
    const ranLog = join(h.root, "ran");
    const worktree = await leaveSetUpWorktree(h, ranLog);
    // A base commit Git no longer has is what makes the load throw at launch.
    rewriteLeftRow(h, worktree, (row) => ({ ...row, baseCommit: "0".repeat(40) }));
    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1 || failure(h) !== undefined, "the switch back did not settle");
    assert.equal(failure(h), undefined);
    assert.equal(readFileSync(ranLog, "utf8"), "x");
    assert.match(h.providers[3]!.prompts[0]!, /setup environment is not available/u);
  });
});

test("a release that cannot finish after a turn took the session says so, though the switch stays owed", async () => {
  await withSession("kept-deferred", async (h) => {
    commitSetup(h, { setup: [{ name: "Prepare Target", command: write(join(h.root, "setup-ran"), "'yes'"), timeoutSeconds: 30 }] });
    const internals = internalsOf(h);
    const canProceed = internals.worktreeRebindCanProceed.bind(h.manager);
    let refused = false;
    const removal = stickRemoval(h);
    internals.worktreeRebindCanProceed = (sessionId, entry) => {
      if (refused) return false;
      if (existsSync(join(h.root, "setup-ran")) && !h.store.readMeta(sessionId)?.pendingApproval) {
        refused = true;
        return false;
      }
      return canProceed(sessionId, entry);
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => refused && journal(h)[0]?.processTerminationStartedAt !== undefined, "the release never started");
    const [record] = journal(h);
    await waitFor(() => errorText(h).some((text) => text.includes(`could not be removed and is still at ${record!.worktreePath}`)), "nobody was told");
    assert.equal(h.store.readMeta(h.sessionId)?.pendingLocationSwitch?.occurrenceId, "occurrence-1", "the switch is still owed");
    assert.equal(failure(h), undefined, "and it has not failed");
    removal.free();
  });
});

for (const { how, patch } of [
  { how: "the occurrence was replaced", patch: { occurrenceId: "occurrence-other" } },
  { how: "the occurrence is gone", patch: undefined },
]) {
  test(`a replacement superseded because ${how} still gives the reserved worktree back, and says so when it cannot`, async () => {
    await withSession(`kept-superseded-${patch ? "replaced" : "gone"}`, async (h) => {
      const internals = internalsOf(h);
      const replace = internals.replaceProviderProcess.bind(h.manager);
      internals.replaceProviderProcess = async (...args) => {
        const pending = h.store.readMeta(h.sessionId)!.pendingLocationSwitch!;
        h.store.patchMeta(h.sessionId, { pendingLocationSwitch: patch ? { ...pending, ...patch } : undefined });
        return replace(...args);
      };
      const removal = stickRemoval(h);
      assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
      await waitFor(() => journal(h)[0]?.processTerminationStartedAt !== undefined, "the release never started");
      const [record] = journal(h);
      await waitFor(() => errorText(h).some((text) => text.includes(`could not be removed and is still at ${record!.worktreePath}`)), "nobody was told");
      removal.free();
      await internals.replayDeferredWorktreeRetirements();
      const later = internals.worktreePullRequestDiscoveryNow;
      internals.worktreePullRequestDiscoveryNow = () => later() + 24 * 60 * 60 * 1000;
      await internals.replayDeferredWorktreeRetirements();
      assert.deepEqual(journal(h), [], "it did not wait for a restart");
      assert.equal(existsSync(record!.worktreePath), false);
      assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.app);
    });
  });
}

test("a replacement that committed the move is never rolled back, whatever stops its provider after that", async () => {
  await withSession("committed-superseded", async (h) => {
    const internals = internalsOf(h);
    // The hardest case: the journal could not even drop the rollback when the move committed.
    const remove = internals.removeWorktreeCleanupRecord.bind(h.manager);
    let keepRecord = true;
    internals.removeWorktreeCleanupRecord = (...args) => keepRecord ? false : remove(...args);
    internals.replaceProviderProcess = async (...args) => {
      const options = args[2] as { replacementMeta: () => unknown };
      assert.ok(options.replacementMeta(), "the move commits");
      return { status: "superseded" };
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.store.readMeta(h.sessionId)?.repoPath === h.docs, "the move did not commit");
    const worktree = h.store.readMeta(h.sessionId)!.worktreePath!;
    writeFileSync(join(worktree, "uncommitted.txt"), "the session's work\n");
    const before = files(worktree);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(files(worktree), before, "the worktree the session moved into is still there, untouched");
    keepRecord = false;

    // And that leftover record is dropped, never replayed, by the next sweep.
    await internals.replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.deepEqual(files(worktree), before);
  });
});

test("a stuck rollback is retried on a schedule without a restart, then gives up once and says so", async () => {
  await withSession("retry", async (h) => {
    commitSetup(h, FAILING_STEP);
    const removal = stickRemoval(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    const [record] = journal(h);
    const target = record!.worktreePath;
    assert.match(failure(h)!.reason!, /tries again/u);
    const internals = internalsOf(h);
    let now = Date.now();
    internals.worktreePullRequestDiscoveryNow = () => now;

    // Not yet due: a pass of the sweep is not an attempt.
    const attempted = removal.attempts();
    await internals.replayDeferredWorktreeRetirements();
    assert.equal(removal.attempts(), attempted, "the schedule backs off");

    // Bounded: attempts stop however long the sweep keeps running, and the session hears once.
    const hours = 10 * 60 * 60 * 1000;
    for (let pass = 0; pass < 2000; pass++) {
      now += hours;
      await internals.replayDeferredWorktreeRetirements();
    }
    const total = removal.attempts();
    assert.equal(total, 8, "eight attempts in all, the first being the switch's own, over two years of sweeps");
    const gaveUp = () => errorText(h).filter((text) => text.includes(target) && /stopped trying/u.test(text));
    assert.equal(gaveUp().length, 1, "it says so once");
    assert.equal(existsSync(target), true);
    assert.equal(journal(h).length, 1, "the record stays for whoever acts on it");

    // Giving up ends only the schedule. Asking again still tries, so whoever clears the blockage can finish it.
    removal.free();
    const attemptsBefore = removal.attempts();
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-2" })), { ok: true });
    await waitFor(() => removal.attempts() > attemptsBefore, "asking again did not try the removal");
    await waitFor(() => !journal(h).some((item) => item.worktreePath === target && item.processTerminationStartedAt !== undefined),
      "the removal did not finish once it could");
  });
});

test("a stuck rollback finishes on the sweep once what blocked it has passed, with no restart and no new request", async () => {
  await withSession("retry-finishes", async (h) => {
    commitSetup(h, FAILING_STEP);
    const removal = stickRemoval(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    const target = journal(h)[0]!.worktreePath;
    removal.free();
    const internals = internalsOf(h);
    const later = Date.now() + 24 * 60 * 60 * 1000;
    internals.worktreePullRequestDiscoveryNow = () => later;
    // The real periodic pass, not only the sweep it ends with.
    await h.manager.reconcileWorktreePullRequests();
    assert.deepEqual(journal(h), []);
    assert.equal(existsSync(target), false, "the worktree went");
    assert.ok(git(h.docs, "rev-parse", "--verify", "refs/heads/fix/install-link"), "and the branch stayed");
  });
});

test("a worktree that replaced the proved one while its processes were ending is left alone by the forced removal", async () => {
  await withSession("swap-during-removal", async (h) => {
    commitSetup(h, FAILING_STEP);
    const internals = internalsOf(h);
    const retire = internals.retireWorktreeProcesses.bind(h.manager);
    let swapped = false;
    let replacement: Record<string, string> | undefined;
    internals.retireWorktreeProcesses = async (...args) => {
      await retire(...args);
      if (swapped) return;
      swapped = true;
      // What the proof held for goes, and a person's own worktree takes that path.
      const path = args[2] as string;
      git(h.docs, "worktree", "remove", "--force", path);
      git(h.docs, "worktree", "add", "--quiet", path, "fix/install-link");
      writeFileSync(join(path, "theirs.txt"), "a person's work\n");
      replacement = files(path);
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    assert.equal(swapped, true);
    const target = docsWorktrees(h)[1]!;
    assert.deepEqual(files(target), replacement, "the forced removal did not touch it");
    h.restart();
    await waitFor(() => journal(h).length === 0, "the mismatched record was not dropped");
    assert.deepEqual(files(target), replacement, "and neither did the replay");
  });
});

test("a proof the move has spent does not stay in the worktree", async () => {
  await withSession("proof-cleared", async (h) => {
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const worktree = h.store.readMeta(h.sessionId)!.worktreePath!;
    await waitFor(() => git(worktree, "for-each-ref", "refs/worktree") === "", "the spent proof stayed");
  });
});

test("the sweep never touches the reservation of a switch still running its setup", async () => {
  await withSession("sweep-live", async (h) => {
    const started = join(h.root, "step-started");
    commitSetup(h, { setup: [{ name: "Long Step", command: [process.execPath, "-e",
      `require('fs').writeFileSync(${JSON.stringify(started)},'');setTimeout(()=>{},60000)`], timeoutSeconds: 120 }] });
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => existsSync(started), "setup never started");
    const internals = internalsOf(h);
    const later = Date.now() + 24 * 60 * 60 * 1000;
    internals.worktreePullRequestDiscoveryNow = () => later;
    const [record] = journal(h);
    await internals.replayDeferredWorktreeRetirements();
    assert.equal(existsSync(record!.worktreePath), true, "the worktree is still there");
    assert.equal(journal(h)[0]?.processTerminationStartedAt, undefined, "and no removal began");
    assert.equal(h.store.readMeta(h.sessionId)?.pendingLocationSwitch?.occurrenceId, "occurrence-1");
    h.manager.stop(h.sessionId);
    await waitFor(() => journal(h).length === 0, "the stop did not give the worktree back");
  });
});
