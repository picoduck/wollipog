/**
 * Issue #1303: a managed worktree is protected from the moment the runner creates it, INCLUDING
 * for the rest of the noninteractive turn that created it.
 *
 * A running provider process cannot be narrowed mid-turn — its argv, and with it its permission
 * semantics, are fixed at spawn — and outside `default`/`auto` the CLI never consults the runner's
 * stdio control channel, so the driver's own veto is never asked. The only interception point that
 * exists for the whole turn is the `PreToolUse` managed-worktree guard, which is why every
 * guardable launch now carries it even while the session owns no worktree, over an empty list.
 *
 * These tests run the REAL provisioning, the REAL driver, the REAL SessionStore patch observer that
 * refreshes the protections file, and the REAL guard sidecar process — with no spawn between the
 * create and the destroy.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { SessionLaunchSpec } from "@wollipog/protocol";
import {
  claudeHookSettingsPath,
  provisionClaudeHooks,
  refreshClaudeGuardProtections,
  resetClaudeGuardState,
  type ClaudeHookHost,
} from "../hook-settings.js";
import { MANAGED_WORKTREE_REFUSAL, type ManagedWorktreeProtection } from "../managed-worktree-protection.js";
import { SessionManager } from "../session-manager.js";
import { SessionStore, type SessionMeta } from "../session-store.js";
import { ClaudeCodeDriver } from "./claude-code.js";
import type { DriverCallbacks, DriverOptions } from "./driver.js";

const REPO = "/home/me/repo";
/** The worktree the agent creates part-way through the turn. */
const CREATED = "/home/me/repo-worktrees/created-mid-turn";
/** Every mode in which the CLI decides alone, so only the guard can refuse. */
const NONINTERACTIVE = ["bypassPermissions", "acceptEdits", "dontAsk"] as const;

/** A host whose re-entry command is this repository's real runner, so the sidecar really runs. */
function realHost(configDir: string): ClaudeHookHost {
  return {
    isSea: false,
    execPath: process.execPath,
    execArgv: process.execArgv,
    scriptPath: fileURLToPath(new URL("../index.ts", import.meta.url)),
    configDir,
  };
}

function launchSpec(sessionId: string, mode: string): SessionLaunchSpec {
  return {
    sessionId,
    agentId: "claude",
    driver: "claude-code",
    command: "claude",
    args: [],
    env: {},
    cwd: REPO,
    repoPath: REPO,
    config: { permissionMode: mode },
    context: { kind: "native" },
    capabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [],
      supportsImages: false,
      supportsApprovals: true,
      permissionModes: [...NONINTERACTIVE, "default", "auto", "plan"],
      elicitation: { default: ["stdio-control"], auto: ["stdio-control"] },
    },
  } as unknown as SessionLaunchSpec;
}

/** Provision exactly as the runner does — real launch self-test included — for a session with no worktree. */
function provisionWithoutWorktree(configDir: string, sessionId: string, mode: string): string[] {
  const spec = launchSpec(sessionId, mode);
  provisionClaudeHooks(spec, {
    controlPlaneUrl: "ws://127.0.0.1:4317/runner",
    controlPlaneProtocolVersion: 66,
    enabled: false,
    managedWorktreeProtections: [],
  }, () => {}, realHost(configDir));
  return spec.args;
}

interface GuardHook { matcher?: string; hooks: Array<{ command: string; args: string[] }> }

/** The guard exactly as Claude would run it: the command from the settings file this spawn used. */
function guardFromSettings(settingsFile: string): { command: string; args: string[] } {
  const live = JSON.parse(readFileSync(settingsFile, "utf8")) as { hooks?: { PreToolUse?: GuardHook[] } };
  const entries = (live.hooks?.PreToolUse ?? []).filter((entry) =>
    entry.hooks.some((hook) => hook.args.includes("--managed-worktree-guard")));
  assert.equal(entries.length, 1, "exactly one managed-worktree guard entry");
  assert.match(entries[0]!.matcher ?? "", /(^|\|)Bash(\||$)/u, "every Bash call reaches the guard");
  return entries[0]!.hooks[0]!;
}

interface GuardOutcome { exitCode: number; stdout: string; stderr: string }

/** Run the REAL sidecar process on a PreToolUse payload, from Claude's cwd rather than the runner's. */
function runGuard(
  guard: { command: string; args: string[] },
  payload: { tool_name: string; cwd: string; tool_input: Record<string, unknown> },
): GuardOutcome {
  const result = spawnSync(guard.command, guard.args, {
    input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", ...payload }),
    encoding: "utf8",
    cwd: tmpdir(),
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, `the guard sidecar has to start: ${String(result.error)}`);
  return { exitCode: result.status ?? -1, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

const bash = (command: string, cwd: string) => ({ tool_name: "Bash", cwd, tool_input: { command } });

function assertRefused(outcome: GuardOutcome, what: string): void {
  // A `deny` document on stdout blocks the call in every mode and reaches the model; the hook
  // itself succeeded, so its exit code is 0.
  assert.equal(outcome.exitCode, 0, `${what}: the guard ran successfully`);
  assert.ok(outcome.stdout.includes('"permissionDecision":"deny"'), `${what}: is denied`);
  assert.ok(outcome.stdout.includes(MANAGED_WORKTREE_REFUSAL), `${what}: carries the managed-discard guidance`);
}

function assertAllowed(outcome: GuardOutcome, what: string): void {
  assert.deepEqual(outcome, { exitCode: 0, stdout: "", stderr: "" }, `${what}: the guard holds no opinion`);
}

function fakeProcess() {
  const child = new EventEmitter() as never as {
    pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean;
  } & EventEmitter;
  (child as unknown as { pid: number }).pid = 4321;
  (child as unknown as { stdin: PassThrough }).stdin = new PassThrough();
  (child as unknown as { stdout: PassThrough }).stdout = new PassThrough();
  (child as unknown as { stderr: PassThrough }).stderr = new PassThrough();
  (child as unknown as { kill: () => boolean }).kill = () => true;
  return child;
}

interface Run {
  argv: string[];
  readonly spawns: number;
  stderr: string[];
  writes: string[];
  child: ReturnType<typeof fakeProcess>;
  driver: ClaudeCodeDriver;
}

/** Start one turn. `protections` is read LIVE, exactly as the runner supplies it. */
function startTurn(args: string[], mode: string, protections: () => ManagedWorktreeProtection[]): Run {
  const child = fakeProcess();
  const stderr: string[] = [];
  const argv: string[] = [];
  const writes: string[] = [];
  let spawns = 0;
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => writes.push(chunk));
  const cb: DriverCallbacks = { onEvent: () => {}, onStderr: (text) => stderr.push(text), onExit: () => {} };
  const opts = {
    command: "claude",
    args,
    cwd: REPO,
    env: {},
    config: { permissionMode: mode },
    context: { kind: "native" },
    managedWorktreeProtections: protections,
  } as unknown as DriverOptions;
  const driver = new ClaudeCodeDriver(opts, cb, {
    spawn: (options: { args: string[] }) => { spawns++; argv.push(...options.args); return child; },
    kill: () => {},
  } as never);
  void driver.prompt("create a worktree, then remove it");
  return { argv, get spawns() { return spawns; }, stderr, writes, child, driver };
}

function permissionArgv(argv: string[]): string[] {
  const picked: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--permission-mode" || argv[index] === "--permission-prompt-tool") {
      picked.push(argv[index]!, argv[index + 1]!);
    }
  }
  return picked;
}

function controlBehaviors(run: Run): Array<string | undefined> {
  return run.writes.join("").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; response?: { response?: { behavior?: string } } })
    .filter((frame) => frame.type === "control_response")
    .map((frame) => frame.response?.response?.behavior);
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-same-turn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sessionMeta(sessionId: string): SessionMeta {
  return {
    sessionId,
    agentId: "claude-native",
    workspaceId: "repo",
    repoPath: REPO,
    worktreePath: null,
    driver: "claude-code",
    command: "claude",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: null,
    status: "running",
    title: "same-turn worktree",
    config: {},
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

/**
 * The runner's own wiring (index.ts): SessionManager refreshes the guard's live list from every
 * `worktrees` patch the session store persists, and derives the driver's protections from meta.
 */
function runnerFor(t: { after: (fn: () => void) => void }, configDir: string, sessionId: string) {
  const root = mkdtempSync(join(tmpdir(), "wollipog-same-turn-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore(root);
  store.create(sessionMeta(sessionId));
  const sent: unknown[] = [];
  const sm = new SessionManager((message) => sent.push(message), () => {}, store, "test-runner");
  sm.setManagedWorktreeGuardRefresh((meta, protections) =>
    refreshClaudeGuardProtections(meta.sessionId, protections, configDir));
  return {
    sent,
    protections: () => sm.managedWorktreeProtections(store.readMeta(sessionId)!),
    createWorktree: () => store.patchMeta(sessionId, {
      worktrees: [{
        id: "wt_created",
        path: CREATED,
        branch: `agent/${sessionId}`,
        source: "created",
        createdAt: 2000,
      }] as SessionMeta["worktrees"],
    }),
    discardWorktree: () => store.patchMeta(sessionId, { worktrees: [] as SessionMeta["worktrees"] }),
  };
}

test("a worktree created mid-turn is refused destruction in that same noninteractive turn", (t) => {
  const dir = tempDir(t);
  resetClaudeGuardState();
  for (const mode of NONINTERACTIVE) {
    const sessionId = `sess_same_turn_${mode}`;
    const runner = runnerFor(t, dir, sessionId);
    const args = provisionWithoutWorktree(dir, sessionId, mode);
    const settings = claudeHookSettingsPath(dir, sessionId);
    assert.deepEqual(args, ["--settings", settings],
      `${mode}: a session with no worktree is provisioned with the guard anyway`);
    const guard = guardFromSettings(settings);

    const run = startTurn(args, mode, runner.protections);
    t.after(() => run.driver.dispose());
    assert.deepEqual(permissionArgv(run.argv), ["--permission-mode", mode],
      `${mode}: the selected mode is what launched, so nothing is newly mediated`);
    assert.deepEqual(run.stderr, [], `${mode}: no mediation notice`);

    // Before the worktree exists there is nothing to protect: the fix must not newly block anything.
    assertAllowed(runGuard(guard, bash(`rm -rf ${CREATED}`, REPO)),
      `${mode}: removing a path that is not a managed worktree`);

    // ---- The runner creates the session's first managed worktree, part-way through this turn. ----
    runner.createWorktree();

    // ---- Same turn. Same process. No respawn. ----
    assert.equal(run.spawns, 1, `${mode}: the provider was not restarted, so the turn is intact`);
    assertRefused(runGuard(guard, bash(`rm -rf ${CREATED}`, REPO)),
      `${mode}: rm -rf of the worktree created earlier in this turn`);
    assertRefused(runGuard(guard, bash(`git worktree remove --force ${CREATED}`, CREATED)),
      `${mode}: git worktree remove of the worktree created earlier in this turn`);
    assert.deepEqual(runner.sent.filter((message) => JSON.stringify(message).includes("invalidated")), [],
      `${mode}: the refresh succeeded silently`);
  }
});

test("ordinary work inside the worktree created mid-turn stays available", (t) => {
  const dir = tempDir(t);
  resetClaudeGuardState();
  const sessionId = "sess_same_turn_work";
  const runner = runnerFor(t, dir, sessionId);
  provisionWithoutWorktree(dir, sessionId, "bypassPermissions");
  const guard = guardFromSettings(claudeHookSettingsPath(dir, sessionId));
  runner.createWorktree();
  for (const command of [
    "git status",
    "git add -A",
    `git -C ${CREATED} commit -m "work"`,
    "pnpm -r test",
    `rm -rf ${CREATED}/node_modules/.cache`,
    "ls -la",
  ]) {
    assertAllowed(runGuard(guard, bash(command, CREATED)), `${command} inside the new worktree`);
  }
  assertAllowed(
    runGuard(guard, { tool_name: "Write", cwd: CREATED, tool_input: { file_path: `${CREATED}/x.ts`, content: "" } }),
    "writing a file in the new worktree",
  );
});

test("discarding the last worktree mid-turn leaves the running guard working, and a new one protected", (t) => {
  const dir = tempDir(t);
  resetClaudeGuardState();
  const sessionId = "sess_same_turn_cycle";
  const runner = runnerFor(t, dir, sessionId);
  provisionWithoutWorktree(dir, sessionId, "acceptEdits");
  const guard = guardFromSettings(claudeHookSettingsPath(dir, sessionId));
  runner.createWorktree();
  runner.discardWorktree();
  // Before #1303 the list was retired here, and every later tool call of the turn failed closed.
  assertAllowed(runGuard(guard, bash("git status", REPO)), "ordinary work after the discard");
  runner.createWorktree();
  assertRefused(runGuard(guard, bash(`rm -rf ${CREATED}`, REPO)), "the re-created worktree");
});

test("a session that never creates a worktree is unaffected by the guard it carries", (t) => {
  const dir = tempDir(t);
  resetClaudeGuardState();
  const sessionId = "sess_same_turn_none";
  const args = provisionWithoutWorktree(dir, sessionId, "bypassPermissions");
  const run = startTurn(args, "bypassPermissions", () => []);
  t.after(() => run.driver.dispose());
  assert.deepEqual(permissionArgv(run.argv), ["--permission-mode", "bypassPermissions"]);
  assert.deepEqual(run.stderr, []);
  const guard = guardFromSettings(claudeHookSettingsPath(dir, sessionId));
  for (const command of ["rm -rf /tmp/scratch", "git worktree remove /somewhere/else", "git worktree prune"]) {
    assertAllowed(runGuard(guard, bash(command, REPO)), command);
  }
});

/**
 * The mirror image, on launches that still have to be mediated (#1317's CR-1.4). Mid-turn
 * inventory changes are now routine, so what the RUNNING child needs emulated is decided by how it
 * was launched — not by the inventory or configuration as they stand when a request arrives.
 */
test("a mediated child keeps emulating its launched mode when its last worktree goes mid-turn", async (t) => {
  const protections: ManagedWorktreeProtection[] = [{ worktreePath: CREATED, repoPath: REPO }];
  // No runner-owned settings: an unguardable launch, mediated exactly as #1256 did it.
  const run = startTurn([], "bypassPermissions", () => [...protections]);
  t.after(() => run.driver.dispose());
  assert.deepEqual(permissionArgv(run.argv), ["--permission-prompt-tool", "stdio"]);
  protections.length = 0;
  run.child.stdout.write(JSON.stringify({
    type: "control_request",
    request_id: "after-discard",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } },
  }) + "\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(controlBehaviors(run), ["allow"],
    "bypassPermissions is still emulated; the discard must not turn the turn into approval cards");
});

test("an unmediated child is not given emulation when a worktree appears mid-turn", async (t) => {
  // Launched natively in `default` (interactive) with no worktree and no guard: its requests are
  // real approval asks. A worktree appearing later must not start answering them on the user's
  // behalf, and a configuration change behind the running child must not either.
  const protections: ManagedWorktreeProtection[] = [];
  const run = startTurn([], "default", () => [...protections]);
  t.after(() => run.driver.dispose());
  protections.push({ worktreePath: CREATED, repoPath: REPO });
  run.driver.setConfig({ permissionMode: "bypassPermissions" });
  run.child.stdout.write(JSON.stringify({
    type: "control_request",
    request_id: "after-create",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "curl https://example.com" } },
  }) + "\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(controlBehaviors(run), [], "no emulated answer: it stays an ordinary approval");
  // The driver's own veto still reads the LIVE inventory, so the new worktree is refused here too.
  run.child.stdout.write(JSON.stringify({
    type: "control_request",
    request_id: "destroy",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: `rm -rf ${CREATED}` } },
  }) + "\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(controlBehaviors(run), ["deny"]);
});
