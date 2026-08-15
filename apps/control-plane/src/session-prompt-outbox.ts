import { randomUUID } from "node:crypto";
import {
  runnerSupportsProtocol,
  type DurableSessionCommand,
  type DurableSessionCommandMessage,
  type DurableSessionCommandResultMessage,
  type DurableSessionCommandUpdateMessage,
} from "@wollipog/protocol";
import { automationCommandDigest, canonicalAutomationCommandJson } from "./automation-command-outbox.js";
import type { ControlPlaneDb, SessionPromptCommandRecord } from "./db.js";
import type { Hub } from "./hub.js";

type Receipt = DurableSessionCommandResultMessage | DurableSessionCommandUpdateMessage;
type Logger = { warn: (message: string) => void };

const RECEIPT_HORIZON_MS = 30 * 24 * 60 * 60_000;
const MAX_RETRY_MS = 30_000;
const RECEIPT_STATES = new Set(["accepted", "queued", "started", "completed", "failed", "uncertain"]);
const RECEIPT_CODES = new Set([
  "COMMAND_ID_CONFLICT", "COMMAND_EXPIRED", "INVALID_COMMAND", "SESSION_NOT_FOUND",
  "QUEUE_FULL", "COMMAND_CANCELLED", "RECEIPT_STORE_FULL",
]);

function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_MS, 250 * (2 ** Math.min(7, Math.max(0, attempt - 1))));
}

/** Durable at-least-once transport for user-submitted prompts. The runner's command journal
 * deduplicates retries; the control plane retains the exact payload until a terminal receipt. */
export class SessionPromptOutbox {
  constructor(
    private readonly db: ControlPlaneDb,
    private readonly hub: Hub,
    private readonly log: Logger,
  ) {}

  stage(sessionId: string, runnerId: string, command: DurableSessionCommand, now = Date.now()): SessionPromptCommandRecord {
    const commandId = `prompt_${randomUUID()}`;
    const payloadJson = canonicalAutomationCommandJson(command);
    return this.db.stageSessionPromptCommand({
      commandId,
      sessionId,
      runnerId,
      payloadJson,
      payloadSha256: automationCommandDigest(command),
      expiresAt: now + RECEIPT_HORIZON_MS,
      now,
    });
  }

  flush(now = Date.now(), runnerId?: string): number {
    let sent = 0;
    for (const row of this.db.dueSessionPromptCommands(now, runnerId, 100)) {
      if (!this.hub.isRunnerOnline(row.runnerId)) continue;
      if (!runnerSupportsProtocol(this.db.getRunner(row.runnerId)?.protocolVersion, "automationCommandReceipts")) {
        this.db.recordSessionPromptCommandReceipt({
          commandId: row.commandId,
          runnerId: row.runnerId,
          sessionId: row.sessionId,
          state: row.state === "pending" ? "failed" : "uncertain",
          revision: row.revision + 1,
          error: "runner no longer supports durable prompt receipts",
          now,
        });
        this.hub.sessionChangedById(row.sessionId);
        continue;
      }
      let command: DurableSessionCommand;
      try {
        command = JSON.parse(row.payloadJson) as DurableSessionCommand;
      } catch {
        this.failMalformed(row, "stored durable prompt payload is malformed", now);
        continue;
      }
      if (automationCommandDigest(command) !== row.payloadSha256) {
        this.failMalformed(row, "stored durable prompt digest does not match", now);
        continue;
      }
      const requestId = randomUUID();
      const nextAttemptAt = now + retryDelay(row.attemptCount + 1);
      if (!this.db.markSessionPromptCommandSent(row.commandId, requestId, now, nextAttemptAt)) continue;
      const message: DurableSessionCommandMessage = {
        type: "durable_session_command",
        requestId,
        commandId: row.commandId,
        executionId: `manual-prompt:${row.sessionId}`,
        payloadDigest: row.payloadSha256,
        expiresAt: row.expiresAt,
        command,
      };
      if (!this.hub.sendToRunner(row.runnerId, message)) return sent;
      sent += 1;
    }
    return sent;
  }

  receipt(runnerId: string, message: Receipt, now = Date.now()): boolean {
    if (!validReceipt(message)) {
      this.log.warn(`runner '${runnerId}' sent a malformed durable prompt receipt`);
      return false;
    }
    let applied: ReturnType<ControlPlaneDb["recordSessionPromptCommandReceipt"]>;
    try {
      applied = this.db.recordSessionPromptCommandReceipt({
        commandId: message.commandId,
        runnerId,
        sessionId: message.sessionId,
        state: message.state === "failed" ? "failed" : message.state,
        revision: message.revision,
        ...(message.type === "durable_session_command_result" ? { requestId: message.requestId } : {}),
        ...(message.error ? { error: message.error } : {}),
        ...(message.code ? { code: message.code } : {}),
        ...(message.type === "durable_session_command_update" && message.userEventSeq !== undefined
          ? { userEventSeq: message.userEventSeq }
          : {}),
        now,
      });
    } catch (error) {
      this.log.warn(`durable prompt receipt was ignored: ${(error as Error).message}`);
      return false;
    }
    if (!applied) return false;
    if (applied.advanced) this.hub.sessionChangedById(applied.command.sessionId);
    return true;
  }

  maintain(now = Date.now()): number {
    const sessions = new Set(this.db.expireSessionPromptCommands(now));
    for (const sessionId of this.db.pruneSessionPromptCommands(now)) sessions.add(sessionId);
    for (const sessionId of sessions) this.hub.sessionChangedById(sessionId);
    return sessions.size;
  }

  stopSession(sessionId: string, now = Date.now()): number {
    const changed = this.db.cancelSessionPromptCommands(
      sessionId,
      "session stopped before durable prompt delivery completed",
      now,
    );
    if (changed) this.hub.sessionChangedById(sessionId);
    return changed;
  }

  private failMalformed(row: SessionPromptCommandRecord, error: string, now: number): void {
    this.log.warn(`${error} (${row.commandId})`);
    this.db.recordSessionPromptCommandReceipt({
      commandId: row.commandId,
      runnerId: row.runnerId,
      sessionId: row.sessionId,
      state: "failed",
      revision: row.revision + 1,
      error,
      now,
    });
    this.hub.sessionChangedById(row.sessionId);
  }
}

function validReceipt(message: Receipt): boolean {
  if (!message || typeof message !== "object" ||
      (message.type !== "durable_session_command_result" && message.type !== "durable_session_command_update") ||
      typeof message.commandId !== "string" || !message.commandId || message.commandId.length > 256 ||
      typeof message.sessionId !== "string" || !message.sessionId || message.sessionId.length > 256 ||
      !RECEIPT_STATES.has(message.state) || !Number.isSafeInteger(message.revision) || message.revision < 0 ||
      (message.error !== undefined && (typeof message.error !== "string" || message.error.length > 4_096)) ||
      (message.code !== undefined && !RECEIPT_CODES.has(message.code))) return false;
  if (message.type === "durable_session_command_result") {
    return typeof message.requestId === "string" && Boolean(message.requestId) && message.requestId.length <= 256 &&
      typeof message.duplicate === "boolean";
  }
  return message.userEventSeq === undefined ||
    (Number.isSafeInteger(message.userEventSeq) && Number(message.userEventSeq) >= 0);
}
