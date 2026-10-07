import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { sessionFollowUp } from "./session-follow-up.js";
import { reminderBadgeDescription, reminderBadgeLabel, snoozedSessionAttentionReason } from "./session-reminders.js";
import {
  sessionStatusSummary,
  statusMeta,
  type SessionCondition,
  type SessionStatusSource,
  type StatusMeta,
} from "./status-meta.js";

/** What a list row or Board card knows about a session beyond the record itself. */
export interface SessionRowStatusContext {
  /** The session's machine is connected. Unknown counts as connected. */
  runnerOnline?: boolean;
  /** The session's reminder: a pending one lets its snoozed attention count, a fired one says Returned. */
  reminder?: SessionReminderView;
  /** How long a stalled session has been silent, in milliseconds; absent while it is not stalled. */
  stalledForMs?: number;
}

/** The one badge a row draws. */
export interface SessionRowBadge {
  meta: StatusMeta;
  /** Requests behind the badge, drawn as a count inside it. */
  count?: number;
  /** The tooltip: one sentence saying what the status means, and how long a stalled session has been silent. */
  title: string;
  /** "Status: <label>", with the request count in words and ", Stalled" for a stalled session. */
  ariaLabel: string;
}

/** A row's one status (#2209): the badge, or none, and the other things that need the person. */
export interface SessionRowStatus {
  /** Null for a session Awaiting Prompt with nothing else to say: idle rows show no badge. */
  badge: SessionRowBadge | null;
  /** The other kinds that need the person, in rank order: the "+N" and its tooltip. */
  others: readonly string[];
}

function requests(count: number): string {
  return `${count} ${count === 1 ? "Request" : "Requests"}`;
}

function conditionName(condition: SessionCondition): string {
  return condition.count === undefined ? condition.meta.label : `${condition.meta.label}, ${requests(condition.count)}`;
}

/** "14 minutes", "2 hours": how long a stalled session has been silent, in its tooltip. */
export function silenceDuration(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** The snoozed-attention reason a pending reminder keeps visible that the ranking does not already hold. */
function snoozedCondition(session: SessionStatusSource, needs: readonly SessionCondition[]): SessionCondition | null {
  const reason = snoozedSessionAttentionReason(session as SessionView);
  if (reason?.kind !== "background_delivery_watchdog") return null;
  if (needs.some((condition) => condition.kind === "background_delivery")) return null;
  return {
    kind: "background_delivery",
    meta: { label: reason.label, tone: reason.severity === "pending" ? "info" : "warning", pulse: false },
    description: reason.description,
    needsYou: true,
  };
}

/**
 * Which one status a Sessions row (and a Board card) shows (#2209), on #2182's ranking so the session
 * bar, the preview and the row agree:
 *
 * 1. The top kind that needs the person, with a neutral "+N" for the other kinds. A snoozed session's
 *    attention reasons count among them.
 * 2. Else Background Work Lost, Disconnected, then Waiting on External Job (`sessionStatusSummary()`).
 * 3. Else a fired reminder's Returned.
 * 4. Else an outstanding human result's Ready for Review.
 * 5. Else the lifecycle status, except Awaiting Prompt, which shows no badge.
 *
 * Stalled is not a second badge: a stalled session's badge takes the danger tone, stops pulsing, and
 * its tooltip says how long the session has been silent.
 */
export function sessionRowStatus(session: SessionStatusSource, context: SessionRowStatusContext = {}): SessionRowStatus {
  const { reminder, stalledForMs } = context;
  const summary = sessionStatusSummary(session, { runnerOnline: context.runnerOnline });
  const needs = summary.conditions.filter((condition) => condition.needsYou);
  const snoozed = reminder?.state === "pending" ? snoozedCondition(session, needs) : null;
  if (snoozed) needs.push(snoozed);

  let primary: SessionCondition | null = needs[0] ?? summary.primary;
  if (primary.kind === "lifecycle") {
    if (reminder?.state === "fired") {
      primary = {
        kind: "lifecycle",
        meta: { ...statusMeta("session", "snoozed"), label: reminderBadgeLabel(reminder) },
        description: reminderBadgeDescription(reminder),
        needsYou: false,
      };
    } else if (primary.meta.label === statusMeta("session", "idle").label) {
      primary = null;
    }
  }
  if ((!primary || (primary.kind === "lifecycle" && primary.meta.tone !== "danger" && !session.stopOperation)) &&
      needs.length === 0 && reminder?.state !== "fired" &&
      session.attention && sessionFollowUp(session as SessionView).group === "ready_for_review") {
    primary = { kind: "lifecycle", meta: { label: "Ready for Review", tone: "warning", pulse: false },
      description: "A new result is waiting for your assessment or next instructions.", needsYou: true };
  }
  const others = needs.slice(1).map(conditionName);
  if (!primary) return { badge: null, others };

  const stalled = stalledForMs !== undefined;
  const silence = stalled ? silenceDuration(stalledForMs) : "";
  return {
    badge: {
      meta: stalled ? { ...primary.meta, tone: "danger", pulse: false } : primary.meta,
      count: primary.count,
      title: stalled ? `${primary.description} Stalled: no activity for ${silence}.` : primary.description,
      ariaLabel: `Status: ${conditionName(primary)}${stalled ? ", Stalled" : ""}`,
    },
    others,
  };
}
