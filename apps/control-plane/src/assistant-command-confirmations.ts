import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AssistantRefusal } from "./assistant-connections.js";

export const ASSISTANT_CONFIRMATION_TTL_MS = 5 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface AssistantConfirmationBinding {
  connectionId: string; grantRevision: number; operation: string; argumentsDigest: string; targetDigest: string;
}

/** Confirmation is an owner-selected extra check, never a replacement for live authorization.
 * Consumption belongs inside receipt reservation so failures roll back the one-shot claim. */
export class AssistantCommandConfirmations {
  static install(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_command_confirmations (
      id_hash TEXT PRIMARY KEY, binding_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0);`);
  }
  constructor(private readonly db: DatabaseSync) {}
  issue(binding: AssistantConfirmationBinding, now = Date.now()): {confirmationId: string; expiresAt: number} {
    this.db.prepare("DELETE FROM assistant_command_confirmations WHERE expires_at<=?").run(now);
    // Bound pending previews for a single connection even if a client abandons each one.
    this.db.prepare(`DELETE FROM assistant_command_confirmations WHERE id_hash IN (
      SELECT id_hash FROM assistant_command_confirmations WHERE json_extract(binding_json,'$.connectionId')=?
      ORDER BY expires_at DESC LIMIT -1 OFFSET 99)`).run(binding.connectionId);
    const confirmationId = randomUUID(), expiresAt = now + ASSISTANT_CONFIRMATION_TTL_MS;
    this.db.prepare("INSERT INTO assistant_command_confirmations VALUES (?,?,?,0)").run(hash(confirmationId), JSON.stringify(binding), expiresAt);
    return {confirmationId, expiresAt};
  }
  consume(confirmationId: string, binding: AssistantConfirmationBinding, now = Date.now()): void {
    const changed = this.db.prepare(`UPDATE assistant_command_confirmations SET consumed=1
      WHERE id_hash=? AND binding_json=? AND expires_at>? AND consumed=0`)
      .run(hash(confirmationId), JSON.stringify(binding), now).changes;
    if (!changed) throw new AssistantRefusal("Destructive confirmation is expired, already used, or no longer matches this command, target or grant. Request a fresh preview using the same command ID before execution.");
  }
}
