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
      this.db.prepare("INSERT INTO runner_media_dispatch_fences VALUES (?,?,?,'claimed')")
        .run(identity.sessionId, identity.generation, canonicalIdentity(identity));
      return true;
    });
  }
  cancelBeforeLaunch(identity: MediaDispatchFenceIdentity): MediaNeverDispatchedFence | null {
    if (!validMediaDispatchFenceIdentity(identity)) return null;
    return this.atomic(() => {
      const prior = this.existing(identity);
      const receipt = receiptFor(identity);
      if (prior) return prior.state === "cancelled" && prior.identity === canonicalIdentity(identity) ? receipt : null;
      this.db.prepare("INSERT INTO runner_media_dispatch_fences VALUES (?,?,?,'cancelled')")
        .run(identity.sessionId, identity.generation, canonicalIdentity(identity));
      return receipt;
    });
  }
}
