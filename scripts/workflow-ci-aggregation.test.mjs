import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import test from "node:test";
import vm from "node:vm";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const check = workflow.slice(workflow.indexOf("\n  check:\n"));
const condition = check.match(/^    if: \$\{\{ (.+) \}\}$/m)?.[1];
assert.ok(condition, "required aggregator condition must be inspectable");
const dependencies = check.match(/^    needs: \[([^\]]+)\]$/m)?.[1].split(", ");
assert.deepEqual(dependencies, ["checks", "unit", "browser", "win32", "webkit", "delegated_pipeline", "suite_plan", "merge_group_gate"]);
const resultEnv = [...check.matchAll(/^          ([A-Z_0-9]+): \$\{\{ needs\.([a-z0-9_]+)\.result \}\}$/gm)];
assert.deepEqual(resultEnv.map((match) => match[2]).sort(), [...dependencies].sort());
const shell = check.match(/^        run: \|\n((?:          .*\n?)+)/m)?.[1]
  .split("\n").map((line) => line.slice(10)).join("\n");
assert.ok(shell, "execute the actual aggregator shell, not a copied implementation");

const results = ["success", "failure", "cancelled", "skipped", "unexpected"];
// Every outcome of every work job, in every combination of up to three non-successes (1,545 rows).
// The full product over six jobs would execute the shell 15,625 times; the report lines are
// independent per job, so larger failure sets add no branch these do not already exercise.
const work = ["checks", "unit", "browser", "win32", "webkit", "delegated_pipeline"];
const combinations = work.reduce((rows, id) => rows.flatMap((row) => results.map((result) => ({ ...row, [id]: result }))), [{}])
  .filter((outcomes) => Object.values(outcomes).filter((result) => result !== "success").length <= 3);
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

test("PR workflow cancellation stops aggregation while non-PR cancellation retains reporting", () => {
  for (const event of events) {
    for (const outcomes of combinations) {
      assert.equal(eligible(condition, event, outcomes, true), event.event_name !== "pull_request" && event.expected,
        `${event.name} with ${JSON.stringify(outcomes)} must preserve its cancellation admission policy`);
    }
  }
});

test("the actual aggregator shell succeeds only for all-success and names every non-success", () => {
  const labels = { checks: "Typecheck & Bundles", unit: "Unit Tests", browser: "Browser End-to-End Tests",
    win32: "Settings-Rows win32 Baselines", webkit: "WebKit End-to-End Tests", delegated_pipeline: "Delegated Pipeline Recovery" };
  for (const outcomes of [...combinations, ...work.map((id) => ({ ...Object.fromEntries(work.map((other) => [other, "success"])), [id]: "" }))]) {
    const env = { ROUTING_ENABLED: "false", PLAN_MODE: "", GATE_ENABLED: "false", GATE_MODE: "",
      ...Object.fromEntries(resultEnv.map((match) => [match[1], ["suite_plan", "merge_group_gate"].includes(match[2]) ? "skipped" : outcomes[match[2]]])) };
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
  const success = Object.fromEntries(work.map((id) => [id, "success"]));
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
  const cancelTemplate = workflow.match(/^  cancel-in-progress: (.+)$/m)?.[1];
  assert.ok(cancelTemplate);
  const headA = "a".repeat(40), headB = "b".repeat(40);
  function context(event, number, ref, workflowName, sha) {
    return { github: { workflow: workflowName, ref, event_name: event.event_name, event: {
      action: event.action,
      pull_request: event.event_name === "pull_request" ? { number, draft: event.draft, head: { sha } } : {},
    } } };
  }
  function evaluate(text, ctx) {
    return text.replace(/\$\{\{ (.+?) \}\}/g, (_, expression) =>
      String(vm.runInNewContext(expression, ctx, { timeout: 1_000 })));
  }
  function group(event, number = 2452, ref = "refs/pull/2452/merge", workflowName = "CI", sha = headA) {
    return evaluate(template, context(event, number, ref, workflowName, sha));
  }
  function cancels(event) {
    return evaluate(cancelTemplate, context(event, 2452, "refs/pull/2452/merge", "CI", headA)) === "true";
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
  assert.notEqual(group(merge, undefined, "refs/heads/gh-readonly-queue/main/pr-2452-b"),
    group(merge, undefined, "refs/heads/gh-readonly-queue/main/pr-2452-a"));

  // #3283: two runs of one head share a lane that never cancels in progress, so neither leaves a
  // cancelled required check on that head. A newer head gets its own lane; pr-ci-supersede.yml
  // cancels the older head's runs instead.
  assert.notEqual(group(ready, 2452, "refs/pull/2452/merge", "CI", headB), samePR);
  for (const event of events.filter((candidate) => candidate.event_name === "pull_request")) {
    assert.equal(cancels(event), false, `${event.name} must not cancel a same-head run in progress`);
  }
  for (const name of ["main-push", "merge-group", "manual"]) {
    assert.equal(cancels(events.find((event) => event.name === name)), true, `${name} keeps cancelling superseded runs`);
  }
});

test("merge groups keep the full required aggregation whatever the disabled gate's result", () => {
  const success = { CHECKS_RESULT: "success", UNIT_RESULT: "success", BROWSER_RESULT: "success", WIN32_RESULT: "success", WEBKIT_RESULT: "success",
    DELEGATED_PIPELINE_RESULT: "success",
    ROUTING_ENABLED: "false", PLAN_RESULT: "skipped", PLAN_MODE: "" };
  const merge = events.find((event) => event.name === "merge-group");
  for (const outcomes of combinations) {
    // The aggregator is admitted for every merge-group outcome, with or without cancellation.
    assert.equal(eligible(condition, merge, { ...outcomes, suite_plan: "skipped", merge_group_gate: "skipped" }, true), true);
  }
  for (const result of results) for (const mode of ["", "full", "fast"]) {
    const run = spawnSync("bash", ["-c", shell], { encoding: "utf8", timeout: 1_000,
      env: { ...success, GATE_SWITCH: "", GATE_ENABLED: "false", GATE_RESULT: result, GATE_MODE: mode } });
    assert.ifError(run.error);
    assert.equal(run.status, result === "skipped" && mode === "" ? 0 : 1, `${result}/${mode}`);
    if (run.status) assert.ok(run.stdout.includes("::error::Unexpected Merge Group Gate admission or output"));
  }
  const missing = spawnSync("bash", ["-c", shell], { encoding: "utf8", timeout: 1_000,
    env: { ...success, GATE_SWITCH: "enabled", GATE_ENABLED: "true", GATE_RESULT: "success", GATE_MODE: "" } });
  assert.equal(missing.status, 1);
  assert.ok(missing.stdout.includes("::error::Merge Group Gate returned missing or unknown mode ''"));
  const caseVariant = spawnSync("bash", ["-c", shell], { encoding: "utf8", timeout: 1_000,
    env: { ...success, GATE_SWITCH: "Enabled", GATE_ENABLED: "true", GATE_RESULT: "success", GATE_MODE: "fast" } });
  assert.equal(caseVariant.status, 1);
  assert.ok(caseVariant.stdout.includes("::error::A reduced merge group requires the exact lowercase enabled gate"));
});
