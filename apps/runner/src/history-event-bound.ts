/**
 * Size bounds for records the runner writes into session history (#4288).
 *
 * The history reader refuses any single record larger than its page budget, and a refused record
 * makes the whole session unreadable: it cannot be paged, restarted, or prompted again. Every bound
 * here therefore applies before a record is written, never after.
 *
 * - `boundTurnDiff` keeps the runner's per-turn worktree capture well below that budget. An
 *   oversized capture keeps whole per-file sections that fit, in Git's order, behind a summary that
 *   names the full size and file count.
 * - `boundHistoryPayload` is the store's last line of defense for any other emitter. It shortens
 *   large top-level text fields of the one record being written, and refuses (returns null) when
 *   that cannot bring the record under the budget, so the caller fails closed without writing.
 */
import type { SessionEventPayload } from "@wollipog/protocol";

/** The largest per-turn worktree diff kept in history, in UTF-8 bytes. JSON escaping can grow a
 * string at most sixfold, so even a worst-case 4 MiB diff stays below the 32 MiB page budget. */
export const TURN_DIFF_MAX_BYTES = 4 * 1024 * 1024;

/** Bytes reserved inside `TURN_DIFF_MAX_BYTES` for the summary that precedes a shortened diff. */
const TURN_DIFF_SUMMARY_RESERVE_BYTES = 4 * 1024;

/** A top-level string shorter than this is never shortened: identifiers, titles and statuses stay
 * exact. Only bulky text (output, diffs, messages) is eligible. */
const HISTORY_FIELD_MIN_BOUND_BYTES = 64 * 1024;

/** The first per-field cap tried by `boundHistoryPayload`; it halves until the record fits. */
const HISTORY_FIELD_FIRST_CAP_BYTES = 4 * 1024 * 1024;

const FILE_HEADER = "diff --git ";

function formatBytes(bytes: number): string {
  return bytes.toLocaleString("en-US");
}

function plural(count: number, noun: string): string {
  return `${formatBytes(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** Split a Git diff into its per-file sections, each starting at a `diff --git ` header line. Any
 * text before the first header is kept as its own leading section. */
function fileSections(diff: string): string[] {
  const starts: number[] = [];
  if (diff.startsWith(FILE_HEADER)) starts.push(0);
  for (let at = diff.indexOf(`\n${FILE_HEADER}`); at !== -1; at = diff.indexOf(`\n${FILE_HEADER}`, at + 1)) {
    starts.push(at + 1);
  }
  if (!starts.length) return [diff];
  const sections: string[] = [];
  if (starts[0]! > 0) sections.push(diff.slice(0, starts[0]));
  for (let index = 0; index < starts.length; index++) {
    sections.push(diff.slice(starts[index], starts[index + 1] ?? diff.length));
  }
  return sections;
}

/** Number of files a Git diff names (its `diff --git ` header lines). */
export function diffFileCount(diff: string): number {
  return fileSections(diff).filter((section) => section.startsWith(FILE_HEADER)).length;
}

/**
 * The summary that replaces or precedes an oversized turn diff. Its lines deliberately start with
 * none of the unified-diff markers (`diff --git`, `---`, `+++`, `@@`, `+`, `-`, `\`), so a diff
 * viewer shows them as plain text and adds nothing to the turn's line counts.
 */
export function oversizedTurnDiffSummary(details: {
  /** The diff's full size, or the lower bound when it was too large to read. */
  bytes: number;
  /** True when `bytes` is only a lower bound. */
  atLeast?: boolean;
  files: number;
  shownFiles: number;
  limitBytes?: number;
}): string {
  const limit = details.limitBytes ?? TURN_DIFF_MAX_BYTES;
  const size = `${details.atLeast ? "more than " : ""}${plural(details.bytes, "byte")}`;
  return [
    `This turn's worktree diff is too large to keep in session history: ${size} across ${plural(details.files, "file")}.`,
    `Session history keeps up to ${plural(limit, "byte")} of each turn's diff; ` +
      `${formatBytes(details.shownFiles)} of ${plural(details.files, "file")} ${details.shownFiles === 1 ? "is" : "are"} shown here.`,
    "The worktree itself is unchanged; its Git changes show the complete diff.",
    "",
  ].join("\n");
}

/**
 * Keep a per-turn worktree diff within `limitBytes`. A diff that fits is returned unchanged. A
 * larger one becomes a summary naming its full size and file count, followed by every whole
 * per-file section that still fits, in their original order. A partial file section is never kept,
 * so what remains is still a well-formed diff.
 */
export function boundTurnDiff(diff: string, limitBytes = TURN_DIFF_MAX_BYTES): string {
  const totalBytes = Buffer.byteLength(diff, "utf8");
  if (totalBytes <= limitBytes) return diff;
  const sections = fileSections(diff);
  const files = sections.filter((section) => section.startsWith(FILE_HEADER)).length;
  const available = Math.max(0, limitBytes - TURN_DIFF_SUMMARY_RESERVE_BYTES);
  const kept: string[] = [];
  let keptBytes = 0;
  let shownFiles = 0;
  for (const section of sections) {
    if (!section.startsWith(FILE_HEADER)) continue;
    const bytes = Buffer.byteLength(section, "utf8");
    if (keptBytes + bytes > available) continue;
    kept.push(section);
    keptBytes += bytes;
    shownFiles += 1;
  }
  const summary = oversizedTurnDiffSummary({ bytes: totalBytes, files, shownFiles, limitBytes });
  return `${summary}${kept.join("")}`;
}

function utf8Head(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  let end = Math.min(bytes.byteLength, Math.max(0, maxBytes));
  while (end > 0 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  let start = Math.max(0, bytes.byteLength - Math.max(0, maxBytes));
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

/** Keep the head and tail of a large text, with a marker naming how many bytes were left out. */
function shortenText(value: string, capBytes: number): string {
  const totalBytes = Buffer.byteLength(value, "utf8");
  if (totalBytes <= capBytes) return value;
  const head = utf8Head(value, Math.floor(capBytes * 0.75));
  const tail = utf8Tail(value, capBytes - Buffer.byteLength(head, "utf8"));
  const omitted = totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  return `${head}\n… [${plural(omitted, "byte")} of ${plural(totalBytes, "byte")} left out: ` +
    `this record exceeded the session history record limit] …\n${tail}`;
}

/**
 * Bring one history record under `budgetBytes` by shortening its bulky top-level text fields. The
 * record's kind, identifiers and every other field stay as they are. Returns the payload unchanged
 * when it already fits, a shortened copy when shortening makes it fit, and null when it cannot be
 * made to fit: the caller must then refuse the write rather than persist an unreadable record.
 * `serialize` measures the record exactly as it will be written.
 */
export function boundHistoryPayload(
  payload: SessionEventPayload,
  budgetBytes: number,
  serialize: (payload: SessionEventPayload) => string,
): SessionEventPayload | null {
  if (Buffer.byteLength(serialize(payload), "utf8") <= budgetBytes) return payload;
  const source = payload as unknown as Record<string, unknown>;
  const bulky = Object.keys(source).filter((key) =>
    typeof source[key] === "string" &&
    Buffer.byteLength(source[key] as string, "utf8") > HISTORY_FIELD_MIN_BOUND_BYTES);
  if (!bulky.length) return null;
  for (let cap = HISTORY_FIELD_FIRST_CAP_BYTES; cap >= HISTORY_FIELD_MIN_BOUND_BYTES; cap = Math.floor(cap / 2)) {
    const candidate: Record<string, unknown> = { ...source };
    for (const key of bulky) candidate[key] = shortenText(source[key] as string, cap);
    const bounded = candidate as unknown as SessionEventPayload;
    if (Buffer.byteLength(serialize(bounded), "utf8") <= budgetBytes) return bounded;
  }
  return null;
}
