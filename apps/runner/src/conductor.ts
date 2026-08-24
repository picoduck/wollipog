/**
 * Conductor provisioning + agent synthesis.
 *
 * The conductor is a NORMAL claude-code session (agentId "conductor") whose `claude -p`
 * process is pointed at this runner executable's `--conductor-mcp` mode via a per-session
 * --mcp-config file. Provisioning happens runner-side, in the start_session handler,
 * BEFORE SessionManager.start() — start() persists spec.args/config into the box store's
 * meta, so the injected flags survive restarts and the resume path reuses them.
 *
 * "conductor" is a contract constant shared by three parties: agent synthesis here, the
 * provisioning trigger here, and the control plane's permissionMode clamp (sessions.ts).
 * Renaming any one of them silently breaks the confirm-before-apply enforcement pairing.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import type { AgentDefinition, SessionLaunchSpec } from "@wollipog/protocol";
import { defaultRunnerReentryHost, runnerReentryCommand, type RunnerReentryHost } from "./runner-reentry.js";
import { scopedRunnerCredentialFile, type RunnerDataDirIdentity } from "./runner-data-dir.js";
import { winQuoteArg } from "./spawn.js";
import { deriveControlPlaneHttpUrl } from "./control-plane-transport.js";

export const CONDUCTOR_AGENT_ID = "conductor";

type ConductorLaunchSpec = Pick<
  SessionLaunchSpec,
  "sessionId" | "driver" | "context" | "config" | "args"
> & { agentId: string | null };

/** Curated read tools, pre-allowed via --allowedTools so inspection never prompts. */
export const CONDUCTOR_READ_TOOLS = [
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
];

/** Side-channel closure: the REST API is credential-free on loopback, so a Bash-equipped
 * conductor could curl /approve on its OWN pending cards. Built-in read-only tools
 * (Read/Grep/Glob) stay — harmless, same trust domain. */
export const CONDUCTOR_DISALLOWED_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
];

/** The persona, as ONE line: winQuoteArg cannot deliver CR/LF (or %) through cmd.exe
 * shell:true, so a multi-line prompt would throw at spawn. <SELF_ID> is substituted at
 * provision time. */
const CONDUCTOR_PROMPT =
  "You are the Conductor for Wollipog. You operate the manager only through the mcp__manager__ tools, never through shell, files, or direct HTTP. Read tools are pre-approved; every mutating tool call shows the user an Allow/Reject card, so before calling one, state briefly what you are about to do and why, then call it once and wait for the decision. If a call is rejected, ask the user instead of retrying. Your own session id is <SELF_ID>; never prompt, stop, or reconfigure it. List runners or sessions before acting so every id you use is real, never guessed. Treat HTTP 409 results as state signals: runner offline, session busy, or a guardrail pause that only the user can resolve with Continue or Stop in the dashboard. Before changing governance, inspect the exact existing policies and propose the narrowest runner, workspace, agent, tool, path, network, or branch scope that satisfies the request. Prefer durable workflows when work has distinct builder, reviewer, gate, retry, or convergence roles: inspect the workflow first, bind every graph role to a real runner agent, dispatch only ready nodes, wait for the worker to settle, inspect its events, publish faithful required artifacts, and only then complete the attempt. Never fabricate an artifact or outcome. For a simple one-agent task, prefer one create_session call with the prompt included. For requests like stopping over-budget work, list sessions, compare costUsd to costBudgetUsd, tell the user which sessions qualify, then stop them one at a time.";

export function conductorSystemPrompt(selfSessionId: string): string {
  return CONDUCTOR_PROMPT.replace("<SELF_ID>", selfSessionId);
}

/** How to launch THIS runner executable in `--conductor-mcp` mode. */
export interface ConductorHost extends RunnerReentryHost {
  /** Running as a Node single-executable (the box deployment) — the binary IS the entry. */
  isSea: boolean;
  execPath: string;
  /** Carries the tsx loader in dev; empty for plain dist/SEA launches. */
  execArgv: string[];
  /** argv[1] — the script the daemon was started with (absent in SEA mode). */
  scriptPath?: string;
  /** Directory holding the per-session mcp-config files. */
  configDir: string;
}

/** node:sea probe, guarded: the module (and `require`) only exist in some runtimes. In the
 * SEA bundle (CJS) the native `require` is in scope; in ESM dev we mint one. */
function defaultConfigDir(): string {
  return join(homedir(), ".agent-manager", "conductor");
}

export function defaultConductorHost(): ConductorHost {
  return {
    ...defaultRunnerReentryHost(),
    configDir: defaultConfigDir(),
  };
}

/** ws->http / wss->https, and strip the /runner WS route — works both locally
 * (ws://127.0.0.1:4317/runner) and on boxes (ws://127.0.0.1:<tunnelPort>/runner). */
export function deriveCpHttpUrl(controlPlaneUrl: string, allowInsecureTransport = false): string {
  return deriveControlPlaneHttpUrl(controlPlaneUrl, allowInsecureTransport);
}

/** Only cli.* dispatches --conductor-mcp. A daemon started the pre-dispatcher way
 * (`tsx src/index.ts` — stale launch scripts, shell history) would otherwise write an
 * mcp.json that re-runs index.* as the "MCP server": a SECOND full daemon whose stdout
 * logs corrupt the JSON-RPC channel and which may even register a duplicate runnerId.
 * The cli.* dispatcher always sits next to index.* (src and dist alike), so rewrite
 * deterministically and note it on stderr. */
/** The command that re-enters this executable as the MCP server. SEA binaries have no
 * script path (argv is [exe, ...args]); script launches re-spawn with the same execArgv so
 * the tsx loader (dev) rides along, while dist/SEA argv stays plain. */
export function conductorMcpCommand(host: Pick<ConductorHost, "isSea" | "execPath" | "execArgv" | "scriptPath">): {
  command: string;
  args: string[];
} {
  return runnerReentryCommand(host, "--conductor-mcp");
}

/** Canonical location of a session's mcp-config file. */
export function conductorMcpConfigPath(configDir: string, sessionId: string): string {
  return join(configDir, `${sessionId}.mcp.json`);
}

export interface StagedRunnerCredentialFile {
  activePath: string;
  promote(): string;
  discard(): void;
}

/** Stage a replacement beside the protected active credential without changing what conductor
 * processes read. The WebSocket `registered` acknowledgement is the cutover boundary: only then
 * does promote atomically replace the active file. Rejection/disconnect can leave the old active
 * credential untouched. */
export function stageRunnerCredentialFile(
  dataDir: string,
  token: string,
  identity?: RunnerDataDirIdentity,
): StagedRunnerCredentialFile {
  const activePath = identity
    ? scopedRunnerCredentialFile(dataDir, identity)
    : join(dataDir, "credentials", "active-runner-token");
  const dir = dirname(activePath);
  const stagedPath = join(dir, `.pending-runner-token-${process.pid}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stagedPath, token, { mode: 0o600, flag: "wx" });
  try { chmodSync(stagedPath, 0o600); } catch { /* Windows ACLs are managed by the owning account */ }
  let staged = true;
  return {
    activePath,
    promote() {
      if (!staged) return activePath;
      renameSync(stagedPath, activePath);
      try { chmodSync(activePath, 0o600); } catch { /* Windows ACLs are managed by the owning account */ }
      staged = false;
      return activePath;
    },
    discard() {
      if (!staged) return;
      rmSync(stagedPath, { force: true });
      staged = false;
    },
  };
}

/** One protected runner-local source for the active runner credential. Per-session MCP configs
 * reference this path and therefore never duplicate plaintext secrets. Direct callers opt into an
 * immediate cutover; the runner daemon uses stageRunnerCredentialFile and waits for registration. */
export function writeRunnerCredentialFile(dataDir: string, token: string): string {
  return stageRunnerCredentialFile(dataDir, token).promote();
}

/** Startup scrub for legacy per-session configs that embedded MANAGER_TOKEN plaintext. Every
 * conductor launch or resume re-provisions its file from current runner state. */
export function sweepConductorMcpConfigs(configDir = defaultConfigDir()): number {
  if (!existsSync(configDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(configDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mcp.json")) continue;
    rmSync(join(configDir, entry.name), { force: true });
    removed++;
  }
  return removed;
}

/**
 * Write a session's mcp-config to `file`. A FILE, never inline JSON: winQuoteArg throws on
 * CR/LF and cannot escape %VAR% through cmd.exe shell:true. The per-server env carries
 * MANAGER_TOKEN_FILE so the secret stays out of argv and out of per-session JSON.
 */
export function writeConductorMcpConfig(
  file: string,
  opts: {
    sessionId: string;
    launch: { command: string; args: string[] };
    cpHttpUrl: string;
    tokenFile: string;
  },
): void {
  mkdirSync(dirname(file), { recursive: true });
  const config = {
    mcpServers: {
      manager: {
        type: "stdio",
        command: opts.launch.command,
        args: [...opts.launch.args, "--cp-url", opts.cpHttpUrl, "--self-session-id", opts.sessionId],
        env: { MANAGER_TOKEN_FILE: opts.tokenFile },
      },
    },
  };
  // 0600: the file carries the protected credential path and launch details. The mode is a POSIX no-op on Windows.
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows ACLs are managed by the owning account */ }
}

/** Best-effort removal of a session's mcp-config. force:true makes it a no-op for
 * non-conductor sessions, so the delete path can call it unconditionally. */
export function removeConductorMcpConfig(sessionId: string, configDir = defaultConfigDir()): void {
  try {
    rmSync(conductorMcpConfigPath(configDir, sessionId), { force: true });
  } catch {
    /* locked/EPERM — best-effort; the file only matters while the session exists */
  }
}

/** The argv tail injected into the conductor's `claude` launch (ClaudeCodeDriver spreads
 * opts.args first, so no driver change is needed). Every arg is validated single-line and
 * %-free — the two things winQuoteArg cannot deliver through cmd.exe. */
export function buildConductorArgs(mcpConfigPath: string, selfSessionId: string): string[] {
  const args = [
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    CONDUCTOR_READ_TOOLS.join(","),
    "--disallowedTools",
    CONDUCTOR_DISALLOWED_TOOLS.join(","),
    "--append-system-prompt",
    conductorSystemPrompt(selfSessionId),
  ];
  for (const a of args) {
    winQuoteArg(a); // throws on CR/LF — fail at provision time, not silently at spawn
    if (a.includes("%")) {
      throw new Error(`conductor arg contains '%', which cmd.exe expands even inside quotes: ${a.slice(0, 60)}`);
    }
  }
  return args;
}

/**
 * Provision a conductor launch spec IN PLACE: write the mcp-config file, append the claude
 * flags, and force permissionMode "default" (runner belt — the control plane clamp is the
 * enforcement). No-op for non-conductor specs; WSL conductors are skipped with a log (path
 * translation for the config file + a Linux-side entry are out of scope). Idempotent: a
 * spec whose args already carry --mcp-config is migrated to this runner's owned config directory.
 * The former shared file is deliberately left untouched because its owning runner is unknowable.
 */
export function provisionConductor(
  spec: ConductorLaunchSpec,
  config: {
    controlPlaneUrl: string;
    tokenFile: string;
    allowInsecureTransport?: boolean;
  },
  log: (msg: string) => void,
  host: ConductorHost = defaultConductorHost(),
): void {
  if (spec.agentId !== CONDUCTOR_AGENT_ID) return;
  if (spec.driver !== "claude-code") return;
  if ((spec.context?.kind ?? "native") === "wsl") {
    log(`conductor ${spec.sessionId}: WSL-context provisioning is not supported — starting without manager tools`);
    return;
  }
  // Belt for every conductor turn regardless of provisioning state: "default" is the only
  // mode where each mcp__manager__ mutation parks on a human Allow/Reject card.
  spec.config = { ...spec.config, permissionMode: "default" };

  const provisioned = spec.args.indexOf("--mcp-config");
  if (provisioned !== -1) {
    const prior = spec.args[provisioned + 1];
    if (!prior || prior.startsWith("--")) throw new Error("persisted conductor --mcp-config has no path");
    const file = conductorMcpConfigPath(host.configDir, spec.sessionId);
    writeConductorMcpConfig(file, {
      sessionId: spec.sessionId,
      launch: conductorMcpCommand(host),
      cpHttpUrl: deriveCpHttpUrl(config.controlPlaneUrl, config.allowInsecureTransport),
      tokenFile: config.tokenFile,
    });
    spec.args[provisioned + 1] = file;
    log(`conductor ${spec.sessionId}: mcp-config ${prior === file ? "refreshed" : "migrated"} ${file}`);
    return;
  }

  const cpHttpUrl = deriveCpHttpUrl(config.controlPlaneUrl, config.allowInsecureTransport);
  const launch = conductorMcpCommand(host);
  const file = conductorMcpConfigPath(host.configDir, spec.sessionId);
  writeConductorMcpConfig(file, { sessionId: spec.sessionId, launch, cpHttpUrl, tokenFile: config.tokenFile });
  spec.args = [...spec.args, ...buildConductorArgs(file, spec.sessionId)];
  log(`conductor ${spec.sessionId}: manager MCP provisioned (${file})`);
}

/**
 * Synthesize the "conductor" agent AFTER mergeAgents(), never inside discovery: a
 * configured claude entry shares the launch key "claude-code|native|claude" and would
 * suppress a discovered conductor via the merge's usedKeys check. Post-merge synthesis
 * covers config-ful and config-less (box) runners alike. Synthesis is skipped when any
 * agent already claims the id (a config-defined conductor wins) or when no available
 * native claude-code agent exists to donate the launch command.
 */
/**
 * Synthesis fenced on the control plane's protocol version (v91+).
 *
 * With the runner env gate removed, the device-local experiment toggle is the feature's only
 * gate — and only a v91+ control plane serves web bundles that default that toggle off and
 * read the versioned client storage. An older control plane's bundles default it ON and would
 * treat a legacy stored value as an opt-in, so advertising to them would surface the conductor
 * to users who never chose it. An unknown version (pre-registration) fails closed; the next
 * discovery merge after registration re-publishes with the version known. A config-DEFINED
 * conductor is explicit operator opt-in and is advertised regardless.
 */
export function applyConductorAdvertisementFence(
  agents: AgentDefinition[],
  controlPlaneProtocolVersion: number | null,
): AgentDefinition[] {
  return runnerSupportsProtocol(controlPlaneProtocolVersion ?? undefined, "ungatedConductorAdvertisement")
    ? withConductorAgent(agents)
    : agents;
}

export function withConductorAgent(agents: AgentDefinition[]): AgentDefinition[] {
  if (agents.some((a) => a.id === CONDUCTOR_AGENT_ID)) {
    // Config wins on IDENTITY (launch command/args/env), but the UI contract still applies:
    // a config-defined conductor inherits the full claude-code catalog capabilities, and
    // every mode except "default" is a dead option the CP clamp 409s mid-session.
    return agents.map((a) => {
      if (a.id !== CONDUCTOR_AGENT_ID || !a.capabilities) return a;
      const defaultControl = a.capabilities.supportsApprovals && a.capabilities.permissionModes?.includes("default");
      return {
        ...a,
        available: a.available === false ? false : defaultControl === true,
        capabilities: {
          ...a.capabilities,
          permissionModes: defaultControl ? ["default"] : [],
          ...(a.capabilities.elicitation
            ? {
                elicitation: defaultControl && a.capabilities.elicitation.default
                  ? { default: [...a.capabilities.elicitation.default] }
                  : undefined,
              }
            : {}),
        },
      };
    });
  }
  const donor = agents.find(
    (a) =>
      a.driver === "claude-code" &&
      (a.context?.kind ?? "native") === "native" &&
      a.available === true &&
      a.capabilities?.supportsApprovals === true &&
      a.capabilities.permissionModes?.includes("default"),
  );
  if (!donor) return agents;
  const caps = donor.capabilities;
  return [
    ...agents,
    {
      id: CONDUCTOR_AGENT_ID,
      name: "Conductor (Wollipog)",
      command: donor.command,
      // The donor's BASE args come too: an nvm-installed claude launches as
      // `node <cli.js>` — dropping the script arg would spawn bare node.
      args: [...(donor.args ?? [])],
      env: { ...donor.env },
      driver: "claude-code",
      context: { kind: "native" },
      version: donor.version,
      available: true,
      authStatus: donor.authStatus,
      // permissionModes ["default"] means the existing UI never offers another mode —
      // the CP clamp then makes it unreachable even for hand-rolled requests.
      capabilities: caps
        ? {
            ...caps,
            permissionModes: ["default"],
            ...(caps.elicitation
              ? {
                  elicitation: caps.elicitation.default
                    ? { default: [...caps.elicitation.default] }
                    : undefined,
                }
              : {}),
          }
        : undefined,
      source: "discovered",
      claudeCode: donor.claudeCode,
    },
  ];
}

