import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type SessionLaunchSpec } from "@wollipog/protocol";
import { provisionAgentControl, type AgentControlHost } from "./agent-control.js";
import { ASSISTANT_INSTRUCTIONS, assistantLaunchArgs, stripAssistantLaunchArgs } from "./assistant-launch.js";

function assistantSpec(driver: SessionLaunchSpec["driver"], args: string[] = []): SessionLaunchSpec {
  return {
    sessionId: "s_assistant", workspaceId: "ws", workspacePath: "/home/owner", agentId: "agent",
    command: driver === "claude-code" ? "claude" : "codex", args, env: { PROVIDER_SETTING: "kept" }, useWorktree: false,
    driver, context: { kind: "native" },
    assistant: { threadId: "thr_fixture" },
  };
}

function withHost(run: (host: AgentControlHost, root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "wollipog-assistant-launch-"));
  try { run({ isSea: true, execPath: "/opt/wollipog-runner", execArgv: [], configDir: root }, root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

const config = { controlPlaneUrl: "ws://127.0.0.1:4317/runner", controlPlaneProtocolVersion: PROTOCOL_VERSION };

for (const driver of ["claude-code", "codex", "codex-app-server"] as const) {
  test(`an assistant ${driver} launch gets its instructions and no agent-control server, CLI or credential`, () => {
    withHost((host, root) => {
      const registered: string[] = [];
      const launch = assistantSpec(driver, ["--user-flag"]);
      provisionAgentControl(launch, { ...config, registerCredential: (sessionId) => registered.push(sessionId) }, () => {}, host);
      const instructions = driver === "claude-code"
        ? ["--append-system-prompt", ASSISTANT_INSTRUCTIONS]
        : ["-c", `developer_instructions=${JSON.stringify(ASSISTANT_INSTRUCTIONS)}`];
      assert.deepEqual(launch.args, ["--user-flag", ...instructions]);
      assert.deepEqual(launch.env, { PROVIDER_SETTING: "kept" }, "no Wollipog endpoint, token path or relay key reaches the agent");
      assert.deepEqual(registered, [], "no agent-control credential is minted or registered");
      assert.deepEqual(readdirSync(root), [], "no token, ready, MCP config or CLI file is written");
      // A relaunch from the persisted arguments replaces the instructions rather than adding more.
      provisionAgentControl(launch, config, () => {}, host);
      assert.deepEqual(launch.args, ["--user-flag", ...instructions]);
    });
  });
}

test("an assistant launch refuses another harness and any second role, never launching an ordinary session", () => {
  withHost((host) => {
    for (const driver of ["pi", "acp"] as const) {
      const launch = assistantSpec(driver);
      assert.throws(() => provisionAgentControl(launch, config, () => {}, host), /only on Claude Code or Codex/);
    }
    const orchestrator = { ...assistantSpec("claude-code"), orchestrator: { strictProjectIsolation: false } } as SessionLaunchSpec;
    assert.throws(() => provisionAgentControl(orchestrator, config, () => {}, host), /no other role/);
    const wsl: SessionLaunchSpec = { ...assistantSpec("claude-code"), context: { kind: "wsl", distro: "Ubuntu" } };
    assert.throws(() => provisionAgentControl(wsl, config, () => {}, host), /native Claude Code or Codex/);
  });
});

test("stripping keeps a user's own instructions", () => {
  const own = ["--append-system-prompt", "Prefer short answers", "-c", 'developer_instructions="Mine"'];
  assert.deepEqual(stripAssistantLaunchArgs([...own, ...assistantLaunchArgs("claude-code", []), ...assistantLaunchArgs("codex", [])]), own);
});
