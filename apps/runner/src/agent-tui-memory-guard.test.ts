/**
 * Issue #1336 slice 3: a native TUI in `provider` mode carries a guard that answers from runner
 * memory, exactly as a runner-driven launch does.
 *
 * These tests drive the REAL provisioning into a temp hook directory with a REAL abstract verdict
 * socket, take the hook command out of the argv the TUI would launch with, and run the REAL sidecar
 * entry point with it — so what is asserted is what the provider's hook would get.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { parse as shellParse } from "shell-quote";
import { prepareAgentTuiLaunch } from "./agent-tui.js";
import { provisionAgentTuiManagedWorktreeGuard } from "./agent-tui-guard.js";
import type { CodexHookEntry, CodexHookInventoryProbe } from "./codex-managed-worktree-guard.js";
import {
  claudeHookSessionProtectionsPath,
  managedWorktreeGuardMemoryProtections,
  refreshClaudeGuardProtections,
  resetClaudeGuardState,
  seedManagedWorktreeGuardMemory,
  type ClaudeHookHost,
} from "./hook-settings.js";
import { ManagedWorktreeGuardSockets } from "./managed-worktree-guard-socket.js";
import { MANAGED_WORKTREE_GUARD_MODE, runManagedWorktreeGuardCli } from "./managed-worktree-guard.js";
import { MANAGED_WORKTREE_REFUSAL } from "./managed-worktree-protection.js";
import type { SessionMeta } from "./session-store.js";

const LINUX = process.platform === "linux";
const REPO = "/repo";
const WORKTREE = "/repo-worktrees/s1336";
const PROTECTED = [{ worktreePath: WORKTREE, repoPath: REPO }];

const roots: string[] = [];
const hosts: ManagedWorktreeGuardSockets[] = [];
after(async () => {
  for (const host of hosts) await host.closeAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  resetClaudeGuardState();
});

function fixture() {
  resetClaudeGuardState();
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-memory-"));
  roots.push(dir);
  const sockets = new ManagedWorktreeGuardSockets(dir);
  hosts.push(sockets);
  return { dir, sockets };
}

function hookHost(configDir: string): ClaudeHookHost {
  return {
    isSea: false,
    execPath: "/usr/bin/node",
    execArgv: ["--import", "tsx"],
    scriptPath: "/repo/apps/runner/src/index.ts",
    configDir,
  };
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "s1336",
    agentId: "claude",
    workspaceId: "workspace",
    repoPath: REPO,
    worktreePath: WORKTREE,
    driver: "claude-code",
    command: "claude",
    args: [],
    env: {},
    context: { kind: "native" },
    agentSessionId: "structured-provider-session",
    status: "idle",
    title: "Test",
    config: { permissionMode: "acceptEdits" },
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    preview: null,
    pendingApproval: null,
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** The wiring `index.ts` gives `prepareAgentTuiLaunch`, with the verdict socket it now supplies. */
function dependencies(
  dir: string,
  sockets: ManagedWorktreeGuardSockets,
  logs: string[],
  protections: () => typeof PROTECTED = () => PROTECTED,
  /** Runs while the socket is being prepared, before provisioning reads the list. */
  duringSocketWait: () => void = () => {},
) {
  return {
    controlPlaneProtocolVersion: PROTOCOL_VERSION,
    platform: "linux" as const,
    prepareScratch: async () => assert.fail("an ordinary TUI must not prepare scratch"),
    assertSessionNotDeleted: () => {},
    provision: () => assert.fail("an ordinary TUI must not reprovision agent control"),
    // The Codex permission profile (#1336 slice 2) probes a real CLI; it is not under test here.
    permissionProfile: async (input: { args: readonly string[] }) =>
      ({ active: false as const, args: [...input.args], reason: "not under test" }),
    provisionManagedWorktreeGuard: (spec: SessionMeta, cwd?: string) => provisionAgentTuiManagedWorktreeGuard(
      spec,
      {
        controlPlaneUrl: "ws://127.0.0.1:4317/runner",
        controlPlaneProtocolVersion: PROTOCOL_VERSION,
        enabled: false,
        protections,
        verifyGuardLaunch: () => ({ ok: true as const }),
        readCodexHookInventory: async (probe: CodexHookInventoryProbe): Promise<CodexHookEntry[]> => {
          const command = /command=("(?:[^"\\]|\\.)*")/u.exec(probe.args[probe.args.length - 1]!)?.[1];
          return [{
            key: "/<session-flags>/config.toml:pre_tool_use:0:0",
            enabled: true,
            trustStatus: "untrusted",
            source: "sessionFlags",
            command: JSON.parse(command!) as string,
          }];
        },
        platform: "linux",
        guardSocket: async (sessionId) => {
          seedManagedWorktreeGuardMemory(sessionId, protections());
          const address = await sockets.ensure(sessionId, "abstract");
          duringSocketWait();
          return address;
        },
      },
      (line) => logs.push(line),
      hookHost(dir),
      cwd,
    ),
  };
}

/** Run the real sidecar with the argv a hook command carries (after the re-entry mode). */
async function sidecar(hookArgs: readonly string[], command: string) {
  let stdout = "";
  let stderr = "";
  let code = -1;
  const mode = hookArgs.indexOf(MANAGED_WORKTREE_GUARD_MODE);
  assert.ok(mode >= 0, "the hook command re-enters the runner as the guard");
  await runManagedWorktreeGuardCli(["node", "cli", ...hookArgs.slice(mode)], {
    stdin: Readable.from([JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: WORKTREE })]),
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
    exit: (value) => { code = value; },
  });
  return { stdout, stderr, code };
}

function nothingOnDiskNames(dir: string, address: string, logs: readonly string[]): void {
  for (const name of readdirSync(dir)) {
    assert.ok(!readFileSync(join(dir, name), "utf8").includes(address), `${name} discloses the socket name`);
  }
  assert.ok(!logs.join("\n").includes(address), "the socket name is never logged");
}

test("a Claude TUI in provider mode launches from an inline document and is judged from memory", { skip: !LINUX }, async () => {
  const { dir, sockets } = fixture();
  const logs: string[] = [];
  const source = meta();
  const durable = JSON.stringify(source);
  const launch = await prepareAgentTuiLaunch(source, dependencies(dir, sockets, logs));
  assert.ok(launch);
  assert.equal(JSON.stringify(source), durable, "durable metadata does not move under provisioning");

  // `agentTuiLaunch` drops a `--settings` whose FILE is gone; an inline document names no file.
  const inline = launch.args[launch.args.lastIndexOf("--settings") + 1]!;
  const document = JSON.parse(inline) as { hooks: { PreToolUse: Array<{ hooks: Array<{ args: string[] }> }> } };
  const hookArgs = document.hooks.PreToolUse[0]!.hooks[0]!.args;
  const address = hookArgs[hookArgs.indexOf("--guard-socket") + 1]!;
  assert.match(address, /^@wollipog-guard-/u);
  assert.equal(readdirSync(dir).some((name) => name.endsWith(".protections.json")), false, "no list on disk");
  nothingOnDiskNames(dir, address, logs);

  const refused = await sidecar(hookArgs, `git worktree remove ${WORKTREE}`);
  assert.equal(refused.code, 0);
  assert.match(refused.stdout, /"permissionDecision":"deny"/u);
  assert.ok(refused.stdout.includes(MANAGED_WORKTREE_REFUSAL));
  assert.deepEqual(await sidecar(hookArgs, "git status"), { stdout: "", stderr: "", code: 0 });

  // The live refresh reaches the open TUI's next call without touching a file.
  assert.deepEqual(refreshClaudeGuardProtections("s1336", [], dir), { state: "refreshed" });
  assert.equal((await sidecar(hookArgs, `git worktree remove ${WORKTREE}`)).stdout, "");
  // A runner that is gone (or a session that is closed) is a refusal, never a pass.
  await sockets.close("s1336");
  assert.equal((await sidecar(hookArgs, "git status")).code, 2);
});

test("a Codex TUI in provider mode asks the same socket, with no list on disk", { skip: !LINUX }, async () => {
  const { dir, sockets } = fixture();
  const logs: string[] = [];
  const launch = await prepareAgentTuiLaunch(
    meta({
      agentId: "codex",
      driver: "codex-app-server",
      command: "codex",
      args: ["-c", 'model="gpt-5-codex"'],
      config: { permissionMode: "danger-full-access" },
    }),
    dependencies(dir, sockets, logs),
  );
  assert.ok(launch);
  const override = launch.args.find((arg) => arg.startsWith("hooks.PreToolUse="));
  assert.ok(override);
  const command = /command=("(?:[^"\\]|\\.)*")/u.exec(override)?.[1];
  const hookArgs = shellParse(JSON.parse(command!) as string) as string[];
  const address = hookArgs[hookArgs.indexOf("--guard-socket") + 1]!;
  assert.match(address, /^@wollipog-guard-/u);
  // The protections PATH is still named (the guard-state veto takes its directory from it) ...
  assert.equal(hookArgs[hookArgs.indexOf("--protections") + 1], claudeHookSessionProtectionsPath(dir, "s1336"));
  // ... but nothing is written there, or anywhere else in the hook state directory.
  assert.deepEqual(readdirSync(dir), []);
  nothingOnDiskNames(dir, address, logs);

  const refused = await sidecar(hookArgs, `git worktree remove ${WORKTREE}`);
  assert.ok(refused.stdout.includes(MANAGED_WORKTREE_REFUSAL));
  assert.deepEqual(await sidecar(hookArgs, "git status"), { stdout: "", stderr: "", code: 0 });
});

for (const driver of ["claude-code", "codex-app-server"] as const) {
  test(`a ${driver} TUI provisions the list as it is AFTER the socket wait, not a snapshot from before (review CR-1.1)`, { skip: !LINUX }, async () => {
    // The socket proof can take seconds. A worktree the session acquires meanwhile reaches the live
    // list through the refresh; provisioning must not overwrite it with the older snapshot.
    const { dir, sockets } = fixture();
    const later = { worktreePath: "/repo-worktrees/created-during-the-wait", repoPath: REPO };
    let live = PROTECTED;
    const launch = await prepareAgentTuiLaunch(
      meta(driver === "claude-code" ? {} : {
        agentId: "codex", driver, command: "codex", args: [], config: { permissionMode: "danger-full-access" },
      }),
      dependencies(dir, sockets, [], () => live, () => { live = [...PROTECTED, later]; }),
    );
    assert.ok(launch);
    assert.deepEqual(managedWorktreeGuardMemoryProtections("s1336"), [...PROTECTED, later]);
  });
}
