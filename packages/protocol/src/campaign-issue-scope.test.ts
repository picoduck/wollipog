import assert from "node:assert/strict";
import { test } from "node:test";
import {
  campaignIssueForgeUrl, campaignScopeChangeBefore, campaignScopeChangeGroups, campaignScopeChangeResult, campaignScopeForRepository, campaignScopeHolds,
  campaignScopeIssues, campaignScopeNumbers, campaignScopeWithIssues, canonicalCampaignIssues, epicChecklistMembers, normalizeCampaignIssueScopeSnapshot,
} from "./campaign-issue-scope.js";
import type { CampaignIssueScope } from "./index.js";

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

const legacy: CampaignIssueScope = { repository: "owner/app", issueNumbers: [12, 5], revision: 3, authorizedByUserId: "usr_owner", authorizedAt: 10 };

test("a scope stored before #4118 reads as its numbers in its repository, at the same revision (#4118)", () => {
  assert.deepEqual(campaignScopeIssues(legacy), [{ repository: "owner/app", number: 5 }, { repository: "owner/app", number: 12 }]);
  assert.deepEqual(campaignScopeNumbers(legacy, "Owner/App"), [5, 12]);
  assert.deepEqual(campaignScopeNumbers(legacy, "owner/api"), []);
  // The launch repository's runner part of a one-repository scope is the stored scope, field for field.
  assert.equal(JSON.stringify(campaignScopeForRepository(legacy, "owner/app")),
    JSON.stringify({ ...legacy, issueNumbers: [5, 12] }));
});

test("repository-qualified scope keeps same-numbered issues apart and gives each runner only its repository (#4118)", () => {
  const scope = campaignScopeWithIssues(legacy, [{ repository: "Owner/Api", number: 5 }, { repository: "owner/app", number: 5 }, { repository: "owner/api", number: 40 }]);
  assert.deepEqual(scope.issues, [{ repository: "owner/api", number: 5 }, { repository: "owner/api", number: 40 }, { repository: "owner/app", number: 5 }]);
  assert.deepEqual([scope.repository, scope.issueNumbers, scope.revision], ["owner/app", [5], 3]);
  assert.ok(campaignScopeHolds(scope, { repository: "OWNER/API", number: 5 }));
  assert.ok(!campaignScopeHolds(scope, { repository: "owner/app", number: 40 }), "a number belongs to its own repository only");
  const api = campaignScopeForRepository(scope, "owner/api");
  assert.deepEqual(api, { repository: "owner/api", issueNumbers: [5, 40], revision: 3, authorizedByUserId: "usr_owner", authorizedAt: 10 });
  assert.equal("issues" in api, false, "runners get the earlier shape");
  // Malformed, duplicated or oversized lists are refused.
  for (const bad of [[{ repository: "owner/app", number: 5 }, { repository: "Owner/App", number: 5 }], [{ repository: "nope", number: 1 }],
    [{ repository: "owner/app", number: 0 }], [{ repository: "owner/app", number: 1, extra: true }],
    Array.from({ length: 101 }, (_, i) => ({ repository: "owner/app", number: i + 1 }))]) {
    assert.equal(canonicalCampaignIssues(bad), null, JSON.stringify(bad).slice(0, 80));
  }
});

test("a scope change snapshot groups every other repository's part and bounds the whole scope (#4118)", () => {
  const base = { category: "campaign_issue_scope", repository: "Owner/App", expectedRevision: 2, before: [5], additions: [], removals: [],
    otherRepositories: [{ repository: "Owner/Api", before: [5], additions: [40], removals: [5] }],
    explanation: "Move work to the api", affectedAssignments: [{ sessionId: "s_child", issue: 5, repository: "Owner/Api" }], affectedDecisions: [] };
  const snapshot = normalizeCampaignIssueScopeSnapshot(base)!;
  assert.deepEqual(snapshot.otherRepositories, [{ repository: "owner/api", before: [5], additions: [40], removals: [5] }]);
  assert.deepEqual(snapshot.affectedAssignments, [{ sessionId: "s_child", issue: 5, repository: "owner/api" }]);
  assert.deepEqual(campaignScopeChangeGroups(snapshot).map((group) => group.repository), ["owner/app", "owner/api"]);
  assert.deepEqual(campaignScopeChangeBefore(snapshot), [{ repository: "owner/api", number: 5 }, { repository: "owner/app", number: 5 }]);
  assert.deepEqual(campaignScopeChangeResult(snapshot), [{ repository: "owner/api", number: 40 }, { repository: "owner/app", number: 5 }]);
  // A snapshot without other repositories normalizes exactly as before.
  assert.equal("otherRepositories" in normalizeCampaignIssueScopeSnapshot({ ...base, additions: [6], otherRepositories: undefined, affectedAssignments: [] })!, false);
  for (const patch of [
    { otherRepositories: [{ repository: "owner/app", before: [], additions: [1], removals: [] }] },
    { otherRepositories: [{ repository: "owner/api", before: [], additions: [1], removals: [] }, { repository: "OWNER/API", before: [], additions: [2], removals: [] }] },
    { otherRepositories: [{ repository: "owner/api", before: [], additions: [], removals: [3] }] },
    { otherRepositories: [{ repository: "owner/api", before: [], additions: [1], removals: [], extra: 1 }] },
    { otherRepositories: [] },
    { otherRepositories: [{ repository: "owner/api", before: Array.from({ length: 100 }, (_, i) => i + 1), additions: [], removals: [] }] },
    { affectedAssignments: [{ sessionId: "s_child", issue: 5, repository: "third/repo" }] },
    { otherRepositories: [{ repository: "owner/api", before: [5], additions: [], removals: [] }] },
  ]) {
    assert.equal(normalizeCampaignIssueScopeSnapshot({ ...base, ...patch }), null, JSON.stringify(patch).slice(0, 120));
  }
});
