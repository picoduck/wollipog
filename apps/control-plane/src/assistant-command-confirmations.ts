import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AssistantRefusal, assistantCallContext } from "./assistant-connections.js";
import type { AssistantOwnerConfirmations, OwnerConfirmationRequest } from "./assistant-owner-confirmations.js";

export const ASSISTANT_CONFIRMATION_TTL_MS = 5 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface AssistantConfirmationBinding {
  connectionId: string; grantRevision: number; operation: string; argumentsDigest: string; targetDigest: string;
}

/** What a thread's assistant is told when its destructive command waits for the owner. It names
 * no value the assistant could send back to complete the command itself. */
export const OWNER_CONFIRMATION_PENDING_RECOVERY = "Your owner was asked to approve this exact command in Wollipog. Nothing ran yet. " +
  "Do not send it again: if your owner approves it, Wollipog runs it once and tells you the result in this conversation, " +
  "and if they deny it or it expires you are told that instead. Tell your owner what you asked for and why.";
const OWNER_ONLY = "A Wollipog Assistant thread's destructive commands run only after your owner approves them in Wollipog. " +
  "Nothing ran. No value you received can confirm it: send the command without confirmationId to ask your owner.";
const STALE = "Your owner's approval no longer matches this command: its target, arguments or the thread's grant changed after it was requested. " +
  "Nothing ran. Ask your owner again if the command is still needed.";

/** Confirmation is an owner-selected extra check, never a replacement for live authorization.
 * Consumption belongs inside receipt reservation so failures roll back the one-shot claim.
 *
 * An external Assistant connection gets a short-lived confirmation ID to repeat the command with,
 * because a person reads its preview in that assistant's chat. A Wollipog Assistant thread's
 * assistant could repeat it alone, so for a thread connection (#4665) the preview becomes an owner
 * confirmation request and no ID is returned. Only the control plane's run of the owner's approval,
 * marked in `assistantCallContext`, can consume it. */
export class AssistantCommandConfirmations {
  static install(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_command_confirmations (
      id_hash TEXT PRIMARY KEY, binding_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0);`);
  }
  constructor(private readonly db: DatabaseSync, private readonly owner?: AssistantOwnerConfirmations) {}
  private isThread(connectionId: string): boolean {
    const row = this.db.prepare("SELECT thread_id FROM assistant_connections WHERE id=?").get(connectionId) as {thread_id: string | null} | undefined;
    return !!row?.thread_id;
  }
  issue(binding: AssistantConfirmationBinding, now = Date.now()): {confirmationId: string; expiresAt: number} {
    // A thread's assistant must never hold a value that confirms its own command.
    if (this.isThread(binding.connectionId)) throw new AssistantRefusal(OWNER_ONLY);
    this.db.prepare("DELETE FROM assistant_command_confirmations WHERE expires_at<=?").run(now);
    // Bound pending previews for a single connection even if a client abandons each one.
    this.db.prepare(`DELETE FROM assistant_command_confirmations WHERE id_hash IN (
      SELECT id_hash FROM assistant_command_confirmations WHERE json_extract(binding_json,'$.connectionId')=?
      ORDER BY expires_at DESC LIMIT -1 OFFSET 99)`).run(binding.connectionId);
    const confirmationId = randomUUID(), expiresAt = now + ASSISTANT_CONFIRMATION_TTL_MS;
    this.db.prepare("INSERT INTO assistant_command_confirmations VALUES (?,?,?,0)").run(hash(confirmationId), JSON.stringify(binding), expiresAt);
    return {confirmationId, expiresAt};
  }
  /** The answer to a destructive command that needs confirmation, with nothing dispatched.
   * `external` is the operation's own preview for an external connection: it receives a
   * confirmation ID to repeat the command with. A thread connection's command is recorded for
   * its owner instead, with the same preview fields and no ID. A command whose receipt already
   * exists returns that receipt, exactly as reserving it again would. */
  preview(binding: AssistantConfirmationBinding, request: OwnerConfirmationRequest, external: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    if (!this.isThread(binding.connectionId)) return {confirmationRequired: true, ...this.issue(binding, now), ...external};
    if (!this.owner) throw new AssistantRefusal("Owner confirmation is unavailable on this control plane. Nothing ran. Ask your owner to run this command themselves.");
    const prior = this.db.prepare("SELECT operation, digest, receipt_json FROM assistant_command_receipts WHERE connection_id=? AND command_id=?")
      .get(binding.connectionId, request.commandId) as {operation: string; digest: string; receipt_json: string} | undefined;
    if (prior) {
      if (prior.operation !== binding.operation || prior.digest !== binding.argumentsDigest) throw new AssistantRefusal("commandId is already bound to a different operation or request. Look up the original receipt; use a new ID only for a new command.");
      return {receipt: JSON.parse(prior.receipt_json), recovery: "This command already ran or is running. Read its receipt and target; never dispatch it again."};
    }
    const target = request.target;
    const label = request.targetLabel ?? (target.kind === "session"
      ? (this.db.prepare("SELECT title FROM sessions WHERE id=?").get(target.id) as {title: string} | undefined)?.title || target.id
      : target.id);
    const confirmation = this.owner.request(binding, request, label, now);
    const {recovery: _external, ...shown} = external;
    return {...shown, ownerConfirmationRequired: true, ownerConfirmation: {status: confirmation.status, expiresAt: confirmation.expiresAt},
      recovery: OWNER_CONFIRMATION_PENDING_RECOVERY};
  }
  consume(confirmationId: string, binding: AssistantConfirmationBinding, now = Date.now()): void {
    if (this.isThread(binding.connectionId)) {
      // The confirmationId argument is ignored: only the owner's approval, being run by the
      // control plane in this call, can spend a thread's request.
      const call = assistantCallContext.getStore();
      if (!this.owner || !call?.ownerConfirmationId || call.connectionId !== binding.connectionId) throw new AssistantRefusal(OWNER_ONLY);
      if (!this.owner.consumeApproved(call.ownerConfirmationId, binding, now)) throw new AssistantRefusal(STALE);
      return;
    }
    const changed = this.db.prepare(`UPDATE assistant_command_confirmations SET consumed=1
      WHERE id_hash=? AND binding_json=? AND expires_at>? AND consumed=0`)
      .run(hash(confirmationId), JSON.stringify(binding), now).changes;
    if (!changed) throw new AssistantRefusal("Destructive confirmation is expired, already used, or no longer matches this command, target or grant. Request a fresh preview using the same command ID before execution.");
  }
}
