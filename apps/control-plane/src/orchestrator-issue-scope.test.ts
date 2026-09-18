import assert from "node:assert/strict";
import { test } from "node:test";
import { orchestratorIssueNumbersFromInitialPrompt } from "./orchestrator-issue-scope.js";

test("explicit initial campaign requests produce a finite issue scope", () => {
  assert.deepEqual(
    orchestratorIssueNumbersFromInitialPrompt("Claim and orchestrate issue 1209, 1210, and 1211."),
    [1209, 1210, 1211],
  );
  assert.deepEqual(orchestratorIssueNumbersFromInitialPrompt("Please coordinate GitHub issues #4 and #9"), [4, 9]);
  assert.deepEqual(orchestratorIssueNumbersFromInitialPrompt("Manage issue 42 and issue 43"), [42]);
});

test("mentions and ambiguous or negated prose do not grant issue-write scope", () => {
  for (const prompt of [
    "Investigate why issue 1209 was modified.",
    "Do not claim issue 1209.",
    "Summarize issues 1209 and 1210.",
    "The campaign concerns issue 1209.",
    "Claim issue 0.",
    "Claim issue 9999999999999999.",
  ]) assert.deepEqual(orchestratorIssueNumbersFromInitialPrompt(prompt), [], prompt);
});
