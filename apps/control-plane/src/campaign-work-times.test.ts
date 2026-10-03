import assert from "node:assert/strict";
import { test } from "node:test";
import {
  campaignItemDurations,
  campaignItemTimelines,
  type CampaignItemTimelineInput,
  type CampaignItemTransition,
} from "./campaign-work-times.js";

const planned: Omit<CampaignItemTransition, "at"> = { dispatchState: "planned", commitment: "committed", blocked: false };
const queued: Omit<CampaignItemTransition, "at"> = { dispatchState: "queued", commitment: "committed", blocked: false };

function durations(items: CampaignItemTimelineInput[], id: string, asOf: number) {
  const item = items.find((candidate) => candidate.id === id)!;
  return campaignItemDurations(campaignItemTimelines(items).get(id)!, item.attempts.length, asOf);
}

test("time metrics replay recorded intervals through the derived state: queued, running, then waiting", () => {
  const item: CampaignItemTimelineInput = {
    id: "a",
    createdAt: 0,
    transitions: [{ at: 0, ...planned }, { at: 10, ...queued }],
    dependsOn: [],
    attempts: [{
      ordinal: 1,
      startedAt: 30,
      endedAt: 60,
      deliveredAt: 60,
      statuses: [{ at: 30, status: "running", archived: false }, { at: 50, status: "idle", archived: false }],
    }],
  };
  assert.deepEqual(campaignItemTimelines([item]).get("a"), [
    { from: 0, state: "planned" },
    { from: 10, state: "queued" },
    { from: 30, state: "running" },
    { from: 50, state: "waiting" },
    { from: 60, state: "delivered" },
  ]);
  assert.deepEqual(durations([item], "a", 1_000), {
    queue: { availability: "known", value: 20 },
    waiting: { availability: "known", value: 10 },
    active: { availability: "known", value: 20 },
  }, "time after delivery and while merely planned counts toward none of them");
});

test("a span before recording began is a history gap, never zero", () => {
  const recordedLater: CampaignItemTimelineInput = {
    id: "late", createdAt: 0, transitions: [{ at: 100, ...queued }], dependsOn: [], attempts: [],
  };
  assert.deepEqual(durations([recordedLater], "late", 160), {
    queue: { availability: "partial", value: 60, reason: "history_unavailable" },
    waiting: { availability: "partial", value: 0, reason: "history_unavailable" },
    active: { availability: "partial", value: 0, reason: "history_unavailable" },
  });
  // Delivered before recording began: nothing about its durations was recorded.
  const finishedEarlier: CampaignItemTimelineInput = {
    id: "done",
    createdAt: 0,
    transitions: [{ at: 100, ...queued }],
    dependsOn: [],
    attempts: [{ ordinal: 1, startedAt: 10, endedAt: 50, deliveredAt: 50, statuses: [] }],
  };
  assert.deepEqual(durations([finishedEarlier], "done", 500), {
    queue: { availability: "unavailable", reason: "history_unavailable" },
    waiting: { availability: "unavailable", reason: "history_unavailable" },
    active: { availability: "unavailable", reason: "history_unavailable" },
  });
  // An attempt open before recording began has no observed state until its first status.
  const openEarlier: CampaignItemTimelineInput = {
    id: "open",
    createdAt: 100,
    transitions: [{ at: 100, ...queued }],
    dependsOn: [],
    attempts: [{ ordinal: 1, startedAt: 100, endedAt: null, deliveredAt: null, statuses: [{ at: 150, status: "running", archived: false }] }],
  };
  assert.deepEqual(durations([openEarlier], "open", 200).active, { availability: "partial", value: 50, reason: "history_unavailable" });
});

test("an item that never started has no Active Time to measure, while its queue time is a known value", () => {
  const item: CampaignItemTimelineInput = { id: "q", createdAt: 0, transitions: [{ at: 0, ...queued }], dependsOn: [], attempts: [] };
  assert.deepEqual(durations([item], "q", 0), {
    queue: { availability: "known", value: 0 },
    waiting: { availability: "known", value: 0 },
    active: { availability: "unavailable", reason: "not_started" },
  });
});

test("a blocked dependency makes a queued item wait, and an unfinished one leaves it queued", () => {
  const dependency: CampaignItemTimelineInput = {
    id: "dep",
    createdAt: 0,
    transitions: [{ at: 0, ...queued }, { at: 10, ...queued, blocked: true }, { at: 20, ...queued }],
    dependsOn: [],
    attempts: [],
  };
  const dependent: CampaignItemTimelineInput = {
    id: "item", createdAt: 0, transitions: [{ at: 0, ...queued }], dependsOn: ["dep"], attempts: [],
  };
  assert.deepEqual(durations([dependent, dependency], "item", 30), {
    queue: { availability: "known", value: 20 },
    waiting: { availability: "known", value: 10 },
    active: { availability: "unavailable", reason: "not_started" },
  });
  // A cycle or missing dependency blocks, as the primary state does.
  const orphan: CampaignItemTimelineInput = { ...dependent, id: "orphan", dependsOn: ["missing"] };
  assert.deepEqual(durations([orphan], "orphan", 30).waiting, { availability: "known", value: 30 });
});

test("a held, failed, archived, or deleted attempt session counts as waiting, and reassignment starts over", () => {
  const item: CampaignItemTimelineInput = {
    id: "r",
    createdAt: 0,
    transitions: [{ at: 0, ...queued }],
    dependsOn: [],
    attempts: [
      {
        ordinal: 1, startedAt: 0, endedAt: 40, deliveredAt: null,
        statuses: [
          { at: 0, status: "running", archived: false },
          { at: 10, status: "failed", archived: false },
          { at: 20, status: "running", archived: false },
          { at: 30, status: null, archived: false },
        ],
      },
      { ordinal: 2, startedAt: 40, endedAt: null, deliveredAt: null, statuses: [{ at: 40, status: "running", archived: false }] },
    ],
  };
  assert.deepEqual(durations([item], "r", 50), {
    queue: { availability: "known", value: 0 },
    waiting: { availability: "known", value: 20 },
    active: { availability: "known", value: 30 },
  });
});
