/**
 * Issue #1337: a native TUI launch of a session with a runner-owned worktree must carry the same
 * managed-worktree guard a runner-driven launch carries, or be refused.
 *
 * These tests drive the REAL provisioning (`provisionAgentTuiManagedWorktreeGuard`, which is the
 * wiring `index.ts` hands to `prepareAgentTuiLaunch`) into a temp hook directory, and then put the
 * reproduction's removal command through the REAL guard decision using the protections file the
 * TUI launch actually names.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { prepareAgentTuiLaunch } from "./agent-tui.js";
import { provisionAgentTuiManagedWorktreeGuard } from "./agent-tui-guard.js";
import {
  claudeHookProtectionsPath,
  claudeHookSessionProtectionsPath,
  claudeHookSettingsPath,
  describeManagedSettings,
  refreshClaudeGuardProtections,
  resetClaudeGuardState,
  type ClaudeHookHost,
} from "./hook-settings.js";
import {
  readManagedWorktreeGuardProtections,
  runManagedWorktreeGuardDecision,
} from "./managed-worktree-guard.js";
import { MANAGED_WORKTREE_REFUSAL } from "./managed-worktree-protection.js";
import type { SessionMeta } from "./session-store.js";

const REPO = "/repo";
const WORKTREE = "/repo-worktrees/s1337";

type Protection = { worktreePath: string; repoPath: string };

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
    sessionId: "s1337",
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

/** Exactly the wiring `index.ts` gives `prepareAgentTuiLaunch`, against a temp hook directory. */
function dependencies(
  configDir: string,
  protections: { worktreePath: string; repoPath: string }[] | (() => Protection[]),
  logs: string[] = [],
) {
  return {
    controlPlaneProtocolVersion: PROTOCOL_VERSION,
    platform: "linux" as const,
    prepareScratch: async () => assert.fail("an ordinary TUI must not prepare scratch"),
    assertSessionNotDeleted: () => {},
    provision: () => assert.fail("an ordinary TUI must not reprovision agent control"),
    provisionManagedWorktreeGuard: (spec: SessionMeta) => provisionAgentTuiManagedWorktreeGuard(
      spec,
      {
        controlPlaneUrl: "ws://127.0.0.1:4317/runner",
        controlPlaneProtocolVersion: PROTOCOL_VERSION,
        enabled: false,
        protections: typeof protections === "function" ? protections : () => protections,
        // The real sidecar self-test spawns a process; managed-worktree-guard.test.ts runs the
        // real launch probe.
        verifyGuardLaunch: () => ({ ok: true as const }),
      },
      (line) => logs.push(line),
      hookHost(configDir),
    ),
  };
}

function settingsArgument(args: readonly string[]): string | null {
  const index = args.lastIndexOf("--settings");
  return index >= 0 ? args[index + 1] ?? null : null;
}

/** The `PreToolUse` payload Claude sends the guard for one Bash call. */
function bashCall(command: string, cwd: string): string {
  return JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });
}

test("a TUI launch for a session with a managed worktree provisions the guard and refuses the removal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-guard-"));
  resetClaudeGuardState();
  try {
    const source = meta();
    const durable = JSON.stringify(source);
    const launch = await prepareAgentTuiLaunch(
      source,
      dependencies(dir, [{ worktreePath: WORKTREE, repoPath: REPO }]),
    );

    assert.ok(launch);
    // The guard is observable in the argv the TUI launches with, never inferred.
    const settings = settingsArgument(launch.args);
    assert.equal(settings, claudeHookSettingsPath(dir, "s1337"));
    assert.equal(describeManagedSettings(settings!)?.guard, true);
    // A fresh protection list, not whatever a previous launch happened to leave behind.
    const protectionsFile = claudeHookProtectionsPath(settings!);
    assert.deepEqual(readManagedWorktreeGuardProtections(protectionsFile), [
      { worktreePath: WORKTREE, repoPath: REPO },
    ]);
    // Durable metadata must not move under launch provisioning.
    assert.equal(JSON.stringify(source), durable);

    // The reproduction: `git worktree remove <worktree-path>` from the TUI session.
    const refused = runManagedWorktreeGuardDecision(
      bashCall(`git worktree remove ${WORKTREE}`, WORKTREE),
      protectionsFile,
    );
    assert.equal(refused.exitCode, 0);
    assert.match(refused.stdout, /"permissionDecision":"deny"/u);
    assert.ok(refused.stdout.includes(MANAGED_WORKTREE_REFUSAL));
    // An unrelated command is still the session's own business.
    assert.deepEqual(
      runManagedWorktreeGuardDecision(bashCall("git status", WORKTREE), protectionsFile),
      { stdout: "", stderr: "", exitCode: 0 },
    );
  } finally {
    resetClaudeGuardState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a TUI launch re-provisions a swept settings file instead of launching without the guard", async () => {
  // Before #1337 the TUI dropped a `--settings` pair whose file was gone (#1320) so `claude` could
  // start at all — which is exactly the launch the bug report calls unguarded.
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-guard-"));
  resetClaudeGuardState();
  try {
    const swept = claudeHookSettingsPath(dir, "s1337");
    const launch = await prepareAgentTuiLaunch(
      meta({ args: ["--settings", swept] }),
      dependencies(dir, [{ worktreePath: WORKTREE, repoPath: REPO }]),
    );
    assert.ok(launch);
    assert.deepEqual(launch.args, ["--settings", swept]);
    assert.equal(describeManagedSettings(swept)?.guard, true);
  } finally {
    resetClaudeGuardState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a TUI refuses a managed-worktree session it cannot guard, and leaves unguardable ones without a worktree alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-guard-"));
  resetClaudeGuardState();
  try {
    const protection = [{ worktreePath: WORKTREE, repoPath: REPO }];
    // A TUI has no driver, so the mediation fallback a runner-driven launch uses where the guard
    // cannot be injected (WSL/container path translation, a non-host execution target) has no TUI
    // form. The launch is refused rather than started unprotected.
    for (const unguardable of [
      meta({ sessionId: "s1337wsl", context: { kind: "wsl", distro: "test" } }),
      meta({ sessionId: "s1337ct", executionTarget: { adapter: "container", id: "c1" } as never }),
    ]) {
      await assert.rejects(
        prepareAgentTuiLaunch(unguardable, dependencies(dir, protection)),
        /managed worktree guard could not be provisioned/u,
      );
    }
    // With no runner-owned worktree there is nothing for the guard to protect, so an unguardable
    // launch keeps opening exactly as it did before.
    const launch = await prepareAgentTuiLaunch(
      meta({ sessionId: "s1337none", context: { kind: "wsl", distro: "test" } }),
      dependencies(dir, []),
    );
    assert.ok(launch);
    assert.equal(settingsArgument(launch.args), null);
  } finally {
    resetClaudeGuardState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a TUI is refused once the guard's own state can no longer be trusted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-guard-"));
  resetClaudeGuardState();
  try {
    const protection = [{ worktreePath: WORKTREE, repoPath: REPO }];
    const first = await prepareAgentTuiLaunch(meta(), dependencies(dir, protection));
    assert.ok(first);
    // Tamper with the protection list the way the guard's tripwire exists to catch. The guard is
    // invalidated, and a TUI has no mediation to fall back to.
    writeFileSync(claudeHookProtectionsPath(settingsArgument(first.args)!), "[]", "utf8");
    await assert.rejects(
      prepareAgentTuiLaunch(meta(), dependencies(dir, protection)),
      /managed worktree guard could not be provisioned/u,
    );
  } finally {
    resetClaudeGuardState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a TUI launch keeps an agent's own settings when the session owns no managed worktree", async () => {
  // Claude applies only the LAST `--settings`, so guarding a worktree-less session that carries
  // its own settings would shadow the agent's rules (docs/adr/0012, "Live protections").
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-guard-"));
  resetClaudeGuardState();
  try {
    const agentSettings = join(dir, "agent.json");
    writeFileSync(agentSettings, "{}", "utf8");
    const launch = await prepareAgentTuiLaunch(
      meta({ sessionId: "s1337own", args: ["--settings", agentSettings] }),
      dependencies(dir, []),
    );
    assert.ok(launch);
    assert.deepEqual(launch.args, ["--settings", agentSettings]);
  } finally {
    resetClaudeGuardState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opening a TUI never retires guard state the running provider still reads", async () => {
  // CR-1.2. A TUI runs ALONGSIDE the session's structured provider. The running provider's loaded
  // hook reads the protection list on every matched tool call, so a TUI open that retired that
  // list would make every one of them fail closed — for a session that merely discarded its last
  // worktree (the list is deliberately kept empty, #1303) and carries its own `--settings`, which
  // is every Claude Orchestrator preset launch.
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-guard-"));
  resetClaudeGuardState();
  try {
    const own = join(dir, "agent.json");
    writeFileSync(own, "{}", "utf8");
    const args = ["--settings", own];
    const guarded = await prepareAgentTuiLaunch(
      meta({ args }),
      dependencies(dir, [{ worktreePath: WORKTREE, repoPath: REPO }]),
    );
    assert.ok(guarded);
    const settings = settingsArgument(guarded.args)!;
    const protectionsFile = claudeHookProtectionsPath(settings);
    assert.equal(describeManagedSettings(settings)?.guard, true);

    // The session discards its last worktree: the live refresh keeps the running provider's guard
    // over an empty list rather than retiring it (#1303). Now its TUI is opened.
    assert.equal(refreshClaudeGuardProtections("s1337", [], dir).state, "refreshed");
    const afterDiscard = await prepareAgentTuiLaunch(meta({ args }), dependencies(dir, []));
    assert.ok(afterDiscard);
    // The TUI itself is unguarded here (guarding it would shadow the agent's own settings), but
    // the running provider's state is untouched and its guard still decides.
    assert.equal(describeManagedSettings(settings)?.guard, true);
    assert.deepEqual(readManagedWorktreeGuardProtections(protectionsFile), []);
    assert.deepEqual(
      runManagedWorktreeGuardDecision(bashCall("git status", REPO), protectionsFile),
      { stdout: "", stderr: "", exitCode: 0 },
    );
  } finally {
    resetClaudeGuardState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the protection list is resolved when provisioning runs, not from the launch snapshot", async () => {
  // CR-1.1. The launch snapshot predates the awaited preparation an Orchestrator TUI performs. A
  // worktree created in that window must reach the list this launch writes; writing the stale
  // snapshot instead would also overwrite the live refresh the running provider depends on.
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-guard-"));
  resetClaudeGuardState();
  try {
    const live: Protection[] = [];
    const source = meta({
      sessionId: "s1337orc",
      args: [],
      config: { permissionMode: "orchestrator" },
    });
    const launch = await prepareAgentTuiLaunch(source, {
      ...dependencies(dir, () => [...live]),
      executionIsolationMode: "bwrap" as const,
      // The worktree appears while the TUI is still preparing its scratch directory.
      prepareScratch: async () => { live.push({ worktreePath: WORKTREE, repoPath: REPO }); return "/scratch"; },
      provision: () => {},
    });
    assert.ok(launch);
    const settings = settingsArgument(launch.args)!;
    assert.deepEqual(readManagedWorktreeGuardProtections(claudeHookProtectionsPath(settings)), [
      { worktreePath: WORKTREE, repoPath: REPO },
    ]);
  } finally {
    resetClaudeGuardState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refusal from the protection source leaves no runner-owned files behind", async () => {
  // CR-2.1. The production source refuses a session deleted while the TUI was preparing, because
  // deletion has already removed this session's hook files. That only helps if nothing is written
  // before the list is resolved.
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-guard-"));
  resetClaudeGuardState();
  try {
    await assert.rejects(
      prepareAgentTuiLaunch(meta(), dependencies(dir, () => {
        throw new Error("session is being deleted");
      })),
      /session is being deleted/u,
    );
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    resetClaudeGuardState();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unguardable Codex TUI for a session with no managed worktree opens unchanged, and says it is unguarded (#1438)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-guard-"));
  resetClaudeGuardState();
  try {
    const deps = dependencies(dir, []);
    const launch = await prepareAgentTuiLaunch(
      meta({ sessionId: "s1337cdx", driver: "codex", command: "codex", args: ["--profile", "team"] }),
      {
        ...deps,
        provisionManagedWorktreeGuard: (spec: SessionMeta, cwd?: string) => provisionAgentTuiManagedWorktreeGuard(
          spec,
          {
            controlPlaneUrl: "ws://127.0.0.1:4317/runner",
            controlPlaneProtocolVersion: PROTOCOL_VERSION,
            enabled: false,
            protections: () => [],
            verifyGuardLaunch: () => ({ ok: true as const }),
            readCodexHookInventory: () => assert.fail("a profiled launch has no faithful probe to run"),
          },
          () => {},
          hookHost(dir),
          cwd,
        ),
      },
    );
    assert.ok(launch);
    // A profile cannot be enumerated, so this launch cannot be guarded. With nothing to protect
    // that is not a refusal: the argv is untouched (#1377), and the launch reports itself
    // unguarded so the runner can say so if a worktree appears while it is open (#1438).
    assert.deepEqual(launch.args, ["--profile", "team"]);
    assert.equal(launch.managedWorktreeGuard?.active, false);
    assert.match(launch.managedWorktreeGuard?.reason ?? "", /profile/u);
    // Only the (empty) protection list was written; it names no worktree and nothing reads it.
    assert.deepEqual(readdirSync(dir), [basename(claudeHookSessionProtectionsPath(dir, "s1337cdx"))]);
  } finally {
    resetClaudeGuardState();
    rmSync(dir, { recursive: true, force: true });
  }
});
