import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "@wollipog/test-support/bounded-child-process";
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
  const wake = worker.split("\n  health_wake:\n")[1].split("\n  controller_wake:\n")[0];
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

// Run the entry module itself: importing main() hides pending top-level-await cycles.
test("rolling CLI retries a short listing after its real terminal worker handoff", () => {
  const preload = `let queuedReads = 0;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    let status = 200, body;
    if (path === "/repos/${repository}/actions/runs/10") body = ${JSON.stringify(run({ status: "completed", conclusion: "success" }))};
    else if (path.endsWith("/git/ref/heads/ci/main-rolling-state")) { status = 404; body = {}; }
    else if (path.endsWith("/git/ref/heads/main")) body = { object: { sha: "${target}" } };
    else if (path.endsWith("/runs")) body = {
      total_count: new URL(url).searchParams.get("status") === "queued" && ++queuedReads === 1 ? 1 : 0,
      workflow_runs: [] };
    else if (path.endsWith("/git/trees") || path.endsWith("/git/commits")) body = { sha: "${target}" };
    else if (path === "/repos/${repository}") body = { node_id: "repo" };
    else if (path === "/graphql") body = { data: { updateRefs: {} } };
    else if (path.endsWith("/dispatches") && options.method === "POST") { status = 204; }
    else throw new Error("Unexpected fixture request");
    return new Response(status === 204 ? null : JSON.stringify(body), { status });
  };`;
  const child = spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload),
    new URL("./main-rolling-validation.mjs", import.meta.url).pathname, "reconcile"], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, GITHUB_REPOSITORY: repository, GITHUB_REF: "refs/heads/main",
      GITHUB_TOKEN: "test-token", MAIN_ROLLING_WORKER_RUN_ID: "10", MAIN_ROLLING_WORKER_ATTEMPT: "1",
      GITHUB_STEP_SUMMARY: "" },
  });
  assert.ifError(child.error); assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stderr, /unsettled top-level await/);
  const events = child.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events[0].event, "main_rolling_handoff"); assert.equal(events[0].status, "completed");
  assert.equal(events[1].event, "main_rolling_reconciled");
  assert.equal(events[1].pending.targetSha, target);
});

test("rolling CLI completes its real worker handoff and fails closed on a later API refusal", () => {
  for (const changed of [false, true]) {
    const worker = run({ status: "completed", conclusion: "success", ...(changed ? { run_attempt: 2 } : {}) });
    const preload = `globalThis.fetch = async (url, options) => {
      if (options.method !== "GET") throw new Error("Unexpected fixture mutation");
      const path = new URL(url).pathname;
      console.log(JSON.stringify({ fixtureRequest: path }));
      if (path === "/repos/${repository}/actions/runs/10")
        return new Response(JSON.stringify(${JSON.stringify(worker)}), { status: 200 });
      return new Response("private response must stay hidden", { status: 503 });
    };`;
    const child = spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload),
      new URL("./main-rolling-validation.mjs", import.meta.url).pathname, "reconcile"], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, GITHUB_REPOSITORY: repository, GITHUB_REF: "refs/heads/main",
        GITHUB_TOKEN: "test-token", MAIN_ROLLING_WORKER_RUN_ID: "10", MAIN_ROLLING_WORKER_ATTEMPT: "1",
        GITHUB_STEP_SUMMARY: "" },
    });
    assert.ifError(child.error); assert.equal(child.signal, null);
    assert.equal(child.status, 1, child.stderr);
    assert.doesNotMatch(child.stderr, /unsettled top-level await|private response|test-token/);
    const events = child.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.filter(e => e.fixtureRequest).map(e => e.fixtureRequest), changed
      ? [`/repos/${repository}/actions/runs/10`]
      : [`/repos/${repository}/actions/runs/10`, `/repos/${repository}/git/ref/heads/ci/main-rolling-state`]);
    const handoff = events.find(e => e.event === "main_rolling_handoff");
    assert.equal(handoff?.status, changed ? undefined : "completed");
    if (!changed) { assert.equal(handoff.runId, 10); assert.equal(handoff.attempt, 1); assert.equal(handoff.targetSha, target); }
    assert.equal(JSON.parse(child.stderr.split("\n").find(line => line.startsWith("{"))).failureClass,
      changed ? "worker-handoff-identity-changed" : "api-error");
  }
});
