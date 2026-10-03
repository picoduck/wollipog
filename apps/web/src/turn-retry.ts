import { isTerminal, type AgentDriverKind, type SessionStatus } from "@wollipog/protocol";

/** How Retry Turn on a failed turn's notice (#2169) can start a new turn now, or why it cannot. */
export type TurnRetryPlan =
  | { kind: "prompt" }
  /** A failed or stopped session takes no prompt until it restarts; Retry Turn restarts it first,
   * as Retry Worktree Setup does after a failed launch, where the restart resumes the conversation. */
  | { kind: "restart_then_prompt" }
  | { kind: "unavailable"; reason: string };

/**
 * The drivers whose explicit Restart resumes the provider conversation. It mirrors the runner's start
 * path (apps/runner/src/session-manager.ts, where a restart passes the prior agentSessionId only for
 * these drivers and keeps the "fresh-start behavior for Claude and exec Codex"). The control plane
 * exposes no capability for it, so this list changes with that rule.
 */
export const RESTART_RESUMING_DRIVERS: ReadonlySet<AgentDriverKind> = new Set(["codex-app-server", "pi"]);

export function restartResumesConversation(driver: AgentDriverKind | null | undefined): boolean {
  return driver != null && RESTART_RESUMING_DRIVERS.has(driver);
}

export interface TurnRetryInput {
  status: SessionStatus;
  driver: AgentDriverKind | null | undefined;
  runnerOnline: boolean;
  /** The server's refusal of a prompt to this person (a Viewer). */
  promptRefusal: string | null;
  /** The server's refusal of a restart to this person. */
  restartRefusal: string | null;
  /** The session notice slot's first condition that stops a new message: archived, a quarantined
   * conversation, worktree recovery or a failed account switch. */
  sessionNoticeReason?: string;
  /** A guardrail pause waiting on its Continue / Stop decision. */
  policyPaused: boolean;
  /** A Stop that failed, which must be retried before the session can restart. */
  stopFailed: boolean;
}

export const TURN_RETRY_BUSY_REASON = "The agent is working on another turn.";
export const TURN_RETRY_STOP_FAILED_REASON = "Retry the failed Stop before retrying this turn.";
/** A restart of this driver starts a new provider conversation, so a retried prompt would run without
 * the turns before it; the person restarts knowingly, then sends it again. */
export const TURN_RETRY_FRESH_RESTART_REASON =
  "Restarting starts a new conversation. Restart the session, then send the message again.";

/** The reasons follow the composer's order, so the notice and the composer never disagree about
 * why a session cannot take a turn; a terminal session whose restart resumes is the one difference. */
export function turnRetryPlan(input: TurnRetryInput): TurnRetryPlan {
  const unavailable = (reason: string): TurnRetryPlan => ({ kind: "unavailable", reason });
  if (input.promptRefusal !== null) return unavailable(input.promptRefusal);
  if (input.sessionNoticeReason !== undefined) return unavailable(input.sessionNoticeReason);
  if (!input.runnerOnline) return unavailable("Runner is offline.");
  if (isTerminal(input.status)) {
    if (input.restartRefusal !== null) return unavailable(input.restartRefusal);
    if (input.stopFailed) return unavailable(TURN_RETRY_STOP_FAILED_REASON);
    if (!restartResumesConversation(input.driver)) return unavailable(TURN_RETRY_FRESH_RESTART_REASON);
    return { kind: "restart_then_prompt" };
  }
  if (input.policyPaused) return unavailable("Session is paused by guardrails. Review the pending decision to continue.");
  if (input.status !== "idle") return unavailable(TURN_RETRY_BUSY_REASON);
  return { kind: "prompt" };
}
