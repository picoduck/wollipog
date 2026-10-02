import assert from "node:assert/strict";
import { test } from "node:test";
import type { OrchestratorCampaignProjection } from "@wollipog/protocol";
import {
  CAMPAIGN_STATUS_UNSUPPORTED_REASON,
  CAMPAIGN_ORIGIN_FILTER_OPTIONS,
  CAMPAIGN_SORT_OPTIONS,
  CAMPAIGN_STATE_FILTER_OPTIONS,
  CAMPAIGN_WORK_STATE_LABELS,
  DEFAULT_CAMPAIGN_WORK_FILTERS,
  applyCampaignWorkFilters,
  campaignCostView,
  campaignElapsedMs,
  campaignStatusAvailability,
  campaignSummaryView,
  campaignWorkItemsQuery,
  issueRefHref,
  measuredDuration,
  workItemOriginLabel,
  workItemTimeView,
  workItemTitle,
} from "./campaign-status.js";
import type { CampaignCost, CampaignWorkItem, CampaignWorkSummary } from "./campaign-work-contract.js";
import { titleCaseLabel } from "./format.js";

const campaign = { status: "active" } as OrchestratorCampaignProjection;
const MINUTE = 60_000;

function cost(overrides: Partial<CampaignCost> = {}): CampaignCost {
  return {
    totalUsd: 1.25,
    workItemsUsd: 1,
    coordinationUsd: 0.2,
    unattributedUsd: 0.05,
    source: "providerReported",
    unpricedRecords: 0,
    coverage: "complete",
    ...overrides,
  };
}

function item(overrides: Partial<CampaignWorkItem> & Pick<CampaignWorkItem, "id">): CampaignWorkItem {
  return {
    key: overrides.id,
    issue: null,
    title: overrides.id,
    origin: "original",
    generation: 0,
    state: "planned",
    queuePosition: null,
    lastActivityAt: null,
    startedAt: null,
    endedAt: null,
    recordedAt: 0,
    cost: null,
    currentSessionId: null,
    ...overrides,
  };
}

function summary(overrides: Partial<CampaignWorkSummary> = {}): CampaignWorkSummary {
  return {
    revision: 3,
    planState: "recorded",
    coverage: { untrackedChildren: 0 },
    counts: {
      committed: 5,
      delivered: 2,
      original: 3,
      followUp: 2,
      byState: { planned: 1, queued: 1, running: 1, waiting: 0, blocked: 0, delivered: 2, cancelled: 1, removed: 1 },
    },
    recommendations: { awaiting_adjudication: 1, accepted: 2, rejected: 1, deferred: 0, duplicate: 3 },
    obligations: { verification: 1, adjudication: 0, cleanup: 2 },
    elapsed: { startedAt: 0, completedAt: null },
    cost: cost(),
    ...overrides,
  };
}

test("Campaign Status is offered on the Orchestrator's session and on members, and hidden elsewhere", () => {
  assert.deepEqual(
    campaignStatusAvailability({ id: "s_root", orchestratorCampaign: campaign, parentSessionId: null }, true),
    { kind: "available", campaignSessionId: "s_root", role: "campaign", currentWorkItemId: null },
  );
  assert.deepEqual(
    campaignStatusAvailability({
      id: "s_child",
      parentSessionId: "s_root",
      campaignMembership: { campaignSessionId: "s_root", currentWorkItemId: "cwi_a" },
    }, true),
    { kind: "available", campaignSessionId: "s_root", role: "member", currentWorkItemId: "cwi_a" },
  );
  assert.deepEqual(campaignStatusAvailability({ id: "s_other", parentSessionId: null }, true), { kind: "hidden" });
  // A supporting server reports membership for every authorized member; a child without it is not one,
  // even when its parent runs a campaign.
  assert.deepEqual(campaignStatusAvailability({ id: "s_child", parentSessionId: "s_root" }, true, true), { kind: "hidden" });
});

test("A recognized campaign on a server without campaign work explains why instead of disappearing", () => {
  assert.deepEqual(
    campaignStatusAvailability({ id: "s_root", orchestratorCampaign: campaign, parentSessionId: null }, false),
    { kind: "unavailable", campaignSessionId: "s_root", reason: CAMPAIGN_STATUS_UNSUPPORTED_REASON },
  );
  // An older server sends no membership; the parent's campaign is the only signal it has.
  assert.deepEqual(
    campaignStatusAvailability({ id: "s_child", parentSessionId: "s_root" }, false, true),
    { kind: "unavailable", campaignSessionId: "s_root", reason: CAMPAIGN_STATUS_UNSUPPORTED_REASON },
  );
  assert.deepEqual(campaignStatusAvailability({ id: "s_other", parentSessionId: "s_x" }, false, false), { kind: "hidden" });
});

test("Cost labels distinguish provider-reported, estimated, partially priced, unavailable, and a known zero", () => {
  assert.deepEqual(campaignCostView(cost()), {
    text: "$1.25", provenance: "Provider-Reported", note: "Cost as reported by the provider.", priced: true,
  });
  assert.equal(campaignCostView(cost({ source: "modelPriced" })).provenance, "Estimated API Cost");
  const partial = campaignCostView(cost({ source: "modelPriced", unpricedRecords: 2 }));
  assert.equal(partial.provenance, "Partially Priced");
  assert.match(partial.note!, /2 records could not be priced/);
  assert.equal(campaignCostView(cost({ coverage: "partial" })).provenance, "Partially Priced");
  assert.equal(campaignCostView(cost({ totalUsd: 0 })).text, "$0.00");
  for (const missing of [null, undefined, cost({ totalUsd: null }), cost({ coverage: "unavailable", totalUsd: 0 })]) {
    const view = campaignCostView(missing);
    assert.equal(view.text, "Unavailable");
    assert.equal(view.priced, false);
  }
});

test("Unrecorded measurements read Unavailable, never zero", () => {
  assert.equal(measuredDuration(null), "Unavailable");
  assert.equal(measuredDuration(undefined), "Unavailable");
  assert.equal(measuredDuration(Number.NaN), "Unavailable");
  assert.equal(measuredDuration(0), "0s");
  assert.equal(measuredDuration(10 * MINUTE), "10m 0s");
});

test("Campaign elapsed is wall-clock time, so two concurrent ten-minute items read ten minutes", () => {
  const now = 10 * MINUTE;
  assert.equal(campaignElapsedMs({ startedAt: 0, completedAt: null }, now), 10 * MINUTE);
  assert.equal(campaignElapsedMs({ startedAt: 0, completedAt: 4 * MINUTE }, now), 4 * MINUTE);
  const view = campaignSummaryView(summary(), campaign, now);
  assert.equal(view.elapsed, "10m 0s");
});

test("Planned work shows its age, started work its elapsed time", () => {
  assert.deepEqual(workItemTimeView({ startedAt: null, endedAt: null, recordedAt: 0 }, 5 * MINUTE), { label: "Age", text: "5m 0s" });
  assert.deepEqual(workItemTimeView({ startedAt: MINUTE, endedAt: null, recordedAt: 0 }, 5 * MINUTE), { label: "Elapsed", text: "4m 0s" });
  assert.deepEqual(workItemTimeView({ startedAt: MINUTE, endedAt: 3 * MINUTE, recordedAt: 0 }, 9 * MINUTE), { label: "Elapsed", text: "2m 0s" });
});

test("The summary keeps rejected and duplicate recommendations out of committed progress", () => {
  const view = campaignSummaryView(summary(), { ...campaign, limits: { maximumConcurrentChildren: 4, occupied: 2, costBudgetUsd: 20 } }, 0);
  assert.equal(view.progress.text, "2 of 5 Delivered");
  assert.deepEqual(view.recommendations, { awaiting: 1, rejected: 1, deferred: 0, duplicate: 3 });
  assert.equal(view.withdrawn, 2);
  assert.equal(view.capacity, "2 of 4 Occupied");
  assert.equal(view.budget, "$20.00 Orchestrator Session Budget");
  assert.deepEqual(view.obligations, [{ label: "Verification", count: 1 }, { label: "Cleanup", count: 2 }]);
  assert.deepEqual(view.stateCounts.map((entry) => entry.count), [1, 1, 1, 0, 0, 2]);
  assert.equal(view.planNotice, null);
});

test("A missing plan and partial coverage are explicit", () => {
  const missing = campaignSummaryView(summary({ planState: "not_recorded", coverage: { untrackedChildren: 2 } }), campaign, 0);
  assert.equal(missing.planNotice?.title, "Plan Not Recorded");
  assert.match(missing.planNotice!.body, /2 child sessions without a work item are not counted/);
  const partial = campaignSummaryView(summary({ planState: "partial" }), campaign, 0);
  assert.equal(partial.planNotice?.title, "Partial Coverage");
});

test("Missing campaign facts read Unavailable rather than inventing values", () => {
  const view = campaignSummaryView(summary({ cost: null }), null, 0);
  assert.equal(view.stateLabel, "Unavailable");
  assert.equal(view.capacity, "Unavailable");
  assert.equal(view.cost.text, "Unavailable");
  assert.deepEqual(view.costBreakdown, []);
  assert.equal(view.budget, null);
  const unattributed = campaignSummaryView(summary({ cost: cost({ coordinationUsd: null }) }), campaign, 0);
  assert.deepEqual(unattributed.costBreakdown.map((row) => row.text), ["$1.00", "Unavailable", "$0.05"]);
});

test("Rows name the issue when there is no title, and origins carry their generation", () => {
  assert.equal(workItemTitle({ title: null, issue: { repository: "picoduck/wollipog", number: 7 }, key: "k" }), "picoduck/wollipog#7");
  assert.equal(workItemTitle({ title: "  ", issue: null, key: "plan:read-api" }), "plan:read-api");
  assert.equal(workItemOriginLabel({ origin: "original", generation: 0 }), "Original");
  assert.equal(workItemOriginLabel({ origin: "follow_up", generation: 1 }), "Follow-Up");
  assert.equal(workItemOriginLabel({ origin: "follow_up", generation: 3 }), "Follow-Up · Generation 3");
  assert.equal(issueRefHref({ repository: "picoduck/wollipog", number: 7 }, "pull"), "https://github.com/picoduck/wollipog/pull/7");
  assert.equal(issueRefHref({ repository: "javascript:alert(1)//x", number: 7 }), null);
});

test("The list defaults to unfinished work in queue order, and every filter and sort is honored", () => {
  const items = [
    item({ id: "a", queuePosition: 2, state: "running", startedAt: 0, lastActivityAt: 5, cost: cost({ totalUsd: 3 }) }),
    item({ id: "b", queuePosition: 1, state: "planned", lastActivityAt: 9 }),
    item({ id: "c", queuePosition: null, state: "delivered", origin: "follow_up", generation: 1, startedAt: 0, endedAt: 9 * MINUTE }),
    item({ id: "d", queuePosition: 3, state: "blocked", origin: "follow_up", generation: 1, startedAt: 5 * MINUTE, cost: cost({ totalUsd: 1 }) }),
  ];
  const ids = (filters = DEFAULT_CAMPAIGN_WORK_FILTERS) => applyCampaignWorkFilters(items, filters, 10 * MINUTE).map((entry) => entry.id);
  assert.deepEqual(ids(), ["b", "a", "d"]);
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "finished" }), ["c"]);
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "all", origin: "follow_up" }), ["d", "c"]);
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "all", sort: "activity" }), ["b", "a", "c", "d"]);
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "all", sort: "time" }), ["a", "c", "d", "b"]);
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "all", sort: "cost" }), ["a", "d", "b", "c"]);
  assert.deepEqual(ids({ ...DEFAULT_CAMPAIGN_WORK_FILTERS, state: "blocked" }), ["d"]);
});

test("The work-list query carries the filter, sort, and cursor", () => {
  assert.equal(campaignWorkItemsQuery(DEFAULT_CAMPAIGN_WORK_FILTERS, null, 50), "limit=50&sort=queue&state=unfinished");
  assert.equal(
    campaignWorkItemsQuery({ origin: "follow_up", state: "all", sort: "cost" }, "c1", 25),
    "limit=25&sort=cost&origin=follow_up&state=all&cursor=c1",
  );
});

test("Every visible label follows Title Case", () => {
  const labels = [
    ...Object.values(CAMPAIGN_WORK_STATE_LABELS),
    ...CAMPAIGN_STATE_FILTER_OPTIONS.map((option) => option.label),
    ...CAMPAIGN_ORIGIN_FILTER_OPTIONS.map((option) => option.label),
    ...CAMPAIGN_SORT_OPTIONS.map((option) => option.label),
  ];
  for (const label of labels) assert.equal(titleCaseLabel(label), label, label);
});
