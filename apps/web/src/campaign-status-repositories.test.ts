import assert from "node:assert/strict";
import { test } from "node:test";
import { CAMPAIGN_WORK_ITEM_PRIMARY_STATES, type CampaignWorkItemSummary, type CampaignWorkRepositoryCounts } from "@wollipog/protocol";
import {
  DEFAULT_CAMPAIGN_WORK_FILTERS,
  applyCampaignWorkFilters,
  campaignRepositoryFilterOptions,
  campaignWorkItemsQuery,
  filtersAreDefault,
  groupCampaignWorkByRepository,
  heldOnPullRequest,
  mergeDependencyLabel,
  repositoryCountsLabel,
  stateCauseText,
} from "./campaign-status.js";
import { itemSummary } from "./e2e/campaign-status-fixtures.js";

/** #4120: Campaign Status by repository. */
const counts = (repository: string | null, byState: Partial<CampaignWorkRepositoryCounts["byState"]>): CampaignWorkRepositoryCounts => {
  const full = Object.fromEntries(CAMPAIGN_WORK_ITEM_PRIMARY_STATES.map((state) => [state, byState[state] ?? 0])) as CampaignWorkRepositoryCounts["byState"];
  return { repository, byState: full, total: Object.values(full).reduce((sum, value) => sum + value, 0) };
};
const item = (id: string, repository: string | null, overrides: Partial<CampaignWorkItemSummary> = {}) => itemSummary(id, 1_000, { repository, ...overrides });

test("one repository, or an older control plane, keeps the list ungrouped and without a Repository filter", () => {
  const items = [item("a", "owner/app"), item("b", "owner/app")];
  assert.equal(groupCampaignWorkByRepository(items, null), null);
  assert.equal(groupCampaignWorkByRepository(items, [counts("owner/app", { running: 2 })]), null);
  // A one-repository campaign whose planned items name no repository yet is still one repository.
  const withUnknown = [counts("owner/app", { running: 1 }), counts(null, { planned: 2 })];
  assert.equal(groupCampaignWorkByRepository([item("a", "owner/app"), item("b", null), item("c", null)], withUnknown), null);
  assert.deepEqual(campaignRepositoryFilterOptions(withUnknown, "all"), []);
  assert.deepEqual(campaignRepositoryFilterOptions(null, "all"), []);
  assert.deepEqual(campaignRepositoryFilterOptions([counts("owner/app", { running: 2 })], "all"), []);
});

test("rows group by repository in the control plane's order, each with its counts, unknown last", () => {
  const repositories = [counts("owner/app", { running: 1, delivered: 1 }), counts("owner/api", { waiting: 1 }), counts(null, { planned: 1 })];
  const groups = groupCampaignWorkByRepository(
    [item("x", null), item("b", "owner/api"), item("a", "owner/app"), item("c", "owner/app")], repositories)!;
  assert.deepEqual(groups.map((group) => [group.label, group.items.map((row) => row.id)]),
    [["owner/app", ["a", "c"]], ["owner/api", ["b"]], ["No Repository", ["x"]]]);
  assert.equal(repositoryCountsLabel(groups[0]!.counts, 2), "2 Items: 1 Running, 1 Delivered");
  assert.equal(repositoryCountsLabel(groups[1]!.counts, 1), "1 Item: 1 Waiting");
  assert.equal(repositoryCountsLabel(null, 3), "3 Items");
  assert.deepEqual(campaignRepositoryFilterOptions(repositories, "all").map((option) => option.label),
    ["All Repositories", "owner/app", "owner/api"]);
  // A chosen repository stays selectable even once it has no items.
  assert.deepEqual(campaignRepositoryFilterOptions([counts("owner/app", { running: 1 })], "owner/api").map((option) => option.value),
    ["all", "owner/app", "owner/api"]);
});

test("the Repository filter is sent to the control plane and applied to live rows", () => {
  const filters = { ...DEFAULT_CAMPAIGN_WORK_FILTERS, repository: "owner/api" };
  assert.equal(campaignWorkItemsQuery(filters, null, 50), "limit=50&sort=queue&state=unfinished&repository=owner%2Fapi");
  assert.equal(campaignWorkItemsQuery(DEFAULT_CAMPAIGN_WORK_FILTERS, null, 50), "limit=50&sort=queue&state=unfinished");
  assert.equal(filtersAreDefault(filters), false);
  assert.deepEqual(applyCampaignWorkFilters([item("a", "owner/app", { primaryState: "running" }), item("b", "owner/api", { primaryState: "running" })], filters, 1_000)
    .map((row) => row.id), ["b"]);
});

test("a held item names its prerequisite and the pull request it waits on", () => {
  const dependency = { id: "api", key: "api:field", title: "Add Account Field", repository: "owner/api", status: "unmerged" as const,
    pullRequests: [{ ref: { repository: "owner/api", number: 7 }, state: "open" as const }] };
  assert.equal(mergeDependencyLabel(dependency), "owner/api: Add Account Field");
  assert.equal(mergeDependencyLabel({ ...dependency, title: null }), "owner/api: api:field");
  assert.equal(heldOnPullRequest({ stateCauses: ["dependency_unmerged", "attempt_awaiting_verification"], mergeDependencies: [dependency] }), "owner/api#7");
  assert.equal(heldOnPullRequest({ stateCauses: ["dependency_unmerged"], mergeDependencies: [{ ...dependency, pullRequests: [] }] }), "owner/api: Add Account Field");
  assert.equal(heldOnPullRequest({ stateCauses: ["attempt_awaiting_verification"], mergeDependencies: [dependency] }), null);
  assert.equal(stateCauseText("dependency_unmerged"), "Its merge waits until a prerequisite in another repository is merged.");
});
