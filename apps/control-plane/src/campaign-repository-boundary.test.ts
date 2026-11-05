import assert from "node:assert/strict";
import { test } from "node:test";
import { PROJECT_LOCATION_INSPECTION_FAILURES, type ProjectLocationInspection } from "@wollipog/protocol";
import { launchBoundaryRepositories } from "./campaign-repository-boundary.js";

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
