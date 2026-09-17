import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  isRoutineClaudeOrchestratorBash,
  isRoutineClaudeOrchestratorPermission,
} from "./orchestrator-provider-permissions.js";

const issueIds = fc.uniqueArray(fc.integer({ min: 1, max: 999_999_999 }), {
  minLength: 1,
  maxLength: 30,
});
const loopVariables = fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/u);
const inspections = fc.array(fc.constantFrom(
  "gh issue view $VAR --json number,title,state",
  "gh pr view $VAR --json number,title,state",
  "gh pr checks $VAR",
  "gh pr diff $VAR --name-only",
), { minLength: 1, maxLength: 8 });

function routineLoop(ids: number[], variable: string, commands: string[]): string {
  const body = commands.map((command) => command.replace("$VAR", `$${variable}`)).join("; echo ----; ");
  return `for ${variable} in ${ids.join(" ")}; do ${body}; done`;
}

test("bounded read-only issue and PR loops are accepted across routine input shapes", () => {
  fc.assert(fc.property(issueIds, loopVariables, inspections, (ids, variable, commands) => {
    assert.equal(isRoutineClaudeOrchestratorBash(routineLoop(ids, variable, commands)), true);
  }));
});

test("adding any mutation-capable command to a routine loop makes it interactive", () => {
  const mutation = fc.constantFrom(
    "gh issue edit $VAR --add-label ready",
    "gh issue close $VAR",
    "gh pr merge $VAR --squash",
    "git push origin main",
    "rm -rf build",
    "touch changed.txt",
  );
  fc.assert(fc.property(issueIds, loopVariables, inspections, mutation, (ids, variable, commands, unsafe) => {
    const injected = [...commands, unsafe];
    assert.equal(isRoutineClaudeOrchestratorBash(routineLoop(ids, variable, injected)), false);
  }));
});

test("the loop parser fails closed on shell expansion, redirection, and control-flow escapes", () => {
  for (const command of [
    "for n in 1; do gh issue view $n; rm -rf build; done",
    "for n in 1; do gh issue view $n > issue.json; done",
    "for n in 1; do gh issue view $n | tee issue.json; done",
    "for n in 1; do gh issue view $(touch changed.txt); done",
    "for n in 1; do gh issue view `touch changed.txt`; done",
    "for n in 1; do gh issue view $other; done",
    "for n in one; do gh issue view $n; done",
    "for n in 1\n2; do gh issue view $n; done",
    "for n in 1; do git status; done",
    "for n in 1; do gh issue list; done",
  ]) assert.equal(isRoutineClaudeOrchestratorBash(command), false, command);
});

test("permission classification rejects non-Bash and expanded Bash input shapes", () => {
  const command = "for n in 1 2; do gh issue view $n; done";
  assert.equal(isRoutineClaudeOrchestratorPermission("Bash", { command }), true);
  assert.equal(isRoutineClaudeOrchestratorPermission("Read", { command }), false);
  assert.equal(isRoutineClaudeOrchestratorPermission("Bash", { command, run_in_background: true }), false);
  assert.equal(isRoutineClaudeOrchestratorPermission("Bash", { command, timeout: 120_001 }), false);
  assert.equal(isRoutineClaudeOrchestratorPermission("Bash", { command, timeout: 30_000 }), true);
});
