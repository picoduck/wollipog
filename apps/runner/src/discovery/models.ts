/**
 * Dynamic model + reasoning-effort discovery from each agent's own machine-readable source. Pure
 * parsers are kept separate from I/O so they unit-test against fixtures.
 *
 *   codex-app-server         : live model/list; models_cache.json only when that RPC is unavailable.
 *   codex                    : ~/.codex/models_cache.json + config.toml's chosen `model`.
 *   claude-code              : live control-protocol initialize response; stable aliases only when
 *                              the installed CLI cannot return its authenticated model catalog.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentContext, AgentDefinition, AgentDriverKind, AgentModel } from "@wollipog/protocol";
import { JsonRpcPeer, type RpcError } from "../jsonrpc.js";
import { killTree, spawnAgent, type AgentProcess, type SpawnAgentOptions } from "../spawn.js";
import { run } from "./resolve.js";

/* ------------------------------- pure parsers ----------------------------- */

/** Codex's top-level `model = "…"` from config.toml (ignores any `[table].model`). */
export function parseCodexConfigModel(configToml: string): string | null {
  const head = configToml.split(/^\s*\[/m)[0] ?? configToml; // top-level section only
  const m = head.match(/^\s*model\s*=\s*["']([^"'\n]+)["']/m);
  return m ? m[1]!.trim() : null;
}

/** Parse ~/.codex/models_cache.json into model options with per-model effort. `configured` (from
 * config.toml) is marked as the default; otherwise the first listed model is. Never throws. */
export function parseCodexModels(cacheJson: string, configured?: string | null): AgentModel[] {
  let root: { models?: unknown };
  try {
    root = JSON.parse(cacheJson) as { models?: unknown };
  } catch {
    return [];
  }
  const raw = Array.isArray(root.models) ? root.models : [];
  const out: AgentModel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const m = entry as Record<string, unknown>;
    if (typeof m.visibility === "string" && m.visibility !== "list") continue; // hidden model
    const id = typeof m.slug === "string" ? m.slug : "";
    if (!id) continue;
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
          .map((l) => (l && typeof l === "object" ? (l as { effort?: unknown }).effort : l))
          .filter((e): e is string => typeof e === "string")
      : [];
    const inputModalities = Array.isArray(m.input_modalities)
      ? m.input_modalities.filter((value): value is "text" | "image" => value === "text" || value === "image")
      : [];
    out.push({
      id,
      displayName: typeof m.display_name === "string" ? m.display_name : id,
      description: typeof m.description === "string" ? m.description : undefined,
      efforts: efforts.length ? efforts : undefined,
      defaultEffort: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : undefined,
      inputModalities: inputModalities.length ? inputModalities : undefined,
      // codex's cache carries the real (effective) context window per model — use it directly.
      contextWindow: typeof m.context_window === "number" ? m.context_window : undefined,
      default: configured != null && id === configured,
    });
  }
  if (out.length && !out.some((m) => m.default)) out[0]!.default = true;
  return out;
}

type ModelListPage = { data?: unknown; nextCursor?: unknown };

/** Normalize the stable v2 `model/list` response into the provider-neutral capability shape. */
export function parseCodexAppServerModels(page: unknown): AgentModel[] {
  const data = page && typeof page === "object" && Array.isArray((page as ModelListPage).data)
    ? (page as { data: unknown[] }).data
    : [];
  const models: AgentModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const id = typeof raw.id === "string" && raw.id ? raw.id : typeof raw.model === "string" ? raw.model : "";
    if (!id) continue;
    const efforts = Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
          .map((option) =>
            option && typeof option === "object" ? (option as { reasoningEffort?: unknown }).reasoningEffort : option,
          )
          .filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    const inputModalities = Array.isArray(raw.inputModalities)
      ? raw.inputModalities.filter((value): value is "text" | "image" => value === "text" || value === "image")
      : [];
    models.push({
      id,
      displayName: typeof raw.displayName === "string" ? raw.displayName : id,
      description: typeof raw.description === "string" ? raw.description : undefined,
      default: raw.isDefault === true,
      hidden: raw.hidden === true,
      efforts: efforts.length ? [...new Set(efforts)] : undefined,
      defaultEffort: typeof raw.defaultReasoningEffort === "string" ? raw.defaultReasoningEffort : undefined,
      inputModalities: inputModalities.length ? [...new Set(inputModalities)] : undefined,
    });
  }
  return models;
}

/** Fetch every model/list page while rejecting cursor loops and unbounded server pagination. */
export async function collectCodexAppServerModels(
  request: (params: { cursor?: string; includeHidden: true; limit: number }) => Promise<unknown>,
): Promise<AgentModel[]> {
  const models: AgentModel[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const response = await request({ ...(cursor ? { cursor } : {}), includeHidden: true, limit: 100 });
    models.push(...parseCodexAppServerModels(response));
    const next = response && typeof response === "object" ? (response as ModelListPage).nextCursor : undefined;
    if (typeof next !== "string" || !next) break;
    if (cursors.has(next)) throw new Error(`codex model/list repeated pagination cursor ${JSON.stringify(next)}`);
    cursors.add(next);
    cursor = next;
    if (pageNumber === 19) throw new Error("codex model/list exceeded 20 pages");
  }
  const deduped = [...new Map(models.map((model) => [model.id, model])).values()];
  if (deduped.length && !deduped.some((model) => model.default)) {
    (deduped.find((model) => !model.hidden) ?? deduped[0])!.default = true;
  }
  return deduped;
}

/** Version-neutral Claude aliases used only when live initialization metadata is unavailable. */
const CLAUDE_ALIASES: AgentModel[] = [
  {
    id: "default",
    displayName: "Default",
    description: "Uses Claude Code's configured model",
  },
  {
    id: "opus",
    displayName: "Opus",
    description: "Uses the latest available Opus model",
  },
  {
    id: "fable",
    displayName: "Fable",
    description: "Uses the latest available Fable model",
  },
  {
    id: "sonnet",
    displayName: "Sonnet",
    description: "Uses the latest available Sonnet model",
  },
  {
    id: "haiku",
    displayName: "Haiku",
    description: "Uses the latest available Haiku model",
  },
];
export function claudeModels(configured?: string | null): AgentModel[] {
  return CLAUDE_ALIASES.map((a) => ({ ...a, default: configured ? a.id === configured : a.id === "default" }));
}

interface ClaudeModelInfo {
  value?: unknown;
  resolvedModel?: unknown;
  displayName?: unknown;
  description?: unknown;
  supportedEffortLevels?: unknown;
}

function claudeResolvedDisplayName(modelId: string): string | null {
  const normalized = modelId.replace(/\[[^\]]+\]$/, "").replace(/-\d{8}$/, "");
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(normalized);
  if (!match) return null;
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}

const CLAUDE_STANDARD_CONTEXT_WINDOW = 200_000;

function claudeModelFamily(modelId: string): string | null {
  const normalized = modelId.replace(/\[[^\]]+\]$/, "");
  const resolved = /^claude-([a-z]+)-\d+/.exec(normalized)?.[1];
  if (resolved) return resolved;
  return /^(opus|fable|sonnet|haiku)$/.exec(normalized)?.[1] ?? null;
}

function claudeContextWindow(info: ClaudeModelInfo): number | undefined {
  const description = typeof info.description === "string" ? info.description : "";
  const match = /\b(\d+(?:\.\d+)?)\s*([kKmM])\s+context\b/.exec(description);
  if (match) {
    const multiplier = match[2]!.toLowerCase() === "m" ? 1_000_000 : 1_000;
    return Math.round(Number(match[1]) * multiplier);
  }
  const ids = [info.value, info.resolvedModel].filter((value): value is string => typeof value === "string");
  if (ids.some((id) => /\[1m\]$/i.test(id))) return 1_000_000;
  for (const id of [info.resolvedModel, info.value]) {
    if (typeof id !== "string") continue;
    const family = claudeModelFamily(id);
    if (family) return CLAUDE_STANDARD_CONTEXT_WINDOW;
  }
  return undefined;
}

function claudeLiveDisplayName(info: ClaudeModelInfo, id: string): string {
  const raw = typeof info.displayName === "string" && info.displayName.trim() ? info.displayName.trim() : id;
  const resolved = typeof info.resolvedModel === "string" ? claudeResolvedDisplayName(info.resolvedModel) : null;
  if (!resolved) return raw;
  if (id === "default") return `Default (${resolved})`;
  const family = resolved.split(" ", 1)[0]!.toLowerCase();
  const rawWithoutContext = raw.replace(/\s*\([^)]*\bcontext\b[^)]*\)\s*$/i, "").trim().toLowerCase();
  // Decorate only generic family labels. Preserve meaningful CLI distinctions such as
  // "Opus Plan" when two picker entries resolve to the same provider model.
  if (raw !== id && rawWithoutContext !== family) return raw;
  const context = raw.match(/\(([^)]*context)\)/i)?.[1];
  return context ? `${resolved} (${context.replace(/\bcontext\b/i, "Context")})` : resolved;
}

/** Normalize Claude Code's authenticated control-protocol initialization model catalog. */
export function parseClaudeModels(initialization: unknown): AgentModel[] {
  const rawModels =
    initialization && typeof initialization === "object" && Array.isArray((initialization as { models?: unknown }).models)
      ? (initialization as { models: unknown[] }).models
      : [];
  const models: AgentModel[] = [];
  for (const entry of rawModels) {
    if (!entry || typeof entry !== "object") continue;
    const info = entry as ClaudeModelInfo;
    const id = typeof info.value === "string" ? info.value.trim() : "";
    if (!id) continue;
    const efforts = Array.isArray(info.supportedEffortLevels)
      ? info.supportedEffortLevels.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    models.push({
      id,
      displayName: claudeLiveDisplayName(info, id),
      description: typeof info.description === "string" ? info.description : undefined,
      default: id === "default",
      efforts: efforts.length ? [...new Set(efforts)] : undefined,
      contextWindow: claudeContextWindow(info),
    });
  }
  const deduped = [...new Map(models.map((model) => [model.id, model])).values()];
  if (deduped.length && !deduped.some((model) => model.default)) deduped[0]!.default = true;
  // Keep pre-discovery persisted aliases resolvable without duplicating them in the picker.
  // Hidden aliases surface only when an existing session selected that exact id.
  if (deduped.length) {
    for (const alias of CLAUDE_ALIASES) {
      if (!deduped.some((model) => model.id === alias.id)) {
        deduped.push({ ...alias, default: false, hidden: true });
      }
    }
  }
  return deduped;
}

/* --------------------------------- I/O ------------------------------------ */

/** Read $HOME/<rel> in the given context (native fs / WSL cat); null if absent/unreadable. */
async function readHomeFile(context: AgentContext, rel: string): Promise<string | null> {
  if (context.kind === "native") {
    try {
      return readFileSync(join(homedir(), rel), "utf8");
    } catch {
      return null;
    }
  }
  const r = await run("wsl.exe", ["-d", context.distro, "--exec", "sh", "-c", `cat "$HOME/${rel}" 2>/dev/null`], {
    timeoutMs: 6000,
    maxBuffer: 16 * 1024 * 1024, // models_cache.json is ~200KB; ample headroom
  });
  return r.code === 0 && r.stdout ? r.stdout : null;
}

/** Discover a driver's model options from the agent's own sources. Empty ⇒ caller keeps the catalog. */
export async function discoverModels(driver: AgentDriverKind, context: AgentContext): Promise<AgentModel[]> {
  if (driver === "codex" || driver === "codex-app-server") {
    const [cache, config] = await Promise.all([
      readHomeFile(context, ".codex/models_cache.json"),
      readHomeFile(context, ".codex/config.toml"),
    ]);
    return cache ? parseCodexModels(cache, config ? parseCodexConfigModel(config) : null) : [];
  }
  if (driver === "claude-code") {
    // Live discovery is handled by queryClaudeModels. This remains the version-neutral fallback
    // for older or temporarily unavailable CLIs; never infer versions from ~/.claude.json.
    return claudeModels();
  }
  return [];
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Query the resolved Codex launch directly. Discovery never exposes a listener; this is local stdio. */
export const CODEX_DISCOVERY_CLIENT_INFO = {
  name: "wollipog-discovery",
  version: "0.8.0",
} as const;

async function queryCodexAppServerModels(agent: AgentDefinition): Promise<AgentModel[]> {
  const context = agent.context ?? { kind: "native" as const };
  const child = spawnAgent({
    command: agent.command,
    args: [...(agent.args ?? []), "app-server"],
    cwd: context.kind === "wsl" ? "/" : process.cwd(),
    env: agent.env,
    context,
    scrubInheritedEnv: ["OPENAI_API_KEY"],
  });
  const peer = new JsonRpcPeer(child.stdin, child.stdout);
  child.stderr.resume();
  attachModelProbeLifecycle(child, peer);
  try {
    await withTimeout(
      peer.request("initialize", { clientInfo: CODEX_DISCOVERY_CLIENT_INFO }),
      12_000,
      "codex app-server initialize",
    );
    peer.notify("initialized", {});
    return await withTimeout(
      collectCodexAppServerModels((params) =>
        withTimeout(peer.request("model/list", params), 8_000, "codex app-server model/list page"),
      ),
      20_000,
      "codex app-server model/list",
    );
  } finally {
    peer.dispose("model discovery complete");
    killTree(child);
  }
}

/** Exact no-prompt launch contract for Claude's SDK control initialization. */
const CLAUDE_LIFETIME_ENVIRONMENT = [
  "WOLLIPOG_CLAUDE_PERSISTENT",
  "WOLLIPOG_CLAUDE_PERSISTENT_IDLE_MS",
  "WOLLIPOG_CLAUDE_PENDING_MAX_MS",
  "MAM_CLAUDE_PERSISTENT",
  "MAM_CLAUDE_PERSISTENT_IDLE_MS",
  "MAM_CLAUDE_PENDING_MAX_MS",
];

export function claudeModelProbeOptions(agent: AgentDefinition): SpawnAgentOptions {
  const context = agent.context ?? { kind: "native" as const };
  const env = { ...(agent.env ?? {}) };
  for (const name of CLAUDE_LIFETIME_ENVIRONMENT) delete env[name];
  if (env.CLAUDE_CODE_OAUTH_TOKEN) delete env.ANTHROPIC_API_KEY;
  return {
    command: agent.command,
    args: [
      ...(agent.args ?? []),
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "plan",
      "--no-session-persistence",
    ],
    cwd: context.kind === "wsl" ? "/" : process.cwd(),
    env,
    context,
    // Match real Claude turns: a daemon-inherited key would switch discovery to API billing and
    // return a catalog from a different account than the subscription-backed session will use.
    scrubInheritedEnv: ["ANTHROPIC_API_KEY", ...CLAUDE_LIFETIME_ENVIRONMENT],
  };
}

function claudeModelProbeSupported(agent: AgentDefinition): boolean {
  const capabilities = agent.claudeCode;
  return capabilities?.controlProtocol === true && capabilities.permissionModes.includes("plan");
}

/** Collect one SDK control response, including a final JSON line without a newline terminator. */
export function collectClaudeModelsFromProcess(child: AgentProcess, requestId: string): Promise<AgentModel[]> {
  return new Promise<AgentModel[]>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const processLine = (raw: string) => {
      const line = raw.trim();
      if (!line || settled) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const envelope = message.response;
      if (!envelope || typeof envelope !== "object") return;
      const response = envelope as Record<string, unknown>;
      if (response.request_id !== requestId) return;
      if (response.subtype !== "success") {
        finish(() => reject(new Error(`claude model discovery failed: ${String(response.error ?? "unknown error")}`)));
        return;
      }
      finish(() => resolve(parseClaudeModels(response.response)));
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        processLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.stdin.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => {
      processLine(buffer);
      finish(() => reject(new Error(`claude model discovery exited before initialization (${code ?? "signal"})`)));
    });
    child.stdin.end(
      `${JSON.stringify({
        request_id: requestId,
        type: "control_request",
        request: { subtype: "initialize" },
      })}\n`,
    );
  });
}

interface ClaudeModelQueryDeps {
  spawn?: typeof spawnAgent;
  kill?: typeof killTree;
  timeoutMs?: number;
  requestId?: string;
}

/** Query Claude Code's SDK control initialization without sending a prompt or repository content. */
export async function queryClaudeModels(
  agent: AgentDefinition,
  deps: ClaudeModelQueryDeps = {},
): Promise<AgentModel[]> {
  const child = (deps.spawn ?? spawnAgent)(claudeModelProbeOptions(agent));
  child.stderr.resume();
  const requestId = deps.requestId ?? `wollipog-model-discovery-${Date.now().toString(36)}`;
  try {
    return await withTimeout(
      collectClaudeModelsFromProcess(child, requestId),
      deps.timeoutMs ?? 12_000,
      "claude model discovery initialize",
    );
  } finally {
    (deps.kill ?? killTree)(child);
  }
}

/** Spawn failures on POSIX emit `error` without `exit`; always settle pending RPCs instead of crashing. */
export function attachModelProbeLifecycle(child: AgentProcess, peer: Pick<JsonRpcPeer, "dispose">): void {
  child.once("error", (error) => peer.dispose(`codex app-server model probe spawn failed: ${error.message}`));
  child.once("exit", (code) => peer.dispose(`codex app-server model probe exited (${code ?? "signal"})`));
}

export interface AgentModelDiscovery {
  models: AgentModel[];
  source?: "live" | "cached";
}

interface AgentModelDiscovererDeps {
  queryAppServer: (agent: AgentDefinition) => Promise<AgentModel[]>;
  queryClaude?: (agent: AgentDefinition) => Promise<AgentModel[]>;
  fallback: (driver: AgentDriverKind, context: AgentContext) => Promise<AgentModel[]>;
}

function modelDiscoveryKey(agent: AgentDefinition): string {
  const context = agent.context ?? { kind: "native" as const };
  const contextKey = context.kind === "wsl" ? `wsl:${context.distro}` : "native";
  return JSON.stringify([
    agent.driver ?? "acp",
    contextKey,
    agent.version ?? "unknown-version",
    agent.command,
    ...(agent.args ?? []),
  ]);
}

function modelListUnavailable(error: unknown): boolean {
  const rpc = error as Partial<RpcError> | undefined;
  return rpc?.code === -32601 || /method not found|unknown method/i.test(typeof rpc?.message === "string" ? rpc.message : "");
}

/** Build a cacheable discoverer; dependency injection keeps fallback/refresh policy fully testable. */
export function createAgentModelDiscoverer(deps: AgentModelDiscovererDeps) {
  const cache = new Map<string, AgentModelDiscovery>();
  const claudeFailures = new Map<string, number>();
  return async (agent: AgentDefinition, options: { refresh?: boolean } = {}): Promise<AgentModelDiscovery> => {
    const driver = agent.driver ?? "acp";
    const context = agent.context ?? { kind: "native" as const };
    if (agent.available === false) return { models: [] };
    if (driver !== "codex-app-server" && driver !== "claude-code") {
      return { models: await deps.fallback(driver, context), ...(driver === "codex" ? { source: "cached" as const } : {}) };
    }

    const key = modelDiscoveryKey(agent);
    const previous = cache.get(key);
    if (!options.refresh) {
      if (previous) return previous;
    }

    let result: AgentModelDiscovery;
    if (driver === "claude-code") {
      if (!claudeModelProbeSupported(agent)) {
        result = { models: await deps.fallback(driver, context) };
        cache.set(key, result);
        return result;
      }
      try {
        const models = deps.queryClaude ? await deps.queryClaude(agent) : [];
        result = models.length ? { models, source: "live" } : { models: await deps.fallback(driver, context) };
        claudeFailures.delete(key);
      } catch {
        // A transient first failure must not poison the periodic discovery cache. Keep a prior live
        // result on explicit refresh failure. After three cold failures, cache the fallback so a
        // structurally broken CLI stops spawning forever; an explicit refresh still retries it.
        const failures = (claudeFailures.get(key) ?? 0) + 1;
        claudeFailures.set(key, failures);
        if (previous?.source === "live") return previous;
        const fallback = previous ?? { models: await deps.fallback(driver, context) };
        if (failures >= 3) cache.set(key, fallback);
        return fallback;
      }
      cache.set(key, result);
      return result;
    }

    try {
      result = { models: await deps.queryAppServer(agent), source: "live" };
    } catch (error) {
      // A working method that timed out or returned bad data must retain catalog metadata. Only an
      // older server that truly lacks model/list may use models_cache.json as a labeled fallback.
      if (!modelListUnavailable(error)) return previous ?? { models: [] };
      result = { models: await deps.fallback("codex", context), source: "cached" };
    }
    cache.set(key, result);
    return result;
  };
}

export const discoverAgentModels = createAgentModelDiscoverer({
  queryAppServer: queryCodexAppServerModels,
  queryClaude: queryClaudeModels,
  fallback: discoverModels,
});
