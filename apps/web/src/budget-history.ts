import type { UsageRetentionPolicy } from "@wollipog/protocol";
import { formatMoney } from "./usage-view-model.js";

/**
 * Budget and History (#3015): the daily budget and usage history retention, edited in one dialog.
 * The control plane validates the same limits (`usage-routes.ts`, `usage-aggregation.ts`); these
 * mirror them so a value it would refuse is caught under its field before anything is sent.
 */

export type BudgetHistoryField = "budget" | "hourly" | "daily";

/** The dialog's fields in the order they read, which is also the order focus visits errors in. */
export const BUDGET_HISTORY_FIELDS: readonly BudgetHistoryField[] = ["budget", "hourly", "daily"];

export const HOURLY_MIN_DAYS = 1;
export const HOURLY_MAX_DAYS = 90;
export const DAILY_FLOOR_DAYS = 30;
export const DAILY_MAX_DAYS = 3650;
export const BUDGET_MIN_USD = 0.01;
export const BUDGET_MAX_USD = 1_000_000;

export interface BudgetHistoryDraft {
  budget: string;
  hourly: string;
  daily: string;
}

/** What is saved now: the dialog's baseline. A part that saves becomes the new baseline at once, so
 * a retry after a partial failure sends only what still differs. */
export interface BudgetHistorySaved {
  budgetUsd: number | null;
  hourlyDays: number;
  dailyDays: number;
}

const DAYS = new Intl.NumberFormat("en-US");

/** "3,650 days", "1 day". */
export function daysLabel(days: number): string {
  return `${DAYS.format(days)} ${days === 1 ? "day" : "days"}`;
}

/** The budget as the field shows it: "25", "12.50", or empty for no limit. */
export function budgetDraft(usd: number | null): string {
  if (usd == null) return "";
  return Number.isInteger(usd) ? String(usd) : usd.toFixed(2);
}

/** The text as a plain decimal ("$1,250.5" → "1250.5"), or null when it is not one. A comma counts
 * only as a thousands separator, so "25,50" is refused rather than read as 2,550. */
function plainDecimal(text: string, dollar: boolean): string | null {
  const trimmed = dollar ? text.trim().replace(/^\$/, "") : text.trim();
  if (trimmed === "" || trimmed === ".") return null;
  return /^(?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d*)?$/.test(trimmed) ? trimmed.replaceAll(",", "") : null;
}

/** The budget the field asks for, rounded to cents as the control plane rounds it: `null` for an
 * empty field, `undefined` when the text is not an amount it accepts. */
export function parseBudget(text: string): number | null | undefined {
  if (text.trim() === "") return null;
  const plain = plainDecimal(text, true);
  if (plain === null) return undefined;
  const rounded = Math.round(Number(plain) * 100) / 100;
  return Number.isFinite(rounded) && rounded >= BUDGET_MIN_USD && rounded <= BUDGET_MAX_USD ? rounded : undefined;
}

/** A whole number of days, or `undefined` for anything else. */
export function parseDays(text: string): number | undefined {
  const plain = plainDecimal(text, false);
  return plain !== null && /^\d+$/.test(plain) ? Number(plain) : undefined;
}

function validHourly(text: string): number | undefined {
  const days = parseDays(text);
  return days !== undefined && days >= HOURLY_MIN_DAYS && days <= HOURLY_MAX_DAYS ? days : undefined;
}

/** Daily totals must cover at least the hourly detail, and never less than 30 days. */
export function dailyMinimum(hourlyText: string): number {
  return Math.max(validHourly(hourlyText) ?? 0, DAILY_FLOOR_DAYS);
}

/** Each field's error, one sentence that says how to fix it (§8.5), or nothing when it is valid. */
export function budgetHistoryErrors(draft: BudgetHistoryDraft): Partial<Record<BudgetHistoryField, string>> {
  const errors: Partial<Record<BudgetHistoryField, string>> = {};
  if (parseBudget(draft.budget) === undefined) {
    const plain = plainDecimal(draft.budget, true);
    errors.budget = plain !== null && Number(plain) > BUDGET_MAX_USD
      ? "Enter an amount up to $1,000,000, or leave it empty for no limit."
      : "Enter an amount of at least $0.01, or leave it empty for no limit.";
  }
  if (validHourly(draft.hourly) === undefined) errors.hourly = "Enter 1 to 90 days.";
  const minimum = dailyMinimum(draft.hourly);
  const daily = parseDays(draft.daily);
  if (daily === undefined || daily < minimum || daily > DAILY_MAX_DAYS) {
    errors.daily = `Enter ${DAYS.format(minimum)} to ${DAYS.format(DAILY_MAX_DAYS)} days.`;
  }
  return errors;
}

/** The daily field's helper names its range, which follows the hourly detail. */
export function dailyHelper(hourlyText: string): string {
  return `${DAYS.format(dailyMinimum(hourlyText))} to ${DAYS.format(DAILY_MAX_DAYS)} days.`;
}

/** "Fix 2 fields to save." */
export function fixFieldsSentence(count: number): string {
  return `Fix ${count} ${count === 1 ? "field" : "fields"} to save.`;
}

/** The values a valid draft saves. Call only once `budgetHistoryErrors` is empty. */
export function draftValues(draft: BudgetHistoryDraft): BudgetHistorySaved {
  return {
    budgetUsd: parseBudget(draft.budget) ?? null,
    hourlyDays: parseDays(draft.hourly)!,
    dailyDays: parseDays(draft.daily)!,
  };
}

export interface BudgetHistoryChanges {
  budget: boolean;
  retention: boolean;
  /** The periods that get shorter, which delete older history once saved. */
  shorterHourly: boolean;
  shorterDaily: boolean;
}

export function budgetHistoryChanges(next: BudgetHistorySaved, saved: BudgetHistorySaved): BudgetHistoryChanges {
  return {
    budget: next.budgetUsd !== saved.budgetUsd,
    retention: next.hourlyDays !== saved.hourlyDays || next.dailyDays !== saved.dailyDays,
    shorterHourly: next.hourlyDays < saved.hourlyDays,
    shorterDaily: next.dailyDays < saved.dailyDays,
  };
}

/** A valid period shorter than today's warns before submit (§8.5), naming what it deletes. */
export function shorterWarning(field: "hourly" | "daily", text: string, savedDays: number): string | null {
  const days = parseDays(text);
  if (days === undefined || days >= savedDays) return null;
  return `Shorter than now (${daysLabel(savedDays)}). Older ${field === "hourly" ? "hourly detail" : "daily totals"} will be deleted.`;
}

const DAY_MS = 86_400_000;

/** The first day a chart keeps once `days` of history remain: "Sep 11", or "Feb 15, 2017" outside
 * the current year. Usage is cut in UTC days, and it never starts before recording did. */
export function historyStartLabel(days: number, now: number, coverageStartedAt?: number): string {
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  const start = Math.max(today - days * DAY_MS, coverageStartedAt ?? 0);
  const sameYear = new Date(start).getUTCFullYear() === new Date(now).getUTCFullYear();
  return new Date(start).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** The Shorten Usage History confirmation's body: what is deleted, where charts will start, and
 * that it can't be undone (§7.4). */
export function shortenHistoryMessage(
  next: Pick<BudgetHistorySaved, "hourlyDays" | "dailyDays">,
  changes: Pick<BudgetHistoryChanges, "shorterHourly" | "shorterDaily">,
  now: number,
  coverageStartedAt?: number,
): string {
  const hourlyStart = historyStartLabel(next.hourlyDays, now, coverageStartedAt);
  const dailyStart = historyStartLabel(next.dailyDays, now, coverageStartedAt);
  if (changes.shorterHourly && changes.shorterDaily) {
    return `Hourly detail older than ${daysLabel(next.hourlyDays)} and daily totals older than ${daysLabel(next.dailyDays)} are deleted now, so hourly charts will start at ${hourlyStart} and daily charts at ${dailyStart}. This can't be undone.`;
  }
  if (changes.shorterHourly) {
    return `Hourly detail older than ${daysLabel(next.hourlyDays)} is deleted now, so hourly charts will start at ${hourlyStart}. Daily totals are not affected. This can't be undone.`;
  }
  return `Daily totals older than ${daysLabel(next.dailyDays)} are deleted now, so daily charts will start at ${dailyStart}. Hourly detail is not affected. This can't be undone.`;
}

/** The danger notice's sentence after a failed save: what did save, and what didn't. Saving stops at
 * the first failure, so history is never sent after the budget failed. */
export function saveFailureSentence(failed: "budget" | "retention", changes: Pick<BudgetHistoryChanges, "budget" | "retention">): string {
  if (failed === "budget") return changes.retention ? "Nothing was changed." : "The daily budget wasn't saved.";
  return changes.budget ? "The daily budget was saved. History wasn't changed." : "History wasn't changed.";
}

export const SAVED_TOAST = "Budget and history saved.";

/** The saved toast's detail line: "Daily budget $25.00 per person. Hourly detail 30 days, daily
 * totals 365 days." */
export function savedToastDetail(budgetUsd: number | null, retention: Pick<UsageRetentionPolicy, "hourlyDays" | "dailyDays">): string {
  const budget = budgetUsd == null ? "No daily budget." : `Daily budget ${formatMoney(budgetUsd)} per person.`;
  return `${budget} Hourly detail ${daysLabel(retention.hourlyDays)}, daily totals ${daysLabel(retention.dailyDays)}.`;
}
