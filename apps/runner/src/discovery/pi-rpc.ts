import { homedir } from "node:os";
import type { AgentCapabilities, AgentContext, AgentModel, AgentSlashCommand } from "@wollipog/protocol";
import { PiRpcPeer } from "../pi-rpc-peer.js";
import { killTree, spawnAgent, type AgentProcess } from "../spawn.js";
import type { ResolvedLaunch } from "./resolve.js";

type Json = Record<string, unknown>;

const MAX_DISCOVERED_MODELS = 128;
const MAX_DISCOVERED_COMMANDS = 512;

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function commandSource(command: Json): AgentSlashCommand["source"] {
  if (command.location === "project") return "project";
  return command.source === "extension" ? "plugin" : "user";
}

export interface PiRpcDiscoveryResult {
  available: boolean;
  authStatus: "authenticated" | "unauthenticated" | "unknown";
  capabilities: AgentCapabilities;
  unavailableReason?: string;
}

/** Prove the installed Pi process speaks the required RPC contract and derive every selectable
 * model, thinking level, command, and skill from that exact runtime. The ephemeral probe uses
 * Pi's fail-closed project-trust flag, so repository-controlled resources cannot execute. */
export async function probePiRpc(
  launch: ResolvedLaunch,
  context: AgentContext,
  options: {
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    spawn?: typeof spawnAgent;
    kill?: typeof killTree;
  } = {},
): Promise<PiRpcDiscoveryResult> {
  const spawn = options.spawn ?? spawnAgent;
  const kill = options.kill ?? killTree;
  const timeoutMs = options.timeoutMs ?? 12_000;
  const deadlineAt = Date.now() + timeoutMs;
  const remaining = (): number => {
    const value = deadlineAt - Date.now();
    if (value <= 0) throw new Error("Pi RPC compatibility probe timed out");
    return value;
  };
  let child: AgentProcess | null = null;
  let peer: PiRpcPeer | null = null;
  try {
    child = spawn({
      command: launch.command,
      args: [...launch.args, "--mode", "rpc", "--no-approve", "--no-session"],
      cwd: options.cwd ?? (context.kind === "wsl" ? "/" : homedir()),
      env: { ...options.env, PI_OFFLINE: "1" },
      context,
      trackDescendants: false,
    });
    let transportError: Error | null = null;
    peer = new PiRpcPeer(child.stdin, child.stdout, () => {}, (error) => { transportError = error; });
    const initialRequestTimeoutMs = remaining();
    const [stateResponse, modelsResponse, commandsResponse] = await Promise.all([
      peer.request<Json>({ type: "get_state" }, initialRequestTimeoutMs),
      peer.request<Json>({ type: "get_available_models" }, initialRequestTimeoutMs),
      peer.request<Json>({ type: "get_commands" }, initialRequestTimeoutMs),
    ]);
    if (transportError) throw transportError;
    const state = object(stateResponse.data);
    const active = object(state?.model);
    const available = object(modelsResponse.data)?.models;
    if (!Array.isArray(available)) throw new Error("get_available_models returned no model catalog");
    if (available.length > MAX_DISCOVERED_MODELS) throw new Error("model catalog exceeds the supported bound");
    const entriesResponse = await peer.request<Json>({ type: "get_entries" }, remaining()).catch(() => undefined);
    const entries = object(entriesResponse?.data);
    const supportsConversationFork = Array.isArray(entries?.entries) && entries?.leafId === null;

    const models: AgentModel[] = [];
    for (const rawModel of available) {
      const model = object(rawModel);
      if (!model) continue;
      const provider = nonempty(model?.provider);
      const id = nonempty(model?.id);
      if (!provider || !id) continue;
      const selection = `${provider}/${id}`;
      const effortResponse = await peer.request<Json>({ type: "set_model", provider, modelId: id }, remaining());
      const selected = object(effortResponse.data);
      if (nonempty(selected?.provider) !== provider || nonempty(selected?.id) !== id) {
        throw new Error("set_model did not confirm the requested model");
      }
      const levelsResponse = await peer.request<Json>({ type: "get_available_thinking_levels" }, remaining());
      const rawLevels = object(levelsResponse.data)?.levels;
      if (!Array.isArray(rawLevels)) throw new Error("thinking-level discovery returned no level catalog");
      const efforts = rawLevels.filter((level): level is string => typeof level === "string" && level.length > 0);
      const input = Array.isArray(model.input)
        ? model.input.filter((item): item is "text" | "image" => item === "text" || item === "image")
        : undefined;
      models.push({
        id: selection,
        displayName: nonempty(model.name) ?? selection,
        default: active?.provider === provider && active?.id === id,
        inputModalities: input?.length ? input : undefined,
        efforts: efforts.length ? efforts : undefined,
        defaultEffort: active?.provider === provider && active?.id === id &&
            efforts.includes(String(state?.thinkingLevel))
          ? String(state?.thinkingLevel)
          : undefined,
        contextWindow: typeof model.contextWindow === "number" && model.contextWindow > 0
          ? model.contextWindow
          : undefined,
      });
    }

    const rawCommands = object(commandsResponse.data)?.commands;
    if (!Array.isArray(rawCommands)) throw new Error("get_commands returned no command catalog");
    if (rawCommands.length > MAX_DISCOVERED_COMMANDS) throw new Error("command catalog exceeds the supported bound");
    const slashCommands = rawCommands.flatMap((raw): AgentSlashCommand[] => {
      const command = object(raw);
      const name = nonempty(command?.name);
      if (!command || !name) return [];
      return [{ name, description: nonempty(command.description), source: commandSource(command) }];
    });
    const effortLevels = [...new Set(models.flatMap((model) => model.efforts ?? []))];
    const capabilities: AgentCapabilities = {
      models,
      effortLevels,
      slashCommands,
      modelSource: "live",
      supportsImages: models.some((model) => model.inputModalities?.includes("image")),
      supportsApprovals: false,
      // get_entries was added after Pi's persisted-session --fork surface. Requiring its structured
      // response and an empty no-session leaf prevents older runtimes from advertising a clone
      // action they cannot bind to an authoritative completed checkpoint.
      supportsConversationFork,
      supportsSteering: true,
      permissionModes: [],
    };
    if (!models.length) {
      return {
        available: false,
        authStatus: "unauthenticated",
        capabilities,
        unavailableReason: "Pi is installed, but it reported no authenticated models. Run `pi` and configure a provider account.",
      };
    }
    return { available: true, authStatus: "authenticated", capabilities };
  } catch {
    return {
      available: false,
      authStatus: "unknown",
      capabilities: {
        models: [],
        effortLevels: [],
        slashCommands: [],
        supportsImages: false,
        supportsApprovals: false,
        supportsConversationFork: false,
        supportsSteering: false,
        permissionModes: [],
      },
      unavailableReason: "The installed Pi CLI did not satisfy Wollipog's RPC compatibility probe. Upgrade `@earendil-works/pi-coding-agent` and rediscover.",
    };
  } finally {
    peer?.dispose("Pi discovery complete");
    if (child) kill(child);
  }
}

export function unavailablePiCapabilities(): AgentCapabilities {
  return {
    models: [],
    effortLevels: [],
    slashCommands: [],
    supportsImages: false,
    supportsApprovals: false,
    supportsConversationFork: false,
    supportsSteering: false,
    permissionModes: [],
  };
}
