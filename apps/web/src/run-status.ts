import { sessionAttentionBreakdown, type RunView, type SessionView } from "@wollipog/protocol";
import { statusMeta, type StatusValue } from "./status-meta.js";

export type RunStatus = StatusValue<"run">;

/** The comparison needs attention first, then indicates whether any member is working. */
export function runStatus(
  run: Pick<RunView, "sessionIds">,
  sessions: ReadonlyMap<string, SessionView>,
): RunStatus | null {
  const members = run.sessionIds.flatMap((id) => sessions.get(id) ?? []);
  if (members.some((member) => sessionAttentionBreakdown(member).length > 0)) return "approval_required";
  if (members.some((member) => statusMeta("session", member.status).pulse)) return "running";
  return null;
}
