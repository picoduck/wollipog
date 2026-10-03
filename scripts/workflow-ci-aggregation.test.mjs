import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const check = workflow.slice(workflow.indexOf("\n  check:\n"));
const condition = check.match(/^    if: \$\{\{ (.+) \}\}$/m)?.[1];
assert.ok(condition, "required aggregator condition must be inspectable");
const dependencies = check.match(/^    needs: \[([^\]]+)\]$/m)?.[1].split(", ");
assert.deepEqual(dependencies, ["checks", "browser", "win32"]);
const resultEnv = [...check.matchAll(/^          ([A-Z_0-9]+): \$\{\{ needs\.([a-z0-9_]+)\.result \}\}$/gm)];
assert.deepEqual(resultEnv.map((match) => match[2]).sort(), [...dependencies].sort());
const shell = check.match(/^        run: \|\n((?:          .*\n?)+)/m)?.[1]
  .split("\n").map((line) => line.slice(10)).join("\n");
assert.ok(shell, "execute the actual aggregator shell, not a copied implementation");

const results = ["success", "failure", "cancelled", "skipped", "unexpected"];
const combinations = results.flatMap((checks) => results.flatMap((browser) => results.map((win32) => ({ checks, browser, win32 }))));
const events = [
  ...["opened", "synchronize", "reopened"].flatMap((action) => [
    { name: `ready/${action}`, event_name: "pull_request", action, draft: false, expected: true },
    { name: `draft/${action}`, event_name: "pull_request", action, draft: true, expected: false },
  ]),
  { name: "ready-for-review", event_name: "pull_request", action: "ready_for_review", draft: false, expected: true },
  { name: "stale-draft-ready-for-review", event_name: "pull_request", action: "ready_for_review", draft: true, expected: true },
  { name: "main-push", event_name: "push", expected: true },
  { name: "merge-group", event_name: "merge_group", expected: true },
  { name: "manual", event_name: "workflow_dispatch", expected: true },
];

// This is an inert expression model of GitHub's documented status functions, not its
// scheduler. A needs result is deliberately independent of workflow cancellation.
function eligible(expression, event, outcomes, workflowCancelled) {
  const github = {
    event_name: event.event_name,
    event: { action: event.action, pull_request: event.event_name === "pull_request" ? { draft: event.draft } : undefined },
  };
  const context = {
    github,
    needs: Object.fromEntries(Object.entries(outcomes).map(([id, result]) => [id, { result }])),
    always: () => true,
    cancelled: () => workflowCancelled,
    success: () => Object.values(outcomes).every((result) => result === "success"),
    failure: () => Object.values(outcomes).includes("failure"),
  };
  // GitHub adds success() only when an if expression has no status function.
  const effective = /\b(?:always|cancelled|success|failure)\s*\(/.test(expression)
    ? expression : `success() && (${expression})`;
  return vm.runInNewContext(effective, context, { timeout: 1_000 });
}

test("active aggregation reports every dependency outcome and preserves the draft guard", () => {
  for (const event of events) {
    for (const outcomes of combinations) {
      assert.equal(eligible(condition, event, outcomes, false), event.expected,
        `${event.name} with ${JSON.stringify(outcomes)} must reach required reporting when active`);
    }
  }
});

test("workflow cancellation makes aggregation ineligible regardless of dependency outcomes", () => {
  for (const event of events) {
    for (const outcomes of combinations) {
      assert.equal(eligible(condition, event, outcomes, true), false,
        `${event.name} with ${JSON.stringify(outcomes)} must not resist whole-workflow cancellation`);
    }
  }
});

test("the actual aggregator shell succeeds only for all-success and names every non-success", () => {
  const labels = { checks: "Typecheck, Unit Tests & Bundles", browser: "Browser End-to-End Tests", win32: "Settings-Rows win32 Baselines" };
  for (const outcomes of [...combinations, { checks: "", browser: "success", win32: "success" }]) {
    const env = Object.fromEntries(resultEnv.map((match) => [match[1], outcomes[match[2]]]));
    const run = spawnSync("bash", ["-c", shell], { env, encoding: "utf8", timeout: 1_000 });
    assert.ifError(run.error);
    assert.equal(run.signal, null);
    const allSucceeded = Object.values(outcomes).every((result) => result === "success");
    assert.equal(run.status, allSucceeded ? 0 : 1, JSON.stringify(outcomes));
    for (const [id, result] of Object.entries(outcomes)) {
      if (result === "success") {
        assert.ok(run.stdout.includes(`${labels[id]}: success`));
      } else if (result === "cancelled") {
        assert.ok(run.stdout.includes(`::error::${labels[id]} was cancelled:`));
      } else {
        assert.ok(run.stdout.includes(`::error::${labels[id]} ended with result '${result}'`));
      }
    }
  }
});

test("cancellation regression rejects unconditional aggregation and failure-hiding guards", () => {
  const ready = events[0];
  const success = { checks: "success", browser: "success", win32: "success" };
  assert.equal(eligible(condition.replace("!cancelled()", "always()"), ready, success, true), true,
    "the old condition remains true under cancellation in the documented model");
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.equal(eligible(condition.replace("!cancelled()", "true"), ready, { ...success, browser: result }, false), false,
      "removing the status function introduces implicit success() and hides required reporting");
  }
});

test("concurrency remains independent for unrelated PRs, refs and workflows", () => {
  const template = workflow.match(/^  group: (.+)$/m)?.[1];
  assert.ok(template);
  assert.match(workflow, /^  cancel-in-progress: true$/m);
  function group(event, number = 2452, ref = "refs/pull/2452/merge", workflowName = "CI") {
    const github = { workflow: workflowName, ref, event_name: event.event_name, event: {
      action: event.action,
      pull_request: event.event_name === "pull_request" ? { number, draft: event.draft } : {},
    } };
    return template.replace(/\$\{\{ (.+?) \}\}/g, (_, expression) =>
      String(vm.runInNewContext(expression, { github }, { timeout: 1_000 })));
  }
  const ready = events[0];
  const samePR = group(ready);
  assert.equal(group(events.find((event) => event.name === "ready/synchronize")), samePR);
  assert.equal(group(events.find((event) => event.name === "stale-draft-ready-for-review")), samePR);
  assert.notEqual(group(events.find((event) => event.name === "draft/synchronize")), samePR);
  assert.notEqual(group(ready, 2453, "refs/pull/2453/merge"), samePR);
  assert.notEqual(group(ready, 2452, undefined, "Other Workflow"), samePR);
  const main = group(events.find((event) => event.name === "main-push"), undefined, "refs/heads/main");
  assert.notEqual(main, samePR);
  const merge = events.find((event) => event.name === "merge-group");
  assert.notEqual(group(merge, undefined, "refs/heads/gh-readonly-queue/main/pr-2452-a"), main);
  assert.notEqual(group(merge, undefined, "refs/heads/gh-readonly-queue/main/pr-2452-a"),
    group(merge, undefined, "refs/heads/gh-readonly-queue/main/pr-2452-b"));
});
