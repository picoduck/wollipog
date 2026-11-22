import type { AssistantThread, RunnerView } from "@wollipog/protocol";
import { compareSessionNotices, SESSION_NOTICE_RANK } from "./components/SessionNoticeSlot.js";
import type { ConnState } from "./store.js";
import { statusMeta } from "./status-meta.js";

const problems = [
  ["tools_unavailable", SESSION_NOTICE_RANK.assistantToolsUnavailable, "Assistant Tools Unavailable"],
  ["sign_in_needed", SESSION_NOTICE_RANK.assistantSignInNeeded, "Sign In Needed"],
  ["turn_failed", SESSION_NOTICE_RANK.assistantTurnFailed, "Turn Failed"],
  ["turn_rejected", SESSION_NOTICE_RANK.assistantTurnFailed, "Provider Rejected the Turn"],
  ["usage_limit", SESSION_NOTICE_RANK.assistantUsageLimit, "Account at Its Usage Limit"],
  ["automatic_turns_held", SESSION_NOTICE_RANK.assistantAutomaticTurnsHeld, "Automatic Turns Held"],
  ["machine_offline", SESSION_NOTICE_RANK.assistantMachineOffline, "Machine Offline"],
  ["reconnecting", SESSION_NOTICE_RANK.assistantReconnecting, "Reconnecting to Wollipog…"],
] as const;

export function assistantThreadProblems(
  thread: AssistantThread, connection: ConnState, runner?: Pick<RunnerView, "status">,
) {
  const health = thread.health;
  if (!health || thread.status === "archived" || connection === "unauthorized") return [];
  const active = {
    tools_unavailable: health.toolsUnavailable,
    sign_in_needed: health.signInNeeded,
    turn_failed: health.turn?.kind === "failed",
    turn_rejected: health.turn?.kind === "rejected",
    usage_limit: health.usageLimit,
    automatic_turns_held: health.automaticTurnsHeld,
    machine_offline: runner?.status === "offline",
    reconnecting: connection === "offline" || connection === "connecting",
  };
  return problems.filter(([key]) => active[key]).map(([key, rank, title]) => {
    const badge = statusMeta("assistantThreadHealth", key);
    return { key, rank, title, badge, severity: badge.tone as "danger" | "warning" | "info" };
  }).sort(compareSessionNotices);
}

export type AssistantThreadProblem = ReturnType<typeof assistantThreadProblems>[number];
