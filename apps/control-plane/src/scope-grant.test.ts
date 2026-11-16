/**
 * The scope grant's deterministic floors and ceilings (#4102). Each floor only removes what the
 * Decision Model returned; none can add an issue, a repository, a count or an operation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CampaignAuthorityBoundary } from "@wollipog/protocol";
import { DECISION_KINDS, decisionOutputSchema, renderDecisionInput, validateDecisionOutput } from "./decision-kinds.js";
import {
  boundaryRepositories, exactNamedRepositoryLimit, grantOperations, grantReviewMaxIssues, grantSelection, messageNamesRepository, onlyOtherRepositories, repositoryNameInMessage, resolveGrantRepository, resolveRepositoryName,
  writtenAsCount, writtenAsDigits, writtenAsRange, writtenForRepository, writtenRangeMembersForRepository,
} from "./scope-grant.js";
import { issueReferencesAcrossRepositories } from "./campaign-launch-admission.js";

test("literal range spelling is bounded and keeps the first endpoint's repository", () => {
  for (const text of ["#10–#14", "#10—#14", "#10-#14", "issues 10 through 14", "#10..#14", "#10 to #14"]) {
    assert.deepEqual([...writtenRangeMembersForRepository(text, "owner/repo", "owner/repo")], [10, 11, 12, 13, 14], text);
  }
  const foreign = "other/repo#10–#14";
  assert.deepEqual([...writtenRangeMembersForRepository(foreign, "owner/repo", "owner/repo")], []);
  assert.deepEqual([...writtenRangeMembersForRepository(foreign, "other/repo", "owner/repo")], [10, 11, 12, 13, 14]);
  for (const text of ["#10 and #14", "#10 through", "through #14", "#14–#10", "#0–#5", "#1–#101", "10–14", "#10–other/repo#14"]) {
    assert.deepEqual([...writtenRangeMembersForRepository(text, "owner/repo", "owner/repo")], [], text);
  }
  assert.equal(writtenRangeMembersForRepository("#1–#100", "owner/repo", "owner/repo").size, 100);
});
import { EMPTY_GRANT } from "./scope-grant-test-fixture.js";

test("the campaign launch request proves only its named repository, never another limit (#4402)", () => {
  const message = "Use the orchestrate-issues skill to fix #4398, #4399, #4400, #4401, #4402, #4403, #4404 and #4405 in picoduck/wollipog. Each issue specifies its behavior and acceptance criteria. Follow them, say so in each PR, and close each issue only after verifying every criterion against merged main.";
  const entries = [{ repository: "picoduck/wollipog" }, { repository: "misko19/dev-box-setup" }];
  const refs = Array.from({ length: 8 }, (_, i) => ({ repository: entries[0]!.repository, number: 4398 + i }));
  const proposed = refs.map((ref) => ({ ...ref, origin: "owner_named" }));
  assert.equal(exactNamedRepositoryLimit(message, entries, proposed, refs), "picoduck/wollipog");
  for (const changed of [message.replace(" in picoduck", " not in picoduck"), message + " Also misko19/dev-box-setup.",
    message + " But not in picoduck/wollipog.", message.replace("to fix", "to discuss")]) {
    assert.equal(exactNamedRepositoryLimit(changed, entries, proposed, refs), null, changed);
  }
  assert.equal(exactNamedRepositoryLimit(message, entries, proposed.slice(1), refs), null);
  assert.equal(exactNamedRepositoryLimit(message, entries, [...proposed, { repository: entries[1]!.repository, number: 1, origin: "owner_named" }], refs), null);
  assert.equal(exactNamedRepositoryLimit(message, entries, proposed, [...refs, { repository: entries[1]!.repository, number: 1 }]), null);
});

const BOUNDARY = { repository: "Owner/Repo" };
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

test("a repository name means one boundary repository, or nothing (#4118)", () => {
  const entries = [{ repository: "owner/app", locationNames: ["Web Client"] }, { repository: "Owner/API", locationNames: ["Backend", "Shared"] },
    { repository: "other/tools", locationNames: ["Shared"] }, { repository: "fork/tools" }];
  for (const name of ["owner/api", "OWNER/API", "api", "the api repo", "The API repository", "Backend", "the backend repo"]) assert.equal(resolveRepositoryName(name, entries), "owner/api", name);
  assert.equal(resolveRepositoryName("web client", entries), "owner/app");
  // Several matches, by short name or Location name, or none: nothing.
  for (const name of ["tools", "the tools repo", "shared", "billing", "repo", "the", " "]) assert.equal(resolveRepositoryName(name, entries), null, name);
  assert.equal(repositoryNameInMessage("Fix bugs in  The API\nrepo please.", "the api repo"), true);
  assert.equal(repositoryNameInMessage("Fix bugs please.", "the api repo"), false);
  // Whole words only: a name inside a longer word was never written.
  assert.equal(repositoryNameInMessage("Fix this rapidly.", "api"), false);
  assert.equal(repositoryNameInMessage("Fix the api-gateway first.", "api"), false);
  assert.equal(repositoryNameInMessage("Fix the top bug in api.", "api"), true);
  assert.equal(repositoryNameInMessage("Fix owner/api (the top bug).", "owner/api"), true);
  assert.equal(repositoryNameInMessage("Fix my-org/my.repo first.", "my-org/my.repo"), true);
  assert.equal(repositoryNameInMessage("Fix my-org/myxrepo first.", "my-org/my.repo"), false, "the name is literal text");
  assert.equal(repositoryNameInMessage("Fix it.", " "), false);
  // A repository's name as words of the message's own, never inside an issue reference (#4117).
  const named = [{ repository: "owner/api", locationNames: ["Docs Folder"] }, { repository: "owner/web" }];
  assert.equal(messageNamesRepository("Fix bugs in owner/api.", named), true);
  assert.equal(messageNamesRepository("Fix bugs in the web repo.", named), true);
  assert.equal(messageNamesRepository("Fix bugs in docs folder.", named), true);
  assert.equal(messageNamesRepository("Fix owner/api#12 and owner/web#3.", named), false);
  assert.equal(messageNamesRepository("Fix https://github.com/owner/web/issues/3 rapidly.", named), false);
  assert.equal(messageNamesRepository("Fix owner/web#3, then the api.", named), true);
  assert.equal(messageNamesRepository("Fix everything.", named), false);
  // Every Location name the resolver accepts counts, whichever way the message writes it.
  const alias = [{ repository: "owner/backend", locationNames: ["The API Repository"] }, { repository: "owner/web" }];
  assert.equal(resolveRepositoryName("api", alias), "owner/backend");
  for (const message of ["Fix #12 in api only.", "Fix #12 in the api repo only.", "Fix #12 in The API Repository only."]) {
    assert.equal(messageNamesRepository(message, alias), true, message);
  }
  assert.equal(messageNamesRepository("Fix #12 rapidly.", alias), false);
});

test("a number is written for a repository only where the message qualifies it so; a bare one is the launch repository's (#4118)", () => {
  const text = "Fix #12, owner/api#40, https://github.com/owner/api/issues/41 and owner/app#7. Also other/repo#9.";
  assert.equal(writtenForRepository(text, 12, "owner/app", "owner/app"), true);
  assert.equal(writtenForRepository(text, 12, "owner/api", "owner/app"), false, "a bare number names nothing in another repository");
  assert.equal(writtenForRepository(text, 40, "OWNER/API", "owner/app"), true);
  assert.equal(writtenForRepository(text, 40, "owner/app", "owner/app"), false, "qualified by another repository, it is that repository's");
  assert.equal(writtenForRepository(text, 41, "owner/api", "owner/app"), true);
  assert.equal(writtenForRepository(text, 7, "owner/app", "owner/app"), true);
  assert.equal(writtenForRepository(text, 9, "owner/app", "owner/app"), false);
  assert.deepEqual(issueReferencesAcrossRepositories(text, "owner/app", ["owner/app", "owner/api"]), [{ repository: "owner/app", number: 7 },
    { repository: "owner/app", number: 12 }, { repository: "owner/api", number: 40 }, { repository: "owner/api", number: 41 }]);
  assert.deepEqual(boundaryRepositories({ repository: "Owner/App", repositories: [{ repository: "owner/app", locationIds: ["l"] }, { repository: "Owner/API", locationIds: ["m"] }] }),
    ["owner/app", "owner/api"]);
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

test("range and count spelling floors keep separate numbers separate", () => {
  for (const text of ["Fix #10–#14", "Fix #10-#14", "Fix #10..#14", "Fix issues 10 through 14", "Fix #10 to issue #14", "Fix 10-14"])
    assert.equal(writtenAsRange(text, 10, 14), true, text);
  assert.equal(writtenAsRange("Fix #10 and #14", 10, 14), false);
  assert.equal(writtenAsRange("See #10, then fix everything up to #14", 10, 14), false);
  assert.equal(writtenAsCount("Find the five highest-priority issues", 5), true);
  assert.equal(writtenAsCount("Find the 5 highest-priority issues", 5), true);
  assert.equal(writtenAsCount("Find the highest-priority issues", 50), false);
});

test("operations are only ever intersected with the launch's", () => {
  assert.deepEqual(grantOperations(["pr_merge", "issue_closure"], null), ["pr_merge", "issue_closure"]);
  assert.deepEqual(grantOperations(["pr_merge", "issue_closure"], ["issue_closure", "tool_approval", "policy_ask"]), ["issue_closure"]);
  assert.deepEqual(grantOperations(["pr_merge"], []), []);
});

test("an owner's approval of a failed grant's proposal grows only a derived limit, within the 100-issue ceiling", () => {
  const failed = { firstMessageScope: { state: "established" as const, messageDigest: "d".repeat(64), establishedAt: 1,
    derivedLimits: { acceptedFollowUps: true, maxIssues: true }, grant: {
    version: 1 as const, status: "failed" as const, failureClass: "timed_out" as const, namedIssues: [],
    ceilings: { repositories: ["owner/repo"], maxIssues: 2, maxIssuesSource: "derived" as const, operations: [] } } } };
  const review = { grantReview: { cause: "grant_failed" as const, ownerMessage: "Fix things", messageDigest: "d".repeat(64) } };
  assert.equal(grantReviewMaxIssues(failed, review, boundary(2, 1), 5), 6);
  assert.equal(grantReviewMaxIssues(failed, review, boundary(2), 5), 100, "no follow-up limit lifts it to the ceiling");
  assert.equal(grantReviewMaxIssues(failed, review, boundary(8, 1), 5), 8, "it never shrinks");
  const explicit = structuredClone(failed);
  explicit.firstMessageScope.grant.ceilings.maxIssuesSource = "explicit" as never;
  assert.equal(grantReviewMaxIssues(explicit, review, boundary(2, 1), 5), undefined);
  // A later authorization that set Maximum Issues explicitly ends the growth, whatever the grant recorded.
  const reauthorized = structuredClone(failed);
  reauthorized.firstMessageScope.derivedLimits.maxIssues = false;
  assert.equal(grantReviewMaxIssues(reauthorized, review, boundary(2, 1), 5), undefined);
  const { derivedLimits: _none, ...unrecorded } = failed.firstMessageScope;
  assert.equal(grantReviewMaxIssues({ firstMessageScope: unrecorded }, review, boundary(2, 1), 5), undefined);
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

test("live selection ceilings keep defaults, narrowing and explicit caps", () => {
  const selection = { repository: "owner/repo", requestedCount: null, criteria: "highest priority", constraints: ["open"] };
  const read = (changes: Partial<typeof selection & { unstatedCount: number }> = {}) =>
    grantSelection({ ...selection, ...changes }, 0, boundary(1), { acceptedFollowUps: true, maxIssues: true });
  assert.equal(read()!.count, 3);
  assert.equal(read({ unstatedCount: 50 })!.count, 3);
  assert.equal(read({ unstatedCount: 2 })!.count, 2);
  assert.equal(grantSelection({ ...selection, requestedCount: 5 }, 1, boundary(3), { acceptedFollowUps: true, maxIssues: false })!.count, 2);
  assert.equal(grantSelection(null, 0, boundary(3), undefined), undefined);
});
