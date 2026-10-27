import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { collectCertification, forgeReader, fullTestStepsPassed, main } from "./release-certification.mjs";
import { REQUIRED, WORKER } from "./main-rolling-validation.mjs";

const repository = "example/project";
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40), D = "d".repeat(40);
const claim = "12345678-1234-1234-1234-123456789012";
const at = (minute = 0) => new Date(Date.UTC(2026, 9, 25, 10, minute)).toISOString();
const core = ["Typecheck", "Unit Tests", "Verify Node 22 Engine Boundary", "Verify Excluded Node Engine Boundary",
  "Verify Node 23 Engine Boundary", "Verify Recommended Node Engine Boundary", "Verify Delegated Linux Provider Containment",
  "Validate Web Production Build", "Validate Runner Bundle", "Validate Control-Plane Bundle"];
const worker = (overrides = {}) => ({ id: 10, run_attempt: 1, run_number: 50, display_title: `Rolling ${A} ${claim}`,
  path: WORKER, head_sha: C, head_branch: "main", event: "workflow_dispatch", status: "completed", conclusion: "success",
  repository: { full_name: repository }, head_repository: { full_name: repository }, created_at: at(),
  run_started_at: at(1), updated_at: at(30), ...overrides });
const jobs = () => REQUIRED.map((name, i) => ({ id: i + 1, name, run_id: 10, run_attempt: 1, head_sha: C,
  status: "completed", conclusion: "success", created_at: at(), started_at: at(1), completed_at: at(29),
  steps: [...(i < 9 ? ["Verify Rolling Checkout"] : []), ...(i === 0 ? core : []),
    ...(i >= 1 && i <= 5 ? ["Remote-Instance Browser End-to-End Tests"] : []),
    ...(i === 1 ? ["Rendered Production Browser Smoke"] : []), ...(i === 6 ? ["WebKit Browser End-to-End Tests"] : []),
    ...(i === 7 ? ["Compare the Diff Against the Settings-Rows Paths"] : []),
    ...(i === 8 ? ["Compare Against the Committed win32 Baselines"] : []),
    ...(i === 9 ? ["Require Every Job to Have Succeeded"] : [])].map((name, n) => ({ name, number: n + 1,
      conclusion: "success", started_at: at(1), completed_at: at(2) })) }));

function forge() {
  const data = { runs: [worker()], jobs: jobs(), requests: [], denied: new Set(), mainReads: 0,
    suiteMismatch: false, moveMain: false, truncated: false, wrongRunName: false, hook: null };
  const api = async (path, options) => {
    assert.ok(!options || !options.method || options.method === "GET", "certification must be read-only");
    data.requests.push(path); data.hook?.(path);
    const url = new URL("https://api.github.com" + path);
    const local = url.pathname.replace(`/repos/${repository}`, "");
    if (local === "/git/ref/heads/main") return { object: { sha: ++data.mainReads > 1 && data.moveMain ? D : B } };
    if (local.startsWith("/compare/")) {
      const source = local.split("/").at(-1).split("...")[0];
      return { merge_base_commit: { sha: data.denied.has(source) ? D : source } };
    }
    if (local.startsWith("/contents/")) {
      const file = local.slice("/contents/".length);
      let source = readFileSync(new URL("../" + file, import.meta.url), "utf8");
      if (data.wrongRunName && file === WORKER) source = source.replace("run-name: Rolling", "run-name: Unbound");
      const index = [WORKER, ".github/workflows/ci.yml", ".github/workflows/settings-rows-win32.yml"].indexOf(file);
      return { sha: (data.suiteMismatch && url.searchParams.get("ref") === C ? "9" : String(index + 1)).repeat(40),
        encoding: "base64", content: Buffer.from(source).toString("base64") };
    }
    if (local.endsWith("/main-rolling-validation.yml/runs")) {
      let selected = data.runs.filter((r) => !url.searchParams.has("status") || r.status === url.searchParams.get("status"));
      if (url.searchParams.has("created")) selected = selected.filter((r) => r.created_at >= url.searchParams.get("created").slice(2));
      selected = selected.toSorted((a, b) => b.id - a.id);
      const offset = (Number(url.searchParams.get("page")) - 1) * 100;
      return structuredClone({ total_count: data.truncated && url.searchParams.has("created") ? 1500 : selected.length,
        workflow_runs: selected.slice(offset, offset + 100) });
    }
    if (local.endsWith("/jobs")) return structuredClone({ total_count: data.jobs.length, jobs: data.jobs });
    const id = Number(local.split("/")[3]);
    if (local.startsWith("/actions/runs/")) {
      const run = data.runs.find((r) => r.id === id);
      if (run) return structuredClone(run);
      const error = new Error("not found"); error.status = 404; throw error;
    }
    throw new Error("Unexpected inert API request: " + local);
  };
  return { data, api, collect: (options = {}) => collectCertification(repository, A, { api, now: () => at(60), ...options }) };
}

test("certification binds an exact older candidate while newer main and dispatcher identities stay separate", async () => {
  const f = forge();
  const result = await f.collect();
  assert.equal(result.status, "certified"); assert.equal(result.targetSha, A);
  assert.equal(result.mainSha, B); assert.equal(result.sourceSha, C);
  assert.equal(result.runId, 10); assert.equal(result.attempt, 1);
  assert.equal(result.coverageVersion, "rolling-full-v1"); assert.equal(result.suiteVersion.length, 64);
  assert.ok(f.data.requests.length <= 48);
});

test("green ancestors, different candidates, PR heads and merge-group runs cannot satisfy the gate", async () => {
  for (const edit of [{ display_title: `Rolling ${D} ${claim}` }, { event: "pull_request" }, { event: "merge_group" },
    { path: ".github/workflows/ci.yml" }, { head_branch: "topic" }, { head_repository: { full_name: "other/repo" } }]) {
    const f = forge(); Object.assign(f.data.runs[0], edit);
    assert.notEqual((await f.collect()).status, "certified", JSON.stringify(edit));
  }
  const f = forge(); f.data.denied.add(A);
  assert.equal((await f.collect()).reason, "candidate-outside-main");
});

test("an incompatible workflow suite rejects exact-SHA green", async () => {
  const f = forge(); f.data.suiteMismatch = true;
  assert.equal((await f.collect()).status, "incompatible");
  const unbound = forge(); unbound.data.wrongRunName = true;
  assert.equal((await unbound.collect()).reason, "unsupported-workflow-contract");
});

test("missing, skipped, duplicate, cancelled and incomplete jobs cannot certify", async () => {
  for (const change of ["missing", "duplicate", "checkout", "test", "cancelled", "run-cancelled"]) {
    const f = forge();
    if (change === "missing") f.data.jobs.pop();
    if (change === "duplicate") f.data.jobs.push({ ...structuredClone(f.data.jobs[0]), id: 99 });
    if (change === "checkout") f.data.jobs[0].steps[0].conclusion = "skipped";
    if (change === "test") f.data.jobs[0].steps.find((s) => s.name === "Unit Tests").conclusion = "skipped";
    if (change === "cancelled") f.data.jobs[1].conclusion = "cancelled";
    if (change === "run-cancelled") f.data.runs[0].conclusion = "cancelled";
    assert.notEqual((await f.collect()).status, "certified", change);
  }
  assert.equal(fullTestStepsPassed(jobs()), true);
});

test("the release proof requires every core test step in authoritative health's coverage contract", () => {
  const health = readFileSync(new URL("./main-ci-health.mjs", import.meta.url), "utf8");
  const declaration = health.match(/const CORE_STEPS = (\[[\s\S]*?\]);/);
  assert.ok(declaration, "a health coverage-contract change requires an explicit release-proof update");
  const names = JSON.parse(declaration[1]);
  for (const name of names) {
    const inventory = jobs();
    assert.ok(inventory[0].steps.some((s) => s.name === name), name);
    inventory[0].steps = inventory[0].steps.filter((s) => s.name !== name);
    assert.equal(fullTestStepsPassed(inventory), false, name);
  }
});

test("pending reruns and newer target runs withdraw an earlier certificate", async () => {
  const f = forge(); assert.equal((await f.collect()).status, "certified");
  Object.assign(f.data.runs[0], { run_attempt: 2, status: "in_progress", conclusion: null });
  assert.equal((await f.collect({ pointerRunId: 10 })).status, "pending");
  Object.assign(f.data.runs[0], { status: "completed", conclusion: "failure" });
  f.data.jobs[1].conclusion = "failure";
  assert.equal((await f.collect()).status, "failed");
});

test("reruns and new workers appearing during job verification invalidate the observation", async () => {
  for (const race of ["rerun", "new-worker", "main"]) {
    const f = forge();
    f.data.hook = (path) => {
      if (!path.includes("/jobs")) return;
      f.data.hook = null;
      if (race === "rerun") Object.assign(f.data.runs[0], { run_attempt: 2, status: "in_progress", conclusion: null });
      if (race === "new-worker") f.data.runs.push(worker({ id: 11, created_at: at(40), status: "queued", conclusion: null }));
      if (race === "main") f.data.moveMain = true;
    };
    assert.equal((await f.collect()).status, "unknown", race);
  }
});

test("old pointers are hints only and history expiry fails closed", async () => {
  const f = forge(); f.data.truncated = true;
  assert.equal((await f.collect({ pointerRunId: 10 })).reason, "evidence-window-exceeds-bound");
  assert.notEqual((await f.collect({ pointerRunId: 999 })).status, "certified");
});

test("workflow discovery finds exact evidence beyond the first worker page", async () => {
  const f = forge();
  f.data.runs.push(...Array.from({ length: 150 }, (_, i) => worker({ id: i + 100,
    display_title: `Rolling ${D} ${claim}`, created_at: at(40) })));
  assert.equal((await f.collect()).status, "certified");
  assert.equal(await main(["--repository", repository, "--target-sha", A], { api: f.api, log: () => {} }), 0);
});

test("fresh exact evidence takes precedence over a deleted checkpoint locator", async () => {
  const f = forge();
  assert.equal((await f.collect({ pointerRunId: 999 })).status, "certified");
});

test("an unavailable observation preserves only the run locator for later resume", async () => {
  const f = forge(); f.api.rateLimit = { limit: 1000, remaining: 599 };
  const result = await f.collect({ pointerRunId: 10 });
  assert.equal(result.status, "unknown"); assert.equal(result.runId, 10);
  assert.equal(result.attempt, null); assert.equal(result.sourceSha, null);
});

test("API quota and evidence errors never reuse stale success or disclose response text", async () => {
  const f = forge();
  f.api.rateLimit = { limit: 1000, remaining: 599 };
  const quota = await f.collect(); assert.equal(quota.status, "unknown"); assert.equal(quota.reason, "api-quota-reserved");
  const result = await collectCertification(repository, A, { api: async () => { throw new Error("private credential response"); } });
  assert.equal(result.reason, "certification-evidence-unavailable"); assert.ok(!JSON.stringify(result).includes("private credential"));
});

test("gh adapter is GET-only, verifies quota headers, and keeps private error bodies out", async () => {
  const api = forgeReader((program, args) => {
    assert.equal(program, "gh"); assert.deepEqual(args.slice(0, 4), ["api", "--include", "--method", "GET"]);
    return 'HTTP/2.0 200 OK\r\nx-ratelimit-limit: 1000\r\nx-ratelimit-remaining: 900\r\n\r\n{"ok":true}';
  });
  assert.deepEqual(await api("/repos/example/project"), { ok: true });
  assert.deepEqual(api.rateLimit, { limit: 1000, remaining: 900 });
  await assert.rejects(forgeReader(() => { throw new Error("private body"); })("/any"), /certification-forge-read-failed/);
});

test("workflow gate fails non-certified evidence while read-only report mode returns the waiting result", async () => {
  const f = forge(); f.data.runs = [];
  const logs = [];
  const args = ["--repository", repository, "--target-sha", A];
  assert.equal(await main(args, { api: f.api, log: (s) => logs.push(JSON.parse(s)) }), 1);
  assert.equal(await main([...args, "--report"], { api: f.api, log: () => {} }), 0);
  assert.equal(logs[0].status, "missing");
});
