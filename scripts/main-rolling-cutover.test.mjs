import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
import { CUTOVER_MARKER, restoreMainPushCI } from "./restore-main-push-ci.mjs";

const push = "  push:\n    branches: [main]\n";
const actualWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
// Exercise the same rollback contract after an operator restores the trigger too.
const workflow = actualWorkflow.includes(CUTOVER_MARKER) ? actualWorkflow : actualWorkflow.replace(push, CUTOVER_MARKER);
const rollback = fileURLToPath(new URL("./restore-main-push-ci.mjs", import.meta.url));

test("cutover or explicit rollback retains PR, merge-group, manual and reusable full events", () => {
  const events = actualWorkflow.slice(actualWorkflow.indexOf("\non:\n"), actualWorkflow.indexOf("\npermissions:\n"));
  assert.notEqual(events.includes(CUTOVER_MARKER), /^  push:/m.test(events), "one explicit main-push ownership state");
  assert.equal(restoreMainPushCI(actualWorkflow), actualWorkflow.replace(CUTOVER_MARKER, push));
  assert.match(events, /^  merge_group:\n/m);
  assert.match(events, /^  workflow_call:\n/m);
  assert.match(events, /^  workflow_dispatch:\n/m);
  assert.match(events, /pull_request:\n    types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.match(actualWorkflow, /name: Typecheck, Test & Sidecar Bundle/);
  const controller = readFileSync(new URL("../.github/workflows/main-rolling-controller.yml", import.meta.url), "utf8");
  assert.match(controller, /on:\n  push:\n    branches: \[main\]/);
});

test("rollback restores main-only push and preserves every other byte, including future jobs", () => {
  for (const source of [workflow, workflow + "\n  future_job:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo future\n",
    workflow.replace("types: [opened, synchronize, reopened, ready_for_review]", "types: [opened, synchronize, reopened, ready_for_review, edited]")]) {
    const restored = restoreMainPushCI(source);
    assert.equal(restored, source.replace(CUTOVER_MARKER, push));
    assert.equal(restored.slice(restored.indexOf("\npermissions:\n")), source.slice(source.indexOf("\npermissions:\n")));
    assert.equal(restoreMainPushCI(restored), restored, "restoration must be idempotent");
  }
});

test("rollback refuses ambiguous or drifted events without guessing", () => {
  for (const source of [workflow.replace(CUTOVER_MARKER, ""), workflow.replace(CUTOVER_MARKER, CUTOVER_MARKER.repeat(2)),
    workflow.replace(CUTOVER_MARKER, "  push: [main]\n"), workflow.replace(CUTOVER_MARKER, "  push:\n    branches: [other]\n"),
    workflow.replace(CUTOVER_MARKER, push + "    paths: [docs/**]\n"), workflow + "\non:\n  push:\n",
    workflow.replace("  merge_group:\n", ""), workflow.replace("on:\n", "on: [pull_request]\n")]) {
    assert.throws(() => restoreMainPushCI(source));
  }
});

test("executable rollback previews, writes only on request, and refuses drift without mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "rolling-cutover-"));
  try {
    const path = join(dir, "ci.yml");
    writeFileSync(path, workflow);
    const run = args => spawnSync(process.execPath, [rollback, ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(run([path]).status, 0);
    assert.equal(readFileSync(path, "utf8"), workflow);
    assert.equal(run(["--write", path]).status, 0);
    assert.equal(readFileSync(path, "utf8"), restoreMainPushCI(workflow));
    assert.equal(run(["--write", path]).status, 0);
    const drifted = workflow.replace(CUTOVER_MARKER, "  push: [other]\n");
    writeFileSync(path, drifted);
    assert.equal(run(["--write", path]).status, 1);
    assert.equal(readFileSync(path, "utf8"), drifted);
    assert.equal(run(["--unknown", path]).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
