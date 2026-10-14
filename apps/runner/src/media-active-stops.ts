import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mediaActiveStopIdentityBody, mediaActiveStopRequestBody,
  type MediaActiveStopIdentity, type MediaActiveStopRequest, type MediaActiveStopAcknowledgement } from "@wollipog/protocol";
import { RunnerMediaDispatchFences } from "./media-dispatch-fences.js";

export interface OwnedMediaStopHandle {
  identity: MediaActiveStopIdentity;
  /** Signal ONLY this already registered dedicated worker. This is not terminal confirmation. */
  requestStop(): void;
}
export interface RunnerMediaActiveStopPorts {
  /** Private actual worker registry. No PID, generic SessionManager or caller claims. */
  current(identity: MediaActiveStopIdentity): OwnedMediaStopHandle | null;
  currentAuthority(identity: MediaActiveStopIdentity): boolean;
}
const json = (value: unknown) => JSON.stringify(value);
const hash = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
const receipt = (request: MediaActiveStopRequest, outcome: MediaActiveStopAcknowledgement["outcome"]): MediaActiveStopAcknowledgement => {
  const body = { ...request, outcome };
  return { ...body, stopFenceSha256: hash(body) };
};

/** Unregistered preparation. The runner must provide its actual restricted-worker registry.
 * A permanent same-command Stop claim precedes any signal; ambiguity is readback only.
 * No terminal status, budget release, usage reset or sensitive command deletion occurs here. */
export class RunnerMediaActiveStops {
  private readonly fences: RunnerMediaDispatchFences;
  constructor(private readonly db: DatabaseSync, private readonly ports: RunnerMediaActiveStopPorts) {
    this.fences = new RunnerMediaDispatchFences(db);
    db.exec("CREATE TABLE IF NOT EXISTS runner_media_active_stops (session_id TEXT NOT NULL,generation TEXT NOT NULL," +
      "request TEXT NOT NULL,sha256 TEXT NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('unknown','stop_requested'))," +
      "PRIMARY KEY(session_id,generation));");
  }
  private prior(request: MediaActiveStopRequest): MediaActiveStopAcknowledgement | null {
    const row = this.db.prepare("SELECT request,sha256,outcome FROM runner_media_active_stops WHERE session_id=? AND generation=?")
      .get(request.sessionId, request.generation) as { request: string; sha256: string; outcome: MediaActiveStopAcknowledgement["outcome"] } | undefined;
    if (!row) return null;
    const { operationId, childSessionId: _child, ...dispatch } = request;
    if (row.request !== json(request) || row.sha256 !== hash(request) || !["unknown", "stop_requested"].includes(row.outcome)) {
      throw new Error("Dedicated Stop identity cannot be replaced.");
    }
    if (this.fences.stopOperation(dispatch) !== operationId) throw new Error("Dedicated Stop command fence is unavailable.");
    return receipt(request, row.outcome);
  }
  request(input: MediaActiveStopRequest): MediaActiveStopAcknowledgement | null {
    if (this.db.isTransaction) return null; // An irreversible signal cannot precede an outer commit.
    let request: MediaActiveStopRequest;
    try { request = mediaActiveStopRequestBody(input); } catch { return null; }
    const { operationId: _operation, childSessionId: _child, ...dispatch } = request;
    const identity = mediaActiveStopIdentityBody({ ...dispatch, childSessionId: _child });
    try {
      if (!this.fences.claimed(dispatch) || !this.ports.currentAuthority(identity)) return null;
      const handle = this.ports.current(identity);
      if (!handle || json(mediaActiveStopIdentityBody(handle.identity)) !== json(identity)) return null;
      const prior = this.prior(request);
      if (prior) return prior;
      // Commit the permanent unknown intent BEFORE calling an actual owned handle. A crash or
      // exception can never cause the signal to be retried, even after this coordinator restarts.
      // The original command also anchors the operation. Missing Stop history cannot become
      // an absence-based permission to create a replacement intent or repeat a signal.
      if (this.fences.stopOperation(dispatch) !== null) return null;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (!this.fences.claimStop(dispatch, request.operationId)) throw new Error("Dedicated Stop fence changed.");
        this.db.prepare("INSERT INTO runner_media_active_stops VALUES (?,?,?,?,'unknown')")
          .run(request.sessionId, request.generation, json(request), hash(request));
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      // Recheck the same registered handle and authority at the irreversible boundary.
      if (this.ports.current(identity) !== handle || !this.ports.currentAuthority(identity) ||
        this.fences.stopOperation(dispatch) !== request.operationId) return receipt(request, "unknown");
      try {
        // A registry refresh can retain this object while replacing its worker coordinates.
        // Recheck the complete identity after the final authority/fence callbacks. Malformed
        // coordinates retain this committed operation as unknown, just like a failed signal.
        if (json(mediaActiveStopIdentityBody(handle.identity)) !== json(identity)) return receipt(request, "unknown");
        handle.requestStop();
      } catch { return receipt(request, "unknown"); }
      this.db.prepare("UPDATE runner_media_active_stops SET outcome='stop_requested' WHERE session_id=? AND generation=? AND request=? AND sha256=?")
        .run(request.sessionId, request.generation, json(request), hash(request));
      return receipt(request, "stop_requested");
    } catch { return null; }
  }
  readback(input: MediaActiveStopRequest): MediaActiveStopAcknowledgement | null {
    try { return this.prior(mediaActiveStopRequestBody(input)); } catch { return null; }
  }
}
