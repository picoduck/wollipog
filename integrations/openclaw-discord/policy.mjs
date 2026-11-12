/** Delayed updates deliberately support the explicit-ID allowlist subset of OpenClaw policy.
 * Roles, names, wildcards and dynamic groups never expand this standing requester binding. */
export function currentDiscordUpdatePolicy(config, binding, guildId, parentId, env = process.env) {
  const minimal = tools => tools?.profile === "minimal" && !tools.alsoAllow?.length && !tools.allow?.length;
  if (!minimal(config?.tools) || Object.keys(config?.mcp?.servers ?? {}).length ||
      config?.agents?.list?.some(agent => agent.tools && !minimal(agent.tools))) return false;
  const root = config?.channels?.discord;
  if (!root || root.enabled === false) return false;
  const account = root.accounts?.[binding.accountId];
  if (!account || account.enabled === false) return false;
  const token = account.token ?? root.token;
  const tokenEnv = binding.updates?.botTokenEnv;
  if (!tokenEnv || !env[tokenEnv] || !(token === env[tokenEnv] ||
      (token?.source === "env" && token.id === tokenEnv))) return false;
  const includes = (list, id) => Array.isArray(list) && list.some(value => value === id || value === `discord:${id}`);
  if (guildId === null) return (account.dmPolicy ?? root.dmPolicy) === "allowlist" &&
    includes(account.allowFrom ?? root.allowFrom, binding.requesterId);
  if ((account.groupPolicy ?? root.groupPolicy ?? "allowlist") !== "allowlist") return false;
  const guild = (account.guilds ?? root.guilds)?.[guildId];
  if (!guild || !includes(guild.users, binding.requesterId)) return false;
  const channelId = binding.destination.startsWith("channel:") ? binding.destination.slice(8) : "";
  const channel = guild.channels?.[channelId] ?? (parentId ? guild.channels?.[parentId] : undefined);
  return channel?.enabled === true && (channel.users === undefined || includes(channel.users, binding.requesterId));
}

export function currentDiscordUpdateRoutePolicy(api, binding, guildId, parentId, roles = [], env = process.env) {
  const current = api.runtime.config?.current?.();
  const resolve = api.runtime.channel?.routing?.resolveAgentRoute;
  if (!currentDiscordUpdatePolicy(current, binding, guildId, parentId, env) || typeof resolve !== "function") return false;
  const direct = binding.destination.startsWith("user:");
  const route = resolve({cfg: current, channel: "discord", accountId: binding.accountId,
    peer: {kind: direct ? "direct" : "channel", id: binding.destination.slice(direct ? 5 : 8)},
    ...(parentId ? {parentPeer: {kind: "channel", id: parentId}} : {}), guildId, memberRoleIds: roles});
  return route?.agentId === binding.agentId && route.accountId === binding.accountId && route.sessionKey === binding.sessionKey;
}
