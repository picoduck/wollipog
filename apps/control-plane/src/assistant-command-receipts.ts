import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AssistantRefusal, type AssistantOperationReceipt } from "./assistant-connections.js";

export interface AssistantCommandReceipt extends AssistantOperationReceipt {
  createdAt: number;
  updatedAt: number;
  /** A service resource/receipt identifier, never a cached private result or raw error. */
  resultReference?: string;
}

/** JSON object ordering cannot change command identity. Inputs must be JSON values. */
export function assistantRequestDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, canonical(item)]));
    return v;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Operation-agnostic reservation. A duplicate ALWAYS reconciles; it never dispatches again.
 * `associate` runs in the same SQL savepoint, for a trusted work-origin/event claim (#4467).
 * It must use this same database and must be synchronous, with no external side effects.
 * Persist no prompts, credentials, raw errors or private result bodies here.
 */
export class AssistantCommandReceipts {
  static install(db: DatabaseSync): void {
    db.exec(`CREATE TABLE IF NOT EXISTS assistant_command_receipts (
      connection_id TEXT NOT NULL, command_id TEXT NOT NULL, operation TEXT NOT NULL,
      digest TEXT NOT NULL, receipt_json TEXT NOT NULL,
      PRIMARY KEY(connection_id, command_id));`);
  }
  constructor(private readonly db: DatabaseSync) {}
  get(connectionId: string, commandId: string): AssistantCommandReceipt | null {
    const row = this.db.prepare("SELECT receipt_json FROM assistant_command_receipts WHERE connection_id=? AND command_id=?")
      .get(connectionId, commandId) as { receipt_json: string } | undefined;
    return row ? JSON.parse(row.receipt_json) as AssistantCommandReceipt : null;
  }
  reserve(input: Omit<AssistantOperationReceipt, "status">, associate?: (receipt: AssistantCommandReceipt) => void): { created: boolean; receipt: AssistantCommandReceipt } {
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(input.operationId)) throw new AssistantRefusal("commandId must contain 1–128 letters, digits, dots, colons, underscores or hyphens. Reconcile that ID before retrying.");
    this.db.exec("SAVEPOINT assistant_command_reserve");
    try {
      const existing = this.get(input.connectionId, input.operationId);
      if (existing) {
        if (existing.operation !== input.operation || existing.argumentsDigest !== input.argumentsDigest) throw new AssistantRefusal("commandId is already bound to a different operation or request. Look up the original receipt; use a new ID only for a new command.");
        this.db.exec("RELEASE assistant_command_reserve");
        return { created: false, receipt: existing };
      }
      const now = Date.now();
      const receipt: AssistantCommandReceipt = { ...input, status: "accepted", createdAt: now, updatedAt: now };
      this.db.prepare("INSERT INTO assistant_command_receipts VALUES (?,?,?,?,?)")
        .run(input.connectionId, input.operationId, input.operation, input.argumentsDigest, JSON.stringify(receipt));
      associate?.(receipt);
      this.db.exec("RELEASE assistant_command_reserve");
      return { created: true, receipt };
    } catch (error) {
      this.db.exec("ROLLBACK TO assistant_command_reserve; RELEASE assistant_command_reserve");
      throw error;
    }
  }
  settle(connectionId: string, commandId: string, status: "succeeded" | "failed" | "uncertain", resultReference?: string): AssistantCommandReceipt {
    const receipt = this.get(connectionId, commandId);
    if (!receipt) throw new Error("Assistant command reservation missing");
    if (receipt.status !== "accepted" && receipt.status !== "running") return receipt;
    const settled = { ...receipt, status, updatedAt: Date.now(), ...(resultReference ? {resultReference, resourceId: resultReference} : {}) };
    this.db.prepare("UPDATE assistant_command_receipts SET receipt_json=? WHERE connection_id=? AND command_id=? AND json_extract(receipt_json, '$.status') IN ('accepted','running')")
      .run(JSON.stringify(settled), connectionId, commandId);
    return this.get(connectionId, commandId)!;
  }
}
