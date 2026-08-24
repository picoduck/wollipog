import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition, SessionLaunchSpec } from "@wollipog/protocol";
import {
  applyConductorAdvertisementFence,
  CONDUCTOR_DISALLOWED_TOOLS,
  CONDUCTOR_READ_TOOLS,
  buildConductorArgs,
  conductorMcpCommand,
  conductorSystemPrompt,
  deriveCpHttpUrl,
  provisionConductor,
  removeConductorMcpConfig,
  stageRunnerCredentialFile,
  sweepConductorMcpConfigs,
  withConductorAgent,
  writeRunnerCredentialFile,
  type ConductorHost,
} from "./conductor.js";
import { mergeAgents } from "./discovery/discover.js";
import { winQuoteArg } from "./spawn.js";

/* -------------------------------------------------------------------------- */
/* deriveCpHttpUrl                                                             */
/* -------------------------------------------------------------------------- */

test("deriveCpHttpUrl: ws->http, wss->https, /runner suffix stripped (local + box tunnel)", () => {
  assert.equal(deriveCpHttpUrl("ws://127.0.0.1:4317/runner"), "http://127.0.0.1:4317");
  assert.equal(deriveCpHttpUrl("ws://127.0.0.1:39201/runner"), "http://127.0.0.1:39201"); // box tunnel port
  assert.equal(deriveCpHttpUrl("wss://manager.example.com/runner"), "https://manager.example.com");
  assert.throws(
    () => deriveCpHttpUrl("ws://manager.example.com/runner"),
    /--allow-insecure-transport/u,
  );
  assert.equal(
    deriveCpHttpUrl("ws://manager.example.com/runner", true),
    "http://manager.example.com",
  );
});

/* -------------------------------------------------------------------------- */
/* conductorMcpCommand                                                         */
/* -------------------------------------------------------------------------- */

test("conductorMcpCommand: SEA re-enters the binary with just --conductor-mcp", () => {
  const launch = conductorMcpCommand({
    isSea: true,
    execPath: "/home/u/.agent-manager/agent-manager-runner",
    execArgv: [],
    scriptPath: undefined,
  });
  assert.equal(launch.command, "/home/u/.agent-manager/agent-manager-runner");
  assert.deepEqual(launch.args, ["--conductor-mcp"]);
});

test("conductorMcpCommand: script launches re-spawn node with execArgv (tsx loader in dev) + the script", () => {
  const launch = conductorMcpCommand({
    isSea: false,
    execPath: "/usr/bin/node",
    execArgv: ["--import", "tsx"],
    scriptPath: "/repo/apps/runner/src/cli.ts",
  });
  assert.equal(launch.command, "/usr/bin/node");
  assert.deepEqual(launch.args, ["--import", "tsx", "/repo/apps/runner/src/cli.ts", "--conductor-mcp"]);
});

test("conductorMcpCommand rewrites a legacy index.* entry to its cli.* sibling (only cli dispatches the flag)", () => {
  // A daemon started the pre-dispatcher way (`tsx src/index.ts`) must not point the MCP
  // server at index.* — that would boot a SECOND daemon whose stdout corrupts JSON-RPC.
  const dev = conductorMcpCommand({
    isSea: false,
    execPath: "/usr/bin/node",
    execArgv: ["--import", "tsx"],
    scriptPath: "/repo/apps/runner/src/index.ts",
  });
  assert.deepEqual(dev.args, ["--import", "tsx", "/repo/apps/runner/src/cli.ts", "--conductor-mcp"]);

  // dist (compiled) and Windows separators rewrite too, preserving the original separator.
  const dist = conductorMcpCommand({
    isSea: false,
    execPath: "node",
    execArgv: [],
    scriptPath: "C:\\repo\\apps\\runner\\dist\\index.js",
  });
  assert.deepEqual(dist.args, ["C:\\repo\\apps\\runner\\dist\\cli.js", "--conductor-mcp"]);

  // Non-index entries pass through untouched (cli.ts itself, or an unrelated wrapper).
  const cli = conductorMcpCommand({ isSea: false, execPath: "node", execArgv: [], scriptPath: "/x/cli.ts" });
  assert.deepEqual(cli.args, ["/x/cli.ts", "--conductor-mcp"]);
  const other = conductorMcpCommand({ isSea: false, execPath: "node", execArgv: [], scriptPath: "/x/main-index.ts" });
  assert.deepEqual(other.args, ["/x/main-index.ts", "--conductor-mcp"]);
});

/* -------------------------------------------------------------------------- */
/* provisionConductor                                                          */
/* -------------------------------------------------------------------------- */

const CP_CONFIG = { controlPlaneUrl: "ws://127.0.0.1:4317/runner", tokenFile: "/secure/active-runner-token" };

function makeSpec(over: Partial<SessionLaunchSpec> = {}): SessionLaunchSpec {
  return {
    sessionId: "s_cond1",
    workspaceId: null,
    workspacePath: "/home/me",
    agentId: "conductor",
    title: "Conductor",
    command: "claude",
    args: [],
    env: {},
    useWorktree: false,
    driver: "claude-code",
    context: { kind: "native" },
    config: {},
    ...over,
  };
}

function makeHost(configDir: string): ConductorHost {
  return {
    isSea: false,
    execPath: "/usr/bin/node",
    execArgv: ["--import", "tsx"],
    scriptPath: "/repo/apps/runner/src/cli.ts",
    configDir,
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "wollipog-conductor-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("provisionConductor writes token-free mcp-config using a protected credential-file reference", () => {
  withTempDir((dir) => {
    const spec = makeSpec();
    provisionConductor(spec, CP_CONFIG, () => {}, makeHost(dir));

    const file = join(dir, "s_cond1.mcp.json");
    assert.ok(existsSync(file), "per-session mcp-config file written");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(parsed, {
      mcpServers: {
        manager: {
          type: "stdio",
          command: "/usr/bin/node",
          args: [
            "--import",
            "tsx",
            "/repo/apps/runner/src/cli.ts",
            "--conductor-mcp",
            "--cp-url",
            "http://127.0.0.1:4317",
            "--self-session-id",
            "s_cond1",
          ],
          env: { MANAGER_TOKEN_FILE: "/secure/active-runner-token" },
        },
      },
    });
  });
});

test("provisionConductor appends the exact argv tail and forces permissionMode 'default'", () => {
  withTempDir((dir) => {
    const spec = makeSpec({ args: ["--pre-existing"], config: { model: "opus", permissionMode: "acceptEdits" } });
    provisionConductor(spec, CP_CONFIG, () => {}, makeHost(dir));

    const file = join(dir, "s_cond1.mcp.json");
    assert.deepEqual(spec.args, [
      "--pre-existing",
      "--mcp-config",
      file,
      "--strict-mcp-config",
      "--allowedTools",
      CONDUCTOR_READ_TOOLS.join(","),
      "--disallowedTools",
      "Bash,BashOutput,KillShell,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch",
      "--append-system-prompt",
      conductorSystemPrompt("s_cond1"),
    ]);
    // The runner-side belt: the CP clamp is the enforcement, this keeps a stale CP honest.
    assert.equal(spec.config!.permissionMode, "default");
    assert.equal(spec.config!.model, "opus", "other config keys are preserved");
  });
});

test("the Conductor prompt uses Wollipog identity while preserving manager tool routing", () => {
  const prompt = conductorSystemPrompt("s_identity");
  assert.match(prompt, /^You are the Conductor for Wollipog\./);
  assert.match(prompt, /mcp__manager__ tools/);
  assert.doesNotMatch(prompt, /ACP Agent Manager/);
});

test("the pre-allowed reads are exactly the curated manager inspection tools", () => {
  assert.deepEqual(CONDUCTOR_READ_TOOLS, [
    "mcp__manager__list_runners",
    "mcp__manager__list_sessions",
    "mcp__manager__get_session",
    "mcp__manager__get_session_events",
    "mcp__manager__list_runs",
    "mcp__manager__list_governance_policies",
    "mcp__manager__get_governance_policy",
    "mcp__manager__list_workflows",
    "mcp__manager__get_workflow",
    "mcp__manager__get_workflow_node",
    "mcp__manager__list_workflow_instances",
    "mcp__manager__get_workflow_instance",
  ]);
  assert.ok(CONDUCTOR_DISALLOWED_TOOLS.includes("Bash"), "the REST side-channel is closed");
});

test("every injected arg passes winQuoteArg (no CR/LF) and carries no % (cmd.exe expansion)", () => {
  withTempDir((dir) => {
    const spec = makeSpec();
    provisionConductor(spec, CP_CONFIG, () => {}, makeHost(dir));
    for (const arg of spec.args) {
      assert.doesNotThrow(() => winQuoteArg(arg), `winQuoteArg must accept: ${arg.slice(0, 40)}`);
      assert.ok(!arg.includes("%"), `no %% in: ${arg.slice(0, 40)}`);
    }
  });
});

test("the system prompt is a single line, carries the self session id, and instructs the guard habits", () => {
  const prompt = conductorSystemPrompt("s_cond1");
  assert.ok(!/[\r\n%]/.test(prompt), "single-line and %-free (winQuoteArg deliverable)");
  assert.ok(prompt.includes("s_cond1"), "self id substituted");
  assert.ok(!prompt.includes("<SELF_ID>"), "placeholder gone");
  assert.match(prompt, /never prompt, stop, or reconfigure it/);
});

test("provisioning keeps argv idempotent and refreshes the credential reference before resume", () => {
  withTempDir((dir) => {
    const spec = makeSpec();
    provisionConductor(spec, CP_CONFIG, () => {}, makeHost(dir));
    const once = [...spec.args];
    provisionConductor(spec, { ...CP_CONFIG, tokenFile: "/secure/rotated-token" }, () => {}, makeHost(dir));
    assert.deepEqual(spec.args, once, "no duplicated flags on double-provision");
    assert.equal(spec.config!.permissionMode, "default");
    const parsed = JSON.parse(readFileSync(join(dir, "s_cond1.mcp.json"), "utf8"));
    assert.deepEqual(parsed.mcpServers.manager.env, { MANAGER_TOKEN_FILE: "/secure/rotated-token" });
    assert.equal(readFileSync(join(dir, "s_cond1.mcp.json"), "utf8").includes("tok-abc"), false);
  });
});

test("re-provision migrates persisted shared mcp-config argv without touching legacy bytes", () => {
  withTempDir((dir) => {
    const logs: string[] = [];
    const spec = makeSpec();
    const legacyDir = join(dir, "legacy-shared");
    mkdirSync(legacyDir);
    const legacy = join(legacyDir, "s_cond1.mcp.json");
    writeFileSync(legacy, "legacy-bytes");
    spec.args = ["--mcp-config", legacy, "--strict-mcp-config"];
    provisionConductor(spec, CP_CONFIG, (m) => logs.push(m), makeHost(dir));
    const file = join(dir, "s_cond1.mcp.json");
    assert.equal(spec.args[1], file);
    assert.ok(existsSync(file), "the owned config is generated before launch");
    assert.equal(readFileSync(legacy, "utf8"), "legacy-bytes");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.mcpServers.manager.env.MANAGER_TOKEN_FILE, "/secure/active-runner-token");
    assert.ok(parsed.mcpServers.manager.args.includes("--self-session-id"));
    assert.ok(logs.some((l) => l.includes("migrated")), "the migration is logged");
  });
});

test("re-provision fails closed when persisted --mcp-config has no path", () => {
  withTempDir((dir) => {
    for (const args of [["--mcp-config"], ["--mcp-config", "--strict-mcp-config"]]) {
      const spec = makeSpec({ args });
      assert.throws(
        () => provisionConductor(spec, CP_CONFIG, () => {}, makeHost(dir)),
        /persisted conductor --mcp-config has no path/,
      );
      assert.equal(existsSync(join(dir, "s_cond1.mcp.json")), false);
    }
  });
});

test("runner credential file is mode 600 and startup sweep removes legacy conductor configs", () => {
  withTempDir((dir) => {
    const credential = writeRunnerCredentialFile(dir, "opaque-runner-token");
    assert.equal(readFileSync(credential, "utf8"), "opaque-runner-token");
    if (process.platform !== "win32") assert.equal(statSync(credential).mode & 0o777, 0o600);

    const configs = join(dir, "conductor");
    mkdirSync(configs);
    writeFileSync(join(dir, "keep.txt"), "keep");
    const first = join(configs, "old.mcp.json");
    const second = join(configs, "new.mcp.json");
    writeFileSync(first, '{"MANAGER_TOKEN":"legacy"}');
    writeFileSync(second, "{}", { mode: 0o600 });
    assert.equal(sweepConductorMcpConfigs(configs), 2);
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), false);
    assert.equal(existsSync(join(dir, "keep.txt")), true);
  });
});

test("pending runner rotation preserves the active conductor token until acknowledged cutover", () => {
  withTempDir((dir) => {
    const active = writeRunnerCredentialFile(dir, "opaque-active-token");
    const retried = stageRunnerCredentialFile(dir, "opaque-retried-token");
    assert.equal(retried.activePath, active);
    assert.equal(readFileSync(active, "utf8"), "opaque-active-token");
    assert.equal(readFileSync(active, "utf8"), "opaque-active-token", "transient rejection must preserve the working token");
    assert.equal(retried.promote(), active, "the same staged token remains promotable after reconnect");
    assert.equal(readFileSync(active, "utf8"), "opaque-retried-token");

    const accepted = stageRunnerCredentialFile(dir, "opaque-accepted-token");
    assert.equal(readFileSync(active, "utf8"), "opaque-retried-token", "staging must not publish a pending token");
    assert.equal(accepted.promote(), active);
    assert.equal(readFileSync(active, "utf8"), "opaque-accepted-token");
    assert.equal(accepted.promote(), active, "the registered acknowledgement may be replayed safely");
  });
});

test("removeConductorMcpConfig deletes the per-session credential-reference file; missing files no-op", () => {
  withTempDir((dir) => {
    const spec = makeSpec();
    provisionConductor(spec, CP_CONFIG, () => {}, makeHost(dir));
    const file = join(dir, "s_cond1.mcp.json");
    assert.ok(existsSync(file));

    removeConductorMcpConfig("s_cond1", dir);
    assert.ok(!existsSync(file), "delete_session must not leave MANAGER_TOKEN litter behind");

    // Non-conductor sessions have no file — the delete path calls this unconditionally.
    assert.doesNotThrow(() => removeConductorMcpConfig("s_never_existed", dir));
  });
});

test("enabled non-conductor and non-claude-code specs are untouched", () => {
  withTempDir((dir) => {
    const worker = makeSpec({ agentId: "claude-code" });
    provisionConductor(worker, CP_CONFIG, () => {}, makeHost(dir));
    assert.deepEqual(worker.args, []);
    assert.deepEqual(worker.config, {});

    const acp = makeSpec({ driver: "acp" });
    provisionConductor(acp, CP_CONFIG, () => {}, makeHost(dir));
    assert.deepEqual(acp.args, []);
    assert.ok(!existsSync(join(dir, "s_cond1.mcp.json")));
  });
});

test("a WSL-context conductor is skipped with a log line (out of scope)", () => {
  withTempDir((dir) => {
    const logs: string[] = [];
    const spec = makeSpec({ context: { kind: "wsl", distro: "Ubuntu" } });
    provisionConductor(spec, CP_CONFIG, (m) => logs.push(m), makeHost(dir));
    assert.deepEqual(spec.args, [], "no flags injected for a WSL conductor");
    assert.ok(!existsSync(join(dir, "s_cond1.mcp.json")));
    assert.ok(logs.some((l) => l.includes("WSL")), "the skip is logged, not silent");
  });
});

/* -------------------------------------------------------------------------- */
/* withConductorAgent                                                          */
/* -------------------------------------------------------------------------- */

function claudeAgent(over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: "claude-code",
    name: "Claude Code",
    command: "/home/u/.local/bin/claude",
    args: [],
    env: {},
    driver: "claude-code",
    context: { kind: "native" },
    version: "2.1.0",
    available: true,
    authStatus: "authenticated",
    capabilities: {
      models: [{ id: "default", default: true }], effortLevels: ["low"], slashCommands: [],
      supportsImages: true, supportsApprovals: true, permissionModes: ["default", "auto", "acceptEdits"],
      elicitation: {
        default: ["stdio-control"],
        auto: ["stdio-control"],
        acceptEdits: ["none"],
      },
    },
    source: "discovered",
    ...over,
  };
}

test("withConductorAgent appends a conductor when an available native claude-code agent exists", () => {
  const out = withConductorAgent([claudeAgent()]);
  assert.equal(out.length, 2);
  const conductor = out.find((a) => a.id === "conductor")!;
  assert.equal(conductor.name, "Conductor (Wollipog)");
  assert.equal(conductor.command, "/home/u/.local/bin/claude", "launch command donated by the claude agent");
  assert.deepEqual(conductor.args, []);
  assert.equal(conductor.driver, "claude-code");
  assert.deepEqual(conductor.context, { kind: "native" });
  assert.equal(conductor.version, "2.1.0");
  assert.equal(conductor.authStatus, "authenticated");
  assert.deepEqual(conductor.capabilities!.permissionModes, ["default"], "the UI never offers another mode");
  assert.deepEqual(conductor.capabilities!.elicitation, { default: ["stdio-control"] });
});

test("withConductorAgent does not widen elicitation when the donor lacks a default-mode entry", () => {
  const donor = claudeAgent({
    capabilities: {
      models: [{ id: "default", default: true }],
      effortLevels: [],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: true,
      permissionModes: ["default", "acceptEdits"],
      elicitation: { acceptEdits: ["none"] },
    },
  });
  const conductor = withConductorAgent([donor]).find((agent) => agent.id === "conductor")!;
  assert.deepEqual(conductor.capabilities!.permissionModes, ["default"]);
  assert.equal(conductor.capabilities!.elicitation, undefined);
});

test("withConductorAgent inherits the donor's base args (node-wrapped nvm installs)", () => {
  // A version-manager claude launches as `node <cli.js>` — dropping the donor's args would
  // synthesize a conductor that spawns bare node and fails every turn.
  const donor = claudeAgent({
    command: "/home/u/.nvm/versions/node/v25.2.1/bin/node",
    args: ["/home/u/.nvm/versions/node/v25.2.1/lib/node_modules/@anthropic-ai/claude-code/cli.js"],
  });
  const conductor = withConductorAgent([donor]).find((a) => a.id === "conductor")!;
  assert.equal(conductor.command, donor.command);
  assert.deepEqual(conductor.args, donor.args, "base args donated too");
  assert.notEqual(conductor.args, donor.args, "copied, not aliased");
});

test("withConductorAgent inherits verified Claude diagnostics and explicit auth env", () => {
  const donor = claudeAgent({
    env: { ANTHROPIC_API_KEY: "configured-key" },
    claudeCode: {
      status: "ready", installedVersion: "2.1.205", effortLevels: ["low"], permissionModes: ["acceptEdits"],
      streamJsonInput: true, streamJsonImages: true, controlProtocol: true, forkSession: true,
      replayUserMessages: true, auth: { status: "authenticated", method: "api_key", provider: "firstParty", billingSource: "api" },
    },
  });
  const conductor = withConductorAgent([donor]).find((a) => a.id === "conductor")!;
  assert.deepEqual(conductor.env, donor.env);
  assert.notEqual(conductor.env, donor.env);
  assert.equal(conductor.claudeCode?.auth.billingSource, "api");
  assert.deepEqual(conductor.capabilities?.effortLevels, ["low"]);
});

test("withConductorAgent does not advertise a conductor without verified stdio approvals", () => {
  const donor = claudeAgent({ capabilities: {
    models: [], effortLevels: [], slashCommands: [], supportsImages: false,
    supportsApprovals: false, permissionModes: ["acceptEdits"],
  } });
  assert.equal(withConductorAgent([donor]).some((agent) => agent.id === "conductor"), false);
});

test("withConductorAgent keeps a config-defined conductor's identity but clamps its advertised modes", () => {
  // A config entry inherits the FULL claude-code catalog capabilities (index.ts maps
  // capabilitiesFor(driver)); without the clamp the mid-session mode dropdown would offer
  // acceptEdits/auto/bypassPermissions — dead options the CP clamp 409s.
  const configured = claudeAgent({
    id: "conductor",
    name: "My Conductor",
    source: "config",
    capabilities: {
      models: [{ id: "default", displayName: "Default", default: true }],
      effortLevels: [],
      slashCommands: [],
      supportsImages: true,
      supportsApprovals: true,
      permissionModes: ["default", "auto", "acceptEdits", "plan", "bypassPermissions"],
      elicitation: {
        default: ["stdio-control"],
        auto: ["stdio-control"],
        acceptEdits: ["none"],
        plan: ["none"],
        bypassPermissions: ["none"],
      },
    },
  });
  const out = withConductorAgent([configured, claudeAgent()]);
  assert.equal(out.filter((a) => a.id === "conductor").length, 1, "no second conductor synthesized");
  const conductor = out.find((a) => a.id === "conductor")!;
  assert.equal(conductor.name, "My Conductor", "config wins on identity");
  assert.deepEqual(conductor.capabilities!.permissionModes, ["default"], "but the UI mode contract still applies");
  assert.deepEqual(conductor.capabilities!.elicitation, { default: ["stdio-control"] });
  assert.equal(conductor.capabilities!.supportsImages, true, "other capabilities preserved");
  assert.equal(conductor.capabilities!.models.length, 1);
});

test("withConductorAgent skips when only a WSL claude exists, or when claude is not available", () => {
  const wslOnly = withConductorAgent([
    claudeAgent({ id: "claude-code-wsl-Ubuntu", context: { kind: "wsl", distro: "Ubuntu" } }),
  ]);
  assert.ok(!wslOnly.some((a) => a.id === "conductor"));

  const unavailable = withConductorAgent([claudeAgent({ available: undefined })]);
  assert.ok(!unavailable.some((a) => a.id === "conductor"));

  assert.ok(!withConductorAgent([]).some((a) => a.id === "conductor"));
});

test("post-merge synthesis: a configured claude entry sharing the launch key does not suppress the conductor", () => {
  // The config entry and the discovered agent share launchKey "claude-code|native|claude", so the
  // merge suppresses the discovered EXTRA — synthesis must therefore run on the merged list, where
  // the enriched config entry (now available) is the donor.
  const configAgent: AgentDefinition = {
    id: "claude-native",
    name: "Claude Code (native)",
    command: "claude",
    args: [],
    env: {},
    driver: "claude-code",
    context: { kind: "native" },
    source: "config",
  };
  const merged = mergeAgents([configAgent], [claudeAgent({ command: "/usr/local/bin/claude" })]);
  assert.equal(merged.length, 1, "precondition: the discovered claude was folded into the config entry");
  const out = withConductorAgent(merged);
  const conductor = out.find((a) => a.id === "conductor");
  assert.ok(conductor, "the conductor is synthesized post-merge");
  // The bare "claude" config command adopts discovery's RESOLVED path in the merge (it's a
  // pointer, not an override), so the donor — and hence the conductor — carries the real path.
  assert.equal(conductor!.command, "/usr/local/bin/claude", "donated by the merged (config) entry");
});

test("conductor advertisement is fenced on a v91+ control plane", () => {
  const donor = claudeAgent();
  // Unknown (pre-registration) and pre-v91 control planes serve web bundles that default the
  // experiment on and cannot distinguish a legacy stored opt-in — synthesis must fail closed.
  assert.equal(applyConductorAdvertisementFence([donor], null).some((a) => a.id === "conductor"), false);
  assert.equal(applyConductorAdvertisementFence([donor], 90).some((a) => a.id === "conductor"), false);
  assert.equal(applyConductorAdvertisementFence([donor], 91).some((a) => a.id === "conductor"), true);
});

test("a config-defined conductor passes the fence untouched: it is explicit operator opt-in", () => {
  const configured = claudeAgent({ id: "conductor", name: "Configured Conductor", source: "config" });
  const fenced = applyConductorAdvertisementFence([configured], 90);
  assert.equal(fenced.some((a) => a.id === "conductor"), true);
});
