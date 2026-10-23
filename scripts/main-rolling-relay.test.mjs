import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const relay = readFileSync(new URL("../.github/workflows/main-rolling-relay.yml", import.meta.url), "utf8");
const guard = relay.match(/^    if: (.+)$/m)?.[1];
const repository = "picoduck/wollipog";
function admitted(changes = {}, outer = {}) {
  const github = { ref: "refs/heads/main", event_name: "workflow_run", repository,
    event: { action: "completed", workflow_run: { path: ".github/workflows/main-rolling-validation.yml",
      event: "workflow_dispatch", head_branch: "main", repository: { full_name: repository },
      head_repository: { full_name: repository }, ...changes } }, ...outer };
  return Boolean(vm.runInNewContext(guard, { github }, { timeout: 1000 }));
}

test("relay accepts only completed same-repository main workers or main-push CI", () => {
  assert.ok(admitted());
  assert.ok(admitted({ path: ".github/workflows/ci.yml", event: "push" }));
  for (const changes of [
    { path: ".github/workflows/ci.yml", event: "pull_request" },
    { path: ".github/workflows/ci.yml", event: "workflow_dispatch" },
    { path: ".github/workflows/main-rolling-validation.yml", event: "push" },
    { path: ".github/workflows/other.yml" }, { head_branch: "ci/main-rolling-state" },
    { head_branch: "topic" }, { repository: { full_name: "other/repository" } },
    { head_repository: { full_name: "fork/repository" } },
  ]) assert.equal(admitted(changes), false, JSON.stringify(changes));
  assert.equal(admitted({}, { ref: "refs/heads/topic" }), false);
  assert.equal(admitted({}, { event_name: "workflow_dispatch" }), false);
  assert.equal(admitted({}, { event: { action: "requested" } }), false);
  // A delivered failed/cancelled completion must still wake reconciliation; it certifies nothing.
  for (const conclusion of ["success", "failure", "cancelled", "timed_out"])
    assert.ok(admitted({ conclusion, name: "untrusted display title" }));
});

test("relay is an independent token-scoped wake with no checkout or target execution", () => {
  assert.match(relay, /workflows: \[Main Rolling Validation, CI\]\n    types: \[completed\]/);
  assert.match(relay, /^permissions: \{\}$/m);
  assert.match(relay, /    permissions:\n      actions: write\n/);
  assert.equal((relay.match(/^  [a-z_]+:$/gm) ?? []).length, 2, "one event and one job");
  assert.match(relay, /timeout-minutes: 2/);
  assert.match(relay, /group: main-rolling-relay\n      cancel-in-progress: false/);
  assert.doesNotMatch(relay, /checkout@|download-artifact|upload-artifact|needs:|contents: write|issues:|secrets: inherit/);
  const commands = [...relay.matchAll(/^        run: (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(commands, ['gh workflow run main-rolling-controller.yml --ref main --repo "$GITHUB_REPOSITORY"']);
  assert.ok(!commands[0].includes("${{"));
  assert.match(relay, /GH_TOKEN: \$\{\{ github.token \}\}/);
});
