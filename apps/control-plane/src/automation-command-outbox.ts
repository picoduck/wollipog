import { createHash, randomUUID } from "node:crypto";
import type {
  AutomationCommandState,
  DurableSessionCommand,
  DurableSessionCommandMessage,
  DurableSessionCommandResultMessage,
  DurableSessionCommandUpdateMessage,
} from "@wollipog/protocol";
import { isDurableSessionCommandErrorCode, runnerSupportsProtocol } from "@wollipog/protocol";
import type { AutomationCommandRecord, ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import { isTransientProviderError } from "./provider-error.js";

type Logger = { warn: (message: string) => void };
type Receipt = DurableSessionCommandResultMessage | DurableSessionCommandUpdateMessage;

const MAX_BATCH = 100;
const MAX_RETRY_MS = 30_000;
/** Replacement attempts for a launch the provider failed for a passing reason. The condition that
 * motivates this — another Claude Code process holding the credential refresh — clears in about a
 * minute, so three attempts spread over roughly seven cover it without holding the execution open
 * long enough to collide with the automation's next scheduled tick. */
const MAX_PROVIDER_RETRIES = 3;
const PROVIDER_RETRY_BASE_MS = 60_000;

function providerRetryDelay(attempt: number): number {
  return PROVIDER_RETRY_BASE_MS * (2 ** Math.max(0, attempt - 1));
}

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
    /** False once a command has outlived its execution's delivery bound. Asked here rather than
     * only before a tick's flush because `receipt()` and runner registration flush directly: a
     * bound enforced only by the caller would let those paths hand a runner a launch the very
     * sweep that follows is about to write off. Skipping only defers — the sweep does the
     * expiring — so this stays a pure predicate and mutates nothing mid-flush. */
    private readonly deliverable: (row: AutomationCommandRecord, now: number) => boolean = () => true,
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
      if (!this.deliverable(row, now)) continue;
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
    if (state === "rejected" && this.retryProviderFailure(runnerId, message, now)) return true;
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

  /**
   * A launch the provider ended for a transient reason is not a verdict on the job. Replace the
   * command with a fresh identity due after a delay instead of settling the execution, so the
   * scheduled work still runs in its window. The replacement is a new command id because the
   * runner's journal answers a replayed id with its stored terminal receipt and runs nothing.
   *
   * Returns true only when a replacement was durably issued; every other path falls through to
   * the ordinary rejection so a real refusal still fails on its first attempt.
   */
  private retryProviderFailure(runnerId: string, message: Receipt, now: number): boolean {
    if (!isTransientProviderError(message.error)) return false;
    const command = this.db.getAutomationCommand(message.commandId);
    if (!command || command.kind !== "start_session") return false;
    const attempt = this.db.listAutomationCommands(command.executionId)
      .filter((sibling) => sibling.supersededBy !== undefined).length + 1;
    if (attempt > MAX_PROVIDER_RETRIES) return false;
    let retried: ReturnType<ControlPlaneDb["retryAutomationCommand"]>;
    try {
      retried = this.db.retryAutomationCommand({
        commandId: message.commandId,
        runnerId,
        sessionId: message.sessionId,
        ...(message.type === "durable_session_command_result" ? { requestId: message.requestId } : {}),
        revision: message.revision,
        error: message.error!,
        ...(message.code ? { code: message.code } : {}),
        nextAttemptAt: now + providerRetryDelay(attempt),
        now,
      });
    } catch (error) {
      this.log.warn(`durable command retry was not issued: ${(error as Error).message}`);
      return false;
    }
    if (!retried) return false;
    this.log.warn(
      `automation command '${message.commandId}' failed transiently and was replaced by ` +
      `'${retried.replacement.commandId}' (attempt ${attempt} of ${MAX_PROVIDER_RETRIES}): ${message.error}`,
    );
    this.changed(retried.executionId, now);
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

function validReceipt(message: Receipt): boolean {
  if (!message || typeof message !== "object" ||
      (message.type !== "durable_session_command_result" && message.type !== "durable_session_command_update") ||
      typeof message.commandId !== "string" || !message.commandId ||
      typeof message.sessionId !== "string" || !message.sessionId ||
      !RECEIPT_STATES.has(message.state) || !Number.isInteger(message.revision) || message.revision < 0 ||
      (message.error !== undefined && typeof message.error !== "string") ||
      (message.code !== undefined && !isDurableSessionCommandErrorCode(message.code))) return false;
  if (message.type === "durable_session_command_result") {
    return typeof message.requestId === "string" && Boolean(message.requestId) && typeof message.duplicate === "boolean";
  }
  return message.userEventSeq === undefined || (Number.isInteger(message.userEventSeq) && message.userEventSeq >= 0);
}
