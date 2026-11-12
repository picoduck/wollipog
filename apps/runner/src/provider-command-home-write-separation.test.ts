import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { providerCommandHomeWriteSeparationReport, type AgentDefinition, type AgentDriverKind,
  type RunnerToControlPlane, type SessionLaunchSpec } from "@wollipog/protocol";
import { mergeAgents } from "./discovery/discover.js";
import { buildCodexTurnParams } from "./drivers/codex-app-server.js";
import { AcpFilesystemService, AcpTerminalService } from "./acp-client-services.js";
import type { AgentProcess } from "./spawn.js";
import { providerCommandHomeWriteSeparationDiagnostic } from "./provider-command-home-write-separation.js";
import type { Driver } from "./drivers/driver.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";

const agent = (driver: AgentDriverKind): AgentDefinition => ({
  id: driver, name: driver, driver, command: "inert", args: [], env: {}, context: { kind: "native" },
});

test("production catalog merge replaces stale claims while retaining unrelated readiness and installation data", () => {
  for (const driver of ["claude-code", "codex-app-server", "pi", "acp"] as const) {
    const configured = { ...agent(driver), installation: { id: "fixture", path: "/inert", via: "path" as const },
      providerAccountReadiness: { defaultAuthStatus: "authenticated" as const, readyAccountIds: ["account"] },
      providerReadiness: { checkedAt: 123, installation: "compatible" as const, authentication: "unknown" as const, reason: "in_use" as const },
      providerCommandHomeWriteSeparation: { version: 999, status: "protected", reason: "configured" },
    } as unknown as AgentDefinition;
    const projected = mergeAgents([configured], [])[0]!;
    const report = providerCommandHomeWriteSeparationReport(projected.providerCommandHomeWriteSeparation);
    if (process.platform === "linux" || process.platform === "darwin") {
      assert.deepEqual(report, { version: 1, status: "unprotected", reason: driver === "acp"
        ? "incomplete_adapter_coverage" : "unsupported_command_mediation" });
    } else {
      assert.deepEqual(report, { version: 1, status: "unavailable", reason: "unsupported_host" });
    }
    assert.deepEqual(projected.providerAccountReadiness, configured.providerAccountReadiness);
    assert.deepEqual(projected.providerReadiness, configured.providerReadiness);
    assert.deepEqual(projected.installation, configured.installation);
    assert.equal(configured.providerCommandHomeWriteSeparation?.status, "protected", "input was not mutated");
  }
});

test("missing mixed-version reports and unknown future claims remain unknown; WSL is explicitly unavailable", () => {
  const legacy = agent("codex-app-server");
  assert.deepEqual(providerCommandHomeWriteSeparationReport(legacy.providerCommandHomeWriteSeparation),
    { status: "unknown", reason: "report_unavailable" });
  assert.deepEqual(providerCommandHomeWriteSeparationReport({ version: 2, status: "protected" }),
    { status: "unknown", reason: "report_unavailable" });
  const projected = mergeAgents([{ ...legacy, context: { kind: "wsl", distro: "Fixture" } }], [])[0]!;
  assert.deepEqual(projected.providerCommandHomeWriteSeparation,
    { version: 1, status: "unavailable", reason: "unsupported_host" });
});

test("production externalSandbox turn selection does not promote the separate runner write-separation report", () => {
  const turn = buildCodexTurnParams({ permissionMode: "acceptEdits" }, null, "/fixture", [],
    undefined, [], null, false, [], [], { network: "inherit" });
  assert.equal(turn.sandboxPolicy.type, "externalSandbox");
  const projected = mergeAgents([agent("codex-app-server")], [])[0]!;
  assert.notEqual(providerCommandHomeWriteSeparationReport(projected.providerCommandHomeWriteSeparation).status, "protected");
});

test("ACP client terminal spawning does not attest to adapter-wide command coverage", async () => {
  const root = mkdtempSync(join(tmpdir(), "command-home-acp-"));
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new PassThrough(), pid: undefined });
  let spawns = 0;
  const terminals = new AcpTerminalService(new AcpFilesystemService(root, { kind: "native" }), { kind: "native" },
    undefined, { spawn: options => {
      spawns++; assert.equal(options.isolation, undefined);
      return child as unknown as AgentProcess;
    } });
  try {
    await terminals.create({ sessionId: "fixture", command: process.execPath, args: ["--inert"], cwd: root });
    assert.equal(spawns, 1);
    const projected = mergeAgents([agent("acp")], [])[0]!;
    if (process.platform === "linux" || process.platform === "darwin") {
      assert.equal(projected.providerCommandHomeWriteSeparation?.reason, "incomplete_adapter_coverage");
    }
    assert.notEqual(projected.providerCommandHomeWriteSeparation?.status, "protected");
  } finally {
    child.emit("close", 0, null);
    terminals.dispose(); rmSync(root, { recursive: true, force: true });
  }
});

test("real session launch emits truthful separation disclosure without changing provider argv, env or isolation", async () => {
  for (const driver of ["claude-code", "codex-app-server", "pi", "acp"] as const) {
    const root = mkdtempSync(join(tmpdir(), "command-home-disclosure-"));
    const sent: RunnerToControlPlane[] = [];
    const logs: string[] = [];
    let captured: unknown;
    const factory = (_kind: AgentDriverKind, options: unknown): Driver => {
      captured = options;
      return { initialize: async () => {}, newSession: async () => "inert-thread", loadSession: async () => {},
        agentSessionId: () => "inert-thread", setConfig() {}, cancel() {}, dispose() {},
        resolvePermission: () => false, prompt: async () => "end_turn" } as unknown as Driver;
    };
    const store = new SessionStore(join(root, "sessions"));
    const manager = new SessionManager(message => sent.push(message), message => logs.push(message), store, "runner", undefined, factory);
    const spec: SessionLaunchSpec = { sessionId: "fixture", agentId: driver, workspaceId: null,
      workspacePath: root, driver, command: "inert-provider", args: ["--fixture"],
      env: { HOME: root, FIXTURE_VALUE: "synthetic-only" }, context: { kind: "native" }, useWorktree: false };
    try {
      assert.equal(await manager.start(spec), true);
      const diagnostics = logs.filter(text => text.includes("provider_command_home_write_separation"));
      assert.equal(diagnostics.length, 1);
      assert.equal(sent.some(message => message.type === "session_event" && message.payload.kind === "stderr" &&
        message.payload.text.includes("provider_command_home_write_separation")), false,
      "launch disclosure must not change provider history or its accounting replay boundary");
      const report = JSON.parse(diagnostics[0]!);
      assert.notEqual(report.status, "protected");
      assert.equal(report.reason, process.platform === "linux" || process.platform === "darwin"
        ? driver === "acp" ? "incomplete_adapter_coverage" : "unsupported_command_mediation" : "unsupported_host");
      assert.doesNotMatch(diagnostics[0]!, /synthetic-only|inert-provider|fixture|HOME/);
      const options = captured as { command: string; args: string[]; env: Record<string, string>; isolation?: unknown };
      assert.equal(options.command, spec.command);
      assert.deepEqual(options.args, spec.args);
      assert.deepEqual(options.env, {}, "existing preparation has no configured agent env in this fixture");
      assert.equal(options.isolation, undefined, "disclosure does not enable an isolation policy");
    } finally {
      manager.shutdownAll(); rmSync(root, { recursive: true, force: true });
    }
  }
});

test("remote launch diagnostics never reuse the runner host's native assessment", () => {
  for (const adapter of ["container", "cloud"]) {
    const report = JSON.parse(providerCommandHomeWriteSeparationDiagnostic({ ...agent("codex-app-server"),
      executionTarget: { adapter } as never }));
    assert.deepEqual(report, { event: "provider_command_home_write_separation", status: "unknown", reason: "report_unavailable" });
  }
});
