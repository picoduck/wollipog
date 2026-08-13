import type {
  CancelSessionMessage,
  InterruptTurnMessage,
  InterruptTurnResultReason,
} from "@wollipog/protocol";

export interface SessionCancellationCommandDependencies {
  cancelSessionStart(sessionId: string): void;
  cancelSession(sessionId: string): void;
  interruptTurn(sessionId: string, turnId?: string): InterruptTurnResultReason;
}

/** Keep terminal session cancellation separate from non-terminal turn interruption. */
export function handleSessionCancellationCommand(
  command: CancelSessionMessage | InterruptTurnMessage,
  dependencies: SessionCancellationCommandDependencies,
): InterruptTurnResultReason | undefined {
  if (command.type === "cancel_session") {
    dependencies.cancelSessionStart(command.sessionId);
    dependencies.cancelSession(command.sessionId);
    return;
  }

  return dependencies.interruptTurn(command.sessionId, command.turnId);
}
