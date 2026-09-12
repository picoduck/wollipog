const FIELD_COUNT = 5;
const MAX_EXPRESSION_LENGTH = 128;
const SEARCH_DAYS = 366 * 5;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const OFFSET_WINDOW_MS = 24 * HOUR_MS;
const MAX_OFFSET_MODELS = 512;
// These process-wide caches deliberately trade occasional Intl reconstruction for fixed storage.
// Map insertion order is the LRU order; hits move entries to the tail before capacity eviction.
const MAX_VALIDATED_TIMEZONES = 128;
const MAX_TIMEZONE_FORMATTERS = 128;
const validatedTimezones = new Map<string, string>();

function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value!);
}

function timezoneCacheKey(timezone: string): string {
  // IANA identifiers are ASCII and Intl accepts them case-insensitively. Folding the cache key
  // makes accepted case variants share validation, formatter, and offset-model entries. Limit the
  // fold to ASCII so Unicode lookalikes cannot collide with a previously validated identifier.
  return timezone.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

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
  const key = timezoneCacheKey(normalized);
  const cached = lruGet(validatedTimezones, key);
  if (cached) return cached;
  let canonical: string;
  try {
    // This runtime identity is only for internal cache/scheduling reuse. Persist the user's input;
    // IANA alias canonicalization can vary with the JavaScript runtime and its timezone database.
    canonical = new Intl.DateTimeFormat("en-US", { timeZone: normalized }).resolvedOptions().timeZone;
  } catch {
    throw new Error(`unknown IANA timezone '${normalized}'`);
  }
  lruSet(validatedTimezones, key, canonical, MAX_VALIDATED_TIMEZONES);
  return canonical;
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
  const key = timezoneCacheKey(timezone);
  let value = lruGet(formatters, key);
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
    lruSet(formatters, key, value, MAX_TIMEZONE_FORMATTERS);
  }
  return value;
}

export function resetTimezoneCachesForTests(): void {
  validatedTimezones.clear();
  formatters.clear();
}

export function timezoneCacheStateForTests(): {
  validationEntries: number;
  formatterEntries: number;
  maxValidationEntries: number;
  maxFormatterEntries: number;
} {
  return {
    validationEntries: validatedTimezones.size,
    formatterEntries: formatters.size,
    maxValidationEntries: MAX_VALIDATED_TIMEZONES,
    maxFormatterEntries: MAX_TIMEZONE_FORMATTERS,
  };
}

function localParts(epoch: number, timezone: string): LocalParts {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(epoch)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour!, minute: parts.minute!,
  };
}

function localMinute(parts: LocalParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
}

interface OffsetSegment {
  start: number;
  end: number;
  offset: number;
}

const offsetModels = new Map<string, OffsetSegment[]>();

function offsetAt(epoch: number, timezone: string): number {
  return localMinute(localParts(epoch, timezone)) - epoch;
}

function transitionMinute(start: number, end: number, startOffset: number, timezone: string): number {
  let low = start;
  let high = end;
  while (high - low > MINUTE_MS) {
    const midpoint = Math.floor((low + (high - low) / 2) / MINUTE_MS) * MINUTE_MS;
    if (offsetAt(midpoint, timezone) === startOffset) low = midpoint;
    else high = midpoint;
  }
  return high;
}

/** Build the UTC offset segments which can contain one local day. Probing at hour boundaries is
 * deliberately independent of cron density; IANA offset regimes persist beyond an hour, while
 * binary search locates each detected transition to the minute precision cron supports. */
function offsetModel(year: number, month: number, day: number, timezone: string): OffsetSegment[] {
  const key = `${timezone}\0${year}-${month}-${day}`;
  const cached = offsetModels.get(key);
  if (cached) {
    offsetModels.delete(key);
    offsetModels.set(key, cached);
    return cached;
  }

  const localDay = Date.UTC(year, month - 1, day);
  const start = localDay - OFFSET_WINDOW_MS;
  const end = localDay + 24 * HOUR_MS + OFFSET_WINDOW_MS;
  const segments: OffsetSegment[] = [];
  let segmentStart = start;
  let currentOffset = offsetAt(start, timezone);
  for (let probe = start + HOUR_MS; probe <= end; probe += HOUR_MS) {
    const nextOffset = offsetAt(probe, timezone);
    if (nextOffset === currentOffset) continue;
    const transition = transitionMinute(probe - HOUR_MS, probe, currentOffset, timezone);
    segments.push({ start: segmentStart, end: transition, offset: currentOffset });
    segmentStart = transition;
    currentOffset = nextOffset;
  }
  segments.push({ start: segmentStart, end, offset: currentOffset });

  offsetModels.set(key, segments);
  if (offsetModels.size > MAX_OFFSET_MODELS) offsetModels.delete(offsetModels.keys().next().value!);
  return segments;
}

/** Convert one local wall-clock minute using the existing four-step convergence policy, but answer
 * offset lookups from the day's model instead of formatting every cron candidate. The convergence
 * matters: repeated fall-back minutes resolve to one deterministic occurrence, and that occurrence
 * can differ by zone; spring-forward gaps still fail the final equality check. */
function localEpoch(parts: LocalParts, model: OffsetSegment[]): number | null {
  const desired = localMinute(parts);
  let guess = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const segment = model.find((candidate) => guess >= candidate.start && guess < candidate.end);
    if (!segment) return null;
    const observed = guess + segment.offset;
    const delta = desired - observed;
    if (delta === 0) return guess;
    guess += delta;
  }
  const segment = model.find((candidate) => guess >= candidate.start && guess < candidate.end);
  return segment && guess + segment.offset === desired ? guess : null;
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
      const model = offsetModel(year, month, day, zone);
      const minimumOffset = Math.min(...model.map((segment) => segment.offset));
      const maximumOffset = Math.max(...model.map((segment) => segment.offset));
      const lastMinute = parsed.minute.values.at(-1)!;
      candidateLoop:
      for (const hour of parsed.hour.values) {
        const hourEnd = Date.UTC(year, month - 1, day, hour, lastMinute);
        if (hourEnd - minimumOffset <= after) continue;
        for (const minute of parsed.minute.values) {
          const parts = { year, month, day, hour, minute };
          const desired = localMinute(parts);
          // Offset bounds let dense schedules skip candidates that cannot pass the cursor or beat
          // the current minimum. The bounds stay valid across fall-back overlaps, so correctness
          // does not depend on wall-clock ordering matching instant ordering.
          if (desired - minimumOffset <= after) continue;
          if (best !== null && desired - maximumOffset >= best) break candidateLoop;
          const epoch = localEpoch(parts, model);
          if (epoch !== null && epoch > after && (best === null || epoch < best)) best = epoch;
        }
      }
      if (best !== null) return best;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  throw new Error("cron expression has no fire time within five years");
}
