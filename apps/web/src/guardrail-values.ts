import { MAX_LIVE_CHILD_LIMIT, type SessionConfig, type SessionView } from "@wollipog/protocol";

/**
 * The session guardrails' values (#2175): what each field accepts, the one-sentence error that says
 * how to fix it, the configuration a save sends, and the + menu's one-line summary. Pure, so the
 * Guardrails dialog and its tests read one definition of a legal limit.
 */

/** A field's parsed value, or the error shown in place of its helper (docs/design-system.md §8.5). */
export type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const USD_ERROR = "Enter an amount like 5 or 2.50.";
export const USD_ZERO_ERROR = "Enter an amount above 0, or leave the field empty for no limit.";
export const USD_LIST_ERROR = "Enter amounts like 1 or 2.50, separated by commas.";
export const COUNT_ZERO_ERROR = "Enter a number above 0, or leave the field empty for no limit.";

/** A plain decimal: digits with an optional fraction, or a bare fraction. No sign, exponent or
 * separator, so "1e", "-3" and "abc" are typos rather than a number JavaScript happens to read. */
const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const WHOLE = /^\d+$/;

/** One dollar amount. Empty means no limit (null). Zero is refused: the server reads it as "clear",
 * which is not what a person typing a $0 money limit means. A leading "$" is accepted. */
export function parseUsd(text: string): FieldResult<number | null> {
  const trimmed = text.trim().replace(/^\$\s*/, "");
  if (trimmed === "") return text.trim() === "" ? { ok: true, value: null } : { ok: false, error: USD_ERROR };
  if (!DECIMAL.test(trimmed)) return { ok: false, error: USD_ERROR };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, error: USD_ERROR };
  if (value <= 0) return { ok: false, error: USD_ZERO_ERROR };
  return { ok: true, value };
}

/** Dollar amounts separated by commas (spaces are tolerated too), ascending and without repeats.
 * Empty means none. */
export function parseUsdList(text: string): FieldResult<number[]> {
  const tokens = text.split(/[\s,]+/).filter((token) => token !== "");
  const amounts: number[] = [];
  for (const token of tokens) {
    const amount = parseUsd(token);
    if (!amount.ok || amount.value === null) return { ok: false, error: USD_LIST_ERROR };
    amounts.push(amount.value);
  }
  return { ok: true, value: [...new Set(amounts)].sort((a, b) => a - b) };
}

/** A whole count from `min` to `max`. Empty means no value (null): no limit for the tool-call
 * threshold, and "keep the current limit" for Live Child Limit. */
export function parseCount(text: string, max: number, min = 0): FieldResult<number | null> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: null };
  const value = WHOLE.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(value) || value > max) return { ok: false, error: countError(max, min) };
  // Only the tool-call threshold has a minimum (1): its 0 would read as "clear" on the server.
  if (value < min) return { ok: false, error: COUNT_ZERO_ERROR };
  return { ok: true, value };
}

function countError(max: number, min: number): string {
  return Number.isFinite(max)
    ? `Enter a whole number from ${min} to ${max}.`
    : "Enter a whole number like 200.";
}

/** The four fields as typed. */
export interface GuardrailDraft {
  costBudgetUsd: string;
  costCheckpointsUsd: string;
  maxToolCalls: string;
  maxChildSessions: string;
}

export type GuardrailField = keyof GuardrailDraft;
export const GUARDRAIL_FIELDS: readonly GuardrailField[] = ["costBudgetUsd", "costCheckpointsUsd", "maxToolCalls", "maxChildSessions"];

export type GuardrailSession = Pick<SessionView, "costBudgetUsd" | "costCheckpointsUsd" | "maxToolCalls" | "maxChildSessions">;

/** A cost or tool-call limit as the server means it: a positive number, or none (it reads any value
 * at or below 0 as "no limit"). */
function armedLimit(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

/** An amount as plain digits, never in exponent form ("1e-7", "1e+21"), so it reads as the amount
 * and parses back as typed. */
export function plainDecimal(value: number): string {
  const exponent = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(String(Math.abs(value)));
  if (!exponent) return String(value);
  // Move the point in JavaScript's shortest digits rather than printing the binary expansion.
  const digits = exponent[1]! + (exponent[2] ?? "");
  const point = 1 + Number(exponent[3]);
  const plain = point <= 0
    ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length
      ? digits + "0".repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return value < 0 ? `-${plain}` : plain;
}

/** The fields as the dialog opens: the session's current limits, empty where none is set. */
export function guardrailDraft(session: GuardrailSession): GuardrailDraft {
  const budget = armedLimit(session.costBudgetUsd);
  const toolCalls = armedLimit(session.maxToolCalls);
  return {
    costBudgetUsd: budget !== null ? plainDecimal(budget) : "",
    costCheckpointsUsd: (session.costCheckpointsUsd ?? []).map(plainDecimal).join(", "),
    maxToolCalls: toolCalls !== null ? plainDecimal(toolCalls) : "",
    maxChildSessions: session.maxChildSessions != null ? String(session.maxChildSessions) : "",
  };
}

/** The four fields parsed. */
function parseDraft(draft: GuardrailDraft) {
  return {
    costBudgetUsd: parseUsd(draft.costBudgetUsd),
    costCheckpointsUsd: parseUsdList(draft.costCheckpointsUsd),
    maxToolCalls: parseCount(draft.maxToolCalls, Number.POSITIVE_INFINITY, 1),
    maxChildSessions: parseCount(draft.maxChildSessions, MAX_LIVE_CHILD_LIMIT),
  } satisfies Record<GuardrailField, FieldResult<unknown>>;
}

/** One field's error, or null when its value is legal. */
export function guardrailFieldError(field: GuardrailField, text: string): string | null {
  const result = parseDraft({ costBudgetUsd: "", costCheckpointsUsd: "", maxToolCalls: "", maxChildSessions: "", [field]: text })[field];
  return result.ok ? null : result.error;
}

/** Whether a checkpoint sits at or above the recurring threshold, so it never pauses on its own
 * (the threshold pauses first). Null while either field is invalid or empty. */
export function checkpointAboveThreshold(draft: Pick<GuardrailDraft, "costBudgetUsd" | "costCheckpointsUsd">): boolean {
  const budget = parseUsd(draft.costBudgetUsd);
  const checkpoints = parseUsdList(draft.costCheckpointsUsd);
  if (!budget.ok || budget.value === null || !checkpoints.ok) return false;
  return checkpoints.value.some((amount) => amount >= budget.value!);
}

/**
 * The configuration a save sends, in one request, or the errors that block it.
 *
 * Only a field whose value differs from the session's sends: re-sending an unchanged cost or
 * tool-call threshold would re-arm its recurring allowance at the advanced amount (the control
 * plane stores a new step with every value it is given). A field still showing the text it opened
 * with is neither checked nor sent, so a limit the server accepted can never block saving another
 * field. An emptied cost or tool-call field sends the server's clear value (0, or no checkpoints);
 * an emptied Live Child Limit keeps the current limit, since 0 there pauses new children.
 */
export function guardrailPatch(
  session: GuardrailSession,
  draft: GuardrailDraft,
): { ok: true; patch: Partial<SessionConfig> } | { ok: false; errors: Partial<Record<GuardrailField, string>> } {
  const opened = guardrailDraft(session);
  const parsed = parseDraft(draft);
  const edited = (field: GuardrailField) => draft[field] !== opened[field];
  const errors: Partial<Record<GuardrailField, string>> = {};
  for (const field of GUARDRAIL_FIELDS) {
    const result = parsed[field];
    if (edited(field) && !result.ok) errors[field] = result.error;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const { costBudgetUsd: budget, costCheckpointsUsd: checkpoints, maxToolCalls: toolCalls, maxChildSessions: children } = parsed;
  const patch: Partial<SessionConfig> = {};
  if (edited("costBudgetUsd") && budget.ok && budget.value !== armedLimit(session.costBudgetUsd)) {
    patch.costBudgetUsd = budget.value ?? 0;
  }
  if (edited("costCheckpointsUsd") && checkpoints.ok &&
      checkpoints.value.join(",") !== (session.costCheckpointsUsd ?? []).join(",")) {
    patch.costCheckpointsUsd = checkpoints.value;
  }
  if (edited("maxToolCalls") && toolCalls.ok && toolCalls.value !== armedLimit(session.maxToolCalls)) {
    patch.maxToolCalls = toolCalls.value ?? 0;
  }
  if (edited("maxChildSessions") && children.ok && children.value !== null && children.value !== session.maxChildSessions) {
    patch.maxChildSessions = children.value;
  }
  return { ok: true, patch };
}

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** The + menu's second line for Guardrails…: what pauses the session and how many children may
 * run, or "No limits set." */
export function guardrailSummary(session: GuardrailSession): string {
  const amounts = [...new Set([
    ...(session.costCheckpointsUsd ?? []),
    ...(armedLimit(session.costBudgetUsd) !== null ? [session.costBudgetUsd!] : []),
  ])].sort((a, b) => a - b).map(formatUsd);
  const pauses = [
    amounts.length ? `${listWords(amounts)} spent` : null,
    armedLimit(session.maxToolCalls) !== null
      ? `${session.maxToolCalls} tool ${session.maxToolCalls === 1 ? "call" : "calls"}`
      : null,
  ].filter((part): part is string => part !== null);
  const children = session.maxChildSessions == null
    ? null
    : session.maxChildSessions === 0
      ? "New children paused."
      : `Up to ${session.maxChildSessions} live ${session.maxChildSessions === 1 ? "child" : "children"}.`;
  const sentences = [pauses.length ? `Pauses at ${pauses.join(" or ")}.` : null, children]
    .filter((sentence): sentence is string => sentence !== null);
  return sentences.length ? sentences.join(" ") : "No limits set.";
}

function listWords(words: string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}
