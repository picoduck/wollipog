import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignIssueForgeUrl, epicChecklistMembers, normalizeCampaignIssueScopeSnapshot } from "./campaign-issue-scope.js";

test("GitLab epic checklists accept #N and same-project issue URLs only (#3539)", () => {
  assert.deepEqual(epicChecklistMembers(`Goal: #99.
## Units
- [ ] #12 Work (depends on #40)
- [x] https://gitlab.example.com/Platform/Backend/Service/-/issues/13 Done
- [ ] http://GITLAB.example.com/platform/backend/service/-/issues/14 Insecure scheme, same project
- [ ] https://gitlab.example.com/platform/backend/other/-/issues/15 Other project
- [ ] https://gitlab.example.com/platform/backend/service/sub/-/issues/16 Nested project
- [ ] https://elsewhere.example.com/platform/backend/service/-/issues/17 Other host
- [ ] https://github.com/platform/backend/issues/18 GitHub
- [ ] https://gitlab.example.com/platform/backend/service/-/merge_requests/19 Merge request
## Dependencies
- [ ] #20 Dependency`, "gitlab.example.com/platform/backend/service"), [12, 13, 14]);
  assert.deepEqual(epicChecklistMembers("## Members\n- [ ] https://gitlab.example.com:8443/group/project/-/issues/3\n- [ ] https://gitlab.example.com/group/project/-/issues/4",
    "gitlab.example.com:8443/group/project"), [3]);
  // A GitHub repository keeps reading GitHub URLs only.
  assert.deepEqual(epicChecklistMembers("## Units\n- [ ] https://gitlab.example.com/team/repo/-/issues/5\n- [ ] https://github.com/team/repo/issues/6", "team/repo"), [6]);
});

test("forge web addresses are exact per forge (#3539)", () => {
  assert.equal(campaignIssueForgeUrl("https://github.com/team/repo/issues/7", "team/repo", "issue", 7), true);
  assert.equal(campaignIssueForgeUrl("https://github.com/team/repo/pull/7", "team/repo", "change", 7), true);
  assert.equal(campaignIssueForgeUrl("https://github.com/Team/repo/issues/7", "team/repo", "issue", 7), false);
  const repository = "gitlab.example.com:8443/Platform/Backend/Service";
  assert.equal(campaignIssueForgeUrl("https://gitlab.example.com:8443/platform/backend/service/-/issues/7", repository, "issue", 7), true);
  assert.equal(campaignIssueForgeUrl("http://gitlab.example.com:8443/Platform/Backend/Service/-/merge_requests/7", repository, "change", 7), true);
  for (const url of [
    "https://gitlab.example.com/Platform/Backend/Service/-/issues/7",
    "https://gitlab.example.com:8443/Platform/Backend/Other/-/issues/7",
    "https://gitlab.example.com:8443/Platform/Backend/Service/-/issues/8",
    "https://gitlab.example.com:8443/Platform/Backend/Service/issues/7",
    "https://gitlab.example.com:8443/Platform/Backend/Service/-/merge_requests/7",
    "https://user@gitlab.example.com:8443/Platform/Backend/Service/-/issues/7",
    "https://gitlab.example.com:8443/Platform/Backend/Service/-/issues/7?x=1",
    "ftp://gitlab.example.com:8443/Platform/Backend/Service/-/issues/7",
  ]) assert.equal(campaignIssueForgeUrl(url, repository, "issue", 7), false, url);
  assert.equal(campaignIssueForgeUrl("https://gitlab.example.com/group/project/-/issues/7", "group/sub/project", "issue", 7), false, "a bare namespace is not a repository");
});

test("GitLab scope snapshots are host-qualified and canonicalized in lower case (#3539)", () => {
  const base = { category: "campaign_issue_scope", expectedRevision: 0, before: [], additions: [3], removals: [],
    explanation: "Include the epic members", affectedAssignments: [], affectedDecisions: [] };
  assert.equal(normalizeCampaignIssueScopeSnapshot({ ...base, repository: "GitLab.Example.com/Platform/Backend/Service" })?.repository,
    "gitlab.example.com/platform/backend/service");
  assert.equal(normalizeCampaignIssueScopeSnapshot({ ...base, repository: "gitlab.example.com:8443/group/project" })?.repository, "gitlab.example.com:8443/group/project");
  for (const repository of ["platform/backend/service", "github.com/team/repo", "https://gitlab.example.com/group/project", "gitlab.example.com/group/project.git"]) {
    assert.equal(normalizeCampaignIssueScopeSnapshot({ ...base, repository }), null, repository);
  }
});

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
