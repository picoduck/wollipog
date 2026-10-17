import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { mediaActiveStopIdentityBody, mediaActiveStopRequestBody, mediaActiveStopAcknowledgementBody,
  type MediaActiveStopIdentity, type MediaActiveStopRequest, type MediaActiveStopAcknowledgement } from "@wollipog/protocol";
import { MediaSessionPurposes } from "./media-session-purposes.js";
import { initializePreparedMediaSchema, type PreparedMediaRecord } from "./prepared-media-sessions.js";

export interface PreparedMediaActiveStopPorts {
  /** Trusted private current authority AND owning-runner registered same-command handle proof.
   * A prepared state, caller boolean or generic inventory cannot implement this port. */
  current(identity: MediaActiveStopIdentity): boolean;
  /** Send only this exact durable operation; acceptance is not terminal or usage proof. */
  send(request: MediaActiveStopRequest): void;
}
interface StopRecord { request: MediaActiveStopRequest; acknowledged: MediaActiveStopAcknowledgement | null }
const json = (v: unknown) => JSON.stringify(v);
const sha = (v: unknown) => createHash("sha256").update(json(v)).digest("hex");

/** Dedicated lifecycle preparation, deliberately unregistered in hosting. Unknown operations
 * retain reservations/history and permit exact readback only. There is no settlement API here. */
export class PreparedMediaActiveStops {
  private readonly purposes: MediaSessionPurposes;
  constructor(readonly database: DatabaseSync, private readonly ports: PreparedMediaActiveStopPorts) {
    this.purposes = new MediaSessionPurposes(database);
    initializePreparedMediaSchema(database);
  }
  owns(sessionId: string): boolean {
    try {
      return Boolean(this.database.prepare("SELECT 1 FROM prepared_media_active_stops WHERE session_id=?").get(sessionId) ||
        this.database.prepare("SELECT 1 FROM prepared_media_sessions WHERE json_extract(payload,'$.sessionId')=? AND stop_operation_id IS NOT NULL").get(sessionId));
    } catch { return true; } // Missing history retains quarantine, never creates terminal proof.
  }
  private identity(sessionId: string): MediaActiveStopIdentity | null {
    try {
      if (this.purposes.lifecycleState(sessionId) !== "active") return null;
      const row = this.database.prepare("SELECT payload,payload_sha256 FROM prepared_media_sessions WHERE json_extract(payload,'$.sessionId')=?")
        .get(sessionId) as { payload: string; payload_sha256: string } | undefined;
      const member = this.database.prepare("SELECT active FROM campaign_budget_members WHERE session_id=?").get(sessionId);
      if (!row || member?.active !== 1) return null;
      const record = JSON.parse(row.payload) as PreparedMediaRecord;
      if (sha(record) !== row.payload_sha256 || !record.dispatchSha256) return null;
      return mediaActiveStopIdentityBody({ rootSessionId: record.rootSessionId, childSessionId: record.childSessionId,
        sessionId, runnerId: record.runnerId, generation: record.admission.dispatch.generation,
        commandSha256: record.commandSha256, dispatchSha256: record.dispatchSha256 });
    } catch { return null; }
  }
  private saved(sessionId: string): StopRecord | null {
    const row = this.database.prepare("SELECT record,sha256 FROM prepared_media_active_stops WHERE session_id=?")
      .get(sessionId) as { record: string; sha256: string } | undefined;
    if (!row) return null;
    const record = JSON.parse(row.record) as StopRecord;
    const anchor = this.database.prepare("SELECT stop_operation_id FROM prepared_media_sessions WHERE json_extract(payload,'$.sessionId')=?").get(sessionId);
    if (sha(record) !== row.sha256 || record.request.sessionId !== sessionId ||
      anchor?.stop_operation_id !== record.request.operationId ||
      json(mediaActiveStopRequestBody(record.request)) !== json(record.request) ||
      Object.keys(record).length !== 2 || !Object.hasOwn(record, "acknowledged")) throw new Error("Dedicated Stop provenance is unavailable.");
    if (record.acknowledged !== null && (json(mediaActiveStopRequestBody(this.requestFromAck(record.acknowledged))) !== json(record.request) ||
      sha(mediaActiveStopAcknowledgementBody(record.acknowledged)) !== record.acknowledged.stopFenceSha256)) {
      throw new Error("Dedicated Stop acknowledgement is unavailable.");
    }
    return record;
  }
  private requestFromAck(ack: MediaActiveStopAcknowledgement): MediaActiveStopRequest {
    const { outcome: _outcome, stopFenceSha256: _hash, ...request } = ack;
    return request;
  }
  request(sessionId: string): MediaActiveStopRequest | null {
    if (this.database.isTransaction) return null;
    try {
      const identity = this.identity(sessionId);
      if (!identity || !this.ports.current(identity)) return null;
      const prior = this.saved(sessionId);
      if (prior) {
        const { operationId: _operation, ...bound } = prior.request;
        return json(identity) === json(bound) ? prior.request : null; // Never resend ambiguous effects.
      }
      if (this.owns(sessionId)) return null; // An anchored operation with missing history stays unknown.
      const request = mediaActiveStopRequestBody({ ...identity, operationId: `media_stop_${randomUUID()}` });
      const record: StopRecord = { request, acknowledged: null };
      // This autocommit is the durable uncertainty boundary. No effect precedes it, no retry
      // can replace it, and callback failures cannot roll the intent back.
      this.database.exec("BEGIN IMMEDIATE");
      try {
        if (json(this.identity(sessionId)) !== json(identity)) throw new Error("Dedicated Stop identity changed.");
        const anchored = this.database.prepare("UPDATE prepared_media_sessions SET stop_operation_id=? WHERE json_extract(payload,'$.sessionId')=? AND stop_operation_id IS NULL")
          .run(request.operationId, sessionId);
        if (anchored.changes !== 1) throw new Error("Dedicated Stop operation cannot be replaced.");
        this.database.prepare("INSERT INTO prepared_media_active_stops VALUES (?,?,?)")
          .run(sessionId, json(record), sha(record));
        this.database.exec("COMMIT");
      } catch (error) { this.database.exec("ROLLBACK"); throw error; }
      if (json(this.identity(sessionId)) === json(identity) && this.ports.current(identity)) {
        try { this.ports.send(request); } catch { /* Exact readback only; no duplicate send. */ }
      }
      return request;
    } catch { return null; }
  }
  acknowledge(authenticatedRunnerId: string, ack: MediaActiveStopAcknowledgement): boolean {
    if (this.database.isTransaction) return false;
    try {
      const request = mediaActiveStopRequestBody(this.requestFromAck(ack));
      const body = mediaActiveStopAcknowledgementBody(ack);
      const identity = this.identity(request.sessionId), record = this.saved(request.sessionId);
      const { operationId: _operation, ...bound } = request;
      if (authenticatedRunnerId !== request.runnerId || !identity || !record || !this.ports.current(identity) ||
        json(identity) !== json(bound) || json(record.request) !== json(request) || sha(body) !== ack.stopFenceSha256) return false;
      if (record.acknowledged) return json(record.acknowledged) === json(ack); // A late frame cannot replace an ACK.
      const next: StopRecord = { request, acknowledged: { ...body, stopFenceSha256: ack.stopFenceSha256 } };
      return this.database.prepare("UPDATE prepared_media_active_stops SET record=?,sha256=? WHERE session_id=? AND record=? AND sha256=?")
        .run(json(next), sha(next), request.sessionId, json(record), sha(record)).changes === 1;
    } catch { return false; }
  }
  readback(sessionId: string): MediaActiveStopRequest | null {
    try { return this.saved(sessionId)?.request ?? null; } catch { return null; }
  }
}
