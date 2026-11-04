import { isPolicyApproval, isTerminal, runnerSupportsProtocol, type SessionView } from "@wollipog/protocol";
import { sessionCommandRefusal } from "./session-command-permissions.js";
import { canStopActiveTurn } from "./session-actions.js";
import { statusMeta } from "./status-meta.js";
import type { TimelineItem } from "./timeline.js";

/**
 * What a Multi-Agent Run does with its members (#2976): their names, whether each can take a
 * follow-up or be stopped, its final answer, and the per-member fan-out the Follow Up dialog sends.
 * Pure, so the run page and its tests share one answer.
 */

/**
 * Each member's name, in run order. Two members running the same agent would read the same, so
 * those are numbered by their position among the agent's members ("Claude Code 1", "Claude Code 2"),
 * the same on the tabs, the column heads, the Follow Up dialog and the Stop confirmations (§10.1).
 */
export function runMemberLabels(agents: readonly string[]): string[] {
  const totals = new Map<string, number>();
  for (const agent of agents) totals.set(agent, (totals.get(agent) ?? 0) + 1);
  // A member not loaded yet has no name to share.
  const seen = new Map<string, number>();
  return agents.map((agent) => {
    if (!agent || (totals.get(agent) ?? 0) < 2) return agent;
    const index = (seen.get(agent) ?? 0) + 1;
    seen.set(agent, index);
    return `${agent} ${index}`;
  });
}

/** Whether the member can take a follow-up now. */
export type FollowUpAvailability =
  /** Awaiting a prompt: checked when the dialog opens. */
  | { kind: "ready" }
  /** Can take a prompt but is waiting on something else (an answer, a review): offered unchecked. */
  | { kind: "available" }
  /** Its agent is working, or ended, or the person may not prompt it: unavailable, with why. */
  | { kind: "running" | "ended" | "refused"; reason: string };

type MemberSession = Pick<SessionView, "status" | "archived" | "historyQuarantine" | "commandPermissions">;

/** A member whose agent is working: Starting, Running, Stopping, Children Working and the like. */
export function memberWorking(session: Pick<SessionView, "status">): boolean {
  return session.status === "queued" || statusMeta("session", session.status).pulse;
}

export function followUpAvailability(session: MemberSession): FollowUpAvailability {
  if (isTerminal(session.status) || session.archived || session.historyQuarantine) return { kind: "ended", reason: "Ended" };
  if (memberWorking(session)) return { kind: "running", reason: "Running" };
  const refusal = sessionCommandRefusal(session, "prompt");
  if (refusal !== null) return { kind: "refused", reason: refusal };
  return session.status === "idle" ? { kind: "ready" } : { kind: "available" };
}

export const followUpSelectable = (availability: FollowUpAvailability) =>
  availability.kind === "ready" || availability.kind === "available";

/** The member's machine, as far as this device knows it. */
export interface MemberRunner {
  online: boolean;
  protocolVersion?: number | null;
}

/**
 * Why Stop Agent is unavailable for the member, or null while its current turn can be stopped. Stop
 * Agent is the composer's Stop Turn (`cancelTurn`): it stops the turn and keeps the session, so the
 * member can still take a follow-up.
 */
export function stopAgentUnavailableReason(
  session: Pick<SessionView, "status" | "activeTurnId" | "pendingApproval" | "commandPermissions">,
  runner: MemberRunner,
): string | null {
  const context = {
    runnerOnline: runner.online,
    runnerProtocolVersion: runner.protocolVersion,
    status: session.status,
    policyPaused: isPolicyApproval(session.pendingApproval),
    activeTurnId: session.activeTurnId,
  };
  if (!session.activeTurnId || (session.status !== "running" && session.status !== "input_required")) return "Not running";
  if (!runner.online) return "Its machine is offline.";
  if (!runnerSupportsProtocol(runner.protocolVersion, "turnInterruptionAck")) return "Update its machine to stop a turn.";
  const refusal = sessionCommandRefusal(session, "cancelTurn");
  if (refusal !== null) return refusal;
  return canStopActiveTurn(context) ? null : "Waiting on a policy approval.";
}

/**
 * The member's last reply: the text of its newest top-level agent message, as the agent wrote it
 * (Markdown), or null before it has replied. A subagent's messages are its own work, not the answer.
 */
export function memberFinalAnswer(items: readonly TimelineItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.kind === "agent_message" && !item.parentToolUseId && item.text.trim()) return item.text;
  }
  return null;
}

/** One member's answer to a follow-up send. */
export type MemberSendResult = { sessionId: string; ok: true } | { sessionId: string; ok: false; error: string };

/**
 * Sends one follow-up to each member through its own `prompt` call, all at once (#2976). Every send
 * settles: one refusal never cancels the others, and each member's outcome comes back in order.
 */
export async function promptRunMembers(
  prompt: (sessionId: string, text: string) => Promise<unknown>,
  sessionIds: readonly string[],
  text: string,
): Promise<MemberSendResult[]> {
  const settled = await Promise.allSettled(sessionIds.map((sessionId) => prompt(sessionId, text)));
  return settled.map((outcome, index): MemberSendResult => {
    const sessionId = sessionIds[index]!;
    if (outcome.status === "fulfilled") return { sessionId, ok: true };
    const reason = outcome.reason;
    return { sessionId, ok: false, error: reason instanceof Error && reason.message ? reason.message : "The send failed." };
  });
}

/** Names in a sentence: "Codex", "Claude Code and Codex", "Claude Code 1, Claude Code 2 and Codex". */
export function namesSentence(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
