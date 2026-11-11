import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import { AssistantEventInbox, registerAssistantEventReceiver, wakeOpenClaw } from "./assistant-event-receiver.js";
import { AssistantDiscordDelivery, type DiscordDeliveryConnection, type DiscordDeliveryBinding } from "./assistant-discord-delivery.js";

export interface BridgeConnection extends DiscordDeliveryConnection {
  events?: {subscriptionId: string; path: string; signingSecretEnv: string};
}
export interface BridgeSettings {
  connections: BridgeConnection[];
  bridge: {port: number; gatewayOrigin: string; hookTokenEnv: string};
}
/** A separately enabled OpenClaw service, never a control-plane daemon. Existing raw signature
 * verification/inbox/hook client are bundled without changing their wire contract. */
export async function startDiscordBridge(deps: {
  sql: DatabaseSync; settings(): BridgeSettings; secret(name: string): string | undefined;
  currentPolicy(binding: DiscordDeliveryBinding, guildId: string | null, parentId?: string, roles?: string[]): boolean;
  diagnostic(reason: string): void; request?: typeof fetch;
  /** Request-injection harness only; the production plugin always listens on loopback. */
  listen?: boolean;
}) {
  const settings = deps.settings(), sql = deps.sql;
  if (!Number.isSafeInteger(settings.bridge.port) || settings.bridge.port < 1024 || settings.bridge.port > 65535 ||
      !Array.isArray(settings.connections) || settings.connections.length > 32) throw new Error("invalid_bridge_configuration");
  sql.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
  AssistantEventInbox.install(sql);
  sql.exec(`CREATE TABLE IF NOT EXISTS assistant_bridge_meta (name TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assistant_bridge_wakes (
    control_plane_id TEXT NOT NULL,connection_id TEXT NOT NULL,work_id TEXT NOT NULL,revision INTEGER NOT NULL,
    run_id TEXT,PRIMARY KEY(control_plane_id,connection_id,work_id,revision));`);
  const get = (name: string) => (sql.prepare("SELECT value FROM assistant_bridge_meta WHERE name=?").get(name) as {value: string} | undefined)?.value;
  const set = (name: string, value: string) => sql.prepare("INSERT INTO assistant_bridge_meta VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(name, value);
  const topology = (input: BridgeSettings) => JSON.stringify([input.bridge, input.connections.map(connection =>
    [connection.name, connection.controlPlaneId, connection.connectionId, connection.events])]);
  const initialTopology = topology(settings);
  const current = () => {
    const value = deps.settings();
    if (topology(value) !== initialTopology) throw new Error("bridge_topology_changed_restart_isolated_service");
    return value;
  };
  const sender = new AssistantDiscordDelivery(sql, {...deps, connections: () => current().connections});
  const inbox = new AssistantEventInbox(sql), app = Fastify({logger: false});
  const paths = new Set<string>();
  for (const connection of settings.connections) {
    const events = connection.events;
    if (!events) continue;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(events.path) || paths.has(events.path)) throw new Error("invalid_receiver_path");
    paths.add(events.path);
    await app.register(async child => registerAssistantEventReceiver(child, {
      controlPlaneId: connection.controlPlaneId, connectionId: connection.connectionId, subscriptionId: events.subscriptionId,
      currentSecret: () => {
        try {
          const target = current().connections.find(item => item.connectionId === connection.connectionId && item.controlPlaneId === connection.controlPlaneId);
          const name = target?.events?.signingSecretEnv;
          return name && /^[A-Z][A-Z0-9_]{0,127}$/.test(name) ? deps.secret(name) ?? null : null;
        } catch {return null;}
      }, inbox, diagnostic: fields => deps.diagnostic(`signed_event_${fields.reason}`),
    }), {prefix: `/events/${events.path}`});
  }
  // Loopback-only. Owner-controlled HTTPS reverse proxy/tunnel supplies remote reachability.
  if (deps.listen === false) await app.ready();
  else await app.listen({host: "127.0.0.1", port: settings.bridge.port});
  let active: Promise<void> | undefined, closing = false;
  const observe = async (name: string, bindingId: string, workId: string, eventId: string) => {
    const prepared = await sender.source(name, bindingId, workId);
    const {work} = prepared.view, keys = [work.controlPlaneId, work.connectionId, work.workId, work.revision] as const;
    const existing = sql.prepare("SELECT run_id FROM assistant_bridge_wakes WHERE control_plane_id=? AND connection_id=? AND work_id=? AND revision=?").get(...keys);
    if (!existing) {
      const config = current().bridge;
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(config.hookTokenEnv)) throw new Error("invalid_hook_secret_reference");
      const token = deps.secret(config.hookTokenEnv);
      if (!token) throw new Error("missing_hook_credential");
      // Recheck source and destination after asynchronous preparation and before admission.
      const checked = await sender.prepare(name, bindingId, workId);
      if (checked.view.work.revision !== work.revision) throw new Error("work_revision_changed");
      const admitted = sql.prepare("INSERT OR IGNORE INTO assistant_bridge_wakes VALUES (?,?,?,?,NULL)").run(...keys);
      try { if (admitted.changes) {
        const result = await wakeOpenClaw({gatewayOrigin: config.gatewayOrigin, hookToken: token, binding: checked.view.binding,
          controlPlaneId: work.controlPlaneId, connectionId: work.connectionId, workId, eventId}, deps.request);
        if (result.runId) sql.prepare("UPDATE assistant_bridge_wakes SET run_id=? WHERE control_plane_id=? AND connection_id=? AND work_id=? AND revision=?").run(result.runId, ...keys);
        deps.diagnostic(result.runId ? "hook_admission_accepted" : "hook_admission_uncertain");
      }} catch {deps.diagnostic("hook_admission_uncertain");}
    }
    const reply = await sender.deliver(name, bindingId, workId);
    deps.diagnostic(reply.state === "confirmed" ? "work_reply_confirmed" : "work_reply_uncertain");
    const wake = sql.prepare("SELECT run_id FROM assistant_bridge_wakes WHERE control_plane_id=? AND connection_id=? AND work_id=? AND revision=?").get(...keys) as {run_id: string | null};
    return {runId: wake.run_id};
  };
  const drain = async () => {
    const config = current();
    // Bounded pages advance independently of success so inaccessible work cannot starve later
    // authorized conversations. Every sweep revisits current state and uncertain receipts.
    const destinations = config.connections.flatMap(connection => connection.bindings.filter(binding => binding.updates?.enabled === true)
      .map(binding => ({connection, binding})));
    if (!destinations.length || destinations.length > 128) throw new Error("invalid_update_bindings");
    const index = Number(get("binding_index") ?? 0) % destinations.length;
    const {connection, binding} = destinations[index]!;
    set("binding_index", String((index + 1) % destinations.length));
    const cursorKey = createHash("sha256").update(JSON.stringify([connection.controlPlaneId, connection.connectionId, binding.bindingId])).digest("hex");
    try {
      const page = await sender.reconcile(connection.name, binding.bindingId, get(cursorKey) ?? "");
      for (const work of page.items) {
        try {await observe(connection.name, binding.bindingId, work.workId,
          `reconcile:${createHash("sha256").update(JSON.stringify([work.controlPlaneId, work.connectionId, work.workId, work.revision])).digest("hex")}`);}
        catch {deps.diagnostic("work_update_blocked_or_uncertain");}
      }
      set(cursorKey, page.nextAfter ?? "");
    } catch {deps.diagnostic("work_reconciliation_unavailable");}
    const outstanding = sender.outstanding(5, Number(get("reply_position") ?? 0));
    for (const receipt of outstanding) {
      const target = destinations.find(item => item.connection.controlPlaneId === receipt.control_plane_id &&
        item.connection.connectionId === receipt.connection_id && item.binding.bindingId === receipt.binding_id);
      if (!target) continue;
      try {await sender.deliver(target.connection.name, target.binding.bindingId, receipt.work_id, receipt.revision);}
      catch {deps.diagnostic("reply_reconciliation_blocked");}
    }
    set("reply_position", outstanding.length ? String(outstanding.at(-1)!.position) : "0");
    const after = Number(get("inbox_position") ?? 0);
    const pending = sql.prepare(`SELECT rowid AS position,control_plane_id,subscription_id,event_id,work_id FROM assistant_event_wakes
      WHERE state='pending' AND rowid>? ORDER BY rowid LIMIT 5`).all(after) as
      {position: number; control_plane_id: string; subscription_id: string; event_id: string; work_id: string}[];
    for (const item of pending) {
      for (const candidate of destinations.filter(target => target.connection.controlPlaneId === item.control_plane_id &&
        target.connection.connectionId === inbox.connectionFor(item.control_plane_id, item.subscription_id, item.event_id))) {
        try {
          const wake = await observe(candidate.connection.name, candidate.binding.bindingId, item.work_id, item.event_id);
          if (inbox.reserveWake(item.control_plane_id, item.subscription_id, item.event_id, item.work_id)) {
            // Only a retained hook run ID means accepted; neither state claims Discord delivery.
            inbox.settleWake(item.control_plane_id, item.subscription_id, item.event_id, item.work_id, wake.runId ?? undefined);
          }
          break;
        } catch {deps.diagnostic("event_update_blocked_or_uncertain");}
      }
    }
    set("inbox_position", pending.length ? String(pending.at(-1)!.position) : "0");
  };
  return {
    app,
    tick() {
      if (closing) return Promise.resolve();
      if (!active) active = drain().catch(() => {deps.diagnostic("bridge_reconciliation_unavailable");}).finally(() => {active = undefined;});
      return active;
    },
    async close() {closing = true; await active; await app.close();},
  };
}
