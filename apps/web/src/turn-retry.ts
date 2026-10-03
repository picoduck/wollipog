import { isTerminal, type SessionStatus } from "@wollipog/protocol";

/** How Retry Turn on a failed turn's notice (#2169) can start a new turn now, or why it cannot. */
export type TurnRetryPlan =
  | { kind: "prompt" }
  /** A failed or stopped session takes no prompt until it restarts; Retry Turn restarts it first,
   * as Retry Worktree Setup does after a failed launch. */
  | { kind: "restart_then_prompt" }
  | { kind: "unavailable"; reason: string };

export interface TurnRetryInput {
  status: SessionStatus;
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

/** The reasons follow the composer's order, so the notice and the composer never disagree about
 * why a session cannot take a turn; a restartable terminal session is the one difference. */
export function turnRetryPlan(input: TurnRetryInput): TurnRetryPlan {
  const unavailable = (reason: string): TurnRetryPlan => ({ kind: "unavailable", reason });
  if (input.promptRefusal !== null) return unavailable(input.promptRefusal);
  if (input.sessionNoticeReason !== undefined) return unavailable(input.sessionNoticeReason);
  if (!input.runnerOnline) return unavailable("Runner is offline.");
  if (isTerminal(input.status)) {
    if (input.restartRefusal !== null) return unavailable(input.restartRefusal);
    if (input.stopFailed) return unavailable(TURN_RETRY_STOP_FAILED_REASON);
    return { kind: "restart_then_prompt" };
  }
  if (input.policyPaused) return unavailable("Session is paused by guardrails. Review the pending decision to continue.");
  if (input.status !== "idle") return unavailable(TURN_RETRY_BUSY_REASON);
  return { kind: "prompt" };
}
