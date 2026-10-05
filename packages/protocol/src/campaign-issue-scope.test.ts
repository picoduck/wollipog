import assert from "node:assert/strict";
import { test } from "node:test";
import { epicChecklistMembers, normalizeCampaignIssueScopeSnapshot } from "./campaign-issue-scope.js";

test("epic member checklists exclude dependencies, prose mentions, external repositories and unrelated sections", () => {
  assert.deepEqual(epicChecklistMembers(`Goal: #99.
## Units
- [ ] #12 Work (depends on: #40; coordinates with #50)
- [x] #13 Done
- [ ] https://github.com/team/repo/issues/14 Work
- [ ] https://github.com/other/repo/issues/15 Other
## Dependencies
- [ ] #16 Dependency
## Members
- [ ] #12 Duplicate
- [ ] #17 Member
## Out of Scope
- [ ] #18 Excluded`, "team/repo"), [12,13,14,17]);
});

test("scope normalization refuses ambiguous and oversized authority, and canonicalizes exact changes", () => {
  const base = { category: "campaign_issue_scope", repository: "Team/Repo", expectedRevision: 0, before: [2,1],
    additions: [4,3], removals: [1], explanation: "Include the epic members", affectedAssignments: [], affectedDecisions: [] };
  const normalized = normalizeCampaignIssueScopeSnapshot(base)!;
  assert.equal(normalized.repository, "team/repo");
  assert.deepEqual(normalized.before, [1,2]);
  assert.deepEqual(normalized.additions, [3,4]);
  for (const patch of [{ additions: [2] }, { removals: [9] }, { additions: [3,3] }, { expectedRevision: -1 },
    { before: Array.from({ length: 100 }, (_, i) => i + 1), additions: [101], removals: [] }, { explanation: "" }]) {
    assert.equal(normalizeCampaignIssueScopeSnapshot({ ...base, ...patch }), null);
  }
});
