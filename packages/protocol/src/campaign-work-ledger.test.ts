import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAMPAIGN_WORK_ITEM_PRIMARY_STATES,
  CAMPAIGN_WORK_ITEM_UNFINISHED_STATES,
  CAMPAIGN_WORK_LEDGER_LIMITS,
  CAMPAIGN_WORK_REVISION_CHANGED,
  type CampaignMetric,
  type CampaignWorkSummary,
} from "./index.js";

test("only delivered, cancelled, and removed are finished work-item states", () => {
  const finished = CAMPAIGN_WORK_ITEM_PRIMARY_STATES
    .filter((state) => !(CAMPAIGN_WORK_ITEM_UNFINISHED_STATES as readonly string[]).includes(state));
  assert.deepEqual(finished, ["delivered", "cancelled", "removed"]);
});

test("ledger bounds match the posted contract", () => {
  assert.equal(CAMPAIGN_WORK_LEDGER_LIMITS.planItemsPerCall, 100);
  assert.ok(CAMPAIGN_WORK_LEDGER_LIMITS.pageSizeDefault <= CAMPAIGN_WORK_LEDGER_LIMITS.pageSizeMax);
  assert.equal(CAMPAIGN_WORK_REVISION_CHANGED, "revision_changed");
});

test("a known zero is distinct from an unavailable measurement", () => {
  const zero: CampaignMetric<number> = { availability: "known", value: 0 };
  const missing: CampaignMetric<number> = { availability: "unavailable", reason: "not_collected" };
  assert.notDeepEqual(zero, missing);
  // The cost summary is optional: omission means "not collected", never zero.
  const summary: Pick<CampaignWorkSummary, "cost"> = {};
  assert.equal(summary.cost, undefined);
});
