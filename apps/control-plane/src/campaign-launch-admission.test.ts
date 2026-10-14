import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import type { CampaignLaunchProposal } from "@wollipog/protocol";
import { campaignLaunchDigest, parseCampaignLaunchProposal } from "./campaign-launch-admission.js";

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
  for (const field of ["costUsd", "toolCalls", "concurrency", "acceptedFollowUps"]) {
    const budget = { ...proposal.budgetAuthority } as Record<string, unknown>;
    delete budget[field];
    assert.equal(parseCampaignLaunchProposal({ ...proposal, budgetAuthority: budget }), null);
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
