import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_LOCATION_INSPECTION_FAILURES, type CampaignAuthorityBoundary, type ProjectLocationInspection, type ProjectLocationView,
  type SessionView } from "@wollipog/protocol";
import { campaignBoundaryRepositoryAt, launchBoundaryRepositories } from "./campaign-repository-boundary.js";

const verified = (locationId: string, repository: string): ProjectLocationInspection => ({ ok: true, location: { locationId, projectId: "prj",
  runnerId: "r", workspaceId: locationId, repository, digest: "d".repeat(64), verifiedAt: 1 } });
const failed = (locationId: string, failure: keyof typeof PROJECT_LOCATION_INSPECTION_FAILURES): ProjectLocationInspection =>
  ({ ok: false, locationId, failure, reason: PROJECT_LOCATION_INSPECTION_FAILURES[failure] });

test("the launch repository leads, other repositories follow in Project order, and each entry keeps Project order (#4117)", () => {
  // Project order: the default Location first, then the others by creation.
  const locations = ["default", "b1", "launch", "c1", "b2"].map((id) => ({ id, name: `Location ${id}` }));
  const result = launchBoundaryRepositories({ launchRepository: "Owner/Repo", launchLocationId: "launch", locations,
    inspections: new Map([["default", verified("default", "owner/repo")], ["b1", verified("b1", "b/repo")],
      ["c1", verified("c1", "C/Repo")], ["b2", verified("b2", "b/repo")],
      // The launch Location's own inspection is the launch inspection; a stale map entry is ignored.
      ["launch", failed("launch", "read_failed")]]) });
  assert.deepEqual(result.repositories, [
    { repository: "owner/repo", locationIds: ["default", "launch"] },
    { repository: "b/repo", locationIds: ["b1", "b2"] },
    { repository: "c/repo", locationIds: ["c1"] },
  ]);
  assert.deepEqual(result.excluded, []);
});

test("failed Locations are excluded with their fixed reasons, and an uninspected Location reads as unread (#4117)", () => {
  const locations = ["launch", "offline", "old", "folder", "unanswered"].map((id) => ({ id, name: id }));
  const result = launchBoundaryRepositories({ launchRepository: "owner/repo", launchLocationId: "launch", locations,
    inspections: new Map([["offline", failed("offline", "runner_offline")], ["old", failed("old", "runner_too_old")],
      ["folder", failed("folder", "not_repository")]]) });
  assert.deepEqual(result.repositories, [{ repository: "owner/repo", locationIds: ["launch"] }]);
  assert.deepEqual(result.excluded, [
    { locationId: "offline", name: "offline", failure: "runner_offline", reason: PROJECT_LOCATION_INSPECTION_FAILURES.runner_offline },
    { locationId: "old", name: "old", failure: "runner_too_old", reason: PROJECT_LOCATION_INSPECTION_FAILURES.runner_too_old },
    { locationId: "folder", name: "folder", failure: "not_repository", reason: PROJECT_LOCATION_INSPECTION_FAILURES.not_repository },
    { locationId: "unanswered", name: "unanswered", failure: "read_failed", reason: PROJECT_LOCATION_INSPECTION_FAILURES.read_failed },
  ]);
});

test("without a launch Location the boundary is the launch repository plus every verified Location (#4117)", () => {
  const result = launchBoundaryRepositories({ launchRepository: "owner/repo", launchLocationId: null,
    locations: [{ id: "a", name: "a" }], inspections: new Map([["a", verified("a", "other/repo")]]) });
  assert.deepEqual(result.repositories, [{ repository: "owner/repo", locationIds: [] }, { repository: "other/repo", locationIds: ["a"] }]);
});

test("Locations past the boundary's bounds are excluded rather than silently dropped (#4117)", () => {
  const locations = Array.from({ length: 102 }, (_, n) => ({ id: `l${n}`, name: `l${n}` }));
  const result = launchBoundaryRepositories({ launchRepository: "owner/repo", launchLocationId: "l0", locations,
    inspections: new Map(locations.slice(1).map((location) => [location.id, verified(location.id, "owner/repo")])) });
  assert.equal(result.repositories[0]!.locationIds.length, 100);
  assert.deepEqual(result.excluded.map((item) => [item.locationId, item.failure]), [["l100", "read_failed"], ["l101", "read_failed"]]);
});

test("a place is a boundary repository's Location only while its active Location is listed in the root's Project (#4119)", () => {
  const location = (id: string, runnerId: string, workspaceId: string, extra: Partial<ProjectLocationView> = {}): ProjectLocationView => ({ id, projectId: "prj",
    runnerId, workspaceId, name: id, path: `/${id}`, source: "managed", availability: "available", isDefault: false, createdAt: 1, updatedAt: 1, ...extra });
  const locations = new Map([["app", location("app", "r", "w")], ["api", location("api", "r2", "a")],
    ["moved", location("moved", "r2", "m", { projectId: "other" })], ["gone", location("gone", "r3", "g", { availability: "runner_removed" })]]);
  const db = { getProjectLocation: (id: string) => locations.get(id) ?? null };
  const boundary = { version: 1, revision: 1, issueScopeRevision: 1, repository: "owner/app", objective: "o", authorizedByUserId: "u", authorizedAt: 1,
    operations: [], delegatablePolicyIds: [], repositories: [{ repository: "owner/app", locationIds: ["app"] },
      { repository: "Owner/Api", locationIds: ["api", "moved", "gone", "missing"] }] } satisfies CampaignAuthorityBoundary;
  const root = { runnerId: "r", workspaceId: "w", projectId: "prj",
    orchestratorPolicy: { control: { mode: "full_control", boundary } } as unknown as SessionView["orchestratorPolicy"] };
  assert.equal(campaignBoundaryRepositoryAt(db, root, { runnerId: "r", workspaceId: "w" }), "owner/app", "the root's own place");
  assert.equal(campaignBoundaryRepositoryAt(db, root, { runnerId: "r2", workspaceId: "a" }), "owner/api");
  for (const place of [{ runnerId: "r2", workspaceId: "m" }, { runnerId: "r3", workspaceId: "g" }, { runnerId: "r2", workspaceId: "x" },
    { runnerId: "r2", workspaceId: null }, { runnerId: "r2" }]) assert.equal(campaignBoundaryRepositoryAt(db, root, place), null, JSON.stringify(place));
  assert.equal(campaignBoundaryRepositoryAt(db, { ...root, projectId: null }, { runnerId: "r2", workspaceId: "a" }), null, "a root outside the Project");
  // A boundary that predates the list has only the root's own place; Custom has none.
  const { repositories: _repositories, ...single } = boundary;
  const legacy = { ...root, orchestratorPolicy: { control: { mode: "full_control", boundary: single } } as unknown as SessionView["orchestratorPolicy"] };
  assert.equal(campaignBoundaryRepositoryAt(db, legacy, { runnerId: "r", workspaceId: "w" }), "owner/app");
  assert.equal(campaignBoundaryRepositoryAt(db, legacy, { runnerId: "r2", workspaceId: "a" }), null);
  const custom = { ...root, orchestratorPolicy: { control: { mode: "custom" } } as unknown as SessionView["orchestratorPolicy"] };
  assert.equal(campaignBoundaryRepositoryAt(db, custom, { runnerId: "r", workspaceId: "w" }), null);
});
