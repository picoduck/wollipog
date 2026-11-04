import assert from "node:assert/strict";
import test from "node:test";
import {
  budgetDraft,
  budgetHistoryChanges,
  budgetHistoryErrors,
  dailyHelper,
  fixFieldsSentence,
  historyStartLabel,
  parseBudget,
  saveFailureSentence,
  savedToastDetail,
  shortenHistoryMessage,
  shorterWarning,
} from "./budget-history.js";

const valid = { budget: "25", hourly: "30", daily: "365" };

test("the budget accepts what the control plane accepts: empty, or $0.01 to $1,000,000 rounded to cents", () => {
  assert.equal(parseBudget(""), null);
  assert.equal(parseBudget("  "), null);
  assert.equal(parseBudget("25"), 25);
  assert.equal(parseBudget("$12.5"), 12.5);
  assert.equal(parseBudget("1,000"), 1000);
  assert.equal(parseBudget("0.005"), 0.01, "rounded to the nearest cent, as the plane rounds");
  for (const refused of ["-5", "0", "0.004", "abc", ".", "1e3", "25,50", "1,0000", "25,5.1.2", "1000000.01"]) {
    assert.equal(parseBudget(refused), undefined, refused);
  }
  assert.equal(parseBudget("1000000"), 1_000_000);
});

test("each field's error says how to fix it, and Daily Totals' floor follows Hourly Detail", () => {
  assert.deepEqual(budgetHistoryErrors(valid), {});
  assert.deepEqual(budgetHistoryErrors({ ...valid, budget: "" }), {});
  assert.deepEqual(budgetHistoryErrors({ budget: "-5", hourly: "500", daily: "365" }), {
    budget: "Enter an amount of at least $0.01, or leave it empty for no limit.",
    hourly: "Enter 1 to 90 days.",
  });
  assert.equal(budgetHistoryErrors({ ...valid, budget: "2000000" }).budget,
    "Enter an amount up to $1,000,000, or leave it empty for no limit.");
  for (const hourly of ["0", "91", "1.5", "", "abc"]) assert.equal(budgetHistoryErrors({ ...valid, hourly }).hourly, "Enter 1 to 90 days.", hourly);
  assert.equal(budgetHistoryErrors({ ...valid, daily: "29" }).daily, "Enter 30 to 3,650 days.");
  assert.equal(budgetHistoryErrors({ ...valid, daily: "3651" }).daily, "Enter 30 to 3,650 days.");
  assert.equal(budgetHistoryErrors({ ...valid, hourly: "60", daily: "45" }).daily, "Enter 60 to 3,650 days.");
  // An invalid hourly value leaves the daily floor at 30 rather than guessing.
  assert.equal(budgetHistoryErrors({ ...valid, hourly: "500", daily: "45" }).daily, undefined);
  assert.equal(dailyHelper("60"), "60 to 3,650 days.");
  assert.equal(dailyHelper("14"), "30 to 3,650 days.");
  assert.equal(fixFieldsSentence(1), "Fix 1 field to save.");
  assert.equal(fixFieldsSentence(2), "Fix 2 fields to save.");
});

test("changes compare saved values, and only a shorter period warns", () => {
  const saved = { budgetUsd: 25, hourlyDays: 30, dailyDays: 365 };
  assert.deepEqual(budgetHistoryChanges(saved, saved), { budget: false, retention: false, shorterHourly: false, shorterDaily: false });
  assert.deepEqual(budgetHistoryChanges({ ...saved, budgetUsd: null, hourlyDays: 60 }, saved),
    { budget: true, retention: true, shorterHourly: false, shorterDaily: false });
  assert.deepEqual(budgetHistoryChanges({ ...saved, hourlyDays: 14, dailyDays: 200 }, saved),
    { budget: false, retention: true, shorterHourly: true, shorterDaily: true });
  assert.equal(shorterWarning("hourly", "14", 30), "Shorter than now (30 days). Older hourly detail will be deleted.");
  assert.equal(shorterWarning("daily", "200", 365), "Shorter than now (365 days). Older daily totals will be deleted.");
  assert.equal(shorterWarning("hourly", "30", 30), null);
  assert.equal(shorterWarning("hourly", "60", 30), null);
  assert.equal(budgetDraft(null), "");
  assert.equal(budgetDraft(25), "25");
  assert.equal(budgetDraft(12.5), "12.50");
});

test("Shorten Usage History names what is deleted and the UTC day charts will start at", () => {
  const now = Date.UTC(2026, 8, 25, 15, 30);
  assert.equal(historyStartLabel(14, now), "Sep 11");
  assert.equal(historyStartLabel(400, now), "Aug 21, 2025");
  assert.equal(historyStartLabel(14, now, Date.UTC(2026, 8, 20)), "Sep 20", "never before recording started");
  assert.equal(shortenHistoryMessage({ hourlyDays: 14, dailyDays: 365 }, { shorterHourly: true, shorterDaily: false }, now),
    "Hourly detail older than 14 days is deleted now, so hourly charts will start at Sep 11. Daily totals are not affected. This can't be undone.");
  assert.equal(shortenHistoryMessage({ hourlyDays: 30, dailyDays: 200 }, { shorterHourly: false, shorterDaily: true }, now),
    "Daily totals older than 200 days are deleted now, so daily charts will start at Mar 9. Hourly detail is not affected. This can't be undone.");
  assert.equal(shortenHistoryMessage({ hourlyDays: 1, dailyDays: 400 }, { shorterHourly: true, shorterDaily: true }, now),
    "Hourly detail older than 1 day and daily totals older than 400 days are deleted now, so hourly charts will start at Sep 24 and daily charts at Aug 21, 2025. This can't be undone.");
});

test("a failed save says what did save; the toast detail says what is saved now", () => {
  assert.equal(saveFailureSentence("retention", { budget: true, retention: true }), "The daily budget was saved. History wasn't changed.");
  assert.equal(saveFailureSentence("retention", { budget: false, retention: true }), "History wasn't changed.");
  assert.equal(saveFailureSentence("budget", { budget: true, retention: true }), "Nothing was changed.");
  assert.equal(saveFailureSentence("budget", { budget: true, retention: false }), "The daily budget wasn't saved.");
  assert.equal(savedToastDetail(25, { hourlyDays: 30, dailyDays: 365 }),
    "Daily budget $25.00 per person. Hourly detail 30 days, daily totals 365 days.");
  assert.equal(savedToastDetail(null, { hourlyDays: 1, dailyDays: 3650 }),
    "No daily budget. Hourly detail 1 day, daily totals 3,650 days.");
});
