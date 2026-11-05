import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAMPAIGN_BOUNDARY_LOCATIONS_MAX, CAMPAIGN_BOUNDARY_REPOSITORIES_MAX, PROTOCOL_VERSION,
  campaignAuthorityPreflight, campaignBoundaryRepositories, campaignBoundaryRepository, validCampaignControl,
  type CampaignAuthorityBoundary, type CampaignControl,
} from "./index.js";

const boundary: CampaignAuthorityBoundary = { version: 1, revision: 1, issueScopeRevision: 1, repository: "owner/repo",
  objective: "Deliver #1", authorizedByUserId: "usr_owner", authorizedAt: 1, operations: ["pr_merge"], delegatablePolicyIds: [] };
const control = (repositories: unknown): CampaignControl =>
  ({ mode: "full_control", boundary: { ...boundary, repositories } as CampaignAuthorityBoundary });

test("a boundary's repository list is one entry per repository, led by the boundary's repository (#4117)", () => {
  assert.ok(validCampaignControl(control([{ repository: "owner/repo", locationIds: ["loc_a", "loc_b"] },
    { repository: "other/repo", locationIds: ["loc_c"] }, { repository: "gitlab.example.com/group/project", locationIds: [] }])));
  assert.ok(validCampaignControl(control([{ repository: "Owner/Repo", locationIds: ["loc_a"] }])), "repositories compare case-insensitively");
  const invalid: unknown[] = [
    [],
    {},
    [{ repository: "other/repo", locationIds: [] }],
    [{ repository: "owner/repo", locationIds: [] }, { repository: "OWNER/repo", locationIds: [] }],
    [{ repository: "owner/repo", locationIds: ["loc_a"] }, { repository: "other/repo", locationIds: ["loc_a"] }],
    [{ repository: "owner/repo", locationIds: ["loc_a", "loc_a"] }],
    [{ repository: "owner/repo", locationIds: [""] }],
    [{ repository: "owner/repo", locationIds: ["loc\na"] }],
    [{ repository: "owner/repo", locationIds: [7] }],
    [{ repository: "owner/repo" }],
    [{ repository: "owner/repo", locationIds: [], path: "/home/owner/repo" }],
    [{ repository: "https://github.com/owner/repo", locationIds: [] }],
    [null],
    [{ repository: "owner/repo", locationIds: [] }, ...Array.from({ length: CAMPAIGN_BOUNDARY_REPOSITORIES_MAX }, (_, n) => ({ repository: `o/r${n}`, locationIds: [] }))],
    [{ repository: "owner/repo", locationIds: Array.from({ length: CAMPAIGN_BOUNDARY_LOCATIONS_MAX + 1 }, (_, n) => `loc_${n}`) }],
  ];
  for (const repositories of invalid) assert.equal(validCampaignControl(control(repositories)), false, JSON.stringify(repositories).slice(0, 120));
});

test("a boundary minted before the list reads as one entry of its repository (#4117)", () => {
  assert.ok(validCampaignControl({ mode: "full_control", boundary }));
  assert.deepEqual(campaignBoundaryRepositories(boundary), [{ repository: "owner/repo", locationIds: [] }]);
  const listed = { ...boundary, repositories: [{ repository: "owner/repo", locationIds: ["loc_a"] }, { repository: "other/repo", locationIds: ["loc_b"] }] };
  assert.deepEqual(campaignBoundaryRepository(listed, "OTHER/REPO"), { repository: "other/repo", locationIds: ["loc_b"] });
  assert.equal(campaignBoundaryRepository(listed, "third/repo"), null);
  const copy = campaignBoundaryRepositories(listed);
  copy[0]!.locationIds.push("loc_z");
  assert.deepEqual(listed.repositories[0]!.locationIds, ["loc_a"], "readers get a copy, never the stored list");
});

test("only a v286 runner can enforce a boundary with a repository list (#4117)", () => {
  const listed = control([{ repository: "owner/repo", locationIds: ["loc_a"] }]);
  assert.equal(campaignAuthorityPreflight(listed, "claude-code", PROTOCOL_VERSION).supported, true);
  const older = campaignAuthorityPreflight(listed, "claude-code", 285);
  assert.equal(older.supported, false);
  assert.match(JSON.stringify(older), /286/);
  assert.equal(campaignAuthorityPreflight({ mode: "full_control", boundary }, "claude-code", 284).supported, true);
});
