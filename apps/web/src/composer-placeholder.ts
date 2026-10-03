import type { AgentDriverKind, SessionStatus } from "@wollipog/protocol";

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
  if (input.policyPaused) return "Paused by a guardrail. Continue or stop in the request above.";
  return null;
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
  if (input.turnActive) return "Add a message. It sends when this turn ends.";
  if (input.narrow) return `Message ${input.agent}`;
  return input.fileReferences
    ? `Message ${input.agent}. Type / for commands or @ for files.`
    : `Message ${input.agent}. Type / for commands.`;
}
