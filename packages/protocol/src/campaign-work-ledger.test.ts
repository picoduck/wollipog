import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAMPAIGN_WORK_ITEM_PRIMARY_STATES,
  CAMPAIGN_WORK_ITEM_UNFINISHED_STATES,
  CAMPAIGN_WORK_LEDGER_LIMITS,
  CAMPAIGN_WORK_REVISION_CHANGED,
  campaignRepositoryLocation,
  type CampaignMetric,
  type CampaignWorkSummary,
} from "./index.js";

test("ledger refs name a GitHub slug or a host-qualified GitLab project (#3539)", () => {
  assert.deepEqual(campaignRepositoryLocation("picoduck/wollipog"), { forge: "github", repository: "picoduck/wollipog" });
  assert.deepEqual(campaignRepositoryLocation("gitlab.example.com/group/subgroup/project"),
    { forge: "gitlab", host: "gitlab.example.com", project: "group/subgroup/project" });
  assert.deepEqual(campaignRepositoryLocation("gitlab.com/group/project"), { forge: "gitlab", host: "gitlab.com", project: "group/project" });
  assert.deepEqual(campaignRepositoryLocation("git.internal.example:8443/team/my.project_2"),
    { forge: "gitlab", host: "git.internal.example:8443", project: "team/my.project_2" });
  const deepest = ["gitlab.example.com", ...Array.from({ length: 22 }, (_, index) => `g${index}`)].join("/");
  assert.equal(campaignRepositoryLocation(deepest)?.forge, "gitlab", "a top-level group, 20 subgroups, and the project");
  for (const refused of [
    "group/subgroup/project", // no host: glab would resolve it against gitlab.com
    "github.com/picoduck/wollipog", // GitHub refs keep their one spelling
    "GitHub.com:443/picoduck/wollipog",
    "gitlab.example.com/group/../project",
    "gitlab.example.com/group/-project",
    "gitlab.example.com/group/project.git",
    "gitlab.example.com/group//project",
    "gitlab.example.com/group/project/",
    "gitlab.example.com:0/group/project",
    "gitlab.example.com:65536/group/project",
    "-gitlab.example.com/group/project",
    "https://gitlab.example.com/group/project",
    "gitlab.example.com/group/pro ject",
    `${deepest}/one-more`,
    `gitlab.example.com/${"a".repeat(240)}/project`,
    "",
    "owner",
    42,
  ]) {
    assert.equal(campaignRepositoryLocation(refused), null, `${String(refused)} is refused`);
  }
});

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
