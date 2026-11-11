import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { WOLLIPOG_OUTBOUND_EVENT_MEDIA_TYPE, type OutboundEventEnvelope } from "@wollipog/protocol";
import { verifyAutomationTriggerSignature } from "./automation-trigger-ingress.js";
import type { AssistantDestinationBinding } from "./assistant-work.js";

/** Lives beside the external Assistant, in its own protected SQLite file. Keys and private
 * destination coordinates are supplied by owner configuration, never by an incoming event.
 * OpenClaw's in-memory hook replay cache is deliberately not this ledger. */
export class AssistantEventInbox {
  static install(sql: DatabaseSync): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS assistant_event_inbox (
      control_plane_id TEXT NOT NULL, subscription_id TEXT NOT NULL, event_id TEXT NOT NULL,
      digest TEXT NOT NULL, envelope_json TEXT NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(control_plane_id,subscription_id,event_id));
      CREATE TABLE IF NOT EXISTS assistant_event_wakes (
      control_plane_id TEXT NOT NULL, subscription_id TEXT NOT NULL, event_id TEXT NOT NULL,
      work_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','dispatching','accepted','uncertain')),
      run_id TEXT, PRIMARY KEY(control_plane_id,subscription_id,event_id,work_id));`);
  }
  constructor(private sql: DatabaseSync) {}

  connectionFor(controlPlaneId: string, subscriptionId: string, eventId: string): string | null {
    const row = this.sql.prepare("SELECT json_extract(envelope_json,'$.assistant.connectionId') AS connection_id FROM assistant_event_inbox WHERE control_plane_id=? AND subscription_id=? AND event_id=?")
      .get(controlPlaneId, subscriptionId, eventId) as {connection_id: string} | undefined;
    return row?.connection_id ?? null;
  }

  accept(controlPlaneId: string, subscriptionId: string, envelope: OutboundEventEnvelope, bytes: Buffer, now = Date.now()): boolean {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const prior = this.sql.prepare("SELECT digest FROM assistant_event_inbox WHERE control_plane_id=? AND subscription_id=? AND event_id=?")
      .get(controlPlaneId, subscriptionId, envelope.eventId) as {digest: string} | undefined;
    if (prior) {
      if (prior.digest !== digest) throw new Error("Event identity conflicts with its durable digest");
      return false;
    }
    this.sql.exec("SAVEPOINT assistant_inbox_accept");
    try {
      this.sql.prepare("INSERT INTO assistant_event_inbox VALUES (?,?,?,?,?,?)")
        .run(controlPlaneId, subscriptionId, envelope.eventId, digest, bytes.toString("utf8"), now);
      for (const work of envelope.assistant!.work) this.sql.prepare("INSERT INTO assistant_event_wakes VALUES (?,?,?,?,'pending',NULL)")
        .run(controlPlaneId, subscriptionId, envelope.eventId, work.workId);
      this.sql.exec("RELEASE assistant_inbox_accept");
      return true;
    } catch (error) { this.sql.exec("ROLLBACK TO assistant_inbox_accept; RELEASE assistant_inbox_accept"); throw error; }
  }

  state(controlPlaneId: string, subscriptionId: string, eventId: string, workId: string): {state: string; runId: string | null} | null {
    const row = this.sql.prepare("SELECT state,run_id FROM assistant_event_wakes WHERE control_plane_id=? AND subscription_id=? AND event_id=? AND work_id=?")
      .get(controlPlaneId, subscriptionId, eventId, workId) as {state: string; run_id: string | null} | undefined;
    return row ? {state: row.state, runId: row.run_id} : null;
  }

  /** Reservation precedes HTTP. A dispatching row after a crash is uncertain, never a reason
   * to repeat a hook whose replay cache may have vanished. Reconcile with work/command receipts. */
  reserveWake(controlPlaneId: string, subscriptionId: string, eventId: string, workId: string): boolean {
    return !!this.sql.prepare(`UPDATE assistant_event_wakes SET state='dispatching'
      WHERE control_plane_id=? AND subscription_id=? AND event_id=? AND work_id=? AND state='pending'`)
      .run(controlPlaneId, subscriptionId, eventId, workId).changes;
  }
  settleWake(controlPlaneId: string, subscriptionId: string, eventId: string, workId: string, runId?: string): void {
    this.sql.prepare(`UPDATE assistant_event_wakes SET state=?,run_id=?
      WHERE control_plane_id=? AND subscription_id=? AND event_id=? AND work_id=? AND state='dispatching'`)
      .run(runId ? "accepted" : "uncertain", runId ?? null, controlPlaneId, subscriptionId, eventId, workId);
  }

  pending(limit = 100): {controlPlaneId: string; subscriptionId: string; eventId: string; workId: string}[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Inbox page limit must be from 1 to 100");
    return (this.sql.prepare(`SELECT control_plane_id,subscription_id,event_id,work_id FROM assistant_event_wakes
      WHERE state='pending' ORDER BY rowid LIMIT ?`).all(limit) as
      {control_plane_id: string; subscription_id: string; event_id: string; work_id: string}[])
      .map(row => ({controlPlaneId: row.control_plane_id, subscriptionId: row.subscription_id, eventId: row.event_id, workId: row.work_id}));
  }
}

export function registerAssistantEventReceiver(app: FastifyInstance, config: {
  controlPlaneId: string; connectionId: string; subscriptionId: string;
  /** Reload owner configuration on every attempt so rotation/revocation takes effect. */
  currentSecret(): string | null;
  inbox: AssistantEventInbox;
}): void {
  app.addContentTypeParser(WOLLIPOG_OUTBOUND_EVENT_MEDIA_TYPE, {parseAs: "buffer", bodyLimit: 16 * 1024}, (_req, bytes, done) => done(null, bytes));
  app.post("/wollipog/events", {bodyLimit: 16 * 1024}, async (req, reply) => {
    const startedAt = Date.now();
    const diagnostic = (reason: string, eventId?: string, duplicate?: boolean) => {
      const fields = {event: "assistant_event_ingress", entryPoint: "signed_callback", requestId: req.id,
        reason, durationMs: Math.max(0, Date.now() - startedAt),
        ...(eventId ? {eventFingerprint: createHash("sha256").update(eventId).digest("hex")} : {}),
        ...(duplicate === undefined ? {} : {duplicate})};
      if (reason === "accepted") req.log.info(fields, "Assistant event accepted");
      else req.log.warn(fields, "Assistant event refused");
    };
    const bytes = req.body;
    const header = (name: string) => typeof req.headers[name] === "string" ? req.headers[name] as string : undefined;
    const secret = config.currentSecret();
    if (!secret || !Buffer.isBuffer(bytes) || header("x-wollipog-subscription-id") !== config.subscriptionId ||
        !verifyAutomationTriggerSignature(secret, config.subscriptionId, {timestamp: header("x-wollipog-timestamp"),
          nonce: header("x-wollipog-nonce"), signature: header("x-wollipog-signature")}, bytes)) {
      diagnostic("invalid_signature");
      return reply.code(401).send({error: "Invalid event signature or subscription."});
    }
    let envelope: OutboundEventEnvelope;
    try { envelope = JSON.parse(bytes.toString("utf8")); } catch { diagnostic("malformed_event"); return reply.code(400).send({error: "Malformed event."}); }
    const references = envelope?.assistant?.work;
    if (envelope?.version !== "v1" || typeof envelope.eventId !== "string" || !/^[\w.:-]{1,128}$/.test(envelope.eventId) ||
        header("x-wollipog-event-id") !== envelope.eventId || typeof envelope.sessionId !== "string" ||
        !Number.isSafeInteger(envelope.occurredAt) || !["session.created", "session.idle", "session.completed", "session.failed", "session.stopped", "session.input_required"].includes(envelope.kind) ||
        envelope.assistant?.controlPlaneId !== config.controlPlaneId || envelope.assistant?.connectionId !== config.connectionId ||
        !Array.isArray(references) || !references.length || references.length > 100 ||
        new Set(references.map(work => work?.workId)).size !== references.length ||
        references.some(work => !work || typeof work.workId !== "string" || !/^[\w.:-]{1,128}$/.test(work.workId) ||
          !Number.isSafeInteger(work.revision) || work.revision < 1 || !Number.isSafeInteger(work.attentionRevision))) {
      diagnostic("wrong_work_contract");
      return reply.code(400).send({error: "Event does not match this connection's work contract."});
    }
    try {
      const created = config.inbox.accept(config.controlPlaneId, config.subscriptionId, envelope, bytes);
      diagnostic("accepted", envelope.eventId, !created);
      return reply.code(202).send({accepted: true, duplicate: !created});
    } catch {
      // Conflicting identity and persistence failure must not be acknowledged as accepted.
      diagnostic("durable_acceptance_refused", envelope.eventId);
      return reply.code(409).send({error: "Event could not be durably accepted. Inspect the receiver ledger."});
    }
  });
}

/** One hook admission, not a delivery receipt. The caller must recheck current source access,
 * binding revision, requester identity and live Discord membership before rendering/sending.
 * Hooks run without automatic channel delivery so a model cannot bypass the reply-intent fence. */
export async function wakeOpenClaw(input: {
  gatewayOrigin: string; hookToken: string; binding: AssistantDestinationBinding;
  controlPlaneId: string; connectionId: string; workId: string; eventId: string;
}, request: typeof fetch = fetch): Promise<{runId?: string}> {
  const origin = new URL(input.gatewayOrigin);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/" ||
      (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("Use an owner-configured HTTPS Gateway origin or literal loopback HTTP");
  }
  if (input.binding.revoked || input.binding.connectionId !== input.connectionId) throw new Error("Destination binding is unavailable");
  const response = await request(new URL("/hooks/agent", origin), {method: "POST", redirect: "error",
    signal: AbortSignal.timeout(10_000), headers: {authorization: `Bearer ${input.hookToken}`, "content-type": "application/json"},
    body: JSON.stringify({agentId: input.binding.agentId, sessionKey: input.binding.sessionKey,
      idempotencyKey: createHash("sha256").update(JSON.stringify([input.controlPlaneId, input.connectionId, input.eventId, input.workId])).digest("hex"),
      channel: "discord", to: input.binding.destination, accountId: input.binding.accountId, deliver: false,
      message: `Wollipog work changed. Reconcile authorized work before acting: ${JSON.stringify({controlPlaneId: input.controlPlaneId, connectionId: input.connectionId, workId: input.workId})}`})});
  if (!response.ok) return {};
  // A bounded response prevents an operator-misconfigured endpoint consuming unbounded memory.
  const reader = response.body?.getReader();
  if (!reader) return {};
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16 * 1024) return {};
      chunks.push(chunk.value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {runId?: unknown};
    return typeof body.runId === "string" && /^[\w.:-]{1,128}$/.test(body.runId) ? {runId: body.runId} : {};
  } catch { return {}; } finally { await reader.cancel(); }
}

/** The connector supplies current source/binding/Discord checks; an event is only a wake hint.
 * Calling this again after an unknown hook response never repeats the admission automatically. */
export async function dispatchAssistantWake(inbox: AssistantEventInbox,
  item: {controlPlaneId: string; subscriptionId: string; eventId: string; workId: string},
  prepare: () => Promise<Parameters<typeof wakeOpenClaw>[0]>,
  recheck: () => boolean,
  request: typeof fetch = fetch,
): Promise<void> {
  const input = await prepare();
  if (input.controlPlaneId !== item.controlPlaneId || input.eventId !== item.eventId || input.workId !== item.workId ||
      inbox.connectionFor(item.controlPlaneId, item.subscriptionId, item.eventId) !== input.connectionId ||
      !recheck()) throw new Error("Work origin or current destination access changed");
  if (!inbox.reserveWake(item.controlPlaneId, item.subscriptionId, item.eventId, item.workId)) return;
  try {
    const result = await wakeOpenClaw(input, request);
    inbox.settleWake(item.controlPlaneId, item.subscriptionId, item.eventId, item.workId, result.runId);
  } catch {
    inbox.settleWake(item.controlPlaneId, item.subscriptionId, item.eventId, item.workId);
  }
}
