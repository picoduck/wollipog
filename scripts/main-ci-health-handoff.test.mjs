import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { awaitWorkerTerminal, budgetApi, main, WORKER_HANDOFF_WAIT_MS } from "./main-ci-health.mjs";

const repository = "example/project", target = "a".repeat(40);
const run = extra => ({ id: 10, run_attempt: 1, status: "in_progress", conclusion: null,
  display_title: `Rolling ${target} 12345678-1234-1234-1234-123456789012`,
  path: ".github/workflows/main-rolling-validation.yml", event: "workflow_dispatch", head_branch: "main",
  head_sha: target, created_at: "2026-10-25T12:00:00Z", repository: { full_name: repository },
  head_repository: { full_name: repository }, ...extra });

test("terminal handoff polls only its exact worker and shares the observation budget", async () => {
  let time = 0, calls = 0;
  const api = budgetApi(async path => {
    assert.equal(path, `/repos/${repository}/actions/runs/10`);
    return run(++calls === 2 ? { status: "completed", conclusion: "failure" } : {});
  });
  const result = await awaitWorkerTerminal(repository, { runId: 10, attempt: 1 }, {
    api, clock: () => time, sleep: async ms => { time += ms; },
  });
  assert.equal(result.status, "completed"); assert.equal(result.polls, 2);
  assert.equal(result.waitedMs, 30_000); assert.equal(result.targetSha, target);
  assert.equal(api.budget.calls, 2); assert.equal(api.budget.mutationCalls, 0);
});

test("an unfinished worker stops after at most three minutes and six charged reads", async () => {
  let time = 0;
  const api = budgetApi(async () => run());
  const result = await awaitWorkerTerminal(repository, { runId: 10, attempt: 1 }, {
    api, clock: () => time, sleep: async ms => { time += ms; },
  });
  assert.equal(result.status, "pending"); assert.equal(result.polls, 6);
  assert.equal(time, WORKER_HANDOFF_WAIT_MS); assert.equal(api.budget.calls, 6);
  assert.equal(api.budget.limit, 48); assert.equal(api.budget.reserve, 8);
});

test("worker identity/attempt drift, invalid provenance and API exhaustion fail closed", async () => {
  for (const extra of [{ id: 11 }, { run_attempt: 2 }, { head_branch: "topic" },
    { path: ".github/workflows/ci.yml" }, { event: "pull_request" },
    { head_repository: { full_name: "other/repo" } }, { display_title: "untrusted" }]) {
    await assert.rejects(awaitWorkerTerminal(repository, { runId: 10, attempt: 1 }, {
      api: async () => run(extra),
    }), /worker-handoff-identity-changed/);
  }
  let time = 0;
  const api = budgetApi(async () => run(), { limit: 2, reserve: 0 });
  await assert.rejects(awaitWorkerTerminal(repository, { runId: 10, attempt: 1 }, {
    api, clock: () => time, sleep: async ms => { time += ms; },
  }), /api-budget-exhausted/);
  assert.equal(api.budget.calls, 2); assert.equal(api.budget.mutationCalls, 0);
});

test("entry-point timeout retains unknown handoff evidence without any incident mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "health-handoff-")), output = join(dir, "health.json");
  try {
    const paths = [], mutations = [];
    const code = await main([], {
      env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test", GITHUB_REF: "refs/heads/main",
        GITHUB_EVENT_NAME: "workflow_dispatch", MAIN_CI_HEALTH_WORKER_RUN_ID: "10",
        MAIN_CI_HEALTH_WORKER_ATTEMPT: "1", MAIN_CI_HEALTH_OUTPUT: output },
      api: async (path, options) => { paths.push(path); if (options?.method) mutations.push(options); return {}; },
      waitForWorker: async (_repo, expected, { api }) => {
        assert.deepEqual(expected, { runId: 10, attempt: 1 });
        await api(`/repos/${repository}/actions/runs/10`);
        return { ...expected, status: "pending", polls: 1, waitedMs: 180_000 };
      }, log: () => {}, error: () => {},
    });
    assert.equal(code, 1); assert.equal(mutations.length, 0);
    assert.deepEqual(paths, ["/rate_limit", `/repos/${repository}/actions/runs/10`]);
    const health = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(health.status, "unknown"); assert.equal(health.fullCertification, null);
    assert.deepEqual(health.reasons, ["worker-handoff-pending"]);
    assert.equal(health.workerHandoff.runId, 10); assert.equal(health.apiBudget.calls, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("worker terminal job dispatches health with literal command and scoped token only", () => {
  const worker = readFileSync(new URL("../.github/workflows/main-rolling-validation.yml", import.meta.url), "utf8");
  const wake = worker.slice(worker.indexOf("\n  health_wake:\n"));
  assert.match(wake, /if: always\(\) && github.ref == 'refs\/heads\/main'/);
  assert.match(wake, /needs: \[admit, validation\]/);
  assert.match(wake, /permissions:\n      actions: write/);
  assert.match(wake, /^    continue-on-error: true$/m, "a delivery failure must not poison the full regression verdict");
  assert.doesNotMatch(wake, /checkout@|contents:|issues:|download-artifact/);
  assert.match(wake, /WORKER_RUN_ID: \$\{\{ github.run_id \}\}/);
  assert.match(wake, /WORKER_ATTEMPT: \$\{\{ github.run_attempt \}\}/);
  const shells = [...wake.matchAll(/run: (timeout .+)/g)].map(match => match[1]);
  assert.deepEqual(shells, Array(2).fill('timeout 30 gh workflow run main-ci-health.yml --ref main --repo "$GITHUB_REPOSITORY" -f worker_run_id="$WORKER_RUN_ID" -f worker_attempt="$WORKER_ATTEMPT"'));
  assert.match(wake, /if: steps.dispatch.outcome == 'failure'/);
  assert.match(wake, /"event":"main_ci_health_wake","delivery":"failed"/);
});
