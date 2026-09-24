/**
 * Agent discovery: probe the host (and every WSL distro) for installed agent CLIs,
 * returning extended AgentDefinitions with version, auth status, and capabilities.
 * Discovered agents augment the static runner config — config entries win on conflict
 * so user overrides (custom args/env/tokens) are preserved.
 */

import { readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentContextKey } from "@wollipog/protocol";
import type {
  AcpRuntimeCapabilities,
  AgentCapabilities,
  AgentContext,
  AgentDefinition,
  AgentDriverKind,
  AgentSlashCommand,
} from "@wollipog/protocol";
import { AcpClient } from "../acp.js";
import { capabilitiesFor } from "../catalog.js";
import {
  applyClaudeAgentEnvironment,
  applyNativeClaudeGitBashReadiness,
  claudeCapabilitiesFromProbe,
  probeNativeClaudeCode,
  probeWslClaudeCode,
  resolveNativeClaudeGitBash,
  unavailableClaudeCode,
} from "./claude-code.js";
import { probeNativeCodexAppServer, probeWslCodexAppServer, unavailableCodexAppServer } from "./codex-app-server.js";
import { discoverAgentModels, type AgentModelDiscovery } from "./models.js";
import { checkHarnessUpdate } from "./harness-updates.js";
import { unavailableNativeTuiAccounting } from "./native-tui-accounting.js";
import { probePiRpc, unavailablePiCapabilities } from "./pi-rpc.js";
import { launchTargetStillMatches, listWslDistros, resolveInWsl, resolveInWslCandidates, resolveNativeCandidates, resolvedLaunchIdentity, run, type ResolvedBinary, type ResolvedLaunch } from "./resolve.js";
import { invalidateStaleNativeInstallation } from "./stale-installation.js";

const CONFIGURED_ACP_PROBE_TIMEOUT_MS = 20_000;
const MAX_CONCURRENT_CONFIGURED_ACP_PROBES = 4;

/** Verify an operator-configured ACP launch with the protocol's side-effect-free initialize call.
 * Provider stderr and thrown diagnostics are deliberately reduced to fixed operator guidance: a
 * configured launch may receive credentials, so neither its environment nor its output may enter
 * runner metadata. */
export async function probeConfiguredAcpAgent(
  agent: AgentDefinition,
  env: Record<string, string>,
  options: { cwd?: string; timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<AgentDefinition> {
  const context = agent.context ?? { kind: "native" as const };
  if (context.kind === "wsl" && (options.platform ?? process.platform) !== "win32") {
    return {
      ...agent,
      env: {},
      available: false,
      unavailableReason: "This WSL launch target is incompatible with a non-Windows runner.",
    };
  }

  let exited = false;
  let spawnFailed = false;
  let capabilities: AcpRuntimeCapabilities | undefined;
  let client: AcpClient | undefined;
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    client = new AcpClient({
      command: agent.command,
      args: [...(agent.args ?? [])],
      cwd: options.cwd ?? process.cwd(),
      env,
      context,
      initializeOnly: true,
    }, {
      onEvent: () => {},
      onStderr: (text) => { if (text.startsWith("spawn error:")) spawnFailed = true; },
      onExit: () => { exited = true; },
      onAcpCapabilities: (value) => { capabilities = value; },
    });
    await Promise.race([
      client.initialize(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("configured ACP probe timed out"));
        }, options.timeoutMs ?? CONFIGURED_ACP_PROBE_TIMEOUT_MS);
      }),
    ]);
    return {
      ...agent,
      env: {},
      available: true,
      unavailableReason: undefined,
      ...(capabilities ? { acp: capabilities } : {}),
    };
  } catch {
    const unavailableReason = spawnFailed
      ? "The configured command was not found or could not be started in this execution context."
      : exited
        ? "The configured launch exited before completing an ACP initialize probe. Check its command and arguments."
        : timedOut
          ? "The configured launch did not complete an ACP initialize probe before the timeout."
          : "The configured launch did not return a valid ACP initialize response.";
    return { ...agent, env: {}, available: false, unavailableReason };
  } finally {
    if (timer) clearTimeout(timer);
    client?.dispose();
  }
}

/** Probe configured ACP entries independently so one missing environment reference or broken
 * adapter cannot suppress discovery for the rest of the runner. */
export async function probeConfiguredAcpAgents(
  agents: AgentDefinition[],
  resolveEnv: (agentId: string) => Record<string, string>,
  options: { cwd?: string; timeoutMs?: number; platform?: NodeJS.Platform } = {},
): Promise<AgentDefinition[]> {
  const pending = agents.filter((agent) => (agent.driver ?? "acp") === "acp");
  const results = new Array<AgentDefinition>(pending.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      const index = next++;
      const agent = pending[index]!;
      try {
        results[index] = await probeConfiguredAcpAgent(agent, resolveEnv(agent.id), options);
      } catch {
        results[index] = {
          ...agent,
          env: {},
          available: false,
          unavailableReason: "The configured launch environment could not be resolved on this runner.",
        };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_CONFIGURED_ACP_PROBES, pending.length) },
    () => worker(),
  ));
  return results;
}

/** Probe configured Pi entries with their runner-resolved environment. The result is reduced to
 * metadata before it leaves the runner; credentials and provider diagnostics never cross the
 * control-plane boundary. */
export async function probeConfiguredPiAgents(
  agents: AgentDefinition[],
  resolveEnv: (agentId: string) => Record<string, string>,
  options: {
    cwd?: string;
    timeoutMs?: number;
    platform?: NodeJS.Platform;
    probe?: typeof probePiRpc;
    discovered?: AgentDefinition[];
  } = {},
): Promise<AgentDefinition[]> {
  const pending = agents.filter((agent) => agent.driver === "pi");
  const results = new Array<AgentDefinition>(pending.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      const index = next++;
      const agent = pending[index]!;
      const context = agent.context ?? { kind: "native" as const };
      if (context.kind === "wsl" && (options.platform ?? process.platform) !== "win32") {
        results[index] = {
          ...agent,
          env: {},
          available: false,
          unavailableReason: "This WSL launch target is incompatible with a non-Windows runner.",
        };
        continue;
      }
      try {
        const env = resolveEnv(agent.id);
        const shapeMatch = options.discovered?.find((candidate) =>
          launchKeys(agent).some((key) => launchKeys(candidate).includes(key)));
        const adoptLaunch = Boolean(shapeMatch) && !/[\\/]/.test(agent.command) && /[\\/]/.test(shapeMatch!.command);
        const launchAgent = adoptLaunch
          ? { ...shapeMatch!, args: [...(shapeMatch!.args ?? []), ...(agent.args ?? [])] }
          : agent;
        const exactLaunchMatch = Boolean(shapeMatch) && agent.command === shapeMatch!.command &&
          JSON.stringify(agent.args ?? []) === JSON.stringify(shapeMatch!.args ?? []);
        const unchangedAdoptedLaunch = adoptLaunch && (agent.args?.length ?? 0) === 0;
        if (shapeMatch && Object.keys(env).length === 0 && (unchangedAdoptedLaunch || exactLaunchMatch)) {
          results[index] = {
            ...agent,
            command: launchAgent.command,
            args: [...(launchAgent.args ?? [])],
            env: {},
            version: agent.version ?? shapeMatch.version,
            available: shapeMatch.available,
            authStatus: shapeMatch.authStatus,
            capabilities: shapeMatch.capabilities,
            piAgentControl: shapeMatch.piAgentControl,
            unavailableReason: shapeMatch.unavailableReason,
          };
          continue;
        }
        const result = await (options.probe ?? probePiRpc)(
          { command: launchAgent.command, args: [...(launchAgent.args ?? [])] },
          context,
          {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            env,
          },
        );
        results[index] = {
          ...agent,
          command: launchAgent.command,
          args: [...(launchAgent.args ?? [])],
          env: {},
          available: result.available,
          authStatus: result.authStatus,
          capabilities: result.capabilities,
          piAgentControl: result.piAgentControl,
          unavailableReason: result.unavailableReason,
        };
      } catch {
        results[index] = {
          ...agent,
          env: {},
          available: false,
          authStatus: "unknown",
          capabilities: unavailablePiCapabilities(),
          unavailableReason: "The configured Pi launch environment could not be resolved or probed on this runner.",
        };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_CONFIGURED_ACP_PROBES, pending.length) },
    () => worker(),
  ));
  return results;
}

/** Where each driver keeps user-defined slash commands / prompts ($HOME-relative). */
const COMMAND_DIRS: Partial<Record<AgentDriverKind, { dir: string; source: AgentSlashCommand["source"] }[]>> = {
  "claude-code": [{ dir: ".claude/commands", source: "user" }],
};

/** Filesystem command sources actually supported by the provider. Codex prompts/skills are not
 * slash commands and must not be advertised as such. Exported to keep that boundary regression-tested. */
export function commandDirectoriesForDriver(
  driver: AgentDriverKind,
): readonly { dir: string; source: AgentSlashCommand["source"] }[] {
  return COMMAND_DIRS[driver] ?? [];
}

function nativeSlashCommands(driver: AgentDriverKind): AgentSlashCommand[] {
  const out: AgentSlashCommand[] = [];
  for (const { dir, source } of commandDirectoriesForDriver(driver)) {
    try {
      for (const f of readdirSync(join(homedir(), dir))) {
        if (f.endsWith(".md")) out.push({ name: f.slice(0, -3), source });
      }
    } catch {
      /* dir absent */
    }
  }
  return out;
}

async function wslSlashCommands(distro: string, driver: AgentDriverKind): Promise<AgentSlashCommand[]> {
  const out: AgentSlashCommand[] = [];
  for (const { dir, source } of commandDirectoriesForDriver(driver)) {
    const r = await run("wsl.exe", ["-d", distro, "--exec", "sh", "-c", `ls "$HOME/${dir}"/*.md 2>/dev/null`], {
      timeoutMs: 6000,
    });
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.trim().match(/([^/\\]+)\.md$/);
      if (m) out.push({ name: m[1]!, source });
    }
  }
  return out;
}

/** Discovery is only a UI/admission precondition. The root-installed launcher repeats every
 * executable and kernel check immediately before preparing a launch, so this cannot become an
 * authority-bearing pathname check. Keep the probe fixed to distro-owned system paths. */
async function probeWslSafeLauncher(distro: string, nodeRuntime: string | undefined): Promise<{ bwrapRuntime: string } | null> {
  if (!nodeRuntime?.startsWith("/") || /[\0\r\n]/u.test(nodeRuntime)) return null;
  const script = [
    "set -eu",
    "node=$1",
    "test \"$(id -u)\" != 0",
    "compiler=$(readlink -f /usr/bin/cc); case \"$compiler\" in /usr/bin/*) ;; *) exit 125;; esac",
    "for file in \"$compiler\" /usr/bin/bwrap \"$node\"; do",
    "  test -f \"$file\" && test ! -L \"$file\"",
    "  while test \"$file\" != /; do",
    "    test ! -L \"$file\"; test \"$(stat -c %u \"$file\")\" = 0",
    "    mode=$(stat -c %a \"$file\"); test $((0$mode & 022)) = 0",
    "    file=${file%/*}; test -n \"$file\" || file=/",
    "  done",
    "done",
    "/usr/bin/bwrap --help",
  ].join("\n");
  const result = await run("wsl.exe", ["-d", distro, "--exec", "sh", "-c", script, "wollipog-probe", nodeRuntime], { timeoutMs: 5_000 });
  if (result.code !== 0) return null;
  const help = `${result.stdout}\n${result.stderr}`;
  return ["--bind-fd", "--ro-bind-fd"].every((flag) => help.includes(flag))
    ? { bwrapRuntime: "/usr/bin/bwrap" }
    : null;
}

/** Curated capabilities + the agent's discovered slash commands. Dynamic model discovery is applied
 * to the merged agent list afterward (enrichAgentModels), so config + discovered agents share it. */
function withSlashCommands(driver: AgentDriverKind, slashCommands: AgentSlashCommand[]): AgentCapabilities | undefined {
  const caps = capabilitiesFor(driver);
  return caps ? { ...caps, slashCommands } : undefined;
}

/** Same-turn steering and image tool results are transport contract evidence, never a static
 * driver-name assumption. A supported Codex App Server hands an MCP tool's image content to the
 * model as image input (reviewed end to end while dogfooding #1492); whether a given model accepts
 * it is that model's own `inputModalities`. */
function verifiedCodexAppServerCapabilities(
  slashCommands: AgentSlashCommand[],
  compatibility: NonNullable<AgentDefinition["codexAppServer"]>,
): AgentCapabilities | undefined {
  const caps = withSlashCommands("codex-app-server", slashCommands);
  return caps && compatibility.status === "supported"
    ? { ...caps, supportsSteering: true, imageToolResults: true }
    : caps;
}

function withoutConfiguredProviderAttestations(agent: AgentDefinition): AgentDefinition {
  // Native TUI accounting is a live provider-contract attestation, never configuration. A stale
  // persisted value must not survive when a v121 runner cannot rediscover the same launch.
  const {
    nativeTuiAccounting: _unverifiedAccounting,
    piAgentControl: _unverifiedPiAgentControl,
    ...withoutAccounting
  } = agent;
  const codexAppServer = withoutAccounting.codexAppServer;
  const { orchestratorApproval: _unverifiedOrchestratorApproval, ...verifiedCodexAppServer } = codexAppServer ?? {};
  const unattested = withoutConfiguredImageToolResults(codexAppServer
    ? { ...withoutAccounting, codexAppServer: verifiedCodexAppServer as typeof codexAppServer }
    : withoutAccounting);
  if ((agent.driver !== "codex-app-server" && agent.driver !== "claude-code" && agent.driver !== "pi") ||
      !unattested.capabilities?.supportsSteering) {
    return unattested;
  }
  const { supportsSteering: _unverified, ...capabilities } = unattested.capabilities;
  return { ...unattested, capabilities };
}

/** Image tool results decide who may approve UI evidence, so no configuration can claim them. */
function withoutConfiguredImageToolResults(agent: AgentDefinition): AgentDefinition {
  if (agent.capabilities?.imageToolResults === undefined) return agent;
  const { imageToolResults: _unverified, ...capabilities } = agent.capabilities;
  return { ...agent, capabilities };
}

/** `driver|context` key so agents sharing an execution context read the same model source once. */
function modelKey(a: AgentDefinition): string {
  const ctx = a.context ?? { kind: "native" as const };
  const contextKey = ctx.kind === "wsl" ? `wsl:${ctx.distro}` : "native";
  return JSON.stringify([a.driver ?? "acp", contextKey, a.version ?? "unknown-version", a.command, ...(a.args ?? [])]);
}

/**
 * Apply DYNAMIC model discovery to a finished agent list: query each resolved version/context once
 * and override normalized capabilities on every agent sharing that launch. Covers config +
 * discovered agents alike; agents whose driver has no dynamic source keep the
 * catalog's models. Best-effort — a read failure just leaves the catalog list in place.
 */
export async function enrichAgentModels(
  agents: AgentDefinition[],
  options: { refresh?: boolean } = {},
): Promise<AgentDefinition[]> {
  const pairs = new Map<string, AgentDefinition>();
  for (const agent of agents) pairs.set(modelKey(agent), agent);
  const discoveries = new Map<string, AgentModelDiscovery>();
  await Promise.all(
    [...pairs].map(async ([key, agent]) => {
      discoveries.set(key, await discoverAgentModels(agent, options));
    }),
  );
  return agents.map((agent) => applyAgentModelDiscovery(agent, discoveries.get(modelKey(agent))));
}

/** Pure normalized-capability projection, exported so hidden-model aggregation stays regression-tested. */
export function applyAgentModelDiscovery(
  agent: AgentDefinition,
  discovery: AgentModelDiscovery | undefined,
): AgentDefinition {
  if (!discovery?.models.length || !agent.capabilities) return agent;
  const models = agent.claudeCode
    ? discovery.models.map((model) => {
        if (!model.efforts?.length) return model;
        const efforts = model.efforts.filter((effort) => agent.claudeCode!.effortLevels.includes(effort));
        return { ...model, efforts: efforts.length ? efforts : undefined };
      })
    : discovery.models;
  const visible = models.filter((model) => !model.hidden);
  const efforts = [...new Set(visible.flatMap((model) => model.efforts ?? []))];
  const advertisedModalities = visible.flatMap((model) => model.inputModalities ?? []);
  return {
    ...agent,
    capabilities: {
      ...agent.capabilities,
      models,
      modelSource: discovery.source,
      effortLevels: agent.claudeCode
        ? agent.claudeCode.effortLevels
        : efforts.length ? efforts : agent.capabilities.effortLevels,
      supportsImages: agent.claudeCode
        ? agent.claudeCode.streamJsonImages && (
            advertisedModalities.length ? advertisedModalities.includes("image") : agent.capabilities.supportsImages
          )
        : advertisedModalities.length
          ? advertisedModalities.includes("image")
          : agent.capabilities.supportsImages,
    },
  };
}

interface KnownAgent {
  id: string;
  name: string;
  /** Binary name to resolve on PATH / inside the distro. */
  bin: string;
  driver: AgentDriverKind;
  /** Path under $HOME whose existence means the agent is logged in. */
  authFile?: string;
}

const KNOWN: KnownAgent[] = [
  { id: "claude-code", name: "Claude Code", bin: "claude", driver: "claude-code", authFile: ".claude/.credentials.json" },
  { id: "codex", name: "Codex", bin: "codex", driver: "codex", authFile: ".codex/auth.json" },
  { id: "pi", name: "Pi", bin: "pi", driver: "pi" },
];

/** The logical installation entry point survives upgrades that replace its symlink target.
 * The context keeps a WSL path distinct from the same path on the native host. */
function installationId(context: AgentContext, bin: ResolvedBinary): string {
  return createHash("sha256").update(JSON.stringify([agentContextKey(context), bin.path])).digest("hex").slice(0, 16);
}

function codexExecId(primaryId: string): string {
  if (primaryId === "codex") return "codex-exec";
  const wsl = primaryId.replace(/^codex-wsl-/, "codex-exec-wsl-");
  return wsl === primaryId ? `${primaryId}-exec` : wsl;
}

/** One resolved Codex launch becomes an app-server primary plus an explicit non-interactive row. */
export function codexAgentDefinitions(
  base: AgentDefinition,
  compatibility: NonNullable<AgentDefinition["codexAppServer"]>,
  slashCommands: AgentSlashCommand[],
): AgentDefinition[] {
  const supported = compatibility.status === "supported";
  // An installed-but-signed-out Codex accepts a session and then fails every turn with an
  // OpenAI 401 behind a reconnect loop, so it is not ready — mirror Claude, whose readiness
  // already folds auth in. "unknown" stays selectable: only a confirmed missing login gates.
  const signedIn = base.authStatus !== "unauthenticated";
  const primary: AgentDefinition = {
    ...base,
    driver: "codex-app-server",
    available: supported && signedIn,
    capabilities: verifiedCodexAppServerCapabilities(slashCommands, compatibility),
    codexAppServer: compatibility,
    ...(base.authStatus === "authenticated" ? { codexBillingSource: "provider_account" as const } : {}),
  };
  const exec: AgentDefinition = {
    ...base,
    id: codexExecId(base.id),
    name: `${base.name} (Non-Interactive)`,
    driver: "codex",
    available: signedIn,
    capabilities: withSlashCommands("codex", slashCommands),
    codexAppServer: compatibility,
    ...(base.authStatus === "authenticated" ? { codexBillingSource: "provider_account" as const } : {}),
  };
  return [primary, exec];
}

/** A replacement during native probes cannot inherit their version or a different driver row. */
export function nativeDiscoveredDefinitions(
  base: AgentDefinition,
  codexAppServer: AgentDefinition["codexAppServer"],
  slashCommands: AgentSlashCommand[],
): AgentDefinition[] {
  const candidates = codexAppServer ? codexAgentDefinitions(base, codexAppServer, slashCommands) : [base];
  const checked = invalidateStaleNativeInstallation(candidates[0]!);
  return checked !== candidates[0] ? [checked] : candidates;
}

/** An explicit agent-config `OPENAI_API_KEY` is a deliberate API-billing Codex setup: the drivers
 * honor it (they scrub only the daemon-inherited key), so a missing `~/.codex/auth.json` must not
 * gate that entry. Mirrors the Claude config-auth carve-out applied in the same merge.
 *
 * The key itself is not visible here in production — the runner redacts config env before the
 * merge — so the trigger is the config row's non-secret auth assertion (set where the env is
 * redacted). For an already-authenticated discovered row the recompute is a no-op, because the
 * availability formula below equals the discovery gate with a confirmed login. */
export function applyCodexAgentEnvironment(agent: AgentDefinition, preserveAvailability = false): AgentDefinition {
  if (agent.driver !== "codex" && agent.driver !== "codex-app-server") return agent;
  if (!agent.env?.OPENAI_API_KEY && agent.authStatus !== "authenticated") return agent;
  return {
    ...agent,
    authStatus: "authenticated",
    ...(agent.env?.OPENAI_API_KEY ? { codexBillingSource: "api" as const } : {}),
    available: preserveAvailability
      ? agent.available
      : agent.driver === "codex-app-server"
        ? agent.codexAppServer?.status === "supported"
        : true,
  };
}

/** Keep Codex absence explicit per context without advertising a non-existent exec fallback. */
export function unavailableCodexAgentDefinition(
  id: string,
  name: string,
  context: AgentContext,
): AgentDefinition {
  return {
    id,
    name,
    command: "codex",
    args: [],
    env: {},
    bin: "codex",
    driver: "codex-app-server",
    context,
    available: false,
    authStatus: "unknown",
    capabilities: withSlashCommands("codex-app-server", []),
    source: "discovered",
    codexAppServer: unavailableCodexAppServer(),
    nativeTuiAccounting: unavailableNativeTuiAccounting("codex", undefined, false),
  };
}

/** Keep Claude absence explicit per context so missing-install remediation is visible. */
export function unavailableClaudeAgentDefinition(
  id: string,
  name: string,
  context: AgentContext,
): AgentDefinition {
  const claudeCode = unavailableClaudeCode();
  return {
    id,
    name,
    command: "claude",
    args: [],
    env: {},
    bin: "claude",
    driver: "claude-code",
    context,
    available: false,
    authStatus: "unknown",
    capabilities: withSlashCommands("claude-code", []),
    source: "discovered",
    claudeCode,
    nativeTuiAccounting: unavailableNativeTuiAccounting("claude-code", undefined, false),
  };
}

/** Keep Pi absence explicit so onboarding can offer exact installation guidance without ever
 * presenting a configured-but-unverified runtime as ready. */
export function unavailablePiAgentDefinition(
  id: string,
  name: string,
  context: AgentContext,
): AgentDefinition {
  return {
    id,
    name,
    command: "pi",
    args: [],
    env: {},
    bin: "pi",
    driver: "pi",
    context,
    available: false,
    authStatus: "unknown",
    unavailableReason: "Pi is not installed. Install `@earendil-works/pi-coding-agent`, authenticate a provider, then rediscover.",
    capabilities: unavailablePiCapabilities(),
    source: "discovered",
  };
}

/** Pull a semver-ish token out of `--version` output, else the trimmed first line. */
export function parseVersion(s: string): string | undefined {
  const m = s.match(/\d+\.\d+\.\d+[\w.-]*/);
  if (m) return m[0];
  const line = s.split(/\r?\n/)[0]?.trim();
  return line || undefined;
}

type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

export function supportedWslAgentControlNodeRuntime(
  launch: ResolvedLaunch | null,
  versionOutput: string,
): string | undefined {
  if (!launch?.command.startsWith("/") || launch.args.length !== 0) return undefined;
  const major = Number(versionOutput.trim().match(/^v(\d+)\./u)?.[1]);
  return Number.isInteger(major) && major >= 22 ? launch.command : undefined;
}

async function nativeProbe(k: KnownAgent, launch: ResolvedLaunch): Promise<{ version?: string; authStatus: AuthStatus }> {
  const v = await run(launch.command, [...launch.args, "--version"], { timeoutMs: 5000 });
  const version = v.code === 0 ? parseVersion(v.stdout || v.stderr) : undefined;
  const authStatus = k.authFile ? localAuthFileStatus(join(homedir(), k.authFile)) : "unknown";
  return { version, authStatus };
}

async function wslProbe(
  distro: string,
  k: KnownAgent,
  launch: ResolvedLaunch,
): Promise<{ version?: string; authStatus: AuthStatus }> {
  const [v, a] = await Promise.all([
    run("wsl.exe", ["-d", distro, "--exec", launch.command, ...launch.args, "--version"], { timeoutMs: 8000 }),
    k.authFile
      ? run("wsl.exe", ["-d", distro, "--exec", "sh", "-c", `test -f "$HOME/${k.authFile}"`], { timeoutMs: 6000 })
      : Promise.resolve({ code: 2, stdout: "", stderr: "" }),
  ]);
  return {
    version: v.code === 0 ? parseVersion(v.stdout || v.stderr) : undefined,
    authStatus: probedAuthFileStatus(a),
  };
}

/** Only a completed probe may claim the auth file is absent: "unauthenticated" gates selection,
 * and a probe that could not run has confirmed nothing. `test -f` itself exits 0 or 1; any other
 * code (127 no shell, 126 not executable, wsl.exe failures) is the probe failing, not a missing
 * file. Exported pure so the gate-feeding interpretation stays regression-tested. */
export function probedAuthFileStatus(a: { code: number | null; timedOut?: boolean; errorCode?: string }): AuthStatus {
  if (a.timedOut || a.errorCode) return "unknown";
  if (a.code === 0) return "authenticated";
  return a.code === 1 ? "unauthenticated" : "unknown";
}

/** Same confirmed-absence rule for the native stat: only ENOENT/ENOTDIR prove the file is
 * missing; EACCES or I/O errors leave auth undetermined and must not gate selection. */
export function localAuthFileStatus(path: string, stat: typeof statSync = statSync): AuthStatus {
  try {
    stat(path);
    return "authenticated";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "unauthenticated" : "unknown";
  }
}

/** Probe the native host + every WSL distro for known agent CLIs. */
export async function discoverAgents(): Promise<AgentDefinition[]> {
  // Probe in parallel, but publish in resolver order. A bare configured command must always
  // adopt the PATH-first installation even when its version/update probe finishes last.
  const nativeSlots: AgentDefinition[][][] = KNOWN.map(() => []);

  // Native host.
  await Promise.all(
    KNOWN.map(async (k, knownIndex) => {
      const bins = await resolveNativeCandidates(k.bin);
      if (bins.length === 0) {
        if (k.bin === "codex") nativeSlots[knownIndex]![0] = [unavailableCodexAgentDefinition("codex", "Codex", { kind: "native" })];
        if (k.bin === "claude") nativeSlots[knownIndex]![0] = [unavailableClaudeAgentDefinition("claude-code", "Claude Code", { kind: "native" })];
        if (k.bin === "pi") nativeSlots[knownIndex]![0] = [unavailablePiAgentDefinition("pi", "Pi", { kind: "native" })];
        return;
      }
      await Promise.all(bins.map(async (bin, index) => {
      const suffix = installationId({ kind: "native" }, bin);
      const installation = { id: suffix, path: bin.path, via: bin.via, targetIdentity: resolvedLaunchIdentity(bin) };
      if (!launchTargetStillMatches(bin.launch, { kind: "native" }, installation.targetIdentity)) {
        const unavailable = k.bin === "codex"
          ? unavailableCodexAgentDefinition(k.id, k.name, { kind: "native" })
          : k.bin === "claude"
            ? unavailableClaudeAgentDefinition(k.id, k.name, { kind: "native" })
            : unavailablePiAgentDefinition(k.id, k.name, { kind: "native" });
        nativeSlots[knownIndex]![index] = [invalidateStaleNativeInstallation({
          ...unavailable,
          id: index === 0 ? k.id : `${k.id}-installation-${suffix}`,
          name: index === 0 ? k.name : `${k.name} (${bin.path})`,
          command: bin.launch.command,
          args: bin.launch.args,
          installation,
        })];
        return;
      }
      const gitBashPath = k.bin === "claude" ? await resolveNativeClaudeGitBash() : undefined;
      const claudeCode = k.bin === "claude"
        ? applyNativeClaudeGitBashReadiness(await probeNativeClaudeCode(bin.launch, bin.via), gitBashPath)
        : undefined;
      const { version, authStatus } = claudeCode
        ? { version: claudeCode.installedVersion, authStatus: claudeCode.auth.status }
        : await nativeProbe(k, bin.launch);
      const codexAppServer = k.bin === "codex" ? await probeNativeCodexAppServer(bin.launch, version) : undefined;
      const piRpc = k.bin === "pi" ? await probePiRpc(bin.launch, { kind: "native" }) : undefined;
      const update = launchTargetStillMatches(bin.launch, { kind: "native" }, installation.targetIdentity)
        ? await checkHarnessUpdate(k.bin as "claude" | "codex" | "pi", bin, { kind: "native" }, version,
          k.bin === "codex" ? codexAppServer?.status === "supported" : k.bin === "claude" ? claudeCode?.status === "ready" : piRpc?.available === true)
        : undefined;
      const slashCommands = nativeSlashCommands(k.driver);
      const catalogCapabilities = withSlashCommands(k.driver, slashCommands);
      const base: AgentDefinition = {
        id: index === 0 ? k.id : `${k.id}-installation-${suffix}`,
        name: index === 0 ? k.name : `${k.name} (${bin.path})`,
        // The launch shape, not the shim path: a version-manager npm shim is a node script that
        // the daemon's non-login PATH can't run, so it launches as `<version>/bin/node <shim>`.
        command: bin.launch.command,
        args: bin.launch.args,
        // The logical name is the stable launch-target identity — the node-wrapped launch's
        // command ("node") and entry file (possibly cli.js/index.js) identify nothing.
        bin: k.bin,
        env: gitBashPath ? { CLAUDE_CODE_GIT_BASH_PATH: gitBashPath } : {},
        driver: k.driver,
        context: { kind: "native" },
        version,
        update,
        available: piRpc ? piRpc.available : claudeCode ? claudeCode.status === "ready" : true,
        authStatus: piRpc?.authStatus ?? authStatus,
        unavailableReason: piRpc?.unavailableReason,
        capabilities: piRpc?.capabilities ?? (claudeCode && catalogCapabilities
          ? claudeCapabilitiesFromProbe(catalogCapabilities, claudeCode)
          : catalogCapabilities),
        ...(piRpc?.piAgentControl ? { piAgentControl: piRpc.piAgentControl } : {}),
        source: "discovered",
        installation,
        ...(codexAppServer ? { codexAppServer } : {}),
        ...(claudeCode ? { claudeCode } : {}),
        ...(k.bin !== "pi" ? { nativeTuiAccounting: unavailableNativeTuiAccounting(
          k.bin === "claude" ? "claude-code" : "codex",
          version,
          k.bin === "claude" ? claudeCode?.streamJsonInput === true : codexAppServer?.appServerAvailable === true,
        ) } : {}),
      };
      nativeSlots[knownIndex]![index] = nativeDiscoveredDefinitions(base, codexAppServer, slashCommands);
      }));
    }),
  );

  // Each WSL distro (Windows only; empty elsewhere).
  const distros = await listWslDistros();
  const wslSlots: AgentDefinition[][][][] = distros.map(() => KNOWN.map(() => []));
  await Promise.all(
    distros.flatMap((distro, distroIndex) =>
      KNOWN.map(async (k, knownIndex) => {
        const [bins, node] = await Promise.all([resolveInWslCandidates(distro, k.bin), resolveInWsl(distro, "node")]);
        if (bins.length === 0) {
          if (k.bin === "codex") {
            wslSlots[distroIndex]![knownIndex]![0] = [unavailableCodexAgentDefinition(
              `codex-wsl-${distro}`,
              `Codex (WSL: ${distro})`,
              { kind: "wsl", distro },
            )];
          }
          if (k.bin === "claude") {
            wslSlots[distroIndex]![knownIndex]![0] = [unavailableClaudeAgentDefinition(
              `claude-code-wsl-${distro}`,
              `Claude Code (WSL: ${distro})`,
              { kind: "wsl", distro },
            )];
          }
          if (k.bin === "pi") {
            wslSlots[distroIndex]![knownIndex]![0] = [unavailablePiAgentDefinition(
              `pi-wsl-${distro}`,
              `Pi (WSL: ${distro})`,
              { kind: "wsl", distro },
            )];
          }
          return;
        }
        await Promise.all(bins.map(async (bin, index) => {
        const suffix = installationId({ kind: "wsl", distro }, bin);
        const [baseProbe, slash, nodeVersion, safeLauncher] = await Promise.all([
          k.bin === "claude" ? probeWslClaudeCode(distro, bin.launch, bin.via) : wslProbe(distro, k, bin.launch),
          wslSlashCommands(distro, k.driver),
          node ? run("wsl.exe", ["-d", distro, "--exec", node.launch.command, ...node.launch.args, "--version"], { timeoutMs: 5_000 }) : null,
          probeWslSafeLauncher(distro, node?.launch.command),
        ]);
        const agentControlRuntime = supportedWslAgentControlNodeRuntime(
          node?.launch ?? null,
          nodeVersion?.code === 0 ? nodeVersion.stdout || nodeVersion.stderr : "",
        );
        const claudeCode = k.bin === "claude" ? baseProbe as NonNullable<AgentDefinition["claudeCode"]> : undefined;
        const { version, authStatus } = claudeCode
          ? { version: claudeCode.installedVersion, authStatus: claudeCode.auth.status }
          : baseProbe as Awaited<ReturnType<typeof wslProbe>>;
        const codexAppServer = k.bin === "codex" ? await probeWslCodexAppServer(distro, bin.launch, version) : undefined;
        const piRpc = k.bin === "pi" ? await probePiRpc(bin.launch, { kind: "wsl", distro }) : undefined;
        const update = await checkHarnessUpdate(k.bin as "claude" | "codex" | "pi", bin, { kind: "wsl", distro }, version,
          k.bin === "codex" ? codexAppServer?.status === "supported" : k.bin === "claude" ? claudeCode?.status === "ready" : piRpc?.available === true);
        const catalogCapabilities = withSlashCommands(k.driver, slash);
        const base: AgentDefinition = {
          id: index === 0 ? `${k.id}-wsl-${distro}` : `${k.id}-wsl-${distro}-installation-${suffix}`,
          name: index === 0 ? `${k.name} (WSL: ${distro})` : `${k.name} (WSL: ${distro}, ${bin.path})`,
          command: bin.launch.command,
          args: bin.launch.args,
          bin: k.bin,
          env: {},
          driver: k.driver,
          context: { kind: "wsl", distro },
          version,
          update,
          available: piRpc ? piRpc.available : claudeCode ? claudeCode.status === "ready" : true,
          authStatus: piRpc?.authStatus ?? authStatus,
          unavailableReason: piRpc?.unavailableReason,
          capabilities: piRpc?.capabilities ?? (claudeCode && catalogCapabilities
            ? claudeCapabilitiesFromProbe(catalogCapabilities, claudeCode)
            : catalogCapabilities),
          source: "discovered",
          installation: { id: suffix, path: bin.path, via: bin.via, targetIdentity: resolvedLaunchIdentity(bin) },
          ...(agentControlRuntime
            ? { wslAgentControl: { protocolVersion: 1 as const, nodeRuntime: agentControlRuntime,
                ...(safeLauncher ? { safeLauncherProtocolVersion: 1 as const,
                  bwrapRuntime: safeLauncher.bwrapRuntime } : {}) } }
            : {}),
          ...(codexAppServer ? { codexAppServer } : {}),
          ...(claudeCode ? { claudeCode } : {}),
          ...(k.bin !== "pi" ? { nativeTuiAccounting: unavailableNativeTuiAccounting(
            k.bin === "claude" ? "claude-code" : "codex",
            version,
            k.bin === "claude" ? claudeCode?.streamJsonInput === true : codexAppServer?.appServerAvailable === true,
          ) } : {}),
        };
        wslSlots[distroIndex]![knownIndex]![index] = codexAppServer ? codexAgentDefinitions(base, codexAppServer, slash) : [base];
        }));
      }),
    ),
  );

  const found = [...nativeSlots.flat(2), ...wslSlots.flat(3)];
  // Defensive: collapse any duplicate ids (e.g. two distros that resolve identically).
  const byId = new Map<string, AgentDefinition>();
  for (const a of found) if (!byId.has(a.id)) byId.set(a.id, a);
  return [...byId.values()];
}

/** Basename of a command, treating it as either a Windows or POSIX path. */
function commandBase(cmd: string): string {
  const norm = cmd.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1) || cmd;
}

/** The launch-SHAPE identity: derived purely from command/args (never `bin`), so a config entry
 * that pins the exact resolved launch (node + entry script) still matches the discovered agent.
 * Bare names compare by BASENAME; node-wrapped shims key on the SCRIPT's basename — except
 * generically-named entry files (index.js / cli.js / main.js, common npm layouts), which would
 * falsely unify DIFFERENT agents and key on the full script path instead. */
function launchShapeKey(a: AgentDefinition): string {
  const ctx = a.context?.kind === "wsl" ? `wsl:${a.context.distro}` : "native";
  let base = commandBase(a.command);
  const script = a.args?.[0];
  if (/^node(\.exe)?$/i.test(base) && script) {
    const scriptBase = commandBase(script).replace(/\.(c|m)?js$/i, "");
    base = /^(index|cli|main|bin)$/i.test(scriptBase) ? script : scriptBase;
  } else if (/^(npx|uvx)(\.cmd|\.exe)?$/i.test(base)) {
    // Package runners are generic launchers. Key on the package argument or every Registry npx
    // agent would collapse into one launch target during config/discovery merging.
    const packageArg = (a.args ?? []).find((arg) => !arg.startsWith("-"));
    if (packageArg) base = `${base}:${packageArg}`;
  }
  return `${a.driver ?? "acp"}|${ctx}|${base}`;
}

/** Every identity an agent answers to. Discovery stamps its logical binary name (`bin`:
 * "claude"/"codex") — the ground truth a bare config name matches regardless of launch shape —
 * but the shape key is ALWAYS included too, so a config entry pinning the exact node-wrapped
 * launch (no `bin`, generic cli.js entry) still merges instead of duplicating. */
function launchKeys(a: AgentDefinition): string[] {
  const shape = launchShapeKey(a);
  if (!a.bin) return [shape];
  const ctx = a.context?.kind === "wsl" ? `wsl:${a.context.distro}` : "native";
  const binKey = `${a.driver ?? "acp"}|${ctx}|${a.bin}`;
  return binKey === shape ? [shape] : [binKey, shape];
}

/** Candidate zero owns the established agent id; all later PATH hits carry an installation
 * suffix. Prefer it even if a caller supplies discovery results in completion order. */
function isDefaultDiscoveredInstallation(agent: AgentDefinition): boolean {
  if (!agent.installation) return false;
  const base = agent.driver === "claude-code" ? "claude-code"
    : agent.driver === "codex-app-server" ? "codex"
      : agent.driver === "codex" ? "codex-exec"
        : agent.driver === "pi" ? "pi" : null;
  if (!base) return false;
  return agent.id === (agent.context?.kind === "wsl" ? `${base}-wsl-${agent.context.distro}` : base);
}

/**
 * Merge discovered agents into the configured list. Config entries keep their launch
 * params (command/args/env/driver/context) but are ENRICHED with discovery metadata
 * (version, auth status, slash commands) when they point at the same launch target.
 * Discovered agents that don't match a config entry are appended as new entries.
 */
export function mergeAgents(
  configAgents: AgentDefinition[],
  discovered: AgentDefinition[],
  configuredProbes: AgentDefinition[] = [],
  policyOverrideAgentIds: ReadonlySet<string> = new Set(),
): AgentDefinition[] {
  // Config selects a driver but cannot attest to live provider contracts. Strip stale steering
  // and Native TUI accounting claims first; only matching discovery may restore them.
  const safeConfigAgents = configAgents.map(withoutConfiguredProviderAttestations);
  // Index every discovered agent under ALL of its identities (bin key + launch shape), so both
  // a bare config name and a config entry pinning the exact resolved launch find their match.
  const byKey = new Map<string, AgentDefinition>();
  for (const d of discovered) {
    for (const k of launchKeys(d)) {
      const prior = byKey.get(k);
      if (!prior || (!isDefaultDiscoveredInstallation(prior) && isDefaultDiscoveredInstallation(d))) byKey.set(k, d);
    }
  }
  // Configured probes are exact evidence for one config identity. They cannot share the
  // launch-shape index: two rows may intentionally use the same command with different arguments
  // or environment references, and each probe result must stay attached to its own id.
  const configuredProbeById = new Map(configuredProbes.map((probe) => [probe.id, probe]));
  const matchedDiscoveredIds = new Set<string>();
  const overrideKeys = new Set<string>();
  const enriched = safeConfigAgents.map((c) => {
    const exactMatch = /[\\/]/.test(c.command) ? discovered.find((d) =>
      d.driver === c.driver && agentContextKey(d.context) === agentContextKey(c.context) &&
      d.command === c.command && JSON.stringify(d.args ?? []) === JSON.stringify(c.args ?? [])) : undefined;
    const shapeMatch = exactMatch ?? launchKeys(c).map((k) => byKey.get(k)).find(Boolean);
    const configuredProbe = configuredProbeById.get(c.id);
    const d = configuredProbe
      ? {
          ...shapeMatch,
          ...configuredProbe,
          version: configuredProbe.version ?? shapeMatch?.version,
          authStatus: configuredProbe.authStatus ?? shapeMatch?.authStatus,
          registry: shapeMatch?.registry ?? configuredProbe.registry,
        }
      : shapeMatch;
    if (!d) {
      const { wslAgentControl: _unverifiedWslAgentControl, ...configured } = c;
      return {
        ...configured,
        available: false,
        unavailableReason: configured.context?.kind === "wsl" && process.platform !== "win32"
          ? "This WSL launch target is incompatible with a non-Windows runner."
          : configured.unavailableReason ?? "No completed discovery probe verified this configured launch target.",
      };
    }
    // A completed configured probe is exact evidence for the launch it actually executed; keep
    // an adopted absolute executable/wrapper prefix through this merge. Otherwise a bare path-less
    // config command ("codex") is a pointer, not a launch override, and should adopt discovery's
    // resolved launch only when it has no custom arguments.
    const adoptLaunch = configuredProbe != null ||
      (!/[\\/]/.test(c.command) && (c.args?.length ?? 0) === 0 && /[\\/]/.test(d.command));
    const effectiveCommand = adoptLaunch ? d.command : c.command;
    const effectiveArgs = adoptLaunch ? d.args ?? [] : c.args ?? [];
    const sameInstallation = !!shapeMatch && effectiveCommand === shapeMatch.command &&
      JSON.stringify(effectiveArgs) === JSON.stringify(shapeMatch.args ?? []);
    if (sameInstallation && shapeMatch) matchedDiscoveredIds.add(shapeMatch.id);
    const policyOverride = Object.keys(c.env ?? {}).length > 0 || c.available === false ||
      policyOverrideAgentIds.has(c.id);
    if (shapeMatch && ((!sameInstallation && (/[\\/]/.test(c.command) || (c.args?.length ?? 0) > 0)) ||
        policyOverride)) {
      // A configured wrapper, argv, environment, or disable may enforce policy. Preserve the
      // pre-existing precedence rule across every same-name discovered installation.
      for (const key of launchKeys(c)) overrideKeys.add(key);
      if (policyOverride) for (const key of launchKeys(shapeMatch)) overrideKeys.add(key);
    }
    return applyCodexAgentEnvironment(applyClaudeAgentEnvironment({
      ...c,
      ...(adoptLaunch ? { command: d.command, args: [...(d.args ?? [])] } : {}),
      env: { ...(d.env ?? {}), ...(c.env ?? {}) },
      version: c.version ?? d.version,
      authStatus: c.authStatus ?? d.authStatus,
      available: d.available === true && c.available !== false,
      unavailableReason: d.available === true && c.available !== false
        ? undefined
        : d.unavailableReason ?? c.unavailableReason,
      // Diagnostics describe the live resolved launch, so fresh discovery wins over a stale
      // config/persisted value. Old runners simply omit the field and keep the config value.
      codexAppServer: d.codexAppServer ?? c.codexAppServer,
      codexBillingSource: c.codexBillingSource ?? d.codexBillingSource,
      claudeCode: d.claudeCode ?? c.claudeCode,
      // Fresh discovery is the only authority. Config and old-runner values never attest support.
      nativeTuiAccounting: d.nativeTuiAccounting,
      registry: d.registry ?? c.registry,
      // A basename match can enrich diagnostics for a custom wrapper, but cannot attest that
      // the wrapper launches the discovered installation chosen by the Machine owner.
      installation: sameInstallation ? shapeMatch?.installation : undefined,
      acp: d.acp ?? c.acp,
      wslAgentControl: d.wslAgentControl,
      piAgentControl: d.piAgentControl,
      capabilities: c.capabilities
        ? c.driver === "claude-code" && d.capabilities
          ? {
              ...c.capabilities,
              // Launch params remain user-authored, but installed CLI support is not a config
              // preference: discovery is authoritative for every optional argv/input surface.
              effortLevels: d.capabilities.effortLevels,
              permissionModes: d.capabilities.permissionModes,
              elicitation: d.capabilities.elicitation,
              supportsImages: d.capabilities.supportsImages,
              supportsApprovals: d.capabilities.supportsApprovals,
              supportsSteering: d.capabilities.supportsSteering,
              supportsConversationFork: d.capabilities.supportsConversationFork,
              imageToolResults: d.capabilities.imageToolResults,
              slashCommands: d.capabilities.slashCommands,
            }
          : c.driver === "codex-app-server"
            ? {
                ...c.capabilities,
                slashCommands: d.capabilities?.slashCommands ?? c.capabilities.slashCommands,
                ...(d.codexAppServer?.status === "supported" && d.capabilities?.supportsSteering
                  ? { supportsSteering: true as const }
                  : {}),
                ...(d.codexAppServer?.status === "supported" && d.capabilities?.imageToolResults
                  ? { imageToolResults: true as const }
                  : {}),
              }
            : c.driver === "pi" && d.capabilities
              ? d.capabilities
              : { ...c.capabilities, slashCommands: d.capabilities?.slashCommands ?? c.capabilities.slashCommands }
        : d.capabilities,
    }, c.available !== undefined), c.available !== undefined);
  });
  // A discovered agent that shares a launch target with a config agent has already
  // enriched it (above). Append the rest — but if a discovered agent's id collides
  // with a config agent that is a DIFFERENT launch target (e.g. the ACP adapter also
  // named "codex"/"claude-code"), give the discovered one a distinct id so it isn't
  // suppressed and doesn't clash downstream.
  const usedIds = new Set(safeConfigAgents.map((a) => a.id));
  const extras: AgentDefinition[] = [];
  for (const d of discovered) {
    if (matchedDiscoveredIds.has(d.id)) continue;
    if (launchKeys(d).some((key) => overrideKeys.has(key))) continue;
    let id = d.id;
    if (usedIds.has(id)) {
      const suffix = d.driver === "codex-app-server"
        ? "-app-server"
        : d.context?.kind === "wsl"
          ? `-wsl-${d.context.distro}`
          : "-native";
      id = `${d.id}${suffix}`;
      let n = 2;
      while (usedIds.has(id)) id = `${d.id}${suffix}-${n++}`;
    }
    usedIds.add(id);
    extras.push(id === d.id ? d : { ...d, id });
  }
  return [...enriched, ...extras];
}
