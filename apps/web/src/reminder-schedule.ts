import type { SessionReminderView } from "@wollipog/protocol";

export type ParsedReminderSchedule =
  | { scheduleKind: "timed"; scheduledFor: number; timeZone: string; originalExpression: string }
  | { scheduleKind: "someday"; originalExpression: string };

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
  "Someday",
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

/**
 * The zone every reminder time is read in: the one the Snooze dialog's helper names, this browser's.
 * A reminder saved from another zone keeps its absolute instant and its stored zone; only where it
 * is read moves, so a row's time, its tooltip and the dialog name one wall-clock time for it.
 */
export function reminderDisplayZone(): string {
  return browserTimeZone();
}

/** Why an expression does not resolve to a future schedule. */
type ReminderProblem = "unknown" | "numeric" | "zero" | "later_today" | "clock" | "date" | "past";

function normalizeExpression(expression: string): string {
  return expression.trim().toLocaleLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
}

/** A month name or its abbreviation, as typed ("dec", "Sept", "december"). */
const MONTH_EXPRESSION = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** What may follow a day: a daypart, or a clock with an optional "at" ("9am", "at 3:30 pm", "15:00"). */
const CLOCK_TAIL = "(?: (morning|afternoon|evening)|(?: at)? (\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?)?";
const MONTH_FIRST_DATE = new RegExp(`^${MONTH_EXPRESSION} (\\d{1,2})(?:st|nd|rd|th)?(?: (\\d{4}))?${CLOCK_TAIL}$`);
const DAY_FIRST_DATE = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? ${MONTH_EXPRESSION}(?: (\\d{4}))?${CLOCK_TAIL}$`);
/** The form an Exact Date and Time entry stored before #2181, which stays unambiguous. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?$/;
/** A date written in numbers only ("12/10/26"), whose day and month order is a locale's guess. */
const NUMERIC_DATE = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?(?: |$)/;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function monthIndex(typed: string): number {
  return MONTHS.findIndex((month) => month.toLocaleLowerCase().startsWith(typed.slice(0, 3)));
}

/** Deliberately small, locale-honest natural-language grammar. Free-form parsing never guesses
 * between numeric date conventions: a date is written with its month's name, or as an ISO date. */
export function parseReminderExpression(
  expression: string,
  now = new Date(),
): ParsedReminderSchedule | null {
  const resolved = resolveReminderExpression(expression, now);
  return typeof resolved === "string" ? null : resolved;
}

function resolveReminderExpression(expression: string, now: Date): ParsedReminderSchedule | ReminderProblem {
  const originalExpression = expression.trim();
  const normalized = normalizeExpression(originalExpression);
  let scheduled: Date | ReminderProblem = "unknown";
  if (normalized === "someday") return { scheduleKind: "someday", originalExpression };
  const relative = /^in (\d{1,4}) (minute|minutes|hour|hours|day|days)$/.exec(normalized);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!;
    if (amount === 0) return "zero";
    // Relative days are elapsed 24-hour periods. Calendar intent is a named date ("dec 10 9am"),
    // whose resolved absolute instant is summarized before saving.
    const multiplier = unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000;
    scheduled = new Date(now.getTime() + amount * multiplier);
  } else if (normalized === "later today") {
    scheduled = new Date(now.getTime() + 3 * 3_600_000);
    if (scheduled.toDateString() !== now.toDateString()) return "later_today";
  } else if (normalized === "tomorrow" || normalized === "tomorrow morning") {
    scheduled = new Date(now);
    scheduled.setDate(scheduled.getDate() + 1);
    scheduled.setHours(9, 0, 0, 0);
  } else if (normalized === "tomorrow afternoon") {
    scheduled = new Date(now);
    scheduled.setDate(scheduled.getDate() + 1);
    scheduled.setHours(13, 0, 0, 0);
  } else if (normalized === "this weekend") {
    scheduled = resolveWeekday(6, 9, 0, now) ?? "past";
  } else if (normalized === "next week") {
    const daysUntilNextMonday = (1 - now.getDay() + 7) % 7 || 7;
    scheduled = localCalendarInstant(now, daysUntilNextMonday, 9, 0, now) ?? "past";
  } else if (normalized === "next month") {
    const target = new Date(now.getFullYear(), now.getMonth() + 1, 1, 12);
    scheduled = firstLocalInstant(target, 9, 0, now) ?? "past";
  } else {
    const time = /^(?:today|tomorrow)(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(normalized);
    const weekday = new RegExp(`^${WEEKDAY_EXPRESSION}${CLOCK_TAIL}$`).exec(normalized);
    const monthFirst = MONTH_FIRST_DATE.exec(normalized);
    const dayFirst = DAY_FIRST_DATE.exec(normalized);
    const iso = ISO_DATE.exec(normalized);
    if (time) {
      const clock = clockTime(time[1]!, time[2], time[3]);
      if (!clock) return "clock";
      scheduled = localCalendarInstant(now, normalized.startsWith("tomorrow") ? 1 : 0, clock.hour, clock.minute, now) ?? "past";
    } else if (weekday) {
      const weekdayIndex = WEEKDAYS.findIndex(({ abbreviation }) => weekday[1]!.startsWith(abbreviation));
      const clock = clockOrDaypart(weekday[2], weekday[3], weekday[4], weekday[5]);
      if (!clock) return "clock";
      if (weekdayIndex < 0) return "unknown";
      scheduled = resolveWeekday(weekdayIndex, clock.hour, clock.minute, now) ?? "past";
    } else if (monthFirst || dayFirst) {
      // Both forms put the year and the clock in groups 3 to 7; only the month and day swap.
      const date = (monthFirst ?? dayFirst)!;
      const month = monthIndex(monthFirst ? date[1]! : date[2]!);
      const day = Number(monthFirst ? date[2] : date[1]);
      const clock = clockOrDaypart(date[4], date[5], date[6], date[7]);
      if (!clock) return "clock";
      scheduled = resolveCalendarDate(date[3] ? Number(date[3]) : undefined, month, day, clock, now);
    } else if (iso) {
      const clock = iso[4] ? clockTime(iso[4], iso[5], undefined) : { hour: 9, minute: 0 };
      if (!clock) return "clock";
      scheduled = resolveCalendarDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), clock, now);
    } else if (NUMERIC_DATE.test(normalized)) {
      return "numeric";
    }
  }
  if (typeof scheduled === "string") return scheduled;
  if (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() <= now.getTime()) return "past";
  return {
    scheduleKind: "timed",
    scheduledFor: scheduled.getTime(),
    timeZone: browserTimeZone(),
    originalExpression,
  };
}

function clockOrDaypart(
  daypart: string | undefined,
  rawHour: string | undefined,
  rawMinute: string | undefined,
  meridiem: string | undefined,
): { hour: number; minute: number } | null {
  if (rawHour) return clockTime(rawHour, rawMinute, meridiem);
  return { hour: daypart ? DAYPART_HOURS[daypart as keyof typeof DAYPART_HOURS] : 9, minute: 0 };
}

/** A named day of the year. Without a year it is the next one still ahead (February 29 included). */
function resolveCalendarDate(
  year: number | undefined,
  month: number,
  day: number,
  clock: { hour: number; minute: number },
  now: Date,
): Date | ReminderProblem {
  const exists = (candidateYear: number) => month >= 0 && day >= 1 &&
    new Date(candidateYear, month, day, 12).getMonth() === month;
  const years = year === undefined
    ? Array.from({ length: 9 }, (_, offset) => now.getFullYear() + offset)
    : [year];
  if (!years.some(exists)) return "date";
  for (const candidateYear of years.filter(exists)) {
    const instant = firstLocalInstant(new Date(candidateYear, month, day, 12), clock.hour, clock.minute, now);
    if (instant) return instant;
  }
  return "past";
}

/**
 * Why `expression` cannot be saved, as one actionable sentence for the field's error (§8.5), or
 * null when it resolves to a future schedule. A numeric date is refused with both of its readings
 * and the named form that removes the guess.
 */
export function reminderExpressionError(
  expression: string,
  now = new Date(),
  supportsSomeday = true,
): string | null {
  const original = expression.trim();
  if (!original) return "Enter when it returns, like “tomorrow 3pm”.";
  const resolved = resolveReminderExpression(original, now);
  if (typeof resolved !== "string") {
    return resolved.scheduleKind === "someday" && !supportsSomeday
      ? "Someday needs a newer version of Wollipog. Enter a time instead."
      : null;
  }
  switch (resolved) {
    case "numeric": return numericDateError(original, normalizeExpression(original));
    case "zero": return "Choose a time in the future, like “in 2 hours”.";
    case "later_today": return "Later Today has passed for today. Choose another time.";
    case "clock": return "Enter a real time of day, like “3:30pm”.";
    case "date": return `“${original}” isn't a date on the calendar. Check the day and the month.`;
    case "past": return "That time has passed. Choose a later one.";
    case "unknown": return `Wollipog can't read “${original}” as a time. Try “in 2 hours”, “tomorrow 3pm” or “dec 10 9am”.`;
  }
}

function numericDateError(original: string, normalized: string): string {
  const [, rawFirst, rawSecond] = NUMERIC_DATE.exec(normalized)!;
  const first = Number(rawFirst);
  const second = Number(rawSecond);
  const reading = (month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= 31
    ? { month: MONTHS[month - 1]!, day }
    : null;
  const monthFirst = reading(first, second);
  const dayFirst = reading(second, first);
  const example = monthFirst ?? dayFirst ?? { month: "December", day: 10 };
  const fix = `Write the month, like “${example.month.slice(0, 3)} ${example.day}”.`;
  if (monthFirst && dayFirst && first !== second) {
    return `“${original}” could be ${monthFirst.month} ${monthFirst.day} or ${dayFirst.month} ${dayFirst.day}. ${fix}`;
  }
  return `“${original}” is a date in numbers only. ${fix}`;
}

/** Complete a partially typed expression using only values accepted by the authoritative parser.
 * Keeping this beside the parser makes it difficult for autocomplete and validation to drift. */
export function suggestReminderExpressions(
  query: string,
  now = new Date(),
): ParsedReminderSchedule[] {
  const normalized = normalizeExpression(query);
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

  // A named date on its own offers the morning and the afternoon of that day ("dec 10").
  const namedDate = new RegExp(`^${MONTH_EXPRESSION} (\\d{1,2})$`).exec(normalized);
  if (namedDate) {
    const date = `${MONTHS[monthIndex(namedDate[1]!)]!} ${Number(namedDate[2])}`;
    candidates.add(`${date} at 9 AM`);
    candidates.add(`${date} at 1 PM`);
  }

  const clock = new RegExp(`^(today|tomorrow|${WEEKDAY_EXPRESSION}|${MONTH_EXPRESSION} \\d{1,2})(?:\\s+at)?\\s+(\\d{1,2})(?::(\\d{1,2}))?\\s*(a|am|p|pm)?$`).exec(normalized);
  if (clock) {
    const monthDay = new RegExp(`^${MONTH_EXPRESSION} (\\d{1,2})$`).exec(clock[1]!);
    const day = clock[1] === "today"
      ? "Today"
      : clock[1] === "tomorrow"
        ? "Tomorrow"
        : monthDay
          ? `${MONTHS[monthIndex(monthDay[1]!)]!} ${Number(monthDay[2])}`
          : WEEKDAYS.find(({ abbreviation }) => clock[1]!.startsWith(abbreviation))?.name;
    const hour = Number(clock[4]);
    const minute = clock[5] ? `:${clock[5].padStart(2, "0")}` : "";
    const typedMeridiem = clock[6];
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

/** Editing starts from the stored absolute instant. In particular, a stored expression must not be
 * reinterpreted in a browser that has moved to a different time zone. */
export function storedReminderSchedule(reminder: SessionReminderView): ParsedReminderSchedule {
  if (reminder.scheduleKind === "someday") {
    return { scheduleKind: "someday", originalExpression: reminder.originalExpression };
  }
  return {
    scheduleKind: "timed",
    scheduledFor: reminder.scheduledFor,
    timeZone: reminder.timeZone,
    originalExpression: reminder.originalExpression,
  };
}

/**
 * A snoozed row's return time, short enough for its time cell (#2209), in `timeZone`, which a row
 * passes as `reminderDisplayZone()` so it agrees with the Snooze dialog (#2218): the time alone today ("3:00 PM"), the weekday and time within the week ("Thu 9:00 AM"), and the
 * date beyond that ("Oct 12"). `formatReminderInstant()` gives the full instant for the tooltip.
 */
export function formatReminderReturn(scheduledFor: number, timeZone: string, now = Date.now()): string {
  const days = calendarDaysAhead(scheduledFor, timeZone, now);
  const time = { hour: "numeric", minute: "2-digit", timeZone } as const;
  if (days === 0) return new Intl.DateTimeFormat(undefined, time).format(new Date(scheduledFor));
  if (days > 0 && days < 7) {
    return new Intl.DateTimeFormat(undefined, { weekday: "short", ...time }).format(new Date(scheduledFor));
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone }).format(new Date(scheduledFor));
}

/** How many calendar days in `timeZone` lie between now and the instant: 0 today, 1 tomorrow. */
function calendarDaysAhead(scheduledFor: number, timeZone: string, now: number): number {
  const day = (instant: number) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone })
    .format(new Date(instant));
  return Math.round((Date.parse(day(scheduledFor)) - Date.parse(day(now))) / 86_400_000);
}

/**
 * A Snooze preset tile's second line (#2181), in the schedule's time zone: "Today, 5:00 PM" today,
 * "Sat, 9:00 AM" within the week, "Nov 1, 9:00 AM" beyond it, and "No set time" for Someday.
 */
export function formatReminderTileTime(schedule: ParsedReminderSchedule, now = Date.now()): string {
  if (schedule.scheduleKind === "someday") return "No set time";
  const { scheduledFor, timeZone } = schedule;
  const days = calendarDaysAhead(scheduledFor, timeZone, now);
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(scheduledFor));
  const time = format({ hour: "numeric", minute: "2-digit" });
  if (days === 0) return `Today, ${time}`;
  if (days > 0 && days < 7) return `${format({ weekday: "short" })}, ${time}`;
  return `${format({ month: "short", day: "numeric" })}, ${time}`;
}

/**
 * The day and time a snooze returns, for the Snooze summary (#2181): "Saturday, Sep 26 at 9:00 AM",
 * in `timeZone`, with the year only when it is not this year's.
 */
export function formatReminderReturnDay(scheduledFor: number, timeZone: string, now = Date.now()): string {
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(new Date(scheduledFor));
  const year = (instant: number) => new Intl.DateTimeFormat("en-CA", { year: "numeric", timeZone }).format(new Date(instant));
  const date = format({ month: "short", day: "numeric", ...(year(scheduledFor) !== year(now) ? { year: "numeric" } : {}) });
  const time = format({ hour: "numeric", minute: "2-digit" });
  return `${format({ weekday: "long" })}, ${date} at ${time}`;
}

/** A time zone's everyday name for the Snooze Until helper ("Eastern Time"), or its id. */
export function timeZoneDisplayName(timeZone: string, now = Date.now()): string {
  if (timeZone === "UTC" || timeZone === "Etc/UTC") return "UTC";
  try {
    const name = new Intl.DateTimeFormat(undefined, { timeZone, timeZoneName: "longGeneric" })
      .formatToParts(new Date(now))
      .find((part) => part.type === "timeZoneName")?.value;
    // An offset ("GMT+01:00") says less than the zone's own id.
    return name && !/^GMT/.test(name) ? name : timeZone;
  } catch {
    return timeZone;
  }
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
