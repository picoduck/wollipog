import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionMeta } from "./session-store.js";
import { agentTuiLaunch, prepareAgentTuiLaunch } from "./agent-tui.js";
import { provisionAgentControl } from "./agent-control.js";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { waitForPendingKills } from "./spawn.js";
import { openWindowsConpty } from "./windows-conpty.js";
import { orchestratorLaunchArgs } from "./orchestrator-preset.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "manager-session",
    agentId: "agent",
    workspaceId: "workspace",
    repoPath: "/repo",
    worktreePath: "/repo-wt",
    driver: "claude-code",
    command: "claude",
    args: ["--profile", "team profile"],
    env: { PROVIDER_TOKEN: "runner-local" },
    context: { kind: "native" },
    agentSessionId: "structured-provider-session",
    status: "idle",
    title: "Test",
    config: {},
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

/**
 * A session that owns no runner-created worktree and provisions no guard: the launch shape every
 * test here predates. `agent-tui-managed-worktree.test.ts` covers the guarded launch (#1337).
 */
const unguarded = (spec: SessionMeta) => ({ protections: [], args: spec.args, guardActive: false });

/** The session is still there when its preparation settles: the case every test here predates.
 * `agent-tui-agent-control.test.ts` covers a delete landing inside that window (#1379). */
const stillPresent = () => {};

const CLAUDE_RUNNER_ENV = [
  "ANTHROPIC_API_KEY",
  "WOLLIPOG_CLAUDE_PERSISTENT",
  "WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS",
  "WOLLIPOG_CLAUDE_PENDING_MAX_MS",
  "WOLLIPOG_CLAUDE_HANDOFF_WAIT_MAX_MS",
  "MAM_CLAUDE_PERSISTENT",
  "MAM_CLAUDE_PERSISTENT_IDLE_MS",
  "MAM_CLAUDE_PENDING_MAX_MS",
];

test("agent TUI launch is provider-gated and never attaches structured session identity", () => {
  const launch = agentTuiLaunch(meta(), { platform: "linux" });
  assert.deepEqual(launch, {
    command: "claude",
    args: ["--profile", "team profile"],
    env: { PROVIDER_TOKEN: "runner-local" },
    scrubInheritedEnv: CLAUDE_RUNNER_ENV,
  });
  assert.equal(JSON.stringify(launch).includes("structured-provider-session"), false);
  assert.equal(agentTuiLaunch(meta({ driver: "acp" }), { platform: "linux" }), null);
  assert.equal(agentTuiLaunch(meta({ command: "" }), { platform: "linux" }), null);
});

test("Windows agent TUI launch supports cmd shims inside ConPTY", () => {
  assert.deepEqual(agentTuiLaunch(meta(), { platform: "win32", comspec: "C:\\Windows\\cmd.exe" }), {
    command: "C:\\Windows\\cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", '"claude --profile "team profile""'],
    env: { PROVIDER_TOKEN: "runner-local" },
    scrubInheritedEnv: CLAUDE_RUNNER_ENV,
    verbatimCommandLine: 'C:\\Windows\\cmd.exe /d /v:off /s /c "claude --profile "team profile""',
  });
});

test("Windows cmd shim receives spaced and metacharacter TUI args intact through ConPTY", { skip: process.platform !== "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-argv (x86) & Tools "));
  const capture = join(dir, "capture.cjs");
  const shim = join(dir, "echo args.cmd");
  writeFileSync(capture, 'process.stdout.write("TUI_ARGV=" + JSON.stringify(process.argv.slice(2)) + "\\n")\n', "utf8");
  writeFileSync(shim, '@echo off\r\nnode "%~dp0capture.cjs" %*\r\n', "utf8");
  const argv = [
    "team profile", "amp&value", 'say "yes"', "paren(value)", "pipe|value", "less<value",
    "more>value", "caret^value", "bang!kept", "comma,value", "semi;value", "equals=value",
    "C:\\path with space\\", "after-space-tail", "equals=tail\\", "after-equals-tail",
    'before\\"after', 'before\\\\"after', 'before\\"', '\\"after', 'before"\\', "after-quote-tail",
  ];
  const launch = agentTuiLaunch(meta({
    command: shim,
    args: argv,
  }), {
    platform: "win32",
    comspec: process.env.ComSpec,
  });
  assert.ok(launch);
  const child = openWindowsConpty({
    command: launch.command,
    args: launch.args,
    cwd: dir,
    cols: 100,
    rows: 25,
    env: launch.env,
    scrubInheritedEnv: launch.scrubInheritedEnv,
    verbatimCommandLine: launch.verbatimCommandLine,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  const closed = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
  try {
    const started = Date.now();
    while (!output.includes("TUI_ARGV=") && Date.now() - started < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const encoded = output.match(/TUI_ARGV=(\[[^\r\n]*\])/u)?.[1];
    assert.ok(encoded, output);
    assert.deepEqual(JSON.parse(encoded), argv);
  } finally {
    // kill() only starts taskkill, so the shim can still hold this directory as its working
    // directory once the call returns, and Windows then rejects the removal with EPERM - which
    // force: true does not suppress. Wait for the pseudoconsole to close and the kill to land.
    child.kill();
    await new Promise<void>((resolve) => {
      const expiry = setTimeout(resolve, 10_000);
      void closed.then(() => { clearTimeout(expiry); resolve(); });
    });
    await waitForPendingKills(10_000);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch (error) {
      // The assertions above have already decided this test. A temp directory the OS still holds
      // open is the runner image's to reap; failing here would look just like an argv regression.
      t.diagnostic(`ConPTY temp directory cleanup failed: ${String(error)}`);
    }
  }
});

test("Windows cmd shim launch rejects percent expansion", () => {
  assert.throws(
    () => agentTuiLaunch(meta({ args: ["%USERPROFILE%"] }), { platform: "win32", comspec: "cmd.exe" }),
    /contain %/,
  );
});

test("Windows Claude Orchestrator TUI argv carries a single-line system prompt", () => {
  const args = orchestratorLaunchArgs("claude-code", {
    command: "runner.exe", args: ["--agent-control-mcp"], env: {},
  }, ["C:\\repo"]);
  const launch = agentTuiLaunch(meta({ driver: "claude-code", args }), {
    platform: "win32", comspec: "cmd.exe",
  });
  assert.ok(launch);
  assert.equal(args.some((arg) => /[\r\n]/u.test(arg)), false);
  assert.match(launch.args.at(-1) ?? "", /append-system-prompt/);
});

test("orchestrator TUIs rebuild credentials and restrictions without mutating durable metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-tui-"));
  try {
    for (const driver of ["claude-code", "codex", "codex-app-server"] as const) {
      const source = meta({ driver, args: [], env: {}, config: { permissionMode: "orchestrator" } });
      const original = JSON.stringify(source);
      let probes = 0;
      const launch = await prepareAgentTuiLaunch(source, {
        controlPlaneProtocolVersion: PROTOCOL_VERSION,
        executionIsolationMode: "bwrap",
        platform: "linux",
        prepareScratch: async () => "/scratch",
        assertSessionNotDeleted: stillPresent,
        provisionManagedWorktreeGuard: unguarded,
        provision: (prepared) => provisionAgentControl(prepared, {
          controlPlaneUrl: "ws://127.0.0.1:8787/runner",
          controlPlaneProtocolVersion: PROTOCOL_VERSION,
          executionIsolationMode: "bwrap",
          registerCredential: () => {},
        }, () => {}, {
          configDir: dir, execPath: process.execPath, scriptPath: "/runner/cli.ts", execArgv: [], isSea: false,
          platform: "linux",
        }),
        probe: async (prepared, cwd) => {
          probes++;
          assert.equal(cwd, "/scratch");
          assert.ok(prepared.args.includes("--strict-config"));
          assert.equal(prepared.env?.WOLLIPOG_PERMISSION_PRESET, "orchestrator");
          return ["-c", "mcp_servers.ambient.enabled=false"];
        },
      });
      assert.ok(launch);
      assert.equal(launch.cwd, "/scratch");
      assert.equal(launch.env?.WOLLIPOG_PERMISSION_PRESET, "orchestrator");
      assert.equal(launch.env?.TMPDIR, "/scratch");
      assert.ok(launch.env?.WOLLIPOG_SESSION_TOKEN_FILE);
      assert.equal(JSON.stringify(source), original);
      if (driver === "claude-code") {
        assert.equal(probes, 0);
        assert.ok(launch.args.includes("--strict-mcp-config"));
        assert.match(launch.args[launch.args.indexOf("--tools") + 1] ?? "", /Read/);
        assert.ok(launch.args.includes("--setting-sources"));
        // #1473: the preset no longer disables hooks through a settings document of its own; the
        // guard's runner-owned document (none here: the stub provisions no guard) is the only one.
        assert.equal(launch.args.includes("--settings"), false);
        assert.equal(launch.args.join(" ").includes("disableAllHooks"), false);
      } else {
        assert.equal(probes, 1);
        const launchText = launch.args.join(" ");
        assert.ok(launchText.includes("mcp_servers.ambient.enabled=false"));
        assert.match(launchText, /sandbox_mode=.*workspace-write/);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("provider-mode Claude Orchestrator TUI keeps the project cwd and provider temp policy", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const source = meta({
      driver: "claude-code",
      args: [],
      env: { PROVIDER_TEMP_POLICY: "inherited" },
      config: { permissionMode: "orchestrator" },
      orchestrator: { strictProjectIsolation: false },
    });
    const launch = await prepareAgentTuiLaunch(source, {
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "provider",
      platform,
      prepareScratch: async () => "/repo-wt",
      provision: () => {},
      assertSessionNotDeleted: stillPresent,
      provisionManagedWorktreeGuard: unguarded,
    });
    assert.ok(launch);
    assert.equal(launch.cwd, "/repo-wt");
    assert.equal(launch.env?.PROVIDER_TEMP_POLICY, "inherited");
    assert.equal(launch.env?.TMPDIR, undefined);
    assert.equal(launch.env?.TEMP, undefined);
    assert.equal(launch.env?.TMP, undefined);
  }
});

test("orchestrator TUI preparation fails closed for old peers, unsupported targets, terminal sessions and probes", async () => {
  const source = meta({ driver: "codex", config: { permissionMode: "orchestrator" } });
  const dependencies = {
    controlPlaneProtocolVersion: PROTOCOL_VERSION, platform: "linux" as const,
    provision: () => {}, prepareScratch: async () => "/scratch",
    assertSessionNotDeleted: stillPresent,
    provisionManagedWorktreeGuard: unguarded,
  };
  await assert.rejects(prepareAgentTuiLaunch(source, { ...dependencies, controlPlaneProtocolVersion: 111 }), /current native/);
  await assert.rejects(prepareAgentTuiLaunch({ ...source, context: { kind: "wsl", distro: "test" } }, dependencies), /current native/);
  await assert.rejects(prepareAgentTuiLaunch({ ...source, driver: "acp" }, dependencies), /current native/);
  await assert.rejects(prepareAgentTuiLaunch(source, { ...dependencies, platform: "win32" }),
    /attested native filesystem boundary/);
  await assert.rejects(prepareAgentTuiLaunch({ ...source, driver: "claude-code" }, {
    ...dependencies, platform: "linux", executionIsolationMode: "provider",
  }), /attested native filesystem boundary/);
  for (const status of ["stopped", "failed", "completed"] as const) {
    await assert.rejects(prepareAgentTuiLaunch({ ...source, status }, dependencies), /active session/);
  }
  await assert.rejects(prepareAgentTuiLaunch(source, {
    ...dependencies, probe: async () => { throw new Error("isolation unavailable"); },
  }), /isolation unavailable/);
  await assert.rejects(prepareAgentTuiLaunch(source, {
    ...dependencies, provision: async () => { throw new Error("credential provisioning failed"); },
  }), /credential provisioning failed/);
  assert.deepEqual(await prepareAgentTuiLaunch(meta(), {
    controlPlaneProtocolVersion: 58, provision: () => assert.fail("ordinary TUI must not reprovision"),
    prepareScratch: async () => assert.fail("ordinary TUI must not prepare scratch"),
    assertSessionNotDeleted: stillPresent,
    provisionManagedWorktreeGuard: unguarded,
  }), { ...agentTuiLaunch(meta()), managedWorktreeGuard: { active: false } });
});

test("an Orchestrator with independent provider permissions has no Native TUI form", async () => {
  await assert.rejects(
    prepareAgentTuiLaunch(meta({ config: { permissionMode: "acceptEdits" }, orchestrator: { strictProjectIsolation: false } }), {
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "provider",
      platform: "linux",
      prepareScratch: async () => "/scratch",
      provision: () => {},
      assertSessionNotDeleted: stillPresent,
      provisionManagedWorktreeGuard: unguarded,
    }),
    /independent provider permissions/,
  );
});

test("a TUI launch drops a persisted --settings file that no longer exists, and keeps one that does", () => {
  // `claude` refuses to start with "Settings file not found", and a TUI replays the persisted args
  // without re-running launch provisioning, so a swept runner-owned settings file must not break it
  // (issue #1313: guarded sessions now persist such an argument).
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-"));
  try {
    const present = join(dir, "s1.settings.json");
    writeFileSync(present, "{}", "utf8");
    const missing = join(dir, "gone.settings.json");
    const launch = agentTuiLaunch(
      meta({ driver: "claude-code", args: ["--settings", missing, "--add-dir", "/notes", "--settings", present] }),
      { platform: "linux" },
    );
    assert.deepEqual(launch?.args, ["--add-dir", "/notes", "--settings", present]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a TUI launch keeps an inline --settings JSON document and still drops a missing file (#1378)", () => {
  // `claude` accepts an inline JSON object as the --settings value. It never names a file, so the
  // missing-file rule must not treat it as one; anything else that is not an existing file still goes.
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-"));
  try {
    const missing = join(dir, "gone.settings.json");
    const inline = '{"disableAllHooks":true}';
    const launch = agentTuiLaunch(
      meta({
        driver: "claude-code",
        args: [
          "--settings", inline, "--settings", missing, "--settings", " { } ",
          "--settings", "[]", "--settings", "null", "--settings", "{not json",
        ],
      }),
      { platform: "linux" },
    );
    assert.deepEqual(launch?.args, ["--settings", inline, "--settings", " { } "]);

    // The preset carried that inline document until #1473; a persisted launch from then still
    // replays through here unchanged, and the current preset has no --settings to drop.
    const preset = orchestratorLaunchArgs("claude-code", {
      command: "runner", args: ["--agent-control-mcp"], env: {},
    }, ["/repo"]);
    assert.equal(preset.includes("--settings"), false);
    assert.deepEqual(agentTuiLaunch(meta({ driver: "claude-code", args: [...preset, "--settings", inline] }), { platform: "linux" })?.args,
      [...preset, "--settings", inline]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
