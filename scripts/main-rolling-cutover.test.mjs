import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CUTOVER_MARKER, restoreMainPushCi } from "./restore-main-push-ci.mjs";

const read = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
const ci = read("ci.yml");
const controller = read("main-rolling-controller.yml");
const jobs = (source) => source.slice(source.indexOf("\njobs:\n"));
const events = (source) => [...source.slice(source.indexOf("\non:\n"), source.indexOf("\npermissions:")).matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]);
const push = "  push:\n    branches: [main]\n";
const restoredMode = events(ci).includes("push");
const cutover = restoredMode ? ci.replace(push, CUTOVER_MARKER) : ci;

test("cutover and restored mode retain full PR/queue/called/manual CI", () => {
  assert.deepEqual(events(ci), restoredMode
    ? ["workflow_call", "merge_group", "pull_request", "push", "workflow_dispatch"]
    : ["workflow_call", "merge_group", "pull_request", "workflow_dispatch"]);
  assert.equal(ci.includes(CUTOVER_MARKER), !restoredMode);
  if (restoredMode) assert.match(ci, /  push:\n    branches: \[main\]\n/);
  assert.match(controller, /  push:\n    branches: \[main\]/);
  assert.match(ci, /pull_request:\n    types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.match(ci, /needs: \[checks, browser, win32, webkit\]/);
  assert.match(read("main-rolling-validation.yml"), /uses: .\/.github\/workflows\/ci.yml/);
});

test("rollback restores the old main-only trigger without changing full job definitions", () => {
  // This pins rollback preservation. Full inventory is covered by workflow-pr-event-contract;
  // cutover's base-vs-head job-body comparison is a review check, not a frozen shared-job hash.
  const restored = restoreMainPushCi(cutover);
  assert.deepEqual(events(restored), ["workflow_call", "merge_group", "pull_request", "push", "workflow_dispatch"]);
  assert.match(restored, /  push:\n    branches: \[main\]\n  workflow_dispatch:/);
  assert.equal(jobs(restored), jobs(cutover));
  assert.equal(restored.replace(push, CUTOVER_MARKER), cutover);
  const changed = cutover.replace("name: Typecheck, Unit Tests & Bundles", "name: Typecheck, Unit Tests & Bundles # later edit");
  assert.equal(jobs(restoreMainPushCi(changed)), jobs(changed));
});

test("rollback refuses absent, duplicate, or conflicting trigger markers", () => {
  for (const source of [cutover.replace(CUTOVER_MARKER, ""), cutover.replace(CUTOVER_MARKER, CUTOVER_MARKER.repeat(2)),
    cutover.replace(CUTOVER_MARKER, `${CUTOVER_MARKER}  push:\n    branches: [other]\n`),
    cutover.replace("name: CI", "name: Different Workflow"), restoreMainPushCi(cutover)]) {
    assert.throws(() => restoreMainPushCi(source));
  }
});
