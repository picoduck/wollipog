const FIELD_COUNT = 5;
const MAX_EXPRESSION_LENGTH = 128;
const SEARCH_DAYS = 366 * 5;

interface CronField {
  values: number[];
  wildcard: boolean;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseNumber(raw: string, min: number, max: number, sundayAlias = false): number {
  if (!/^\d+$/.test(raw)) throw new Error(`invalid cron value '${raw}'`);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > (sundayAlias ? 7 : max)) {
    throw new Error(`cron value '${raw}' must be between ${min} and ${sundayAlias ? 7 : max}`);
  }
  return sundayAlias && parsed === 7 ? 0 : parsed;
}

function parseField(raw: string, min: number, max: number, sundayAlias = false): CronField {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (!part) throw new Error("cron fields cannot contain empty list entries");
    const [base, stepRaw, ...extra] = part.split("/");
    if (extra.length || !base) throw new Error(`invalid cron field '${raw}'`);
    const step = stepRaw === undefined ? 1 : parseNumber(stepRaw, 1, max - min + 1);
    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const pieces = base.split("-");
      if (pieces.length !== 2) throw new Error(`invalid cron range '${base}'`);
      // Preserve 7 until after range expansion so `5-7` means Friday through Sunday instead of
      // appearing to be a descending `5-0` range.
      start = parseNumber(pieces[0]!, min, sundayAlias ? 7 : max);
      end = parseNumber(pieces[1]!, min, sundayAlias ? 7 : max);
      if (start > end) throw new Error(`cron range '${base}' must be ascending`);
    } else {
      start = parseNumber(base, min, max, sundayAlias);
      end = stepRaw === undefined ? start : max;
    }
    for (let value = start; value <= end; value += step) values.add(sundayAlias && value === 7 ? 0 : value);
  }
  if (!values.size) throw new Error(`cron field '${raw}' selects no values`);
  const sorted = [...values].sort((a, b) => a - b);
  const wildcard = sorted.length === max - min + 1 && sorted.every((value, index) => value === min + index);
  return { values: sorted, wildcard };
}

export function parseCron(expression: string): ParsedCron {
  const normalized = expression.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(`cron expression must contain 1-${MAX_EXPRESSION_LENGTH} characters`);
  }
  const fields = normalized.split(" ");
  if (fields.length !== FIELD_COUNT) throw new Error("cron expression must contain exactly five fields");
  return {
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dayOfMonth: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12),
    dayOfWeek: parseField(fields[4]!, 0, 6, true),
  };
}

export function validateTimeZone(timezone: string): string {
  const normalized = timezone.trim();
  if (!normalized || normalized.length > 128) throw new Error("timezone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(0);
  } catch {
    throw new Error(`unknown IANA timezone '${normalized}'`);
  }
  return normalized;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timezone, value);
  }
  return value;
}

function localParts(epoch: number, timezone: string): LocalParts {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(epoch)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!,
  };
}

function sameLocal(left: LocalParts, right: LocalParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute;
}

/** Convert one local wall-clock minute to an instant. The final equality check rejects spring-DST
 * gaps; repeated fall-back minutes intentionally resolve to one instant, matching once-per-wall-time cron semantics. */
function localEpoch(parts: LocalParts, timezone: string): number | null {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = localParts(guess, timezone);
    const observedUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute);
    const delta = desired - observedUtc;
    if (delta === 0) return sameLocal(observed, parts) ? guess : null;
    guess += delta;
  }
  return sameLocal(localParts(guess, timezone), parts) ? guess : null;
}

function dayMatches(parsed: ParsedCron, year: number, month: number, day: number): boolean {
  const dom = parsed.dayOfMonth.values.includes(day);
  const dow = parsed.dayOfWeek.values.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  if (parsed.dayOfMonth.wildcard && parsed.dayOfWeek.wildcard) return true;
  if (parsed.dayOfMonth.wildcard) return dow;
  if (parsed.dayOfWeek.wildcard) return dom;
  return dom || dow;
}

export function nextCronFire(expression: string | ParsedCron, timezone: string, after: number): number {
  if (!Number.isFinite(after) || after < 0) throw new Error("cron cursor must be a non-negative epoch");
  const parsed = typeof expression === "string" ? parseCron(expression) : expression;
  const zone = validateTimeZone(timezone);
  const start = localParts(after, zone);
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day));
  let best: number | null = null;
  for (let offset = 0; offset < SEARCH_DAYS; offset += 1) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    if (parsed.month.values.includes(month) && dayMatches(parsed, year, month, day)) {
      for (const hour of parsed.hour.values) {
        for (const minute of parsed.minute.values) {
          const epoch = localEpoch({ year, month, day, hour, minute }, zone);
          if (epoch !== null && epoch > after && (best === null || epoch < best)) best = epoch;
        }
      }
      if (best !== null) return best;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  throw new Error("cron expression has no fire time within five years");
}
