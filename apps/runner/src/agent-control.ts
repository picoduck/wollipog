/** Runner-local provisioning for the provider-neutral Wollipog CLI and MCP surface. */

import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import { runnerSupportsProtocol, type SessionLaunchSpec } from "@wollipog/protocol";
import { deriveControlPlaneHttpUrl } from "./control-plane-transport.js";
import {
  defaultRunnerReentryHost,
  runnerReentryCommand,
  type RunnerReentryHost,
} from "./runner-reentry.js";
import { assertSafeSessionFileId } from "./session-file-id.js";

const TOKEN_PREFIX = "wollipoga_";
const TOKEN_PATTERN = /^wollipoga_[A-Za-z0-9_-]{43}$/u;
const AGENT_CONTROL_ENV_KEYS = [
  "WOLLIPOG_CONTROL_PLANE_URL",
  "WOLLIPOG_SESSION_ID",
  "WOLLIPOG_SESSION_TOKEN_FILE",
  "WOLLIPOG_SESSION_CREDENTIAL_READY_FILE",
  "WOLLIPOG_CLI",
  "WOLLIPOG_CLI_ARGS",
] as const;

export interface AgentControlHost extends RunnerReentryHost {
  configDir: string;
}

export function defaultAgentControlHost(dataDir: string): AgentControlHost {
  return { ...defaultRunnerReentryHost(), configDir: resolve(dataDir, "agent-control") };
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

function writeMcpConfig(
  file: string,
  launch: { command: string; args: string[] },
  tokenFile: string,
  cpUrl: string,
  sessionId: string,
  readyFile: string,
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
  spec: Pick<SessionLaunchSpec, "sessionId" | "driver" | "context" | "executionTarget" | "args" | "env">,
  config: {
    controlPlaneUrl: string;
    controlPlaneProtocolVersion: number | null;
    allowInsecureTransport?: boolean;
    registerCredential?: (sessionId: string, tokenHash: string) => void;
  },
  log: (message: string) => void,
  host: AgentControlHost,
): void {
  const supported = runnerSupportsProtocol(config.controlPlaneProtocolVersion, "sessionAgentControl");
  const hostExecution = (spec.context?.kind ?? "native") === "native" &&
    (!spec.executionTarget || spec.executionTarget.adapter === "host");
  if (!supported || !hostExecution) {
    removeAgentControlLaunchState(spec, host);
    if (!hostExecution) {
      log(`agent control ${spec.sessionId}: non-host path injection is not supported`);
    }
    return;
  }

  const cpUrl = deriveControlPlaneHttpUrl(config.controlPlaneUrl, config.allowInsecureTransport);
  const tokenFile = agentControlTokenPath(host.configDir, spec.sessionId);
  const token = sessionToken(tokenFile);
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const readyFile = agentControlReadyPath(host.configDir, spec.sessionId);
  // Every registration gets a fresh positive-ack fence, including reconnect/resume with the same
  // token. A stale marker must never let the first request race a rejected re-binding.
  rmSync(readyFile, { force: true });
  config.registerCredential?.(spec.sessionId, tokenHash);

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

  if (spec.driver === "claude-code") {
    const file = agentControlMcpConfigPath(host.configDir, spec.sessionId);
    writeMcpConfig(file, runnerReentryCommand(host, "--agent-control-mcp"), tokenFile, cpUrl, spec.sessionId, readyFile);
    let already = false;
    for (let i = 0; i < spec.args.length - 1; i++) {
      if (spec.args[i] === "--mcp-config" && spec.args[i + 1] === file) already = true;
    }
    if (!already) spec.args.push("--mcp-config", file);
  }
  log(`agent control ${spec.sessionId}: CLI${spec.driver === "claude-code" ? " and MCP" : ""} provisioned`);
}

export function removeAgentControlFiles(sessionId: string, configDir: string): void {
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
        ![".token", ".mcp.json", ".ready"].some((suffix) => entry.name.endsWith(suffix))) continue;
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
