import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { CampaignLaunchProposal } from "@wollipog/protocol";
import { campaignLaunchDigest, derivedLaunchLimits, firstMessageBoundary, firstMessageDigest, firstMessageIssues, firstMessageLaunch, firstMessageObjective, issueReferencesInMessage,
  parseCampaignLaunchProposal, parseFullControlLaunchRequest } from "./campaign-launch-admission.js";

const proposal: CampaignLaunchProposal = { repository: "Owner/Repo", issueNumbers: [12], objective: "Deliver #12",
  operations: ["implementation_question", "pr_merge"], delegatablePolicyIds: [],
  issueAuthority: { epics: [12], relatedFollowUps: false, maxIssues: 10, closureReasons: ["completed"] },
  budgetAuthority: { version: 1, costUsd: 20, toolCalls: 200, concurrency: 2, acceptedFollowUps: 0,
    accounting: "managed_workers_only", unpriced: "stop" } };

test("launch proposals preserve finite Human intent and reject injected provenance and partial limits", () => {
  const parsed = parseCampaignLaunchProposal(proposal)!;
  assert.equal(parsed.repository, "owner/repo");
  assert.equal(proposal.repository, "Owner/Repo");
  for (const field of ["authorizedByUserId", "authorizedAt", "revision", "ready", "executionProfile", "evidenceAuthority"]) {
    assert.equal(parseCampaignLaunchProposal({ ...proposal, [field]: "injected" }), null);
  }
  for (const field of ["concurrency", "acceptedFollowUps"]) {
    const budget = { ...proposal.budgetAuthority } as Record<string, unknown>;
    delete budget[field];
    assert.equal(parseCampaignLaunchProposal({ ...proposal, budgetAuthority: budget }), null);
  }
  // A cost or tool-call ceiling is optional: an absent one has no limit, and each present one stays.
  for (const omitted of [["costUsd"], ["toolCalls"], ["costUsd", "toolCalls"]]) {
    const budget = { ...proposal.budgetAuthority } as Record<string, unknown>;
    for (const field of omitted) delete budget[field];
    const unbounded = parseCampaignLaunchProposal({ ...proposal, budgetAuthority: budget as unknown as CampaignLaunchProposal["budgetAuthority"] })!;
    assert.ok(unbounded, omitted.join(","));
    for (const field of omitted) assert.equal(field in unbounded.budgetAuthority, false, field);
  }
  for (const invalid of [{ costUsd: 0 }, { costUsd: Number.POSITIVE_INFINITY }, { toolCalls: 0 }, { toolCalls: 1.5 }]) {
    assert.equal(parseCampaignLaunchProposal({ ...proposal, budgetAuthority: { ...proposal.budgetAuthority, ...invalid } }), null, JSON.stringify(invalid));
  }
  assert.equal(parseCampaignLaunchProposal({ ...proposal, issueAuthority: { epics: "not-an-array" } }), null);
});

test("generated exact issue scopes normalize idempotently without mutation and reject every extra authority field", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 100 }), fc.jsonValue(),
    (numbers, injected) => {
      const input = { ...structuredClone(proposal), issueNumbers: numbers, issueAuthority: { ...proposal.issueAuthority, epics: [], maxIssues: 100 } };
      const before = structuredClone(input);
      const parsed = parseCampaignLaunchProposal(input)!;
      assert.ok(parsed);
      assert.deepEqual(input, before);
      assert.deepEqual(parseCampaignLaunchProposal(parsed), parsed);
      assert.deepEqual(new Set(parsed.issueNumbers), new Set(numbers));
      assert.equal(parseCampaignLaunchProposal({ ...input, authorizedByUserId: injected }), null);
      assert.equal(campaignLaunchDigest(parsed), campaignLaunchDigest({ ...parsed, issueAuthority: { ...parsed.issueAuthority } }));
    }));
});

test("a first message's issue references name only the campaign's own repository (#2940)", () => {
  const text = [
    "Fix #12, Owner/Repo#7 and https://github.com/owner/repo/issues/9#issuecomment-1.",
    "Ignore other/repo#5, owner/repo-fork#4, https://github.com/other/repo/issues/6 and https://github.com/owner/repo/pull/8.",
    "Not references: issue#11, a/b/owner/repo#13, ##14, #0, #15abc, 16#17, `#12` again.",
  ].join("\n");
  assert.deepEqual(issueReferencesInMessage(text, "owner/repo"), [7, 9, 12]);
  assert.deepEqual(issueReferencesInMessage("No references at all.", "owner/repo"), []);
  assert.deepEqual(issueReferencesInMessage("Ship other/repo#1 only.", "owner/repo"), []);
  const many = Array.from({ length: 150 }, (_, index) => `#${index + 1}`).join(" ");
  assert.equal(issueReferencesInMessage(many, "owner/repo").length, 100, "a scope holds at most 100 issues");
});

test("a first message becomes a one-line bounded objective, and its digest binds the exact text", () => {
  assert.equal(firstMessageObjective("  Ship #12\n\n\tthen\u0007 tidy  "), "Ship #12 then tidy");
  const long = firstMessageObjective("x".repeat(5000));
  assert.equal(long.length, 4000);
  assert.ok(long.endsWith("…"));
  assert.notEqual(firstMessageDigest("Ship #12"), firstMessageDigest("Ship #12 "));
  assert.match(firstMessageDigest("Ship #12"), /^[a-f0-9]{64}$/u);
});

test("a launch naming no task, issues or objective waits for its first message", () => {
  const empty = parseFullControlLaunchRequest({ runnerId: "r", workspaceId: "w" }, false)!;
  assert.ok(empty);
  assert.equal(firstMessageLaunch(empty), true);
  assert.equal(firstMessageLaunch({ task: "Ship it" }), false);
  assert.equal(firstMessageLaunch({ issueNumbers: [12] }), false);
  assert.equal(firstMessageLaunch({ issueNumbers: [] }), true);
  assert.equal(firstMessageLaunch({ overrides: { objective: "Ship it" } }), false);
  assert.equal(parseFullControlLaunchRequest({ runnerId: "r" }, false), null);
});

test("the first message's boundary keeps every authority and only grows follow-up and issue limits to fit its issues", () => {
  const boundary = { version: 1 as const, revision: 1, issueScopeRevision: 1, repository: "owner/repo", objective: "placeholder",
    authorizedByUserId: "u", authorizedAt: 1, operations: ["pr_merge" as const], delegatablePolicyIds: ["p"],
    issueAuthority: { epics: [], relatedFollowUps: true, maxIssues: 1, closureReasons: ["completed" as const] },
    budgetAuthority: { version: 1 as const, costUsd: 5, concurrency: 2, acceptedFollowUps: 1, accounting: "managed_workers_only" as const, unpriced: "stop" as const } };
  const derived = { acceptedFollowUps: true, maxIssues: true };
  const next = firstMessageBoundary(boundary, "execute_approved", [3, 4, 5], "Ship #3 #4 #5", 2, 2, 9, derived);
  assert.deepEqual(next, { ...boundary, objective: "Ship #3 #4 #5", revision: 2, issueScopeRevision: 2, authorizedAt: 9,
    issueAuthority: { ...boundary.issueAuthority, epics: [3, 4, 5], maxIssues: 6 },
    budgetAuthority: { ...boundary.budgetAuthority, acceptedFollowUps: 3 } });
  const recommendOnly = firstMessageBoundary(boundary, "recommend_only", [], "Tidy", 2, 2, 9, derived);
  assert.equal(recommendOnly.budgetAuthority!.acceptedFollowUps, 1, "never below what the launch authorized");
  assert.equal(recommendOnly.issueAuthority!.maxIssues, 1);
});

test("explicit follow-up and issue ceilings never grow, and an explicit Maximum Issues bounds the scope (CR-1.1)", () => {
  const boundary = { version: 1 as const, revision: 1, issueScopeRevision: 1, repository: "owner/repo", objective: "pending",
    authorizedByUserId: "u", authorizedAt: 1, operations: ["pr_merge" as const], delegatablePolicyIds: [],
    issueAuthority: { epics: [], relatedFollowUps: true, maxIssues: 1, closureReasons: ["completed" as const] },
    budgetAuthority: { version: 1 as const, concurrency: 1, acceptedFollowUps: 0, accounting: "managed_workers_only" as const, unpriced: "stop" as const } };
  const explicit = { acceptedFollowUps: false, maxIssues: false };
  const next = firstMessageBoundary(boundary, "execute_approved", [12], "Fix #12", 2, 2, 2, explicit);
  assert.equal(next.budgetAuthority!.acceptedFollowUps, 0);
  assert.equal(next.issueAuthority!.maxIssues, 1);
  assert.equal(firstMessageBoundary(boundary, "execute_approved", [12], "Fix #12", 2, 2, 2).issueAuthority!.maxIssues, 1,
    "with no record of which limits were derived, every limit counts as explicit");
  assert.deepEqual(firstMessageIssues(boundary, [12, 13, 14], explicit), [12]);
  assert.deepEqual(firstMessageIssues(boundary, [12, 13, 14], { acceptedFollowUps: true, maxIssues: true }), [12, 13, 14]);
  assert.deepEqual(derivedLaunchLimits({ budget: { acceptedFollowUps: 0 }, issues: { maxIssues: 1 } }), explicit);
  assert.deepEqual(derivedLaunchLimits(undefined), { acceptedFollowUps: true, maxIssues: true });
});
