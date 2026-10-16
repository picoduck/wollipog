import assert from "node:assert/strict";
import { test } from "node:test";
import { ARCHIVED_HISTORY_RETENTION_LIMITS } from "@wollipog/protocol";
import {
  historyPrunedSentence,
  historyPrunedTitle,
  historyPrunesAt,
  parseRetentionDays,
  retentionChangePrunesMore,
  retentionConfirmation,
  retentionCountsLabel,
  retentionLastRun,
  retentionScheduleSentence,
  retentionSourceSentence,
} from "./archived-history-retention.js";

const DAY = 86_400_000;
const AT = Date.UTC(2026, 9, 15, 14, 30);

test("a threshold is whole days within the limits", () => {
  for (const [text, days] of [["90", 90], [" 7 ", 7], ["3650", 3650]] as const) {
    assert.equal(parseRetentionDays(text, ARCHIVED_HISTORY_RETENTION_LIMITS), days, text);
  }
  for (const text of ["", "6", "3651", "9.5", "1e2", "-7", "90d"]) {
    assert.equal(parseRetentionDays(text, ARCHIVED_HISTORY_RETENTION_LIMITS), null, text);
  }
});

test("only turning retention on or shortening it prunes more", () => {
  assert.equal(retentionChangePrunesMore(null, 90), true);
  assert.equal(retentionChangePrunesMore(90, 30), true);
  assert.equal(retentionChangePrunesMore(90, 120), false);
  assert.equal(retentionChangePrunesMore(90, 90), false);
  assert.equal(retentionChangePrunesMore(90, null), false);
});

test("counts, schedule and last pass read as sentences a person can act on", () => {
  assert.equal(retentionCountsLabel({ sessions: 0, events: 0 }), "None");
  assert.equal(retentionCountsLabel({ sessions: 1, events: 1 }), "1 session, about 1 event");
  assert.equal(retentionCountsLabel({ sessions: 128, events: 604_115 }), "128 sessions, about 604,115 events");
  const base = { retentionDays: 90, prunesFrom: AT + DAY, nextRunAt: AT + 60_000 };
  assert.equal(retentionScheduleSentence(base, AT, "en-US", "UTC"), "Pruning starts Oct 16, 2026, 2:30 PM.");
  assert.equal(retentionScheduleSentence({ ...base, prunesFrom: AT - 1 }, AT, "en-US", "UTC"), "Next pass Oct 15, 2026, 2:31 PM.");
  assert.equal(retentionScheduleSentence({ ...base, retentionDays: null, prunesFrom: null }, AT), undefined);
  assert.deepEqual(retentionLastRun({ finishedAt: AT, sessions: 0, events: 0 }, "en-US", "UTC"),
    { when: "Finished Oct 15, 2026, 2:30 PM.", pruned: "Nothing to prune" });
  assert.deepEqual(retentionLastRun({ finishedAt: AT, sessions: 2, events: 900 }, "en-US", "UTC"),
    { when: "Finished Oct 15, 2026, 2:30 PM.", pruned: "2 sessions, 900 events" });
  assert.equal(retentionSourceSentence({ source: "organization", environmentDays: 180 }), null);
  assert.match(retentionSourceSentence({ source: "environment", environmentDays: 180 })!, /sets 180 days\. Saving here overrides it/);
});

test("the confirmation names what goes, what stays, and when it starts", () => {
  const preview = { retentionDays: 30, eligible: { sessions: 3, events: 1_200 }, prunesFrom: AT + DAY };
  const on = retentionConfirmation(null, preview, "en-US", "UTC");
  assert.equal(on.title, "Prune Archived History");
  assert.equal(on.confirmLabel, "Prune History");
  assert.equal(on.message, "History of sessions archived more than 30 days ago is permanently removed from this control plane, "
    + "starting Oct 16, 2026, 2:30 PM. Prompts, the final response, usage and cost, and attachments are kept. This cannot be undone here.");
  assert.deepEqual(on.detailRows.map((row) => row.meta), ["3", "1,200"]);
  const shorter = retentionConfirmation(90, preview, "en-US", "UTC");
  assert.equal(shorter.title, "Shorten History Retention");
  assert.equal(shorter.confirmLabel, "Shorten Retention");
});

test("a pruned session says when, under which threshold, and what was kept", () => {
  const pruned = { prunedAt: AT, eventCount: 12_345, retentionDays: 90 };
  assert.equal(historyPrunedSentence(pruned, "en-US", "UTC"),
    "On Oct 15, 2026, the retention policy for sessions archived more than 90 days removed 12,345 events: tool calls and "
    + "their output, file edits, reasoning, and intermediate messages. Prompts, the final response, usage and cost, and "
    + "attachments are kept.");
  assert.equal(historyPrunedTitle(pruned, "en-US", "UTC"), "Pruned Oct 15, 2026 by the 90-day retention policy");
});

test("an archived session is pruned at its threshold, never before the policy arms or on a past date", () => {
  const policy = { retentionDays: 90, prunesFrom: AT, nextRunAt: null };
  const archived = { archived: true, archivedAt: AT - 100 * DAY };
  assert.equal(historyPrunesAt(archived, policy, AT - DAY), AT, "past its threshold before arming: when pruning starts");
  assert.equal(historyPrunesAt(archived, policy, AT + 5 * DAY), AT + 5 * DAY, "past both: now, not a date gone by");
  assert.equal(historyPrunesAt(archived, { ...policy, nextRunAt: AT + 6 * DAY }, AT + 5 * DAY), AT + 6 * DAY,
    "past both with a pass scheduled: at that pass");
  assert.equal(historyPrunesAt({ archived: true, archivedAt: AT }, policy, AT), AT + 90 * DAY);
  assert.equal(historyPrunesAt({ ...archived, historyPruned: { prunedAt: AT, eventCount: 1, retentionDays: 90 } }, policy), null);
  assert.equal(historyPrunesAt({ archived: false, archivedAt: undefined }, policy), null);
  assert.equal(historyPrunesAt(archived, { retentionDays: null, prunesFrom: null, nextRunAt: null }), null);
  assert.equal(historyPrunesAt(archived, null), null);
});
