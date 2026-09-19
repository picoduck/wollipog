/**
 * Issue #1377: a Codex native TUI launch of a session with a runner-owned worktree must carry the
 * managed-worktree guard as a Codex `PreToolUse` hook, or be refused.
 *
 * These tests drive the REAL provisioning (`provisionAgentTuiManagedWorktreeGuard`, the wiring
 * `index.ts` hands `prepareAgentTuiLaunch`) into a temp hook directory, then put the reproduction's
 * removal command through the REAL guard decision using the protections file named inside the
 * `-c` override the TUI actually launches with. Only the hook inventory is stubbed where a test
 * needs a specific inventory; the probe client itself is exercised against a fake app-server
 * process, and against the installed `codex` when one is present.
 */

import assert from "node:assert/strict";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { parse as shellParse } from "shell-quote";
import { prepareAgentTuiLaunch } from "./agent-tui.js";
import { provisionAgentTuiManagedWorktreeGuard } from "./agent-tui-guard.js";
import { UnguardedAgentTuiRegistry, unguardedAgentTuiNotice } from "./agent-tui-guard-notice.js";
import {
  CODEX_HOOK_TRUST_BYPASS_FLAG,
  codexGuardArgsActive,
  codexGuardCommandString,
  codexGuardConfigOverride,
  codexHookInventoryProbe,
  codexHookInventoryVerdict,
  codexHookIsolationVerdict,
  codexHookStateDisableOverride,
  readCodexHookInventory,
  withoutCodexHooksFeatureDisable,
  type CodexHookEntry,
  type CodexHookInventoryProbe,
} from "./codex-managed-worktree-guard.js";
import { orchestratorLaunchArgs } from "./orchestrator-preset.js";
import {
  claudeHookSessionProtectionsPath,
  refreshClaudeGuardProtections,
  resetClaudeGuardState,
  type ClaudeHookHost,
} from "./hook-settings.js";
import {
  MANAGED_WORKTREE_GUARD_MATCHER,
  MANAGED_WORKTREE_GUARD_MODE,
  readManagedWorktreeGuardProtections,
  runManagedWorktreeGuardDecision,
} from "./managed-worktree-guard.js";
import { MANAGED_WORKTREE_REFUSAL } from "./managed-worktree-protection.js";
import type { SessionMeta } from "./session-store.js";

const REPO = "/repo";
const WORKTREE = "/repo-worktrees/s1377";
const PROTECTED = [{ worktreePath: WORKTREE, repoPath: REPO }];

function hookHost(configDir: string): ClaudeHookHost {
  return {
    isSea: false,
    execPath: "/usr/bin/node",
    execArgv: ["--import", "/abs/tsx/loader.mjs"],
    scriptPath: "/repo/apps/runner/src/index.ts",
    configDir,
  };
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "s1377",
    agentId: "codex",
    workspaceId: "workspace",
    repoPath: REPO,
    worktreePath: WORKTREE,
    driver: "codex-app-server",
    command: "codex",
    args: ["-c", 'model="gpt-5-codex"'],
    env: {},
    context: { kind: "native" },
    agentSessionId: "structured-provider-thread",
    status: "idle",
    title: "Test",
    config: { permissionMode: "danger-full-access" },
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

/** What `codex app-server` reports for a session-flags hook: enabled, and never trusted. */
function runnerHookEntry(probe: CodexHookInventoryProbe): CodexHookEntry {
  const override = probe.args[probe.args.length - 1]!;
  const command = /command=("(?:[^"\\]|\\.)*")/u.exec(override)?.[1];
  assert.ok(command, "the probe must carry the runner's override");
  return {
    key: "/<session-flags>/config.toml:pre_tool_use:0:0",
    enabled: true,
    trustStatus: "untrusted",
    source: "sessionFlags",
    command: JSON.parse(command) as string,
  };
}

interface Harness {
  probes: CodexHookInventoryProbe[];
  logs: string[];
}

function dependencies(
  configDir: string,
  options: {
    protections?: typeof PROTECTED;
    inventory?: (probe: CodexHookInventoryProbe) => CodexHookEntry[] | Promise<CodexHookEntry[]>;
    selfTest?: { ok: true } | { ok: false; reason: string };
    platform?: NodeJS.Platform;
  } = {},
  harness: Harness = { probes: [], logs: [] },
) {
  return {
    controlPlaneProtocolVersion: PROTOCOL_VERSION,
    platform: "linux" as const,
    prepareScratch: async () => assert.fail("an ordinary TUI must not prepare scratch"),
    assertSessionNotDeleted: () => {},
    provision: () => assert.fail("an ordinary TUI must not reprovision agent control"),
    provisionManagedWorktreeGuard: (spec: SessionMeta, cwd?: string) =>
      provisionAgentTuiManagedWorktreeGuard(
        spec,
        {
          controlPlaneUrl: "ws://127.0.0.1:4317/runner",
          controlPlaneProtocolVersion: PROTOCOL_VERSION,
          enabled: false,
          protections: () => options.protections ?? PROTECTED,
          // managed-worktree-guard.test.ts runs the real sidecar launch probe.
          verifyGuardLaunch: () => options.selfTest ?? { ok: true as const },
          readCodexHookInventory: async (probe) => {
            harness.probes.push(probe);
            return options.inventory ? options.inventory(probe) : [runnerHookEntry(probe)];
          },
          platform: options.platform ?? "linux",
        },
        (line) => harness.logs.push(line),
        hookHost(configDir),
        cwd,
      ),
  };
}

function overrideArgument(args: readonly string[]): string | null {
  for (let index = args.length - 2; index >= 0; index--) {
    if (args[index] === "-c" && args[index + 1]!.startsWith("hooks.PreToolUse=")) return args[index + 1]!;
  }
  return null;
}

/** The protections file named inside the hook command the override installs. */
function protectionsFileOf(override: string): string {
  const command = /command=("(?:[^"\\]|\\.)*")/u.exec(override)?.[1];
  assert.ok(command);
  const argv = shellParse(JSON.parse(command) as string) as string[];
  assert.ok(argv.includes(MANAGED_WORKTREE_GUARD_MODE));
  return argv[argv.indexOf("--protections") + 1]!;
}

function bashCall(command: string, cwd: string): string {
  return JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd });
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-codex-tui-guard-"));
  resetClaudeGuardState();
  try {
    await run(dir);
  } finally {
    resetClaudeGuardState();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a Codex TUI for a session with a managed worktree carries the guard hook and refuses the removal", async () => {
  await withDir(async (dir) => {
    const harness: Harness = { probes: [], logs: [] };
    const source = meta();
    const durable = JSON.stringify(source);
    const launch = await prepareAgentTuiLaunch(source, dependencies(dir, {}, harness));

    assert.ok(launch);
    // The guard is observable in the argv the TUI launches with, never inferred.
    const override = overrideArgument(launch.args);
    assert.ok(override);
    assert.ok(codexGuardArgsActive(launch.args, override));
    assert.ok(launch.args.includes(CODEX_HOOK_TRUST_BYPASS_FLAG));
    // The catalog's own -c is kept, ahead of the runner's.
    assert.deepEqual(launch.args.slice(0, 2), ["-c", 'model="gpt-5-codex"']);
    // Durable metadata must not move under launch provisioning.
    assert.equal(JSON.stringify(source), durable);

    // The same per-session protections file Claude's guard and the live refresh use, fresh.
    const protectionsFile = protectionsFileOf(override);
    assert.equal(protectionsFile, claudeHookSessionProtectionsPath(dir, "s1377"));
    assert.deepEqual(readManagedWorktreeGuardProtections(protectionsFile), PROTECTED);

    // The inventory was enumerated with the same flags, in the TUI's directory.
    assert.equal(harness.probes.length, 1);
    assert.deepEqual(harness.probes[0]!.args, [
      "app-server", "-c", 'model="gpt-5-codex"', "-c", override,
    ]);
    assert.equal(harness.probes[0]!.cwd, WORKTREE);

    // The reproduction: `git worktree remove <worktree-path>` from the TUI session.
    const refused = runManagedWorktreeGuardDecision(
      bashCall(`git worktree remove ${WORKTREE}`, WORKTREE),
      protectionsFile,
    );
    assert.equal(refused.exitCode, 0);
    assert.match(refused.stdout, /"permissionDecision":"deny"/u);
    assert.ok(refused.stdout.includes(MANAGED_WORKTREE_REFUSAL));
    assert.deepEqual(
      runManagedWorktreeGuardDecision(bashCall("git status", WORKTREE), protectionsFile),
      { stdout: "", stderr: "", exitCode: 0 },
    );
  });
});

test("the plain codex driver is guarded the same way", async () => {
  await withDir(async (dir) => {
    const launch = await prepareAgentTuiLaunch(meta({ driver: "codex", args: [] }), dependencies(dir));
    assert.ok(launch);
    const override = overrideArgument(launch.args);
    assert.ok(override && codexGuardArgsActive(launch.args, override));
  });
});

test("a foreign enabled-but-untrusted hook refuses the Codex TUI and names the hook", async () => {
  await withDir(async (dir) => {
    const foreign = "/home/u/.codex/config.toml:pre_tool_use:0:0";
    await assert.rejects(
      prepareAgentTuiLaunch(meta(), dependencies(dir, {
        inventory: (probe) => [
          runnerHookEntry(probe),
          { key: foreign, enabled: true, trustStatus: "untrusted", command: "/home/u/hook.sh" },
          // Trusted, managed, and disabled hooks are not un-gated by the bypass and do not count.
          { key: "trusted", enabled: true, trustStatus: "trusted", command: "/t.sh" },
          { key: "managed", enabled: true, trustStatus: "managed", command: "/m.sh" },
          { key: "off", enabled: false, trustStatus: "untrusted", command: "/o.sh" },
        ],
      })),
      (error: Error) => {
        assert.match(error.message, /Native TUI is unavailable/u);
        assert.ok(error.message.includes(foreign));
        assert.match(error.message, /Trust them in Codex \(\/hooks\) or disable them/u);
        assert.doesNotMatch(error.message, /trusted,|managed,|\boff\b/u);
        return true;
      },
    );
  });
});

test("a Codex TUI opened before the first worktree is guarded over an empty list, and the worktree that appears later is protected inside it (#1438)", async () => {
  await withDir(async (dir) => {
    const harness: Harness = { probes: [], logs: [] };
    const launch = await prepareAgentTuiLaunch(
      meta({ worktreePath: undefined }),
      dependencies(dir, { protections: [] }, harness),
    );

    assert.ok(launch);
    const override = overrideArgument(launch.args);
    assert.ok(override && codexGuardArgsActive(launch.args, override));
    assert.deepEqual(launch.managedWorktreeGuard, { active: true });
    // The #1377 rule was applied, not skipped: the inventory was enumerated for this launch too.
    assert.equal(harness.probes.length, 1);
    assert.equal(harness.probes[0]!.cwd, REPO);

    // Over an empty list the guard holds no opinion beyond its own state.
    const protectionsFile = protectionsFileOf(override);
    assert.deepEqual(readManagedWorktreeGuardProtections(protectionsFile), []);
    const removal = bashCall(`git worktree remove ${WORKTREE}`, REPO);
    assert.deepEqual(
      runManagedWorktreeGuardDecision(removal, protectionsFile),
      { stdout: "", stderr: "", exitCode: 0 },
    );

    // The worktree appears AFTER the launch was prepared. The session store's patch observer calls
    // exactly this, and the hook the running TUI already carries reads the same file.
    assert.deepEqual(refreshClaudeGuardProtections("s1377", PROTECTED, dir), { state: "refreshed" });
    const refused = runManagedWorktreeGuardDecision(removal, protectionsFile);
    assert.match(refused.stdout, /"permissionDecision":"deny"/u);
    assert.ok(refused.stdout.includes(MANAGED_WORKTREE_REFUSAL));
  });
});

test("with nothing to protect, a foreign untrusted hook neither refuses the Codex TUI nor earns the trust bypass (#1438)", async () => {
  await withDir(async (dir) => {
    const foreign = "/home/u/.codex/config.toml:pre_tool_use:0:0";
    const source = meta({ worktreePath: undefined });
    const launch = await prepareAgentTuiLaunch(source, dependencies(dir, {
      protections: [],
      inventory: (probe) => [
        runnerHookEntry(probe),
        { key: foreign, enabled: true, trustStatus: "untrusted", command: "/home/u/hook.sh" },
      ],
    }));

    assert.ok(launch);
    // Exactly the launch this person had before #1438: their untrusted hook stays gated.
    assert.deepEqual(launch.args, source.args);
    assert.ok(!launch.args.includes(CODEX_HOOK_TRUST_BYPASS_FLAG));
    assert.equal(launch.managedWorktreeGuard?.active, false);
    assert.ok(launch.managedWorktreeGuard?.reason?.includes(foreign));

    // That TUI cannot be given the guard later, so the first worktree is announced, once.
    const registry = new UnguardedAgentTuiRegistry();
    assert.equal(registry.opened("shell-1", "s1377", launch.managedWorktreeGuard, 0), null);
    assert.equal(registry.protectionsChanged("other-session", 1), null);
    const notice = registry.protectionsChanged("s1377", 1);
    assert.ok(notice);
    assert.match(notice, /Close the TUI and open it again/u);
    assert.ok(notice.includes(foreign));
    assert.equal(registry.protectionsChanged("s1377", 2), null);
  });
});

test("the reopen notice is for an unguarded, still-open TUI only (#1438)", () => {
  const registry = new UnguardedAgentTuiRegistry();
  // A guarded TUI is kept in step by the live refresh, and a provider with no guard has no state.
  assert.equal(registry.opened("guarded", "s1", { active: true }, 0), null);
  assert.equal(registry.opened("plain", "s1", undefined, 0), null);
  assert.equal(registry.protectionsChanged("s1", 1), null);

  // Closed before the worktree appeared: nothing is left open to reopen.
  assert.equal(registry.opened("closed", "s2", { active: false }, 0), null);
  registry.exited("closed");
  assert.equal(registry.protectionsChanged("s2", 1), null);

  // A worktree created while the launch was being prepared is announced at open.
  assert.equal(
    registry.opened("raced", "s3", { active: false }, 1),
    unguardedAgentTuiNotice(),
  );
  assert.equal(registry.protectionsChanged("s3", 2), null);

  // Discarding down to nothing is not news, and a reopened TUI is judged afresh.
  assert.equal(registry.opened("first", "s4", { active: false, reason: "why" }, 0), null);
  assert.equal(registry.protectionsChanged("s4", 0), null);
  registry.exited("first");
  assert.equal(registry.opened("second", "s4", { active: false, reason: "why" }, 0), null);
  assert.equal(registry.protectionsChanged("s4", 1), unguardedAgentTuiNotice("why"));
});

test("a modified (re-hashed) hook counts as untrusted", () => {
  const verdict = codexHookInventoryVerdict([
    { key: "ours", enabled: true, trustStatus: "untrusted", command: "guard" },
    { key: "edited", enabled: true, trustStatus: "modified", command: "/e.sh" },
  ], "guard");
  assert.equal(verdict.ok, false);
  assert.deepEqual(!verdict.ok && verdict.foreignUntrusted, ["edited"]);
});

test("a Codex TUI is refused when the inventory cannot be enumerated", async () => {
  await withDir(async (dir) => {
    await assert.rejects(
      prepareAgentTuiLaunch(meta(), dependencies(dir, {
        inventory: () => { throw new Error("the Codex hook inventory probe timed out"); },
      })),
      /could not be enumerated \(the Codex hook inventory probe timed out\)/u,
    );
  });
});

test("a Codex TUI is refused when Codex does not install the runner's hook", async () => {
  await withDir(async (dir) => {
    // What `--disable hooks`, or a Codex build with a different hook schema, looks like.
    await assert.rejects(
      prepareAgentTuiLaunch(meta(), dependencies(dir, { inventory: () => [] })),
      /Codex did not install the runner's PreToolUse hook/u,
    );
  });
});

test("a Codex TUI is refused when the sidecar's launch self-test fails, before any probe", async () => {
  await withDir(async (dir) => {
    const harness: Harness = { probes: [], logs: [] };
    await assert.rejects(
      prepareAgentTuiLaunch(meta(), dependencies(dir, {
        selfTest: { ok: false, reason: "probe exited 1: ERR_MODULE_NOT_FOUND" },
      }, harness)),
      /launch self-test failed/u,
    );
    assert.equal(harness.probes.length, 0);
  });
});

test("an unguardable Codex context with a managed worktree is refused", async () => {
  await withDir(async (dir) => {
    await assert.rejects(
      prepareAgentTuiLaunch(meta({ context: { kind: "wsl", distro: "Ubuntu" } as SessionMeta["context"] }),
        dependencies(dir)),
      /WSL\/container hook path translation is not supported/u,
    );
    await assert.rejects(
      prepareAgentTuiLaunch(meta(), dependencies(dir, { platform: "win32" })),
      /not supported on Windows/u,
    );
  });
});

test("a profiled Codex launch cannot be enumerated and is refused", async () => {
  await withDir(async (dir) => {
    await assert.rejects(
      prepareAgentTuiLaunch(meta({ args: ["--profile", "team"] }), dependencies(dir)),
      /profile may declare hooks/u,
    );
  });
});

test("a tampered protection list refuses the Codex TUI", async () => {
  await withDir(async (dir) => {
    const first = await prepareAgentTuiLaunch(meta(), dependencies(dir));
    assert.ok(first);
    writeFileSync(claudeHookSessionProtectionsPath(dir, "s1377"), JSON.stringify({ version: 1, protections: [] }));
    await assert.rejects(
      prepareAgentTuiLaunch(meta(), dependencies(dir)),
      /modified outside the runner/u,
    );
  });
});

test("a stale runner override is replaced, never duplicated, and a later user override disarms the guard", async () => {
  await withDir(async (dir) => {
    const first = await prepareAgentTuiLaunch(meta(), dependencies(dir));
    assert.ok(first);
    const again = await prepareAgentTuiLaunch(meta({ args: first.args }), dependencies(dir));
    assert.ok(again);
    const override = overrideArgument(first.args)!;
    assert.ok(codexGuardArgsActive(again.args, override));
    assert.equal(again.args.filter((arg) => arg.startsWith("hooks.PreToolUse=")).length, 1);
    assert.equal(again.args.filter((arg) => arg === CODEX_HOOK_TRUST_BYPASS_FLAG).length, 1);

    assert.equal(codexGuardArgsActive([...first.args, "--config", "hooks.PreToolUse=[]"], override), false);
    assert.equal(codexGuardArgsActive(first.args.filter((arg) => arg !== CODEX_HOOK_TRUST_BYPASS_FLAG), override), false);
  });
});

test("guard flags go before an option terminator, and a prompt after it is never read as a flag (review CR-2.2)", async () => {
  await withDir(async (dir) => {
    const harness: Harness = { probes: [], logs: [] };
    const launch = await prepareAgentTuiLaunch(
      meta({ args: ["-c", "a=1", "--", "--disable=hooks please"] }),
      dependencies(dir, {}, harness),
    );
    assert.ok(launch);
    const terminator = launch.args.indexOf("--");
    assert.deepEqual(launch.args.slice(terminator), ["--", "--disable=hooks please"]);
    const override = overrideArgument(launch.args)!;
    assert.ok(launch.args.indexOf(override) < terminator);
    assert.ok(launch.args.indexOf(CODEX_HOOK_TRUST_BYPASS_FLAG) < terminator);
    assert.ok(codexGuardArgsActive(launch.args, override));
    // The prompt text is not replayed into the probe as an option.
    assert.deepEqual(harness.probes[0]!.args, ["app-server", "-c", "a=1", "-c", override]);
    // A guard flag that only appears after the terminator is a prompt, not a guard.
    assert.equal(codexGuardArgsActive(["--", "-c", override, CODEX_HOOK_TRUST_BYPASS_FLAG], override), false);
  });
});

test("remote and Codex-worktree launches cannot be probed locally and are refused (review CR-2.1)", async () => {
  await withDir(async (dir) => {
    for (const args of [["--remote", "ws://127.0.0.1:9"], ["--remote=ws://127.0.0.1:9"], ["--worktree"]]) {
      await assert.rejects(
        prepareAgentTuiLaunch(meta({ args }), dependencies(dir)),
        /runs the session somewhere the local inventory probe cannot see/u,
      );
    }
  });
});

test("the override is a TOML inline table naming the quoted sidecar command", () => {
  const launch = { command: "/usr/bin/node", args: ["cli.ts", MANAGED_WORKTREE_GUARD_MODE, "--protections", "/h/it's here.json"] };
  const override = codexGuardConfigOverride(launch);
  assert.equal(
    override,
    `hooks.PreToolUse=[{matcher=${JSON.stringify(MANAGED_WORKTREE_GUARD_MATCHER)},` +
    `hooks=[{type="command",command=${JSON.stringify(codexGuardCommandString(launch))}}]}]`,
  );
  assert.deepEqual(shellParse(codexGuardCommandString(launch)), [launch.command, ...launch.args]);
  assert.throws(() => codexGuardConfigOverride({ command: "/x\n", args: [] }), /control character/u);
});

test("the probe replays config and feature flags only", () => {
  const probe = codexHookInventoryProbe(
    { command: "codex", args: ["--search", "-c", "a=1", "--enable", "x", "--no-alt-screen", "--config", "b=2"], env: { CODEX_HOME: "/ch" } },
    "/cwd",
    "hooks.PreToolUse=[]",
    { PATH: "/bin" },
  );
  assert.deepEqual(probe.args, ["app-server", "-c", "a=1", "--enable", "x", "--config", "b=2", "-c", "hooks.PreToolUse=[]"]);
  assert.deepEqual(probe.env, { PATH: "/bin", CODEX_HOME: "/ch" });
  assert.throws(() => codexHookInventoryProbe({ command: "codex", args: ["-p", "x"] }, "/", "o"), /profile/u);
  assert.throws(() => codexHookInventoryProbe({ command: "codex", args: ["--profile=x"] }, "/", "o"), /profile/u);
  assert.throws(() => codexHookInventoryProbe({ command: "codex", args: ["-pteam"] }, "/", "o"), /profile/u);
});

test("the probe replays every accepted spelling and follows -C/--cd (review CR-1.1, CR-1.2)", () => {
  const probe = codexHookInventoryProbe(
    {
      command: "codex",
      args: ["--disable=hooks", "--config=a=1", "-cb=2", "--enable=x", "-C", "sub"],
    },
    "/work",
    "hooks.PreToolUse=[]",
    {},
  );
  // `--disable=hooks` has to reach the probe, or it approves a launch whose hooks are all off.
  assert.deepEqual(probe.args, [
    "app-server", "--disable=hooks", "--config=a=1", "-cb=2", "--enable=x", "-c", "hooks.PreToolUse=[]",
  ]);
  assert.equal(probe.cwd, "/work/sub");
  assert.equal(codexHookInventoryProbe({ command: "codex", args: ["--cd=/abs"] }, "/work", "o", {}).cwd, "/abs");
  assert.equal(codexHookInventoryProbe({ command: "codex", args: ["-C/abs2"] }, "/work", "o", {}).cwd, "/abs2");
  assert.equal(codexHookInventoryProbe({ command: "codex", args: ["--cd", "../up"] }, "/work/a", "o", {}).cwd, "/work/up");
});

/** A stand-in app-server that answers initialize and hooks/list over stdio. */
function fakeAppServer(dir: string, reply: string): CodexHookInventoryProbe {
  const script = join(dir, "fake-app-server.mjs");
  writeFileSync(script, `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
  if (message.id === 2 && message.method === "hooks/list" && message.params.cwds[0] === ${JSON.stringify(dir)}) {
    process.stdout.write("not json\\n");
    process.stdout.write(${JSON.stringify(reply)} + "\\n");
  }
});
`);
  return { command: process.execPath, args: [script], cwd: dir, env: process.env };
}

test("the inventory client reads hooks/list over stdio and fails closed on anything else", async () => {
  await withDir(async (dir) => {
    const entries = await readCodexHookInventory(fakeAppServer(dir, JSON.stringify({
      id: 2,
      result: { data: [{ cwd: dir, hooks: [{ key: "k", enabled: true, trustStatus: "untrusted", command: "c", source: "sessionFlags" }], warnings: [], errors: [] }] },
    })));
    assert.deepEqual(entries, [{ key: "k", enabled: true, trustStatus: "untrusted", command: "c", source: "sessionFlags" }]);

    await assert.rejects(
      readCodexHookInventory(fakeAppServer(dir, JSON.stringify({ id: 2, result: { data: [{ hooks: [{ key: "k" }] }] } }))),
      /cannot classify/u,
    );
    await assert.rejects(
      readCodexHookInventory(fakeAppServer(dir, JSON.stringify({ id: 2, error: { message: "nope" } }))),
      /no inventory/u,
    );
    // A discovery error leaves part of the inventory unknown (review CR-1.3).
    await assert.rejects(
      readCodexHookInventory(fakeAppServer(dir, JSON.stringify({
        id: 2,
        result: { data: [{ cwd: dir, hooks: [], warnings: [], errors: [{ path: "/p/hooks.json", message: "bad" }] }] },
      }))),
      /hook discovery errors \(\/p\/hooks\.json\)/u,
    );
    await assert.rejects(
      readCodexHookInventory({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: dir, env: process.env }, undefined, 300),
      /timed out/u,
    );
    await assert.rejects(
      readCodexHookInventory({ command: process.execPath, args: ["-e", "process.exit(0)"], cwd: dir, env: process.env }),
      /exited before answering/u,
    );
    await assert.rejects(
      readCodexHookInventory({ command: join(dir, "missing-codex"), args: [], cwd: dir, env: process.env }),
      /probe failed|could not be started/u,
    );
  });
});

const installedCodex = spawnSync("codex", ["--version"], { encoding: "utf8" });

test("against the installed codex, the override installs an enabled session-flags hook", {
  skip: installedCodex.status !== 0 ? "codex is not installed" : false,
}, async () => {
  await withDir(async (dir) => {
    // A throwaway CODEX_HOME, so the user's own hooks cannot change the verdict.
    const home = join(dir, "codex-home");
    mkdirSync(home);
    const launch = { command: "/bin/true", args: [MANAGED_WORKTREE_GUARD_MODE, "--protections", join(dir, "p.json")] };
    const override = codexGuardConfigOverride(launch);
    const entries = await readCodexHookInventory(codexHookInventoryProbe(
      { command: "codex", args: [], env: { CODEX_HOME: home } }, dir, override,
    ));
    assert.deepEqual(codexHookInventoryVerdict(entries, codexGuardCommandString(launch)), { ok: true });
    const ours = entries.find((entry) => entry.command === codexGuardCommandString(launch));
    assert.equal(ours?.source, "sessionFlags");
    assert.equal(ours?.trustStatus, "untrusted");

    // `--disable=hooks` in the launch turns the guard off; the replayed probe must see that.
    const disabled = await readCodexHookInventory(codexHookInventoryProbe(
      { command: "codex", args: ["--disable=hooks"], env: { CODEX_HOME: home } }, dir, override,
    ));
    assert.equal(codexHookInventoryVerdict(disabled, codexGuardCommandString(launch)).ok, false);
    // An attached `-c` hook the user supplied is seen, and counted as foreign.
    const attached = await readCodexHookInventory(codexHookInventoryProbe(
      {
        command: "codex",
        args: ['-chooks.PostToolUse=[{hooks=[{type="command",command="/x/attached.sh"}]}]'],
        env: { CODEX_HOME: home },
      },
      dir,
      override,
    ));
    const verdict = codexHookInventoryVerdict(attached, codexGuardCommandString(launch));
    assert.equal(verdict.ok, false);
  });
});

/* ---------------------------------------------------------------------------------------------
 * Issue #1473: the Orchestrator preset's Codex TUI carries the guard without any user hook.
 * ------------------------------------------------------------------------------------------ */

const CODEX_PRESET_ARGS = orchestratorLaunchArgs("codex", { command: "/runner", args: ["--agent-control-mcp"], env: {} }, ["/repo"]);

function orchestratorMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return meta({
    sessionId: "s1473",
    worktreePath: undefined,
    args: [...CODEX_PRESET_ARGS],
    config: { permissionMode: "orchestrator" },
    orchestrator: { strictProjectIsolation: true },
    ...overrides,
  });
}

/** The Orchestrator branch of `prepareAgentTuiLaunch` prepares scratch, provisions Agent Control,
 * and probes MCP servers; none of that is under test here, so each is the smallest stand-in. */
function orchestratorDependencies(
  configDir: string,
  options: Parameters<typeof dependencies>[1] = {},
  harness: Harness = { probes: [], logs: [] },
) {
  return {
    ...dependencies(configDir, options, harness),
    executionIsolationMode: "bwrap" as const,
    prepareScratch: async () => "/scratch",
    provision: () => {},
    probe: async () => [] as string[],
  };
}

function stateOverrideOf(args: readonly string[]): string | null {
  const index = args.findIndex((arg, i) => i > 0 && args[i - 1] === "-c" && arg.startsWith("hooks.state="));
  return index >= 0 ? args[index]! : null;
}

function hasHooksDisable(args: readonly string[]): boolean {
  return args.some((arg, i) => (arg === "--disable" && args[i + 1] === "hooks") || arg === "--disable=hooks");
}

test("a Codex Orchestrator TUI drops --disable hooks, disables every foreign hook by key, and carries the guard (#1473)", async () => {
  await withDir(async (dir) => {
    const harness: Harness = { probes: [], logs: [] };
    const foreign = [
      { key: "/home/u/.codex/config.toml:pre_tool_use:0:0", trustStatus: "trusted", command: "/home/u/t.sh" },
      { key: "/repo/.codex/config.toml:post_tool_use:0:0", trustStatus: "untrusted", command: "/repo/u.sh" },
    ];
    const source = orchestratorMeta();
    const launch = await prepareAgentTuiLaunch(source, orchestratorDependencies(dir, {
      protections: [],
      inventory: (probe) => {
        // Codex honours the runner's per-key disable override; the probe reads that back.
        const disabled = !!stateOverrideOf(probe.args);
        return [
          runnerHookEntry(probe),
          ...foreign.map((entry) => ({ ...entry, enabled: !disabled, source: "user" })),
          { key: "already-off", enabled: false, trustStatus: "trusted", command: "/x.sh" },
        ];
      },
    }, harness));

    assert.ok(launch);
    assert.deepEqual(launch.managedWorktreeGuard, { active: true });
    const override = overrideArgument(launch.args);
    assert.ok(override && codexGuardArgsActive(launch.args, override));
    // The preset's flag is gone from the guarded launch, and ONLY the hooks feature flag is.
    assert.equal(hasHooksDisable(launch.args), false);
    for (const feature of ["apps", "plugins", "multi_agent"]) {
      assert.equal(launch.args[launch.args.indexOf(feature) - 1], "--disable", `${feature} stays disabled`);
    }
    assert.ok(launch.args.includes("--strict-config"));
    // Every enabled foreign hook is named in the per-invocation disable override, trusted or not.
    const state = stateOverrideOf(launch.args);
    assert.equal(state,
      'hooks.state={"/home/u/.codex/config.toml:pre_tool_use:0:0"={enabled=false},"/repo/.codex/config.toml:post_tool_use:0:0"={enabled=false}}');
    assert.ok(launch.args.indexOf(state!) < launch.args.indexOf(override!), "the guard override stays last");
    // Two enumerations: one to find the foreign hooks, one to prove they are off. Neither replays
    // the dropped flag, and the second replays the disable override.
    assert.equal(harness.probes.length, 2);
    for (const probe of harness.probes) assert.equal(hasHooksDisable(probe.args), false);
    assert.equal(stateOverrideOf(harness.probes[0]!.args), null);
    assert.equal(stateOverrideOf(harness.probes[1]!.args), state);
    // Durable metadata still says what the preset wrote.
    assert.ok(hasHooksDisable(source.args));
  });
});

test("a Codex Orchestrator TUI with no foreign hook is guarded after a single enumeration (#1473)", async () => {
  await withDir(async (dir) => {
    const harness: Harness = { probes: [], logs: [] };
    const launch = await prepareAgentTuiLaunch(orchestratorMeta(), orchestratorDependencies(dir, { protections: [] }, harness));
    assert.ok(launch);
    assert.deepEqual(launch.managedWorktreeGuard, { active: true });
    assert.equal(harness.probes.length, 1);
    assert.equal(hasHooksDisable(launch.args), false);
    assert.equal(stateOverrideOf(launch.args), null);
  });
});

test("a Codex Orchestrator TUI whose foreign hook stays enabled keeps --disable hooks and no guard, and is refused with something to protect (#1473)", async () => {
  await withDir(async (dir) => {
    const stubborn = { key: "/home/u/.codex/config.toml:pre_tool_use:0:0", enabled: true, trustStatus: "trusted", command: "/home/u/t.sh" };
    const harness: Harness = { probes: [], logs: [] };
    const source = orchestratorMeta();
    // Nothing to protect yet: opened exactly as the preset wrote it, hooks feature off, no bypass.
    const launch = await prepareAgentTuiLaunch(source, orchestratorDependencies(dir, {
      protections: [],
      inventory: (probe) => [runnerHookEntry(probe), stubborn],
    }, harness));
    assert.ok(launch);
    assert.equal(harness.probes.length, 2, "the disable override was tried and read back");
    assert.equal(launch.managedWorktreeGuard?.active, false);
    assert.match(launch.managedWorktreeGuard?.reason ?? "", /Orchestrator launch/u);
    assert.ok(launch.managedWorktreeGuard?.reason?.includes(stubborn.key));
    assert.deepEqual(launch.args, source.args, "the preset's own argv, --disable hooks included");
    assert.ok(hasHooksDisable(launch.args));
    assert.ok(!launch.args.includes(CODEX_HOOK_TRUST_BYPASS_FLAG));

    // With a descendant's worktree to protect, an unguarded Orchestrator TUI is refused instead.
    await assert.rejects(
      prepareAgentTuiLaunch(orchestratorMeta(), orchestratorDependencies(dir, {
        inventory: (probe) => [runnerHookEntry(probe), stubborn],
      })),
      /Native TUI is unavailable.*Orchestrator launch/su,
    );
  });
});

test("a foreign hook whose key the override cannot spell leaves the Codex Orchestrator TUI as the preset wrote it (#1473)", async () => {
  await withDir(async (dir) => {
    const harness: Harness = { probes: [], logs: [] };
    const source = orchestratorMeta();
    const launch = await prepareAgentTuiLaunch(source, orchestratorDependencies(dir, {
      protections: [],
      inventory: (probe) => [
        runnerHookEntry(probe),
        { key: "/home/u/odd\nname/config.toml:pre_tool_use:0:0", enabled: true, trustStatus: "trusted", command: "/x.sh" },
      ],
    }, harness));
    assert.ok(launch);
    assert.equal(launch.managedWorktreeGuard?.active, false);
    assert.match(launch.managedWorktreeGuard?.reason ?? "", /could not be disabled.*control character/u);
    assert.deepEqual(launch.args, source.args);
    assert.equal(harness.probes.length, 1, "no second enumeration was attempted");
  });
});

test("an ordinary Codex TUI still admits a trusted foreign hook and never rewrites --disable hooks (#1473)", async () => {
  await withDir(async (dir) => {
    const harness: Harness = { probes: [], logs: [] };
    const launch = await prepareAgentTuiLaunch(meta({ args: ["--disable", "hooks"] }), dependencies(dir, {
      inventory: (probe) => [
        { ...runnerHookEntry(probe), enabled: false },
        { key: "trusted", enabled: true, trustStatus: "trusted", command: "/t.sh" },
      ],
    }, harness)).catch((error: Error) => error);
    // The person's own `--disable hooks` disables the runner's hook too, which the ordinary rule
    // reports as such — it is not rewritten for them.
    assert.ok(launch instanceof Error);
    assert.match(launch.message, /reports the runner's PreToolUse hook as disabled/u);
    assert.equal(harness.probes.length, 1);
    assert.ok(hasHooksDisable(harness.probes[0]!.args));
  });
});

test("the isolation verdict refuses any enabled hook beside the runner's, and the disable override is one inline table (#1473)", () => {
  const ours = "/usr/bin/node /r/cli.ts --managed-worktree-guard --protections /p.json";
  const runner: CodexHookEntry = { key: "/<session-flags>/config.toml:pre_tool_use:0:0", enabled: true, trustStatus: "untrusted", command: ours };
  assert.deepEqual(codexHookIsolationVerdict([runner], ours), { ok: true });
  assert.deepEqual(codexHookIsolationVerdict([runner, { key: "off", enabled: false, trustStatus: "trusted", command: "/x" }], ours), { ok: true });
  const trusted = codexHookIsolationVerdict([runner, { key: "k1", enabled: true, trustStatus: "trusted", command: "/x" }], ours);
  assert.equal(trusted.ok, false);
  assert.match((trusted as { reason: string }).reason, /Orchestrator launch: k1/u);
  // The ordinary verdicts still come first: an absent or disabled runner hook is reported as such.
  assert.match((codexHookIsolationVerdict([], ours) as { reason: string }).reason, /did not install/u);
  assert.equal(codexHookStateDisableOverride(["a:0:0", 'q"uote']), 'hooks.state={"a:0:0"={enabled=false},"q\\"uote"={enabled=false}}');
  assert.throws(() => codexHookStateDisableOverride(["bad\nkey"]), /control character/u);
  assert.deepEqual(withoutCodexHooksFeatureDisable(["--strict-config", "--disable", "hooks", "--disable=hooks", "--disable", "apps", "--", "--disable", "hooks"]),
    ["--strict-config", "--disable", "apps", "--", "--disable", "hooks"]);
});

test("against the installed codex, a foreign hook is disabled for the invocation by the state override (#1473)", {
  skip: installedCodex.status !== 0 ? "codex is not installed" : false,
}, async () => {
  await withDir(async (dir) => {
    // A throwaway CODEX_HOME carrying a user hook of its own, so the inventory has a foreign entry.
    const home = join(dir, "codex-home");
    mkdirSync(home);
    writeFileSync(join(home, "config.toml"),
      '[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "/bin/true"\n');
    const launch = { command: "/bin/true", args: [MANAGED_WORKTREE_GUARD_MODE, "--protections", join(dir, "p.json")] };
    const override = codexGuardConfigOverride(launch);
    const ours = codexGuardCommandString(launch);
    const entries = await readCodexHookInventory(codexHookInventoryProbe(
      { command: "codex", args: [], env: { CODEX_HOME: home } }, dir, override,
    ));
    const foreign = entries.filter((entry) => entry.enabled && entry.command !== ours);
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0]!.source, "user");
    assert.equal(codexHookIsolationVerdict(entries, ours).ok, false);
    const disabled = await readCodexHookInventory(codexHookInventoryProbe(
      { command: "codex", args: ["-c", codexHookStateDisableOverride(foreign.map((entry) => entry.key))], env: { CODEX_HOME: home } },
      dir, override,
    ));
    assert.deepEqual(codexHookIsolationVerdict(disabled, ours), { ok: true });
    assert.equal(disabled.find((entry) => entry.key === foreign[0]!.key)?.enabled, false);
    assert.equal(disabled.find((entry) => entry.command === ours)?.enabled, true);
  });
});
