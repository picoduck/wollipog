import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SessionMeta } from "./session-store.js";
import { agentTuiLaunch } from "./agent-tui.js";
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
  "WOLLIPOG_CONDUCTOR",
  "MAM_CONDUCTOR",
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
    args: ["/d", "/s", "/c", 'claude --profile "team profile"'],
    env: { PROVIDER_TOKEN: "runner-local" },
    scrubInheritedEnv: CLAUDE_RUNNER_ENV,
    verbatimCommandLine: 'C:\\Windows\\cmd.exe /d /s /c "claude --profile "team profile""',
  });
});

test("Windows cmd shim receives spaced and metacharacter TUI args intact through ConPTY", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-tui-argv (x86) & Tools "));
  const shim = join(dir, "echo args.cmd");
  writeFileSync(shim, "@echo off\r\necho TUI_ARGV=[%~1][%~2][%~3][%~4][%~5]\r\n", "utf8");
  const launch = agentTuiLaunch(meta({
    command: shim,
    args: ["team profile", "amp&value", 'say "yes"', "paren(value)", "pipe|value"],
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
    assert.match(output, /TUI_ARGV=\[team profile\]\[amp&value\]\[say "yes"\]\[paren\(value\)\]\[pipe\|value\]/);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows cmd shim launch rejects percent expansion", () => {
  assert.throws(
    () => agentTuiLaunch(meta({ args: ["%USERPROFILE%"] }), { platform: "win32", comspec: "cmd.exe" }),
    /contains %/,
  );
});
