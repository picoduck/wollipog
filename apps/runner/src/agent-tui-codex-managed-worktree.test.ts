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
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { parse as shellParse } from "shell-quote";
import { prepareAgentTuiLaunch } from "./agent-tui.js";
import { provisionAgentTuiManagedWorktreeGuard } from "./agent-tui-guard.js";
import {
  CODEX_HOOK_TRUST_BYPASS_FLAG,
  codexGuardArgsActive,
  codexGuardCommandString,
  codexGuardConfigOverride,
  codexHookInventoryProbe,
  codexHookInventoryVerdict,
  readCodexHookInventory,
  type CodexHookEntry,
  type CodexHookInventoryProbe,
} from "./codex-managed-worktree-guard.js";
import {
  claudeHookSessionProtectionsPath,
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
