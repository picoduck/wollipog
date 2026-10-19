import type { PodMemberRole, PodMemberView, PodOrchestrationState, PodView, SessionView } from "@wollipog/protocol";
import { sessionAgentLabel } from "./components/agent-options.js";
import { titleCaseLabel } from "./format.js";

/** A member's role in words: "Worker". */
export function podRoleLabel(role: PodMemberRole): string {
  return titleCaseLabel(role);
}

/** A member by role and agent: "Worker · Codex". A member whose session is gone keeps its role. */
export function podMemberName(member: PodMemberView, session: SessionView | undefined): string {
  const role = podRoleLabel(member.role);
  return session ? `${role} · ${sessionAgentLabel(session.agentName, session.driver, session.agentId)}` : role;
}

/** The member's task: its session title without a leading role ("Worker: migrate…" reads
 * "migrate…"), so a label that already names the role never says it twice (#2980). */
export function podMemberTask(member: PodMemberView, session: SessionView | undefined): string {
  const title = session?.title.trim() ?? "";
  const role = podRoleLabel(member.role);
  const prefix = new RegExp(`^${role}\\s*[:·–—-]\\s*`, "iu");
  return title.replace(prefix, "").trim() || title;
}

/** A member as a choice: "Worker · Codex: migrate call sites". */
export function podMemberChoiceLabel(member: PodMemberView, session: SessionView | undefined): string {
  const task = podMemberTask(member, session);
  return task ? `${podMemberName(member, session)}: ${task}` : podMemberName(member, session);
}

/** A member in a sentence: its role while no other member shares it, else role and agent. A
 * session no longer in the pod is named by its title, or "a former member". */
export function podMemberShortName(pod: PodView, sessions: ReadonlyMap<string, SessionView>, sessionId: string): string {
  const member = pod.members.find((candidate) => candidate.sessionId === sessionId);
  if (!member) return sessions.get(sessionId)?.title || "A former member";
  const shared = pod.members.some((other) => other.sessionId !== sessionId && other.role === member.role);
  return shared ? podMemberName(member, sessions.get(sessionId)) : podRoleLabel(member.role);
}

/** Stop reasons a person caused or already sees elsewhere, which need no banner. */
const SILENT_STOP_REASONS = new Set(["stopped_by_human", "pod_closed"]);

/**
 * Why automatic turns stopped, once, in a sentence (#2980): the turn limit, repeated answers, a
 * member that needs the person, or a member that ended. Anything else says that turns stopped,
 * with the server's own words behind Show Details. Null when nothing needs saying.
 */
export function podTurnsStopNotice(state: PodOrchestrationState | undefined): { sentence: string; details?: string } | null {
  if (!state || (state.status !== "stopped" && state.status !== "paused")) return null;
  const reason = state.stopReason;
  if (!reason || SILENT_STOP_REASONS.has(reason)) return null;
  if (reason === "max_turns") return { sentence: "Automatic turns stopped: the turn limit was reached." };
  if (reason.startsWith("repeated_output")) return { sentence: "Automatic turns stopped: a member gave the same answer again." };
  if (reason === "member_requires_human_decision") return { sentence: "Automatic turns paused: a member needs your decision." };
  if (reason === "lead_turn_complete") return { sentence: "Automatic turns paused: the lead finished its turn." };
  if (reason === "no_eligible_next_member") return { sentence: "Automatic turns paused: no member could take the next turn." };
  if (reason === "member_failed") return { sentence: "Automatic turns stopped: a member failed." };
  if (reason === "member_stopped") return { sentence: "Automatic turns stopped: a member was stopped." };
  if (reason === "member_input_required") return { sentence: "Automatic turns stopped: a member needs your input." };
  return { sentence: "Automatic turns stopped.", details: reason };
}
