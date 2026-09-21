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
  "This Weekend",
  "Next Week",
  "Next Month",
] as const;

const WEEKDAYS = [
  { name: "Sunday", abbreviation: "sun" },
  { name: "Monday", abbreviation: "mon" },
  { name: "Tuesday", abbreviation: "tue" },
  { name: "Wednesday", abbreviation: "wed" },
  { name: "Thursday", abbreviation: "thu" },
  { name: "Friday", abbreviation: "fri" },
  { name: "Saturday", abbreviation: "sat" },
] as const;

const DAYPART_HOURS = {
  morning: 9,
  afternoon: 13,
  evening: 18,
} as const;

const WEEKDAY_EXPRESSION = "(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)";

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
  } else if (normalized === "this weekend") {
    scheduled = resolveWeekday(6, 9, 0, now);
  } else if (normalized === "next week") {
    const daysUntilNextMonday = (1 - now.getDay() + 7) % 7 || 7;
    scheduled = localCalendarInstant(now, daysUntilNextMonday, 9, 0, now);
  } else if (normalized === "next month") {
    const target = new Date(now.getFullYear(), now.getMonth() + 1, 1, 12);
    scheduled = firstLocalInstant(target, 9, 0, now);
  } else {
    const time = /^(?:today|tomorrow)(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(normalized);
    if (time) {
      const clock = clockTime(time[1]!, time[2], time[3]);
      if (!clock) return null;
      scheduled = localCalendarInstant(now, normalized.startsWith("tomorrow") ? 1 : 0, clock.hour, clock.minute, now);
    } else {
      const weekday = new RegExp(`^${WEEKDAY_EXPRESSION}(?: (morning|afternoon|evening)|(?: at)? (\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?)?$`).exec(normalized);
      if (weekday) {
        const weekdayIndex = WEEKDAYS.findIndex(({ abbreviation }) => weekday[1]!.startsWith(abbreviation));
        const daypart = weekday[2] as keyof typeof DAYPART_HOURS | undefined;
        const clock = weekday[3]
          ? clockTime(weekday[3], weekday[4], weekday[5])
          : { hour: daypart ? DAYPART_HOURS[daypart] : 9, minute: 0 };
        if (!clock || weekdayIndex < 0) return null;
        scheduled = resolveWeekday(weekdayIndex, clock.hour, clock.minute, now);
      }
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
  for (const { name } of WEEKDAYS) {
    candidates.add(name);
    candidates.add(`${name} Morning`);
    candidates.add(`${name} Afternoon`);
    candidates.add(`${name} Evening`);
    candidates.add(`${name} at 9 AM`);
    candidates.add(`${name} at 3:30 PM`);
  }
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

  const clock = new RegExp(`^(today|tomorrow|${WEEKDAY_EXPRESSION})(?:\\s+at)?\\s+(\\d{1,2})(?::(\\d{1,2}))?\\s*(a|am|p|pm)?$`).exec(normalized);
  if (clock) {
    const day = clock[1] === "today"
      ? "Today"
      : clock[1] === "tomorrow"
        ? "Tomorrow"
        : WEEKDAYS.find(({ abbreviation }) => clock[1]!.startsWith(abbreviation))?.name;
    const hour = Number(clock[3]);
    const minute = clock[4] ? `:${clock[4].padStart(2, "0")}` : "";
    const typedMeridiem = clock[5];
    const meridiems = typedMeridiem
      ? [typedMeridiem.startsWith("a") ? "AM" : "PM"]
      : hour >= 1 && hour <= 12 ? ["AM", "PM"] : [""];
    for (const meridiem of day ? meridiems : []) {
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

function clockTime(
  rawHour: string,
  rawMinute: string | undefined,
  meridiem: string | undefined,
): { hour: number; minute: number } | null {
  let hour = Number(rawHour);
  const minute = Number(rawMinute ?? 0);
  if (hour > 23 || minute > 59 || (meridiem && (hour < 1 || hour > 12))) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

function localCalendarInstant(
  now: Date,
  daysFromToday: number,
  hour: number,
  minute: number,
  notBefore: Date,
): Date | null {
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromToday, 12);
  return firstLocalInstant(target, hour, minute, notBefore);
}

/** Find the first real instant for a local wall time. Checking nearby instants distinguishes a
 * spring-forward gap from a normalized Date and exposes both fall-back occurrences. */
function firstLocalInstant(target: Date, hour: number, minute: number, notBefore: Date): Date | null {
  const year = target.getFullYear();
  const month = target.getMonth();
  const day = target.getDate();
  const normalized = new Date(year, month, day, hour, minute, 0, 0).getTime();
  const matches = new Set<number>();
  for (let deltaMinutes = -180; deltaMinutes <= 180; deltaMinutes += 30) {
    const candidate = new Date(normalized + deltaMinutes * 60_000);
    if (candidate.getFullYear() === year
      && candidate.getMonth() === month
      && candidate.getDate() === day
      && candidate.getHours() === hour
      && candidate.getMinutes() === minute) matches.add(candidate.getTime());
  }
  const instant = [...matches].sort((left, right) => left - right)
    .find((candidate) => candidate > notBefore.getTime());
  return instant === undefined ? null : new Date(instant);
}

function resolveWeekday(weekday: number, hour: number, minute: number, now: Date): Date | null {
  const daysAhead = (weekday - now.getDay() + 7) % 7;
  const currentWeek = localCalendarInstant(now, daysAhead, hour, minute, now);
  if (currentWeek) return currentWeek;
  return localCalendarInstant(now, daysAhead + 7, hour, minute, now);
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
