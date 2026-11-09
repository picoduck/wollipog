import assert from "node:assert/strict";
import { test } from "node:test";
import {
  campaignIssueForgeUrl, campaignScopeChangeBefore, campaignScopeChangeGroups, campaignScopeChangeResult, campaignScopeForRepository, campaignScopeHolds,
  campaignScopeIssues, campaignScopeNumbers, campaignScopeWithIssues, canonicalCampaignIssues, epicChecklistMembers, normalizeCampaignIssueScopeSnapshot,
} from "./campaign-issue-scope.js";
import type { CampaignIssueScope } from "./index.js";

test("a proposal's issues are exactly each repository's additions, with a launch issue left bare (#4118, #4282)", () => {
  const issue = (number: number, repository?: string) => ({ ...(repository ? { repository } : {}), number, origin: "owner_named", rationale: "Named", title: "" });
  const snapshot = (issues: ReturnType<typeof issue>[], other: Record<string, unknown> = { repository: "owner/api", before: [], additions: [40], removals: [] }, additions = [12]) =>
    normalizeCampaignIssueScopeSnapshot({ category: "campaign_issue_scope", repository: "owner/app", expectedRevision: 1, before: [], additions, removals: [],
      otherRepositories: [other], explanation: "Reasons", affectedAssignments: [], affectedDecisions: [], activeChildren: [],
      scopeProposal: { initial: true, messageDigest: "a".repeat(64), issues, requestedCount: null, constraints: [], withheldOperations: [], checks: [], route: "owner",
        ownerCause: "constraint_check_unavailable", ownerMessage: "Fix them." } });
  assert.deepEqual(snapshot([issue(12), issue(40, "owner/api")])!.scopeProposal!.issues.map((i) => [i.repository, i.number]), [[undefined, 12], ["owner/api", 40]]);
  // The same numbers in the wrong repositories, a missing one, an extra one, an unknown repository and a removal are all refused.
  assert.equal(snapshot([issue(40), issue(12, "owner/api")]), null);
  assert.equal(snapshot([issue(12)]), null);
  assert.equal(snapshot([issue(12), issue(40, "owner/api"), issue(41, "owner/api")]), null);
  assert.equal(snapshot([issue(12), issue(40, "owner/web")]), null);
  assert.equal(snapshot([issue(12, "owner/app"), issue(40, "owner/api")]), null, "a launch issue stays bare");
  assert.equal(snapshot([issue(12)], { repository: "owner/api", before: [40], additions: [], removals: [40] }), null, "a proposal adds issues only");
  assert.equal(snapshot([issue(12)], { repository: "owner/api", before: [40], additions: [], removals: [] })!.otherRepositories![0]!.before[0], 40,
    "another repository the scope merely holds is fine");
});

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

test("selection lineage, its review evidence and its owner causes keep their exact shapes (#4103)", () => {
  const base = { category: "campaign_issue_scope", repository: "team/repo", expectedRevision: 1, before: [], additions: [3],
    removals: [], explanation: "Highest priority", affectedAssignments: [], affectedDecisions: [], lineage: { kind: "selection" } };
  const review = { occurrenceId: "dec_1", grantDigest: "a".repeat(64), verdict: "admit", reason: "Fits." };
  assert.deepEqual(normalizeCampaignIssueScopeSnapshot({ ...base, selectionReview: review })?.selectionReview, review);
  assert.deepEqual(normalizeCampaignIssueScopeSnapshot(base)?.lineage, { kind: "selection" });
  for (const bad of [{ ...review, verdict: "refuse" }, { ...review, grantDigest: "x" }, { ...review, extra: 1 }, { ...review, reason: "r".repeat(301) }]) {
    assert.equal(normalizeCampaignIssueScopeSnapshot({ ...base, selectionReview: bad }), null);
  }
  assert.equal(normalizeCampaignIssueScopeSnapshot({ ...base, lineage: { kind: "selection", epic: 1 } }), null);
  const grantReview = { ownerMessage: "Find the 3 highest-priority issues", messageDigest: "b".repeat(64), reviewOccurrenceId: "dec_2" };
  for (const cause of ["selection_uncertain", "selection_failed", "selection_unverified", "selection"]) {
    assert.ok(normalizeCampaignIssueScopeSnapshot({ ...base, grantReview: { ...grantReview, cause } }), cause);
  }
  assert.equal(normalizeCampaignIssueScopeSnapshot({ ...base, grantReview: { ...grantReview, cause: "selection_admitted" } }), null);
});

test("an owner review keeps its exact shape and never rides with an admission, a grant review or lineage (#4267)", () => {
  const base = { category: "campaign_issue_scope", repository: "team/repo", expectedRevision: 1, before: [1], additions: [3, 4],
    removals: [], explanation: "The owner asked for these", affectedAssignments: [], affectedDecisions: [] };
  const plain = { cause: "lineage_missing" };
  const raised = { cause: "lineage_missing", maxIssuesIncrease: { from: 2, increase: 1 } };
  assert.deepEqual(normalizeCampaignIssueScopeSnapshot({ ...base, ownerReview: plain })?.ownerReview, plain);
  assert.deepEqual(normalizeCampaignIssueScopeSnapshot({ ...base, ownerReview: raised })?.ownerReview, raised);
  for (const bad of [{ cause: "selection" }, { ...plain, extra: 1 }, { ...plain, maxIssuesIncrease: { from: 2, increase: 0 } },
    { ...plain, maxIssuesIncrease: { from: 0, increase: 1 } }, { ...plain, maxIssuesIncrease: { from: 99, increase: 2 } },
    { ...plain, maxIssuesIncrease: { from: 2, increase: 1, to: 3 } }, { ...plain, maxIssuesIncrease: { from: 2.5, increase: 1 } }, [], "lineage_missing"]) {
    assert.equal(normalizeCampaignIssueScopeSnapshot({ ...base, ownerReview: bad }), null, JSON.stringify(bad));
  }
  for (const companion of [{ issueAdmission: { boundaryRevision: 1, evidenceDigest: "a".repeat(64) } }, { lineage: { kind: "epic", epic: 1 } },
    { grantReview: { cause: "grant_failed", ownerMessage: "Fix it", messageDigest: "b".repeat(64) } },
    { selectionReview: { occurrenceId: "dec_1", grantDigest: "a".repeat(64), verdict: "admit", reason: "Fits." } }]) {
    assert.equal(normalizeCampaignIssueScopeSnapshot({ ...base, ownerReview: plain, ...companion }), null, JSON.stringify(companion));
  }
});

test("#4333 owner review causes retain only matching lineage and reject agent-shaped extensions", () => {
  const base = { category: "campaign_issue_scope", repository: "team/repo", expectedRevision: 1, before: [1], additions: [2],
    removals: [], explanation: "Owner review", affectedAssignments: [], affectedDecisions: [] };
  for (const cause of ["epic_not_authorized", "follow_ups_not_authorized", "publication_unapproved", "publication_authority_changed",
    "publication_approved_under_earlier_boundary", "publication_approver_not_owner", "selection_not_granted"]) {
    const lineage = cause === "epic_not_authorized" ? { kind: "epic", epic: 99 }
      : cause === "selection_not_granted" ? { kind: "selection" } : { kind: "follow_up", publicationOccurrenceId: "published" };
    const snapshot = { ...base, lineage, ownerReview: { cause } };
    assert.deepEqual(normalizeCampaignIssueScopeSnapshot(snapshot)?.ownerReview, { cause });
    assert.equal(normalizeCampaignIssueScopeSnapshot({ ...snapshot, lineage: undefined }), null);
    assert.equal(normalizeCampaignIssueScopeSnapshot({ ...snapshot, ownerReview: { cause, settledPublication: "forged" } }), null);
    assert.equal(normalizeCampaignIssueScopeSnapshot({ ...snapshot, issueAdmission: { boundaryRevision: 1, evidenceDigest: "a".repeat(64) } }), null);
  }
});
