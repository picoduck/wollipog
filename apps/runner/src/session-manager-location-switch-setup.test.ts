import assert from "node:assert/strict";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import type { RunnerToControlPlane, SessionLaunchSpec, SessionLocationSwitchMessage } from "@wollipog/protocol";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeProjectPathKey } from "./claude-background-work.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

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
}

async function withSession(name: string, body: (h: Harness) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wollipog-switch-setup-${name}-`)));
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  const claudeHome = join(root, "claude-home");
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const fake = fakeProvider();
  const sent: RunnerToControlPlane[] = [];
  const dataDir = join(root, "data");
  const store = new SessionStore(join(dataDir, "sessions"));
  const manager = new SessionManager((message) => { sent.push(message); }, () => {}, store, "runner", undefined,
    fake.factory as never, dataDir, 2);
  try {
    const app = repository(root, "app", "git@github.com:acme/app.git");
    const docs = repository(root, "docs", "git@github.com:acme/docs.git");
    git(docs, "branch", "fix/install-link");
    manager.configureSharedDirectories([{ id: "app", name: "App", path: app }, { id: "docs", name: "Docs", path: docs }] as never);
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
    await body({
      manager, store, sessionId, providers: fake.providers, sent, app, docs, root,
      message: (overrides = {}) => ({
        type: "session_location_switch", requestId: "request-1", sessionId, workspaceId: "docs", workspacePath: docs,
        repository: "acme/docs", locationName: "Docs", occurrenceId: "occurrence-1", continuation: "Continue the docs fix here.",
        recoverBranch: "fix/install-link", ...overrides,
      }),
    });
  } finally {
    manager.shutdownAll();
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
    const lock = join(dataDir, "sessions", "lock");
    if (existsSync(lock)) utimesSync(lock, new Date(0), new Date(0));
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
    assert.match(meta.locationSwitchFailure!.reason!, new RegExp(h.sessionId, "u"), "the refusal names the session setting it up");
    assert.equal(h.store.readMeta(h.sessionId)?.pendingLocationSwitch?.occurrenceId, "occurrence-1", "the first switch is unaffected");
    assert.deepEqual(docsWorktrees(h), [h.docs, target]);
  });
});

test("a target another switch claimed while Git was still checking it out stays that session's: no setup, no removal, no takeover", async () => {
  await withSession("claimed-first", async (h) => {
    commitSetup(h, { setup: [{ name: "Prepare Target", command: write(join(h.root, "setup-ran"), "'yes'"), timeoutSeconds: 30 }] });
    // Model the other switch getting there first: its claim lands while this switch's checkout runs,
    // so the first holder this switch sees for its own new worktree is that session.
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

    assert.match(failure(h)!.reason!, /which session s_switch_setup_first took while it was being verified/u);
    assertStayed(h);
    assert.equal(runner.reusedWorktreeClaims.get(contested!), "s_switch_setup_first", "the winner's claim is not overwritten");
    assert.equal(existsSync(join(contested!, ".git")), true, "the worktree is the winner's: this switch does not remove it");
    assert.equal(existsSync(join(h.root, "setup-ran")), false, "no setup runs in another session's worktree");
    assert.deepEqual(payloads(h, "permission_request"), []);
    assert.equal(h.providers.length, 1);
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
