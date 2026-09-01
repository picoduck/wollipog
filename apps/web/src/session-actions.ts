import {
  runnerSupportsProtocol,
  type AgentDriverKind,
  type SessionStatus,
} from "@wollipog/protocol";

export interface EditInForkContext {
  driver: AgentDriverKind;
  hasWorktree: boolean;
  runnerOnline: boolean;
  runnerProtocolVersion?: number | null;
  status: SessionStatus;
  queuedPrompts: number;
  busy: boolean;
}

export interface ConversationForkContext extends EditInForkContext {
  providerSupported: boolean;
  forkInProgress: boolean;
}

export type ConversationForkAvailability =
  | { available: true; forkTurn: number }
  | { available: false; reason: string };

export type EditInForkAvailability =
  | { available: true; forkTurn: number }
  | { available: false; reason: string };

export interface StopTurnContext {
  runnerOnline: boolean;
  runnerProtocolVersion?: number | null;
  status: SessionStatus;
  policyPaused?: boolean;
  activeTurnId?: string;
}

export type ComposerPrimaryAction = "send" | "stop" | "stopping";

/** Turn interruption is intentionally narrower than the queueing predicate: queued/starting
 * launches have no active provider turn and the v72 acknowledged endpoint rejects them fail-closed. */
export function canStopActiveTurn(context: StopTurnContext): boolean {
  return context.runnerOnline
    && runnerSupportsProtocol(context.runnerProtocolVersion, "turnInterruptionAck")
    && !context.policyPaused
    && Boolean(context.activeTurnId)
    && (context.status === "running" || context.status === "input_required");
}

export function composerPrimaryAction(input: {
  canStopTurn: boolean;
  hasContent: boolean;
  stopping: boolean;
}): ComposerPrimaryAction {
  if (input.canStopTurn && input.stopping) return "stopping";
  if (!input.canStopTurn || input.hasContent) return "send";
  return "stop";
}

// A fork can take minutes and outlive one SessionDetail mount. Keep the lock at module scope so
// navigating away and reopening the source cannot start a second ambiguous operation.
const activeSessionForks = new Set<string>();
const sessionForkListeners = new Set<() => void>();

function notifySessionForkListeners(): void {
  for (const listener of sessionForkListeners) listener();
}

export function subscribeSessionForks(listener: () => void): () => void {
  sessionForkListeners.add(listener);
  return () => sessionForkListeners.delete(listener);
}

export function sessionForkInProgress(sessionId: string): boolean {
  return activeSessionForks.has(sessionId);
}

export function acquireSessionFork(sessionId: string): (() => void) | null {
  if (activeSessionForks.has(sessionId)) return null;
  activeSessionForks.add(sessionId);
  notifySessionForkListeners();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSessionForks.delete(sessionId);
    notifySessionForkListeners();
  };
}

/** Shared fail-closed gate for every plain conversation-fork entry point. */
export function conversationForkAvailability(
  forkTurn: number | undefined,
  latestKnownTurn: number | undefined,
  context: ConversationForkContext,
): ConversationForkAvailability {
  if (!Number.isInteger(forkTurn) || forkTurn! <= 0) {
    return { available: false, reason: "Complete a conversation turn before creating a fork." };
  }
  if (!context.hasWorktree) {
    return { available: false, reason: "Conversation forks require an isolated worktree session." };
  }
  if (!context.runnerOnline) {
    return { available: false, reason: "Reconnect the runner before creating a fork." };
  }
  if (!runnerSupportsProtocol(context.runnerProtocolVersion, "conversationFork")) {
    return { available: false, reason: "Update and restart the runner to enable conversation forks." };
  }
  if (!context.providerSupported) {
    return { available: false, reason: "This provider does not support conversation forks." };
  }
  if (context.forkInProgress) {
    return { available: false, reason: "A conversation fork is already in progress for this session." };
  }
  if (["queued", "running", "starting", "input_required"].includes(context.status)) {
    return { available: false, reason: "Wait for the current turn or approval before creating a fork." };
  }
  if (context.queuedPrompts > 0) {
    return { available: false, reason: "Cancel or wait for queued messages before creating a fork." };
  }
  if (context.busy) {
    return { available: false, reason: "Another session action is already in progress." };
  }
  if (context.driver === "claude-code" && forkTurn !== latestKnownTurn) {
    return {
      available: false,
      reason: "Claude Code can fork only its latest completed conversation checkpoint.",
    };
  }
  return { available: true, forkTurn: forkTurn! };
}

/** A lost response or server-side 5xx cannot prove whether the non-idempotent fork committed. */
export function forkFailureIsAmbiguous(httpStatus?: number): boolean {
  return httpStatus === undefined || httpStatus >= 500;
}

/**
 * Editing completed turn N means forking the provider/files AFTER N-1, then preparing the edited
 * prompt in the child composer. Only Codex app-server currently proves historical provider forks;
 * Claude's --fork-session can fork only its latest transcript and therefore cannot remove N.
 */
export function editInForkAvailability(
  userTurn: number | undefined,
  completedConversationTurns: ReadonlySet<number>,
  context: EditInForkContext,
): EditInForkAvailability {
  if (context.driver !== "codex-app-server") {
    return { available: false, reason: "Historical edit-and-fork is available only for Codex App Server sessions." };
  }
  if (!context.hasWorktree) {
    return { available: false, reason: "Edit-and-fork requires an isolated worktree session." };
  }
  if (!context.runnerOnline) {
    return { available: false, reason: "Reconnect the runner before creating a fork." };
  }
  if (!runnerSupportsProtocol(context.runnerProtocolVersion, "conversationFork")) {
    return { available: false, reason: "Update and restart the runner to enable conversation forks." };
  }
  if (["queued", "running", "starting", "input_required"].includes(context.status)) {
    return { available: false, reason: "Wait for the current turn or approval before creating a fork." };
  }
  if (context.queuedPrompts > 0) {
    return { available: false, reason: "Cancel or wait for queued messages before creating a fork." };
  }
  if (context.busy) {
    return { available: false, reason: "Another session action is already in progress." };
  }
  if (!Number.isInteger(userTurn) || userTurn! <= 1) {
    return { available: false, reason: "This message has no earlier completed provider checkpoint to fork from." };
  }
  const forkTurn = userTurn! - 1;
  if (!completedConversationTurns.has(userTurn!) || !completedConversationTurns.has(forkTurn)) {
    return { available: false, reason: "The exact provider checkpoint before this message is unavailable." };
  }
  return { available: true, forkTurn };
}
