/**
 * Agent discovery: probe the host (and every WSL distro) for installed agent CLIs,
 * returning extended AgentDefinitions with version, auth status, and capabilities.
 * Discovered agents augment the static runner config — config entries win on conflict
 * so user overrides (custom args/env/tokens) are preserved.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentCapabilities,
  AgentContext,
  AgentDefinition,
  AgentDriverKind,
  AgentSlashCommand,
} from "@wollipog/protocol";
import { capabilitiesFor } from "../catalog.js";
import {
  applyClaudeAgentEnvironment,
  claudeCapabilitiesFromProbe,
  probeNativeClaudeCode,
  probeWslClaudeCode,
  unavailableClaudeCode,
} from "./claude-code.js";
import { probeNativeCodexAppServer, probeWslCodexAppServer, unavailableCodexAppServer } from "./codex-app-server.js";
import { discoverAgentModels, type AgentModelDiscovery } from "./models.js";
import { listWslDistros, resolveInWsl, resolveNative, run, type ResolvedLaunch } from "./resolve.js";

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

/** Curated capabilities + the agent's discovered slash commands. Dynamic model discovery is applied
 * to the merged agent list afterward (enrichAgentModels), so config + discovered agents share it. */
function withSlashCommands(driver: AgentDriverKind, slashCommands: AgentSlashCommand[]): AgentCapabilities | undefined {
  const caps = capabilitiesFor(driver);
  return caps ? { ...caps, slashCommands } : undefined;
}

/** Same-turn steering is transport contract evidence, never a static driver-name assumption. */
function verifiedCodexAppServerCapabilities(
  slashCommands: AgentSlashCommand[],
  compatibility: NonNullable<AgentDefinition["codexAppServer"]>,
): AgentCapabilities | undefined {
  const caps = withSlashCommands("codex-app-server", slashCommands);
  return caps && compatibility.status === "supported" ? { ...caps, supportsSteering: true } : caps;
}

function withoutConfiguredCodexSteering(agent: AgentDefinition): AgentDefinition {
  if (agent.driver !== "codex-app-server" || !agent.capabilities?.supportsSteering) return agent;
  const { supportsSteering: _unverified, ...capabilities } = agent.capabilities;
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
  authFile: string;
}

const KNOWN: KnownAgent[] = [
  { id: "claude-code", name: "Claude Code", bin: "claude", driver: "claude-code", authFile: ".claude/.credentials.json" },
  { id: "codex", name: "Codex", bin: "codex", driver: "codex", authFile: ".codex/auth.json" },
];

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
  };
  const exec: AgentDefinition = {
    ...base,
    id: codexExecId(base.id),
    name: `${base.name} (Non-Interactive)`,
    driver: "codex",
    available: signedIn,
    capabilities: withSlashCommands("codex", slashCommands),
    codexAppServer: compatibility,
  };
  return [primary, exec];
}

/** An explicit agent-config `OPENAI_API_KEY` is a deliberate API-billing Codex setup: the drivers
 * honor it (they scrub only the daemon-inherited key), so a missing `~/.codex/auth.json` must not
 * gate that entry. Mirrors the Claude config-auth carve-out applied in the same merge. */
export function applyCodexAgentEnvironment(agent: AgentDefinition, preserveAvailability = false): AgentDefinition {
  if (agent.driver !== "codex" && agent.driver !== "codex-app-server") return agent;
  if (!agent.env?.OPENAI_API_KEY) return agent;
  return {
    ...agent,
    authStatus: "authenticated",
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

async function nativeProbe(k: KnownAgent, launch: ResolvedLaunch): Promise<{ version?: string; authStatus: AuthStatus }> {
  const v = await run(launch.command, [...launch.args, "--version"], { timeoutMs: 5000 });
  const version = v.code === 0 ? parseVersion(v.stdout || v.stderr) : undefined;
  const authStatus: AuthStatus = existsSync(join(homedir(), k.authFile)) ? "authenticated" : "unauthenticated";
  return { version, authStatus };
}

async function wslProbe(
  distro: string,
  k: KnownAgent,
  launch: ResolvedLaunch,
): Promise<{ version?: string; authStatus: AuthStatus }> {
  const [v, a] = await Promise.all([
    run("wsl.exe", ["-d", distro, "--exec", launch.command, ...launch.args, "--version"], { timeoutMs: 8000 }),
    run("wsl.exe", ["-d", distro, "--exec", "sh", "-c", `test -f "$HOME/${k.authFile}"`], { timeoutMs: 6000 }),
  ]);
  return {
    version: v.code === 0 ? parseVersion(v.stdout || v.stderr) : undefined,
    authStatus: a.code === 0 ? "authenticated" : "unauthenticated",
  };
}

/** Probe the native host + every WSL distro for known agent CLIs. */
export async function discoverAgents(): Promise<AgentDefinition[]> {
  const found: AgentDefinition[] = [];

  // Native host.
  await Promise.all(
    KNOWN.map(async (k) => {
      const bin = await resolveNative(k.bin);
      if (!bin) {
        if (k.bin === "codex") found.push(unavailableCodexAgentDefinition("codex", "Codex", { kind: "native" }));
        if (k.bin === "claude") found.push(unavailableClaudeAgentDefinition("claude-code", "Claude Code", { kind: "native" }));
        return;
      }
      const claudeCode = k.bin === "claude" ? await probeNativeClaudeCode(bin.launch, bin.via) : undefined;
      const { version, authStatus } = claudeCode
        ? { version: claudeCode.installedVersion, authStatus: claudeCode.auth.status }
        : await nativeProbe(k, bin.launch);
      const codexAppServer = k.bin === "codex" ? await probeNativeCodexAppServer(bin.launch, version) : undefined;
      const slashCommands = nativeSlashCommands(k.driver);
      const catalogCapabilities = withSlashCommands(k.driver, slashCommands);
      const base: AgentDefinition = {
        id: k.id,
        name: k.name,
        // The launch shape, not the shim path: a version-manager npm shim is a node script that
        // the daemon's non-login PATH can't run, so it launches as `<version>/bin/node <shim>`.
        command: bin.launch.command,
        args: bin.launch.args,
        // The logical name is the stable launch-target identity — the node-wrapped launch's
        // command ("node") and entry file (possibly cli.js/index.js) identify nothing.
        bin: k.bin,
        env: {},
        driver: k.driver,
        context: { kind: "native" },
        version,
        available: claudeCode ? claudeCode.status === "ready" : true,
        authStatus,
        capabilities: claudeCode && catalogCapabilities
          ? claudeCapabilitiesFromProbe(catalogCapabilities, claudeCode)
          : catalogCapabilities,
        source: "discovered",
        ...(codexAppServer ? { codexAppServer } : {}),
        ...(claudeCode ? { claudeCode } : {}),
      };
      found.push(...(codexAppServer ? codexAgentDefinitions(base, codexAppServer, slashCommands) : [base]));
    }),
  );

  // Each WSL distro (Windows only; empty elsewhere).
  const distros = await listWslDistros();
  await Promise.all(
    distros.flatMap((distro) =>
      KNOWN.map(async (k) => {
        const bin = await resolveInWsl(distro, k.bin);
        if (!bin) {
          if (k.bin === "codex") {
            found.push(unavailableCodexAgentDefinition(
              `codex-wsl-${distro}`,
              `Codex (WSL: ${distro})`,
              { kind: "wsl", distro },
            ));
          }
          if (k.bin === "claude") {
            found.push(unavailableClaudeAgentDefinition(
              `claude-code-wsl-${distro}`,
              `Claude Code (WSL: ${distro})`,
              { kind: "wsl", distro },
            ));
          }
          return;
        }
        const [baseProbe, slash] = await Promise.all([
          k.bin === "claude" ? probeWslClaudeCode(distro, bin.launch, bin.via) : wslProbe(distro, k, bin.launch),
          wslSlashCommands(distro, k.driver),
        ]);
        const claudeCode = k.bin === "claude" ? baseProbe as NonNullable<AgentDefinition["claudeCode"]> : undefined;
        const { version, authStatus } = claudeCode
          ? { version: claudeCode.installedVersion, authStatus: claudeCode.auth.status }
          : baseProbe as Awaited<ReturnType<typeof wslProbe>>;
        const codexAppServer = k.bin === "codex" ? await probeWslCodexAppServer(distro, bin.launch, version) : undefined;
        const catalogCapabilities = withSlashCommands(k.driver, slash);
        const base: AgentDefinition = {
          id: `${k.id}-wsl-${distro}`,
          name: `${k.name} (WSL: ${distro})`,
          command: bin.launch.command,
          args: bin.launch.args,
          bin: k.bin,
          env: {},
          driver: k.driver,
          context: { kind: "wsl", distro },
          version,
          available: claudeCode ? claudeCode.status === "ready" : true,
          authStatus,
          capabilities: claudeCode && catalogCapabilities
            ? claudeCapabilitiesFromProbe(catalogCapabilities, claudeCode)
            : catalogCapabilities,
          source: "discovered",
          ...(codexAppServer ? { codexAppServer } : {}),
          ...(claudeCode ? { claudeCode } : {}),
        };
        found.push(...(codexAppServer ? codexAgentDefinitions(base, codexAppServer, slash) : [base]));
      }),
    ),
  );

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

/**
 * Merge discovered agents into the configured list. Config entries keep their launch
 * params (command/args/env/driver/context) but are ENRICHED with discovery metadata
 * (version, auth status, slash commands) when they point at the same launch target.
 * Discovered agents that don't match a config entry are appended as new entries.
 */
export function mergeAgents(configAgents: AgentDefinition[], discovered: AgentDefinition[]): AgentDefinition[] {
  // Config selects a driver but cannot attest to the live app-server contract. Strip any stale
  // steering flag first; only a matching discovery result below may restore it.
  const safeConfigAgents = configAgents.map(withoutConfiguredCodexSteering);
  // Index every discovered agent under ALL of its identities (bin key + launch shape), so both
  // a bare config name and a config entry pinning the exact resolved launch find their match.
  const byKey = new Map<string, AgentDefinition>();
  for (const d of discovered) {
    for (const k of launchKeys(d)) if (!byKey.has(k)) byKey.set(k, d);
  }
  const enriched = safeConfigAgents.map((c) => {
    const d = launchKeys(c).map((k) => byKey.get(k)).find(Boolean);
    if (!d) return c;
    // A bare path-less config command ("codex") is a pointer, not a launch override — and it
    // spawns via the daemon's non-login PATH, which is exactly where version-manager installs
    // are invisible. Adopt discovery's RESOLVED launch (absolute command + base args) so the
    // enriched entry can actually spawn; a config entry with a path or custom args keeps its
    // own launch (genuine user override).
    const adoptLaunch = !/[\\/]/.test(c.command) && (c.args?.length ?? 0) === 0 && /[\\/]/.test(d.command);
    return applyCodexAgentEnvironment(applyClaudeAgentEnvironment({
      ...c,
      ...(adoptLaunch ? { command: d.command, args: [...(d.args ?? [])] } : {}),
      version: c.version ?? d.version,
      authStatus: c.authStatus ?? d.authStatus,
      available: c.available ?? d.available,
      // Diagnostics describe the live resolved launch, so fresh discovery wins over a stale
      // config/persisted value. Old runners simply omit the field and keep the config value.
      codexAppServer: d.codexAppServer ?? c.codexAppServer,
      claudeCode: d.claudeCode ?? c.claudeCode,
      registry: d.registry ?? c.registry,
      acp: d.acp ?? c.acp,
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
              supportsConversationFork: d.capabilities.supportsConversationFork,
              slashCommands: d.capabilities.slashCommands,
            }
          : c.driver === "codex-app-server"
            ? {
                ...c.capabilities,
                slashCommands: d.capabilities?.slashCommands ?? c.capabilities.slashCommands,
                ...(d.codexAppServer?.status === "supported" && d.capabilities?.supportsSteering
                  ? { supportsSteering: true as const }
                  : {}),
              }
            : { ...c.capabilities, slashCommands: d.capabilities?.slashCommands ?? c.capabilities.slashCommands }
        : d.capabilities,
    }, c.available !== undefined), c.available !== undefined);
  });
  // A discovered agent that shares a launch target with a config agent has already
  // enriched it (above). Append the rest — but if a discovered agent's id collides
  // with a config agent that is a DIFFERENT launch target (e.g. the ACP adapter also
  // named "codex"/"claude-code"), give the discovered one a distinct id so it isn't
  // suppressed and doesn't clash downstream.
  const usedKeys = new Set(safeConfigAgents.flatMap(launchKeys));
  const usedIds = new Set(safeConfigAgents.map((a) => a.id));
  const extras: AgentDefinition[] = [];
  for (const d of discovered) {
    if (launchKeys(d).some((k) => usedKeys.has(k))) continue;
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
