import type { SessionReminderView, SessionView } from "@wollipog/protocol";
import { activeFullControlCampaign, completedFullControlCampaign, sessionFollowUp, sessionWorking } from "./session-follow-up.js";
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
  /** A parent's human-owned descendant reason, visible even when its family chip is dots. */
  familyFollowUpLabel?: "Needs Your Input" | "Ready for Review";
  /** Any descendant still has work, including background jobs, blocked input, or a pending stop. */
  familyWorking?: boolean;
  /** False when unfinished descendants are blocked rather than progressing. */
  familyProgressing?: boolean;
}

/** One lifecycle or secondary badge. */
export interface SessionRowBadge {
  meta: StatusMeta;
  /** Requests behind the badge, drawn as a count inside it. */
  count?: number;
  /** The tooltip: one sentence saying what the status means, and its concrete condition. */
  title: string;
  /** Status label and request count in words. */
  ariaLabel: string;
}

/** Lifecycle, one secondary badge, and additional actionable conditions for rows and cards. */
export interface SessionRowStatus {
  /** Null when no secondary condition adds to the lifecycle. */
  badge: SessionRowBadge | null;
  lifecycle: SessionRowBadge;
  /** The other kinds that need the person, in rank order: the "+N" and its tooltip. */
  others: readonly string[];
  details: string;
}

function requests(count: number): string {
  return `${count} ${count === 1 ? "Request" : "Requests"}`;
}

function conditionName(condition: SessionCondition): string {
  return condition.count === undefined ? condition.meta.label : `${condition.meta.label}, ${requests(condition.count)}`;
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

/** Lifecycle stays visible; choose one secondary from requests, recovery and passive context. */
export function sessionRowStatus(session: SessionStatusSource, context: SessionRowStatusContext = {}): SessionRowStatus {
  const { reminder } = context;
  const summary = sessionStatusSummary(session, { runnerOnline: context.runnerOnline, familyWorking: context.familyWorking });
  const needs = summary.conditions.filter((condition) => condition.needsYou && !(session.status === "input_required" && condition.attentionKind === "input_required"));
  const snoozed = reminder?.state === "pending" ? snoozedCondition(session, needs) : null;
  if (snoozed) needs.push(snoozed);

  let secondary: SessionCondition | null = needs[0] ?? summary.secondary ?? summary.primary;
  if (secondary.kind === "lifecycle") {
    if (reminder?.state === "fired") {
      secondary = {
        kind: "lifecycle",
        meta: { ...statusMeta("session", "snoozed"), label: reminderBadgeLabel(reminder) },
        description: reminderBadgeDescription(reminder),
        needsYou: false,
      };
    } else if (secondary.meta.label === statusMeta("session", "idle").label) {
      secondary = null;
    }
  }
  if ((!secondary || (secondary.kind === "lifecycle" && secondary.meta.tone !== "danger" && !session.stopOperation)) &&
      needs.length === 0 && reminder?.state !== "fired" &&
      session.attention && sessionFollowUp(session as SessionView, { familyWorking: context.familyWorking }).group === "ready_for_review") {
    secondary = { kind: "lifecycle", meta: statusMeta("session", "ready_for_review"),
      description: "A new result is waiting for your assessment or next instructions.", needsYou: true };
  } else if ((!secondary || (secondary.kind === "lifecycle" && secondary.meta.label === statusMeta("session", "completed").label)) &&
      !session.stopOperation && needs.length === 0 && reminder?.state !== "fired" && !context.familyWorking &&
      !sessionWorking(session as SessionView) && completedFullControlCampaign(session)) {
    secondary = { kind: "lifecycle", meta: statusMeta("session", "campaign_complete"),
      description: "This Full Control campaign finished and the server verified it. Its result is informational.", needsYou: false };
  } else if ((!secondary || (secondary.kind === "lifecycle" && secondary.meta.label === statusMeta("session", "completed").label)) &&
      !session.stopOperation && needs.length === 0 && reminder?.state !== "fired" && !context.familyWorking &&
      !sessionWorking(session as SessionView) && activeFullControlCampaign(session)) {
    secondary = { kind: "lifecycle", meta: statusMeta("session", "campaign_active"),
      description: "This Full Control campaign continues automatically. Its intermediate results are informational.", needsYou: false };
  }
  const others = needs.slice(1).map(conditionName);
  const familyLabel = context.familyFollowUpLabel;
  if (familyLabel && secondary?.meta.label !== familyLabel && needs.every((condition) => condition.kind === "follow_up") &&
      (familyLabel === "Needs Your Input" || (!context.familyWorking && !sessionWorking(session as SessionView))) &&
      (familyLabel === "Needs Your Input" ? 3 : 2) >= sessionFollowUp(session as SessionView).priority) {
    const previous = secondary;
    if (previous?.needsYou && previous.meta.label !== familyLabel) others.push(conditionName(previous));
    const keepPrevious = previous && previous.meta.label !== familyLabel &&
      (previous.kind !== "lifecycle" || previous.meta.tone === "danger" || previous.needsYou || session.stopOperation ||
        reminder?.state === "fired");
    const description = familyLabel === "Needs Your Input"
      ? "A session in this family is waiting for your input."
      : "A result in this family is waiting for your assessment or next instructions.";
    const familyMeta = familyLabel === "Needs Your Input"
      ? statusMeta("attention", "input_required") : statusMeta("session", "ready_for_review");
    secondary = { kind: "lifecycle", meta: { ...familyMeta,
      tone: keepPrevious && previous.meta.tone === "danger" ? "danger" : familyMeta.tone },
      description: keepPrevious ? `${description} ${previous.description}` : description, needsYou: true };
  }
  if (context.familyWorking && needs.length === 0 && !sessionWorking(session as SessionView) &&
      (!secondary || (secondary.kind === "lifecycle" && !secondary.needsYou && secondary.meta.tone !== "danger" &&
        !session.stopOperation && reminder?.state !== "fired"))) {
    secondary = { kind: "lifecycle", meta: statusMeta("session", context.familyProgressing === false ? "children_pending" : "children_working"),
      description: "Child sessions still have unfinished work.", needsYou: false };
  }
  const lifecycle = { meta: summary.primary.meta, title: summary.primary.description,
    ariaLabel: `Status: ${conditionName(summary.primary)}` };
  const badge = secondary && secondary !== summary.primary && secondary.meta.label !== lifecycle.meta.label
    ? { meta: secondary.meta, count: secondary.count, title: secondary.description, ariaLabel: `Status: ${conditionName(secondary)}` } : null;
  const details = [...new Set([...summary.conditions.map((condition) => condition.meta.label + ": " + condition.description), ...(badge ? [badge.title] : [])])].join("\n");
  return { lifecycle, badge, others, details };
}
