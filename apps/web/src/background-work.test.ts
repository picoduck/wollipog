import assert from "node:assert/strict";
import { test } from "node:test";
import type { BackgroundDeliveryView, ManagedBackgroundJobView } from "@wollipog/protocol";
import { backgroundJobLabel, blockedDeliveryStopTarget } from "./background-job-stop.js";
import {
  backgroundJobGroupBadge,
  backgroundJobGroupCounts,
  backgroundJobGroupStatus,
  backgroundJobResultSentence,
  backgroundJobRowSentence,
  backgroundNotificationStage,
  backgroundTurnLabel,
  groupBackgroundHistory,
} from "./background-work.js";

const MINUTE = 60_000;
const NOW = 100 * MINUTE;
const job = (overrides: Partial<ManagedBackgroundJobView> = {}): ManagedBackgroundJobView => ({
  id: "job-shell-a1f3c9",
  parentTurnId: "turn-1",
  launchType: "shell",
  registeredAt: NOW - 10 * MINUTE,
  lastObservedAt: NOW - MINUTE,
  sourcePresent: true,
  ...overrides,
});
const finished = (overrides: Partial<ManagedBackgroundJobView> = {}) => job({
  terminalStatus: "completed", terminalObservedAt: NOW - 5 * MINUTE, continuationRequired: true, ...overrides,
});

test("a job's name is its kind and the last six characters of its id, wherever it is shown (#2858)", () => {
  assert.equal(backgroundJobLabel(job()), "Shell Job a1f3c9");
  assert.equal(backgroundJobLabel(job({ id: "x-7be210", launchType: "monitor" })), "Monitor Job 7be210");
  assert.equal(backgroundJobLabel(job({ id: "abc", launchType: "unknown" })), "Background Job abc");
  // The Session Status popover's Stop Job names the job the same way (#2275).
  const target = blockedDeliveryStopTarget({
    driver: "claude-code", backgroundWorkTracking: "managed", backgroundWorkState: "running",
    backgroundJobs: [finished({ id: "agent-04d2e1", launchType: "agent" }), job({ id: "monitor-7be210", launchType: "monitor" })],
  }, { parentTurnId: "turn-1", watchdogState: "continuation_blocked", unfinishedSiblingJobs: 1 }, 999, true);
  assert.deepEqual(target, { jobId: "monitor-7be210", jobLabel: "Monitor Job 7be210" });
});

test("a turn is named by the transcript's number, never its place in the list (#2858)", () => {
  assert.equal(backgroundTurnLabel("turn-4", { eventId: 40, turn: 4 }), "Turn 4");
  assert.equal(backgroundTurnLabel("turn-4", undefined), "Earlier Turn");
  assert.equal(backgroundTurnLabel("unknown", { eventId: 40, turn: 4 }), "Unknown Turn");
  assert.match(backgroundTurnLabel("turn-4", { eventId: 40, startedAt: NOW }), /^Turn at \d{1,2}:\d{2}/u);
});

test("a group's status: waiting, some finished, returning, returned, missing, unverified (#2858)", () => {
  const status = (jobs: ManagedBackgroundJobView[], deliveries: BackgroundDeliveryView[] = [], truncated = false) =>
    backgroundJobGroupBadge(backgroundJobGroupStatus(groupBackgroundHistory(jobs, deliveries)[0]!, truncated));
  const read = (meta: ReturnType<typeof status>) => [meta.label, meta.tone];
  assert.deepEqual(read(status([job()])), ["Waiting for 1 Job", "info"]);
  assert.deepEqual(read(status([job(), job({ id: "b" })])), ["Waiting for 2 Jobs", "info"]);
  assert.deepEqual(read(status([finished(), job({ id: "b" })])), ["1 of 2 Finished", "neutral"]);
  assert.deepEqual(read(status([finished()], [{ parentTurnId: "turn-1", jobCount: 1, terminalCount: 1, acceptedAt: NOW }])),
    ["Returning Result", "info"]);
  assert.deepEqual(read(status([finished({ assistantResultPersistedAt: NOW })])), ["Result Returned", "success"]);
  assert.deepEqual(read(status([finished()], [{ parentTurnId: "turn-1", jobCount: 1, terminalCount: 1, acceptedAt: NOW,
    missingResultAt: NOW }])), ["Result Missing", "warning"]);
  assert.deepEqual(read(status([finished()], [{ parentTurnId: "turn-1", jobCount: 1, terminalCount: 1, acceptedAt: NOW,
    missingResultAt: NOW, missingResultAcknowledgedAt: NOW }])), ["Missing Result Acknowledged", "neutral"]);
  assert.deepEqual(read(status([finished()], [], true)), ["Unverified", "neutral"], "a bounded list cannot prove the turn is done");
  assert.deepEqual(read(status([job({ parentTurnId: "unknown" })])), ["Unverified", "neutral"]);
  assert.equal(status([finished(), job({ id: "b" })]).pulse, false, "a group's inline status never pulses");
});

test("unknown turns stay separate groups, and groups list the most recent turn first (#2858)", () => {
  const groups = groupBackgroundHistory([
    job({ id: "a", parentTurnId: "unknown", registeredAt: 1 }),
    job({ id: "b", parentTurnId: "unknown", registeredAt: 2 }),
    job({ id: "c", parentTurnId: "turn-2", registeredAt: 3 }),
  ], []);
  assert.deepEqual(groups.map((group) => group.jobs.map((entry) => entry.id)), [["c"], ["b"], ["a"]]);
});

test("a row's sentence and the page's Result say where the job's result is, in the person's words (#2858)", () => {
  assert.equal(backgroundJobRowSentence(job(), "running", 0, NOW), "Started 10m ago");
  assert.equal(backgroundJobRowSentence(job(), "unverified", 0, NOW), "Last seen 1m ago");
  assert.equal(backgroundJobRowSentence(finished(), "completed", 1, NOW), "Result waits for the other job");
  assert.equal(backgroundJobRowSentence(finished(), "completed", 2, NOW), "Result waits for 2 other jobs");
  assert.equal(backgroundJobRowSentence(finished({ continuationQueuedAt: NOW }), "completed", 0, NOW), "Returning result");
  assert.equal(backgroundJobRowSentence(finished({ assistantResultPersistedAt: NOW - 50 * MINUTE }), "completed", 0, NOW),
    "Result returned 50m ago");
  assert.equal(backgroundJobRowSentence(finished({ continuationMissingResultAt: NOW }), "completed", 0, NOW), "Result never arrived");
  assert.equal(backgroundJobRowSentence(finished({ continuationRequired: false }), "killed", 1, NOW), "Finished 5m ago");

  assert.equal(backgroundJobResultSentence(job(), "running", 0, NOW), "Returns to this conversation when the job finishes");
  assert.equal(backgroundJobResultSentence(job(), "lost", 0, NOW), "Can't return to this conversation, because the job was lost");
  assert.equal(backgroundJobResultSentence(finished(), "completed", 2, NOW),
    "Returns to this conversation when the other 2 jobs finish");
  assert.equal(backgroundJobResultSentence(finished({ assistantResultPersistedAt: NOW - MINUTE }), "completed", 0, NOW),
    "Returned to this conversation 1m ago");
  assert.equal(backgroundJobResultSentence(finished({ continuationMissingResultAt: NOW }), "completed", 0, NOW),
    "Never reached this conversation");
  for (const sentence of [
    backgroundJobRowSentence(finished({ continuationAcceptedAt: NOW }), "completed", 0, NOW),
    backgroundJobResultSentence(finished({ continuationSubmittedAt: NOW }), "completed", 0, NOW),
  ]) assert.doesNotMatch(sentence, /continuation|terminal|submitted|accepted|in flight/iu);
});

test("the notification fact reads how far the push got (#2858)", () => {
  const delivery = (notifications: BackgroundDeliveryView["notifications"], queued = true): BackgroundDeliveryView => ({
    parentTurnId: "turn-1", jobCount: 1, terminalCount: 1, ...(queued ? { notificationQueuedAt: NOW } : {}),
    ...(notifications ? { notifications } : {}),
  });
  assert.equal(backgroundNotificationStage([delivery(undefined, false)]), null);
  assert.equal(backgroundNotificationStage([delivery(undefined)]), "Queued");
  const receipt = { deliveryId: "d", endpointKey: "e", state: "service_accepted" as const, attemptCount: 1 };
  assert.equal(backgroundNotificationStage([delivery([{ ...receipt, serviceAcceptedAt: NOW }])]), "Sent");
  assert.equal(backgroundNotificationStage([delivery([{ ...receipt, shownAt: NOW }])]), "Shown");
  assert.equal(backgroundNotificationStage([delivery([{ ...receipt, clickedAt: NOW }])]), "Opened");
});

test("a blocked receipt's unfinished siblings hold the turn even when the bounded list leaves them out (#2858)", () => {
  const listed = Array.from({ length: 3 }, (_, index) => finished({ id: `listed-${index}` }));
  const blocked: BackgroundDeliveryView = {
    parentTurnId: "turn-1", jobCount: 3, terminalCount: 3, watchdogState: "continuation_blocked", unfinishedSiblingJobs: 1,
  };
  const group = groupBackgroundHistory(listed, [blocked])[0]!;
  const counts = backgroundJobGroupCounts(group, true);
  assert.deepEqual(counts, { total: 4, finished: 3, partial: true });
  assert.equal(backgroundJobGroupBadge(backgroundJobGroupStatus(group, true)).label, "3 of 4 Finished");
  const unfinishedSiblings = counts.total - counts.finished;
  assert.equal(backgroundJobRowSentence(listed[0]!, "completed", unfinishedSiblings, NOW), "Result waits for the other job");
  assert.equal(backgroundJobResultSentence(listed[0]!, "completed", unfinishedSiblings, NOW),
    "Returns to this conversation when the other job finishes");
});
