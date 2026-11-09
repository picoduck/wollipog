import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionLocationSwitchMessage, SessionWorktreeView } from "@wollipog/protocol";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

test("a foreign directory at the slot leaves no record to replay, says what to do, and the next attempt goes ahead once it has gone", async () => {
  if (process.platform === "win32") return;
  await withSession("foreign", async (h) => {
    serveOriginLocally(h);
    const branch = `agent/${h.sessionId}`;
    const slot = await docsSlot(h, branch);
    mkdirSync(slot, { recursive: true });
    writeFileSync(join(slot, "not-ours.txt"), "someone's file\n");

    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined })), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the foreign directory did not fail the switch");
    assert.equal(readFileSync(join(slot, "not-ours.txt"), "utf8"), "someone's file\n");
    assert.match(failure(h)!.reason!, /move or delete/iu, "it says what to do");
    assert.deepEqual(journal(h), [], "the attempt made nothing, so nothing stays on record");
    assert.throws(() => git(h.docs, "rev-parse", "--verify", `refs/heads/${branch}`), "and no branch either");

    // Asked again with it still there: the same refusal, with the file still in place.
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined, occurrenceId: "occurrence-2" })), { ok: true });
    await waitFor(() => h.store.readMeta(h.sessionId)?.pendingLocationSwitch === undefined, "the second attempt did not settle");
    assert.match(failure(h)!.reason!, /move or delete/iu);
    assert.equal(readFileSync(join(slot, "not-ours.txt"), "utf8"), "someone's file\n");

    rmSync(slot, { recursive: true, force: true });
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined, occurrenceId: "occurrence-3" })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the attempt after it went did not finish");
    assert.equal(failure(h), undefined);
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, slot);
  });
});

for (const replay of ["restart", "periodic sweep"] as const) {
  const replayIt = async (h: Harness): Promise<void> => {
    if (replay === "restart") {
      h.restart();
      return;
    }
    const later = Date.now() + 24 * 60 * 60 * 1000;
    internalsOf(h).worktreePullRequestDiscoveryNow = () => later;
    await internalsOf(h).replayDeferredWorktreeRetirements();
  };

  test(`a proved rollback whose worktree a person replaced removes nothing, and the next attempt continues there with a notice (${replay})`, async () => {
    await withSession(`replaced-${replay}`.replaceAll(" ", "-"), async (h) => {
      commitSetup(h, FAILING_STEP);
      const removal = stickRemoval(h);
      assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
      await answerTrust(h, "trust");
      await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
      const [record] = journal(h);
      const slot = record!.worktreePath;
      assert.ok(record?.rollbackProof, "a real proof, stuck");

      git(h.docs, "worktree", "remove", "--force", slot);
      git(h.docs, "worktree", "add", "--quiet", slot, "fix/install-link");
      writeFileSync(join(slot, "theirs.txt"), "a person's work\n");
      const before = workState(slot, "fix/install-link");
      removal.free();

      await replayIt(h);
      await waitFor(() => journal(h).length === 0, "the mismatched record was not ended");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(workState(slot, "fix/install-link"), before);
      assert.deepEqual(docsWorktrees(h), [h.docs, slot]);

      if (replay === "restart") await relaunch(h, "app", h.app);
      const providers = h.providers.length;
      assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-next" })), { ok: true });
      await waitFor(() => h.providers[providers]?.prompts.length === 1 || h.store.readMeta(h.sessionId)?.pendingLocationSwitch === undefined &&
        h.store.readMeta(h.sessionId)?.repoPath !== h.docs, "the next attempt did not settle");
      assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.docs);
      const row = h.store.readMeta(h.sessionId)!.worktrees![0]!;
      assert.equal(row.source, "attached", "it is treated as the existing worktree it is, never set up or removed by this session");
      assert.match(h.providers[providers]!.prompts[0]!, /Wollipog Existing Worktree/u);
      assert.match(h.providers[providers]!.prompts[0]!, /1 uncommitted change/u, "it never lands there silently");
      assert.deepEqual(workState(slot, "fix/install-link"), before);
    });
  });

  test(`a rollback an older runner wrote never removes the session's own worktree on that slot, and leaves its ports (${replay})`, async () => {
    await withSession(`older-${replay}`.replaceAll(" ", "-"), async (h) => {
      assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
      await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
      const first = h.store.readMeta(h.sessionId)!.worktreePath!;
      const branch = "fix/own-work";
      await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch });
      const slot = await docsSlot(h, branch);
      writeFileSync(join(slot, "tracked.txt"), "committed\n");
      git(slot, "add", "tracked.txt");
      git(slot, "commit", "--quiet", "-m", "the session's own commit");
      writeFileSync(join(slot, "uncommitted.txt"), "the session's own work\n");
      await h.manager.selectWorktree(h.sessionId, first);

      // From before proofs existed, for the same slot: it carries none.
      const meta = h.store.readMeta(h.sessionId)!;
      const owned = meta.worktrees!.find((item) => item.path === slot)!;
      const stale = internalsOf(h).cleanupRecordForWorktree(meta, owned, "creation_rollback", "force");
      stale.auxiliaryWorktreeRollback = true;
      internalsOf(h).cleanupJournal.add(stale);
      const before = workState(slot, branch);

      await replayIt(h);
      await waitFor(() => journal(h).length === 0, "the mismatched record was not dropped");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(workState(slot, branch), before, "the session's worktree and its branch are untouched");
      assert.ok(h.store.readMeta(h.sessionId)!.worktrees!.some((item) => item.path === slot), "and it still owns it");
      assert.deepEqual(internalsOf(h).worktreePortAllocator.get(`${h.sessionId}\0${owned.id}`), owned.portBlock, "with its ports");
    });
  });
}

/** Git keeps the branch and has no worktree: `worktree add` made the branch, then could not register. */
function blockWorktreeRegistration(h: Harness): () => void {
  const blocker = join(h.docs, ".git", "worktrees");
  assert.equal(existsSync(blocker), false);
  writeFileSync(blocker, "in the way\n");
  return () => rmSync(blocker);
}

test("a failed `worktree add -b` on a default switch gives back the branch it made, so the next attempt can go ahead", async () => {
  if (process.platform === "win32") return;
  await withSession("add-fails", async (h) => {
    serveOriginLocally(h);
    const branch = `agent/${h.sessionId}`;
    const unblock = blockWorktreeRegistration(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined })), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the failed add did not fail the switch");
    assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.app);
    assert.deepEqual(journal(h), []);
    assert.throws(() => git(h.docs, "rev-parse", "--verify", `refs/heads/${branch}`), "the branch it made goes with it");

    unblock();
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined, occurrenceId: "occurrence-2" })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 || h.store.readMeta(h.sessionId)?.pendingLocationSwitch === undefined, "the second attempt did not settle");
    assert.equal(failure(h), undefined, "and it is not refused");
    assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.docs);
    assert.ok(git(h.docs, "rev-parse", "--verify", `refs/heads/${branch}`));
  });
});

test("a failed `worktree add` on a recovered branch keeps that branch, and the next attempt can go ahead", async () => {
  await withSession("add-fails-recovered", async (h) => {
    const tip = git(h.docs, "rev-parse", "refs/heads/fix/install-link");
    const unblock = blockWorktreeRegistration(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the failed add did not fail the switch");
    assert.deepEqual(journal(h), []);
    assert.equal(git(h.docs, "rev-parse", "refs/heads/fix/install-link"), tip);
    unblock();
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-2" })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the second attempt did not finish");
    assert.equal(failure(h), undefined);
  });
});

/** A checkout that really fails: a required smudge filter on every file of the commit. */
function failCheckout(h: Harness, commitOn: string): () => void {
  git(h.docs, "checkout", "--quiet", commitOn);
  writeFileSync(join(h.docs, ".gitattributes"), "tracked.txt filter=refuses\n");
  writeFileSync(join(h.docs, "tracked.txt"), "content\n");
  git(h.docs, "add", ".gitattributes", "tracked.txt");
  git(h.docs, "commit", "--quiet", "-m", "a file that needs a filter");
  if (commitOn !== "main") git(h.docs, "checkout", "--quiet", "main");
  git(h.docs, "config", "filter.refuses.smudge", "false");
  git(h.docs, "config", "filter.refuses.required", "true");
  return () => {
    git(h.docs, "config", "--unset", "filter.refuses.smudge");
    git(h.docs, "config", "--unset", "filter.refuses.required");
  };
}

test("a checkout that fails is an ordinary proved rollback on a recovered branch: nothing partial stays, the branch does, and the next attempt goes ahead", async () => {
  await withSession("checkout-fails-recovered", async (h) => {
    const restore = failCheckout(h, "fix/install-link");
    const tip = git(h.docs, "rev-parse", "refs/heads/fix/install-link");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the failed checkout did not fail the switch");
    assert.deepEqual(journal(h), []);
    assert.deepEqual(docsWorktrees(h), [h.docs], "no partial tree stays");
    assert.equal(git(h.docs, "rev-parse", "refs/heads/fix/install-link"), tip);
    assert.equal(h.providers.length, 1, "and the session is not in it");
    restore();
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-2" })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the second attempt did not finish");
    assert.equal(readFileSync(join(h.store.readMeta(h.sessionId)!.worktreePath!, "tracked.txt"), "utf8"), "content\n");
  });
});

test("a checkout that fails on a default switch gives back its worktree and its branch, and the next attempt goes ahead", async () => {
  if (process.platform === "win32") return;
  await withSession("checkout-fails-default", async (h) => {
    const restore = failCheckout(h, "main");
    serveOriginLocally(h);
    const branch = `agent/${h.sessionId}`;
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined })), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the failed checkout did not fail the switch");
    assert.deepEqual(journal(h), []);
    assert.deepEqual(docsWorktrees(h), [h.docs]);
    assert.throws(() => git(h.docs, "rev-parse", "--verify", `refs/heads/${branch}`));
    restore();
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined, occurrenceId: "occurrence-2" })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the second attempt did not finish");
    assert.equal(failure(h), undefined);
  });
});

/** Refuses the proof ref only, the way a real failure to write it would. */
function refuseProof(h: Harness): () => void {
  const hook = join(h.docs, ".git", "hooks", "reference-transaction");
  mkdirSync(join(h.docs, ".git", "hooks"), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\nif grep -q refs/worktree/wollipog-rollback; then exit 1; fi\nexit 0\n", { mode: 0o755 });
  return () => rmSync(hook);
}

test("a proof that cannot be written on a switch leaves no empty tree and no branch, and the next attempt goes ahead", async () => {
  if (process.platform === "win32") return;
  await withSession("stamp-fails-switch", async (h) => {
    serveOriginLocally(h);
    const branch = `agent/${h.sessionId}`;
    const allow = refuseProof(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined })), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the refused proof did not fail the switch");
    assert.deepEqual(journal(h), []);
    assert.deepEqual(docsWorktrees(h), [h.docs], "the empty worktree went");
    assert.throws(() => git(h.docs, "rev-parse", "--verify", `refs/heads/${branch}`));
    allow();
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined, occurrenceId: "occurrence-2" })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the second attempt did not finish");
    assert.equal(failure(h), undefined);
  });
});

test("a proof that cannot be written on a request fails it before any setup runs, and the next request goes ahead", async () => {
  if (process.platform === "win32") return;
  await withSession("stamp-fails-request", async (h) => {
    const ranLog = join(h.root, "ran");
    git(h.docs, "checkout", "--quiet", "-b", "config-base");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, setup: [{ name: "Log the Run",
      command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(ranLog)},'x')`], timeoutSeconds: 30 }] }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "setup");
    git(h.docs, "checkout", "--quiet", "main");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");

    const allow = refuseProof(h);
    await assert.rejects(h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/other" }));
    assert.equal(existsSync(ranLog), false, "no setup ran without its proof");
    assert.deepEqual(journal(h), []);
    assert.equal(docsWorktrees(h).length, 2, "only the worktree it is already in");
    assert.throws(() => git(h.docs, "rev-parse", "--verify", "refs/heads/fix/other"));

    allow();
    const creating = h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/other" });
    await answerTrust(h, "trust");
    const { worktree } = await creating;
    assert.equal(existsSync(worktree.path), true);
    assert.equal(readFileSync(ranLog, "utf8"), "x");
  });
});

/** A rollback a crash left: `git worktree add --no-checkout` done, and nothing or part of a checkout after it. */
function plantInterruptedRollback(h: Harness, slot: string, branch: string, { proof, files: planted = {} }: { proof?: string; files?: Record<string, string> }): WorktreeCleanupRecord {
  const base = git(h.docs, "rev-parse", "main");
  git(h.docs, "worktree", "add", "--quiet", "--no-checkout", "-b", branch, slot, base);
  if (proof) git(slot, "update-ref", `refs/worktree/wollipog-rollback/${proof}`, "HEAD");
  for (const [name, content] of Object.entries(planted)) writeFileSync(join(slot, name), content);
  const meta = h.store.readMeta(h.sessionId)!;
  const record = internalsOf(h).cleanupRecordForWorktree(
    { ...meta, repoPath: h.docs, worktreePath: slot, worktreeBranch: branch, worktrees: [] },
    { id: "interrupted", path: slot, branch, baseRef: "main", source: "created" },
    "creation_rollback", "force");
  record.auxiliaryWorktreeRollback = true;
  record.rollbackBranchBase = base;
  if (proof) record.rollbackProof = proof;
  internalsOf(h).cleanupJournal.add(record);
  return record;
}

test("a crash before the proof was written leaves an empty tree: a restart removes it and its branch, and the next attempt sets up as new", async () => {
  if (process.platform === "win32") return;
  await withSession("crash-before-proof", async (h) => {
    const ranLog = join(h.root, "ran");
    const config = { version: 1, setup: [{ name: "Log the Run", command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(ranLog)},'x')`], timeoutSeconds: 30 }] };
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify(config));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "setup on the default branch");
    serveOriginLocally(h);
    const branch = `agent/${h.sessionId}`;
    const slot = await docsSlot(h, branch);
    plantInterruptedRollback(h, slot, branch, {});

    h.restart();
    await waitFor(() => journal(h).length === 0, "the rollback was not settled");
    assert.deepEqual(docsWorktrees(h), [h.docs], "the empty tree went");
    assert.throws(() => git(h.docs, "rev-parse", "--verify", `refs/heads/${branch}`), "and so did the branch it made");

    await relaunch(h, "app", h.app);
    const providers = h.providers.length;
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined, occurrenceId: "occurrence-next" })), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => h.providers[providers]?.prompts.length === 1, "the next attempt did not finish");
    assert.equal(readFileSync(ranLog, "utf8"), "x", "a first-time worktree does not skip its setup");
    assert.ok(existsSync(join(slot, ".wollipog.json")), "and it is a whole tree");
  });
});

test("a runner crash during the checkout leaves a partial tree no snapshot covers: it is kept, the next attempt refuses it and says what to do, and following that works", async () => {
  if (process.platform === "win32") return;
  await withSession("crash-mid-checkout", async (h) => {
    writeFileSync(join(h.docs, "a.txt"), "first\n");
    writeFileSync(join(h.docs, "b.txt"), "second\n");
    git(h.docs, "add", "a.txt", "b.txt");
    git(h.docs, "commit", "--quiet", "-m", "two files");
    serveOriginLocally(h);
    const branch = `agent/${h.sessionId}`;
    const slot = await docsSlot(h, branch);
    plantInterruptedRollback(h, slot, branch, { proof: "crashed", files: { "a.txt": "first\n" } });
    // A killed checkout also leaves its lock behind.
    writeFileSync(join(git(slot, "rev-parse", "--absolute-git-dir"), "index.lock"), "");
    const before = files(slot);

    h.restart();
    await waitFor(() => journal(h).length === 0, "the rollback was not settled");
    assert.deepEqual(files(slot), before, "nothing proves it is only the runner's, so it stays");

    await relaunch(h, "app", h.app);
    const providers = h.providers.length;
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined, occurrenceId: "occurrence-next" })), { ok: true });
    await waitFor(() => failure(h) !== undefined || h.providers[providers] !== undefined, "the next attempt did not settle");
    assert.equal(h.providers.length, providers, "no session is put in a partial tree");
    assert.match(failure(h)!.reason!, /never finished its checkout/u);
    assert.match(failure(h)!.reason!, /git worktree remove --force/u);
    assert.deepEqual(files(slot), before);

    rmSync(join(git(slot, "rev-parse", "--absolute-git-dir"), "index.lock"));
    git(h.docs, "worktree", "remove", "--force", slot);
    git(h.docs, "branch", "-D", branch);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined, occurrenceId: "occurrence-after" })), { ok: true });
    await waitFor(() => h.providers[providers]?.prompts.length === 1, "the attempt after following that did not finish");
    assert.deepEqual(files(slot), { "a.txt": "first\n", "b.txt": "second\n" }, "whole");
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
          assert.ok(errorText(h).some((text) => /Deleting this session leaves it in place too/u.test(text)),
            "including what session deletion would do to it");
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

test("a retirement whose row's branch changed is not mistaken for one its session left behind", async () => {
  if (process.platform === "win32") return;
  await withSession("safe-branch-changed", async (h) => {
    serveOriginLocally(h);
    git(h.app, "branch", "away");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const meta = h.store.readMeta(h.sessionId)!;
    const internals = internalsOf(h);
    const record = internals.cleanupRecordForWorktree(meta, { ...meta.worktrees![0], branch: "fix/what-the-record-named" }, "explicit_discard", "safe");
    internals.cleanupJournal.add(record);
    assert.deepEqual(await moveAway(h), { ok: true });
    await waitFor(() => h.providers[2]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move away did not finish");
    await internals.replayDeferredWorktreeRetirements();
    assert.equal(journal(h).length, 1, "not this record's row, so it is not dropped on that row's account");
    assert.equal(errorText(h).some((text) => /did not finish before this session left/u.test(text)), false);
  });
});

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

    // And the next launch, with no switch involved, really launches, and keeps that block.
    h.restart();
    await relaunch(h, "docs", h.docs);
    assert.equal(h.providers.at(-1)!.cwd, worktree);
    assert.equal(h.providers.at(-1)!.env?.WOLLIPOG_PORT_BLOCK_START, String(current.portBlock!.start));
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
    // Clean on purpose: nothing in it could stop a rollback whose proof still held, so only knowing
    // that the move committed keeps the session's own worktree.
    const worktree = h.store.readMeta(h.sessionId)!.worktreePath!;
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.equal(existsSync(worktree), true, "the worktree the session moved into is still there");
    const before = files(worktree);
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

/** A real switch whose setup failed and whose removal is stuck: the proved rollback a person walks into. */
async function stuckProvedRollback(h: Harness, config: unknown = FAILING_STEP): Promise<{ record: WorktreeCleanupRecord; removal: ReturnType<typeof stickRemoval> }> {
  commitSetup(h, config);
  const removal = stickRemoval(h);
  assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
  await answerTrust(h, "trust");
  await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
  const [record] = journal(h);
  assert.ok(record?.rollbackProof, "the proof is on record");
  return { record: record!, removal };
}

const dueLater = (h: Harness): void => {
  const later = Date.now() + 24 * 60 * 60 * 1000;
  internalsOf(h).worktreePullRequestDiscoveryNow = () => later;
};

for (const { kind, work } of [
  { kind: "a commit", work: (slot: string) => {
    writeFileSync(join(slot, "tracked.txt"), "committed by a person\n");
    git(slot, "add", "tracked.txt");
    git(slot, "commit", "--quiet", "-m", "a person's commit");
  } },
  { kind: "an edit to a tracked file", work: (slot: string) => writeFileSync(join(slot, ".wollipog.json"), "{\"edited\":true}\n") },
  { kind: "a new untracked file", work: (slot: string) => writeFileSync(join(slot, "notes.txt"), "a person's notes\n") },
  { kind: "a stage of a new file", work: (slot: string) => {
    writeFileSync(join(slot, "staged.txt"), "staged only\n");
    git(slot, "add", "staged.txt");
  } },
  { kind: "a move to another branch", work: (slot: string) => git(slot, "checkout", "--quiet", "-b", "fix/somewhere-else") },
  { kind: "a commit held only by a private ref", work: (slot: string) => {
    writeFileSync(join(slot, "saved.txt"), "saved work\n");
    git(slot, "add", "saved.txt");
    const commit = git(slot, "commit-tree", git(slot, "write-tree"), "-p", "HEAD", "-m", "saved");
    git(slot, "update-ref", "refs/worktree/saved-work", commit);
    git(slot, "rm", "--quiet", "--cached", "saved.txt");
    rmSync(join(slot, "saved.txt"));
  } },
  { kind: "a commit held only by the reflog", work: (slot: string) => {
    git(slot, "commit", "--quiet", "--allow-empty", "-m", "a commit then reset away");
    git(slot, "reset", "--quiet", "--hard", "HEAD~1");
  } },
  { kind: "an edit hidden by assume-unchanged", work: (slot: string) => {
    git(slot, "update-index", "--assume-unchanged", ".wollipog.json");
    writeFileSync(join(slot, ".wollipog.json"), "{\"hidden\":true}\n");
  } },
  { kind: "an edit hidden by skip-worktree", work: (slot: string) => {
    git(slot, "update-index", "--skip-worktree", ".wollipog.json");
    writeFileSync(join(slot, ".wollipog.json"), "{\"hidden\":true}\n");
  } },
]) {
  test(`a proved rollback keeps ${kind} made in its worktree: nothing is removed, the record ends, and the session is told`, async () => {
    await withSession(`keeps-${kind}`.replaceAll(" ", "-"), async (h) => {
      const teardownLog = join(h.root, "teardown-log");
      const { record, removal } = await stuckProvedRollback(h, { ...FAILING_STEP, teardown: [{ name: "Tear Down", command: [process.execPath, "-e",
        `require('fs').appendFileSync(${JSON.stringify(teardownLog)},'x')`], timeoutSeconds: 30 }] });
      const slot = record.worktreePath;
      work(slot);
      const checkedOut = git(slot, "rev-parse", "--abbrev-ref", "HEAD");
      const before = workState(slot, checkedOut);
      const tip = git(h.docs, "rev-parse", "refs/heads/fix/install-link");
      const history = () => ({ reflog: git(slot, "reflog", "--format=%H"), saved: git(slot, "for-each-ref", "refs/worktree/saved-work") });
      const heldBefore = history();
      removal.free();
      dueLater(h);
      await internalsOf(h).replayDeferredWorktreeRetirements();

      assert.deepEqual(journal(h), [], "the record ends rather than waiting to remove it");
      assert.deepEqual(workState(slot, checkedOut), before, "byte for byte");
      assert.deepEqual(history(), heldBefore, "with what only the worktree's own Git state holds");
      assert.equal(git(h.docs, "rev-parse", "refs/heads/fix/install-link"), tip, "the branch too");
      assert.equal(existsSync(teardownLog), false, "no teardown runs over someone's work");
      assert.ok(errorText(h).some((text) => text.includes(slot) && /kept/iu.test(text)), "and the session is told where it is");
    });
  });
}

test("work that exists only in the index is kept: a staged edit with its working file restored is still someone's", async () => {
  await withSession("keeps-index-only", async (h) => {
    const { record, removal } = await stuckProvedRollback(h);
    const slot = record.worktreePath;
    const original = readFileSync(join(slot, ".wollipog.json"));
    writeFileSync(join(slot, ".wollipog.json"), "{\"staged\":\"only here\"}\n");
    git(slot, "add", ".wollipog.json");
    writeFileSync(join(slot, ".wollipog.json"), original);
    const staged = git(slot, "show", ":.wollipog.json");
    removal.free();
    dueLater(h);
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.equal(git(slot, "show", ":.wollipog.json"), staged, "the staged version is still there");
    assert.ok(errorText(h).some((text) => text.includes(slot) && /kept/iu.test(text)));
  });
});

test("work written while setup's processes were ending is kept, and no teardown runs over it", async () => {
  await withSession("keeps-during-retirement", async (h) => {
    const teardownLog = join(h.root, "teardown-log");
    commitSetup(h, { ...FAILING_STEP, teardown: [{ name: "Tear Down", command: [process.execPath, "-e",
      `require('fs').appendFileSync(${JSON.stringify(teardownLog)},'x')`], timeoutSeconds: 30 }] });
    const internals = internalsOf(h);
    const retire = internals.retireWorktreeProcesses.bind(h.manager);
    let wrote = false;
    internals.retireWorktreeProcesses = async (...args) => {
      await retire(...args);
      if (wrote) return;
      wrote = true;
      writeFileSync(join(args[2] as string, "notes.txt"), "written while the rollback was under way\n");
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    const [, slot] = docsWorktrees(h);
    assert.ok(slot, "the worktree stays");
    assert.equal(readFileSync(join(slot, "notes.txt"), "utf8"), "written while the rollback was under way\n");
    assert.equal(existsSync(teardownLog), false, "no teardown ran over it");
    assert.deepEqual(journal(h), [], "the record ended at once, not on a later try");
    assert.ok(errorText(h).some((text) => text.includes(slot) && /kept/iu.test(text)));
    assert.doesNotMatch(failure(h)!.reason!, /could not be removed/u, "and it is not reported as stuck");
  });
});

test("a file that appears while teardown runs is kept, whoever wrote it, since nothing can say whose it is", async () => {
  await withSession("keeps-during-teardown", async (h) => {
    const written = "notes-during-teardown.txt";
    commitSetup(h, { ...FAILING_STEP, teardown: [{ name: "Tear Down", command: write(written, "'written while teardown waited\\n'"), timeoutSeconds: 30 }] });
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    const [, slot] = docsWorktrees(h);
    assert.ok(slot, "the worktree stays");
    assert.equal(readFileSync(join(slot, written), "utf8"), "written while teardown waited\n");
    assert.deepEqual(journal(h), []);
    assert.ok(errorText(h).some((text) => text.includes(slot) && /kept/iu.test(text)));
  });
});

test("a teardown that changes nothing Git tracks still ends in a removal, and a retry does not run it again", async () => {
  await withSession("teardown-unchanged", async (h) => {
    const teardownLog = join(h.root, "teardown-log");
    const { record, removal } = await stuckProvedRollback(h, { ...FAILING_STEP, teardown: [{ name: "Tear Down", command: [process.execPath, "-e",
      `require('fs').appendFileSync(${JSON.stringify(teardownLog)},'x')`], timeoutSeconds: 30 }] });
    removal.free();
    // Something stops the removal right after teardown, and the tree is as it was.
    const internals = internalsOf(h) as unknown as Internals & { assertRollbackUntouched: (...args: unknown[]) => Promise<void> };
    const check = internals.assertRollbackUntouched.bind(h.manager);
    let checks = 0;
    internals.assertRollbackUntouched = async (...args) => {
      checks++;
      if (checks === 2) throw new Error("the removal could not go on");
      return check(...args);
    };
    dueLater(h);
    await internals.replayDeferredWorktreeRetirements();
    assert.equal(readFileSync(teardownLog, "utf8"), "x", "teardown ran");
    assert.equal(journal(h).length, 1, "unchanged, so it stays on record to try again rather than being kept");
    const later = Date.now() + 365 * 24 * 60 * 60 * 1000;
    internalsOf(h).worktreePullRequestDiscoveryNow = () => later;
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.equal(existsSync(record.worktreePath), false);
    assert.equal(readFileSync(teardownLog, "utf8"), "x", "once");
  });
});

test("a person's work kept from a rollback is what the next attempt continues in, with a notice and no setup", async () => {
  await withSession("kept-next-attempt", async (h) => {
    const ranLog = join(h.root, "ran");
    const { record, removal } = await stuckProvedRollback(h, { setup: [{ name: "Log and Fail",
      command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(ranLog)},'x');process.exit(3)`], timeoutSeconds: 30 }] });
    const slot = record.worktreePath;
    writeFileSync(join(slot, "notes.txt"), "a person's notes\n");
    const before = workState(slot, "fix/install-link");
    assert.equal(readFileSync(ranLog, "utf8"), "x");
    removal.free();
    dueLater(h);
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);

    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-next" })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the next attempt did not finish");
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, slot);
    assert.equal(h.store.readMeta(h.sessionId)!.worktrees![0]!.source, "attached");
    assert.match(h.providers[1]!.prompts[0]!, /Wollipog Existing Worktree/u);
    assert.equal(readFileSync(ranLog, "utf8"), "x", "no setup runs over it");
    assert.deepEqual(workState(slot, "fix/install-link"), before);
  });
});

test("work kept from a rollback on a path in the session's history is an existing worktree next time: no old row, no old environment, no setup", async () => {
  await withSession("kept-history", async (h) => {
    const ranLog = join(h.root, "ran");
    const worktree = await leaveSetUpWorktree(h, ranLog);
    git(h.docs, "worktree", "remove", "--force", worktree);
    git(h.docs, "checkout", "--quiet", "fix/install-link");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, setup: [{ name: "Log and Fail", command: [process.execPath, "-e",
      `require('fs').appendFileSync(${JSON.stringify(ranLog)},'x');process.exit(3)`], timeoutSeconds: 30 }] }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "new setup");
    git(h.docs, "checkout", "--quiet", "main");
    const removal = stickRemoval(h);
    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    await waitFor(() => payloads(h, "permission_request").length === 2, "the new configuration's trust card was not shown");
    h.manager.resolvePermission(h.sessionId, payloads(h, "permission_request")[1].requestId, "trust");
    await waitFor(() => failure(h)?.reason?.includes("required worktree setup failed") === true, "the new setup did not fail the switch");
    writeFileSync(join(worktree, "notes.txt"), "a person's notes\n");
    const before = workState(worktree, "fix/install-link");
    removal.free();
    dueLater(h);
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    const rows = h.store.readMeta(h.sessionId)!.locationHistory!.flatMap((left) => left.worktrees);
    assert.equal(rows.some((row) => row.path === worktree), false, "the old row described an earlier worktree, so it goes");

    const runs = readFileSync(ranLog, "utf8");
    assert.deepEqual(await backToDocs(h, "fix/install-link", "occurrence-next"), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1, "the next return did not finish");
    const row = h.store.readMeta(h.sessionId)!.worktrees![0]!;
    assert.equal(row.source, "attached");
    assert.equal(row.setup, undefined, "no finished setup is claimed for it");
    assert.equal(h.providers[3]!.env?.SWITCH_SETUP_VALUE, undefined, "and the old environment does not come back");
    assert.match(h.providers[3]!.prompts[0]!, /Wollipog Existing Worktree/u);
    assert.equal(readFileSync(ranLog, "utf8"), runs, "no setup runs over it");
    assert.deepEqual(workState(worktree, "fix/install-link"), before);
  });
});

test("a worktree a person remade on a path in the session's history gets no old environment on the next return", async () => {
  await withSession("remade-by-person", async (h) => {
    const ranLog = join(h.root, "ran");
    const worktree = await leaveSetUpWorktree(h, ranLog);
    git(h.docs, "worktree", "remove", "--force", worktree);
    git(h.docs, "checkout", "--quiet", "fix/install-link");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, setup: [{ name: "Log and Fail", command: [process.execPath, "-e",
      `require('fs').appendFileSync(${JSON.stringify(ranLog)},'x');process.exit(3)`], timeoutSeconds: 30 }] }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "new setup");
    git(h.docs, "checkout", "--quiet", "main");
    const removal = stickRemoval(h);
    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    await waitFor(() => payloads(h, "permission_request").length === 2, "the new configuration's trust card was not shown");
    h.manager.resolvePermission(h.sessionId, payloads(h, "permission_request")[1].requestId, "trust");
    await waitFor(() => failure(h)?.reason?.includes("required worktree setup failed") === true, "the new setup did not fail the switch");
    git(h.docs, "worktree", "remove", "--force", worktree);
    git(h.docs, "worktree", "add", "--quiet", worktree, "fix/install-link");
    removal.free();
    dueLater(h);
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    const runs = readFileSync(ranLog, "utf8");

    assert.deepEqual(await backToDocs(h, "fix/install-link", "occurrence-next"), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1, "the next return did not finish");
    assert.equal(h.store.readMeta(h.sessionId)!.worktrees![0]!.source, "attached");
    assert.equal(h.providers[3]!.env?.SWITCH_SETUP_VALUE, undefined);
    assert.equal(readFileSync(ranLog, "utf8"), runs);
  });
});

test("a registered worktree on the slot that was never checked out is refused, not landed in, and says what to do", async () => {
  await withSession("slot-empty", async (h) => {
    git(h.docs, "checkout", "--quiet", "fix/install-link");
    writeFileSync(join(h.docs, "a.txt"), "content\n");
    git(h.docs, "add", "a.txt");
    git(h.docs, "commit", "--quiet", "-m", "a file");
    git(h.docs, "checkout", "--quiet", "main");
    const slot = await docsSlot(h, "fix/install-link");
    git(h.docs, "worktree", "add", "--quiet", "--no-checkout", slot, "fix/install-link");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => failure(h) !== undefined || h.providers[1]?.prompts.length === 1, "the switch did not settle");
    assert.equal(h.providers.length, 1, "no provider started in an empty tree");
    assert.match(failure(h)!.reason!, /never finished its checkout/u);
    assert.ok(failure(h)!.reason!.includes(slot), "it names the worktree");
    assert.match(failure(h)!.reason!, /git worktree remove --force/u);
    assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.app);

    git(h.docs, "worktree", "remove", "--force", slot);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-2" })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the attempt after following that did not finish");
  });
});

test("a request's crash during its checkout leaves a tree that neither the retry nor an attach puts the session in", async () => {
  if (process.platform === "win32") return;
  await withSession("request-partial", async (h) => {
    writeFileSync(join(h.docs, "a.txt"), "first\n");
    git(h.docs, "add", "a.txt");
    git(h.docs, "commit", "--quiet", "-m", "a file");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const first = h.store.readMeta(h.sessionId)!.worktreePath!;
    const slot = await docsSlot(h, "fix/other");
    plantInterruptedRollback(h, slot, "fix/other", { proof: "crashed" });
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), [], "it is kept, since no snapshot covers it");
    assert.equal(existsSync(slot), true);

    await assert.rejects(h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/other" }), /without ownership/u);
    await assert.rejects(h.manager.attachWorktree(h.sessionId, slot), /never finished its checkout/u);
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, first, "the session is still where it was");
  });
});

test("a refused stale directory keeps the session's own row, since that attempt replaced nothing", async () => {
  await withSession("stale-keeps-row", async (h) => {
    const worktree = await leaveWorkBehind(h, "fix/install-link", {});
    pruneWhileUnmounted(h, worktree);
    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    await waitFor(() => failure(h) !== undefined, "the refusal did not fail the switch");
    assert.ok(h.store.readMeta(h.sessionId)!.locationHistory!.some((left) => left.worktrees.some((row) => row.path === worktree)));
  });
});

test("a person who commits and then deletes the directory keeps that branch: only a branch still at its base is given back", async () => {
  if (process.platform === "win32") return;
  await withSession("absent-with-commit", async (h) => {
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, ...FAILING_STEP }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "setup on the default branch");
    serveOriginLocally(h);
    const branch = `agent/${h.sessionId}`;
    const removal = stickRemoval(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined })), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    const slot = journal(h)[0]!.worktreePath;
    writeFileSync(join(slot, "tracked.txt"), "committed by a person\n");
    git(slot, "add", "tracked.txt");
    git(slot, "commit", "--quiet", "-m", "a person's commit");
    const tip = git(slot, "rev-parse", "HEAD");
    rmSync(slot, { recursive: true, force: true });
    removal.free();
    dueLater(h);
    await internalsOf(h).replayDeferredWorktreeRetirements();

    assert.deepEqual(journal(h), []);
    assert.equal(git(h.docs, "rev-parse", `refs/heads/${branch}`), tip, "the commit is still on its branch");

    // The next default switch cannot make that branch, so its refusal says what to do.
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined, occurrenceId: "occurrence-next" })), { ok: true });
    await waitFor(() => h.store.readMeta(h.sessionId)?.pendingLocationSwitch === undefined, "the next attempt did not settle");
    assert.match(failure(h)!.reason!, /already exists/u);
    assert.match(failure(h)!.reason!, /branch to recover|delete the branch/iu);
    assert.equal(git(h.docs, "rev-parse", `refs/heads/${branch}`), tip);
  });
});

test("a person who moves the worktree elsewhere keeps it and its branch: the rollback finds nothing at its path and ends", async () => {
  if (process.platform === "win32") return;
  await withSession("moved-away", async (h) => {
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, ...FAILING_STEP }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "setup on the default branch");
    serveOriginLocally(h);
    const branch = `agent/${h.sessionId}`;
    const removal = stickRemoval(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined })), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    const slot = journal(h)[0]!.worktreePath;
    const moved = join(h.root, "moved-here");
    git(h.docs, "worktree", "move", slot, moved);
    writeFileSync(join(moved, "notes.txt"), "a person's notes\n");
    const before = workState(moved, branch);
    removal.free();
    dueLater(h);
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.deepEqual(workState(moved, branch), before);
    assert.ok(errorText(h).some((text) => text.includes(branch) && /kept/u.test(text)), "and it says the branch stays");
  });
});

test("a request that succeeds leaves no spent proof in its worktree, and neither does one kept for a setup retry", async () => {
  await withSession("request-proof-spent", async (h) => {
    git(h.docs, "checkout", "--quiet", "-b", "config-base");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, ...FAILING_STEP }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "failing setup");
    git(h.docs, "checkout", "--quiet", "main");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");

    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/fine" });
    await waitFor(() => git(worktree.path, "for-each-ref", "refs/worktree") === "", "the spent proof stayed after success");

    const retained = h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/retained" });
    await answerTrust(h, "trust");
    await assert.rejects(retained, /required worktree setup failed/u);
    const slot = await docsSlot(h, "fix/retained");
    await waitFor(() => git(slot, "for-each-ref", "refs/worktree") === "", "the spent proof stayed on the retained worktree");
    assert.deepEqual(journal(h), [], "a retained worktree has no rollback");
  });
});

test("a branch moved and put back from another worktree keeps its reflog: the branch stays though its worktree goes", async () => {
  if (process.platform === "win32") return;
  await withSession("branch-reflog", async (h) => {
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, ...FAILING_STEP }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "setup on the default branch");
    serveOriginLocally(h);
    const branch = `agent/${h.sessionId}`;
    const removal = stickRemoval(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ recoverBranch: undefined })), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    const base = git(h.docs, "rev-parse", `refs/heads/${branch}`);
    const held = git(h.docs, "commit-tree", `${base}^{tree}`, "-p", base, "-m", "held only by the branch's reflog");
    git(h.docs, "update-ref", `refs/heads/${branch}`, held);
    git(h.docs, "update-ref", `refs/heads/${branch}`, base);
    removal.free();
    dueLater(h);
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.ok(git(h.docs, "reflog", "show", "--format=%H", `refs/heads/${branch}`).includes(held), "that commit is still reachable");
    assert.ok(errorText(h).some((text) => text.includes(branch) && /kept/u.test(text)), "and the session is told the branch stays");
  });
});

test("a snapshot that could not be taken after setup is never taken late: a release after the move began keeps the worktree", async () => {
  await withSession("late-snapshot", async (h) => {
    const internals = internalsOf(h) as unknown as Internals & { recordRollbackSnapshot: (record: WorktreeCleanupRecord) => Promise<void> };
    const record = internals.recordRollbackSnapshot.bind(h.manager);
    let calls = 0;
    // The second recording is the one after setup: its read fails, so the record holds none.
    internals.recordRollbackSnapshot = async (item) => {
      calls++;
      if (calls !== 2) return record(item);
      delete item.rollbackSnapshot;
      internalsOf(h).cleanupJournal.add(item);
    };
    const replace = internals.replaceProviderProcess.bind(h.manager);
    let slot = "";
    internals.replaceProviderProcess = async (...args) => {
      // In the gap: the old provider is retiring and anyone may already have written here.
      slot = journal(h)[0]!.worktreePath;
      writeFileSync(join(slot, "written-in-the-gap.txt"), "someone's work\n");
      const pending = h.store.readMeta(h.sessionId)!.pendingLocationSwitch!;
      h.store.patchMeta(h.sessionId, { pendingLocationSwitch: { ...pending, occurrenceId: "occurrence-other" } });
      return replace(...args);
    };
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => slot !== "" && journal(h).length === 0, "the superseded attempt did not settle");
    assert.equal(calls, 2, "nothing was recorded after the move began");
    assert.equal(readFileSync(join(slot, "written-in-the-gap.txt"), "utf8"), "someone's work\n", "kept, not removed");
    assert.ok(errorText(h).some((text) => text.includes(slot) && /kept/iu.test(text)));
  });
});

test("a rollback whose worktree was replaced tells the session, and the request row it kept cannot run setup again", async () => {
  await withSession("mismatch-told", async (h) => {
    git(h.docs, "checkout", "--quiet", "-b", "config-base");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, setup: [{ name: "Leave a File", command: write("from-setup", "'x'"), timeoutSeconds: 30 }] }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "setup");
    git(h.docs, "checkout", "--quiet", "main");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const internals = internalsOf(h);
    const activate = internals.activateWorktreeWithNotice.bind(h.manager);
    internals.activateWorktreeWithNotice = async () => { throw new Error("activation failed"); };
    const removal = stickRemoval(h);
    const failing = h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/other" });
    await answerTrust(h, "trust");
    await assert.rejects(failing, /activation failed/u);
    internals.activateWorktreeWithNotice = activate;
    const slot = journal(h)[0]!.worktreePath;
    // A person replaces it with a worktree of their own on that path.
    git(h.docs, "worktree", "remove", "--force", slot);
    git(h.docs, "worktree", "add", "--quiet", slot, "fix/other");
    removal.free();
    dueLater(h);
    await internals.replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.equal(existsSync(slot), true);
    assert.ok(errorText(h).some((text) => text.includes(slot) && /kept/iu.test(text)), "the session is told");
    const row = h.store.readMeta(h.sessionId)!.worktrees!.find((item) => item.path === slot);
    assert.equal(row?.setup, undefined, "and its row has no setup to retry over their worktree");
    await assert.rejects(h.manager.retryWorktreeSetup(h.sessionId, slot), /not failed/u);
  });
});

test("a launch that loses after remaking a session worktree on a branch with its own commits keeps that branch and its reflog", async () => {
  if (process.platform === "win32") return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-launch-kept-branch-")));
  const fake = fakeProvider();
  const sessionId = "s_launch_kept_branch";
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 2);
  try {
    // No origin, so nothing waits on a network.
    const app = join(root, "app");
    mkdirSync(app);
    git(app, "init", "--quiet", "--initial-branch=main");
    git(app, "commit", "--quiet", "--allow-empty", "-m", "base");
    manager.configureSharedDirectories([{ id: "app", name: "App", path: realpathSync(app) }] as never);
    // The session's branch holds its own commit, with a setup, and its directory has gone.
    git(app, "checkout", "--quiet", "-b", `agent/${sessionId}`);
    writeFileSync(join(app, ".wollipog.json"), JSON.stringify({ version: 1, setup: [{ name: "Step", command: sleep, timeoutSeconds: 120 }] }));
    git(app, "add", ".wollipog.json");
    git(app, "commit", "--quiet", "-m", "the session's own commit");
    const tip = git(app, "rev-parse", "HEAD");
    git(app, "checkout", "--quiet", "main");

    const starting = manager.start({ sessionId, workspaceId: "app", workspacePath: realpathSync(app), agentId: "claude-code", command: "claude-code",
      args: [], env: {}, useWorktree: true, driver: "claude-code", context: { kind: "native" } }).catch(() => undefined);
    const cards = () => store.readEvents(sessionId).map((event) => event.payload).filter((payload) => payload.kind === "permission_request");
    await waitFor(() => store.has(sessionId) && cards().length > 0, "the remade worktree's setup did not ask for trust");
    const worktrees = () => git(app, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;
    assert.equal(worktrees(), 2, "the launch made a worktree on that branch");
    // Stopped while trust is open: the launch loses, and rolls back what it made.
    manager.stop(sessionId);
    await starting;
    await waitFor(() => worktrees() === 1, "the launch did not give back its worktree");
    assert.equal(git(app, "rev-parse", `refs/heads/agent/${sessionId}`), tip, "the branch and its commit stay");
    assert.ok(git(app, "reflog", "show", "--format=%H", `refs/heads/agent/${sessionId}`).includes(tip), "and so does its reflog");
  } finally {
    manager.shutdownAll();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a forced removal of an unchanged worktree still happens, and reports itself", async () => {
  await withSession("removal-reported", async (h) => {
    const { record, removal } = await stuckProvedRollback(h, { setup: [
      { name: "Leave a File", command: write("from-setup", "'x'"), timeoutSeconds: 30 },
      { name: "Then Fail", command: fail, timeoutSeconds: 30 },
    ] });
    assert.equal(existsSync(join(record.worktreePath, "from-setup")), true, "setup's own output, not a person's");
    removal.free();
    dueLater(h);
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.equal(existsSync(record.worktreePath), false);
    assert.ok(errorText(h).some((text) => text.includes(record.worktreePath) && /has been removed/u.test(text)),
      "someone was told it was still there, so someone hears that it is gone");
  });
});

test("with no snapshot on record, even an untouched worktree is kept, since nothing proves it is untouched", async () => {
  await withSession("no-baseline", async (h) => {
    const { record, removal } = await stuckProvedRollback(h);
    const slot = record.worktreePath;
    delete record.rollbackSnapshot;
    internalsOf(h).cleanupJournal.add(record);
    const before = files(slot);
    removal.free();
    dueLater(h);
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.deepEqual(files(slot), before);
  });
});

test("a given-up rollback stays given up through a real restart, says so only once, and finishes when asked after the blocker clears", async (t) => {
  // On the prototype, so the blocker outlives the runner the way a stuck process would.
  const prototype = SessionManager.prototype as unknown as Internals;
  const retire = prototype.retireWorktreeProcesses;
  let blocked = true;
  prototype.retireWorktreeProcesses = async function (this: unknown, ...args: unknown[]) {
    if (blocked) throw new Error("worktree descendant process retirement is unconfirmed");
    return retire.apply(this, args);
  };
  t.after(() => { prototype.retireWorktreeProcesses = retire; });
  await withSession("give-up-restart", async (h) => {
    commitSetup(h, FAILING_STEP);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    const slot = journal(h)[0]!.worktreePath;

    let now = Date.now();
    internalsOf(h).worktreePullRequestDiscoveryNow = () => now;
    for (let pass = 0; pass < 12; pass++) {
      now += 24 * 60 * 60 * 1000;
      await internalsOf(h).replayDeferredWorktreeRetirements();
    }
    const gaveUp = () => errorText(h).filter((text) => text.includes(slot) && /stopped trying/u.test(text));
    assert.equal(gaveUp().length, 1);
    const attempts = journal(h)[0]!.rollbackAttempts;
    assert.ok(journal(h)[0]!.rollbackGaveUpAt);

    h.restart();
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.ok(journal(h)[0]?.rollbackGaveUpAt, "the journal remembers");
    assert.equal(gaveUp().length, 1, "and the restart's one try does not say it again");
    assert.ok(journal(h)[0]!.rollbackAttempts! >= attempts!);
    const settled = journal(h)[0]!.rollbackAttempts;
    const later = Date.now() + 365 * 24 * 60 * 60 * 1000;
    internalsOf(h).worktreePullRequestDiscoveryNow = () => later;
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.equal(journal(h)[0]!.rollbackAttempts, settled, "the schedule does not restart");

    blocked = false;
    await relaunch(h, "app", h.app);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-after" })), { ok: true });
    await waitFor(() => !journal(h).some((item) => item.worktreePath === slot && item.rollbackGaveUpAt), "asking again did not finish it");
  });
});

test("a worktree remade on a path this session used before is rolled back as new: no old setup comes back with it", async () => {
  await withSession("remade-history", async (h) => {
    const ranLog = join(h.root, "ran");
    const worktree = await leaveSetUpWorktree(h, ranLog);
    // A person removes it, and the new attempt on that path fails its setup.
    git(h.docs, "worktree", "remove", "--force", worktree);
    git(h.docs, "checkout", "--quiet", "fix/install-link");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, setup: [{ name: "Log and Maybe Fail", command: [process.execPath, "-e",
      `const fs=require('fs');fs.appendFileSync(${JSON.stringify(ranLog)},'x');process.exit(fs.existsSync(${JSON.stringify(join(h.root, "pass"))})?0:3)`], timeoutSeconds: 30 }] }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "new setup");
    git(h.docs, "checkout", "--quiet", "main");
    const removal = stickRemoval(h);
    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    // The second card this session has seen: the new configuration's.
    await waitFor(() => payloads(h, "permission_request").length === 2, "the new configuration's trust card was not shown");
    h.manager.resolvePermission(h.sessionId, payloads(h, "permission_request")[1].requestId, "trust");
    await waitFor(() => failure(h)?.reason?.includes("required worktree setup failed") === true, "the new setup did not fail the switch");
    assert.equal(readFileSync(ranLog, "utf8"), "xx", "this attempt's setup ran");
    assert.equal(journal(h)[0]?.worktreePath, worktree, "and its rollback is on record");
    removal.free();
    dueLater(h);
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.equal(existsSync(worktree), false, "the old row does not make the new tree someone's work: it goes");

    // The next return makes it new again, rather than giving a new tree the old setup's environment.
    writeFileSync(join(h.root, "pass"), "");
    assert.deepEqual(await backToDocs(h, "fix/install-link", "occurrence-next"), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1 || h.store.readMeta(h.sessionId)?.pendingLocationSwitch === undefined &&
      h.store.readMeta(h.sessionId)?.repoPath !== h.docs, "the next return did not settle");
    assert.equal(h.store.readMeta(h.sessionId)?.repoPath, h.docs);
    assert.equal(h.providers[3]!.env?.SWITCH_SETUP_VALUE, undefined, "the old environment did not come back");
    assert.equal(readFileSync(ranLog, "utf8"), "xxx", "it set up as new");
  });
});

test("selection tries a stuck rollback again, so clearing the blocker and selecting works", async () => {
  await withSession("select-retries", async (h) => {
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
    const tried = removal.attempts();

    await assert.rejects(h.manager.selectWorktree(h.sessionId, record!.worktreePath), /still removing/u);
    assert.equal(removal.attempts(), tried + 1, "the refusal comes after one more try, as its text promises");

    removal.free();
    await assert.rejects(h.manager.selectWorktree(h.sessionId, record!.worktreePath), /not linked/u, "it finished, so that worktree is gone");
    assert.deepEqual(journal(h), []);
    assert.equal(existsSync(record!.worktreePath), false);
    assert.equal(h.store.readMeta(h.sessionId)?.worktreePath, first);
  });
});

test("a request's failed activation keeps a row with a person's work in it, its ports held, and the retry continues there without setup", async () => {
  await withSession("request-kept", async (h) => {
    const ranLog = join(h.root, "ran");
    git(h.docs, "checkout", "--quiet", "-b", "config-base");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, setup: [{ name: "Log the Run",
      command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(ranLog)},'x')`], timeoutSeconds: 30 }] }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "setup");
    git(h.docs, "checkout", "--quiet", "main");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const internals = internalsOf(h);
    const activate = internals.activateWorktreeWithNotice.bind(h.manager);
    internals.activateWorktreeWithNotice = async () => { throw new Error("activation failed"); };
    const removal = stickRemoval(h);
    const failing = h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/other" });
    await answerTrust(h, "trust");
    await assert.rejects(failing, /activation failed/u);
    internals.activateWorktreeWithNotice = activate;
    assert.equal(readFileSync(ranLog, "utf8"), "x");
    const [record] = journal(h);
    assert.ok(record?.rollbackProof, "the proof was written before setup, not at rollback");
    const slot = record!.worktreePath;
    const row = () => h.store.readMeta(h.sessionId)!.worktrees!.find((item) => item.path === slot);
    assert.ok(row(), "the row stays while its rollback is pending");
    const owner = `${h.sessionId}\0${row()!.id}`;
    const block = internals.worktreePortAllocator.get(owner);
    assert.ok(block);

    writeFileSync(join(slot, "notes.txt"), "a person's notes\n");
    const before = files(slot);
    removal.free();
    dueLater(h);
    await internals.replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.deepEqual(files(slot), before);
    assert.ok(row(), "the row stays with the kept worktree");
    assert.deepEqual(internals.worktreePortAllocator.get(owner), block, "and holds its ports");

    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/other" });
    assert.equal(worktree.path, slot, "the retry continues there, rather than failing with no owner");
    assert.equal(readFileSync(ranLog, "utf8"), "x", "with no setup over the work");
    assert.deepEqual(files(slot), before);
  });
});

test("a request's failed activation of an unchanged worktree runs teardown, removes it and frees its ports", async () => {
  await withSession("request-unchanged", async (h) => {
    const teardownLog = join(h.root, "teardown-log");
    git(h.docs, "checkout", "--quiet", "-b", "config-base");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1,
      setup: [{ name: "Leave a File", command: write("from-setup", "'x'"), timeoutSeconds: 30 }],
      teardown: [{ name: "Tear Down", command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(teardownLog)},'x')`], timeoutSeconds: 30 }] }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "setup");
    git(h.docs, "checkout", "--quiet", "main");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const internals = internalsOf(h);
    const activate = internals.activateWorktreeWithNotice.bind(h.manager);
    internals.activateWorktreeWithNotice = async () => { throw new Error("activation failed"); };
    const failing = h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/other" });
    await answerTrust(h, "trust");
    await assert.rejects(failing, /activation failed/u);
    internals.activateWorktreeWithNotice = activate;
    const slot = await docsSlot(h, "fix/other");
    assert.deepEqual(journal(h), []);
    assert.equal(existsSync(slot), false);
    assert.equal(readFileSync(teardownLog, "utf8"), "x");
    assert.throws(() => git(h.docs, "rev-parse", "--verify", "refs/heads/fix/other"), "the branch it made goes");
    assert.equal(h.store.readMeta(h.sessionId)!.worktrees!.some((item) => item.path === slot), false);
    assert.equal(internals.worktreePortAllocator.get(`${h.sessionId}\0${requestedSlot("fix/other")}`), undefined);
  });
});

test("a completed setup whose configuration cannot be read just now launches without its environment, keeps its setup, and gets it back later", async () => {
  await withSession("return-transient", async (h) => {
    const ranLog = join(h.root, "ran");
    const worktree = await leaveSetUpWorktree(h, ranLog);
    const left = h.store.readMeta(h.sessionId)!.locationHistory!.flatMap((entry) => entry.worktrees).find((row) => row.path === worktree)!;
    const baseCommit = left.baseCommit!;
    rewriteLeftRow(h, worktree, (row) => ({ ...row, baseCommit: "0".repeat(40) }));
    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1 || failure(h) !== undefined, "the switch back did not settle");
    assert.equal(failure(h), undefined, "it launches");
    assert.equal(h.providers[3]!.env?.SWITCH_SETUP_VALUE, undefined);
    assert.match(h.providers[3]!.prompts[0]!, /could not be read/u, "the notice says what happened");
    assert.doesNotMatch(h.providers[3]!.prompts[0]!, /never finished/u, "not that setup failed");
    const row = h.store.readMeta(h.sessionId)!.worktrees![0]!;
    assert.equal(row.setup?.status, "completed", "and it keeps what it finished");
    assert.equal(readFileSync(ranLog, "utf8"), "x");

    // The read recovers, and the next launch restores the environment with no setup.
    h.store.patchMeta(h.sessionId, { worktrees: [{ ...row, baseCommit }] });
    h.restart();
    await relaunch(h, "docs", h.docs);
    assert.equal(h.providers.at(-1)!.env?.SWITCH_SETUP_VALUE, "from-setup");
    assert.equal(readFileSync(ranLog, "utf8"), "x");
  });
});

test("a read that works before the move and fails at the relaunch still launches, and the row survives for later", async () => {
  await withSession("return-reverse-race", async (h) => {
    const ranLog = join(h.root, "ran");
    await leaveSetUpWorktree(h, ranLog);
    const internals = internalsOf(h);
    const replace = internals.replaceProviderProcess.bind(h.manager);
    internals.replaceProviderProcess = async (...args) => {
      const options = args[2] as { replacementMeta: () => { worktrees?: SessionWorktreeView[] } | undefined };
      const commit = options.replacementMeta;
      // The read inside the relaunch finds what the read before the move did not: a commit it cannot load.
      options.replacementMeta = () => {
        const moved = commit();
        if (!moved) return moved;
        return h.store.patchMeta(h.sessionId, { worktrees: moved.worktrees!.map((row) => ({ ...row, baseCommit: "0".repeat(40) })) }) ?? undefined;
      };
      return replace(...args);
    };
    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1 || failure(h) !== undefined, "the switch back did not settle");
    assert.equal(failure(h), undefined, "the move is not stranded by it");
    assert.equal(h.providers[3]!.env?.SWITCH_SETUP_VALUE, undefined);
    assert.equal(h.store.readMeta(h.sessionId)!.worktrees![0]!.setup?.status, "completed");
    assert.ok(stderrText(h).some((text) => /setup environment is not available/u.test(text)), "the launch itself says so");
    assert.equal(readFileSync(ranLog, "utf8"), "x");
  });
});

test("a completed setup whose configuration reads differently never runs again on any later launch", async () => {
  await withSession("return-hash-differs", async (h) => {
    const ranLog = join(h.root, "ran");
    const worktree = await leaveSetUpWorktree(h, ranLog);
    rewriteLeftRow(h, worktree, (row) => ({ ...row, setup: { ...row.setup!, configHash: "0".repeat(64) } }));
    assert.deepEqual(await backToDocs(h, "fix/install-link"), { ok: true });
    await waitFor(() => h.providers[3]?.prompts.length === 1 || failure(h) !== undefined, "the switch back did not settle");
    assert.equal(failure(h), undefined);
    assert.equal(readFileSync(ranLog, "utf8"), "x");
    h.restart();
    await relaunch(h, "docs", h.docs);
    assert.equal(readFileSync(ranLog, "utf8"), "x", "not on the next one either");
  });
});

test("retries after a removal that finished are counted too, so a stuck metadata repair gives up rather than retrying forever", async () => {
  await withSession("removed-retries", async (h) => {
    const { removal } = await stuckProvedRollback(h);
    removal.free();
    const internals = internalsOf(h) as unknown as Internals & { forgetRemovedWorktree: (...args: unknown[]) => Promise<unknown> };
    internals.forgetRemovedWorktree = async () => undefined;
    const original = h.store.readMeta.bind(h.store);
    const slot = journal(h)[0]!.worktreePath;
    // The selection still names the path, which is what keeps the repair from finishing.
    (h.store as unknown as { readMeta: (id: string) => unknown }).readMeta = (id: string) => {
      const meta = original(id);
      return meta ? { ...meta, worktrees: [...(meta.worktrees ?? []), { id: journal(h)[0]?.worktreeId, path: slot, branch: "fix/install-link", source: "created" }] } : meta;
    };
    let now = Date.now();
    internals.worktreePullRequestDiscoveryNow = () => now;
    for (let pass = 0; pass < 15; pass++) {
      now += 24 * 60 * 60 * 1000;
      await internals.replayDeferredWorktreeRetirements();
    }
    (h.store as unknown as { readMeta: typeof original }).readMeta = original;
    assert.ok(journal(h)[0]?.worktreeRemovedAt, "the removal itself finished");
    assert.ok(journal(h)[0]?.rollbackGaveUpAt, "and the retries were counted");
  });
});

test("a snapshot that cannot be read ends in keeping the worktree: it is never removed, and the record does not wait forever", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  await withSession("unreadable-snapshot", async (h) => {
    const { record, removal } = await stuckProvedRollback(h);
    const slot = record.worktreePath;
    const before = files(slot);
    const hidden = join(git(slot, "rev-parse", "--absolute-git-dir"), "unreadable");
    writeFileSync(hidden, "recovery\n");
    chmodSync(hidden, 0o000);
    removal.free();
    let now = Date.now();
    internalsOf(h).worktreePullRequestDiscoveryNow = () => now;

    // One failure is no decision: the record waits, so a passing failure costs nothing.
    now += 24 * 60 * 60 * 1000;
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.equal(journal(h).length, 1, "it tries again");
    assert.deepEqual(files(slot), before);

    for (let pass = 0; pass < 12; pass++) {
      now += 24 * 60 * 60 * 1000;
      await internalsOf(h).replayDeferredWorktreeRetirements();
    }
    assert.deepEqual(journal(h), [], "the schedule ended, so the record did");
    assert.deepEqual(files(slot), before, "and the worktree is still there");
    assert.ok(errorText(h).some((text) => text.includes(slot) && /kept/iu.test(text)), "and the session is told");
    chmodSync(hidden, 0o644);

    // And the next attempt continues there, rather than being refused by a record that cannot finish.
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message({ occurrenceId: "occurrence-next" })), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1, "the next attempt did not finish");
    assert.equal(h.store.readMeta(h.sessionId)!.worktrees![0]!.source, "attached");
  });
});

test("a read that comes back before the schedule ends goes on to remove an unchanged worktree", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  await withSession("snapshot-recovers", async (h) => {
    const { record, removal } = await stuckProvedRollback(h);
    // A passing failure of the read itself: its contents, which are all the snapshot records, never change.
    const reflog = join(git(record.worktreePath, "rev-parse", "--absolute-git-dir"), "logs", "HEAD");
    chmodSync(reflog, 0o000);
    removal.free();
    const internals = internalsOf(h);
    dueLater(h);
    await internals.replayDeferredWorktreeRetirements();
    assert.equal(journal(h).length, 1, "no answer, so it waits");
    assert.equal(existsSync(record.worktreePath), true);
    chmodSync(reflog, 0o644);
    const later = Date.now() + 365 * 24 * 60 * 60 * 1000;
    internals.worktreePullRequestDiscoveryNow = () => later;
    await internals.replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), []);
    assert.equal(existsSync(record.worktreePath), false, "and then the snapshot still matches");
  });
});

test("a record whose repository has gone, directory still there, ends once it gives up: it cannot wait forever", async () => {
  await withSession("repository-gone", async (h) => {
    const { record, removal } = await stuckProvedRollback(h);
    const before = files(record.worktreePath);
    removal.free();
    renameSync(h.docs, `${h.docs}.gone`);
    let now = Date.now();
    internalsOf(h).worktreePullRequestDiscoveryNow = () => now;
    for (let pass = 0; pass < 12; pass++) {
      now += 24 * 60 * 60 * 1000;
      await internalsOf(h).replayDeferredWorktreeRetirements();
    }
    assert.deepEqual(journal(h), []);
    assert.deepEqual(files(record.worktreePath), before, "and the directory is left alone");
    renameSync(`${h.docs}.gone`, h.docs);
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

test("a Git refusal keeps a set-up worktree's rollback, so its teardown and ports wait for an answer rather than being lost", async () => {
  await withSession("refusal-keeps-rollback", async (h) => {
    const teardownLog = join(h.root, "teardown-log");
    commitSetup(h, {
      setup: [{ name: "Always Fail", command: fail, timeoutSeconds: 30 }],
      teardown: [{ name: "Stop Services", command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(teardownLog)},'x')`], timeoutSeconds: 30 }],
    });
    const removal = stickRemoval(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await answerTrust(h, "trust");
    await waitFor(() => failure(h) !== undefined, "the failed setup did not fail the switch");
    const [record] = journal(h);
    assert.ok(record?.rollbackProof, "setup ran, so the proof is on record");
    assert.ok(record?.hooks?.teardown.length, "with what it takes to undo it");
    removal.free();

    const internals = internalsOf(h);
    const owner = `${h.sessionId}\0${record!.worktreeId}`;
    const block = internals.worktreePortAllocator.get(owner);
    assert.ok(block);
    let now = Date.now() + 24 * 60 * 60 * 1000;
    internals.worktreePullRequestDiscoveryNow = () => now;

    const config = join(h.docs, ".git", "config");
    const original = readFileSync(config);
    writeFileSync(config, "[broken\n");
    await internals.replayDeferredWorktreeRetirements();
    writeFileSync(config, original);

    assert.equal(journal(h).length, 1, "the record stays");
    assert.deepEqual(internals.worktreePortAllocator.get(owner), block, "its ports stay held");
    assert.equal(existsSync(teardownLog), false, "and its teardown has not run yet");
    assert.equal(existsSync(record!.worktreePath), true);

    now += 24 * 60 * 60 * 1000;
    await internals.replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), [], "the next attempt finishes it");
    assert.equal(readFileSync(teardownLog, "utf8"), "x", "with its teardown");
    assert.equal(existsSync(record!.worktreePath), false);
    assert.equal(internals.worktreePortAllocator.get(owner), undefined);
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

// The forced removal paths and kept-worktree leaks left after #4395.

interface KeepInternals {
  reapWorktree: (...args: unknown[]) => Promise<void>;
  terminateRollbackProcesses: (marker: string) => Promise<boolean>;
}
const keepInternalsOf = (h: Harness) => h.manager as unknown as KeepInternals;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const keptNotices = (h: Harness) => errorText(h).filter((text) => /^Kept the (worktree|directory)/u.test(text));

/** In docs, a request for `fix/other` whose activation fails while its removal is stuck, then a person
 * writes notes in it, so the rollback keeps it. `setup` is the request's setup step. */
async function keptRequest(h: Harness, setup: unknown, beforeKeep?: (slot: string) => void) {
  git(h.docs, "checkout", "--quiet", "-b", "config-base");
  writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, setup: [setup] }));
  git(h.docs, "add", ".wollipog.json");
  git(h.docs, "commit", "--quiet", "-m", "setup");
  git(h.docs, "checkout", "--quiet", "main");
  assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
  await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
  const internals = internalsOf(h);
  const activate = internals.activateWorktreeWithNotice.bind(h.manager);
  internals.activateWorktreeWithNotice = async () => { throw new Error("activation failed"); };
  const removal = stickRemoval(h);
  const failing = h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/other" });
  await answerTrust(h, "trust");
  await assert.rejects(failing, /activation failed/u);
  internals.activateWorktreeWithNotice = activate;
  const [record] = journal(h);
  const slot = record!.worktreePath;
  const row = h.store.readMeta(h.sessionId)!.worktrees!.find((item) => item.path === slot)!;
  writeFileSync(join(slot, "notes.txt"), "a person's notes\n");
  beforeKeep?.(slot);
  const before = files(slot);
  removal.free();
  dueLater(h);
  await internals.replayDeferredWorktreeRetirements();
  return { slot, owner: `${h.sessionId}\0${row.id}`, before };
}

const LOG_STEP = (h: Harness) => ({ name: "Log the Run", command: [process.execPath, "-e",
  `require('fs').appendFileSync(${JSON.stringify(join(h.root, "ran"))},'x')`], timeoutSeconds: 30 });

for (const replay of ["at once", "after a restart", "after a relaunch"] as const) {
  test(`deleting a session leaves a worktree its request's rollback kept for a person's work, byte for byte (${replay})`, async () => {
    await withSession(`delete-kept-request-${replay.replaceAll(" ", "-")}`, async (h) => {
      const { slot, owner, before } = await keptRequest(h, LOG_STEP(h));
      assert.deepEqual(journal(h), [], "the rollback kept it and ended");
      const current = h.store.readMeta(h.sessionId)!.worktreePath!;
      const tip = git(h.docs, "rev-parse", "refs/heads/fix/other");

      if (replay === "after a relaunch") {
        // A launch rebuilds the session's record, and the keep has to survive that.
        h.restart();
        await relaunch(h, "docs", h.docs);
        await h.manager.delete(h.sessionId);
      } else if (replay === "after a restart") {
        // The deletion is on record, and a real restart replays it.
        keepInternalsOf(h).reapWorktree = async () => {};
        await h.manager.delete(h.sessionId);
        assert.ok(journal(h).length >= 1, "the deletion is journaled");
        h.restart();
        await waitFor(() => journal(h).length === 0, "the restart did not settle the deletion");
      } else {
        await h.manager.delete(h.sessionId);
      }
      assert.equal(h.store.has(h.sessionId), false);
      assert.deepEqual(files(slot), before, "every file the person kept is there");
      assert.ok(docsWorktrees(h).includes(slot), "still a worktree");
      assert.equal(git(h.docs, "rev-parse", "refs/heads/fix/other"), tip, "on its branch");
      assert.equal(internalsOf(h).worktreePortAllocator.get(owner), undefined, "its ports are free");
      assert.equal(existsSync(current), false, "a worktree nobody kept still goes with the session");
      assert.deepEqual(journal(h), []);
    });
  });
}

test("a keep that lands while a relaunch waits for the worktree lane survives the relaunch's write, and deletion leaves it", async () => {
  await withSession("keep-during-relaunch", async (h) => {
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/plain" });
    writeFileSync(join(worktree.path, "notes.txt"), "a person's notes\n");
    const before = files(worktree.path);
    // As an older runner left the session: not yet known to record every keep.
    h.store.patchMeta(h.sessionId, { keptWorktreesTracked: undefined });
    h.restart();
    const lease = h.store.readWorktreeLease(h.sessionId);
    if (lease) h.store.releaseWorktreeLease(h.sessionId, lease.owner);
    const lane = h.manager as unknown as {
      runWorktreeOperation: (sessionId: string, operation: () => Promise<void>) => Promise<void>;
      markWorktreeKept: (sessionId: string, path: string) => void;
    };
    // An operation queued right behind the relaunch's first use of the lane, its remap check, starts
    // before the relaunch reads the session, and keeps that worktree before the relaunch writes.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const run = lane.runWorktreeOperation.bind(h.manager);
    let keeping: Promise<void> | undefined;
    lane.runWorktreeOperation = (sessionId, operation) => {
      const result = run(sessionId, operation);
      keeping ??= run(sessionId, async () => {
        await held;
        lane.markWorktreeKept(h.sessionId, worktree.path);
        // A keep also forgets history rows at its path; stand in for that with a visible edit.
        assert.equal(h.store.readMeta(h.sessionId)!.locationHistory!.length, 1);
        // And a deletion's look at an older runner's session records that it has looked.
        h.store.patchMeta(h.sessionId, { locationHistory: [], keptWorktreesTracked: true });
      });
      return result;
    };
    const starting = h.manager.start({ sessionId: h.sessionId, workspaceId: "docs", workspacePath: h.docs, agentId: "claude-code",
      command: "claude-code", args: [], env: {}, useWorktree: false, driver: "claude-code", context: { kind: "native" } });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    release();
    await keeping;
    await starting;
    assert.ok(h.store.readMeta(h.sessionId)?.keptWorktreePaths?.includes(worktree.path), "the relaunch kept the keep");
    assert.equal(h.store.readMeta(h.sessionId)!.locationHistory?.length ?? 0, 0, "and the history as the operation left it");
    assert.equal(h.store.readMeta(h.sessionId)!.keptWorktreesTracked, true, "and that its keeps are recorded");
    await h.manager.delete(h.sessionId);
    assert.deepEqual(files(worktree.path), before);
    assert.ok(docsWorktrees(h).includes(worktree.path));
  });
});

test("a keep that lands while a deletion is under way is honored: the deletion leaves that worktree", async () => {
  await withSession("keep-during-delete", async (h) => {
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/plain" });
    writeFileSync(join(worktree.path, "notes.txt"), "a person's notes\n");
    const before = files(worktree.path);
    const lane = h.manager as unknown as {
      runWorktreeOperation: (sessionId: string, operation: () => Promise<void>) => Promise<void>;
      markWorktreeKept: (sessionId: string, path: string) => void;
    };
    // An operation already under way when the deletion begins keeps this worktree only after the
    // deletion has read the session and written its records.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const keeping = lane.runWorktreeOperation(h.sessionId, async () => {
      await held;
      lane.markWorktreeKept(h.sessionId, worktree.path);
    });
    const deleting = h.manager.delete(h.sessionId);
    await waitFor(() => journal(h).some((record) => record.trigger === "session_delete" && record.worktreePath === worktree.path),
      "the deletion did not write its records");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    release();
    await keeping;
    await deleting;
    assert.deepEqual(files(worktree.path), before, "the kept worktree is all there");
    assert.ok(docsWorktrees(h).includes(worktree.path));
  });
});

test("selecting a worktree a launch rollback still names ends that rollback, so a restart leaves the worktree", async () => {
  await withSession("select-ends-launch-rollback", async (h) => {
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const moved = h.store.readMeta(h.sessionId)!.worktreePath!;
    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/plain" });
    await h.manager.selectWorktree(h.sessionId, moved);
    await waitFor(() => h.store.readMeta(h.sessionId)?.worktreePath === moved && h.store.readMeta(h.sessionId)?.status !== "running",
      "the session did not go back to its first worktree");
    // A launch's rollback of this worktree that could not finish, as a refused identity check leaves.
    const internals = internalsOf(h);
    const meta = h.store.readMeta(h.sessionId)!;
    const row = meta.worktrees!.find((item) => item.path === worktree.path)!;
    internals.cleanupJournal.add({ ...internals.cleanupRecordForWorktree(meta, row, "creation_rollback", "force"),
      checkpointGenerationDisposable: true });
    await h.manager.selectWorktree(h.sessionId, worktree.path);
    await waitFor(() => h.store.readMeta(h.sessionId)?.worktreePath === worktree.path, "the selection did not land");
    writeFileSync(join(worktree.path, "notes.txt"), "work done since it was taken back\n");
    const before = files(worktree.path);
    assert.deepEqual(journal(h), [], "the selection ends the rollback");
    h.restart();
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    assert.deepEqual(files(worktree.path), before, "and a restart leaves the worktree as it is");
  });
});

test("a request that reaches setup only after its session's deletion began cancels it, so the deletion finishes", async () => {
  if (process.platform === "win32") return;
  await withSession("setup-after-delete", async (h) => {
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    git(h.docs, "checkout", "--quiet", "-b", "config-base");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, setup: [LOG_STEP(h)] }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "a setup nobody has trusted yet");
    git(h.docs, "checkout", "--quiet", "main");
    // The request's checkout waits at a gate, after the request has checked that the session can open.
    const hooks = join(h.root, "hooks");
    const started = join(h.root, "checkout-started");
    const gate = join(h.root, "checkout-gate");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\n: > ${JSON.stringify(started)}\nwhile [ ! -e ${JSON.stringify(gate)} ]; do sleep 0.05; done\n`,
      { mode: 0o755 });
    execFileSync("git", ["-C", h.docs, "config", "core.hooksPath", hooks]);
    const requesting = h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/late" }).then(() => "created", () => "failed");
    await waitFor(() => existsSync(started), "the request did not reach its checkout");

    // The deletion begins, and its provider takes a while to go, so the session's row is still there
    // when the request reaches setup.
    const internals = h.manager as unknown as { beginProviderRetirement: (...args: unknown[]) => { promise: Promise<unknown> } };
    const retire = internals.beginProviderRetirement.bind(h.manager);
    let letGo!: () => void;
    const retirementHeld = new Promise<void>((resolve) => { letGo = resolve; });
    internals.beginProviderRetirement = (...args) => {
      const retirement = retire(...args);
      return { ...retirement, promise: retirement.promise.then(async (value) => { await retirementHeld; return value; }) };
    };
    const deleting = h.manager.delete(h.sessionId).then(() => "deleted", (error: Error) => `failed: ${error.message}`);
    await waitFor(() => h.store.isDeleted(h.sessionId), "the deletion did not begin");
    writeFileSync(gate, "");
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    letGo();
    const settled = (promise: Promise<string>) => Promise.race([promise,
      new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 20_000))]);
    assert.equal(await settled(requesting), "failed", "the request ends without anyone answering a trust card");
    assert.equal(await settled(deleting), "deleted", "and the deletion finishes");
    const cardsShown = h.sent.filter((message) => message.type === "session_event" && message.sessionId === h.sessionId &&
      message.payload.kind === "permission_request" && message.payload.title === "Trust Worktree Setup Configuration?");
    assert.equal(cardsShown.length, 0, "no trust card was shown for a session being deleted");
  });
});

test("a keep that lands while a deletion ends a worktree's processes runs no teardown over it", async () => {
  await withSession("keep-before-teardown", async (h) => {
    const teardownLog = join(h.root, "teardown-log");
    git(h.docs, "checkout", "--quiet", "-b", "config-base");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, setup: [LOG_STEP(h)],
      teardown: [{ name: "Tear Down", command: [process.execPath, "-e", `require('fs').appendFileSync(${JSON.stringify(teardownLog)},'x')`], timeoutSeconds: 30 }] }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "setup and teardown");
    git(h.docs, "checkout", "--quiet", "main");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const requesting = h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/torn" });
    await answerTrust(h, "trust");
    const { worktree } = await requesting;
    writeFileSync(join(worktree.path, "notes.txt"), "a person's notes\n");
    const before = files(worktree.path);
    const internals = internalsOf(h);
    const retire = internals.retireWorktreeProcesses.bind(h.manager);
    internals.retireWorktreeProcesses = async (...args) => {
      await retire(...args);
      if (args[2] === worktree.path) {
        (h.manager as unknown as { markWorktreeKept: (sessionId: string, path: string) => void }).markWorktreeKept(h.sessionId, worktree.path);
      }
    };
    await h.manager.delete(h.sessionId);
    assert.equal(existsSync(teardownLog), false, "no teardown ran over what was kept");
    assert.deepEqual(files(worktree.path), before);
  });
});

test("deleting a session while its request's rollback is still pending lets that rollback decide, so hand edits are kept", async () => {
  await withSession("delete-pending-rollback", async (h) => {
    git(h.docs, "checkout", "--quiet", "-b", "config-base");
    writeFileSync(join(h.docs, ".wollipog.json"), JSON.stringify({ version: 1, setup: [LOG_STEP(h)] }));
    git(h.docs, "add", ".wollipog.json");
    git(h.docs, "commit", "--quiet", "-m", "setup");
    git(h.docs, "checkout", "--quiet", "main");
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const internals = internalsOf(h);
    const activate = internals.activateWorktreeWithNotice.bind(h.manager);
    internals.activateWorktreeWithNotice = async () => { throw new Error("activation failed"); };
    const removal = stickRemoval(h);
    const failing = h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/other" });
    await answerTrust(h, "trust");
    await assert.rejects(failing, /activation failed/u);
    internals.activateWorktreeWithNotice = activate;
    const [rollback] = journal(h);
    assert.ok(rollback?.auxiliaryWorktreeRollback, "the request's rollback is pending");
    const slot = rollback!.worktreePath;
    // Someone edits the stuck worktree by hand, then the session is deleted.
    writeFileSync(join(slot, "notes.txt"), "edited by hand\n");
    const before = files(slot);
    removal.free();
    await h.manager.delete(h.sessionId);
    assert.deepEqual(files(slot), before, "the rollback sees the edit and keeps the worktree");
    assert.deepEqual(journal(h), []);
  });
});

test("a kept mark goes once the runner itself removes that worktree", async () => {
  await withSession("mark-forgotten-on-removal", async (h) => {
    serveOriginLocally(h);
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const moved = h.store.readMeta(h.sessionId)!.worktreePath!;
    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "main", branch: "fix/plain" });
    await h.manager.selectWorktree(h.sessionId, moved);
    await waitFor(() => h.store.readMeta(h.sessionId)?.worktreePath === moved && h.store.readMeta(h.sessionId)?.status !== "running",
      "the session did not go back to its first worktree");
    (h.manager as unknown as { markWorktreeKept: (sessionId: string, path: string) => void }).markWorktreeKept(h.sessionId, worktree.path);
    assert.ok(h.store.readMeta(h.sessionId)?.keptWorktreePaths?.includes(worktree.path));
    // What was kept there has since been dealt with, and the worktree holds nothing of anyone's.
    const result = await h.manager.discardWorktree(h.sessionId, worktree.path);
    assert.equal(existsSync(worktree.path), false, JSON.stringify(result));
    assert.equal(h.store.readMeta(h.sessionId)?.keptWorktreePaths?.includes(worktree.path) ?? false, false,
      "nothing is kept at a path whose worktree the runner removed");
  });
});

for (const { kind, dirty, label } of [
  { kind: "with uncommitted work", dirty: true, label: "dirty" },
  { kind: "with a commit no remote has, and nothing uncommitted", dirty: true, label: "unpushed" },
  { kind: "holding nothing of its own", dirty: false, label: "clean" },
]) {
  test(`deleting a session from before kept worktrees were recorded ${dirty ? "leaves" : "removes"} an earlier worktree ${kind}`, async () => {
    if (process.platform === "win32") return;
    await withSession(`backfill-${label}`, async (h) => {
      serveOriginLocally(h);
      git(h.app, "branch", "away");
      assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
      await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
      const worktree = h.store.readMeta(h.sessionId)!.worktreePath!;
      if (label === "dirty") writeFileSync(join(worktree, "untracked.txt"), "untracked notes\n");
      if (label === "unpushed") {
        writeFileSync(join(worktree, "committed.txt"), "committed, never pushed\n");
        git(worktree, "add", "committed.txt");
        git(worktree, "commit", "--quiet", "-m", "local only");
        assert.equal(git(worktree, "status", "--porcelain"), "", "nothing uncommitted");
      }
      assert.deepEqual(await moveAway(h), { ok: true });
      await waitFor(() => h.providers[2]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move away did not finish");
      // As an older runner left it: whatever it kept, it did not record.
      h.store.patchMeta(h.sessionId, { keptWorktreePaths: undefined, keptWorktreesTracked: undefined });
      const before = existsSync(worktree) ? files(worktree) : {};

      await h.manager.delete(h.sessionId);
      if (dirty) {
        assert.deepEqual(files(worktree), before, "work found nowhere else is left where it is");
        assert.ok(docsWorktrees(h).includes(worktree));
      } else {
        assert.equal(existsSync(worktree), false, "a worktree with nothing of its own goes with the session, as before");
      }
      assert.deepEqual(journal(h), []);
    });
  });
}

test("a worktree the runner makes again where a kept one was is removed with the session, as any other is", async () => {
  await withSession("delete-remade-kept", async (h) => {
    const { slot } = await keptRequest(h, LOG_STEP(h));
    // The person took what they needed and removed the worktree and its branch, then asked again.
    git(h.docs, "worktree", "remove", "--force", slot);
    git(h.docs, "branch", "--quiet", "-D", "fix/other");
    const { worktree } = await h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/other" });
    assert.equal(worktree.path, slot);
    assert.equal(readFileSync(join(h.root, "ran"), "utf8"), "xx", "it was made new, with setup, on the trust given before");
    await h.manager.delete(h.sessionId);
    assert.equal(existsSync(slot), false, "nothing of a person's is there now, so nothing keeps it");
    assert.deepEqual(journal(h), []);
  });
});

test("deleting a session leaves a worktree whose retirement its switch overtook, byte for byte", async () => {
  if (process.platform === "win32") return;
  await withSession("delete-overtaken", async (h) => {
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
    const internals = internalsOf(h);
    internals.cleanupJournal.add(internals.cleanupRecordForWorktree(meta, meta.worktrees![0], "explicit_discard", "safe"));
    await internals.replayDeferredWorktreeRetirements();
    assert.deepEqual(await moveAway(h), { ok: true });
    await waitFor(() => h.providers[2]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move away did not finish");
    await internals.replayDeferredWorktreeRetirements();
    assert.deepEqual(journal(h), [], "the overtaken retirement was dropped");
    const notices = errorText(h);
    const before = workState(worktree, branch);

    await h.manager.delete(h.sessionId);
    assert.deepEqual(workState(worktree, branch), before, "every file, the index and the unpushed commit are there");
    assert.deepEqual(journal(h), []);
    assert.ok(notices.some((text) => /Deleting this session leaves it/u.test(text)), "which is what the notice said deletion would do");
  });
});

// Not a behavior test: it records why a kept request has no setup process to stop. A setup step owns
// no descendants past its own end (spawnAgent ends the step's whole boundary when it closes), and a
// request reaches its activation only once every step has ended.
test("a request's setup leaves no process running once its step ends, so a kept request has none to stop", async () => {
  if (process.platform !== "linux") return;
  await withSession("kept-processes", async (h) => {
    const pidFile = join(h.root, "server-pid");
    const server = { name: "Start Server", timeoutSeconds: 30, command: [process.execPath, "-e",
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(require('node:child_process').spawn(process.execPath,` +
      "['-e','setTimeout(()=>{},120000)'],{detached:true,stdio:'ignore'}).pid));process.exit(0)"] };
    let pid: number | undefined;
    try {
      const { slot, before } = await keptRequest(h, server, () => {
        pid = Number(readFileSync(pidFile, "utf8"));
        assert.equal(alive(pid), false, "the step's server ended with the step, before the request failed");
      });
      assert.deepEqual(journal(h), []);
      assert.ok(h.store.readMeta(h.sessionId)!.worktrees!.some((item) => item.path === slot), "the row stays");
      assert.deepEqual(files(slot), before);
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
    }
  });
});

test("a kept worktree is reported once, however often its processes refuse to stop", async () => {
  await withSession("kept-once", async (h) => {
    const { record, removal } = await stuckProvedRollback(h);
    assert.ok(record.processMarker, "setup's processes carry the rollback's marker");
    const slot = record.worktreePath;
    writeFileSync(join(slot, "notes.txt"), "a person's notes\n");
    const before = files(slot);
    let refusals = 3;
    keepInternalsOf(h).terminateRollbackProcesses = async () => refusals-- <= 0;
    removal.free();
    dueLater(h);
    const internals = internalsOf(h);
    await internals.replayDeferredWorktreeRetirements();
    assert.equal(keptNotices(h).length, 1);
    assert.equal(journal(h).length, 1, "the record waits for its processes");
    for (let day = 2; journal(h).length && day < 10; day++) {
      const later = Date.now() + day * 24 * 60 * 60 * 1000;
      internals.worktreePullRequestDiscoveryNow = () => later;
      await internals.replayDeferredWorktreeRetirements();
    }
    assert.deepEqual(journal(h), [], "the record ends once they stop");
    assert.equal(keptNotices(h).length, 1, "and the session heard about the keep only once");
    assert.equal(errorText(h).some((text) => /could not be removed after/u.test(text)), false, "and never that it was being removed");
    assert.deepEqual(files(slot), before);
  });
});

test("while a kept worktree's processes will not stop, asking for it again says it was kept, and giving up says what is left", async () => {
  await withSession("kept-gives-up", async (h) => {
    const { record, removal } = await stuckProvedRollback(h);
    const slot = record.worktreePath;
    writeFileSync(join(slot, "notes.txt"), "a person's notes\n");
    const before = files(slot);
    let stopping = false;
    keepInternalsOf(h).terminateRollbackProcesses = async () => stopping;
    removal.free();
    dueLater(h);
    await internalsOf(h).replayDeferredWorktreeRetirements();
    assert.equal(keptNotices(h).length, 1);

    const firstFailure = failure(h)!.at;
    assert.deepEqual(await backToDocs(h, "fix/install-link", "occurrence-again"), { ok: true });
    await waitFor(() => (failure(h)?.at ?? 0) > firstFailure, "the second switch did not settle");
    assert.match(failure(h)!.reason!, /kept this session's earlier worktree/u);
    assert.doesNotMatch(failure(h)!.reason!, /still removing/u);

    const internals = internalsOf(h);
    for (let day = 2; !journal(h)[0]?.rollbackGaveUpAt && day < 4096; day *= 2) {
      const later = Date.now() + day * 24 * 60 * 60 * 1000;
      internals.worktreePullRequestDiscoveryNow = () => later;
      await internals.replayDeferredWorktreeRetirements();
    }
    assert.ok(journal(h)[0]?.rollbackGaveUpAt, "the schedule ends");
    const gaveUp = errorText(h).filter((text) => /stopped trying on its own/u.test(text));
    assert.equal(gaveUp.length, 1);
    assert.match(gaveUp[0]!, /was kept, but the processes its setup started there could not be stopped/u);
    assert.equal(keptNotices(h).length, 1);

    // A real restart tries once more. Nothing of setup's runs there any more, so the record ends,
    // keeping all of it.
    h.restart();
    await waitFor(() => journal(h).length === 0, "the restart did not finish the kept record");
    assert.deepEqual(files(slot), before);
    assert.equal(keptNotices(h).length, 1);
  });
});

test("a kept directory Git no longer lists says asking again is refused until it is gone, and so it is", async () => {
  await withSession("kept-unregistered", async (h) => {
    const { slot, before } = await keptRequest(h, LOG_STEP(h), (path) => {
      // A person pruned its registration, so only the directory is left.
      rmSync(git(path, "rev-parse", "--absolute-git-dir"), { recursive: true, force: true });
    });
    assert.deepEqual(journal(h), []);
    const [notice] = keptNotices(h);
    assert.ok(notice, "the session is told");
    assert.match(notice!, /no longer registered/u);
    assert.doesNotMatch(notice!, /continues there/u, "it does not promise what will not happen");
    await assert.rejects(h.manager.requestWorktree(h.sessionId, { baseRef: "config-base", branch: "fix/other" }), /no longer registered/u);
    assert.deepEqual(files(slot), before);
    // The refused request made nothing there, so the directory is still kept, and deletion leaves it
    // rather than trying to remove a worktree Git no longer knows of.
    assert.ok(h.store.readMeta(h.sessionId)?.keptWorktreePaths?.includes(slot), "the refusal leaves the keep in place");
    await h.manager.delete(h.sessionId);
    assert.deepEqual(files(slot), before);
    assert.deepEqual(journal(h), [], "and the deletion finishes");
  });
});

test("a session worktree made again where one was kept goes with the session as usual", async () => {
  if (process.platform === "win32") return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-remade-kept-launch-")));
  const fake = fakeProvider();
  const sessionId = "s_remade_kept_launch";
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const manager = new SessionManager(() => {}, () => {}, store, "runner", undefined, fake.factory as never, dataDir, 2);
  try {
    const app = join(root, "app");
    mkdirSync(app);
    git(app, "init", "--quiet", "--initial-branch=main");
    git(app, "commit", "--quiet", "--allow-empty", "-m", "base");
    manager.configureSharedDirectories([{ id: "app", name: "App", path: realpathSync(app) }] as never);
    const spec = { sessionId, workspaceId: "app", workspacePath: realpathSync(app), agentId: "claude-code", command: "claude-code",
      args: [], env: {}, useWorktree: true, driver: "claude-code" as const, context: { kind: "native" as const } };
    await manager.start(spec);
    const worktree = store.readMeta(sessionId)!.worktreePath!;
    (manager as unknown as { markWorktreeKept: (sessionId: string, path: string) => void }).markWorktreeKept(sessionId, worktree);
    manager.stop(sessionId);
    await waitFor(() => store.readMeta(sessionId)?.status === "stopped", "the session did not stop");
    // The person dealt with what was kept, and the next launch makes the session's worktree again.
    git(app, "worktree", "remove", "--force", worktree);
    // With no row recorded for it, as #4395 describes, the launch goes through createWorktree.
    store.patchMeta(sessionId, { worktreePath: null, worktreeBranch: undefined, worktrees: undefined });
    const lease = store.readWorktreeLease(sessionId);
    if (lease) store.releaseWorktreeLease(sessionId, lease.owner);
    await manager.start(spec);
    assert.equal(store.readMeta(sessionId)?.worktreePath, worktree);
    assert.equal(store.readMeta(sessionId)?.keptWorktreePaths?.includes(worktree) ?? false, false, "a new worktree there is not kept");
    await manager.delete(sessionId);
    assert.equal(existsSync(worktree), false, "and it goes with the session");
  } finally {
    manager.shutdownAll();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a session whose port block an older runner left colliding launches again, with a new block and a notice", async () => {
  await withSession("stale-block-launch", async (h) => {
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const row = h.store.readMeta(h.sessionId)!.worktrees![0]!;
    const held = row.portBlock!;
    assert.ok(held);
    // An older runner moved the session without revalidating: its row names a block another holds.
    const allocator = internalsOf(h).worktreePortAllocator;
    allocator.release(`${h.sessionId}\0${row.id}`);
    allocator.allocate("s_other\0other-worktree", held);

    h.restart();
    await relaunch(h, "docs", h.docs);
    const current = h.store.readMeta(h.sessionId)!.worktrees![0]!;
    assert.equal(h.providers.at(-1)!.cwd, row.path);
    assert.notDeepEqual(current.portBlock, held, "it does not take what another session holds");
    assert.deepEqual(internalsOf(h).worktreePortAllocator.get("s_other\0other-worktree"), held);
    assert.equal(h.providers.at(-1)!.env?.WOLLIPOG_PORT_BLOCK_START, String(current.portBlock!.start));
    assert.ok(errorText(h).some((text) => text.includes(`port block changed to ${current.portBlock!.start}-${current.portBlock!.end}`)),
      "and the session is told");
  });
});

test("a session whose stale port block cannot be replaced still refuses to launch, and says why", async () => {
  await withSession("stale-block-exhausted", async (h) => {
    assert.deepEqual(await h.manager.requestLocationSwitch(h.message()), { ok: true });
    await waitFor(() => h.providers[1]?.prompts.length === 1 && h.store.readMeta(h.sessionId)?.status === "idle", "the move did not finish");
    const row = h.store.readMeta(h.sessionId)!.worktrees![0]!;
    const allocator = internalsOf(h).worktreePortAllocator;
    allocator.release(`${h.sessionId}\0${row.id}`);
    allocator.allocate("s_other\0other-worktree", row.portBlock);
    h.restart();
    const next = internalsOf(h).worktreePortAllocator;
    const allocate = next.allocate.bind(next);
    next.allocate = (owner, preferred) => {
      if (owner.startsWith(h.sessionId) && !preferred) throw new Error("worktree port range is exhausted");
      return allocate(owner, preferred);
    };
    const launched = h.providers.length;
    const lease = h.store.readWorktreeLease(h.sessionId);
    if (lease) h.store.releaseWorktreeLease(h.sessionId, lease.owner);
    await h.manager.start({ sessionId: h.sessionId, workspaceId: "docs", workspacePath: h.docs, agentId: "claude-code", command: "claude-code",
      args: [], env: {}, useWorktree: false, driver: "claude-code", context: { kind: "native" } }).catch(() => undefined);
    await waitFor(() => errorText(h).some((text) => /exhausted/u.test(text)), "the launch did not say why it refused");
    assert.equal(h.providers.length, launched, "nothing launched");
    assert.deepEqual(internalsOf(h).worktreePortAllocator.get("s_other\0other-worktree"), row.portBlock, "and the other session keeps its block");
  });
});

test("a worktree a launch makes again after a refused rollback is never removed by that rollback, even when its setup fails", async () => {
  if (process.platform === "win32") return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-launch-remade-after-refusal-")));
  const fake = fakeProvider();
  const sessionId = "s_launch_remade_after_refusal";
  const dataDir = join(root, "data");
  const managers: SessionManager[] = [];
  const logs: string[] = [];
  const retried = () => logs.some((line) => /needs retry after worktree removal/u.test(line));
  const runner = () => {
    const store = new SessionStore(join(dataDir, "sessions"));
    const manager = new SessionManager(() => {}, (line: string) => { logs.push(line); }, store, "runner", undefined, fake.factory as never, dataDir, 2);
    managers.push(manager);
    return { store, manager };
  };
  try {
    const app = join(root, "app");
    mkdirSync(app);
    git(app, "init", "--quiet", "--initial-branch=main");
    git(app, "commit", "--quiet", "--allow-empty", "-m", "base");
    const locations = [{ id: "app", name: "App", path: realpathSync(app) }];
    let { store, manager } = runner();
    manager.configureSharedDirectories(locations as never);
    git(app, "checkout", "--quiet", "-b", `agent/${sessionId}`);
    writeFileSync(join(app, ".wollipog.json"), JSON.stringify({ version: 1, setup: [{ name: "Install Packages", command: fail, timeoutSeconds: 30 }] }));
    git(app, "add", ".wollipog.json");
    git(app, "commit", "--quiet", "-m", "the session's own commit");
    git(app, "checkout", "--quiet", "main");
    const spec = { sessionId, workspaceId: "app", workspacePath: realpathSync(app), agentId: "claude-code", command: "claude-code",
      args: [], env: {}, useWorktree: true, driver: "claude-code" as const, context: { kind: "native" as const } };
    const cards = () => store.readEvents(sessionId).map((event) => event.payload).filter((payload) => payload.kind === "permission_request");
    const releaseLease = () => {
      const lease = store.readWorktreeLease(sessionId);
      if (lease) store.releaseWorktreeLease(sessionId, lease.owner);
    };

    // The first launch is stopped at its trust card while its worktree's configuration is broken, so
    // its rollback's identity check refuses, and the rollback stays on record.
    const starting = manager.start(spec).catch(() => undefined);
    await waitFor(() => store.has(sessionId) && cards().length > 0, "the first launch did not ask for trust");
    const worktree = git(app, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length)).find((path) => path !== realpathSync(app))!;
    git(app, "config", "extensions.worktreeConfig", "true");
    writeFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), "config.worktree"), "[broken\n");
    manager.stop(sessionId);
    await starting;
    await waitFor(() => !existsSync(worktree) || retried(), "the rollback did not try");
    assert.equal(existsSync(worktree), true, "the refused rollback removed nothing");

    // The person removes it, as the refusal says to, and the next launch makes it again. Its required
    // setup fails, so the session keeps it with Retry Setup, and the person fixes things there.
    git(app, "worktree", "remove", "--force", worktree);
    releaseLease();
    const relaunching = manager.start(spec).catch(() => undefined);
    await waitFor(() => cards().length > 1, "the second launch did not ask for trust");
    manager.resolvePermission(sessionId, cards().at(-1)!.requestId, "trust");
    await relaunching;
    await waitFor(() => store.readMeta(sessionId)?.worktreePath === worktree &&
      store.readMeta(sessionId)?.worktrees?.some((row) => row.path === worktree && row.setup?.status === "failed") === true,
    "the session did not keep the remade worktree after its setup failed");
    writeFileSync(join(worktree, "fixes.txt"), "the person's fixes since\n");
    const kept = files(worktree);

    manager.shutdownAll();
    ({ store, manager } = runner());
    manager.configureSharedDirectories(locations as never);
    manager.reconcileStore();
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    assert.equal(existsSync(worktree), true, "a restart does not take the worktree the session holds");
    assert.deepEqual(files(worktree), kept, "with everything in it");
    assert.equal(git(app, "rev-parse", "--verify", `refs/heads/agent/${sessionId}`).length, 40);
  } finally {
    for (const manager of managers) manager.shutdownAll();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    rmSync(root, { recursive: true, force: true });
  }
});

test("a launch rollback leaves a worktree Git cannot answer from inside byte for byte, through a real restart", async () => {
  if (process.platform === "win32") return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wollipog-launch-rollback-identity-")));
  const fake = fakeProvider();
  const sessionId = "s_launch_rollback_identity";
  const dataDir = join(root, "data");
  const managers: SessionManager[] = [];
  const logs: string[] = [];
  const retried = () => logs.some((line) => /needs retry after worktree removal/u.test(line));
  const runner = () => {
    const store = new SessionStore(join(dataDir, "sessions"));
    const manager = new SessionManager(() => {}, (line: string) => { logs.push(line); }, store, "runner", undefined, fake.factory as never, dataDir, 2);
    managers.push(manager);
    return { store, manager };
  };
  try {
    const app = join(root, "app");
    mkdirSync(app);
    git(app, "init", "--quiet", "--initial-branch=main");
    git(app, "commit", "--quiet", "--allow-empty", "-m", "base");
    const locations = [{ id: "app", name: "App", path: realpathSync(app) }];
    let { store, manager } = runner();
    manager.configureSharedDirectories(locations as never);
    // The session's branch holds its own commit, so its rollback keeps the branch (#4209).
    git(app, "checkout", "--quiet", "-b", `agent/${sessionId}`);
    writeFileSync(join(app, ".wollipog.json"), JSON.stringify({ version: 1, setup: [{ name: "Step", command: sleep, timeoutSeconds: 120 }] }));
    git(app, "add", ".wollipog.json");
    git(app, "commit", "--quiet", "-m", "the session's own commit");
    git(app, "checkout", "--quiet", "main");

    const starting = manager.start({ sessionId, workspaceId: "app", workspacePath: realpathSync(app), agentId: "claude-code", command: "claude-code",
      args: [], env: {}, useWorktree: true, driver: "claude-code", context: { kind: "native" } }).catch(() => undefined);
    const cards = () => store.readEvents(sessionId).map((event) => event.payload).filter((payload) => payload.kind === "permission_request");
    await waitFor(() => store.has(sessionId) && cards().length > 0, "the remade worktree's setup did not ask for trust");
    const worktree = git(app, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length)).find((path) => path !== realpathSync(app))!;
    // While trust is open, a person writes there, and its own configuration stops parsing.
    writeFileSync(join(worktree, "notes.txt"), "a person's notes\n");
    git(app, "config", "extensions.worktreeConfig", "true");
    writeFileSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), "config.worktree"), "[broken\n");
    const before = files(worktree);
    manager.stop(sessionId);
    await starting;
    await waitFor(() => !existsSync(worktree) || retried(), "the rollback did not try");
    assert.deepEqual(files(worktree), before, "nothing in it is removed");

    manager.shutdownAll();
    logs.length = 0;
    ({ store, manager } = runner());
    manager.configureSharedDirectories(locations as never);
    manager.reconcileStore();
    await waitFor(() => !existsSync(worktree) || retried(), "the restart did not replay the rollback");
    assert.deepEqual(files(worktree), before, "nor when a restart replays it");
    assert.equal(git(app, "rev-parse", "--verify", `refs/heads/agent/${sessionId}`).length, 40, "and the branch stays");

    // The next launch is refused and says to repair it. The person does, and the session takes it back.
    const spec = { sessionId, workspaceId: "app", workspacePath: realpathSync(app), agentId: "claude-code", command: "claude-code",
      args: [], env: {}, useWorktree: true, driver: "claude-code" as const, context: { kind: "native" as const } };
    const releaseLease = () => {
      const lease = store.readWorktreeLease(sessionId);
      if (lease) store.releaseWorktreeLease(sessionId, lease.owner);
    };
    releaseLease();
    await manager.start(spec).catch(() => undefined);
    const errors = () => store.readEvents(sessionId).map((event) => event.payload)
      .filter((payload) => payload.kind === "error").map((payload) => String((payload as { message?: string }).message));
    await waitFor(() => errors().some((text) => /left as it is, in case it holds work/u.test(text)), "the unrepaired worktree was not refused");
    rmSync(join(git(app, "rev-parse", "--path-format=absolute", "--git-common-dir"), "worktrees", worktree.split("/").at(-1)!, "config.worktree"));
    const launched = fake.providers.length;
    releaseLease();
    const relaunching = manager.start(spec).catch(() => undefined);
    await waitFor(() => cards().length > 1 || fake.providers.length > launched, "the repaired worktree did not relaunch");
    const card = cards().at(-1)!;
    if (fake.providers.length === launched) manager.resolvePermission(sessionId, card.requestId, "skip");
    await relaunching;
    await waitFor(() => fake.providers.length > launched && store.readMeta(sessionId)?.worktreePath === worktree,
      "the session did not take its worktree back");
    writeFileSync(join(worktree, "after-repair.txt"), "work done since the repair\n");
    const taken = files(worktree);

    // A later restart finds nothing to replay against it.
    manager.shutdownAll();
    ({ store, manager } = runner());
    manager.configureSharedDirectories(locations as never);
    manager.reconcileStore();
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    assert.equal(existsSync(worktree), true, "the worktree the session took back is still there");
    assert.deepEqual(files(worktree), taken, "with everything done in it since");
    assert.equal((manager as unknown as { cleanupJournal: { list(): WorktreeCleanupRecord[] } }).cleanupJournal.list().length, 0);
  } finally {
    for (const manager of managers) manager.shutdownAll();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    rmSync(root, { recursive: true, force: true });
  }
});
