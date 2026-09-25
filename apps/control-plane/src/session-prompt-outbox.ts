import { randomUUID } from "node:crypto";
import {
  isDurableSessionCommandErrorCode,
  runnerSupportsProtocol,
  type DurableSessionCommand,
  type DurableSessionCommandMessage,
  type DurableSessionCommandResultMessage,
  type DurableSessionCommandUpdateMessage,
} from "@wollipog/protocol";
import { automationCommandDigest, canonicalAutomationCommandJson } from "./automation-command-outbox.js";
import type { ControlPlaneDb, SessionPromptCommandRecord, WorkflowDecisionResumeState } from "./db.js";
import type { Hub } from "./hub.js";

type Receipt = DurableSessionCommandResultMessage | DurableSessionCommandUpdateMessage;
type Logger = { warn: (message: string) => void };
export type RetryablePendingPrompt = {
  command: Extract<DurableSessionCommand, { type: "prompt_session" }>;
  runnerId: string;
  errorCode: "PROVIDER_AUTHENTICATION_REQUIRED" | "WORKTREE_RECOVERY_REQUIRED";
};

const RECEIPT_HORIZON_MS = 30 * 24 * 60 * 60_000;
const MAX_RETRY_MS = 30_000;
const CAMPAIGN_HOLD_RECHECK_MS = 10_000;
const RECEIPT_STATES = new Set(["accepted", "queued", "started", "completed", "failed", "uncertain"]);

function retryDelay(attempt: number): number {
  return Math.min(MAX_RETRY_MS, 250 * (2 ** Math.min(7, Math.max(0, attempt - 1))));
}

/** Durable at-least-once transport for user-submitted prompts and recovered question answers.
 * The runner's command journal deduplicates retries; the control plane retains the exact payload
 * until a terminal receipt. */
export class SessionPromptOutbox {
  constructor(
    private readonly db: ControlPlaneDb,
    private readonly hub: Hub,
    private readonly log: Logger,
  ) {}

  stage(
    sessionId: string,
    runnerId: string,
    command: DurableSessionCommand,
    now = Date.now(),
  ): SessionPromptCommandRecord {
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

  /** Stage the command that resumes a child after its workflow decision resolves, bound to that
   * decision in the same transaction (#1650). Throws, staging nothing, when the resume is no
   * longer in the `from` state the caller observed. */
  stageWorkflowDecisionResume(
    occurrenceId: string,
    from: WorkflowDecisionResumeState | null,
    sessionId: string,
    runnerId: string,
    command: DurableSessionCommand,
    now = Date.now(),
  ): SessionPromptCommandRecord {
    return this.db.stageWorkflowDecisionResume({
      occurrenceId,
      from,
      command: {
        commandId: `prompt_${randomUUID()}`,
        sessionId,
        runnerId,
        payloadJson: canonicalAutomationCommandJson(command),
        payloadSha256: automationCommandDigest(command),
        expiresAt: now + RECEIPT_HORIZON_MS,
        now,
      },
    });
  }

  stageCampaignContinuation(input: {
    continuationId: string;
    campaignSessionId: string;
    runnerId: string;
    eventFromSeq: number;
    eventThroughSeq: number;
    attemptCount: number;
    command: Extract<DurableSessionCommand, { type: "prompt_session" }>;
    now: number;
  }) {
    const commandId = `campaign_prompt_${input.continuationId}`;
    const payloadJson = canonicalAutomationCommandJson(input.command);
    return this.db.stageCampaignContinuation({
      continuationId: input.continuationId,
      commandId,
      campaignSessionId: input.campaignSessionId,
      runnerId: input.runnerId,
      eventFromSeq: input.eventFromSeq,
      eventThroughSeq: input.eventThroughSeq,
      payloadJson,
      payloadSha256: automationCommandDigest(input.command),
      expiresAt: input.now + RECEIPT_HORIZON_MS,
      attemptCount: input.attemptCount,
      now: input.now,
    });
  }

  stageRecoveredAnswer(
    sessionId: string,
    runnerId: string,
    command: Extract<DurableSessionCommand, { type: "answer_recovered_question" }>,
    now: number,
    baseCommandId: string,
  ) {
    const payloadJson = canonicalAutomationCommandJson(command);
    return this.db.stageRetriableSessionPromptCommand({
      baseCommandId,
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
      if (command.type === "prompt_session" && command.campaignContinuation) {
        const campaign = this.db.campaignContinuationLifecycle(command.campaignContinuation.campaignSessionId);
        const lifecycleEligible = campaign && !campaign.archived && campaign.status === "idle" &&
          !campaign.hasPendingApproval;
        const projection = lifecycleEligible
          ? this.db.campaignProjection(command.campaignContinuation.campaignSessionId)
          : null;
        if (!lifecycleEligible || !projection || projection.status === "waiting_human" ||
            projection.status === "verified_complete") {
          this.db.deferSessionPromptCommand(row.commandId, now + CAMPAIGN_HOLD_RECHECK_MS, now);
          continue;
        }
      }
      const capability = command.type === "answer_recovered_question"
        ? "resumableQuestionAnswers"
        : command.type === "prompt_session" && command.campaignContinuation
          ? "campaignContinuations"
          : "durablePromptQueueIdentity";
      if (!runnerSupportsProtocol(this.db.getRunner(row.runnerId)?.protocolVersion, capability)) {
        this.db.recordSessionPromptCommandReceipt({
          commandId: row.commandId,
          runnerId: row.runnerId,
          sessionId: row.sessionId,
          state: row.state === "pending" ? "failed" : "uncertain",
          revision: row.revision + 1,
          error: command.type === "answer_recovered_question"
            ? "runner no longer supports resumable structured-question answers"
            : command.type === "prompt_session" && command.campaignContinuation
              ? "runner no longer supports durable campaign continuations"
              : "runner no longer supports durable queued prompt identity",
          now,
        });
        this.hub.sessionChangedById(row.sessionId);
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

  cancelPending(
    sessionId: string,
    commandId: string,
    now = Date.now(),
  ): "cancelled" | "not_found" | "delivery_started" {
    const result = this.db.cancelPendingSessionPromptCommand(sessionId, commandId, now);
    if (result === "cancelled") this.hub.sessionChangedById(sessionId);
    return result;
  }

  dismissTerminal(
    sessionId: string,
    commandId: string,
    now = Date.now(),
  ): "dismissed" | "not_found" | "not_terminal" {
    const result = this.db.dismissTerminalSessionPromptCommand(sessionId, commandId, now);
    if (result === "dismissed") this.hub.sessionChangedById(sessionId);
    return result;
  }

  retryKnownUndeliveredFailure(
    sessionId: string,
    commandId: string,
    now = Date.now(),
    flush = true,
  ): "retried" | "not_found" | "not_retryable" {
    const candidate = this.retryableKnownUndeliveredPrompt(sessionId, commandId);
    if (typeof candidate === "string") return candidate;
    const prior = this.db.getSessionPromptCommand(commandId);
    if (!prior) return "not_found";
    // Every explicit retry belongs to one stable incident chain. A second authentication failure
    // must advance `.retry-1` to `.retry-2`, rather than creating a nested identity that the
    // bounded retry lookup would no longer recognize.
    const baseCommandId = commandId.replace(/(?:\.retry-\d+)+$/u, "");
    const staged = this.db.stageRetriableSessionPromptCommand({
      baseCommandId,
      dismissCommandId: commandId,
      sessionId,
      runnerId: prior.runnerId,
      payloadJson: prior.payloadJson,
      payloadSha256: prior.payloadSha256,
      expiresAt: now + RECEIPT_HORIZON_MS,
      now,
    });
    if (staged.disposition !== "deliverable") return "not_retryable";
    this.hub.sessionChangedById(sessionId);
    if (flush) {
      try {
        this.flush(now, prior.runnerId);
      } catch (error) {
        this.log.warn(`retried durable prompt flush was deferred: ${(error as Error).message}`);
      }
    }
    return "retried";
  }

  /** Read-only validation used by the service admission gate before it mutates either prompt
   * identity. retryKnownUndeliveredFailure repeats this check at its synchronous commit boundary. */
  retryableKnownUndeliveredPrompt(
    sessionId: string,
    commandId: string,
  ): RetryablePendingPrompt | "not_found" | "not_retryable" {
    const prior = this.db.getSessionPromptCommand(commandId);
    if (!prior || prior.sessionId !== sessionId || prior.dismissedAt !== undefined) return "not_found";
    if (prior.state !== "failed" ||
        (prior.errorCode !== "PROVIDER_AUTHENTICATION_REQUIRED" &&
          prior.errorCode !== "WORKTREE_RECOVERY_REQUIRED") ||
        prior.userEventSeq !== undefined || prior.payloadJson === "null") return "not_retryable";
    let command: DurableSessionCommand;
    try {
      command = JSON.parse(prior.payloadJson) as DurableSessionCommand;
    } catch {
      return "not_retryable";
    }
    if (command.type !== "prompt_session" || command.sessionId !== sessionId || command.campaignContinuation ||
        automationCommandDigest(command) !== prior.payloadSha256) return "not_retryable";
    return { command, runnerId: prior.runnerId, errorCode: prior.errorCode };
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
      (message.code !== undefined && !isDurableSessionCommandErrorCode(message.code))) return false;
  if (message.type === "durable_session_command_result") {
    return typeof message.requestId === "string" && Boolean(message.requestId) && message.requestId.length <= 256 &&
      typeof message.duplicate === "boolean";
  }
  return message.userEventSeq === undefined ||
    (Number.isSafeInteger(message.userEventSeq) && Number(message.userEventSeq) >= 0);
}
