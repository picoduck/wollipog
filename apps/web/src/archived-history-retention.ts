import type {
  ArchivedHistoryRetentionCounts,
  ArchivedHistoryRetentionView,
  SessionHistoryPruned,
  SessionView,
} from "@wollipog/protocol";

/**
 * Copy and arithmetic for archived-history retention (#2777, docs/archived-history-retention.md):
 * Settings › Storage, the archive's History Pruned badge, a pruned transcript's notice, and the
 * Session Archived notice's prune date.
 */

const DAY_MS = 24 * 60 * 60_000;

export const RETENTION_NO_PERMISSION = "Only an organization owner or admin can change this.";
export const RETENTION_UNSUPPORTED = "Update Wollipog to change this setting.";
export const RETENTION_LOAD_FAILED = "Couldn't load archived history retention. Try again.";
export const RETENTION_SAVE_FAILED = "Archived history retention wasn't saved. Try again.";

/** What a prune removes and keeps, in one sentence each, for the notice and the settings. */
export const PRUNED_CONTENT = "tool calls and their output, file edits, reasoning, and intermediate messages";
export const KEPT_CONTENT = "Prompts, the final response, usage and cost, and attachments are kept.";

export function formatRetentionDate(at: number, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", ...(timeZone ? { timeZone } : {}) }).format(new Date(at));
}

export function formatRetentionDateTime(at: number, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) })
    .format(new Date(at));
}

function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
}

export function retentionDaysLabel(days: number): string {
  return count(days, "day", "days");
}

/** "3 sessions, about 12,400 events", or "None". The event count is approximate: it includes the
 * few events a prune keeps. */
export function retentionCountsLabel(counts: ArchivedHistoryRetentionCounts): string {
  if (counts.sessions === 0) return "None";
  return `${count(counts.sessions, "session", "sessions")}, about ${count(counts.events, "event", "events")}`;
}

/** Whole days from the limits, or null for anything else ("", "9.5", "6"). */
export function parseRetentionDays(text: string, limits: ArchivedHistoryRetentionView["limits"]): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const days = Number(trimmed);
  return Number.isSafeInteger(days) && days >= limits.minDays && days <= limits.maxDays ? days : null;
}

export function retentionDaysError(limits: ArchivedHistoryRetentionView["limits"]): string {
  return `Enter a whole number of days from ${limits.minDays} to ${limits.maxDays.toLocaleString("en-US")}.`;
}

/** Whether saving `days` would prune more than the current policy does, so it needs confirming. */
export function retentionChangePrunesMore(current: number | null, days: number | null): boolean {
  return days !== null && (current === null || days < current);
}

/** The switch's sentence under its title. */
export function retentionSwitchDescription(view: Pick<ArchivedHistoryRetentionView, "retentionDays">): string {
  return view.retentionDays === null
    ? "Archived sessions keep their full history."
    : `Archived sessions lose most of their history ${retentionDaysLabel(view.retentionDays)} after archiving.`;
}

/** Where the policy in effect comes from, when it is not the organization's own saved choice. */
export function retentionSourceSentence(
  view: Pick<ArchivedHistoryRetentionView, "source" | "environmentDays">,
): string | null {
  if (view.source === "environment" && view.environmentDays !== null) {
    return `This control plane's environment sets ${retentionDaysLabel(view.environmentDays)}. Saving here overrides it for this organization.`;
  }
  return null;
}

/** When pruning runs next, for the Eligible Now row: the delay after turning it on, or the next pass. */
export function retentionScheduleSentence(
  view: Pick<ArchivedHistoryRetentionView, "retentionDays" | "prunesFrom" | "nextRunAt">,
  now: number,
  locale?: string,
  timeZone?: string,
): string | undefined {
  if (view.retentionDays === null || view.prunesFrom === null) return undefined;
  if (view.prunesFrom > now) return `Pruning starts ${formatRetentionDateTime(view.prunesFrom, locale, timeZone)}.`;
  if (view.nextRunAt !== null) return `Next pass ${formatRetentionDateTime(view.nextRunAt, locale, timeZone)}.`;
  return undefined;
}

/** The Last Pass row: when, as its sentence, and what it pruned, as its value. */
export function retentionLastRun(
  lastRun: NonNullable<ArchivedHistoryRetentionView["lastRun"]>,
  locale?: string,
  timeZone?: string,
): { when: string; pruned: string } {
  return {
    when: `Finished ${formatRetentionDateTime(lastRun.finishedAt, locale, timeZone)}.`,
    pruned: lastRun.sessions === 0
      ? "Nothing to prune"
      : `${count(lastRun.sessions, "session", "sessions")}, ${count(lastRun.events, "event", "events")}`,
  };
}

/** The confirmation for turning retention on or shortening it (§7.4). */
export function retentionConfirmation(
  current: number | null,
  preview: NonNullable<ArchivedHistoryRetentionView["preview"]>,
  locale?: string,
  timeZone?: string,
): { title: string; message: string; confirmLabel: string; detailRows: Array<{ label: string; meta: string }> } {
  const turningOn = current === null;
  return {
    title: turningOn ? "Prune Archived History" : "Shorten History Retention",
    message: `History of sessions archived more than ${retentionDaysLabel(preview.retentionDays)} ago is permanently `
      + `removed from this control plane, starting ${formatRetentionDateTime(preview.prunesFrom, locale, timeZone)}. `
      + `${KEPT_CONTENT} This cannot be undone here.`,
    confirmLabel: turningOn ? "Prune History" : "Shorten Retention",
    detailRows: [
      { label: "Sessions to Prune", meta: preview.eligible.sessions.toLocaleString("en-US") },
      { label: "Events to Remove (Approx.)", meta: preview.eligible.events.toLocaleString("en-US") },
    ],
  };
}

/** The History Pruned notice's one line above a pruned transcript: how much went, and when. */
export function historyPrunedSummary(pruned: SessionHistoryPruned, locale?: string, timeZone?: string): string {
  return `${count(pruned.eventCount, "event", "events")} removed ${formatRetentionDate(pruned.prunedAt, locale, timeZone)}.`;
}

/** The notice's details: under which policy, what kind of events went, and what was kept. */
export function historyPrunedDetails(pruned: SessionHistoryPruned): string {
  return `The retention policy for sessions archived more than ${retentionDaysLabel(pruned.retentionDays)} removed `
    + `${PRUNED_CONTENT}. ${KEPT_CONTENT}`;
}

/** The History Pruned badge's tooltip in the archive. */
export function historyPrunedTitle(pruned: SessionHistoryPruned, locale?: string, timeZone?: string): string {
  return `Pruned ${formatRetentionDate(pruned.prunedAt, locale, timeZone)} by the `
    + `${pruned.retentionDays.toLocaleString("en-US")}-day retention policy`;
}

/** When an archived session's history will be pruned under the policy, or null when it will not
 * be: retention is off, the session is not archived, or it was already pruned. A session already
 * past its threshold goes at the next pass, and never on a date that has gone by, even when a cached
 * policy's next pass has. */
export function historyPrunesAt(
  session: Pick<SessionView, "archived" | "archivedAt" | "historyPruned">,
  view: Pick<ArchivedHistoryRetentionView, "retentionDays" | "prunesFrom" | "nextRunAt"> | null,
  now = Date.now(),
): number | null {
  if (!view || view.retentionDays === null || view.prunesFrom === null) return null;
  if (!session.archived || session.archivedAt === undefined || session.historyPruned) return null;
  return Math.max(session.archivedAt + view.retentionDays * DAY_MS, view.prunesFrom, view.nextRunAt ?? 0, now);
}
