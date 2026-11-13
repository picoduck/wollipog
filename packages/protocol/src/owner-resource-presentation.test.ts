import assert from "node:assert/strict";
import test from "node:test";
import { ownerResourceKeepReason, ownerResourceLabel, type WorkflowDecisionResourceSnapshot } from "./index.js";

test("owner resource copy names the resource independently of the pending request's action", () => {
  const snapshot = { category: "pr_merge", repository: "picoduck/wollipog", pullRequest: 4141 } as WorkflowDecisionResourceSnapshot;
  assert.equal(ownerResourceLabel(snapshot, "Merge picoduck/wollipog#4141"), "PR #4141 in picoduck/wollipog");
  assert.equal(ownerResourceKeepReason({}), "The Orchestrator handed this resource to you.");
  assert.equal(ownerResourceKeepReason({ ownerRule: { source: "AGENTS.md", quote: "Keep my approval." } }),
    "A rule keeps this resource with you.");
});
