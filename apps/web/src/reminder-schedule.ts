import type { SessionReminderView } from "@wollipog/protocol";

export interface ParsedReminderSchedule {
  scheduledFor: number;
  timeZone: string;
  originalExpression: string;
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Deliberately small, locale-honest natural-language grammar. Free-form parsing never guesses
 * between numeric date conventions; exact datetime-local entry handles locale-specific dates. */
export function parseReminderExpression(
  expression: string,
  now = new Date(),
): ParsedReminderSchedule | null {
  const originalExpression = expression.trim();
  const normalized = originalExpression.toLocaleLowerCase().replace(/\s+/g, " ");
  let scheduled: Date | null = null;
  const relative = /^in (\d{1,4}) (minute|minutes|hour|hours|day|days)$/.exec(normalized);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!;
    // Relative days are elapsed 24-hour periods. Calendar/DST-sensitive intent belongs in the
    // exact local date/time field, whose resolved absolute instant is previewed before saving.
    const multiplier = unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000;
    scheduled = new Date(now.getTime() + amount * multiplier);
  } else if (normalized === "later today") {
    scheduled = new Date(now.getTime() + 3 * 3_600_000);
    if (scheduled.toDateString() !== now.toDateString()) return null;
  } else if (normalized === "tomorrow" || normalized === "tomorrow morning") {
    scheduled = new Date(now);
    scheduled.setDate(scheduled.getDate() + 1);
    scheduled.setHours(9, 0, 0, 0);
  } else if (normalized === "tomorrow afternoon") {
    scheduled = new Date(now);
    scheduled.setDate(scheduled.getDate() + 1);
    scheduled.setHours(13, 0, 0, 0);
  } else {
    const time = /^(?:today|tomorrow)(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(normalized);
    if (time) {
      let hour = Number(time[1]);
      const minute = Number(time[2] ?? 0);
      if (hour > 23 || minute > 59 || (time[3] && (hour < 1 || hour > 12))) return null;
      if (time[3] === "pm" && hour < 12) hour += 12;
      if (time[3] === "am" && hour === 12) hour = 0;
      scheduled = new Date(now);
      if (normalized.startsWith("tomorrow")) scheduled.setDate(scheduled.getDate() + 1);
      scheduled.setHours(hour, minute, 0, 0);
      if (normalized.startsWith("today") && scheduled.getTime() <= now.getTime()) return null;
    }
  }
  if (!scheduled || !Number.isFinite(scheduled.getTime()) || scheduled.getTime() <= now.getTime()) return null;
  return { scheduledFor: scheduled.getTime(), timeZone: browserTimeZone(), originalExpression };
}

/** A datetime-local control is interpreted by the browser runtime. Persist that runtime's zone
 * beside the resolved instant so later rendering does not silently reinterpret the user's choice. */
export function exactReminderSchedule(
  localDateTime: string,
  now = Date.now(),
): ParsedReminderSchedule | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localDateTime)) return null;
  const instant = new Date(localDateTime);
  if (!Number.isFinite(instant.getTime()) || instant.getTime() <= now) return null;
  return { scheduledFor: instant.getTime(), timeZone: browserTimeZone(), originalExpression: localDateTime };
}

/** Editing starts from the stored absolute instant. In particular, a datetime-local expression
 * must not be reinterpreted in a browser that has moved to a different time zone. */
export function storedReminderSchedule(reminder: SessionReminderView): ParsedReminderSchedule {
  return {
    scheduledFor: reminder.scheduledFor,
    timeZone: reminder.timeZone,
    originalExpression: reminder.originalExpression,
  };
}

export function formatReminderInstant(scheduledFor: number, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(scheduledFor));
}
