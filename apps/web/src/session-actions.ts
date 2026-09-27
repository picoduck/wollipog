import {
  isTerminalDurableDeliveryState,
  runnerSupportsProtocol,
  type AgentDriverKind,
  type QueuedPromptView,
  type SessionStatus,
} from "@wollipog/protocol";

/** A settled durable delivery receipt. Its delivery has already ended, so it can be neither
 * cancelled nor waited out; it stays in `SessionView.queued` only so it can be dismissed. Which
 * delivery states are terminal is the protocol's to say; this only projects the entry onto it. */
export function isTerminalDeliveryReceipt(prompt: QueuedPromptView): boolean {
  return isTerminalDurableDeliveryState(prompt.durableDeliveryState);
}

/** Prompts in `SessionView.queued` that are still pending work. Settled receipts are evidence, not
 * work, so every "is this Session busy?" gate counts with this rather than `queued.length`. */
export function pendingQueuedPromptCount(queued: readonly QueuedPromptView[] | undefined): number {
  return (queued ?? []).filter((prompt) => !isTerminalDeliveryReceipt(prompt)).length;
}

export interface EditInForkContext {
  driver: AgentDriverKind;
  hasWorktree: boolean;
  runnerOnline: boolean;
  runnerProtocolVersion?: number | null;
  status: SessionStatus;
  queuedPrompts: number;
  busy: boolean;
  /** Why the signed-in person may not fork this session (#1864), or null when they may. */
  forkRefusal?: string | null;
}

export interface ConversationForkContext extends EditInForkContext {
  providerSupported: boolean;
  forkInProgress: boolean;
}

export type ConversationForkAvailability =
  | { available: true; forkTurn: number }
  | { available: false; reason: string };

/** `offered` is false where this message can never be edited in a fork in this session, so no
 * control is shown. Otherwise the control stays visible, disabled with `reason`. */
export type EditInForkAvailability =
  | { available: true; forkTurn: number }
  | { available: false; offered: boolean; reason: string };

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

export interface CheckpointHandoffContext {
  runnerOnline: boolean;
  runnerProtocolVersion?: number | null;
  hasWorktree: boolean;
  status: SessionStatus;
  queuedPrompts: number;
  busy: boolean;
  forkInProgress: boolean;
  /** A handoff creates its session through the fork route, so it shares Fork's refusal (#1864). */
  forkRefusal?: string | null;
}

/** Why a checkpoint handoff cannot start, or `undefined` when it can. `queuedPrompts` counts pending
 * work only (see `pendingQueuedPromptCount`), so a settled receipt never reports the Session busy. */
export function checkpointHandoffUnavailableReason(context: CheckpointHandoffContext): string | undefined {
  if (context.forkRefusal) return context.forkRefusal;
  if (!context.runnerOnline) return "The runner is offline.";
  if (!runnerSupportsProtocol(context.runnerProtocolVersion, "conversationHandoff")) {
    return "Update the runner to support checkpoint handoffs.";
  }
  if (!context.hasWorktree) return "A worktree is required.";
  if (context.busy || context.forkInProgress || context.queuedPrompts > 0 ||
      ["running", "starting", "queued", "input_required"].includes(context.status)) {
    return "The source session is busy.";
  }
  return undefined;
}

/** Shared fail-closed gate for every plain conversation-fork entry point. */
export function conversationForkAvailability(
  forkTurn: number | undefined,
  latestKnownTurn: number | undefined,
  context: ConversationForkContext,
): ConversationForkAvailability {
  if (context.forkRefusal) return { available: false, reason: context.forkRefusal };
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
  if ((context.driver === "claude-code" || context.driver === "pi") && forkTurn !== latestKnownTurn) {
    return {
      available: false,
      reason: `${context.driver === "pi" ? "Pi" : "Claude Code"} can fork only its latest completed conversation checkpoint.`,
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
 * Claude and Pi can fork only their latest transcripts and therefore cannot remove N.
 *
 * Conditions that can never clear for this message come first and hide the control. Every runtime
 * gate after them, the person's fork refusal included, leaves it visible with its reason, as the
 * other fork controls do (#1869).
 */
export function editInForkAvailability(
  userTurn: number | undefined,
  completedConversationTurns: ReadonlySet<number>,
  context: EditInForkContext,
): EditInForkAvailability {
  const hidden = (reason: string) => ({ available: false, offered: false, reason }) as const;
  const disabled = (reason: string) => ({ available: false, offered: true, reason }) as const;
  if (context.driver !== "codex-app-server") {
    return hidden("Historical edit-and-fork is available only for Codex App Server sessions.");
  }
  if (!Number.isInteger(userTurn) || userTurn! <= 1) {
    return hidden("This message has no earlier completed provider checkpoint to fork from.");
  }
  const forkTurn = userTurn! - 1;
  // A message whose own turn has not completed (still running, cancelled or refused) is not
  // offered either: from the transcript alone a running turn cannot be told from a cancelled one.
  if (!completedConversationTurns.has(userTurn!) || !completedConversationTurns.has(forkTurn)) {
    return hidden("The exact provider checkpoint before this message is unavailable.");
  }
  if (context.forkRefusal) return disabled(context.forkRefusal);
  if (!context.hasWorktree) return disabled("Edit-and-fork requires an isolated worktree session.");
  if (!context.runnerOnline) return disabled("Reconnect the runner before creating a fork.");
  if (!runnerSupportsProtocol(context.runnerProtocolVersion, "conversationFork")) {
    return disabled("Update and restart the runner to enable conversation forks.");
  }
  if (["queued", "running", "starting", "input_required"].includes(context.status)) {
    return disabled("Wait for the current turn or approval before creating a fork.");
  }
  if (context.queuedPrompts > 0) return disabled("Cancel or wait for queued messages before creating a fork.");
  if (context.busy) return disabled("Another session action is already in progress.");
  return { available: true, forkTurn };
}
