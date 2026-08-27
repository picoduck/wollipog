/** Runner configuration loading + CLI argument parsing. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { AcpEnvironmentReference, AcpMcpServerConfig, AgentContext, AgentDriverKind } from "@wollipog/protocol";
import { resolveAcpSessionContext } from "./acp-session-context.js";

export interface RunnerConfigAgent {
  id: string;
  name: string;
  command: string;
  args?: string[];
  /** Runner-local only. Literal values remain compatible; fromEnv defers host lookup to launch. */
  env?: Record<string, string | AcpEnvironmentReference>;
  /** Driver to use: "acp" (default), "claude-code", or "codex". */
  driver?: AgentDriverKind;
  /** Native (default) or { kind: "wsl", distro }. */
  context?: AgentContext;
  /** ACP MCP overrides. Same-name entries replace runner/workspace entries. */
  mcpServers?: AcpMcpServerConfig[];
  /** ACP is runner-local stdio. Any other JSON value is rejected at startup. */
  transport?: "stdio";
}

export interface RunnerConfigWorkspace {
  id: string;
  name: string;
  path: string;
  mcpServers?: AcpMcpServerConfig[];
  /** Exact absolute roots a user may opt into for an ACP session. */
  additionalDirectoryGrants?: string[];
}

export interface RunnerAdmissionPolicy {
  /** Maximum live processes for an exact configured/discovered agent id. */
  agentLimits: Record<string, number>;
  /** Box-capacity units consumed by one live process for an exact agent id. */
  agentWeights: Record<string, number>;
}

export interface RunnerSkillRetention {
  /** Keep all versions of a skill after it leaves desired state, enabling instant re-enable. */
  removedSkillDays: number;
  /** Keep superseded versions briefly so sessions using the prior tree remain consistent. */
  previousVersionMinutes: number;
}

export interface RunnerExecutionIsolation {
  /** Strict platform adapter. Job Objects are process-only; Seatbelt/bwrap also gate writes. */
  mode: "provider" | "bwrap" | "seatbelt" | "windows-job";
  /** bwrap/Seatbelt can deny network. Provider and Windows Job modes must inherit it. */
  network: "inherit" | "deny";
  /** This runner's owned orphan transcript partitions older than this are removed. */
  providerStateRetentionDays?: number;
  /** Oldest eligible runner-owned orphans are removed until their retained total is below this bound. */
  providerStateMaxBytes?: number;
}

export interface RunnerContainerSetupCheck {
  name: string;
  command: string;
  args?: string[];
}

/** Opt-in, locally available container image. Images are never pulled implicitly and must be
 * digest-pinned so a successful setup check describes one reproducible environment. */
export interface RunnerContainerTarget {
  id: string;
  name: string;
  revision: number;
  runtime: "docker" | "podman";
  image: string;
  network: "deny" | "bridge";
  agentCommands: Record<string, { command: string; args?: string[] }>;
  setupChecks: RunnerContainerSetupCheck[];
}

/** Operator-installed stdio proxy for a cloud sandbox. The runner prepares the handoff through
 * the adapter before starting the provider proxy; environment values are fromEnv references only. */
export interface RunnerCloudTarget {
  id: string;
  name: string;
  revision: number;
  adapterCommand: string;
  adapterArgs?: string[];
  adapterEnv?: Record<string, AcpEnvironmentReference>;
  image: string;
  setupCheckDigest: string;
  agentCommands: Record<string, { command: string; args?: string[] }>;
  policy: {
    maxConcurrentSessions: number;
    estimatedHourlyRateUsd: number;
    minimumBudgetUsd: number;
    maximumBudgetUsd: number;
  };
}

export interface RunnerConfig {
  runnerId: string;
  controlPlaneUrl: string;
  token: string;
  workspaces: RunnerConfigWorkspace[];
  agents: RunnerConfigAgent[];
  /** Exclusively owned host-native runner state root (sessions, credentials, worktrees, journals). */
  dataDir: string;
  /** Maximum simultaneously live agent processes on this box. */
  maxConcurrentSessions: number;
  /** Optional provider-aware quotas and capacity weights. Unlisted agents use limit=unbounded, weight=1. */
  admission: RunnerAdmissionPolicy;
  /** Bounded retention for verified content in the runner-local skill store. */
  skillRetention: RunnerSkillRetention;
  /** Runner-owned process/filesystem/network boundary. Defaults to provider-owned sandboxing. */
  executionIsolation: RunnerExecutionIsolation;
  /** Reproducible container placements checked before runner registration. */
  containerTargets: RunnerContainerTarget[];
  /** Provider-neutral cloud proxy placements. No built-in paid provider is implied. */
  cloudTargets: RunnerCloudTarget[];
  /** Lowest-precedence ACP MCP definitions. */
  mcpServers?: AcpMcpServerConfig[];
  /** Registry ids the operator allows this runner to advertise/install. Empty means deny all. */
  acpRegistryAgents: string[];
  features: {
    /** Preview gate; the user must additionally select a workspace grant per session. */
    acpAdditionalDirectories: boolean;
    /** Stabilized Registry metadata gate. Install execution still requires a separate confirmation. */
    acpRegistry?: boolean;
    /** Reserved policy gate. Cannot be enabled until the remote-transport threat model is met. */
    acpRemoteTransports?: boolean;
  };
}

export interface ParsedArgs {
  /** Path to a runner.config.json (defaults to ./runner.config.json; tolerated-missing when the
   * connection is supplied by flags/env instead, so a remote runner needs no JSON file). */
  configPath: string;
  /** Whether `--config` was passed explicitly (vs the default path). A missing/unreadable
   * EXPLICIT config is a hard error; only the missing DEFAULT is tolerated during config-less start. */
  explicitConfig: boolean;
  /** Connection/identity supplied directly via flags, taking precedence over the file. */
  overrides: Partial<RunnerConfig>;
  /** `--token-file <path>`: read the token from a file (keeps the secret out of argv). */
  tokenFile?: string;
  /** `--version` / `-v`: print the version and exit. */
  showVersion: boolean;
  /** Explicit one-time acknowledgement for claiming a populated pre-ownership data root. */
  adoptLegacyDataDir: boolean;
  /** Explicit acknowledgement that a remote ws:// connection exposes the runner credential. */
  allowInsecureTransport: boolean;
}

/**
 * Parse runner CLI args. Supports the legacy `--config <path>` plus config-less flags so the
 * runner can be launched remotely (e.g. over SSH) with no JSON file written on the box:
 *   --runner-id <id>  --control-plane-url <ws://…>  --token <secret>
 *   --workspace <id>:<path>  (repeatable)   --version|-v
 * Each long flag also accepts the `--flag=value` form.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  let configPath = "runner.config.json";
  let explicitConfig = false;
  let tokenFile: string | undefined;
  let showVersion = false;
  let adoptLegacyDataDir = false;
  let allowInsecureTransport = false;
  const overrides: Partial<RunnerConfig> = {};
  const workspaces: RunnerConfigWorkspace[] = [];

  // Returns [value, nextIndex] for either `--flag value` or `--flag=value`.
  const valueOf = (arg: string, i: number): [string | undefined, number] =>
    arg.includes("=") ? [arg.slice(arg.indexOf("=") + 1), i] : [argv[i + 1], i + 1];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--version" || arg === "-v") {
      showVersion = true;
    } else if (arg === "--adopt-legacy-data-dir") {
      adoptLegacyDataDir = true;
    } else if (arg === "--allow-insecure-transport") {
      allowInsecureTransport = true;
    } else if (arg === "--config" || arg === "-c" || arg.startsWith("--config=")) {
      const [v, ni] = valueOf(arg, i);
      if (v) { configPath = v; explicitConfig = true; i = ni; }
    } else if (arg === "--token-file" || arg.startsWith("--token-file=")) {
      const [v, ni] = valueOf(arg, i);
      if (v) { tokenFile = v; i = ni; }
    } else if (arg === "--runner-id" || arg.startsWith("--runner-id=")) {
      const [v, ni] = valueOf(arg, i);
      if (v) { overrides.runnerId = v; i = ni; }
    } else if (arg === "--control-plane-url" || arg.startsWith("--control-plane-url=")) {
      const [v, ni] = valueOf(arg, i);
      if (v) { overrides.controlPlaneUrl = v; i = ni; }
    } else if (arg === "--token" || arg.startsWith("--token=")) {
      const [v, ni] = valueOf(arg, i);
      if (v !== undefined) { overrides.token = v; i = ni; }
    } else if (arg === "--workspace" || arg.startsWith("--workspace=")) {
      const [v, ni] = valueOf(arg, i);
      const ws = parseWorkspaceArg(v);
      if (ws) { workspaces.push(ws); i = ni; }
    } else if (arg === "--data-dir" || arg.startsWith("--data-dir=")) {
      const [v, ni] = valueOf(arg, i);
      if (v) { overrides.dataDir = v; i = ni; }
    } else if (arg === "--max-concurrent-sessions" || arg.startsWith("--max-concurrent-sessions=")) {
      const [v, ni] = valueOf(arg, i);
      if (v) { overrides.maxConcurrentSessions = Number(v); i = ni; }
    }
  }
  if (workspaces.length) overrides.workspaces = workspaces;
  return {
    configPath: resolve(process.cwd(), configPath),
    explicitConfig,
    overrides,
    tokenFile,
    showVersion,
    adoptLegacyDataDir,
    allowInsecureTransport,
  };
}

/** Parse a `--workspace id:path` value. A bare `path` is allowed (id derives from the basename).
 * Splits on the FIRST colon, but leaves a Windows drive path (`C:\…`) as a bare path. */
export function parseWorkspaceArg(s: string | undefined): RunnerConfigWorkspace | null {
  if (!s) return null;
  const idx = s.indexOf(":");
  const looksWindowsDrive = /^[a-zA-Z]:[\\/]/.test(s);
  if (idx > 0 && !looksWindowsDrive) {
    const id = s.slice(0, idx);
    return { id, name: id, path: s.slice(idx + 1) };
  }
  const base = s.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "workspace";
  return { id: base, name: base, path: s };
}

/** Read connection/identity from env vars (config-less startup): RUNNER_ID, CONTROL_PLANE_URL,
 * RUNNER_TOKEN, RUNNER_WORKSPACES (JSON array). */
export function parseEnv(env: NodeJS.ProcessEnv = process.env): Partial<RunnerConfig> {
  const o: Partial<RunnerConfig> = {};
  if (env.RUNNER_ID) o.runnerId = env.RUNNER_ID;
  if (env.CONTROL_PLANE_URL) o.controlPlaneUrl = env.CONTROL_PLANE_URL;
  if (env.RUNNER_TOKEN !== undefined) o.token = env.RUNNER_TOKEN;
  if (env.RUNNER_DATA_DIR) o.dataDir = env.RUNNER_DATA_DIR;
  if (env.RUNNER_MAX_CONCURRENT_SESSIONS) o.maxConcurrentSessions = Number(env.RUNNER_MAX_CONCURRENT_SESSIONS);
  if (env.RUNNER_WORKSPACES) {
    try {
      const ws = JSON.parse(env.RUNNER_WORKSPACES) as RunnerConfigWorkspace[];
      if (Array.isArray(ws)) o.workspaces = ws;
    } catch {
      /* ignore malformed RUNNER_WORKSPACES */
    }
  }
  return o;
}

/** Resolve only genuinely-relative paths; leave Windows (C:\) and POSIX/WSL (/…) absolutes intact. */
export function resolveWorkspacePath(p: string): string {
  if (p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p)) return p;
  return resolve(p);
}

/** Read a runner.config.json. Tolerates a MISSING file when the connection is supplied another
 * way (flags/env, via `overrides`) — so a remotely-launched, config-less runner needs no file. */
function readConfigFile(
  configPath: string,
  overrides: Partial<RunnerConfig>,
  explicitConfig: boolean,
): Partial<RunnerConfig> {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const haveConn = Boolean(overrides.runnerId && overrides.controlPlaneUrl);
    // Tolerate ONLY a missing DEFAULT config during a config-less (flags/env) launch. An explicit
    // `--config`, or any non-ENOENT failure (permissions, etc.), is a hard error — we never
    // silently drop a config the operator asked us to merge.
    if (code === "ENOENT" && !explicitConfig && haveConn) return {};
    throw new Error(`could not read runner config at ${configPath}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Partial<RunnerConfig>;
  } catch (err) {
    throw new Error(`invalid JSON in ${configPath}: ${(err as Error).message}`);
  }
}

/**
 * Admission capacity for a runner that has not been configured explicitly. An idle resident
 * provider process holds a unit until it exits, so this is the number of sessions a developer
 * can leave open, not the number they can run at once.
 *
 * Capacity also sets the ceiling on concurrent worktree preparation and the maximum accepted
 * `agentWeights` value, so raising it widens those alongside admission. Operators on constrained
 * machines should set an explicit lower value rather than relying on this default.
 */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 16;

/** Merge config sources (precedence: overrides > file > defaults), validate, resolve paths. */
export function resolveConfig(file: Partial<RunnerConfig>, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  const runnerId = overrides.runnerId ?? file.runnerId;
  const controlPlaneUrl = overrides.controlPlaneUrl ?? file.controlPlaneUrl;
  if (!runnerId) throw new Error("runner config: 'runnerId' is required (set --runner-id, RUNNER_ID, or runnerId in the config)");
  if (!controlPlaneUrl) throw new Error("runner config: 'controlPlaneUrl' is required (set --control-plane-url, CONTROL_PLANE_URL, or controlPlaneUrl in the config)");
  const maxConcurrentSessions =
    overrides.maxConcurrentSessions ?? file.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
  if (!Number.isInteger(maxConcurrentSessions) || maxConcurrentSessions < 1 || maxConcurrentSessions > 256) {
    throw new Error("runner config: 'maxConcurrentSessions' must be an integer from 1 to 256");
  }
  const rawAdmission: Partial<RunnerAdmissionPolicy> = overrides.admission ?? file.admission ?? {};
  const agentLimits = validateAdmissionMap("agentLimits", rawAdmission.agentLimits, 256);
  const agentWeights = validateAdmissionMap("agentWeights", rawAdmission.agentWeights, maxConcurrentSessions);
  const rawSkillRetention: Partial<RunnerSkillRetention> =
    overrides.skillRetention ?? file.skillRetention ?? {};
  const removedSkillDays = rawSkillRetention.removedSkillDays ?? 7;
  if (!Number.isInteger(removedSkillDays) || removedSkillDays < 0 || removedSkillDays > 3650) {
    throw new Error("runner config: skillRetention.removedSkillDays must be an integer from 0 to 3650");
  }
  const previousVersionMinutes = rawSkillRetention.previousVersionMinutes ?? 60;
  if (!Number.isInteger(previousVersionMinutes) || previousVersionMinutes < 0 ||
      previousVersionMinutes > 525_600) {
    throw new Error(
      "runner config: skillRetention.previousVersionMinutes must be an integer from 0 to 525600",
    );
  }
  const rawIsolation = overrides.executionIsolation ?? file.executionIsolation ?? { mode: "provider", network: "inherit" };
  if (!["provider", "bwrap", "seatbelt", "windows-job"].includes(rawIsolation.mode)) {
    throw new Error("runner config: executionIsolation.mode must be 'provider', 'bwrap', 'seatbelt', or 'windows-job'");
  }
  if (rawIsolation.network !== "inherit" && rawIsolation.network !== "deny") {
    throw new Error("runner config: executionIsolation.network must be 'inherit' or 'deny'");
  }
  if ((rawIsolation.mode === "provider" || rawIsolation.mode === "windows-job") && rawIsolation.network !== "inherit") {
    throw new Error(`runner config: ${rawIsolation.mode} isolation cannot promise runner-owned network denial; use bwrap or seatbelt`);
  }
  const providerStateRetentionDays = rawIsolation.providerStateRetentionDays ?? 7;
  if (!Number.isInteger(providerStateRetentionDays) || providerStateRetentionDays < 0 || providerStateRetentionDays > 3650) {
    throw new Error("runner config: executionIsolation.providerStateRetentionDays must be an integer from 0 to 3650");
  }
  const providerStateMaxBytes = rawIsolation.providerStateMaxBytes ?? 5 * 1024 ** 3;
  if (!Number.isSafeInteger(providerStateMaxBytes) || providerStateMaxBytes < 1024 ** 2 || providerStateMaxBytes > 1024 ** 4) {
    throw new Error("runner config: executionIsolation.providerStateMaxBytes must be an integer from 1048576 to 1099511627776");
  }
  const workspaces = (overrides.workspaces ?? file.workspaces ?? []).map((w) => {
    const additionalDirectoryGrants = w.additionalDirectoryGrants?.map((grant) => {
      if (!configuredAbsolute(grant)) {
        throw new Error(`runner config: workspace '${w.id}' additional-directory grants must be absolute`);
      }
      return grant;
    });
    return { ...w, path: resolveWorkspacePath(w.path), additionalDirectoryGrants };
  });
  for (const workspace of workspaces) {
    if ((workspace.additionalDirectoryGrants?.length ?? 0) > 64) {
      throw new Error(`runner config: workspace '${workspace.id}' exceeds 64 additional-directory grants`);
    }
  }
  const agents = overrides.agents ?? file.agents ?? [];
  const containerTargets = validateContainerTargets(overrides.containerTargets ?? file.containerTargets ?? []);
  const cloudTargets = validateCloudTargets(overrides.cloudTargets ?? file.cloudTargets ?? []);
  const remoteEnabled = overrides.features?.acpRemoteTransports ?? file.features?.acpRemoteTransports ?? false;
  if (remoteEnabled) {
    throw new Error("runner config: ACP remote transports are not implemented; use runner-local stdio over SSH");
  }
  const acpRegistryAgents = overrides.acpRegistryAgents ?? file.acpRegistryAgents ?? [];
  if (acpRegistryAgents.length > 64 || acpRegistryAgents.some((id) => !/^[a-z][a-z0-9-]*$/.test(id))) {
    throw new Error("runner config: 'acpRegistryAgents' must contain at most 64 valid registry ids");
  }
  const mcpServers = overrides.mcpServers ?? file.mcpServers;
  // Reuse the runtime validator so malformed or plaintext-shaped definitions fail at startup,
  // before metadata registration or a session launch can persist them.
  resolveAcpSessionContext({ runner: mcpServers });
  for (const workspace of workspaces) resolveAcpSessionContext({ workspace: workspace.mcpServers });
  for (const agent of agents) {
    for (const [name, value] of Object.entries(agent.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new Error(`runner config: agent '${agent.id}' has invalid environment key '${name}'`);
      }
      if (typeof value === "string") continue;
      if (!value || typeof value !== "object" || Object.keys(value).length !== 1 ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value.fromEnv)) {
        throw new Error(`runner config: agent '${agent.id}' environment '${name}' must be a string or { fromEnv: "NAME" }`);
      }
    }
    const transport = (agent as { transport?: unknown }).transport;
    if (transport !== undefined && transport !== "stdio") {
      throw new Error(`runner config: agent '${agent.id}' uses unsupported ACP transport '${String(transport)}'; use stdio`);
    }
    if (transport === "stdio" && (agent.driver ?? "acp") !== "acp") {
      throw new Error(`runner config: agent '${agent.id}' may set transport only with the ACP driver`);
    }
    resolveAcpSessionContext({ agent: agent.mcpServers, context: agent.context });
  }
  return {
    runnerId,
    controlPlaneUrl,
    token: overrides.token ?? file.token ?? "",
    // ACP requires absolute paths; resolve genuinely-relative workspace paths (like ".")
    // against cwd, leaving Windows (C:\…) and POSIX/WSL (/home/…) absolutes intact.
    workspaces,
    agents,
    dataDir: resolveWorkspacePath(overrides.dataDir ?? file.dataDir ?? resolve(homedir(), ".agent-manager")),
    maxConcurrentSessions,
    admission: { agentLimits, agentWeights },
    skillRetention: { removedSkillDays, previousVersionMinutes },
    executionIsolation: {
      mode: rawIsolation.mode,
      network: rawIsolation.network,
      providerStateRetentionDays,
      providerStateMaxBytes,
    },
    containerTargets,
    cloudTargets,
    mcpServers,
    acpRegistryAgents: [...new Set(acpRegistryAgents)],
    features: {
      acpAdditionalDirectories: overrides.features?.acpAdditionalDirectories ?? file.features?.acpAdditionalDirectories ?? false,
      acpRegistry: overrides.features?.acpRegistry ?? file.features?.acpRegistry ?? false,
      acpRemoteTransports: false,
    },
  };
}

function validateContainerTargets(value: RunnerContainerTarget[]): RunnerContainerTarget[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("runner config: 'containerTargets' must be an array with at most 16 entries");
  }
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`runner config: containerTargets[${index}] must be an object`);
    }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(raw.id) || ids.has(raw.id)) {
      throw new Error(`runner config: container target id '${String(raw.id)}' must be unique and kebab-case`);
    }
    ids.add(raw.id);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error(`runner config: container target '${raw.id}' name must contain 1 to 100 characters`);
    }
    if (!Number.isInteger(raw.revision) || raw.revision < 1 || raw.revision > 1_000_000) {
      throw new Error(`runner config: container target '${raw.id}' revision must be an integer from 1 to 1000000`);
    }
    if (raw.runtime !== "docker" && raw.runtime !== "podman") {
      throw new Error(`runner config: container target '${raw.id}' runtime must be 'docker' or 'podman'`);
    }
    if (typeof raw.image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}@sha256:[a-f0-9]{64}$/.test(raw.image)) {
      throw new Error(`runner config: container target '${raw.id}' image must be pinned as name@sha256:<64 lowercase hex>`);
    }
    if (raw.network !== "deny" && raw.network !== "bridge") {
      throw new Error(`runner config: container target '${raw.id}' network must be 'deny' or 'bridge'`);
    }
    const commandEntries = Object.entries(raw.agentCommands ?? {});
    if (commandEntries.length < 1 || commandEntries.length > 32) {
      throw new Error(`runner config: container target '${raw.id}' must map 1 to 32 agent commands`);
    }
    const agentCommands: RunnerContainerTarget["agentCommands"] = {};
    for (const [agentId, commandSpec] of commandEntries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId) ||
          !commandSpec || typeof commandSpec !== "object" ||
          typeof commandSpec.command !== "string" || !/^[A-Za-z0-9_./+-]{1,256}$/.test(commandSpec.command)) {
        throw new Error(`runner config: container target '${raw.id}' has an invalid command for agent '${agentId}'`);
      }
      const args = commandSpec.args ?? [];
      if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== "string" || arg.length > 512 || arg.includes("\0"))) {
        throw new Error(`runner config: container target '${raw.id}' has invalid command arguments for agent '${agentId}'`);
      }
      agentCommands[agentId] = { command: commandSpec.command, args: [...args] };
    }
    if (!Array.isArray(raw.setupChecks) || raw.setupChecks.length < 1 || raw.setupChecks.length > 16) {
      throw new Error(`runner config: container target '${raw.id}' must define 1 to 16 setup checks`);
    }
    const checkNames = new Set<string>();
    const setupChecks = raw.setupChecks.map((check, checkIndex) => {
      const checkName = typeof check?.name === "string" ? check.name.trim() : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/.test(checkName) || checkNames.has(checkName)) {
        throw new Error(`runner config: container target '${raw.id}' setup check ${checkIndex} has an invalid or duplicate name`);
      }
      checkNames.add(checkName);
      if (typeof check.command !== "string" || !/^[A-Za-z0-9_./+-]{1,256}$/.test(check.command)) {
        throw new Error(`runner config: container target '${raw.id}' setup check '${checkName}' has an invalid command`);
      }
      const args = check.args ?? [];
      if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== "string" || arg.length > 512 || arg.includes("\0"))) {
        throw new Error(`runner config: container target '${raw.id}' setup check '${checkName}' has invalid arguments`);
      }
      return { name: checkName, command: check.command, args: [...args] };
    });
    return { id: raw.id, name, revision: raw.revision, runtime: raw.runtime, image: raw.image, network: raw.network, agentCommands, setupChecks };
  });
}

function validateCloudTargets(value: RunnerCloudTarget[]): RunnerCloudTarget[] {
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("runner config: 'cloudTargets' must be an array with at most 16 entries");
  }
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`runner config: cloudTargets[${index}] must be an object`);
    }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(raw.id) || ids.has(raw.id)) {
      throw new Error(`runner config: cloud target id '${String(raw.id)}' must be unique and kebab-case`);
    }
    ids.add(raw.id);
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error(`runner config: cloud target '${raw.id}' name must contain 1 to 100 characters`);
    }
    if (!Number.isInteger(raw.revision) || raw.revision < 1 || raw.revision > 1_000_000) {
      throw new Error(`runner config: cloud target '${raw.id}' revision must be an integer from 1 to 1000000`);
    }
    if (typeof raw.adapterCommand !== "string" || !/^[A-Za-z0-9_./+\\:-]{1,512}$/.test(raw.adapterCommand)) {
      throw new Error(`runner config: cloud target '${raw.id}' adapterCommand is invalid`);
    }
    const adapterArgs = raw.adapterArgs ?? [];
    if (!Array.isArray(adapterArgs) || adapterArgs.length > 32 ||
        adapterArgs.some((arg) => typeof arg !== "string" || arg.length > 512 || /[\0\r\n]/.test(arg))) {
      throw new Error(`runner config: cloud target '${raw.id}' adapterArgs are invalid`);
    }
    const adapterEnv: Record<string, AcpEnvironmentReference> = {};
    const envEntries = Object.entries(raw.adapterEnv ?? {});
    if (envEntries.length > 32) throw new Error(`runner config: cloud target '${raw.id}' has too many adapter environment references`);
    for (const [nameKey, reference] of envEntries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(nameKey) || !reference || typeof reference !== "object" ||
          Object.keys(reference).length !== 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.fromEnv)) {
        throw new Error(`runner config: cloud target '${raw.id}' adapter environment '${nameKey}' must be { fromEnv: "NAME" }`);
      }
      adapterEnv[nameKey] = { fromEnv: reference.fromEnv };
    }
    if (typeof raw.image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}@sha256:[a-f0-9]{64}$/.test(raw.image) ||
        !/^[a-f0-9]{64}$/.test(raw.setupCheckDigest)) {
      throw new Error(`runner config: cloud target '${raw.id}' requires a digest-pinned image and setupCheckDigest`);
    }
    const commandEntries = Object.entries(raw.agentCommands ?? {});
    if (commandEntries.length < 1 || commandEntries.length > 32) {
      throw new Error(`runner config: cloud target '${raw.id}' must map 1 to 32 agent commands`);
    }
    const agentCommands: RunnerCloudTarget["agentCommands"] = {};
    for (const [agentId, commandSpec] of commandEntries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId) || !commandSpec || typeof commandSpec !== "object" ||
          typeof commandSpec.command !== "string" || !/^[A-Za-z0-9_./+-]{1,256}$/.test(commandSpec.command)) {
        throw new Error(`runner config: cloud target '${raw.id}' has an invalid command for agent '${agentId}'`);
      }
      const args = commandSpec.args ?? [];
      if (!Array.isArray(args) || args.length > 32 || args.some((arg) => typeof arg !== "string" || arg.length > 512 || arg.includes("\0"))) {
        throw new Error(`runner config: cloud target '${raw.id}' has invalid command arguments for agent '${agentId}'`);
      }
      agentCommands[agentId] = { command: commandSpec.command, args: [...args] };
    }
    const policy = raw.policy;
    if (!policy || typeof policy !== "object" || !Number.isInteger(policy.maxConcurrentSessions) ||
        policy.maxConcurrentSessions < 1 || policy.maxConcurrentSessions > 256) {
      throw new Error(`runner config: cloud target '${raw.id}' maxConcurrentSessions must be an integer from 1 to 256`);
    }
    for (const [field, amount] of Object.entries({
      estimatedHourlyRateUsd: policy.estimatedHourlyRateUsd,
      minimumBudgetUsd: policy.minimumBudgetUsd,
      maximumBudgetUsd: policy.maximumBudgetUsd,
    })) {
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
        throw new Error(`runner config: cloud target '${raw.id}' ${field} must be a finite positive USD amount`);
      }
    }
    if (policy.minimumBudgetUsd > policy.maximumBudgetUsd) {
      throw new Error(`runner config: cloud target '${raw.id}' minimumBudgetUsd cannot exceed maximumBudgetUsd`);
    }
    return {
      id: raw.id, name, revision: raw.revision, adapterCommand: raw.adapterCommand,
      adapterArgs: [...adapterArgs], adapterEnv, image: raw.image, setupCheckDigest: raw.setupCheckDigest,
      agentCommands,
      policy: {
        maxConcurrentSessions: policy.maxConcurrentSessions,
        estimatedHourlyRateUsd: policy.estimatedHourlyRateUsd,
        minimumBudgetUsd: policy.minimumBudgetUsd,
        maximumBudgetUsd: policy.maximumBudgetUsd,
      },
    };
  });
}

/** Resolve one configured agent's environment only at process-launch time. */
export function resolveAgentEnvironment(
  agent: Pick<RunnerConfigAgent, "id" | "env">,
  hostEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, source] of Object.entries(agent.env ?? {})) {
    if (typeof source === "string") {
      resolved[name] = source;
      continue;
    }
    const value = hostEnv[source.fromEnv];
    if (value === undefined) {
      throw new Error(`agent '${agent.id}' requires a runner-local environment variable for '${name}'`);
    }
    resolved[name] = value;
  }
  return resolved;
}

function validateAdmissionMap(name: string, value: Record<string, number> | undefined, maximum: number): Record<string, number> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`runner config: admission.${name} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.length > 64) throw new Error(`runner config: admission.${name} exceeds 64 agent policies`);
  const normalized: Record<string, number> = {};
  for (const [agentId, setting] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(agentId)) {
      throw new Error(`runner config: admission.${name} contains invalid agent id '${agentId}'`);
    }
    if (!Number.isInteger(setting) || setting < 1 || setting > maximum) {
      throw new Error(`runner config: admission.${name}.${agentId} must be an integer from 1 to ${maximum}`);
    }
    normalized[agentId] = setting;
  }
  return normalized;
}

function configuredAbsolute(path: string): boolean {
  return typeof path === "string" && (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\"));
}

export function loadConfig(
  configPath: string,
  overrides: Partial<RunnerConfig> = {},
  explicitConfig = false,
): RunnerConfig {
  return resolveConfig(readConfigFile(configPath, overrides, explicitConfig), overrides);
}
