import type { AgentDriverKind, PendingApproval, SessionStatus } from "@wollipog/protocol";

/** The agent a composer addresses, by its product name: "Claude Code", "Codex", "Pi", or a generic
 * ACP agent's own name (docs/design-system.md §17). Never the driver's variant. */
export function composerAgentName(
  driver: AgentDriverKind,
  agentName: string | null | undefined,
  agentId?: string | null,
): string {
  if (driver === "claude-code") return "Claude Code";
  if (driver === "codex" || driver === "codex-app-server") return "Codex";
  if (driver === "pi") return "Pi";
  return agentName || agentId || "the agent";
}

/**
 * Why the composer cannot send a new message now, in the order the person has to act on it, or
 * null when it can (#2154). A Viewer's refusal comes first; an archived session's notice reason
 * comes next, because the slot shows it first; then the session's own state, the machine, the
 * slot's remaining conditions (#2037) and a guardrail pause.
 */
export function composerUnavailableReason(input: {
  refusal: string | null;
  archivedReason: string | undefined;
  status: SessionStatus;
  runnerOnline: boolean;
  machineName: string;
  noticeReason: string | undefined;
  policyPaused: boolean;
  /** Whose workflow decision pauses the session, when that is what pauses it (#4713). */
  workflowDecision?: WorkflowDecisionPause | null;
}): string | null {
  if (input.refusal !== null) return input.refusal;
  if (input.archivedReason !== undefined) return input.archivedReason;
  if (input.status === "failed") return "This session failed and can't take new messages.";
  if (input.status === "stopped") return "This session is stopped. Restart it to send a message.";
  if (input.status === "completed") return "This session has completed and can't take new messages.";
  if (!input.runnerOnline) {
    return `${input.machineName || "This machine"} is offline. You can send again when it reconnects.`;
  }
  if (input.noticeReason !== undefined) return input.noticeReason;
  if (input.policyPaused) {
    // A workflow decision is not a guardrail and offers no Continue or Stop: name who decides it.
    if (input.workflowDecision === "yours") return "Waiting for your decision. Answer the request above to continue.";
    if (input.workflowDecision === "orchestrator") return "Waiting for the Orchestrator's decision on the request above.";
    if (input.workflowDecision === "unknown") return "Waiting for a decision on the request above.";
    return "Paused by a guardrail. Continue or stop in the request above.";
  }
  return null;
}

export type WorkflowDecisionPause = "yours" | "orchestrator" | "unknown";

/** Who decides the workflow decision a session waits on, or null when it waits on something else. */
export function workflowDecisionPause(approval: PendingApproval | null | undefined): WorkflowDecisionPause | null {
  if (approval?.kind !== "workflow_decision") return null;
  const authority = approval.workflowDecision?.authority;
  return authority === "human" ? "yours" : authority === "orchestrator" ? "orchestrator" : "unknown";
}

/** The composer's placeholder: why it cannot send, or what a message sent now will do. */
export function composerPlaceholder(input: {
  unavailableReason: string | null;
  agent: string;
  /** Under 760px the ready sentence drops its trigger hints. */
  narrow: boolean;
  /** An approval or question the agent is waiting on. */
  inputPending: boolean;
  /** A turn is running, so a new message waits for it. */
  turnActive: boolean;
  /** Whether `@` opens the file picker; a runner without workspace references has no `@`. */
  fileReferences: boolean;
}): string {
  if (input.unavailableReason !== null) return input.unavailableReason;
  if (input.inputPending) return "Messages you send now wait until you answer the request above.";
  if (input.turnActive) return "Add a message. It sends when this turn ends; Ctrl+Enter steers now.";
  if (input.narrow) return `Message ${input.agent}`;
  return input.fileReferences
    ? `Message ${input.agent}. Type / for commands or @ for files.`
    : `Message ${input.agent}. Type / for commands.`;
}
