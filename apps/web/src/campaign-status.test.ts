import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignWorkItemSummary } from "@wollipog/protocol";
import {
  CAMPAIGN_STATUS_UNSUPPORTED_REASON,
  CAMPAIGN_ORIGIN_FILTER_OPTIONS,
  CAMPAIGN_SORT_OPTIONS,
  CAMPAIGN_STATE_FILTER_OPTIONS,
  CAMPAIGN_WORK_STATE_LABELS,
  DEFAULT_CAMPAIGN_WORK_FILTERS,
  REPORTED_STAGE_LABELS,
  RESPONSIBLE_ACTOR_LABELS,
  applyCampaignWorkFilters,
  campaignCostView,
  campaignStatusAvailability,
  campaignSummaryView,
  campaignWorkItemsQuery,
  costWithProvenance,
  durationMetricView,
  elapsedMs,
  issueRefHref,
  measuredDuration,
  workItemOriginLabel,
  workItemTimeView,
  workItemTitle,
} from "./campaign-status.js";
import { titleCaseLabel } from "./format.js";
import { MINUTE, campaignProjection, itemSummary, knownCost, workSummary } from "./e2e/campaign-status-fixtures.js";

const NOW = 100 * MINUTE;
const withWork = campaignProjection(workSummary(NOW));
const legacy = campaignProjection(null);

test("Campaign Status is offered on the root campaign and on members, and hidden elsewhere", () => {
  assert.deepEqual(
    campaignStatusAvailability({ id: "s_root", orchestratorCampaign: withWork }),
    { kind: "available", campaignSessionId: "s_root", role: "campaign", currentWorkItemId: null },
  );
  assert.deepEqual(
    campaignStatusAvailability({
      id: "s_child",
      campaignMembership: { campaignSessionId: "s_root", currentWorkItemId: "cwi_a", currentAttemptId: "catt_a" },
    }),
    { kind: "available", campaignSessionId: "s_root", role: "member", currentWorkItemId: "cwi_a" },
  );
  assert.deepEqual(campaignStatusAvailability({ id: "s_other" }), { kind: "hidden" });
  // A server that keeps the ledger reports membership for every authorized member; a child without
  // it is not one, even when its parent runs a campaign.
  assert.deepEqual(campaignStatusAvailability({ id: "s_child" }, { id: "s_root", orchestratorCampaign: withWork }), { kind: "hidden" });
});

test("A nested Orchestrator shows its root campaign, not its own projection", () => {
  assert.deepEqual(
    campaignStatusAvailability({
      id: "s_nested",
      orchestratorCampaign: withWork,
      campaignMembership: { campaignSessionId: "s_root", currentWorkItemId: null, currentAttemptId: null },
    }),
    { kind: "available", campaignSessionId: "s_root", role: "member", currentWorkItemId: null },
  );
});

test("A recognized campaign on a server without the ledger explains why instead of showing an empty plan", () => {
  assert.deepEqual(
    campaignStatusAvailability({ id: "s_root", orchestratorCampaign: legacy }),
    { kind: "unavailable", campaignSessionId: "s_root", reason: CAMPAIGN_STATUS_UNSUPPORTED_REASON },
  );
  assert.deepEqual(
    campaignStatusAvailability({ id: "s_child" }, { id: "s_root", orchestratorCampaign: legacy }),
    { kind: "unavailable", campaignSessionId: "s_root", reason: CAMPAIGN_STATUS_UNSUPPORTED_REASON },
  );
});

test("Cost labels distinguish provider-reported, estimated, partially priced, unavailable, and a known zero", () => {
  assert.deepEqual(campaignCostView(knownCost(1.25)), {
    text: "$1.25", provenance: "Provider-Reported", note: "Cost as reported by the provider.", priced: true,
  });
  assert.equal(campaignCostView(knownCost(1.25, "modelPriced")).provenance, "Estimated API Cost");
  const unpriced = campaignCostView(knownCost(1.25, "modelPriced", 2));
  assert.equal(unpriced.provenance, "Partially Priced");
  assert.match(unpriced.note!, /2 records could not be priced/);
  const partial = campaignCostView({ availability: "partial", value: { usd: 1, source: "modelPriced", unpricedRecords: 0 }, reason: "history_unavailable" });
  assert.equal(partial.provenance, "Partially Priced");
  assert.equal(campaignCostView(knownCost(0)).text, "$0.00", "a known zero is a real amount");
  for (const missing of [undefined, { availability: "unavailable" as const, reason: "not_authorized" as const }]) {
    const view = campaignCostView(missing);
    assert.equal(view.text, "Unavailable");
    assert.equal(view.priced, false);
  }
  assert.match(campaignCostView({ availability: "unavailable", reason: "not_authorized" }).note!, /cannot see the cost/);
});

test("Bucket and attempt costs keep their own provenance beside a total", () => {
  const estimated = campaignCostView(knownCost(1.1, "modelPriced"));
  assert.equal(costWithProvenance(estimated), "$1.10 (Estimated API Cost)");
  assert.equal(costWithProvenance(estimated, "Estimated API Cost"), "$1.10", "the same provenance as its total is not repeated");
  assert.equal(costWithProvenance(campaignCostView(knownCost(1, "modelPriced", 2)), "Partially Priced"), "$1.00 (Partially Priced)",
    "a lower bound always says so");
  assert.equal(costWithProvenance(campaignCostView(undefined)), "Unavailable");
  const view = campaignSummaryView(workSummary(NOW, {
    cost: {
      total: knownCost(3),
      workItems: { availability: "partial", value: { usd: 2, source: "modelPriced", unpricedRecords: 1 }, reason: "unpriced_usage" },
      coordination: knownCost(1),
      unattributed: knownCost(0),
      attributedSince: null,
    },
  }), withWork, NOW);
  assert.deepEqual(view.costBreakdown.map((row) => row.text), ["$2.00 (Partially Priced)", "$1.00", "$0.00"]);
});

test("Unrecorded durations read Unavailable, partial ones are lower bounds, and zero is real", () => {
  assert.equal(measuredDuration(null), "Unavailable");
  assert.equal(measuredDuration(Number.NaN), "Unavailable");
  assert.equal(measuredDuration(0), "0s");
  assert.deepEqual(durationMetricView(undefined), { text: "Unavailable", note: "This server does not record it yet." });
  assert.deepEqual(durationMetricView({ availability: "unavailable", reason: "history_unavailable" }),
    { text: "Unavailable", note: "It was not recorded for this part of the campaign." });
  assert.deepEqual(durationMetricView({ availability: "known", value: 0 }), { text: "0s", note: null });
  assert.equal(durationMetricView({ availability: "partial", value: 3 * MINUTE, reason: "history_unavailable" }).text, "At Least 3m 0s");
});

test("Campaign elapsed is wall-clock time, so two concurrent ten-minute items read ten minutes", () => {
  assert.equal(elapsedMs({ startedAt: 0, endedAt: null }, 10 * MINUTE), 10 * MINUTE);
  assert.equal(elapsedMs({ startedAt: 0, endedAt: 4 * MINUTE }, 10 * MINUTE), 4 * MINUTE);
  assert.equal(elapsedMs({ startedAt: null, endedAt: null }, 10 * MINUTE), null);
  const view = campaignSummaryView(workSummary(NOW, { elapsed: { startedAt: NOW - 10 * MINUTE, endedAt: null } }), withWork, NOW);
  assert.equal(view.elapsed, "10m 0s");
});

test("Work without an attempt shows its age, started work its elapsed time", () => {
  assert.deepEqual(workItemTimeView({ elapsed: { startedAt: null, endedAt: null }, createdAt: 0 }, 5 * MINUTE), { label: "Age", text: "5m 0s" });
  assert.deepEqual(workItemTimeView({ elapsed: { startedAt: MINUTE, endedAt: null }, createdAt: 0 }, 5 * MINUTE), { label: "Elapsed", text: "4m 0s" });
  assert.deepEqual(workItemTimeView({ elapsed: { startedAt: MINUTE, endedAt: 3 * MINUTE }, createdAt: 0 }, 9 * MINUTE), { label: "Elapsed", text: "2m 0s" });
});

test("The summary keeps rejected and duplicate recommendations out of committed progress", () => {
  const work = workSummary(NOW, {
    counts: {
      committed: 5, delivered: 2, original: 3, followUp: 2, cancelled: 1, removed: 1,
      byState: { planned: 1, queued: 1, running: 1, waiting: 0, blocked: 0, delivered: 2, cancelled: 1, removed: 1 },
    },
    recommendations: { awaiting_adjudication: 1, accepted: 2, rejected: 1, deferred: 0, duplicate: 3 },
    obligations: { verification: 1, adjudication: 0, publication: 1, cleanup: 2 },
  });
  const projection = campaignProjection(work, {
    limits: { maximumConcurrentChildren: 4, occupied: 2, remaining: 2, costBudgetUsd: 20, maxToolCalls: null },
  });
  const view = campaignSummaryView(work, projection, NOW);
  assert.equal(view.progressText, "2 of 5 Delivered");
  assert.deepEqual(view.recommendations, { awaiting: 1, rejected: 1, deferred: 0, duplicate: 3 });
  assert.equal(view.withdrawn, 2);
  assert.equal(view.capacity, "2 of 4 Occupied");
  assert.equal(view.budget, "$20.00 Orchestrator Session Budget", "a session budget is never called campaign-wide");
  assert.deepEqual(view.obligations, [
    { label: "Verification", count: 1 }, { label: "Issue Publication", count: 1 }, { label: "Cleanup", count: 2 },
  ]);
  assert.deepEqual(view.stateCounts.map((entry) => entry.count), [1, 1, 1, 0, 0, 2]);
  assert.equal(view.planNotice, null);
  assert.deepEqual(view.costBreakdown.map((row) => row.text), ["$2.00", "$0.50", "$0.00"]);
});

test("A missing plan and partial coverage are explicit", () => {
  const missing = campaignSummaryView(workSummary(NOW, {
    planState: "not_recorded", coverage: { untrackedChildren: 2, predatesLedger: true },
  }), withWork, NOW);
  assert.equal(missing.planNotice?.title, "Plan Not Recorded");
  assert.match(missing.planNotice!.body, /2 child sessions without a work item are not counted/);
  assert.match(missing.planNotice!.body, /before the ledger existed/);
  assert.equal(campaignSummaryView(workSummary(NOW, { planState: "partial" }), withWork, NOW).planNotice?.title, "Partial Coverage");
  assert.equal(campaignSummaryView(workSummary(NOW, { coverage: { untrackedChildren: 1, predatesLedger: false } }), withWork, NOW)
    .planNotice?.title, "Partial Coverage", "untracked children make a recorded plan partial coverage");
});

test("Missing campaign facts and uncollected cost read Unavailable rather than inventing values", () => {
  const view = campaignSummaryView(workSummary(NOW, { cost: undefined }), null, NOW);
  assert.equal(view.stateLabel, "Unavailable");
  assert.equal(view.capacity, "Unavailable");
  assert.equal(view.cost.text, "Unavailable");
  assert.deepEqual(view.costBreakdown, []);
  assert.equal(view.budget, null);
  const unauthorized = campaignSummaryView(workSummary(NOW, {
    cost: { total: knownCost(1), workItems: knownCost(1), coordination: { availability: "unavailable", reason: "not_authorized" }, unattributed: knownCost(0), attributedSince: null },
  }), withWork, NOW);
  assert.deepEqual(unauthorized.costBreakdown.map((row) => row.text), ["$1.00", "Unavailable", "$0.00"]);
});

test("Rows name the issue when there is no title, and origins carry their generation", () => {
  assert.equal(workItemTitle({ title: null, issue: { repository: "picoduck/wollipog", number: 7 }, key: "k" }), "picoduck/wollipog#7");
  assert.equal(workItemTitle({ title: "  ", issue: null, key: "plan:read-api" }), "plan:read-api");
  assert.equal(workItemOriginLabel({ origin: "original", generation: 0 }), "Original");
  assert.equal(workItemOriginLabel({ origin: "follow_up", generation: 1 }), "Follow-Up");
  assert.equal(workItemOriginLabel({ origin: "follow_up", generation: 3 }), "Follow-Up · Generation 3");
  assert.equal(issueRefHref({ repository: "picoduck/wollipog", number: 7 }, "pull"), "https://github.com/picoduck/wollipog/pull/7");
  assert.equal(issueRefHref({ repository: "javascript:alert(1)//x", number: 7 }), null);
  assert.equal(issueRefHref({ repository: "a/b", number: 0 }), null);
});

test("The list defaults to unfinished work in queue order, and every filter and sort is honored", () => {
  const item = (id: string, overrides: Partial<CampaignWorkItemSummary>) => itemSummary(id, NOW, overrides);
  const items = [
    item("cwi_1", { queuePosition: 2, primaryState: "running", elapsed: { startedAt: 0, endedAt: null }, activityAt: 5, cost: knownCost(3) }),
    item("cwi_2", { queuePosition: 1, primaryState: "planned", elapsed: { startedAt: null, endedAt: null }, activityAt: 9 }),
    item("cwi_3", { queuePosition: null, primaryState: "delivered", origin: "follow_up", generation: 1,
      elapsed: { startedAt: 0, endedAt: 9 * MINUTE }, activityAt: 1 }),
    item("cwi_4", { queuePosition: 3, primaryState: "blocked", origin: "follow_up", generation: 1,
      elapsed: { startedAt: NOW - 5 * MINUTE, endedAt: null }, activityAt: 0, cost: knownCost(1) }),
  ];
  const ids = (filters = DEFAULT_CAMPAIGN_WORK_FILTERS) => applyCampaignWorkFilters(items, filters, NOW).map((entry) => entry.id);
  assert.deepEqual(ids(), ["cwi_2", "cwi_1", "cwi_4"]);
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "finished" }), ["cwi_3"]);
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "all", origin: "follow_up" }), ["cwi_4", "cwi_3"]);
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "all", sort: "activity" }), ["cwi_2", "cwi_1", "cwi_3", "cwi_4"]);
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "all", sort: "elapsed" }), ["cwi_1", "cwi_3", "cwi_4", "cwi_2"]);
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "all", sort: "cost" }), ["cwi_1", "cwi_4", "cwi_2", "cwi_3"],
    "unknown cost sorts last, not as zero");
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "blocked" }), ["cwi_4"]);
});

test("The work-list query carries the filter, sort, and cursor", () => {
  assert.equal(campaignWorkItemsQuery(DEFAULT_CAMPAIGN_WORK_FILTERS, null, 50), "limit=50&sort=queue&state=unfinished");
  assert.equal(
    campaignWorkItemsQuery({ origin: "follow_up", state: "all", sort: "cost" }, "c1", 25),
    "limit=25&sort=cost&state=all&origin=follow_up&cursor=c1",
  );
});

test("Every visible label follows Title Case", () => {
  const labels = [
    ...Object.values(CAMPAIGN_WORK_STATE_LABELS),
    ...Object.values(REPORTED_STAGE_LABELS),
    ...Object.values(RESPONSIBLE_ACTOR_LABELS),
    ...CAMPAIGN_STATE_FILTER_OPTIONS.map((option) => option.label),
    ...CAMPAIGN_ORIGIN_FILTER_OPTIONS.map((option) => option.label),
    ...CAMPAIGN_SORT_OPTIONS.map((option) => option.label),
  ];
  for (const label of labels) assert.equal(titleCaseLabel(label), label, label);
});
