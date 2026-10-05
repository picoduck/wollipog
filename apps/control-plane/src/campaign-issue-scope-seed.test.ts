import assert from "node:assert/strict";
import { test } from "node:test";
import { initialCampaignEpic } from "./campaign-issue-scope-seed.js";
import { orchestratorIssueNumbersFromInitialPrompt } from "./orchestrator-issue-scope.js";

test("epic and child-issue wording seed proposals without authorizing implied members", () => {
  for (const prompt of ["Orchestrate epic #2225.", "Orchestrate issue #2225 and its child issues.", "Please coordinate GitHub epic 2225"]) {
    assert.equal(initialCampaignEpic(prompt), 2225);
    assert.deepEqual(orchestratorIssueNumbersFromInitialPrompt(prompt), []);
  }
  for (const prompt of ["Do not orchestrate epic #2225.", "Inspect epic #2225", "Orchestrate epic #2225 except #123", "Orchestrate issue #2225."]) assert.equal(initialCampaignEpic(prompt), null);
  assert.deepEqual(orchestratorIssueNumbersFromInitialPrompt("Orchestrate issues #12 and #13."), [12,13]);
});
