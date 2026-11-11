import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AssistantDestinationBinding, AssistantWork } from "./assistant-work.js";

export interface DiscordDeliveryBinding {
  bindingId: string; requesterId: string; accountId: string; destination: string; agentId: string;
  conversationId: string; sessionKey: string; connectorTokenEnv: string;
  updates?: {enabled: boolean; botTokenEnv: string; botUserId: string; dmChannelId?: string};
}
export interface DiscordDeliveryConnection {
  name: string; origin: string; controlPlaneId: string; connectionId: string; assistantTokenEnv: string;
  bindings: DiscordDeliveryBinding[];
}
interface WorkView {
  work: AssistantWork; binding: AssistantDestinationBinding;
  resolution: {path: string; requests: {path: string}[]; ordinaryChatGrantsApproval: false};
}
interface LocalReply {state: string; channel_id: string; nonce: string; message_id: string | null}
const snowflake = (value: unknown): value is string => typeof value === "string" && /^[0-9]{1,32}$/.test(value);
const canonical = (value: unknown): value is string => typeof value === "string" && /^[\w.:-]{1,128}$/.test(value);
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bounded JSON with no redirects or transport-error disclosure. Inject fetch only in tests.
 * Discord origins are fixed; Wollipog origins come exclusively from protected owner settings. */
export async function deliveryJson(request: typeof fetch, url: string | URL, init: RequestInit = {}): Promise<any> {
  const response = await request(url, {...init, redirect: "error", signal: AbortSignal.timeout(10_000)});
  if (!response.ok) {await response.body?.cancel(); throw new Error("remote_refused_or_unavailable");}
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing_receipt");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 256 * 1024) throw new Error("oversized_receipt");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {await reader.cancel();}
}

/** Runs inside the isolated OpenClaw process: Discord credentials never enter Wollipog.
 * The CP reply fence is authoritative across receivers; this local journal retains a Discord
 * message/nonce before an unavailable CP confirmation can lose that delivery evidence. */
export class AssistantDiscordDelivery {
  constructor(private sql: DatabaseSync, private deps: {
    connections(): DiscordDeliveryConnection[];
    secret(name: string): string | undefined;
    currentPolicy(binding: DiscordDeliveryBinding, guildId: string | null, parentId?: string, roles?: string[]): boolean;
    request?: typeof fetch;
  }) {
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_discord_reply_journal (
      position INTEGER PRIMARY KEY AUTOINCREMENT,binding_id TEXT NOT NULL,
      control_plane_id TEXT NOT NULL,connection_id TEXT NOT NULL,work_id TEXT NOT NULL,revision INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('uncertain','sent','confirmed')),channel_id TEXT NOT NULL,
      nonce TEXT NOT NULL,message_id TEXT,UNIQUE(control_plane_id,connection_id,work_id,revision));`);
  }
  private selected(name: string, bindingId: string) {
    const matches = this.deps.connections().filter(connection => connection.name === name);
    if (matches.length !== 1) throw new Error("unavailable_connection");
    const connection = matches[0]!;
    const bindings = connection.bindings.filter(binding => binding.bindingId === bindingId);
    if (bindings.length !== 1 || bindings[0]!.updates?.enabled !== true || !canonical(connection.controlPlaneId) ||
        !canonical(connection.connectionId)) throw new Error("unavailable_destination");
    const binding = bindings[0]!, origin = new URL(connection.origin);
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
        (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname)))) throw new Error("invalid_origin");
    const secret = (name: string) => {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error("invalid_secret_reference");
      const value = this.deps.secret(name);
      if (!value) throw new Error("missing_credentials");
      return value;
    };
    const assistant = secret(connection.assistantTokenEnv), connector = secret(binding.connectorTokenEnv), bot = secret(binding.updates!.botTokenEnv);
    if (!/^wollipoga_[A-Za-z0-9_-]{43}$/.test(assistant) || !/^wollipogc_[A-Za-z0-9_-]{43}$/.test(connector) ||
        !snowflake(binding.requesterId) || !snowflake(binding.updates!.botUserId) || !/^(channel|user):[0-9]{1,32}$/.test(binding.destination)) throw new Error("invalid_credentials_or_destination");
    return {connection, binding, origin: origin.origin, assistant, connector, bot};
  }
  private cp(selected: ReturnType<AssistantDiscordDelivery["selected"]>, path: string, body?: unknown) {
    return deliveryJson(this.deps.request ?? fetch, new URL(path, `${selected.origin}/`), {
      method: body === undefined ? "GET" : "POST", headers: {authorization: `Bearer ${selected.assistant}`,
        "x-wollipog-connector-token": selected.connector, ...(body === undefined ? {} : {"content-type": "application/json"})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  }
  private discord(bot: string, path: string, body?: unknown) {
    return deliveryJson(this.deps.request ?? fetch, `https://discord.com/api/v10${path}`, {
      method: body === undefined ? "GET" : "POST", headers: {authorization: `Bot ${bot}`,
        ...(body === undefined ? {} : {"content-type": "application/json"})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  }
  async prepare(name: string, bindingId: string, workId: string) {
    if (!canonical(workId)) throw new Error("invalid_work_identity");
    const initial = this.selected(name, bindingId);
    const view = await this.cp(initial, `/assistant/discord/work/${encodeURIComponent(workId)}`) as WorkView;
    if (!view?.work || view.work.controlPlaneId !== initial.connection.controlPlaneId || view.work.connectionId !== initial.connection.connectionId ||
        view.work.workId !== workId || view.work.bindingId !== bindingId || !Number.isSafeInteger(view.work.revision) || view.work.revision < 1 ||
        view.binding?.revoked !== false || view.binding.connectionId !== initial.connection.connectionId ||
        view.binding.id !== bindingId || !Number.isSafeInteger(view.binding.revision) ||
        ["requesterId", "accountId", "destination", "agentId", "conversationId", "sessionKey"].some(key =>
          (view.binding as unknown as Record<string, unknown>)[key] !== (initial.binding as unknown as Record<string, unknown>)[key])) throw new Error("wrong_work_or_destination");
    const channelId = initial.binding.destination.startsWith("channel:") ? initial.binding.destination.slice(8) : initial.binding.updates!.dmChannelId;
    if (!snowflake(channelId)) throw new Error("unproven_dm_channel");
    const channel = await this.discord(initial.bot, `/channels/${channelId}`);
    if (channel.id !== channelId) throw new Error("wrong_discord_channel");
    const me = await this.discord(initial.bot, "/users/@me");
    if (me.id !== initial.binding.updates!.botUserId || me.bot !== true) throw new Error("wrong_discord_account");
    let roles: string[] = [];
    if (initial.binding.destination.startsWith("user:")) {
      if (channel.type !== 1 || channel.guild_id || initial.binding.destination !== `user:${initial.binding.requesterId}` ||
          !Array.isArray(channel.recipients) || channel.recipients.length !== 1 || channel.recipients[0]?.id !== initial.binding.requesterId) throw new Error("wrong_dm_recipient");
    } else {
      if (![0, 5, 10, 11, 12].includes(channel.type) || !snowflake(channel.guild_id)) throw new Error("unsupported_discord_channel");
      const member = await this.discord(initial.bot, `/guilds/${channel.guild_id}/members/${initial.binding.requesterId}`);
      if (member.user?.id !== initial.binding.requesterId || !Array.isArray(member.roles) || member.roles.length > 250 ||
          member.roles.some((role: unknown) => !snowflake(role))) throw new Error("discord_membership_unproven");
      roles = member.roles;
      if ([10, 11, 12].includes(channel.type) && (!snowflake(channel.parent_id) || channel.thread_metadata?.archived !== false || channel.thread_metadata?.locked !== false)) throw new Error("unavailable_thread");
      const requiredBot = (1n << 10n) | (1n << 16n) | (1n << BigInt([10, 11, 12].includes(channel.type) ? 38 : 11));
      for (const [userId, required] of [[initial.binding.requesterId, (1n << 10n) | (1n << 16n)], [me.id, requiredBot]] as const) {
        const permissions = await this.discord(initial.bot, `/channels/${channelId}/permissions/member/${userId}`);
        if (typeof permissions.permissions !== "string" || !/^[0-9]{1,32}$/.test(permissions.permissions) ||
            (BigInt(permissions.permissions) & required) !== required) throw new Error("discord_access_changed");
        if (channel.type === 12) {
          const member = await this.discord(initial.bot, `/channels/${channelId}/thread-members/${userId}`);
          if (member.id !== channelId || member.user_id !== userId) throw new Error("private_thread_membership_unproven");
        }
      }
    }
    if (!this.deps.currentPolicy(initial.binding, channel.guild_id ?? null, channel.parent_id, roles) ||
        fingerprint(initial) !== fingerprint(this.selected(name, bindingId))) throw new Error("current_openclaw_policy_refused");
    return {view, selected: initial, channelId};
  }
  async reconcile(name: string, bindingId: string, after = ""): Promise<{items: AssistantWork[]; nextAfter: string | null}> {
    const selected = this.selected(name, bindingId);
    const page = await this.cp(selected, `/assistant/discord/work?after=${encodeURIComponent(after)}`);
    if (!Array.isArray(page.items) || page.items.length > 100 ||
        (page.nextAfter !== null && (typeof page.nextAfter !== "string" || !/^awc_[1-9][0-9]*$/.test(page.nextAfter))) ||
        page.items.some((work: AssistantWork) => work.controlPlaneId !== selected.connection.controlPlaneId ||
          work.connectionId !== selected.connection.connectionId || work.bindingId !== bindingId || !canonical(work.workId))) throw new Error("wrong_work_page");
    return page;
  }
  async deliver(name: string, bindingId: string, workId: string, revision?: number): Promise<{state: string}> {
    let prepared = await this.prepare(name, bindingId, workId);
    const {work} = prepared.view;
    const version = revision ?? work.revision;
    const keys = [work.controlPlaneId, work.connectionId, workId, version] as const;
    const prior = this.sql.prepare("SELECT * FROM assistant_discord_reply_journal WHERE control_plane_id=? AND connection_id=? AND work_id=? AND revision=?").get(...keys) as LocalReply | undefined;
    if (prior?.state === "confirmed") return {state: "confirmed"};
    const nonce = fingerprint(keys).slice(0, 24);
    let messageId = prior?.message_id ?? null;
    if (prior && prior.channel_id !== prepared.channelId) throw new Error("reply_destination_changed");
    const receiptMatches = (message: any) => snowflake(message?.id) && message.channel_id === prepared.channelId &&
      message.author?.id === prepared.selected.binding.updates!.botUserId && String(message.nonce) === nonce;
    if (prior && !messageId) {
      const recent = await this.discord(prepared.selected.bot, `/channels/${prepared.channelId}/messages?limit=100`);
      if (!Array.isArray(recent) || recent.length > 100) throw new Error("unproven_discord_receipt");
      const matches = recent.filter(receiptMatches);
      if (matches.length !== 1) return {state: "uncertain"};
      messageId = matches[0].id;
    }
    if (!prior) {
      if (version !== work.revision) throw new Error("work_revision_changed");
      const notice = renderDiscordWorkNotice(prepared.view, prepared.selected.origin);
      // Repeat asynchronous source and Discord checks immediately before the durable send fence.
      prepared = await this.prepare(name, bindingId, workId);
      if (prepared.view.work.revision !== version) throw new Error("work_revision_changed");
      const begin = await this.cp(prepared.selected, `/assistant/discord/work/${encodeURIComponent(workId)}/replies`, {action: "begin", revision: version});
      if (begin.state !== "send") return {state: begin.state === "confirmed" ? "confirmed" : "uncertain"};
      this.sql.prepare(`INSERT INTO assistant_discord_reply_journal
        (control_plane_id,connection_id,work_id,revision,state,channel_id,nonce,binding_id)
        VALUES (?,?,?,?,'uncertain',?,?,?)`).run(...keys, prepared.channelId, nonce, bindingId);
      prepared = await this.prepare(name, bindingId, workId);
      if (prepared.view.work.revision !== version) throw new Error("work_revision_changed");
      // A crash or any unknown POST result stays uncertain. Never replay after a restart.
      const message = await this.discord(prepared.selected.bot, `/channels/${prepared.channelId}/messages`,
        {content: notice, nonce, enforce_nonce: true, allowed_mentions: {parse: []}, flags: 4});
      if (!receiptMatches(message)) throw new Error("unproven_discord_receipt");
      messageId = message.id;
    }
    this.sql.prepare("UPDATE assistant_discord_reply_journal SET state='sent',message_id=? WHERE control_plane_id=? AND connection_id=? AND work_id=? AND revision=?")
      .run(messageId, ...keys);
    // Retained message evidence is checked with Discord before reconciliation, never model text.
    prepared = await this.prepare(name, bindingId, workId);
    const message = await this.discord(prepared.selected.bot, `/channels/${prepared.channelId}/messages/${messageId}`);
    if (!receiptMatches(message)) throw new Error("unproven_discord_receipt");
    const confirmed = await this.cp(prepared.selected, `/assistant/discord/work/${encodeURIComponent(workId)}/replies`, {action: "confirm", revision: version, messageId});
    if (confirmed.state !== "confirmed") throw new Error("unconfirmed_control_plane_receipt");
    this.sql.prepare("UPDATE assistant_discord_reply_journal SET state='confirmed' WHERE control_plane_id=? AND connection_id=? AND work_id=? AND revision=?").run(...keys);
    return {state: "confirmed"};
  }
  outstanding(limit = 100, after = 0) {
    return this.sql.prepare("SELECT position,binding_id,control_plane_id,connection_id,work_id,revision FROM assistant_discord_reply_journal WHERE state<>'confirmed' AND position>? ORDER BY position LIMIT ?")
      .all(after, Math.max(1, Math.min(100, limit))) as {position: number; binding_id: string; control_plane_id: string; connection_id: string; work_id: string; revision: number}[];
  }
}

export function renderDiscordWorkNotice(view: WorkView, origin: string): string {
  const base = `/sessions/~${Buffer.from(view.work.sessionId, "utf16le").toString("base64url")}`;
  if (view.resolution?.ordinaryChatGrantsApproval !== false || view.resolution.path !== base ||
      !Array.isArray(view.resolution.requests)) throw new Error("unproven_resolution_path");
  const request = view.resolution.requests[0];
  const path = request?.path ?? base;
  if (request && (!path.startsWith(`${base}/attention/~`) || /[\r\n<>]/.test(path))) throw new Error("unproven_resolution_path");
  const states: Record<string, string> = {completed: "Work completed.", failed: "Work failed.", input_required: "Work needs attention.",
    idle: "Work is idle.", stopped: "Work stopped.", running: "Work is running.", queued: "Work is queued.", starting: "Work is starting."};
  const status = request ? "Work needs attention." : states[view.work.status] ?? "Work changed.";
  const notice = `${status} ${new URL(path, origin).href}${request ? " Answer or approve through Wollipog; a Discord reply grants no approval." : ""}`;
  if (notice.length > 2000) throw new Error("notice_exceeds_discord_limit");
  return notice;
}
