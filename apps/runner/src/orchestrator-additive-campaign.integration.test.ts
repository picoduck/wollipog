import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { execFileSync } from "@wollipog/test-support/bounded-child-process";
import {
  PROTOCOL_VERSION,
  sessionRole,
  type AgentCapabilities,
  type ControlPlaneToRunner,
  type RunnerMetadata,
  type RunnerToControlPlane,
  type SessionEventPayload,
  type SessionLaunchSpec,
  type SessionWorktreeResultMessage,
} from "@wollipog/protocol";
import {
  hashToken,
  isAgentControlApiRouteAllowed,
  isAuthenticatedAgentControlClaim,
} from "../../control-plane/src/auth.js";
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
  agentControlReadyPath,
  agentControlTokenPath,
  markAgentControlCredentialReady,
  markAgentControlCredentialRejected,
  provisionAgentControl,
  type AgentControlHost,
} from "./agent-control.js";
import { ClaudeCodeDriver } from "./drivers/claude-code.js";
import type { DriverCallbacks, DriverOptions } from "./drivers/driver.js";
import {
  applyClaudeHookCapability,
  claudeHookSettingsPath,
  provisionClaudeHooks,
  type ClaudeHookHost,
} from "./hook-settings.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session-store.js";
import { pathWithin, sameWorktreePath } from "./worktree.js";

/**
 * One non-strict native Claude Orchestrator campaign (ADR 0008 / protocol v160), threaded through
 * the REAL control-plane service, the REAL runner `SessionManager` (with the REAL launch
 * provisioning wired to `prepareLaunch`, exactly as `apps/runner/src/index.ts` does), and the REAL
 * `ClaudeCodeDriver` whose only stub is the spawned provider process.
 *
 * Every layer consumes the previous layer's own output: the `start_session` message the service
 * sends is delivered to `SessionManager.start`, the driver options are the ones SessionManager
 * built from the persisted meta, the child's question is the event the runner emitted, and the
 * answer is the frame the control plane produced. Separate fixtures could drift apart; this cannot.
 *
 * No provider process, credentials, or network are involved. The only external tool is `git`.
 *
 * Permission mode: the scenario selects `auto`, a normal (non-preset) mode whose approval cards are
 * the CLI's own escalations. Since #1305 a structured Orchestrator also carries the
 * `--permission-prompt-tool stdio` channel under a fixed rule, but there the runner answers every
 * request itself (routine coordination allowed, everything else refused as the mode would), so no
 * approval card — the thing this scenario threads end to end — would arise. The per-mode parity of
 * the routine contract is covered directly in `drivers/claude-code.test.ts`.
 */

const RUNNER_ID = "runner-additive";
const WORKSPACE_ID = "ws-additive";
const AGENT_ID = "claude";
/** The user's own MCP server configuration and settings (their hooks), from the agent catalog. */
const USER_MCP_CONFIG = "/home/user/servers.mcp.json";
const USER_SETTINGS = "/home/user/settings.json";
const CONTROL_PLANE_URL = "ws://127.0.0.1:4317/runner";

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  models: [],
  effortLevels: [],
  slashCommands: [],
  supportsImages: false,
  supportsApprovals: true,
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
      // The user's configured MCP servers, settings (their hooks), and extra directory ride the
      // catalog launch arguments, exactly as an operator-configured agent would carry them.
      args: ["--mcp-config", USER_MCP_CONFIG, "--settings", USER_SETTINGS, "--add-dir", "/home/user/notes"],
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

/**
 * Recording stand-in for the connection Hub. `requestFromRunner` dispatches the one runner request
 * this scenario uses into the real SessionManager, mirroring the `session_worktree` case of the
 * runner message switch in `apps/runner/src/index.ts`.
 */
class RecordingHub {
  sent: ControlPlaneToRunner[] = [];
  manager?: SessionManager;

  isRunnerOnline(): boolean { return true; }
  sendToRunner(_runnerId: string, msg: ControlPlaneToRunner): boolean {
    this.sent.push(msg);
    return true;
  }

  async requestFromRunner(
    _runnerId: string,
    _requestId: string,
    msg: ControlPlaneToRunner,
  ): Promise<SessionWorktreeResultMessage> {
    this.sent.push(msg);
    if (msg.type !== "session_worktree" || msg.operation !== "create") {
      throw new Error(`unexpected runner request ${msg.type}`);
    }
    // The runner message switch calls exactly this SessionManager method for a create operation.
    const result = await this.manager!.requestWorktree(msg.sessionId, {
      branch: msg.branch,
      ...(msg.baseRef ? { baseRef: msg.baseRef } : {}),
    });
    return {
      type: "session_worktree_result",
      requestId: msg.requestId,
      sessionId: msg.sessionId,
      operation: "create",
      ok: true,
      snapshot: result.snapshot,
      worktree: result.worktree,
    };
  }

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

/** Stand-in for the spawned `claude` process: real streams, no real binary. */
interface FakeProvider extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
}

interface ProviderLaunch {
  sessionId: string;
  opts: DriverOptions;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  child: FakeProvider;
  /** Every control frame the driver wrote back to the provider. */
  writes: Record<string, unknown>[];
}

function fakeProvider(writes: Record<string, unknown>[]): FakeProvider {
  const child = new EventEmitter() as FakeProvider;
  child.pid = 4321;
  child.stdin = new PassThrough();
  child.stdin.setEncoding("utf8");
  let buffered = "";
  child.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) writes.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

interface ControlResponseFrame {
  type: string;
  response: { request_id: string; response: { behavior?: string; updatedInput?: { answers?: unknown } } };
}

/** Only the control-protocol replies; the same stdin also carries stream-json user messages. */
function controlResponses(launch: ProviderLaunch): ControlResponseFrame[] {
  return launch.writes.filter((frame) => frame.type === "control_response") as unknown as ControlResponseFrame[];
}

function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => (arg === flag ? [args[index + 1]!] : []));
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000 && !predicate(); attempt++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(predicate(), true, message);
}

/** No developer signing, hook, or template configuration may run in this fixture. */
const HERMETIC_GIT = ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "init.templateDir="];

function git(args: string[]): string {
  return execFileSync("git", [...HERMETIC_GIT, ...args], { encoding: "utf8" });
}

test("a non-strict Claude Orchestrator campaign runs end to end as an additive role", async () => {
  const root = mkdtempSync(join(tmpdir(), "wollipog-additive-campaign-"));
  const repo = join(root, "repo");
  const runnerData = join(root, "runner-data");
  const sessionsRoot = join(root, "sessions");
  const configDir = join(root, "agent-control");
  const hookDir = join(root, "hooks");
  const db = ControlPlaneDb.open(":memory:");
  const priorGitConfig = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };
  // Also applies to the product git calls the runner makes below: ambient user/system config
  // (signing, hooks, templates) must not participate in this scenario.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_SYSTEM = "/dev/null";
  let manager: SessionManager | undefined;
  try {
    git(["init", "-q", "-b", "main", repo]);
    git(["-C", repo, "config", "user.email", "test@example.com"]);
    git(["-C", repo, "config", "user.name", "Test"]);
    git(["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"]);

    // ------------------------------------------------------------------ the runner side, for real
    const runnerSent: RunnerToControlPlane[] = [];
    const launches: ProviderLaunch[] = [];
    const store = new SessionStore(sessionsRoot);
    const controlHost: AgentControlHost = {
      isSea: true, execPath: "/opt/runner", execArgv: [], configDir, platform: "linux",
    };
    const hookHost: ClaudeHookHost = {
      isSea: false, execPath: "/usr/bin/node", execArgv: ["--import", "tsx"],
      scriptPath: "/repo/apps/runner/src/index.ts", configDir: hookDir,
    };
    const driverFactory = (_kind: unknown, opts: DriverOptions, cb: DriverCallbacks) => {
      const writes: Record<string, unknown>[] = [];
      const child = fakeProvider(writes);
      return new ClaudeCodeDriver(opts, cb, {
        spawn: ((options: { args: string[]; env: Record<string, string>; cwd: string }) => {
          launches.push({
            sessionId: opts.env.WOLLIPOG_SESSION_ID ?? "unknown",
            opts, argv: options.args, env: options.env, cwd: options.cwd, child, writes,
          });
          return child;
        }) as never,
        kill: () => {},
      });
    };
    // The runner's outbound messages travel back into the control plane exactly as the /runner
    // socket handler in apps/control-plane/src/index.ts routes them.
    let svc: SessionsService | undefined;
    const credentialAcks: { sessionId: string; tokenHash: string; accepted: boolean }[] = [];
    const relay = (message: RunnerToControlPlane): void => {
      runnerSent.push(message);
      if (!svc) return;
      if (message.type === "session_status") {
        svc.onSessionStatus(message.sessionId, message.status, message.detail, message.worktreePath,
          RUNNER_ID, message.controlPlaneLaunchId, message.capacityWait);
      } else if (message.type === "session_event") {
        svc.onSessionEvent(message.sessionId, message.payload, message.seq, message.ts, RUNNER_ID);
      } else if (message.type === "session_runtime_updated") {
        svc.applySessionRuntimeUpdate(RUNNER_ID, message.snapshot);
      } else if (message.type === "agent_control_credential") {
        // Control plane /runner socket handler, apps/control-plane/src/index.ts:1191-1200: bind the
        // hash to the exact session row and answer with the acknowledgement.
        const accepted = db.setAgentControlCredential(message.sessionId, RUNNER_ID, message.tokenHash, Date.now());
        credentialAcks.push({ sessionId: message.sessionId, tokenHash: message.tokenHash, accepted });
        // Runner message switch, apps/runner/src/index.ts:1441-1455: an accepted acknowledgement
        // publishes the ready file; a rejected one retires the credential.
        if (accepted) markAgentControlCredentialReady(configDir, message.sessionId, message.tokenHash);
        else markAgentControlCredentialRejected(configDir, message.sessionId);
      }
    };
    manager = new SessionManager(
      relay,
      () => {},
      store,
      RUNNER_ID,
      undefined,
      driverFactory as never,
      runnerData,
      4,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      // prepareLaunch: the same two provisioning calls index.ts wires, on the persisted meta.
      async (meta) => {
        provisionClaudeHooks(meta, {
          controlPlaneUrl: CONTROL_PLANE_URL, controlPlaneProtocolVersion: PROTOCOL_VERSION, enabled: true,
          // index.ts passes exactly this: the live runner-owned worktree set, which provisions the
          // managed-worktree guard hook for the launch.
          managedWorktreeProtections: manager!.managedWorktreeProtections(meta),
        }, () => {}, hookHost);
        await provisionAgentControl(meta, {
          controlPlaneUrl: CONTROL_PLANE_URL,
          controlPlaneProtocolVersion: PROTOCOL_VERSION,
          executionIsolationMode: "provider",
          orchestratorProjectPaths: [repo],
          // apps/runner/src/index.ts:618 passes `registerAgentControlCredential`, which is the
          // `agent_control_credential` message of apps/runner/src/index.ts:523-524.
          registerCredential: (sessionId, tokenHash) =>
            relay({ type: "agent_control_credential", sessionId, tokenHash }),
        }, () => {}, controlHost);
      },
    );

    const hub = new RecordingHub();
    hub.manager = manager;
    db.registerRunner(runnerMeta(repo), Date.now(), PROTOCOL_VERSION);
    svc = new SessionsService(db, hub as unknown as Hub, { info() {}, warn() {}, error() {} });
    const service = svc;

    /**
     * `authedApiPrincipal`/`authedAgentControl` are module-private closures in
     * apps/control-plane/src/index.ts (importing that module boots Fastify), so this reproduces
     * their derivation (index.ts:466-528) with the real exported helpers and the real DB: the
     * bearer is hashed and checked against the session's binding, the claim is authenticated, the
     * exact route is checked against the credential session's role, and the role — never the
     * permission-mode literal — decides `orchestrator`.
     */
    const agentControlPrincipal = (
      sessionId: string,
      bearer: string,
      method: string,
      routePath: string,
    ): AgentPrincipal | null => {
      const session = db.getSession(sessionId);
      const authenticated = isAuthenticatedAgentControlClaim({
        credentialValid: Boolean(session &&
          db.agentControlCredentialValid(session.id, session.runnerId, hashToken(bearer))),
        claimedSessionId: sessionId,
        session,
      });
      if (!authenticated || !session) return null;
      if (!isAgentControlApiRouteAllowed(method, routePath, sessionRole(session))) return null;
      const delegatedScope = db.sessionScope(session.id);
      if (!delegatedScope) return null;
      return {
        kind: "agent",
        actorId: session.id,
        credentialSessionId: session.id,
        ...(sessionRole(session) === "orchestrator" ? { orchestrator: true } : {}),
        organizationId: delegatedScope.organizationId,
        delegatedScope,
      };
    };
    const scopedToken = (sessionId: string): string =>
      readFileSync(agentControlTokenPath(configDir, sessionId), "utf8").trim();

    /** Deliver a control-plane launch the way the runner's `start_session` case does. */
    const deliver = async (sessionId: string, prompt: string): Promise<ProviderLaunch> => {
      const message = hub.sentOfType("start_session").filter((msg) => msg.spec.sessionId === sessionId).at(-1);
      assert.ok(message, `the control plane sent a launch for ${sessionId}`);
      const spec: SessionLaunchSpec = structuredClone(message.spec);
      provisionClaudeHooks(spec, {
        controlPlaneUrl: CONTROL_PLANE_URL, controlPlaneProtocolVersion: PROTOCOL_VERSION, enabled: true,
      }, () => {}, hookHost);
      const before = launches.length;
      assert.equal(await manager!.start(spec, prompt), true, `the runner launched ${sessionId}`);
      await waitFor(() => launches.length > before, `the provider process started for ${sessionId}`);
      const launch = launches.at(-1)!;
      assert.equal(launch.sessionId, sessionId, "the launch carries this session's scoped credential");
      // Every real `claude` process opens its stream with system/init; the runner needs it to
      // record the resumable provider conversation.
      const providerSessionId = valuesOf(launch.argv, "--session-id")[0] ?? valuesOf(launch.argv, "--resume")[0]!;
      launch.child.stdout.write(JSON.stringify({
        type: "system", subtype: "init", session_id: providerSessionId, model: "claude-test",
      }) + "\n");
      await new Promise<void>((resolve) => setImmediate(resolve));
      return launch;
    };
    /** Settle the open provider turn so a later launch is not racing a live one. */
    const settleTurn = async (launch: ProviderLaunch): Promise<void> => {
      launch.child.stdout.write(JSON.stringify({ type: "result", subtype: "success" }) + "\n");
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const eventsFor = (sessionId: string): SessionEventPayload[] => runnerSent.flatMap((message) =>
      message.type === "session_event" && message.sessionId === sessionId ? [message.payload] : []);

    // ---------------------------------------------------------------- 1. creation (control plane)
    const request = { runnerId: RUNNER_ID, workspaceId: WORKSPACE_ID, agentId: AGENT_ID };
    const created = service.createSession(
      { ...request, role: "orchestrator", config: { permissionMode: "auto" } },
      undefined, undefined, false, false, false, { defaultOwnerUserId: "human" },
    );
    assert.ok(created.ok && created.data, created.error ?? "session creation failed");
    const parent = created.data;
    assert.equal(parent.role, "orchestrator");
    assert.equal(parent.permissionMode, "auto", "the role never consumes the permission-mode selection");
    assert.equal(parent.parentControl, "questions_and_approvals", "a human creation context defaults Parent Control on");

    const startMessage = hub.sentOfType("start_session").find((msg) => msg.spec.sessionId === parent.id);
    assert.ok(startMessage, "the control plane sent a launch spec");
    assert.equal(startMessage.spec.config?.permissionMode, "auto", "the launch carries the selected permission mode");
    assert.deepEqual(startMessage.spec.orchestrator, { strictProjectIsolation: false, integrationIsolation: false },
      "the launch policy carries the role to the runner");
    assert.ok(startMessage.spec.args.includes(USER_MCP_CONFIG), "the launch carries the user's configured MCP servers");

    // ------------------------------------------- 2. the runner launch, through the real pipeline
    const first = await deliver(parent.id, "plan the campaign");
    assert.deepEqual(first.opts.orchestrator, { strictProjectIsolation: false, integrationIsolation: false },
      "SessionManager hands the driver the launch policy that carries the role");
    assert.equal(first.opts.config.permissionMode, "auto",
      "the driver runs under the selected provider permission mode");
    assert.equal(first.cwd, repo, "the first launch runs in the workspace, with no scratch directory");

    // The additive role is visible in the real argv: campaign tools, instructions, scoped
    // credential — and nothing the coupled preset injects.
    assert.equal(first.env.WOLLIPOG_PERMISSION_PRESET, "orchestrator",
      "the campaign tool surface is marked on the provider environment");
    const wollipogMcp = agentControlMcpConfigPath(configDir, parent.id);
    assert.equal(
      JSON.parse(readFileSync(wollipogMcp, "utf8")).mcpServers.wollipog.env.WOLLIPOG_PERMISSION_PRESET,
      "orchestrator",
      "the general Agent Control MCP server exposes the campaign tools",
    );
    assert.deepEqual(valuesOf(first.argv, "--mcp-config"), [USER_MCP_CONFIG, wollipogMcp],
      "Wollipog's MCP config sits beside the user's own, which survives untouched");
    assert.deepEqual(valuesOf(first.argv, "--settings"), [USER_SETTINGS],
      "the user's own settings (their hooks) survive, and no hook-disabling settings are injected");
    assert.deepEqual(valuesOf(first.argv, "--allowedTools"), ["mcp__wollipog__*"],
      "only Wollipog's own tools are pre-authorized");
    const instructions = first.argv[first.argv.indexOf("--append-system-prompt") + 1]!;
    assert.match(instructions, /^You are running with the Wollipog Orchestrator role/);
    assert.match(instructions, /Strict Project Isolation is disabled/);
    assert.deepEqual(valuesOf(first.argv, "--add-dir"), ["/home/user/notes", repo],
      "the user's own --add-dir survives and Project Locations are readable");
    for (const flag of ["--strict-mcp-config", "--tools", "--disallowedTools",
      "--setting-sources", "--disable-slash-commands"]) {
      assert.equal(hasFlag(first.argv, flag), false, `${flag} is never injected for the additive role`);
    }
    // The selected mode reaches the provider AND keeps the stdio control channel, which is what
    // makes the tool-approval frames below reachable for this launch at all.
    assert.deepEqual(valuesOf(first.argv, "--permission-mode"), ["auto"]);
    assert.deepEqual(valuesOf(first.argv, "--permission-prompt-tool"), ["stdio"]);

    // --------------------------------- 2b. the scoped Agent Control credential, round-tripped
    assert.deepEqual(credentialAcks.filter((ack) => ack.sessionId === parent.id).map((ack) => ack.accepted),
      [true], "the runner registered the minted credential and the control plane accepted the binding");
    const parentToken = scopedToken(parent.id);
    const parentHash = hashToken(parentToken);
    assert.equal(credentialAcks.find((ack) => ack.sessionId === parent.id)?.tokenHash, parentHash,
      "the registered hash is the hash of this session's minted token");
    assert.equal(first.env.WOLLIPOG_SESSION_TOKEN_FILE, agentControlTokenPath(configDir, parent.id),
      "the provider is pointed at this session's own credential file");
    assert.equal(readFileSync(agentControlReadyPath(configDir, parent.id), "utf8"), parentHash,
      "the acknowledgement published the matching ready-file hash");
    assert.equal(db.agentControlCredentialValid(parent.id, RUNNER_ID, parentHash), true,
      "the control plane accepts the exact minted token for this session");
    assert.equal(db.agentControlCredentialValid(parent.id, RUNNER_ID, hashToken(`${parentToken}x`)), false,
      "a wrong token is refused");
    assert.equal(isAuthenticatedAgentControlClaim({
      credentialValid: db.agentControlCredentialValid(parent.id, RUNNER_ID, parentHash),
      claimedSessionId: parent.id,
      session: db.getSession(parent.id),
    }), true, "the running session's claim authenticates");
    assert.equal(isAuthenticatedAgentControlClaim({
      credentialValid: db.agentControlCredentialValid(parent.id, RUNNER_ID, hashToken(`${parentToken}x`)),
      claimedSessionId: parent.id,
      session: db.getSession(parent.id),
    }), false, "a wrong token never authenticates a claim");
    // The additive role decides the route surface, even though the permission mode is `auto`.
    assert.equal(db.getSession(parent.id)?.permissionMode, "auto");
    const campaignRoute = "/api/sessions/:id/orchestrator-campaign";
    const parentPrincipal = agentControlPrincipal(parent.id, parentToken, "GET", campaignRoute);
    assert.equal(parentPrincipal?.orchestrator, true,
      "the Orchestrator role is derived from the session role, not the preset literal");
    assert.ok(agentControlPrincipal(parent.id, parentToken, "POST", "/api/sessions"),
      "an Orchestrator may create child sessions with its scoped credential");

    // ------------------------------------------------ 3. the child raises an eligible question
    let childResult = service.createSession(
      { ...request, title: "Child", config: { permissionMode: "auto" } },
      undefined, undefined, false, false, false, { parentSessionId: parent.id },
    );
    if (childResult.status === 428) {
      const spawnApproval = db.getSession(parent.id)!.pendingApproval!;
      assert.ok(service.approve(parent.id, spawnApproval.requestId, "allow").ok);
      childResult = service.createSession(
        { ...request, title: "Child", config: { permissionMode: "auto" } },
        undefined, undefined, false, false, false, { parentSessionId: parent.id },
      );
    }
    assert.ok(childResult.ok && childResult.data, childResult.error ?? "child creation failed");
    const child = childResult.data;
    const childLaunch = await deliver(child.id, "investigate the failing test");
    // The ordinary child gets its own scoped credential and the ordinary route surface.
    const childToken = scopedToken(child.id);
    assert.notEqual(childToken, parentToken, "each session gets its own credential");
    assert.equal(db.agentControlCredentialValid(child.id, RUNNER_ID, hashToken(childToken)), true);
    assert.equal(db.agentControlCredentialValid(parent.id, RUNNER_ID, hashToken(childToken)), false,
      "a child credential is not valid for the Orchestrator's session");
    assert.equal(agentControlPrincipal(child.id, childToken, "GET", campaignRoute), null,
      "an ordinary session's credential is refused on an Orchestrator-only route");
    const childPrincipal = agentControlPrincipal(child.id, childToken, "GET", "/api/sessions/:id");
    assert.ok(childPrincipal, "the child keeps the ordinary Agent Control route surface");
    assert.equal(childPrincipal.orchestrator, undefined);

    // The question originates in the child's provider and travels the real runner event path.
    childLaunch.child.stdout.write(JSON.stringify({
      type: "control_request",
      request_id: "child-question",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: { questions: [{ question: "Which branch should I base on?", header: "Base",
          multiSelect: false, options: [{ label: "main" }, { label: "release" }] }] },
      },
    }) + "\n");
    await waitFor(() => eventsFor(child.id).some((event) => event.kind === "question_request"),
      "the runner published the child's question");
    const question = eventsFor(child.id).find((event) => event.kind === "question_request")!;
    assert.equal(question.kind === "question_request" ? question.requestId : null, "child-question");
    // The relay above already carried this exact event into the control plane.

    const occurrenceId = question.kind === "question_request" ? question.occurrenceId! : "";
    assert.deepEqual(db.getSession(child.id)?.pendingRequestOwners, {
      human: 0,
      orchestrator: 1,
      requests: [{ requestId: "child-question", occurrenceId, owner: "orchestrator" }],
    }, "the child's question is owned by the Orchestrator, resolved through the persisted role");
    const listed = service.descendantRequests(parent.id, () => true);
    assert.ok(listed.ok && listed.data, listed.error ?? "descendant requests unavailable");
    assert.deepEqual(listed.data.requests.map((req) => ({ sessionId: req.sessionId, owner: req.responseOwner })),
      [{ sessionId: child.id, owner: "orchestrator" }]);

    const questionId = question.kind === "question_request" ? question.questions[0]!.id : "";
    const resolved = service.resolveDescendantRequest(parent.id, child.id, occurrenceId, {
      action: "answer", answers: { [questionId]: "main" },
    }, () => true);
    assert.ok(resolved.ok, resolved.error ?? "resolution failed");
    const answer = hub.sentOfType("answer_question").at(-1)!;
    assert.equal(answer.resolvedByParentSessionId, parent.id, "the Orchestrator is the resolver");
    assert.ok(service.governanceAudit(child.id).some((entry) =>
      entry.stage === "resolution" && entry.actor.kind === "agent" && entry.actor.id === parent.id),
    "the governance audit records the parent as the resolving agent");

    // Deliver the answer to the runner. `index.ts`'s `answer_question` case calls exactly this.
    manager.answerQuestion(answer.sessionId, answer.requestId, answer.answers, answer.action,
      answer.resolvedByParentSessionId);
    const delivered = controlResponses(childLaunch)
      .find((frame) => frame.response.request_id === "child-question");
    assert.ok(delivered, "the child's provider received the answer");
    assert.equal(delivered.response.response.behavior, "allow");
    assert.deepEqual(delivered.response.response.updatedInput?.answers, { [questionId]: "main" },
      "the answers the Orchestrator chose reached the child's provider");
    const resolvedEvent = eventsFor(child.id).find((event) => event.kind === "question_resolved");
    assert.equal(resolvedEvent?.kind === "question_resolved" ? resolvedEvent.resolvedByParentSessionId : null,
      parent.id, "the runner records the Orchestrator as the resolving agent");
    await settleTurn(childLaunch);

    // --------------------------- 4. explicitly requested parent implementation in its own worktree
    // The principal is the authenticated one derived above from the scoped credential — never a
    // hand-built claim.
    const principal = agentControlPrincipal(parent.id, parentToken, "POST", "/api/sessions/:id/worktrees");
    assert.ok(principal, "the Orchestrator's scoped credential authenticates on the worktree route");
    const persisted = db.getSession(parent.id)!;
    assert.equal(persisted.orchestratorPolicy?.execution.strictProjectIsolation, false);
    assert.equal(agentCredentialSessionTargetError("/api/sessions/:id/worktrees", principal, parent.id), null,
      "the Orchestrator's own credential may manage its own worktrees");
    assert.equal(orchestratorSelfWorktreeAuthorizationError(
      principal, parent.id, persisted.orchestratorPolicy?.execution.strictProjectIsolation !== false,
    ), null, "a non-strict Orchestrator is authorized to create a worktree for itself");

    // The two hops the worktree route performs below Fastify: request the runner operation, then
    // apply the runner's snapshot. Only the Fastify handler body itself (argument parsing, runner
    // capability check, pod-reconciliation gate, create-coordinator dedupe) is not exercised.
    const createWorktree = async (sessionId: string, branch: string): Promise<string> => {
      const result = await hub.requestFromRunner(RUNNER_ID, `req-${sessionId}`, {
        type: "session_worktree", operation: "create", requestId: `req-${sessionId}`,
        sessionId, branch, baseRef: "main",
      });
      assert.equal(result.ok, true, result.error ?? "worktree creation failed");
      db.updateSessionFromSnapshot(sessionId, result.snapshot!, Date.now());
      return result.worktree!.path;
    };
    const parentWorktree = await createWorktree(parent.id, `agent/${parent.id}-implementation`);
    const childWorktree = await createWorktree(child.id, `agent/${child.id}-work`);

    assert.equal(db.getSession(parent.id)?.worktreePath, parentWorktree,
      "the control-plane session view shows the new worktree selected for the parent");
    const native = { kind: "native" as const };
    assert.equal(sameWorktreePath(native, parentWorktree, childWorktree), false,
      "the parent implements in a worktree of its own");
    assert.equal(pathWithin(native, parentWorktree, childWorktree), false);
    assert.equal(pathWithin(native, childWorktree, parentWorktree), false);
    assert.equal(pathWithin(native, parentWorktree, repo), false,
      "the dedicated worktree never overlaps the primary checkout");
    assert.equal(git(["-C", parentWorktree, "branch", "--show-current"]).trim(),
      `agent/${parent.id}-implementation`);

    // The parent's NEXT PROMPT relaunches it inside the selected worktree: `activateWorktree`
    // records `pendingWorktreeRebind` (apps/runner/src/session-manager.ts:1932) and the drain
    // performs the rebind once the live turn ends. No control-plane restart is involved.
    await settleTurn(first);
    const promptResult = service.prompt(parent.id, "make the requested edit");
    assert.ok(promptResult.ok, promptResult.error ?? "prompt failed");
    const promptCommand = hub.sent.flatMap((msg) => msg.type === "prompt_session"
      ? [msg]
      : msg.type === "durable_session_command" && msg.command.type === "prompt_session"
        ? [msg.command]
        : []).at(-1);
    assert.ok(promptCommand && promptCommand.sessionId === parent.id, "the control plane sent the prompt");
    const launchesBeforePrompt = launches.length;
    // The runner's `prompt_session` case calls exactly this.
    manager.prompt(promptCommand.sessionId, promptCommand.text, promptCommand.images,
      promptCommand.slashCommand, promptCommand.config);
    await waitFor(() => launches.length > launchesBeforePrompt, "the next prompt relaunched the provider");
    const second = launches.at(-1)!;
    assert.equal(second.sessionId, parent.id);
    const rebindSessionId = valuesOf(second.argv, "--session-id")[0] ?? valuesOf(second.argv, "--resume")[0]!;
    second.child.stdout.write(JSON.stringify({
      type: "system", subtype: "init", session_id: rebindSessionId, model: "claude-test",
    }) + "\n");
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(second.cwd, parentWorktree, "the parent's next launch uses its dedicated worktree as cwd");
    assert.deepEqual(second.opts.orchestrator, { strictProjectIsolation: false, integrationIsolation: false },
      "the role survives the worktree rebind");
    assert.equal(store.readMeta(parent.id)?.config.permissionMode, "auto",
      "the user's permission-mode selection is untouched by the worktree");
    // A linked runner-owned worktree provisions the managed-worktree guard hook, which enforces
    // the runner-owned worktree veto for every Bash call in every mode. The launch therefore keeps
    // the user's selected `auto` instead of being mediated to interactive `default` (issue #1313).
    assert.deepEqual(valuesOf(second.argv, "--permission-mode"), ["auto"]);
    assert.deepEqual(valuesOf(second.argv, "--permission-prompt-tool"), ["stdio"]);
    assert.equal(hasFlag(second.argv, "--settings"), true, "the guard rides a runner-owned settings file");
    assert.equal(hasFlag(second.argv, "--strict-mcp-config"), false);
    // Resume idempotence: re-provisioning the same session adds the additive arguments once.
    assert.deepEqual(valuesOf(second.argv, "--allowedTools"), ["mcp__wollipog__*"]);
    assert.equal(second.argv.filter((arg) => arg === "--append-system-prompt").length, 1);
    // The session's own worktree joins the readable Project Locations on this launch; every
    // value still appears exactly once.
    assert.deepEqual(valuesOf(second.argv, "--add-dir"), ["/home/user/notes", repo, parentWorktree]);
    assert.deepEqual(valuesOf(second.argv, "--mcp-config"), [USER_MCP_CONFIG, wollipogMcp]);
    // The manager policy hooks are unsupported for `auto` (its elicitation is `stdio-control`), so
    // the runner-owned settings file carries the managed-worktree guard alone. Claude applies only
    // the LAST `--settings`, so the user's own file is shadowed for this launch — the same thing
    // that already happened whenever manager hooks were provisioned (docs/adr/0012).
    assert.deepEqual(
      valuesOf(second.argv, "--settings"),
      [USER_SETTINGS, claudeHookSettingsPath(hookDir, parent.id)],
    );

    // ------------------ 5. the implementation itself behaves exactly as for a normal Session
    second.child.stdout.write(JSON.stringify({
      type: "control_request",
      request_id: "coordination",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "gh pr view 1296" } },
    }) + "\n");
    await waitFor(() => controlResponses(second).length > 0, "the classifier answered the routine command");
    assert.deepEqual(
      controlResponses(second).map((frame) => [frame.response.request_id, frame.response.response.behavior]),
      [["coordination", "allow"]],
      "a routine coordination command is auto-allowed by the classifier",
    );
    assert.equal(eventsFor(parent.id).some((event) => event.kind === "permission_request"), false,
      "routine coordination never becomes an approval card");

    second.child.stdout.write(JSON.stringify({
      type: "control_request",
      request_id: "implementation-edit",
      request: { subtype: "can_use_tool", tool_name: "Edit", description: "notes.md",
        input: { file_path: join(parentWorktree, "notes.md"), old_string: "a", new_string: "b" } },
    }) + "\n");
    await waitFor(() => eventsFor(parent.id).some((event) => event.kind === "permission_request"),
      "the edit uses the ordinary provider approval path");
    assert.equal(controlResponses(second).length, 1,
      "the edit is neither auto-allowed nor auto-denied by the runner");
    const card = eventsFor(parent.id).find((event) => event.kind === "permission_request")!;
    assert.equal(card.kind === "permission_request" ? card.title : null, "Edit: notes.md",
      "an ordinary approval card, with no Orchestrator-specific handling");
    await settleTurn(second);
  } finally {
    manager?.shutdownAll();
    db.close();
    if (priorGitConfig.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = priorGitConfig.global;
    if (priorGitConfig.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = priorGitConfig.system;
    rmSync(root, { recursive: true, force: true });
  }
});
