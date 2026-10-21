import type { PodContextEntry, PodMemberRole, PodMemberView, PodOrchestrationState, PodView, SessionEvent, SessionView } from "@wollipog/protocol";
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

/**
 * Why a member's latest answer cannot go to the huddle yet (#2983): its turn is still running, or
 * it has not answered. Null once it has a top-level answer to share.
 */
export function podShareReason(
  session: Pick<SessionView, "status">,
  events: readonly SessionEvent[] | undefined,
  agent: string,
): string | null {
  if (session.status === "starting" || session.status === "running") return `Available when ${agent} finishes its turn.`;
  const answered = events?.some((event) => event.payload.kind === "agent_message" && !event.payload.parentToolUseId && event.payload.text);
  return answered ? null : "No answer yet.";
}

/** A member as a choice: "Worker · Codex: migrate call sites". */
export function podMemberChoiceLabel(member: PodMemberView, session: SessionView | undefined): string {
  const task = podMemberTask(member, session);
  return task ? `${podMemberName(member, session)}: ${task}` : podMemberName(member, session);
}

/** Where a member's name starts: its role, its role and agent, or those and its task. */
export type PodMemberNameStart = "role" | "agent" | "task";

/** Two names a person could not tell apart: the same words, whatever their case and spacing. */
const nameKey = (name: string) => name.toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();

/**
 * Names for `sessionIds` that no two of them share (#2980). Each starts at `start` and grows only
 * while it reads like another's: role ("Worker"), then role and agent ("Worker · Codex"), then
 * those and the task ("Worker · Codex: migrate call sites"), and last the session's id, which
 * nothing else shares, so even two workers on one agent with one title stay apart. A session that
 * left the pod is named by its title, or "A former member", then the same with its id.
 */
export function podMemberNames(
  pod: PodView,
  sessions: ReadonlyMap<string, SessionView>,
  sessionIds: readonly string[],
  start: PodMemberNameStart = "role",
): Map<string, string> {
  const ids = [...new Set(sessionIds)];
  const ladders = new Map(ids.map((sessionId) => {
    const member = pod.members.find((candidate) => candidate.sessionId === sessionId);
    const session = sessions.get(sessionId);
    if (!member) {
      const title = session?.title.trim() || "A former member";
      return [sessionId, [title, `${title} (${sessionId})`]];
    }
    const levels = [podRoleLabel(member.role), podMemberName(member, session), podMemberChoiceLabel(member, session)]
      .slice(start === "role" ? 0 : start === "agent" ? 1 : 2);
    return [sessionId, [...levels, `${levels.at(-1)!} (${sessionId})`]];
  }));
  const level = new Map(ids.map((sessionId) => [sessionId, 0]));
  const name = (sessionId: string) => ladders.get(sessionId)![level.get(sessionId)!]!;
  // Every name in a group that reads alike takes its next step, until none do; the last step
  // carries the session id, so this always ends.
  for (;;) {
    const groups = new Map<string, string[]>();
    for (const sessionId of ids) groups.set(nameKey(name(sessionId)), [...groups.get(nameKey(name(sessionId))) ?? [], sessionId]);
    const colliding = [...groups.values()].filter((group) => group.length > 1).flat()
      .filter((sessionId) => level.get(sessionId)! < ladders.get(sessionId)!.length - 1);
    if (colliding.length === 0) break;
    for (const sessionId of colliding) level.set(sessionId, level.get(sessionId)! + 1);
  }
  return new Map(ids.map((sessionId) => [sessionId, name(sessionId)]));
}

/** One member's name among the pod's members (see `podMemberNames`). */
export function podMemberShortName(
  pod: PodView,
  sessions: ReadonlyMap<string, SessionView>,
  sessionId: string,
  start: PodMemberNameStart = "role",
): string {
  return podMemberNames(pod, sessions, [...pod.members.map((member) => member.sessionId), sessionId], start).get(sessionId)!;
}

/**
 * The pod's one badge in its bar (#2981): Closed once it is closed, Running while automatic turns
 * run or any member's turn does, and Active otherwise.
 */
export function podBadgeStatus(pod: PodView, sessions: ReadonlyMap<string, SessionView>): "active" | "running" | "closed" {
  if (pod.status === "closed") return "closed";
  if (pod.orchestration?.state.status === "running") return "running";
  return pod.members.some((member) => {
    const status = sessions.get(member.sessionId)?.status;
    return status === "running" || status === "starting";
  }) ? "running" : "active";
}

/**
 * Who wrote a huddle entry, by name (#2981): a member by role and agent ("Worker · Codex"), told
 * apart from the other members as `podMemberNames` does; a session that has left the pod by the
 * agent its entry recorded; and a person as `person` names them ("You").
 */
export function podEntrySourceName(
  entry: PodContextEntry,
  pod: PodView,
  sessions: ReadonlyMap<string, SessionView>,
  person: string,
): string {
  const source = entry.source;
  if (source.kind === "human") return person;
  if (pod.members.some((member) => member.sessionId === source.sessionId)) {
    return podMemberShortName(pod, sessions, source.sessionId, "agent");
  }
  return source.agentLabel.trim() || source.sessionTitle.trim() || "A former member";
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
