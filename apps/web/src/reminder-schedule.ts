import type { SessionReminderView } from "@wollipog/protocol";

export interface ParsedReminderSchedule {
  scheduledFor: number;
  timeZone: string;
  originalExpression: string;
}

const REMINDER_SUGGESTION_SEEDS = [
  "Later Today",
  "Tomorrow",
  "Tomorrow Morning",
  "Tomorrow Afternoon",
  "Tomorrow at 9 AM",
  "Tomorrow at 1 PM",
  "Tomorrow at 3:30 PM",
  "In 15 Minutes",
  "In 30 Minutes",
  "In 1 Hour",
  "In 2 Hours",
  "In 1 Day",
  "In 7 Days",
] as const;

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

/** Complete a partially typed expression using only values accepted by the authoritative parser.
 * Keeping this beside the parser makes it difficult for autocomplete and validation to drift. */
export function suggestReminderExpressions(
  query: string,
  now = new Date(),
): ParsedReminderSchedule[] {
  const normalized = query.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (!normalized) return [];

  const candidates = new Set<string>(REMINDER_SUGGESTION_SEEDS);
  for (const hoursFromNow of [1, 3]) {
    const future = new Date(now.getTime() + hoursFromNow * 3_600_000);
    if (future.toDateString() !== now.toDateString()) continue;
    const hour = future.getHours() % 12 || 12;
    const minute = future.getMinutes() ? `:${String(future.getMinutes()).padStart(2, "0")}` : "";
    candidates.add(`Today at ${hour}${minute} ${future.getHours() < 12 ? "AM" : "PM"}`);
  }
  const relative = /^in\s+(\d{1,4})(?:\s+[a-z]*)?$/.exec(normalized);
  if (relative) {
    const amount = Number(relative[1]);
    candidates.add(`In ${amount} ${amount === 1 ? "Minute" : "Minutes"}`);
    candidates.add(`In ${amount} ${amount === 1 ? "Hour" : "Hours"}`);
    candidates.add(`In ${amount} ${amount === 1 ? "Day" : "Days"}`);
  }

  const clock = /^(today|tomorrow)(?:\s+at)?\s+(\d{1,2})(?::(\d{1,2}))?\s*(a|am|p|pm)?$/.exec(normalized);
  if (clock) {
    const day = clock[1] === "today" ? "Today" : "Tomorrow";
    const hour = Number(clock[2]);
    const minute = clock[3] ? `:${clock[3].padStart(2, "0")}` : "";
    const typedMeridiem = clock[4];
    const meridiems = typedMeridiem
      ? [typedMeridiem.startsWith("a") ? "AM" : "PM"]
      : hour >= 1 && hour <= 12 ? ["AM", "PM"] : [""];
    for (const meridiem of meridiems) {
      candidates.add(`${day} at ${hour}${minute}${meridiem ? ` ${meridiem}` : ""}`);
    }
  }

  const terms = normalized.split(" ");
  const suggestions: ParsedReminderSchedule[] = [];
  for (const candidate of candidates) {
    const candidateNormalized = candidate.toLocaleLowerCase();
    const candidateTerms = candidateNormalized.split(" ");
    if (candidateNormalized === normalized
      || !terms.every((term) => candidateTerms.some((candidateTerm) => candidateTerm.startsWith(term)))) continue;
    const parsed = parseReminderExpression(candidate, now);
    if (parsed) suggestions.push(parsed);
    if (suggestions.length === 6) break;
  }
  return suggestions;
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
