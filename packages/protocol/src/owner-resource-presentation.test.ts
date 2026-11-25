import assert from "node:assert/strict";
import test from "node:test";
import { ownerResourceKeepReason, ownerResourceLabel, ownerResourceNoun, type WorkflowDecisionResourceSnapshot } from "./index.js";

test("owner resource copy names the resource independently of the pending request's action", () => {
  const snapshot = { category: "pr_merge", repository: "picoduck/wollipog", pullRequest: 4141 } as WorkflowDecisionResourceSnapshot;
  assert.equal(ownerResourceLabel(snapshot), "PR #4141 in picoduck/wollipog");
  assert.equal(ownerResourceKeepReason({}), "The Orchestrator handed this resource to you.");
  assert.equal(ownerResourceKeepReason({ ownerRule: { source: "AGENTS.md", quote: "Keep my approval." } }),
    "A rule keeps this resource with you.");
});

test("owner labels stay bounded and normalize multiline questions", () => {
  const label = ownerResourceLabel({ category: "implementation_question", question: `Which\n layout? ${"A".repeat(1000)}`, options: [] });
  assert.equal(label.length, 200);
  assert.ok(label.startsWith("Which layout? "));
  assert.ok(label.endsWith("…"));
  assert.equal(ownerResourceLabel({ category: "issue_closure", repository: "team/repo", issue: 7 } as WorkflowDecisionResourceSnapshot),
    "Issue #7 in team/repo");
});

test("a request card names the kept resource by its kind (#4713)", () => {
  assert.equal(ownerResourceKeepReason({}, ownerResourceNoun("pr_merge")), "The Orchestrator handed this PR to you.");
  assert.equal(ownerResourceKeepReason({ ownerRule: { source: "AGENTS.md", quote: "Keep my approval." } }, ownerResourceNoun("merged_branch_deletion")),
    "A rule keeps this branch with you.");
  assert.equal(ownerResourceNoun("review_round_extension"), "PR");
  assert.equal(ownerResourceNoun("follow_up_issue_publication"), "publication");
  assert.equal(ownerResourceNoun("implementation_question"), "question");
});
