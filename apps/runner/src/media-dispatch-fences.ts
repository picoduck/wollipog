import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mediaDispatchFenceBody, validMediaDispatchFenceIdentity,
  type MediaDispatchFenceIdentity, type MediaNeverDispatchedFence } from "@wollipog/protocol";
const receiptFor = (identity: MediaDispatchFenceIdentity): MediaNeverDispatchedFence => {
  const body = mediaDispatchFenceBody(identity);
  return { ...body, fenceSha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
};
const canonicalIdentity = (identity: MediaDispatchFenceIdentity) => {
  const { outcome: _outcome, ...body } = mediaDispatchFenceBody(identity);
  return JSON.stringify(body);
};

/** Runner-owned durable launch fence. Final media dispatcher must claim BEFORE any provider
 * action and consult this same DB for every delayed/recovered command. No hosting registration
 * or native launch occurs here. A claimed command is ambiguous and cannot be certified unsent.
 * The emitted receipt may enter the control plane only via the owning authenticated runner.
 */
export class RunnerMediaDispatchFences {
  constructor(private readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS runner_media_dispatch_fences (session_id TEXT NOT NULL," +
      "generation TEXT NOT NULL,identity TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('claimed','cancelled'))," +
      "PRIMARY KEY(session_id,generation));");
    if (!(db.prepare("PRAGMA table_info(runner_media_dispatch_fences)").all() as Array<{ name: string }>).some((c) => c.name === "stop_operation_id")) {
      db.exec("ALTER TABLE runner_media_dispatch_fences ADD COLUMN stop_operation_id TEXT");
    }
  }
  private atomic<T>(action: () => T): T {
    this.db.exec("SAVEPOINT runner_media_fence");
    try { const result = action(); this.db.exec("RELEASE runner_media_fence"); return result; }
    catch (error) { this.db.exec("ROLLBACK TO runner_media_fence; RELEASE runner_media_fence"); throw error; }
  }
  private existing(identity: MediaDispatchFenceIdentity): { identity: string; state: "claimed" | "cancelled" } | undefined {
    return this.db.prepare("SELECT identity,state FROM runner_media_dispatch_fences WHERE session_id=? AND generation=?")
      .get(identity.sessionId, identity.generation) as { identity: string; state: "claimed" | "cancelled" } | undefined;
  }
  claim(identity: MediaDispatchFenceIdentity): boolean {
    if (!validMediaDispatchFenceIdentity(identity)) return false;
    return this.atomic(() => {
      if (this.existing(identity)) return false; // includes same-command replay and a changed command
      this.db.prepare("INSERT INTO runner_media_dispatch_fences(session_id,generation,identity,state) VALUES (?,?,?,'claimed')")
        .run(identity.sessionId, identity.generation, canonicalIdentity(identity));
      return true;
    });
  }
  /** Read-only exact durable ownership; status or process inventory cannot stand in for it. */
  claimed(identity: MediaDispatchFenceIdentity): boolean {
    if (!validMediaDispatchFenceIdentity(identity)) return false;
    const prior = this.existing(identity);
    return prior?.state === "claimed" && prior.identity === canonicalIdentity(identity);
  }
  stopOperation(identity: MediaDispatchFenceIdentity): string | null {
    if (!this.claimed(identity)) return null;
    const row = this.db.prepare("SELECT stop_operation_id FROM runner_media_dispatch_fences WHERE session_id=? AND generation=?")
      .get(identity.sessionId, identity.generation);
    return typeof row?.stop_operation_id === "string" ? row.stop_operation_id : null;
  }
  claimStop(identity: MediaDispatchFenceIdentity, operationId: string): boolean {
    if (!this.claimed(identity) || typeof operationId !== "string" || !operationId || operationId.length > 256 || /[\x00-\x1f\x7f]/u.test(operationId)) return false;
    return this.db.prepare("UPDATE runner_media_dispatch_fences SET stop_operation_id=? WHERE session_id=? AND generation=? AND identity=? AND state='claimed' AND stop_operation_id IS NULL")
      .run(operationId, identity.sessionId, identity.generation, canonicalIdentity(identity)).changes === 1;
  }
  cancelBeforeLaunch(identity: MediaDispatchFenceIdentity): MediaNeverDispatchedFence | null {
    if (!validMediaDispatchFenceIdentity(identity)) return null;
    return this.atomic(() => {
      const prior = this.existing(identity);
      const receipt = receiptFor(identity);
      if (prior) return prior.state === "cancelled" && prior.identity === canonicalIdentity(identity) ? receipt : null;
      this.db.prepare("INSERT INTO runner_media_dispatch_fences(session_id,generation,identity,state) VALUES (?,?,?,'cancelled')")
        .run(identity.sessionId, identity.generation, canonicalIdentity(identity));
      return receipt;
    });
  }
}
