import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type ControlPlaneToRunner,
  type RunnerMetadata,
  type SessionEventPayload,
  type SessionLaunchSpec,
} from "@wollipog/protocol";
import { ControlPlaneDb } from "../../control-plane/src/db.js";
import type { Hub } from "../../control-plane/src/hub.js";
import {
  agentCredentialSessionTargetError,
  orchestratorSelfWorktreeAuthorizationError,
  type AgentPrincipal,
} from "../../control-plane/src/identity.js";
import { SessionsService } from "../../control-plane/src/sessions.js";
import {
  agentControlMcpConfigPath,
  provisionAgentControl,
  type AgentControlHost,
} from "./agent-control.js";
import { effectiveClaudePermissionMode } from "./claude-permission.js";
import { ClaudeCodeDriver, claudePermissionArgs } from "./drivers/claude-code.js";
import type { DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import {
  applyClaudeHookCapability,
  claudeHookSettingsPath,
  provisionClaudeHooks,
  type ClaudeHookHost,
} from "./hook-settings.js";
import { createRequestedWorktree, pathWithin, sameWorktreePath } from "./worktree.js";

/**
 * One non-strict native Claude Orchestrator campaign (ADR 0008 / protocol v160), threaded through
 * the REAL control-plane service, the REAL runner provisioning, and the REAL Claude driver.
 *
 * Every layer consumes the previous layer's own output: the launch spec the service sends to the
 * runner is the object `provisionAgentControl`/`provisionClaudeHooks` mutate, and the driver runs
 * on the argv/env those produced. Three separate fixtures could drift apart; this cannot.
 *
 * No provider process, credentials, or network are involved. The only external tool is `git`,
 * used for the parent's own dedicated worktree.
 */

const RUNNER_ID = "runner-additive";
const WORKSPACE_ID = "ws-additive";
const AGENT_ID = "claude";
/** The user's own MCP server configuration, carried by the catalog agent definition. */
const USER_MCP_CONFIG = "/home/user/servers.mcp.json";

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  models: [],
  effortLevels: [],
  slashCommands: [],
  supportsImages: false,
  supportsApprovals: true,
  supportsSteering: true,
  permissionModes: ["default", "auto", "acceptEdits", "plan", "orchestrator"],
  elicitation: {
    default: ["stdio-control"],
    auto: ["stdio-control"],
    acceptEdits: ["hook"],
    plan: ["hook"],
    orchestrator: ["none"],
  },
};

function runnerMeta(workspacePath: string): RunnerMetadata {
  return {
    runnerId: RUNNER_ID,
    hostname: "host",
    os: "linux",
    version: "1.0.0",
    workspaces: [{ id: WORKSPACE_ID, name: "Demo", path: workspacePath }],
    agents: applyClaudeHookCapability([{
      id: AGENT_ID,
      name: "Claude",
      command: "claude",
      // The user's configured MCP servers and extra directory ride the catalog launch arguments.
      args: ["--mcp-config", USER_MCP_CONFIG, "--add-dir", "/home/user/notes"],
      env: { PROVIDER_SETTING: "kept" },
      driver: "claude-code",
      available: true,
      context: { kind: "native" },
      version: "2.1.0",
      capabilities: CLAUDE_CAPABILITIES,
      claudeCode: {
        status: "ready",
        effortLevels: [],
        permissionModes: CLAUDE_CAPABILITIES.permissionModes!,
        streamJsonInput: true,
        streamJsonImages: true,
        controlProtocol: true,
        forkSession: true,
        replayUserMessages: true,
        auth: { status: "authenticated", billingSource: "subscription" },
      },
    }], true),
  };
}

/** Minimal recording stand-in for the connection Hub: only what this campaign exercises. */
class RecordingHub {
  sent: ControlPlaneToRunner[] = [];

  isRunnerOnline(): boolean { return true; }
  sendToRunner(_runnerId: string, msg: ControlPlaneToRunner): boolean {
    this.sent.push(msg);
    return true;
  }
  async requestFromRunner(): Promise<never> { throw new Error("runner did not respond in time"); }
  async waitForRunnerRequest(): Promise<never> { throw new Error("runner request is no longer in flight"); }
  resolveRunnerRequest(): boolean { return false; }
  activeTurnIdForSession(): string | undefined { return undefined; }
  queuedPromptForSession(): undefined { return undefined; }
  setSessionQueue(): void {}
  sessionChanged(): void {}
  sessionChangedById(): void {}
  sessionReminderChanged(): void {}
  sessionReminderRemoved(): void {}
  sessionEvent(): void {}
  sessionEventsReset(): void {}
  sessionRemoved(): void {}
  runChanged(): void {}
  podChanged(): void {}
  podContextEntry(): void {}
  projectChanged(): void {}
  projectChangedById(): void {}
  runnerChanged(): void {}

  sentOfType<T extends ControlPlaneToRunner["type"]>(type: T): Extract<ControlPlaneToRunner, { type: T }>[] {
    return this.sent.filter((msg): msg is Extract<ControlPlaneToRunner, { type: T }> => msg.type === type);
  }
}

function launchSpecFor(hub: RecordingHub, sessionId: string): SessionLaunchSpec {
  const spec = hub.sentOfType("start_session").find((msg) => msg.spec.sessionId === sessionId)?.spec;
  assert.ok(spec, "the control plane sent a launch spec for this session");
  return spec;
}

function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

interface DriverHarness {
  driver: ClaudeCodeDriver;
  events: SessionEventPayload[];
  writes: unknown[];
  feed: (msg: unknown) => unknown;
  baseArgs: () => string[];
}

function driverFor(spec: SessionLaunchSpec, cwd: string): DriverHarness {
  const events: SessionEventPayload[] = [];
  const writes: unknown[] = [];
  const cb: DriverCallbacks = {
    onEvent: (payload) => events.push(payload),
    onStderr: () => {},
    onModelResolved: () => {},
    onExit: () => {},
  };
  const opts: DriverOptions = {
    command: spec.command,
    args: [...spec.args],
    cwd,
    env: { ...spec.env },
    config: spec.config ?? {},
    context: spec.context ?? { kind: "native" },
    ...(spec.capabilities ? { capabilities: spec.capabilities } : {}),
    ...(spec.orchestrator ? { orchestrator: spec.orchestrator } : {}),
  };
  const driver = new ClaudeCodeDriver(opts, cb);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (driver as any).child = { stdin: { write: (value: string) => writes.push(JSON.parse(value)) } };
  return {
    driver,
    events,
    writes,
    feed: (msg: unknown) => (driver as any).handleEvent(msg),
    baseArgs: () => (driver as any).preparedBaseArgs() as string[],
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function gitInit(repo: string): void {
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"]);
}

test("a non-strict Claude Orchestrator campaign runs end to end as an additive role", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-additive-campaign-"));
  const repo = join(root, "repo");
  const runnerData = join(root, "runner-data");
  const configDir = join(root, "agent-control");
  const hookDir = join(root, "hooks");
  const db = ControlPlaneDb.open(":memory:");
  try {
    gitInit(repo);
    const hub = new RecordingHub();
    db.registerRunner(runnerMeta(repo), Date.now(), PROTOCOL_VERSION);
    const svc = new SessionsService(db, hub as unknown as Hub, { info() {}, warn() {}, error() {} });

    // ---------------------------------------------------------------- 1. creation (control plane)
    // A human creates an Orchestrator that keeps an ordinary provider permission mode.
    const request = { runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID };
    const created = svc.createSession(
      { ...request, role: "orchestrator", config: { permissionMode: "acceptEdits" } },
      undefined, undefined, false, false, false, { defaultOwnerUserId: "human" },
    );
    assert.ok(created.ok && created.data, created.error);
    const parent = created.data;
    assert.equal(parent.role, "orchestrator");
    assert.equal(parent.permissionMode, "acceptEdits", "the role never consumes the permission-mode selection");
    assert.equal(parent.parentControl, "questions_and_approvals", "a human creation context defaults Parent Control on");

    // ------------------------------------------------- 2. the exact launch spec sent to the runner
    const spec = launchSpecFor(hub, parent.id);
    assert.equal(spec.config?.permissionMode, "acceptEdits", "the launch carries the selected permission mode");
    assert.deepEqual(spec.orchestrator, { strictProjectIsolation: false }, "the launch policy carries the role");
    assert.ok(spec.args.includes(USER_MCP_CONFIG), "the launch carries the user's configured MCP servers");

    // ------------------------------------------------------- 3. real runner launch provisioning
    const controlHost: AgentControlHost = {
      isSea: true, execPath: "/opt/runner", execArgv: [], configDir, platform: "linux",
    };
    const hookHost: ClaudeHookHost = {
      isSea: false, execPath: "/usr/bin/node", execArgv: ["--import", "tsx"],
      scriptPath: "/repo/apps/runner/src/index.ts", configDir: hookDir,
    };
    const controlPlaneUrl = "ws://127.0.0.1:4317/runner";
    provisionAgentControl(spec, {
      controlPlaneUrl,
      controlPlaneProtocolVersion: PROTOCOL_VERSION,
      executionIsolationMode: "provider",
      orchestratorProjectPaths: [repo],
    }, () => {}, controlHost);
    provisionClaudeHooks(spec, {
      controlPlaneUrl, controlPlaneProtocolVersion: PROTOCOL_VERSION, enabled: true,
    }, () => {}, hookHost);

    // The additive role is visible: campaign tools, instructions, a scoped credential — nothing else.
    assert.equal(spec.env.WOLLIPOG_PERMISSION_PRESET, "orchestrator",
      "the campaign tool surface is marked on the launch environment");
    const wollipogMcp = agentControlMcpConfigPath(configDir, spec.sessionId);
    assert.ok(spec.args.includes(wollipogMcp), "Wollipog's MCP config sits beside the user's own");
    assert.equal(
      JSON.parse(readFileSync(wollipogMcp, "utf8")).mcpServers.wollipog.env.WOLLIPOG_PERMISSION_PRESET,
      "orchestrator",
      "the general Agent Control MCP server exposes the campaign tools",
    );
    assert.ok(spec.args.includes(USER_MCP_CONFIG), "the user's configured MCP servers survive provisioning");
    assert.deepEqual(valuesOf(spec.args, "--allowedTools"), ["mcp__wollipog__*"],
      "only Wollipog's own tools are pre-authorized");
    const instructions = spec.args[spec.args.indexOf("--append-system-prompt") + 1]!;
    assert.match(instructions, /^You are running with the Wollipog Orchestrator role/);
    assert.match(instructions, /Strict Project Isolation is disabled/);
    assert.ok(valuesOf(spec.args, "--add-dir").includes("/home/user/notes"), "the user's own --add-dir survives");
    assert.ok(valuesOf(spec.args, "--add-dir").includes(repo), "Project Locations are readable");
    // Nothing the coupled preset injects may appear.
    for (const flag of ["--strict-mcp-config", "--tools", "--disallowedTools", "--permission-mode",
      "--setting-sources", "--disable-slash-commands"]) {
      assert.equal(hasFlag(spec.args, flag), false, `${flag} is never injected for the additive role`);
    }
    // Manager hooks provision exactly as for any ordinary Claude session (the preset removes them).
    const hookSettings = claudeHookSettingsPath(hookDir, spec.sessionId);
    assert.ok(existsSync(hookSettings), "manager hooks are provisioned, as for a normal session");
    assert.deepEqual(valuesOf(spec.args, "--settings"), [hookSettings],
      "the only injected --settings is the managed hook file, never a hook-disabling literal");
    assert.deepEqual(spec.capabilities?.elicitation?.acceptEdits, ["hook"],
      "the selected mode keeps its managed hook elicitation transport");

    // ------------------------------------------- 4. the Claude argv the driver would actually run
    const parentDriverCwd = repo;
    const argvHarness = driverFor(spec, parentDriverCwd);
    const mode = effectiveClaudePermissionMode(spec.config ?? {}, false);
    assert.equal(mode, "acceptEdits", "the driver resolves the user's selected mode, not the preset's default");
    const argv = [...argvHarness.baseArgs(), ...claudePermissionArgs(mode, true).args];
    assert.deepEqual(valuesOf(argv, "--permission-mode"), ["acceptEdits"],
      "the provider runs under the selected permission mode");
    assert.ok(argv.includes(USER_MCP_CONFIG), "the user's MCP servers reach the provider argv");
    assert.ok(argv.includes(wollipogMcp) && argv.includes(hookSettings));
    assert.equal(argv.includes("--strict-mcp-config"), false);

    // ------------------------------------------------ 5. the child raises an eligible question
    db.updateSessionStatus(parent.id, "running", Date.now());
    let childResult = svc.createSession(
      { ...request, title: "Child" }, undefined, undefined, false, false, false, { parentSessionId: parent.id },
    );
    if (childResult.status === 428) {
      const spawnApproval = db.getSession(parent.id)!.pendingApproval!;
      assert.ok(svc.approve(parent.id, spawnApproval.requestId, "allow").ok);
      childResult = svc.createSession(
        { ...request, title: "Child" }, undefined, undefined, false, false, false, { parentSessionId: parent.id },
      );
    }
    assert.ok(childResult.ok && childResult.data, childResult.error);
    const child = childResult.data;
    db.updateSessionStatus(child.id, "running", Date.now());
    svc.onSessionEvent(child.id, {
      kind: "question_request",
      requestId: "child-question",
      occurrenceId: "request_child_question",
      questions: [{ id: "q", header: "Next", question: "Which branch should I base on?",
        options: [{ label: "main" }, { label: "release" }] }],
    });

    // Ownership resolves through the persisted role, not the preset literal.
    assert.deepEqual(db.getSession(child.id)?.pendingRequestOwners, {
      human: 0,
      orchestrator: 1,
      requests: [{ requestId: "child-question", occurrenceId: "request_child_question", owner: "orchestrator" }],
    }, "the child's question is owned by the Orchestrator");
    const listed = svc.descendantRequests(parent.id, () => true);
    assert.ok(listed.ok && listed.data, listed.error);
    assert.deepEqual(listed.data.requests.map((req) => ({ sessionId: req.sessionId, owner: req.responseOwner })),
      [{ sessionId: child.id, owner: "orchestrator" }]);

    const answered = svc.resolveDescendantRequest(parent.id, child.id, "request_child_question", {
      action: "answer", answers: { q: "main" },
    }, () => true);
    assert.ok(answered.ok, answered.error);
    assert.deepEqual(hub.sentOfType("answer_question").at(-1), {
      type: "answer_question", sessionId: child.id, requestId: "child-question",
      answers: { q: "main" }, action: "submit", resolvedByParentSessionId: parent.id,
    }, "the Orchestrator resolved the child's question");
    assert.ok(svc.governanceAudit(child.id).some((entry) =>
      entry.stage === "resolution" && entry.actor.kind === "agent" && entry.actor.id === parent.id),
    "the governance audit records the parent as the resolving agent");

    // --------------------------- 6. explicitly requested parent implementation in its own worktree
    const principal: AgentPrincipal = {
      kind: "agent",
      actorId: `agent:${parent.id}`,
      credentialSessionId: parent.id,
      orchestrator: true,
      organizationId: db.localIdentityContext().organizationId,
      delegatedScope: db.sessionScope(parent.id)!,
    };
    const persisted = db.getSession(parent.id)!;
    assert.equal(persisted.orchestratorPolicy?.execution.strictProjectIsolation, false);
    assert.equal(agentCredentialSessionTargetError("/api/sessions/:id/worktrees", principal, parent.id), null,
      "the Orchestrator's own credential may manage its own worktrees");
    assert.equal(orchestratorSelfWorktreeAuthorizationError(
      principal, parent.id, persisted.orchestratorPolicy?.execution.strictProjectIsolation !== false,
    ), null, "a non-strict Orchestrator is authorized to create a worktree for itself");

    const parentWorktree = await createRequestedWorktree(repo, parent.id, {
      baseRef: "HEAD", branch: `agent/${parent.id}-implementation`,
    }, { dataDir: runnerData });
    const childWorktree = await createRequestedWorktree(repo, child.id, {
      baseRef: "HEAD", branch: `agent/${child.id}-work`,
    }, { dataDir: runnerData });
    const native = { kind: "native" as const };
    assert.equal(parentWorktree.created, true);
    assert.equal(sameWorktreePath(native, parentWorktree.path, childWorktree.path), false,
      "the parent implements in a worktree of its own");
    assert.equal(pathWithin(native, parentWorktree.path, childWorktree.path), false);
    assert.equal(pathWithin(native, childWorktree.path, parentWorktree.path), false);
    assert.equal(pathWithin(native, parentWorktree.path, repo), false,
      "the dedicated worktree never overlaps the primary checkout");
    assert.equal(
      execFileSync("git", ["-C", parentWorktree.path, "branch", "--show-current"], { encoding: "utf8" }).trim(),
      `agent/${parent.id}-implementation`,
    );

    // The edit itself behaves exactly as for a normal acceptEdits session.
    const h = driverFor(spec, parentWorktree.path);
    h.feed({
      type: "control_request",
      request_id: "coordination",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "gh pr view 1296" } },
    });
    assert.equal(h.events.length, 0, "routine coordination never becomes an approval card");
    assert.deepEqual((h.writes[0] as { response: { response: { behavior: string } } }).response.response.behavior,
      "allow", "the classifier auto-allows routine coordination");
    h.feed({
      type: "control_request",
      request_id: "implementation-edit",
      request: { subtype: "can_use_tool", tool_name: "Edit", description: "notes.md",
        input: { file_path: join(parentWorktree.path, "notes.md"), old_string: "a", new_string: "b" } },
    });
    assert.equal(h.writes.length, 1, "the edit is neither auto-allowed nor auto-denied");
    assert.equal(h.events.at(-1)?.kind, "permission_request",
      "an edit uses the ordinary provider approval path, with no Orchestrator-specific card");
    const card = h.events.at(-1)!;
    assert.equal(card.kind === "permission_request" ? card.title : null, "Edit: notes.md");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
