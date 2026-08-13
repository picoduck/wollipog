import { createHash, randomUUID } from "node:crypto";
import type {
  AutomationCommandState,
  DurableSessionCommand,
  DurableSessionCommandMessage,
  DurableSessionCommandResultMessage,
  DurableSessionCommandUpdateMessage,
} from "@wollipog/protocol";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";

type Logger = { warn: (message: string) => void };
type Receipt = DurableSessionCommandResultMessage | DurableSessionCommandUpdateMessage;

const MAX_BATCH = 100;
const MAX_RETRY_MS = 30_000;

/** Stable JSON is shared with the runner receipt store so a retry can prove that a command id
 * still names the exact same payload. Arrays retain order; object keys are recursively sorted. */
export function canonicalAutomationCommandJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalAutomationCommandJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalAutomationCommandJson(object[key])}`).join(",")}}`;
}

export function automationCommandDigest(command: DurableSessionCommand): string {
  return createHash("sha256").update(canonicalAutomationCommandJson(command), "utf8").digest("hex");
}

function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_MS, 250 * (2 ** Math.min(7, Math.max(0, attempt - 1))));
}

function storedState(state: Receipt["state"]): AutomationCommandState {
  if (state === "accepted" || state === "queued") return "accepted";
  if (state === "failed") return "rejected";
  return state;
}

/** Durable transport for scheduler-owned session commands. The database is the source of truth:
 * every attempt is recorded before bytes are written, and every runner receipt is applied only
 * if it is monotonic and came from the command's assigned runner. */
export class AutomationCommandOutbox {
  constructor(
    private readonly db: ControlPlaneDb,
    private readonly hub: Hub,
    private readonly log: Logger,
    private readonly changed: (executionId: string, now: number) => void,
  ) {}

  flush(now = Date.now(), runnerId?: string): number {
    let sent = 0;
    // Registration calls flush with the concrete runner id. Include staged commands here: they
    // have no retry timestamp yet, but a rolling downgrade must still settle them immediately.
    if (runnerId && this.hub.isRunnerOnline(runnerId) &&
        !runnerSupportsProtocol(this.db.getRunner(runnerId)?.protocolVersion, "automationCommandReceipts")) {
      // Staged rows have no retry timestamp, so drain every batch during the registration pass;
      // leaving row 101 behind would otherwise require another reconnect to become observable.
      while (true) {
        const batch = this.db.activeAutomationCommands(runnerId, MAX_BATCH);
        if (!batch.length) break;
        for (const row of batch) this.failForCapabilityLoss(row, now);
      }
    }
    for (const expired of this.db.expireAutomationCommands(now, MAX_BATCH)) {
      this.changed(expired.executionId, now);
    }
    for (const row of this.db.dueAutomationCommands(now, runnerId, MAX_BATCH)) {
      if (!this.hub.isRunnerOnline(row.runnerId)) continue;
      if (!runnerSupportsProtocol(this.db.getRunner(row.runnerId)?.protocolVersion, "automationCommandReceipts")) {
        this.failForCapabilityLoss(row, now);
        continue;
      }
      let command: DurableSessionCommand;
      try {
        command = JSON.parse(row.payloadJson) as DurableSessionCommand;
      } catch {
        this.db.rejectAutomationCommand(row.commandId, "stored automation command payload is malformed", now);
        this.changed(row.executionId, now);
        continue;
      }
      if (automationCommandDigest(command) !== row.payloadSha256) {
        this.db.rejectAutomationCommand(row.commandId, "stored automation command digest does not match", now);
        this.changed(row.executionId, now);
        continue;
      }
      const attempt = row.attemptCount + 1;
      const nextAttemptAt = now + retryDelay(attempt);
      const requestId = randomUUID();
      // Persist the attempt first. A crash before send leaves a harmless delayed retry; a crash
      // after send is deduplicated by the runner's receipt journal.
      if (!this.db.markAutomationCommandSent(row.commandId, requestId, now, nextAttemptAt)) continue;
      const message: DurableSessionCommandMessage = {
        type: "durable_session_command",
        requestId,
        commandId: row.commandId,
        executionId: row.executionId,
        payloadDigest: row.payloadSha256,
        expiresAt: row.expiresAt,
        command,
      };
      if (this.hub.sendToRunner(row.runnerId, message)) sent += 1;
    }
    return sent;
  }

  receipt(runnerId: string, message: Receipt, now = Date.now()): boolean {
    if (!validReceipt(message)) {
      this.log.warn(`runner '${runnerId}' sent a malformed durable command receipt`);
      return false;
    }
    const state = storedState(message.state);
    let applied: ReturnType<ControlPlaneDb["recordAutomationCommandReceipt"]>;
    try {
      applied = this.db.recordAutomationCommandReceipt({
        commandId: message.commandId,
        runnerId,
        sessionId: message.sessionId,
        state,
        revision: message.revision,
        ...(message.error ? { error: message.error } : {}),
        ...(message.code ? { code: message.code } : {}),
        ...(message.type === "durable_session_command_result"
          ? { duplicate: message.duplicate, requestId: message.requestId }
          : {}),
        ...(message.type === "durable_session_command_update" && message.userEventSeq !== undefined
          ? { userEventSeq: message.userEventSeq }
          : {}),
        now,
      });
    } catch (error) {
      this.log.warn(`durable command receipt was ignored: ${(error as Error).message}`);
      return false;
    }
    if (!applied) return false;
    if (!applied.advanced) return true;
    this.changed(applied.executionId, now);
    // A receipt may satisfy a dependency or make a terminal execution observable immediately.
    this.flush(now, runnerId);
    return true;
  }

  recover(now = Date.now()): number {
    try {
      return this.flush(now);
    } catch (error) {
      this.log.warn(`automation command outbox recovery failed: ${(error as Error).message}`);
      return 0;
    }
  }

  private failForCapabilityLoss(
    row: ReturnType<ControlPlaneDb["activeAutomationCommands"]>[number],
    now: number,
  ): void {
    // A persisted `sent` attempt may have reached the runner even when its ACK was lost.
    const accepted = row.state === "sent" || row.state === "accepted" || row.state === "started";
    const applied = this.db.recordAutomationCommandReceipt({
      commandId: row.commandId,
      runnerId: row.runnerId,
      sessionId: row.sessionId,
      state: accepted ? "uncertain" : "rejected",
      revision: row.revision + 1,
      error: accepted
        ? "runner lost durable-command capability after accepting this command"
        : "runner no longer supports durable automation commands",
      now,
    });
    if (applied?.advanced) this.changed(applied.executionId, now);
  }
}

const RECEIPT_STATES = new Set(["accepted", "queued", "started", "completed", "failed", "uncertain"]);
const RECEIPT_CODES = new Set([
  "COMMAND_ID_CONFLICT", "COMMAND_EXPIRED", "INVALID_COMMAND", "SESSION_NOT_FOUND",
  "QUEUE_FULL", "COMMAND_CANCELLED", "RECEIPT_STORE_FULL",
]);

function validReceipt(message: Receipt): boolean {
  if (!message || typeof message !== "object" ||
      (message.type !== "durable_session_command_result" && message.type !== "durable_session_command_update") ||
      typeof message.commandId !== "string" || !message.commandId ||
      typeof message.sessionId !== "string" || !message.sessionId ||
      !RECEIPT_STATES.has(message.state) || !Number.isInteger(message.revision) || message.revision < 0 ||
      (message.error !== undefined && typeof message.error !== "string") ||
      (message.code !== undefined && !RECEIPT_CODES.has(message.code))) return false;
  if (message.type === "durable_session_command_result") {
    return typeof message.requestId === "string" && Boolean(message.requestId) && typeof message.duplicate === "boolean";
  }
  return message.userEventSeq === undefined || (Number.isInteger(message.userEventSeq) && message.userEventSeq >= 0);
}
