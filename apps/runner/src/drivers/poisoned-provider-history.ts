/**
 * Recognize a provider rejection caused by an item that is already recorded in the
 * provider-owned conversation history. The request fails before inference, so no local retry,
 * continuation, or compaction can repair it: every later turn resends the same history and is
 * rejected identically. The only repair is a conversation that does not contain the item.
 *
 * Keep this deliberately narrower than "the provider returned 400". A rejected prompt, an
 * unsupported model, an oversized attachment, a content refusal, or a context-window overflow are
 * all recoverable within the same thread and must stay on the ordinary error path.
 *
 * The result carries structure only — the offending item's position, its field name, and the
 * measured sizes. The oversized value itself never crosses this boundary.
 */
export interface PoisonedProviderHistory {
  /** Only cause recognized so far: a historical function call whose serialized arguments exceed
   * the provider's per-field length limit. */
  reason: "oversized_tool_call";
  /** Position of the offending item in the provider's serialized history, when reported. */
  itemIndex?: number;
  /** Structural field name from the provider's error path, never its value. */
  field: "arguments";
  /** Provider's maximum accepted length for the field, when reported. */
  limit?: number;
  /** Length the provider measured, when reported. */
  length?: number;
}

/** `input[675].arguments`, including nested paths a future server version may report. The index
 * proves the field belongs to a historical item rather than to the request's own parameters. */
const HISTORY_ARGUMENTS_PATH = /\binput\[(\d+)\](?:\[\d+\]|\.[A-Za-z0-9_]+)*\.arguments\b/;
const TOO_LONG = /\bstring too long\b|\bmaximum length\b/i;

function boundedCount(match: RegExpMatchArray | null): number | undefined {
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function classifyPoisonedProviderHistory(message: unknown): PoisonedProviderHistory | null {
  if (typeof message !== "string" || !message) return null;
  const path = HISTORY_ARGUMENTS_PATH.exec(message);
  if (!path || !TOO_LONG.test(message)) return null;
  const itemIndex = boundedCount(path);
  const limit = boundedCount(/maximum length (\d+)/i.exec(message));
  const length = boundedCount(/\blength (\d+)\s+instead\b/i.exec(message));
  return {
    reason: "oversized_tool_call",
    ...(itemIndex === undefined ? {} : { itemIndex }),
    field: "arguments",
    ...(limit === undefined ? {} : { limit }),
    ...(length === undefined ? {} : { length }),
  };
}
