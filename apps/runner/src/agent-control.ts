/** Runner-local provisioning for the provider-neutral Wollipog CLI and MCP surface. */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runnerSupportsProtocol, type AcpMcpStdioServer, type AgentDefinition, type SessionLaunchSpec } from "@wollipog/protocol";
import { deriveControlPlaneHttpUrl } from "./control-plane-transport.js";
import {
  defaultRunnerReentryHost,
  runnerReentryCommand,
  type RunnerReentryHost,
} from "./runner-reentry.js";
import { assertSafeSessionFileId } from "./session-file-id.js";
import {
  WSL_AGENT_CONTROL_HELPER_PATH,
  WSL_AGENT_CONTROL_HELPER_SHA256,
  WSL_AGENT_CONTROL_HELPER_SOURCE,
  WSL_AGENT_CONTROL_PRIVATE_MCP,
  WSL_AGENT_CONTROL_PRIVATE_SOCKET,
  WSL_AGENT_CONTROL_PRIVATE_TOKEN,
  WSL_AGENT_CONTROL_PROTOCOL,
  type WslAgentControlLaunch,
} from "./wsl-agent-control.js";
import { installWslBwrapLauncher } from "./wsl-bwrap-launcher.js";
import {
  ORCHESTRATOR_ENV_KEY,
  orchestratorLaunchArgs,
  stripOrchestratorLaunchArgs,
  supportsClaudeAgentAcpOrchestrator,
} from "./orchestrator-preset.js";

const TOKEN_PREFIX = "wollipoga_";
const TOKEN_PATTERN = /^wollipoga_[A-Za-z0-9_-]{43}$/u;
const AGENT_CONTROL_ENV_KEYS = [
  ORCHESTRATOR_ENV_KEY,
  "WOLLIPOG_CONTROL_PLANE_URL",
  "WOLLIPOG_SESSION_ID",
  "WOLLIPOG_SESSION_TOKEN_FILE",
  "WOLLIPOG_SESSION_CREDENTIAL_READY_FILE",
  "WOLLIPOG_CLI",
  "WOLLIPOG_CLI_ARGS",
] as const;
const STAGED_AGENT_CONTROL_FILE_PATTERN =
  /^\.pending-[1-9]\d*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface AgentControlHost extends RunnerReentryHost {
  configDir: string;
  installWslHelper?: (distro: string) => Promise<void>;
  installWslLauncher?: (distro: string) => Promise<void>;
}

export function defaultAgentControlHost(dataDir: string): AgentControlHost {
  return { ...defaultRunnerReentryHost(), configDir: resolve(dataDir, "agent-control"),
    installWslHelper, installWslLauncher: installWslBwrapLauncher };
}

const wslLaunches = new Map<string, WslAgentControlLaunch>();

/** Ephemeral only: SessionStore never receives the credential or helper launch contract. */
export function wslAgentControlLaunch(sessionId: string): WslAgentControlLaunch | undefined {
  return wslLaunches.get(sessionId);
}

async function installWslHelper(distro: string): Promise<void> {
  const staged = `${WSL_AGENT_CONTROL_HELPER_PATH}.pending-${process.pid}-${randomUUID()}`;
  const script = [
    "set -eu",
    "target=$1; staged=$2; expected=$3",
    "for fixed in /usr /usr/local /usr/local/lib; do test -d \"$fixed\"; test ! -L \"$fixed\"; test \"$(/usr/bin/stat -c %u \"$fixed\")\" = 0; mode=$(/usr/bin/stat -c %a \"$fixed\"); test $((0$mode & 022)) = 0; done",
    "dir=/usr/local/lib/wollipog",
    "if test -e \"$dir\" || test -L \"$dir\"; then test -d \"$dir\"; test ! -L \"$dir\"; test \"$(/usr/bin/stat -c %u \"$dir\")\" = 0; mode=$(/usr/bin/stat -c %a \"$dir\"); test $((0$mode & 022)) = 0; else /usr/bin/mkdir -m 0755 -- \"$dir\"; /usr/bin/chown root:root \"$dir\"; fi",
    "/usr/bin/chmod 0755 \"$dir\"",
    "trap '/usr/bin/rm -f -- \"$staged\"' EXIT",
    "/usr/bin/cat > \"$staged\"",
    "/usr/bin/chown root:root \"$staged\"",
    "/usr/bin/chmod 0555 \"$staged\"",
    "printf '%s  %s\\n' \"$expected\" \"$staged\" | /usr/bin/sha256sum -c - >/dev/null",
    "/usr/bin/mv -T -- \"$staged\" \"$target\"",
    "test \"$(/usr/bin/stat -c '%u:%g:%a' \"$target\")\" = '0:0:555'",
    "printf '%s  %s\\n' \"$expected\" \"$target\" | /usr/bin/sha256sum -c - >/dev/null",
  ].join("\n");
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("wsl.exe", [
      "-d", distro, "-u", "root", "--exec", "/bin/sh", "-c", script, "wollipog-install-wsl-helper",
      WSL_AGENT_CONTROL_HELPER_PATH, staged, WSL_AGENT_CONTROL_HELPER_SHA256,
    ], { stdio: ["pipe", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 8_192) stderr += chunk; });
    child.stdin.on("error", () => {});
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`target-local Agent Control helper install failed${stderr.trim() ? `: ${stderr.trim()}` : ` (exit ${String(code)})`}`)));
    child.stdin.end(WSL_AGENT_CONTROL_HELPER_SOURCE);
  });
}

export function agentControlTokenPath(configDir: string, sessionId: string): string {
  assertSafeSessionFileId(sessionId);
  return join(configDir, `${sessionId}.token`);
}

export function agentControlMcpConfigPath(configDir: string, sessionId: string): string {
  assertSafeSessionFileId(sessionId);
  return join(configDir, `${sessionId}.mcp.json`);
}

export function agentControlReadyPath(configDir: string, sessionId: string): string {
  assertSafeSessionFileId(sessionId);
  return join(configDir, `${sessionId}.ready`);
}

function protectedWrite(file: string, value: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new Error("agent-control credential path is a symbolic link");
  }
  const staged = join(dir, `.pending-${process.pid}-${randomUUID()}`);
  writeFileSync(staged, value, { flag: "wx", mode: 0o600 });
  try { chmodSync(staged, 0o600); } catch { /* Windows uses the owning account ACL. */ }
  renameSync(staged, file);
  try { chmodSync(file, 0o600); } catch { /* Windows uses the owning account ACL. */ }
}

function sessionToken(file: string): string {
  try {
    if (!lstatSync(file).isSymbolicLink()) {
      const existing = readFileSync(file, "utf8").trim();
      if (TOKEN_PATTERN.test(existing)) return existing;
    }
  } catch {
    /* Missing or corrupt credentials are replaced below. */
  }
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  protectedWrite(file, token);
  return token;
}

function rotateSessionToken(file: string): string {
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  protectedWrite(file, token);
  return token;
}

function writeMcpConfig(
  file: string,
  launch: { command: string; args: string[] },
  tokenFile: string,
  cpUrl: string,
  sessionId: string,
  readyFile: string,
  orchestrator = false,
): void {
  mkdirSync(dirname(file), { recursive: true });
  const body = {
    mcpServers: {
      wollipog: {
        type: "stdio",
        command: launch.command,
        args: [...launch.args],
        env: {
          WOLLIPOG_CONTROL_PLANE_URL: cpUrl,
          WOLLIPOG_SESSION_ID: sessionId,
          WOLLIPOG_SESSION_TOKEN_FILE: tokenFile,
          WOLLIPOG_SESSION_CREDENTIAL_READY_FILE: readyFile,
          ...(orchestrator ? { [ORCHESTRATOR_ENV_KEY]: "orchestrator" } : {}),
        },
      },
    },
  };
  writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows uses the owning account ACL. */ }
}

function removeAgentControlLaunchState(
  spec: Pick<SessionLaunchSpec, "sessionId" | "args" | "env">,
  host: AgentControlHost,
): void {
  wslLaunches.delete(spec.sessionId);
  const mcpConfig = agentControlMcpConfigPath(host.configDir, spec.sessionId);
  for (let i = spec.args.length - 2; i >= 0; i--) {
    if (spec.args[i] === "--mcp-config" && spec.args[i + 1] === mcpConfig) {
      spec.args.splice(i, 2);
    }
  }
  for (const key of AGENT_CONTROL_ENV_KEYS) delete spec.env[key];
  removeAgentControlFiles(spec.sessionId, host.configDir);
}

/** Mutates only ephemeral runner-side launch state. The credential bytes never cross the runner
 * socket and are scrubbed from durable session metadata by the existing env policy. */
export function provisionAgentControl(
  spec: Pick<SessionLaunchSpec, "sessionId" | "driver" | "context" | "executionTarget" | "command" | "args" | "env"> &
    Partial<Pick<SessionLaunchSpec, "config" | "acpSessionContext">>,
  config: {
    controlPlaneUrl: string;
    controlPlaneProtocolVersion: number | null;
    allowInsecureTransport?: boolean;
    registerCredential?: (sessionId: string, tokenHash: string) => void;
    /** WSL only: registration acknowledgement is a launch fence because its private tmpfs is
     * created with the provider and cannot receive a later native ready-file update. */
    registerCredentialAndWait?: (sessionId: string, tokenHash: string) => Promise<void>;
    /** Exact runner-local catalog row used to authorize an ACP Orchestrator launch. */
    orchestratorAgent?: AgentDefinition;
    /** Direct WSL is proven only by the target-local bwrap launcher. */
    executionIsolationMode?: "provider" | "bwrap" | "seatbelt" | "windows-job";
  },
  log: (message: string) => void,
  host: AgentControlHost,
): Promise<void> | void {
  const supported = runnerSupportsProtocol(config.controlPlaneProtocolVersion, "sessionAgentControl");
  const context = spec.context ?? { kind: "native" as const };
  const targetIsHost = !spec.executionTarget || spec.executionTarget.adapter === "host";
  const nativeHostExecution = context.kind === "native" && targetIsHost;
  const wslOrchestrator = context.kind === "wsl" && targetIsHost && spec.config?.permissionMode === "orchestrator";
  const orchestrator = spec.config?.permissionMode === "orchestrator";
  const structuredDriver = ["codex", "codex-app-server", "claude-code"].includes(spec.driver ?? "acp");
  const orchestratorAgent = config.orchestratorAgent;
  const wslAgentControl = orchestratorAgent?.wslAgentControl;
  const wslBaseArgs = stripOrchestratorLaunchArgs(spec.args, spec.driver);
  const wslLaunchMatches = context.kind === "wsl" && orchestratorAgent &&
    orchestratorAgent.command === spec.command && orchestratorAgent.args.length === wslBaseArgs.length &&
    orchestratorAgent.args.every((arg, index) => arg === wslBaseArgs[index]) &&
    orchestratorAgent.driver === spec.driver && orchestratorAgent.context?.kind === "wsl" &&
    orchestratorAgent.context.distro === context.distro;
  if (orchestrator && (!targetIsHost || !runnerSupportsProtocol(config.controlPlaneProtocolVersion, "sessionOrchestration") ||
      !(nativeHostExecution ? ["acp", "codex", "codex-app-server", "claude-code"].includes(spec.driver ?? "acp")
        : wslOrchestrator && structuredDriver &&
          runnerSupportsProtocol(config.controlPlaneProtocolVersion, "wslAgentControlBridge") &&
          runnerSupportsProtocol(config.controlPlaneProtocolVersion, "wslSafeLauncher") &&
          wslAgentControl?.protocolVersion === WSL_AGENT_CONTROL_PROTOCOL &&
          wslAgentControl.safeLauncherProtocolVersion === 1 &&
          config.executionIsolationMode === "bwrap" && wslLaunchMatches))) {
    throw new Error("the orchestrator preset requires a current supported native harness or verified Direct WSL bridge on the host");
  }
  if (orchestrator && (spec.driver ?? "acp") === "acp") {
    const agent = config.orchestratorAgent;
    const launchMatches = agent && agent.command === spec.command && agent.args.length === spec.args.length &&
      agent.args.every((arg, index) => arg === spec.args[index]);
    if (!agent || !launchMatches || !supportsClaudeAgentAcpOrchestrator(agent)) {
      throw new Error("the Orchestrator preset requires the exact audited Claude Agent ACP adapter");
    }
  }
  if (!supported || (!nativeHostExecution && !wslOrchestrator)) {
    removeAgentControlLaunchState(spec, host);
    if (!nativeHostExecution && !wslOrchestrator) {
      log(`agent control ${spec.sessionId}: non-host path injection is not supported`);
    }
    return;
  }

  const cpUrl = deriveControlPlaneHttpUrl(config.controlPlaneUrl, config.allowInsecureTransport);
  const tokenFile = agentControlTokenPath(host.configDir, spec.sessionId);
  const token = wslOrchestrator ? rotateSessionToken(tokenFile) : sessionToken(tokenFile);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const readyFile = agentControlReadyPath(host.configDir, spec.sessionId);
  // Every registration gets a fresh positive-ack fence, including reconnect/resume with the same
  // token. A stale marker must never let the first request race a rejected re-binding.
  rmSync(readyFile, { force: true });
  const credentialRegistration = wslOrchestrator && config.registerCredentialAndWait
    ? config.registerCredentialAndWait(spec.sessionId, tokenHash)
    : (config.registerCredential?.(spec.sessionId, tokenHash), undefined);

  if (wslOrchestrator && context.kind === "wsl" && wslAgentControl) {
    const provisionWsl = async (): Promise<void> => {
      await Promise.all([
        (async () => {
          // Both installers publish into the same root-owned directory. Serialize their
          // check-and-create steps so a fresh distro cannot lose an otherwise harmless mkdir race.
          await (host.installWslHelper ?? installWslHelper)(context.distro);
          await (host.installWslLauncher ?? installWslBwrapLauncher)(context.distro);
        })(),
        credentialRegistration ?? Promise.reject(new Error("Direct WSL Agent Control requires credential acknowledgement before launch")),
      ]);
      const runtime = wslAgentControl.nodeRuntime;
      if (!runtime.startsWith("/") || /[\0\r\n]/u.test(runtime)) {
        throw new Error("Direct WSL Agent Control requires an absolute discovery-verified Linux Node runtime");
      }
      const helperLaunch = { command: runtime, args: [WSL_AGENT_CONTROL_HELPER_PATH, "mcp"], env: {
        WOLLIPOG_SESSION_ID: spec.sessionId,
        WOLLIPOG_SESSION_TOKEN_FILE: WSL_AGENT_CONTROL_PRIVATE_TOKEN,
        WOLLIPOG_AGENT_CONTROL_SOCKET: WSL_AGENT_CONTROL_PRIVATE_SOCKET,
      } };
      spec.env = {
        ...spec.env,
        WOLLIPOG_SESSION_ID: spec.sessionId,
        WOLLIPOG_SESSION_TOKEN_FILE: WSL_AGENT_CONTROL_PRIVATE_TOKEN,
        WOLLIPOG_CLI: runtime,
        WOLLIPOG_CLI_ARGS: JSON.stringify([WSL_AGENT_CONTROL_HELPER_PATH, "cli"]),
      };
      spec.env[ORCHESTRATOR_ENV_KEY] = "orchestrator";
      spec.args = stripOrchestratorLaunchArgs(spec.args, spec.driver);
      spec.args.push(...orchestratorLaunchArgs(spec.driver, helperLaunch));
      if (spec.driver === "claude-code") spec.args.push("--mcp-config", WSL_AGENT_CONTROL_PRIVATE_MCP);
      wslLaunches.set(spec.sessionId, {
        protocolVersion: WSL_AGENT_CONTROL_PROTOCOL,
        distro: context.distro,
        nodeRuntime: runtime,
        helperPath: WSL_AGENT_CONTROL_HELPER_PATH,
        sessionId: spec.sessionId,
        token,
        tokenFile,
        readyFile,
        cpUrl,
        safeLauncherProtocolVersion: 1,
        bwrapRuntime: wslAgentControl.bwrapRuntime!,
        socketPath: `/tmp/wlp-${process.pid}-${randomUUID()}/control.sock`,
      });
      log(`agent control ${spec.sessionId}: target-local WSL CLI and MCP bridge provisioned`);
    };
    return provisionWsl().catch((error) => {
      removeAgentControlLaunchState(spec, host);
      throw error;
    });
  }

  const cli = runnerReentryCommand(host, "--wollipog-cli");
  spec.env = {
    ...spec.env,
    WOLLIPOG_CONTROL_PLANE_URL: cpUrl,
    WOLLIPOG_SESSION_ID: spec.sessionId,
    WOLLIPOG_SESSION_TOKEN_FILE: tokenFile,
    WOLLIPOG_SESSION_CREDENTIAL_READY_FILE: readyFile,
    WOLLIPOG_CLI: cli.command,
    WOLLIPOG_CLI_ARGS: JSON.stringify(cli.args),
  };
  delete spec.env[ORCHESTRATOR_ENV_KEY];
  if (orchestrator) {
    spec.env[ORCHESTRATOR_ENV_KEY] = "orchestrator";
    const mcp = {
      ...runnerReentryCommand(host, "--agent-control-mcp"),
      env: {
        WOLLIPOG_CONTROL_PLANE_URL: cpUrl, WOLLIPOG_SESSION_ID: spec.sessionId,
        WOLLIPOG_SESSION_TOKEN_FILE: tokenFile, WOLLIPOG_SESSION_CREDENTIAL_READY_FILE: readyFile,
        [ORCHESTRATOR_ENV_KEY]: "orchestrator",
      },
    };
    if ((spec.driver ?? "acp") === "acp") {
      const server: AcpMcpStdioServer = {
        type: "stdio",
        name: "wollipog",
        command: mcp.command,
        args: [...mcp.args],
        env: Object.fromEntries(Object.keys(mcp.env).map((name) => [name, { fromEnv: name }])),
      };
      // Ambient/user ACP context is not part of the audited boundary. The sole MCP definition is
      // materialized from runner-owned environment references immediately before session/new.
      spec.acpSessionContext = { mcpServers: [server] };
    } else {
      spec.args = stripOrchestratorLaunchArgs(spec.args, spec.driver);
      spec.args.push(...orchestratorLaunchArgs(spec.driver, mcp));
    }
  }

  if (spec.driver === "claude-code") {
    const file = agentControlMcpConfigPath(host.configDir, spec.sessionId);
    writeMcpConfig(file, runnerReentryCommand(host, "--agent-control-mcp"), tokenFile, cpUrl, spec.sessionId, readyFile, orchestrator);
    let already = false;
    for (let i = 0; i < spec.args.length - 1; i++) {
      if (spec.args[i] === "--mcp-config" && spec.args[i + 1] === file) already = true;
    }
    if (!already) spec.args.push("--mcp-config", file);
  }
  log(`agent control ${spec.sessionId}: CLI${spec.driver === "claude-code" || (orchestrator && spec.driver === "acp") ? " and MCP" : ""} provisioned`);
}

export function removeAgentControlFiles(sessionId: string, configDir: string): void {
  wslLaunches.delete(sessionId);
  for (const file of [
    agentControlTokenPath(configDir, sessionId),
    agentControlMcpConfigPath(configDir, sessionId),
    agentControlReadyPath(configDir, sessionId),
  ]) {
    try { rmSync(file, { force: true }); } catch { /* Best effort after session deletion. */ }
  }
}

/** Startup cleanup: active sessions re-provision before launch, while terminal/orphaned secrets
 * must not survive runner restarts as live-looking credential material. */
export function sweepAgentControlFiles(configDir: string): number {
  if (!existsSync(configDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(configDir, { withFileTypes: true })) {
    if (!entry.isFile() ||
        !([".token", ".mcp.json", ".ready"].some((suffix) => entry.name.endsWith(suffix)) ||
          STAGED_AGENT_CONTROL_FILE_PATTERN.test(entry.name))) continue;
    rmSync(join(configDir, entry.name), { force: true });
    removed++;
  }
  return removed;
}

/** Publish the exact hash acknowledgement atomically. CLI/MCP callers verify it against their
 * token before issuing the first HTTP request, closing the runner-socket/HTTP race. */
export function markAgentControlCredentialReady(configDir: string, sessionId: string, tokenHash: string): void {
  if (!/^[0-9a-f]{64}$/u.test(tokenHash)) throw new Error("invalid agent-control credential hash");
  const token = readFileSync(agentControlTokenPath(configDir, sessionId), "utf8").trim();
  if (createHash("sha256").update(token).digest("hex") !== tokenHash) {
    throw new Error("agent-control acknowledgement does not match the active token");
  }
  protectedWrite(agentControlReadyPath(configDir, sessionId), tokenHash);
}

/** A rejected binding cannot remain callable or be accidentally reused on resume. */
export function markAgentControlCredentialRejected(configDir: string, sessionId: string): void {
  removeAgentControlFiles(sessionId, configDir);
}
