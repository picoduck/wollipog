import { createHash } from "node:crypto";
import type { DurableSessionCommand } from "@wollipog/protocol";
import type { DatabaseSync } from "node:sqlite";

export interface MediaSessionPurpose {
  sessionId: string;
  rootSessionId: string;
  childSessionId: string;
  admissionId: string;
  occurrenceId: string;
  evidenceId: string;
  resourceDigest: string;
  policyRevision: number;
  generation: string;
  command: Extract<DurableSessionCommand, { type: "start_session" }>;
}
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Permanent purpose marker, not a budget ledger or grant. Cancelled/completed workers cannot
 * be repurposed through generic prompt/restart/config or credential routes. */
export class MediaSessionPurposes {
  constructor(private readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS media_session_purposes (" +
      "session_id TEXT PRIMARY KEY,record TEXT NOT NULL,sha256 TEXT NOT NULL);");
  }
  owns(sessionId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM media_session_purposes WHERE session_id=?").get(sessionId));
  }
  credentialCurrent(sessionId: string): boolean {
    try {
      const purpose = this.get(sessionId);
      return Boolean(purpose && this.db.prepare("SELECT 1 FROM campaign_budget_members WHERE session_id=? AND root_id=? AND generation=?")
        .get(sessionId, purpose.rootSessionId, purpose.generation));
    } catch { return false; }
  }
  add(purpose: MediaSessionPurpose): void {
    if (!this.db.isTransaction || purpose.sessionId === purpose.rootSessionId || purpose.sessionId === purpose.childSessionId ||
      !Number.isSafeInteger(purpose.policyRevision) || purpose.policyRevision <= 0 ||
      !/^[a-f0-9]{64}$/u.test(purpose.resourceDigest) ||
      [purpose.sessionId, purpose.rootSessionId, purpose.childSessionId, purpose.admissionId, purpose.occurrenceId, purpose.evidenceId, purpose.generation]
        .some((v) => typeof v !== "string" || !v || v.length > 256 || /[\x00-\x1f\x7f]/u.test(v))) {
      throw new Error("Atomic actual media Session purpose is required.");
    }
    const actual = this.db.prepare("SELECT 1 FROM sessions s JOIN campaign_budget_members m ON m.session_id=s.id WHERE s.id=? AND s.parent_session_id=? AND m.root_id=? AND m.generation=?").get(purpose.sessionId, purpose.rootSessionId, purpose.rootSessionId, purpose.generation);
    if (!actual || purpose.command.type !== "start_session" || purpose.command.spec.sessionId !== purpose.sessionId || purpose.command.spec.campaignBudgetDispatch?.generation !== purpose.generation || purpose.command.spec.campaignBudgetDispatch.rootSessionId !== purpose.rootSessionId) throw new Error("Actual admitted Session and command generation are required.");
    this.db.prepare("INSERT INTO media_session_purposes VALUES (?,?,?)")
      .run(purpose.sessionId, JSON.stringify(purpose), sha(purpose));
  }
  get(sessionId: string): MediaSessionPurpose | null {
    const row = this.db.prepare("SELECT record,sha256 FROM media_session_purposes WHERE session_id=?")
      .get(sessionId) as { record: string; sha256: string } | undefined;
    if (!row) return null;
    const purpose = JSON.parse(row.record) as MediaSessionPurpose;
    if (sha(purpose) !== row.sha256 || purpose.sessionId !== sessionId) throw new Error("Media Session purpose is invalid.");
    return purpose;
  }
}
