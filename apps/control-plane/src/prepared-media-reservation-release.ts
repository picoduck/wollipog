import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { mediaDispatchFenceBody, validMediaNeverDispatchedFence, type MediaNeverDispatchedFence } from "@wollipog/protocol";
import type { CampaignBudgetLedger } from "./campaign-budget.js";
import { MediaSessionPurposes } from "./media-session-purposes.js";
import { PreparedMediaSessions, type PreparedMediaRecord } from "./prepared-media-sessions.js";
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Server-only adapter. No agent route and no budget usage/settlement mutation. Authenticated
 * runner ingress must use the actual channel runner ID, never one supplied in a worker payload.
 * Hosting has no registration; the final dispatcher must enforce the matching durable runner fence.
 */
export class PreparedMediaReservationRelease {
  private readonly purposes: MediaSessionPurposes;
  constructor(private readonly db: DatabaseSync, private readonly ledger: CampaignBudgetLedger) {
    if (ledger.database !== db) throw new Error("Media cancellation and budget release require the same database.");
    this.purposes = new MediaSessionPurposes(db);
    db.exec("CREATE TABLE IF NOT EXISTS media_never_dispatched_fences (session_id TEXT NOT NULL,generation TEXT NOT NULL," +
      "root_id TEXT NOT NULL,runner_id TEXT NOT NULL,command_sha256 TEXT NOT NULL,dispatch_sha256 TEXT NOT NULL," +
      "receipt TEXT NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(session_id,generation));");
  }
  /** Called ONLY by the owning authenticated runner channel after it durably fenced launch.
   * Digest validation alone is insufficient. A generic/code-job/session-agent message cannot call
   * this ingress; its registration remains held until the real restricted dispatcher is integrated. */
  recordAuthenticatedFence(authenticatedRunnerId: string, receipt: MediaNeverDispatchedFence): boolean {
    if (!validMediaNeverDispatchedFence(receipt) || authenticatedRunnerId !== receipt.runnerId) return false;
    const { outcome: _outcome, fenceSha256, ...identity } = receipt;
    if (fenceSha256 !== sha(mediaDispatchFenceBody(identity))) return false;
    const row = this.db.prepare("SELECT payload,payload_sha256,state FROM prepared_media_sessions WHERE " +
      "json_extract(payload,'$.sessionId')=?")
      .get(receipt.sessionId) as { payload: string; payload_sha256: string; state: string } | undefined;
    if (!row || !["dispatching", "uncertain"].includes(row.state)) return false;
    const r = JSON.parse(row.payload) as PreparedMediaRecord;
    const purpose = this.purposes.get(receipt.sessionId), generation = this.ledger.dispatch(receipt.sessionId);
    if (sha(r) !== row.payload_sha256 || r.state !== row.state || r.rootSessionId !== receipt.rootSessionId ||
      r.sessionId !== receipt.sessionId || r.runnerId !== receipt.runnerId || r.commandSha256 !== receipt.commandSha256 ||
      sha(r.command) !== receipt.commandSha256 || r.dispatchSha256 !== receipt.dispatchSha256 ||
      r.admission.dispatch.generation !== receipt.generation || generation?.generation !== receipt.generation ||
      generation.rootSessionId !== receipt.rootSessionId || !purpose || purpose.rootSessionId !== receipt.rootSessionId ||
      purpose.generation !== receipt.generation || sha(purpose.command) !== receipt.commandSha256) return false;
    const prior = this.db.prepare("SELECT receipt FROM media_never_dispatched_fences WHERE session_id=? AND generation=?")
      .get(receipt.sessionId, receipt.generation) as { receipt: string } | undefined;
    if (prior) return prior.receipt === JSON.stringify(receipt);
    this.db.prepare("INSERT INTO media_never_dispatched_fences VALUES (?,?,?,?,?,?,?,?)")
      .run(receipt.sessionId, receipt.generation, receipt.rootSessionId, receipt.runnerId, receipt.commandSha256,
        receipt.dispatchSha256, JSON.stringify(receipt), sha(receipt));
    return true;
  }
  /** Private PreparedMediaSessionPorts.cancelNeverDispatched callback. The coordinator already
   * claimed cancellation synchronously in the SAME transaction, fencing its dispatch CAS. */
  release(record: PreparedMediaRecord): void {
    if (!this.db.isTransaction || record.state !== "cancelling" ||
      !this.ledger.deactivateNeverDispatchedMediaReservation(record.sessionId, {
        rootSessionId: record.rootSessionId, runnerId: record.runnerId, generation: record.admission.dispatch.generation,
        commandSha256: record.commandSha256, dispatchSha256: record.dispatchSha256,
      })) throw new Error("Exact proven never-dispatched media reservation cannot be released.");
    // This local Session never ran. End its queued lifecycle in the same cancellation transaction
    // so it does not occupy child/native/media slots forever. No provider stop or usage settlement.
    if (Number(this.db.prepare("UPDATE sessions SET status='stopped' WHERE id=? AND status='queued'")
      .run(record.sessionId).changes) !== 1) throw new Error("Never-dispatched Session lifecycle changed.");
  }
  /** Server lifecycle Stop only. Reuse the coordinator's exact atomic never-enqueued claim;
   * unknown/possibly dispatched states and missing tables cannot acquire an unsent proof. */
  cancelLocallyUnsent(sessionId: string): boolean {
    const row = this.db.prepare("SELECT payload FROM prepared_media_sessions WHERE json_extract(payload,'$.sessionId')=?")
      .get(sessionId) as { payload: string } | undefined;
    if (!row) return false;
    const saved = JSON.parse(row.payload) as PreparedMediaRecord;
    const coordinator = new PreparedMediaSessions(this.db, {
      database: this.db,
      materialize: () => { throw new Error("Stop cannot materialize or dispatch media work."); },
      currentAdmission: () => null,
      currentIdentity: (id) => {
        const session = this.db.prepare("SELECT runner_id FROM sessions WHERE id=?").get(id) as { runner_id: string } | undefined;
        const dispatch = this.ledger.dispatch(id);
        return session && dispatch ? { rootSessionId: dispatch.rootSessionId, runnerId: session.runner_id, generation: dispatch.generation } : null;
      },
      authorize: async () => false,
      send: async () => { throw new Error("Stop cannot dispatch media work."); },
      reconcile: async () => null,
      cancelNeverDispatched: (record) => this.release(record),
    });
    coordinator.cancelPrepared({ rootSessionId: saved.rootSessionId, childSessionId: saved.childSessionId,
      admissionId: saved.admissionId, requestSha256: saved.requestSha256 });
    return true;
  }
}
