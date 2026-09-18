/**
 * Issue #1313: a session with a runner-managed worktree must keep the permission mode the user
 * selected. The managed-worktree guard hook (apps/runner/src/managed-worktree-guard.ts) enforces
 * the runner-owned worktree veto for every Bash call in every mode, so the driver no longer has
 * to mediate the mode to interactive `default` and emulate the fixed-rule modes itself.
 *
 * These tests drive the REAL provisioning (`provisionClaudeHooks`) into a temp hook directory and
 * the REAL driver, and compare the permission argv of a session WITH a managed worktree against
 * an otherwise identical session WITHOUT one.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { SessionLaunchSpec } from "@wollipog/protocol";
import {
  claudeHookGuardPath,
  claudeHookSettingsPath,
  claudeHookCircuitPath,
  provisionClaudeHooks,
  writeHookCircuitState,
  type ClaudeHookHost,
} from "../hook-settings.js";
import { MANAGED_WORKTREE_REFUSAL } from "../managed-worktree-protection.js";
import { ClaudeCodeDriver, protectedClaudePermissionMode } from "./claude-code.js";
import type { DriverCallbacks, DriverOptions } from "./driver.js";

const REPO = "/repo";
const WORKTREE = "/repo-worktrees/s1";
const PROTECTIONS = [{ worktreePath: WORKTREE, repoPath: REPO }];
/** Permission modes a user can select, other than `plan` (which this change does not touch). */
const MODES = ["auto", "acceptEdits", "default", "bypassPermissions", "dontAsk"] as const;

function hookHost(configDir: string): ClaudeHookHost {
  return {
    isSea: false,
    execPath: "/usr/bin/node",
    execArgv: ["--import", "tsx"],
    scriptPath: "/repo/apps/runner/src/index.ts",
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
    cwd: WORKTREE,
    repoPath: REPO,
    config: { permissionMode: mode },
    context: { kind: "native" },
    capabilities: {
      models: [],
      effortLevels: [],
      slashCommands: [],
      supportsImages: false,
      supportsApprovals: true,
      permissionModes: [...MODES, "plan"],
      elicitation: {
        default: ["stdio-control"],
        auto: ["stdio-control"],
        acceptEdits: ["hook"],
        bypassPermissions: ["hook"],
        dontAsk: ["hook"],
        plan: ["hook"],
      },
    },
  } as unknown as SessionLaunchSpec;
}

/** Provision a launch exactly as the runner does and return the resulting provider args. */
function provision(
  configDir: string,
  sessionId: string,
  mode: string,
  options: { protections: typeof PROTECTIONS | []; managerHooks?: boolean } ,
): string[] {
  const spec = launchSpec(sessionId, mode);
  provisionClaudeHooks(spec, {
    controlPlaneUrl: "ws://127.0.0.1:4317/runner",
    controlPlaneProtocolVersion: 66,
    enabled: options.managerHooks ?? false,
    managedWorktreeProtections: options.protections,
    // The real sidecar self-test spawns a process; claude-code-managed-worktree covers the driver
    // contract, and managed-worktree-guard.test.ts runs the real launch probe.
    verifyGuardLaunch: () => ({ ok: true }),
  }, () => {}, hookHost(configDir));
  return spec.args;
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

interface Launch { argv: string[]; stderr: string[]; writes: string[]; child: ReturnType<typeof fakeProcess>;
  driver: ClaudeCodeDriver }

/** Run one turn with the given launch args and capture the argv the driver spawned. */
function launch(args: string[], mode: string, protections: typeof PROTECTIONS | []): Launch {
  const child = fakeProcess();
  const writes: string[] = [];
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => writes.push(chunk));
  const stderr: string[] = [];
  const argv: string[] = [];
  const cb: DriverCallbacks = {
    onEvent: () => {},
    onStderr: (text) => stderr.push(text),
    onExit: () => {},
  };
  const opts = {
    command: "claude",
    args,
    cwd: WORKTREE,
    env: {},
    config: { permissionMode: mode },
    context: { kind: "native" },
    managedWorktreeProtections: () => [...protections],
  } as unknown as DriverOptions;
  const driver = new ClaudeCodeDriver(opts, cb, {
    spawn: (options: { args: string[] }) => { argv.push(...options.args); return child; },
    kill: () => {},
  } as never);
  void driver.prompt("do the work");
  return { argv, stderr, writes, child, driver };
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

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-guarded-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("with the guard active, every selected mode launches exactly as it would without a worktree", (t) => {
  const dir = tempDir(t);
  for (const mode of MODES) {
    const guarded = provision(dir, `s-${mode}`, mode, { protections: PROTECTIONS });
    const plain = provision(dir, `p-${mode}`, mode, { protections: [] });
    assert.deepEqual(plain, [], "a session without a managed worktree gets no runner-owned settings");
    assert.deepEqual(guarded, ["--settings", claudeHookSettingsPath(dir, `s-${mode}`)],
      `${mode} carries the guard settings file and nothing else`);

    const withWorktree = launch(guarded, mode, PROTECTIONS);
    const withoutWorktree = launch(plain, mode, []);
    assert.deepEqual(
      permissionArgv(withWorktree.argv),
      permissionArgv(withoutWorktree.argv),
      `${mode}: the managed worktree changes nothing about the permission transport`,
    );
    assert.deepEqual(withWorktree.stderr, [], `${mode}: no mediation notice is emitted`);
    // The ONLY argv difference is the runner-owned settings file that carries the guard. (The
    // provider session id is a fresh UUID per driver, so it is normalized away first.)
    const normalize = (run: Launch) => {
      const argv = [...run.argv];
      const index = argv.indexOf("--session-id");
      if (index >= 0) argv[index + 1] = "<session-id>";
      return argv;
    };
    const plainArgv = normalize(withoutWorktree);
    const difference = normalize(withWorktree).filter((arg) => !plainArgv.includes(arg));
    assert.deepEqual(difference, ["--settings", claudeHookSettingsPath(dir, `s-${mode}`)],
      `${mode}: the guard settings file is the only difference`);
    withWorktree.driver.dispose();
    withoutWorktree.driver.dispose();
  }
});

test("Auto with a managed worktree keeps --permission-mode auto and its stdio channel", (t) => {
  const dir = tempDir(t);
  const args = provision(dir, "auto-1", "auto", { protections: PROTECTIONS });
  const run = launch(args, "auto", PROTECTIONS);
  t.after(() => run.driver.dispose());
  assert.deepEqual(permissionArgv(run.argv),
    ["--permission-prompt-tool", "stdio", "--permission-mode", "auto"]);
  assert.deepEqual(run.stderr, [],
    "the 'automatic permission review is routed through Wollipog' notice is gone");
});

test("Accept Edits and Ask Every Time with a managed worktree are the ordinary fixed/interactive launches", (t) => {
  const dir = tempDir(t);
  const accept = launch(provision(dir, "ae-1", "acceptEdits", { protections: PROTECTIONS }), "acceptEdits", PROTECTIONS);
  const ask = launch(provision(dir, "ask-1", "default", { protections: PROTECTIONS }), "default", PROTECTIONS);
  t.after(() => { accept.driver.dispose(); ask.driver.dispose(); });
  assert.deepEqual(permissionArgv(accept.argv), ["--permission-mode", "acceptEdits"]);
  assert.deepEqual(permissionArgv(ask.argv), ["--permission-prompt-tool", "stdio"]);
});

test("with the guard active, the driver answers no permission request on the user's behalf", async (t) => {
  const dir = tempDir(t);
  for (const mode of ["bypassPermissions", "acceptEdits", "dontAsk"] as const) {
    const run = launch(provision(dir, `emul-${mode}`, mode, { protections: PROTECTIONS }), mode, PROTECTIONS);
    t.after(() => run.driver.dispose());
    run.child.stdout.write(JSON.stringify({
      type: "control_request",
      request_id: `req-${mode}`,
      request: { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: `${WORKTREE}/a.ts` } },
    }) + "\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const responses = run.writes.join("").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string })
      .filter((frame) => frame.type === "control_response");
    assert.deepEqual(responses, [], `${mode}: no emulated response is written`);
  }
});

test("the control-channel refusal survives as defense in depth even with the guard active", async (t) => {
  const dir = tempDir(t);
  const run = launch(provision(dir, "veto-1", "auto", { protections: PROTECTIONS }), "auto", PROTECTIONS);
  t.after(() => run.driver.dispose());
  run.child.stdout.write(JSON.stringify({
    type: "control_request",
    request_id: "veto",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: `git worktree remove ${WORKTREE}` } },
  }) + "\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const responses = run.writes.join("").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; response?: { response?: { behavior?: string; message?: string } } })
    .filter((frame) => frame.type === "control_response");
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.response?.response?.behavior, "deny");
  assert.equal(responses[0]!.response?.response?.message, MANAGED_WORKTREE_REFUSAL);
});

test("without a provisionable guard the launch falls back to EXACTLY today's mediation", (t) => {
  // A non-native context is one of the conditions that makes Claude hooks unsupportable, so the
  // guard cannot be provisioned and the driver must mediate rather than launch natively.
  const dir = tempDir(t);
  const spec = launchSpec("wsl-1", "auto");
  (spec as unknown as { context: { kind: string; distro: string } }).context = { kind: "wsl", distro: "Ubuntu" };
  provisionClaudeHooks(spec, {
    controlPlaneUrl: "ws://127.0.0.1:4317/runner",
    controlPlaneProtocolVersion: 66,
    enabled: true,
    managedWorktreeProtections: PROTECTIONS,
    verifyGuardLaunch: () => ({ ok: true }),
  }, () => {}, hookHost(dir));
  assert.deepEqual(spec.args, [], "no guard settings file is injected for a non-native context");

  const run = launch(spec.args, "auto", PROTECTIONS);
  t.after(() => run.driver.dispose());
  assert.deepEqual(permissionArgv(run.argv), ["--permission-prompt-tool", "stdio"],
    "the mediated launch is interactive default, with no --permission-mode");
  assert.deepEqual(run.stderr, [
    "Claude automatic permission review is routed through Wollipog while runner-owned worktrees are linked so destructive retirement can be refused; use discard_worktree for cleanup.",
  ]);
});

test("the mediated fallback still emulates the fixed-rule modes", async (t) => {
  const run = launch([], "bypassPermissions", PROTECTIONS);
  t.after(() => run.driver.dispose());
  assert.deepEqual(permissionArgv(run.argv), ["--permission-prompt-tool", "stdio"]);
  run.child.stdout.write(JSON.stringify({
    type: "control_request",
    request_id: "emulated",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } },
  }) + "\n");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const responses = run.writes.join("").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; response?: { response?: { behavior?: string } } })
    .filter((frame) => frame.type === "control_response");
  assert.deepEqual(responses.map((frame) => frame.response?.response?.behavior), ["allow"]);
});

test("an open manager-hook circuit keeps the guard: the veto is not a policy-transport feature", (t) => {
  const dir = tempDir(t);
  const args = provision(dir, "circuit-1", "acceptEdits", { protections: PROTECTIONS, managerHooks: true });
  const settings = claudeHookSettingsPath(dir, "circuit-1");
  assert.deepEqual(args, ["--settings", settings]);
  writeHookCircuitState(claudeHookCircuitPath(settings), {
    consecutiveFailures: 3, open: true, openedAt: Date.now(),
  });
  const run = launch(args, "acceptEdits", PROTECTIONS);
  t.after(() => run.driver.dispose());
  assert.ok(run.argv.includes(settings), "the settings argument is kept so the guard still runs");
  assert.deepEqual(permissionArgv(run.argv), ["--permission-mode", "acceptEdits"],
    "and the user's mode is still what launches");
  assert.ok(run.stderr.some((line) => line.includes("hook circuit opened")));
});

test("an open circuit with no guard-only copy drops back to the mediated launch", (t) => {
  const dir = tempDir(t);
  const args = provision(dir, "circuit-2", "acceptEdits", { protections: PROTECTIONS, managerHooks: true });
  const settings = claudeHookSettingsPath(dir, "circuit-2");
  rmSync(claudeHookGuardPath(settings), { force: true });
  writeHookCircuitState(claudeHookCircuitPath(settings), {
    consecutiveFailures: 3, open: true, openedAt: Date.now(),
  });
  const run = launch(args, "acceptEdits", PROTECTIONS);
  t.after(() => run.driver.dispose());
  assert.equal(run.argv.includes(settings), false);
  assert.deepEqual(permissionArgv(run.argv), ["--permission-prompt-tool", "stdio"],
    "an unguarded launch is never native: it falls back to mediation");
});

test("protectedClaudePermissionMode expresses the two-branch contract", () => {
  // Branch 1: no managed worktree — the selection is always honoured.
  for (const mode of [...MODES, "plan"]) {
    assert.equal(protectedClaudePermissionMode(mode, false), mode);
    assert.equal(protectedClaudePermissionMode(mode, false, true), mode);
  }
  // Branch 2: a managed worktree WITHOUT the guard keeps #1256's mediation exactly.
  assert.equal(protectedClaudePermissionMode("plan", true), "plan");
  assert.equal(protectedClaudePermissionMode("acceptEdits", true), "default");
  assert.equal(protectedClaudePermissionMode("auto", true), "default");
  assert.equal(protectedClaudePermissionMode("bypassPermissions", true), "default");
  assert.equal(protectedClaudePermissionMode("dontAsk", true), "default");
  // Branch 3: a managed worktree WITH the guard honours the selection; the hook holds the veto.
  for (const mode of [...MODES, "plan"]) {
    assert.equal(protectedClaudePermissionMode(mode, true, true), mode);
  }
});
