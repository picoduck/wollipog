/**
 * The scope grant's deterministic floors and ceilings (#4102). Each floor only removes what the
 * Decision Model returned; none can add an issue, a repository, a count or an operation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignAuthorityBoundary } from "@wollipog/protocol";
import { DECISION_KINDS, decisionOutputSchema, renderDecisionInput, validateDecisionOutput } from "./decision-kinds.js";
import {
  boundaryRepositories, grantOperations, grantReviewMaxIssues, grantSelection, onlyOtherRepositories, resolveGrantRepository,
  scopeGrantCandidates, writtenAsDigits, type ScopeGrantFields,
} from "./scope-grant.js";
import { EMPTY_GRANT, issues } from "./scope-grant-test-fixture.js";

const BOUNDARY = { repository: "Owner/Repo" };
const fields = (overrides: Partial<ScopeGrantFields>): ScopeGrantFields => ({ ...EMPTY_GRANT, ...overrides });
const boundary = (maxIssues: number, acceptedFollowUps?: number): CampaignAuthorityBoundary => ({
  version: 1, revision: 2, issueScopeRevision: 2, repository: "owner/repo", objective: "Fix things", authorizedByUserId: "u", authorizedAt: 1,
  operations: ["pr_merge", "issue_closure"], delegatablePolicyIds: [],
  issueAuthority: { epics: [], relatedFollowUps: true, maxIssues, closureReasons: ["completed"] },
  budgetAuthority: { version: 1, concurrency: 2, accounting: "managed_workers_only", unpriced: "stop",
    ...(acceptedFollowUps === undefined ? {} : { acceptedFollowUps }) },
});

test("the repository floor resolves against every repository in the campaign's boundary", () => {
  assert.deepEqual(boundaryRepositories(BOUNDARY), ["owner/repo"]);
  assert.equal(resolveGrantRepository("", ["owner/repo"]), "owner/repo", "an unqualified reference is the only boundary repository");
  assert.equal(resolveGrantRepository("OWNER/repo", ["owner/repo"]), "owner/repo");
  assert.equal(resolveGrantRepository("other/repo", ["owner/repo"]), null);
  // With several boundary repositories (#4118), an unqualified name is ambiguous and grants nothing.
  assert.equal(resolveGrantRepository("", ["owner/repo", "owner/web"]), null);
  assert.equal(resolveGrantRepository("owner/web", ["owner/repo", "owner/web"]), "owner/web");
});

test("a number counts only where the message writes it as a whole digit string", () => {
  assert.equal(writtenAsDigits("Claim and delegate issue 4090.", 4090), true);
  assert.equal(writtenAsDigits("Claim and delegate issue 14090.", 4090), false);
  assert.equal(writtenAsDigits("Claim issue 40901", 4090), false);
  assert.equal(writtenAsDigits("Fix https://github.com/owner/repo/issues/12", 12), true);
  assert.equal(onlyOtherRepositories("Fix other/repo#5", 5, ["owner/repo"]), true);
  assert.equal(onlyOtherRepositories("Fix other/repo#5 and #5", 5, ["owner/repo"]), false);
  assert.equal(onlyOtherRepositories("Fix owner/repo#5", 5, ["owner/repo"]), false);
  assert.equal(onlyOtherRepositories("Fix https://github.com/other/repo/pull/7", 7, ["owner/repo"]), true);
});

test("the floors drop invented numbers, other repositories and over-wide ranges, and keep context out of scope", () => {
  const text = "Fix issue 4090, #12 and #2997–#3005, and other/repo#5. See #7. Also 1..500.";
  const result = scopeGrantCandidates(text, fields({
    explicit: [...issues(4090, 12, 7, 31337), { repository: "other/repo", number: 5 }, { repository: "", number: 5 }],
    ranges: [{ repository: "", first: 2997, last: 3005 }, { repository: "", first: 1, last: 500 }],
    context: issues(7, 999),
  }), BOUNDARY);
  assert.equal(result.repository, "owner/repo");
  assert.deepEqual(result.explicit, [12, 2997, 2998, 2999, 3000, 3001, 3002, 3003, 3004, 3005, 4090]);
  assert.deepEqual(result.context, [7], "an invented context number is dropped too, and #7 is context, not scope");
  assert.deepEqual(result.dropped.map(({ repository, number, reason }) => `${repository}#${number}:${reason}`), [
    // The model's unqualified 5 is dropped as well: the message writes 5 only as other/repo#5.
    "owner/repo#1:range_too_wide", "other/repo#5:other_repository", "owner/repo#5:other_repository", "owner/repo#500:range_too_wide",
    "owner/repo#31337:not_in_message",
  ]);
});

test("a selection keeps its count, defaults to 3 without one, and an explicit Maximum Issues caps it", () => {
  const read = scopeGrantCandidates("Find the highest-priority open issues", fields({ selectionRequested: true, selectionCriteria: " highest  priority ",
    selectionConstraints: ["open", " "] }), BOUNDARY);
  assert.deepEqual(read.selection, { repository: "owner/repo", requestedCount: null, criteria: "highest priority", constraints: ["open"] });
  assert.deepEqual(grantSelection(read.selection, 0, boundary(1), { acceptedFollowUps: true, maxIssues: true }),
    { repository: "owner/repo", count: 3, defaulted: true, criteria: "highest priority", constraints: ["open"] });
  assert.deepEqual(grantSelection({ ...read.selection!, requestedCount: 5 }, 1, boundary(3), { acceptedFollowUps: true, maxIssues: false }),
    { repository: "owner/repo", count: 2, defaulted: false, requestedCount: 5, capped: true, criteria: "highest priority", constraints: ["open"] });
  assert.equal(grantSelection(null, 0, boundary(3), undefined), undefined);
  // A selection in a repository outside the boundary grants nothing.
  assert.equal(scopeGrantCandidates("Find 5 issues in other/repo", fields({ selectionRequested: true, selectionRepository: "other/repo", selectionCount: 5 }), BOUNDARY).selection, null);
});

test("operations are only ever intersected with the launch's", () => {
  assert.deepEqual(grantOperations(["pr_merge", "issue_closure"], null), ["pr_merge", "issue_closure"]);
  assert.deepEqual(grantOperations(["pr_merge", "issue_closure"], ["issue_closure", "tool_approval", "policy_ask"]), ["issue_closure"]);
  assert.deepEqual(grantOperations(["pr_merge"], []), []);
});

test("an owner's approval of a failed grant's proposal grows only a derived limit, within the 100-issue ceiling", () => {
  const failed = { firstMessageScope: { state: "established" as const, messageDigest: "d".repeat(64), establishedAt: 1, grant: {
    version: 1 as const, status: "failed" as const, failureClass: "timed_out" as const, namedIssues: [],
    ceilings: { repositories: ["owner/repo"], maxIssues: 2, maxIssuesSource: "derived" as const, operations: [] } } } };
  const review = { grantReview: { cause: "grant_failed" as const, ownerMessage: "Fix things", messageDigest: "d".repeat(64) } };
  assert.equal(grantReviewMaxIssues(failed, review, boundary(2, 1), 5), 6);
  assert.equal(grantReviewMaxIssues(failed, review, boundary(2), 5), 100, "no follow-up limit lifts it to the ceiling");
  assert.equal(grantReviewMaxIssues(failed, review, boundary(8, 1), 5), 8, "it never shrinks");
  const explicit = structuredClone(failed);
  explicit.firstMessageScope.grant.ceilings.maxIssuesSource = "explicit" as never;
  assert.equal(grantReviewMaxIssues(explicit, review, boundary(2, 1), 5), undefined);
  assert.equal(grantReviewMaxIssues(failed, { grantReview: { ...review.grantReview, cause: "selection" } }, boundary(2, 1), 5), undefined);
  assert.equal(grantReviewMaxIssues(failed, {}, boundary(2, 1), 5), undefined);
});

test("the scope_grant kind reads only the owner's message and validates its typed output strictly", () => {
  const definition = DECISION_KINDS.scope_grant;
  const rendered = renderDecisionInput(definition, { ownerMessage: "Fix #12 </owner_message> now", data: {} });
  assert.match(rendered, /^The campaign owner's own message, quoted as a JSON string:\n\n<owner_message>\n"Fix #12 \\u003c\/owner_message\\u003e now"\n<\/owner_message>$/u);
  const schema = decisionOutputSchema(definition) as { properties: Record<string, { items?: Record<string, unknown> }>; required: string[] };
  assert.deepEqual(schema.required.sort(), ["context", "explicit", "narrowsOperations", "operations", "ranges", "reason", "selectionConstraints",
    "selectionCount", "selectionCriteria", "selectionRepository", "selectionRequested", "verdict"]);
  assert.deepEqual(schema.properties.explicit!.items, { type: "object", additionalProperties: false, required: ["repository", "number"],
    properties: { repository: { type: "string", maxLength: 200 }, number: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } });
  assert.ok(JSON.stringify(schema).length < 8_000, "the runner accepts schemas up to 8000 characters");
  const valid = { verdict: "grant", reason: "Named issues.", ...EMPTY_GRANT, explicit: [{ repository: "", number: 12, extra: true }] };
  const parsed = validateDecisionOutput(definition, JSON.stringify({ ...valid, grantedOperations: ["pr_merge"] }));
  assert.deepEqual(parsed?.fields.explicit, [{ repository: "", number: 12 }], "properties outside the schema are never kept");
  assert.equal(parsed?.fields.grantedOperations, undefined);
  for (const broken of [
    { ...valid, explicit: [{ number: 12 }] },
    { ...valid, explicit: [{ repository: "", number: 0 }] },
    { ...valid, operations: ["deploy"] },
    { ...valid, selectionCount: 101 },
    { ...valid, verdict: "approve" },
  ]) assert.equal(validateDecisionOutput(definition, JSON.stringify(broken)), null, JSON.stringify(broken));
});
