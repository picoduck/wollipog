import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { currentDiscordUpdateRoutePolicy } from "./policy.mjs";

export const TESTED_OPENCLAW_VERSION = "2026.11.3";
const HELP = "Use /wollipog launch <connection> <request-id> <target> <task>, prompt <connection> <request-id> <original-request-id> <text>, or status <connection> <request-id>.";
const key = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value);
const resourceKey = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const inside = (root, path) => { const name = relative(root, path); return name !== "" && !name.startsWith(`..${sep}`) && name !== ".." && !isAbsolute(name); };
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Explicit isolated state/config overrides, not the user's baseline profile. No credential
 * values are allowed in the OpenClaw plugin config or the model's tool configuration. */
export function readNativeSettings(pluginConfig, env = process.env) {
  if (!pluginConfig || !key(pluginConfig.profile) || ["default", "dev"].includes(pluginConfig.profile) ||
      env.OPENCLAW_PROFILE !== pluginConfig.profile || !isAbsolute(env.OPENCLAW_STATE_DIR ?? "") ||
      !isAbsolute(env.OPENCLAW_CONFIG_PATH ?? "") || !isAbsolute(pluginConfig.configPath ?? "")) throw new Error("isolated_profile_required");
  const root = realpathSync(env.OPENCLAW_STATE_DIR);
  let baseline = resolve(homedir(), ".openclaw");
  try { baseline = realpathSync(baseline); } catch { /* absent baseline */ }
  if (root === baseline || !inside(root, realpathSync(env.OPENCLAW_CONFIG_PATH))) throw new Error("isolated_profile_required");
  const path = realpathSync(pluginConfig.configPath);
  const privateRoot = realpathSync(join(root, "private"));
  if (!inside(root, privateRoot) || !inside(privateRoot, path)) throw new Error("private_configuration_required");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let input;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("private_configuration_required");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      length += count;
      if (length === bytes.length) throw new Error("oversized_configuration");
      if (!count) break;
    }
    input = JSON.parse(bytes.subarray(0, length).toString("utf8"));
  } finally { closeSync(fd); }
  if (input?.version !== 1 || !Array.isArray(input.connections) || !input.connections.length || input.connections.length > 32) throw new Error("invalid_configuration");
  return input;
}

export function parseNativeCommand(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 16 * 1024) throw new Error("invalid_command");
  const match = raw.trim().match(/^(launch|prompt|status)\s+(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/);
  if (!match || !key(match[2]) || !key(match[3])) throw new Error("invalid_command");
  const [, action, connection, requestId, remainder] = match;
  if (action === "status") {
    if (remainder) throw new Error("invalid_command");
    return {action, connection, requestId};
  }
  const tail = remainder?.match(/^(\S+)\s+([\s\S]+)$/);
  if (!tail || !key(tail[1]) || !tail[2].trim()) throw new Error("invalid_command");
  return {action, connection, requestId, selector: tail[1], text: tail[2].trim()};
}

function normalizedDestination(ctx) {
  const to = typeof ctx.to === "string" ? ctx.to.replace(/^discord:/, "") : "";
  if (ctx.messageThreadId !== undefined) {
    if (typeof ctx.messageThreadId === "number" && !Number.isSafeInteger(ctx.messageThreadId)) throw new Error("unproven_conversation");
    const thread = String(ctx.messageThreadId);
    if (!/^[0-9]{1,32}$/.test(thread) || !/^channel:[0-9]{1,32}$/.test(to) ||
        (ctx.threadParentId !== undefined && !/^[0-9]{1,32}$/.test(ctx.threadParentId))) throw new Error("unproven_conversation");
    if (ctx.threadParentId !== undefined && to !== `channel:${ctx.threadParentId}` && to !== `channel:${thread}`) throw new Error("unproven_conversation");
    return `channel:${thread}`;
  }
  if (!/^(channel|user):[0-9]{1,32}$/.test(to)) throw new Error("unproven_conversation");
  return to;
}

/** Selection uses only host context, never command text containing a claimed sender or route.
 * Ambiguous bindings fail closed. Commands from Gateway/webchat, cron and model tools cannot
 * manufacture the host-authorized Discord context used by this native registrar. */
export function selectNativeBinding(settings, ctx, connectionName, env = process.env) {
  if (ctx.channel !== "discord" || ctx.isAuthorizedSender !== true || typeof ctx.senderId !== "string" ||
      !ctx.senderId || typeof ctx.accountId !== "string" || !ctx.accountId || typeof ctx.agentId !== "string") throw new Error("unproven_requester");
  const destination = normalizedDestination(ctx);
  const connections = settings.connections.filter(connection => connection?.name === connectionName);
  if (connections.length !== 1) throw new Error("unavailable_connection");
  const connection = connections[0];
  const origin = new URL(connection.origin);
  if (origin.username || origin.password || origin.hash || origin.search || origin.pathname !== "/" ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname)))) throw new Error("invalid_origin");
  if (!resourceKey(connection.controlPlaneId) || !resourceKey(connection.connectionId) || !Array.isArray(connection.bindings)) throw new Error("invalid_configuration");
  const bindings = connection.bindings.filter(binding => binding?.requesterId === ctx.senderId && binding.accountId === ctx.accountId &&
    binding.destination === destination && binding.agentId === ctx.agentId);
  if (bindings.length !== 1 || !resourceKey(bindings[0].bindingId)) throw new Error("unbound_requester_or_conversation");
  const binding = bindings[0];
  if (destination.startsWith("user:") && destination !== `user:${ctx.senderId}`) throw new Error("unproven_conversation");
  const fromEnvironment = name => {
    if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error("invalid_secret_reference");
    return env[name];
  };
  const assistantToken = fromEnvironment(connection.assistantTokenEnv), connectorToken = fromEnvironment(binding.connectorTokenEnv);
  if (!/^wollipoga_[A-Za-z0-9_-]{43}$/.test(assistantToken ?? "") || !/^wollipogc_[A-Za-z0-9_-]{43}$/.test(connectorToken ?? "")) throw new Error("missing_credentials");
  return {connection, binding, origin: origin.origin, assistantToken, connectorToken};
}

export function nativeCommandIdentity(selected, requestId, kind = "command") {
  if (!key(requestId)) throw new Error("invalid_command");
  return `discord:${digest([selected.connection.controlPlaneId, selected.connection.connectionId, selected.binding.bindingId, kind, requestId])}`;
}

async function responseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing_response");
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 64 * 1024) throw new Error("oversized_response");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel(); }
}

/** No retry loop. Command identity is deterministic across plugin/Gateway restarts. The user
 * can read the retained command receipt with status before deciding whether another action is new. */
export async function executeNativeCommand(api, ctx, deps = {}) {
  const env = deps.env ?? process.env, request = deps.request ?? fetch;
  const load = deps.loadSettings ?? (() => readNativeSettings(api.pluginConfig, env));
  if (api.runtime.version !== TESTED_OPENCLAW_VERSION) throw new Error("untested_host_version");
  const minimal = tools => tools?.profile === "minimal" && !tools.alsoAllow?.length && !tools.allow?.length;
  const assertDedicated = () => {
    const config = api.runtime.config?.current?.() ?? api.config;
    if (!minimal(config?.tools) || Object.keys(config?.mcp?.servers ?? {}).length ||
        config?.agents?.list?.some(agent => agent.tools && !minimal(agent.tools))) throw new Error("dedicated_native_profile_required");
  };
  assertDedicated();
  const parsed = parseNativeCommand(ctx.args);
  const initial = selectNativeBinding(load(), ctx, parsed.connection, env);
  const fingerprint = selected => digest(selected);
  const recheck = () => {
    assertDedicated();
    const selected = selectNativeBinding(load(), ctx, parsed.connection, env);
    if (fingerprint(initial) !== fingerprint(selected)) throw new Error("configuration_changed");
    ctx.assertOwnerCurrent?.();
    return selected;
  };
  const http = async (path, body, connector = false) => {
    const current = recheck();
    const response = await request(new URL(path, `${current.origin}/`), {method: body === undefined ? "GET" : "POST",
      redirect: "error", signal: AbortSignal.timeout(10_000), headers: {authorization: `Bearer ${current.assistantToken}`,
        ...(connector ? {"x-wollipog-connector-token": current.connectorToken} : {}),
        ...(body === undefined ? {} : {"content-type": "application/json"})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    if (!response.ok) { await response.body?.cancel(); throw new Error("control_plane_refused"); }
    return responseJson(response);
  };
  const discovery = await http("/assistant/mcp", {jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: "assistant_discover", arguments: {}}});
  const content = discovery?.result?.content;
  if (discovery?.result?.isError || !Array.isArray(content) || content.length !== 1 || typeof content[0].text !== "string") throw new Error("unverified_installation");
  const identity = JSON.parse(content[0].text);
  if (identity.controlPlane?.id !== initial.connection.controlPlaneId || identity.connection?.id !== initial.connection.connectionId) throw new Error("wrong_installation");
  const commandId = nativeCommandIdentity(initial, parsed.requestId);
  const verifyReceipt = (receipt, expectedId) => {
    if (!receipt || receipt.controlPlaneId !== initial.connection.controlPlaneId || receipt.connectionId !== initial.connection.connectionId ||
        receipt.operationId !== expectedId || !["accepted", "running", "succeeded", "failed", "uncertain"].includes(receipt.status)) throw new Error("unverified_receipt");
    return receipt;
  };
  if (parsed.action === "status") {
    const {receipt} = await http(`/assistant/discord/commands/${encodeURIComponent(commandId)}`, undefined, true);
    return {action: "status", receipt: receipt === null ? null : verifyReceipt(receipt, commandId)};
  }
  let args, workId;
  if (parsed.action === "launch") {
    const target = initial.connection.launchTargets?.[parsed.selector];
    if (!target || !resourceKey(target.locationId) || !resourceKey(target.agentId)) throw new Error("unavailable_target");
    args = {commandId, locationId: target.locationId, agentId: target.agentId, prompt: parsed.text, useWorktree: true};
    workId = nativeCommandIdentity(initial, parsed.requestId, "work");
  } else {
    const original = nativeCommandIdentity(initial, parsed.selector);
    const {receipt} = await http(`/assistant/discord/commands/${encodeURIComponent(original)}`, undefined, true);
    verifyReceipt(receipt, original);
    if (receipt.status !== "succeeded" || receipt.operation !== "session_launch" || typeof receipt.resourceId !== "string") throw new Error("unconfirmed_original_work");
    workId = nativeCommandIdentity(initial, parsed.selector, "work");
    args = {commandId, sessionId: receipt.resourceId, text: parsed.text};
  }
  const result = await http("/assistant/discord/commands", {operation: parsed.action === "launch" ? "session_launch" : "session_prompt", arguments: args, workId}, true);
  verifyReceipt(result.receipt, commandId);
  return {action: parsed.action, ...result};
}

export function registerNativeCommand(api, deps) {
  api.registerCommand({name: "wollipog", channels: ["discord"], requireAuth: true, acceptsArgs: true,
    description: "Launch, follow up on, or reconcile explicitly bound Wollipog work.",
    handler: async ctx => {
      try {
        const result = await executeNativeCommand(api, ctx, deps);
        if (result.action === "status") return {text: result.receipt ? `Work command status: ${result.receipt.status}.` : "No accepted command was found for that request ID."};
        if (result.receipt?.status === "succeeded") return {text: "Work command accepted. Keep the request ID to reconcile it or send a follow-up."};
        return {text: "The work command was not confirmed. Check its status before submitting another command."};
      } catch {
        api.logger?.warn?.(JSON.stringify({event: "wollipog_native_command", outcome: "refused_or_uncertain"}));
        return {text: `The command was refused or its delivery is uncertain. Check its status before retrying. ${HELP}`};
      }
    }});
}

export function registerDiscordBridgeService(api) {
  let bridge, sql;
  api.registerService({id: "wollipog-assistant-updates", apiVersion: 2,
    async start({scheduler}) {
      if (api.runtime.version !== TESTED_OPENCLAW_VERSION) throw new Error("untested_host_version");
      const settings = () => readNativeSettings(api.pluginConfig);
      if (!settings().bridge) return; // No receiver, secret reads or sockets until owner opt-in.
      if (!scheduler || typeof api.runtime.config?.current !== "function") throw new Error("unsupported_bridge_runtime");
      const privateRoot = realpathSync(dirname(api.pluginConfig.configPath)), metadata = statSync(privateRoot);
      if ((metadata.mode & 0o077) !== 0 || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) throw new Error("private_state_required");
      const path = join(privateRoot, "wollipog-bridge.sqlite");
      const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const file = fstatSync(fd);
        if (!file.isFile() || (file.mode & 0o077) !== 0 || (typeof process.getuid === "function" && file.uid !== process.getuid())) throw new Error("private_state_required");
      } finally {closeSync(fd);}
      const {DatabaseSync} = await import("node:sqlite");
      sql = new DatabaseSync(path);
      try {
        const {startDiscordBridge} = await import("./dist/bridge.mjs");
        bridge = await startDiscordBridge({sql, settings, secret: name => process.env[name],
          currentPolicy: (binding, guildId, parentId, roles) => currentDiscordUpdateRoutePolicy(api, binding, guildId, parentId, roles),
          diagnostic: reason => api.logger.warn(JSON.stringify({event: "wollipog_discord_bridge", reason})),
        });
        scheduler.schedule({id: "reconcile", delayMs: 0, everyMs: 30_000, run: () => bridge.tick()});
      } catch {await bridge?.close(); sql.close(); sql = undefined; bridge = undefined; throw new Error("bridge_start_refused");}
    },
    async stop() {await bridge?.close(); sql?.close(); bridge = undefined; sql = undefined;},
  });
}

export default {id: "wollipog-assistant-discord", name: "Wollipog Assistant Discord",
  description: "Owner-bound Discord command ingress and durable work updates for Wollipog.",
  register(api) {registerNativeCommand(api); registerDiscordBridgeService(api);}};
