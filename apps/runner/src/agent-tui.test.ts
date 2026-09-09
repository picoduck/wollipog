import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionMeta } from "./session-store.js";
import { agentTuiLaunch, prepareAgentTuiLaunch } from "./agent-tui.js";
import { provisionAgentControl } from "./agent-control.js";
import { PROTOCOL_VERSION } from "@wollipog/protocol";
import { openWindowsConpty } from "./windows-conpty.js";

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

const CLAUDE_RUNNER_ENV = [
  "ANTHROPIC_API_KEY",
  "WOLLIPOG_CLAUDE_PERSISTENT",
  "WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS",
  "WOLLIPOG_CLAUDE_PENDING_MAX_MS",
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

test("Windows cmd shim receives spaced and metacharacter TUI args intact through ConPTY", { skip: process.platform !== "win32" }, async () => {
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
  try {
    const started = Date.now();
    while (!output.includes("TUI_ARGV=") && Date.now() - started < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const encoded = output.match(/TUI_ARGV=(\[[^\r\n]*\])/u)?.[1];
    assert.ok(encoded, output);
    assert.deepEqual(JSON.parse(encoded), argv);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows cmd shim launch rejects percent expansion", () => {
  assert.throws(
    () => agentTuiLaunch(meta({ args: ["%USERPROFILE%"] }), { platform: "win32", comspec: "cmd.exe" }),
    /contain %/,
  );
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
        provision: (prepared) => provisionAgentControl(prepared, {
          controlPlaneUrl: "ws://127.0.0.1:8787/runner",
          controlPlaneProtocolVersion: PROTOCOL_VERSION,
          registerCredential: () => {},
        }, () => {}, {
          configDir: dir, execPath: process.execPath, scriptPath: "/runner/cli.ts", execArgv: [], isSea: false,
        }),
        probe: async (prepared, cwd) => {
          probes++;
          assert.equal(cwd, "/repo-wt");
          assert.ok(prepared.args.includes("--strict-config"));
          assert.equal(prepared.env?.WOLLIPOG_PERMISSION_PRESET, "orchestrator");
          return ["-c", "mcp_servers.ambient.enabled=false"];
        },
      });
      assert.ok(launch);
      assert.equal(launch.env?.WOLLIPOG_PERMISSION_PRESET, "orchestrator");
      assert.ok(launch.env?.WOLLIPOG_SESSION_TOKEN_FILE);
      assert.equal(JSON.stringify(source), original);
      if (driver === "claude-code") {
        assert.equal(probes, 0);
        if (process.platform === "win32") {
          const tail = launch.args.at(-1) ?? "";
          assert.ok(tail.includes("--strict-mcp-config"));
          assert.match(tail, /--tools ""/);
          assert.ok(tail.includes("--setting-sources"));
        } else {
          assert.ok(launch.args.includes("--strict-mcp-config"));
          assert.equal(launch.args[launch.args.indexOf("--tools") + 1], "");
          assert.ok(launch.args.includes("--setting-sources"));
        }
      } else {
        assert.equal(probes, 1);
        const launchText = launch.args.join(" ");
        assert.ok(launchText.includes("mcp_servers.ambient.enabled=false"));
        assert.match(launchText, /sandbox_mode=.*read-only/);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("orchestrator TUI preparation fails closed for old peers, unsupported targets, terminal sessions and probes", async () => {
  const source = meta({ driver: "codex", config: { permissionMode: "orchestrator" } });
  const dependencies = { controlPlaneProtocolVersion: PROTOCOL_VERSION, provision: () => {} };
  await assert.rejects(prepareAgentTuiLaunch(source, { ...dependencies, controlPlaneProtocolVersion: 111 }), /current native/);
  await assert.rejects(prepareAgentTuiLaunch({ ...source, context: { kind: "wsl", distro: "test" } }, dependencies), /current native/);
  await assert.rejects(prepareAgentTuiLaunch({ ...source, driver: "acp" }, dependencies), /current native/);
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
  }), agentTuiLaunch(meta()));
});
