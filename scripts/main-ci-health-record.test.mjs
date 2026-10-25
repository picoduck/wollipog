import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { ALERT_LABEL, ALERT_TITLE, API_BUDGET, API_MAX_BUDGET, API_WRITE_RESERVE, API_REMAINING_FLOOR, RECOVERY_API_BUDGET,
  collectHealth, githubApi, HEALTH_REF, HEALTH_SCHEMA, main, readHealthState, reconcile, STALE_MS, writeHealthState } from "./main-ci-health.mjs";
import { REQUIRED, WORKER } from "./main-rolling-validation.mjs";

const repository = "example/project";
const W = "d".repeat(40), A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const chain = [W, A, B, C], claim = "12345678-1234-1234-1234-123456789012";
const at = (minutes = 0) => new Date(Date.UTC(2026, 9, 23, 12, minutes)).toISOString();
const worker = (id = 10, target = A, extra = {}) => ({ id, run_attempt: 1,
  display_title: `Rolling ${target} ${claim}`, path: WORKER, head_sha: target, head_branch: "main",
  event: "workflow_dispatch", status: "completed", conclusion: "success", created_at: at(), updated_at: at(30),
  html_url: `https://github.com/${repository}/actions/runs/${id}`,
  repository: { full_name: repository }, head_repository: { full_name: repository }, ...extra });
const legacy = (id = 9, target = A, extra = {}) => worker(id, target, {
  path: ".github/workflows/ci.yml", event: "push", head_sha: target, ...extra });
const core = ["Typecheck", "Unit Tests", "Verify Node 22 Engine Boundary", "Verify Excluded Node Engine Boundary",
  "Verify Node 23 Engine Boundary", "Verify Recommended Node Engine Boundary", "Verify Delegated Linux Provider Containment",
  "Validate Web Production Build", "Validate Runner Bundle", "Validate Control-Plane Bundle"];
const jobSteps = [core,
  ["Remote-Instance Browser End-to-End Tests", "Rendered Production Browser Smoke"],
  ...[2, 3, 4, 5].map(() => ["Remote-Instance Browser End-to-End Tests"]),
  ["WebKit Browser End-to-End Tests"], ["Compare the Diff Against the Settings-Rows Paths"],
  ["Compare Against the Committed win32 Baselines"], ["Require Every Job to Have Succeeded"]];
const jobs = (isLegacy = false) => REQUIRED.map((name, index) => ({ id: index + 1,
  name: isLegacy ? name.replace(/^Full Validation \/ /, "") : name, status: "completed", conclusion: "success",
  steps: ["Verify Rolling Checkout", ...jobSteps[index]].map((name) => ({ name, conclusion: "success" })) }));
const missing = () => { const error = new Error("private response body"); error.status = 404; throw error; };

function forge({ runs = [worker()], currentMain = A, state = null, history = chain } = {}) {
  const chain = history;
  runs.filter((run) => run.path === WORKER).forEach((run, index) => { run.run_number ??= index + 1; });
  const data = { runs, currentMain, state, oid: state ? C : null, mutations: [], requests: [],
    attempts: new Map(), jobSets: new Map(), associatedPulls: new Map(), commitTimes: new Map(), controllerRuns: [], issues: [], count: 0 };
  const oid = () => (++data.count).toString(16).padStart(40, "0");
  const api = async (path, options = {}) => {
    data.requests.push(path);
    const { method = "GET", body } = options;
    if (method !== "GET") {
      data.mutations.push({ path, method, body });
      if (path.endsWith("/git/trees")) { data.nextState = JSON.parse(body.tree[0].content); return { sha: oid() }; }
      if (path.endsWith("/git/commits")) return { sha: oid() };
      if (path === "/graphql") {
        const update = body.variables.input.refUpdates[0];
        if (update.beforeOid !== (data.oid ?? "0".repeat(40))) return { errors: [{ message: "ref changed" }] };
        data.oid = update.afterOid; data.state = data.nextState; return { data: { updateRefs: {} } };
      }
      if (path.includes("/issues") || path.endsWith("/labels")) return { number: 7 };
      throw new Error("Unexpected mutation");
    }
    const root = `/repos/${repository}`;
    if (path === "/rate_limit") return {};
    if (path === root) return { node_id: "repo-id" };
    if (path === `${root}/git/ref/heads/main`) return { object: { sha: data.currentMain } };
    if (path === `${root}/git/ref/heads/ci/main-health-state`) return data.oid ? { object: { sha: data.oid } } : missing();
    if (path === `${root}/contents/health.json?ref=${data.oid}`) {
      const content = JSON.stringify(data.state);
      return { type: "file", sha: W, encoding: "base64", size: content.length, content: Buffer.from(content).toString("base64") };
    }
    if (path.startsWith(`${root}/git/commits/`)) return { tree: { sha: B } };
    if (path.startsWith(`${root}/git/trees/`)) return { tree: [{ path: "health.json", type: "blob", sha: W }] };
    if (path.startsWith(`${root}/git/blobs/`)) {
      const content = JSON.stringify(data.state);
      return { encoding: "base64", size: content.length, content: Buffer.from(content).toString("base64") };
    }
    if (path === `${root}/actions/workflows/main-rolling-validation.yml`) return { path: WORKER, created_at: at(-60) };
    if (path.includes("/actions/workflows/") && path.includes("/runs?")) {
      if (path.includes("/main-ci-health.yml/")) return { workflow_runs: [], total_count: 0 };
      const rolling = path.includes("main-rolling-validation.yml");
      const controller = path.includes("main-rolling-controller.yml");
      const params = new URL("https://api.github.com" + path).searchParams;
      const selected = (controller ? data.controllerRuns : data.runs).filter((run) =>
        (controller ? true : rolling ? run.path === WORKER : run.path === ".github/workflows/ci.yml") &&
        (!params.get("status") || run.status === params.get("status")) &&
        (!params.get("head_sha") || run.head_sha === params.get("head_sha")) &&
        (!params.get("created") || Date.parse(run.created_at) >= Date.parse(params.get("created").slice(2))));
      const page = Number(params.get("page") ?? 1), size = Number(params.get("per_page") ?? 100);
      return { workflow_runs: selected.slice((page - 1) * size, page * size), total_count: selected.length };
    }
    const match = /\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?(\/jobs\?.*)?$/.exec(path);
    if (match) {
      const run = data.runs.find((run) => run.id === Number(match[1]));
      if (!run) return missing();
      if (!match[2]) return { ...run };
      const key = `${run.id}:${match[2]}`;
      if (!match[3]) return data.attempts.get(key) ?? { ...run, run_attempt: Number(match[2]) };
      const items = data.jobSets.get(key) ?? jobs(run.event === "push");
      return { total_count: items.length, jobs: items };
    }
    if (path.includes("/contents/")) {
      const name = path.split("/contents/")[1].split("?")[0], content = readFileSync(name, "utf8");
      return { sha: createHash("sha1").update(content).digest("hex"), encoding: "base64", content: Buffer.from(content).toString("base64") };
    }
    if (path.includes("/compare/")) {
      const [from, to] = path.split("/compare/")[1].split("?")[0].split("...");
      const i = chain.indexOf(from), j = chain.indexOf(to);
      const commits = i >= 0 && j >= i ? chain.slice(i + 1, j + 1).map((sha) => ({ sha, parents: [{ sha: from }],
        commit: { committer: { date: data.commitTimes.get(sha) ?? at(31) } } })) : [];
      return { merge_base_commit: { sha: i >= 0 && j >= i ? from : W }, commits, total_commits: commits.length };
    }
    if (path.includes("/commits/") && path.includes("/pulls?")) {
      const sha = path.split("/commits/")[1].slice(0, 40);
      return data.associatedPulls.get(sha) ?? [{ number: chain.indexOf(sha), merged_at: at(31),
        merge_commit_sha: sha, base: { ref: "main", repo: { full_name: repository } } }];
    }
    if (path.includes("/issues?")) return data.issues;
    if (path.includes("/commits/")) return { author: null };
    throw new Error(`Unexpected fake API path ${path}`);
  };
  return { data, api, collect: (options = {}) => collectHealth(repository, { api, now: () => at(40), ...options }) };
}

function makeRed(f, id = 10, attempt = 1) {
  const js = jobs(f.data.runs.find((run) => run.id === id)?.event === "push");
  js[0].conclusion = "failure";
  js[0].steps.find((step) => step.name === "Unit Tests").conclusion = "failure";
  f.data.jobSets.set(`${id}:${attempt}`, js);
}

test("complete full evidence certifies tested target, separately from dispatch head, with exact inventory", async () => {
  const f = forge(), health = await f.collect();
  assert.equal(health.status, "passing");
  assert.equal(health.fullCertification.testedSha, A);
  assert.equal(health.fullCertification.dispatcherSha, A);
  assert.equal(health.fullCertification.workflowPath, WORKER);
  assert.equal(health.fullCertification.attempt, 1);
  assert.match(health.fullCertification.suiteVersion, /^[a-f0-9]{64}$/);
  assert.equal(health.fullCertification.inventory.length, REQUIRED.length);
  assert.equal(health.backlog.commits, 0);
  assert.ok(!f.data.requests.some((path) => path.includes("main-rolling-state") || path.includes("artifacts")));
  const delayed = await forge({ currentMain: B, runs: [worker(10, A, { head_sha: B })] }).collect();
  assert.equal(delayed.latestPassingSnapshot.testedSha, A);
  assert.equal(delayed.latestPassingSnapshot.dispatcherSha, B);
  assert.equal(delayed.fullCertification, null, "dispatch head never becomes the tested snapshot");
});

test("idle caught-up main stays fresh; freshness starts at oldest unvalidated commit", async () => {
  const idle = await forge().collect({ now: () => at(100_000) });
  assert.equal(idle.status, "passing"); assert.equal(idle.backlog.oldestUnvalidatedAt, null);
  const behind = forge({ currentMain: C }), pending = await behind.collect();
  assert.equal(pending.status, "pending"); assert.equal(pending.latestPassingSnapshot.testedSha, A);
  assert.equal(pending.fullCertification, null); assert.equal(pending.backlog.commits, 2);
  assert.equal(pending.backlog.merges, 2, "squash-merged PRs count even without Git merge parents");
  assert.equal(pending.backlog.oldestUnvalidatedAgeSeconds, 9 * 60);
  assert.equal((await behind.collect({ now: () => at(STALE_MS / 60_000 + 32) })).status, "stale");
});

test("queue freshness starts at verified PR landing, not the merge group's earlier committer time", async () => {
  const landed = "2026-10-23T20:01:22.000Z", observed = "2026-10-23T20:05:22.000Z";
  const f = forge({ currentMain: B });
  f.data.commitTimes.set(B, "2026-10-23T19:20:07.000Z");
  f.data.associatedPulls.set(B, [{ number: 3647, merged_at: landed, merge_commit_sha: B,
    base: { ref: "main", repo: { full_name: repository } } }]);
  const health = await f.collect({ now: () => observed });
  assert.equal(health.status, "pending");
  assert.equal(health.backlog.clock, "forge-landing-time");
  assert.equal(health.backlog.oldestUnvalidatedAt, landed);
  assert.equal(health.backlog.oldestUnvalidatedAgeSeconds, 240);
  assert.equal(health.backlog.landingEvidence[0].pullRequest, 3647);
  assert.ok(!f.data.requests.some((path) => path.includes("main-rolling-controller.yml/runs")), "PR proof adds no controller census");
});

test("direct main pushes use the controller's forge-created push run when no PR proves landing", async () => {
  const f = forge({ currentMain: B }); f.data.associatedPulls.set(B, []);
  f.data.controllerRuns = [worker(20, B, { path: ".github/workflows/main-rolling-controller.yml", event: "push", created_at: at(35) })];
  const health = await f.collect();
  assert.equal(health.status, "pending"); assert.equal(health.backlog.merges, 0);
  assert.equal(health.backlog.oldestUnvalidatedAgeSeconds, 300);
  assert.equal(health.backlog.landingEvidence[0].source, "main-push-controller-created-at");
  assert.equal(health.backlog.landingEvidence[0].runId, 20);
});

test("freshness uses the oldest verified landing across the complete backlog", async () => {
  const f = forge({ currentMain: C });
  for (const [sha, minutes] of [[B, 35], [C, 33]]) f.data.associatedPulls.set(sha, [
    { number: chain.indexOf(sha), merged_at: at(minutes), merge_commit_sha: sha,
      base: { ref: "main", repo: { full_name: repository } } }]);
  const health = await f.collect();
  assert.equal(health.backlog.oldestUnvalidatedAt, at(33));
  assert.equal(health.backlog.oldestUnvalidatedAgeSeconds, 420);
  assert.equal(health.backlog.landingEvidence.length, 2);
  assert.equal(health.backlog.merges, 2);
});

test("unmerged, future and foreign PR associations cannot establish a main landing", async () => {
  for (const extra of [{ merged_at: null }, { merged_at: at(41) }, { merged_at: "invalid" },
    { merge_commit_sha: A }, { base: { ref: "other", repo: { full_name: repository } } },
    { base: { ref: "main", repo: { full_name: "other/repo" } } }]) {
    const f = forge({ currentMain: B });
    f.data.associatedPulls.set(B, [{ number: 8, merged_at: at(35), merge_commit_sha: B,
      base: { ref: "main", repo: { full_name: repository } }, ...extra }]);
    const health = await f.collect();
    assert.equal(health.status, "unknown"); assert.deepEqual(health.reasons, ["landing-time-unavailable"]);
    assert.equal(health.backlog.oldestUnvalidatedAt, null);
  }
});

test("missing, unrelated, future or incomplete landing evidence stays unknown without using commit time", async () => {
  for (const extra of [null, { event: "workflow_dispatch" }, { path: ".github/workflows/other.yml" },
    { head_branch: "other" }, { repository: { full_name: "other/repo" } },
    { head_repository: { full_name: "fork/repo" } }, { created_at: at(41) }, { created_at: "invalid" }]) {
    const f = forge({ currentMain: B });
    f.data.associatedPulls.set(B, [{ number: 8, merged_at: at(35), merge_commit_sha: A,
      base: { ref: "main", repo: { full_name: repository } } }]);
    f.data.controllerRuns = extra === null ? [] : [worker(20, B, {
      path: ".github/workflows/main-rolling-controller.yml", event: "push", created_at: at(35), ...extra })];
    const health = await f.collect();
    assert.equal(health.status, "unknown"); assert.deepEqual(health.reasons, ["landing-time-unavailable"]);
    assert.equal(health.backlog.oldestUnvalidatedAt, null); assert.equal(health.fullCertification, null);
  }
  const f = forge({ currentMain: B }); f.data.associatedPulls.set(B, []);
  const api = async (path, options) => path.includes("main-rolling-controller.yml/runs")
    ? { workflow_runs: [], total_count: 101 } : f.api(path, options);
  assert.deepEqual((await collectHealth(repository, { api, now: () => at(40) })).reasons, ["incomplete-landing-pagination"]);
});

test("skipped, cancelled, partial, duplicate, missing-checkout and omitted-test outcomes never certify", async () => {
  for (const change of [
    (js) => { js[1].conclusion = "skipped"; }, (js) => { js[2].conclusion = "cancelled"; }, (js) => { js.pop(); },
    (js) => { js[0].steps = js[0].steps.filter((step) => step.name !== "Verify Rolling Checkout"); },
    (js) => { js.push({ ...js[0], id: 55 }); },
    (js) => { js[0].steps = js[0].steps.filter((step) => step.name !== "Unit Tests"); },
    (js) => { js[1].steps.find((step) => step.name === "Rendered Production Browser Smoke").conclusion = "skipped"; },
  ]) {
    const f = forge(), js = jobs(); change(js); f.data.jobSets.set("10:1", js);
    const health = await f.collect();
    assert.equal(health.status, "unknown"); assert.equal(health.fullCertification, null);
  }
  for (const conclusion of ["cancelled", "skipped", "failure"])
    assert.equal((await forge({ runs: [worker(10, A, { conclusion })] }).collect()).fullCertification, null);
});

test("unrelated, synthetic dispatch and wrong-repository runs cannot certify", async () => {
  for (const run of [legacy(10, A, { event: "workflow_dispatch" }), worker(10, A, { path: ".github/workflows/other.yml" }),
    worker(10, A, { repository: { full_name: "other/repo" } }), worker(10, A, { head_repository: { full_name: "fork/repo" } }),
    worker(10, A, { display_title: "Synthetic Failure" })]) {
    const health = await forge({ runs: [run] }).collect();
    assert.equal(health.status, "unknown"); assert.equal(health.fullCertification, null);
  }
});

test("pending and incomplete reruns revoke cached green; complete latest attempt restores it", async () => {
  for (const [status, conclusion] of [["in_progress", null], ["completed", "cancelled"], ["completed", "success"]]) {
    const f = forge({ runs: [worker(10, A, { run_attempt: 2, status, conclusion })] });
    f.data.attempts.set("10:1", worker());
    if (status === "in_progress") f.data.jobSets.set("10:2", []);
    const health = await f.collect();
    assert.equal(health.evidence.length, 2); assert.equal(health.latestAttempt.attempt, 2);
    assert.equal(health.fullCertification?.attempt ?? null, conclusion === "success" ? 2 : null);
  }
  const f = forge({ runs: [worker(11, A, { status: "in_progress", conclusion: null }), worker()] });
  assert.equal((await f.collect()).latestPassingSnapshot, null, "a new claim at the same target revokes green too");
});

test("target ancestry beats completion order; passing ancestor cannot hide newer failure", async () => {
  const f = forge({ currentMain: B, runs: [worker(30, A), worker(20, B, { conclusion: "failure" })] }); makeRed(f, 20);
  const health = await f.collect();
  assert.equal(health.status, "failing"); assert.equal(health.latestAttempt.testedSha, B);
  assert.equal(health.unresolvedFailures[0].runId, 20);
  const resolved = forge({ currentMain: B, runs: [worker(30, A, { conclusion: "failure" }), worker(20, B)] }); makeRed(resolved, 30);
  const green = await resolved.collect();
  assert.equal(green.status, "passing"); assert.equal(green.unresolvedFailures.length, 0);
});

test("failed attempt remains unresolved through rerun until complete full success", async () => {
  const f = forge({ runs: [worker(10, A, { run_attempt: 2, status: "in_progress", conclusion: null })] });
  f.data.attempts.set("10:1", worker(10, A, { conclusion: "failure" })); makeRed(f);
  let health = await f.collect();
  assert.equal(health.status, "failing"); assert.equal(health.unresolvedFailures[0].attempt, 1);
  f.data.runs[0].status = "completed"; f.data.runs[0].conclusion = "success";
  health = await f.collect(); assert.equal(health.status, "passing"); assert.deepEqual(health.unresolvedFailures, []);
});

test("legacy and fast success are uncertified and cannot resolve full incidents", async () => {
  const f = forge({ runs: [legacy(30), worker(10, A, { conclusion: "failure" })] }); makeRed(f);
  const health = await f.collect(); assert.equal(health.status, "failing");
  assert.equal(health.legacyEvidence[0].source, "legacy-main-push");
  assert.equal(health.legacyEvidence[0].certification, "none");
  const resolved = forge({ runs: [legacy(9, A, { conclusion: "failure" }), worker(10, B)], currentMain: B }); makeRed(resolved, 9);
  assert.equal((await resolved.collect()).status, "passing");
});

test("missing evidence, pagination, ancestry, source binding and rerun races fail closed", async () => {
  const variants = [
    async (path, fallback) => path.includes("/jobs?") ? { jobs: [], total_count: 1 } : fallback(),
    async (path, fallback) => path.includes("/compare/") ? {} : fallback(),
    async (path, fallback) => path.includes("/contents/") ? { sha: A } : fallback(),
    async (path, fallback) => path.endsWith("/runs/10") ? worker(10, A, { run_attempt: 2 }) : fallback(),
    async () => { throw new Error("token private response"); },
  ];
  for (const variant of variants) {
    const f = forge({ currentMain: B }), health = await collectHealth(repository, { api: (path) => variant(path, () => f.api(path)), now: () => at(40) });
    assert.equal(health.status, "unknown"); assert.equal(health.fullCertification, null);
    assert.doesNotMatch(JSON.stringify(health), /token private/);
  }
});

test("older attempt mismatches and reruns starting after job reads invalidate the final observation", async () => {
  const older = forge({ runs: [worker(10, A, { run_attempt: 2 })] });
  const invalid = await collectHealth(repository, { api: (path) => path.endsWith("/attempts/1")
    ? worker(10, A, { run_attempt: 2 }) : older.api(path) });
  assert.equal(invalid.status, "unknown"); assert.equal(invalid.fullCertification, null);
  const f = forge();
  const raced = await collectHealth(repository, { api: async (path) => {
    const result = await f.api(path);
    if (path.includes("/jobs?")) f.data.runs[0] = worker(10, A, { run_attempt: 2, status: "in_progress", conclusion: null, run_number: 1 });
    return result;
  } });
  assert.equal(raced.status, "unknown"); assert.equal(raced.fullCertification, null);
  assert.deepEqual(raced.reasons, ["run-changed"]);
});

test("persistence is CAS fenced, compacted, and discarded as certification input", async () => {
  const f = forge();
  assert.deepEqual(await readHealthState(f.api, repository), { oid: null, sequence: 0, pointers: [], recovered: true });
  const health = await f.collect();
  await writeHealthState(f.api, repository, { oid: null, sequence: 0, recovered: true }, health);
  assert.equal(f.data.state.fullCertification.testedSha, A);
  const cached = await readHealthState(f.api, repository);
  assert.deepEqual(Object.keys(cached).sort(), ["oid", "pointers", "recovered", "sequence"]);
  assert.deepEqual(cached.pointers, [10]);
  await assert.rejects(writeHealthState(f.api, repository, { oid: null, sequence: 0 }, health), /health-write-conflict/);
  await writeHealthState(f.api, repository, { ...cached, sequence: 127 }, health);
  assert.deepEqual(f.data.mutations.filter((m) => m.path.endsWith("/git/commits")).at(-1).body.parents, []);
  assert.equal(f.data.mutations.at(-1).body.variables.input.refUpdates[0].name, HEALTH_REF);
  f.data.state = { ...f.data.state, fullCertification: { testedSha: C }, runPointers: [999] };
  const forged = await readHealthState(f.api, repository), unknown = await f.collect({ pointers: forged.pointers });
  assert.equal(unknown.status, "passing"); assert.equal(unknown.fullCertification.testedSha, A, "a missing cache hint cannot spoof the target or poison valid fresh evidence");
});

test("report is read-only, schema-versioned JSON; invalid modes are refused", async () => {
  const f = forge(), output = [], env = { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test", GITHUB_REF: "refs/heads/main" };
  assert.equal(await main(["report"], { env, api: f.api, log: (line) => output.push(JSON.parse(line)) }), 0);
  assert.equal(output[0].schema, HEALTH_SCHEMA); assert.deepEqual(f.data.mutations, []);
  assert.equal(await main(["invalid"], { env, api: f.api, error: () => {} }), 1);
});

test("a new worker appearing during observation invalidates the old success", async () => {
  const f = forge(); let listings = 0;
  const api = async (path) => {
    const result = await f.api(path);
    if (path.includes("main-rolling-validation.yml/runs?") && path.includes("&head_sha=") && ++listings > 1)
      return { ...result, total_count: 2, workflow_runs: [...result.workflow_runs, worker(20, A, { status: "in_progress", conclusion: null })] };
    return result;
  };
  const health = await collectHealth(repository, { api });
  assert.equal(health.status, "unknown"); assert.equal(health.fullCertification, null);
  assert.deepEqual(health.reasons, ["listing-changed"]);
});

test("bounded job pagination cannot certify a partial first page", async () => {
  const f = forge(); let pages = 0;
  const health = await collectHealth(repository, { api: async (path) => {
    if (!path.includes("/jobs?")) return f.api(path);
    pages++;
    return { total_count: 1001, jobs: Array.from({ length: 100 }, (_, i) => ({ id: (pages - 1) * 100 + i + 1 })) };
  } });
  assert.equal(pages, 10); assert.equal(health.status, "unknown");
  assert.deepEqual(health.reasons, ["incomplete-pagination"]);
});

test("the real observation and persistence path closes only a superseded full incident", async () => {
  const f = forge({ currentMain: B, runs: [worker(10, A, { conclusion: "failure" }), worker(20, B)] }); makeRed(f);
  f.data.issues = [{ number: 7, state: "open", title: ALERT_TITLE, labels: [{ name: ALERT_LABEL }],
    user: { login: "github-actions[bot]" }, body: "<!-- main-ci-health latest:10 -->" }];
  assert.equal(await reconcile({ repository }, { api: f.api, log: () => {}, now: () => at(40) }), "closed");
  assert.equal(f.data.state.status, "passing");
  assert.ok(f.data.state.resolvedRunIds.includes(10));
  assert.ok(f.data.mutations.some((mutation) => mutation.body?.state === "closed"));
  const red = forge({ runs: [worker(10, A, { conclusion: "failure" })] }); makeRed(red);
  assert.equal(await reconcile({ repository }, { api: red.api, log: () => {}, now: () => at(40) }), "opened");
  assert.ok(red.data.mutations.find((mutation) => mutation.path.endsWith("/issues")).body.body.includes("evidence:10:1"));
});

test("unknown and fast-success evidence keep an existing full incident open", async () => {
  const f = forge({ runs: [worker(10, A, { conclusion: "failure" }), legacy(30)] }); makeRed(f);
  f.data.issues = [{ number: 7, state: "open", title: ALERT_TITLE, labels: [{ name: ALERT_LABEL }],
    user: { login: "github-actions[bot]" }, body: "<!-- main-ci-health latest:10 -->" }];
  assert.equal(await reconcile({ repository }, { api: f.api, log: () => {}, now: () => at(40) }), "unchanged");
  assert.ok(!f.data.mutations.some((mutation) => mutation.body?.state === "closed"));
  const output = [], env = { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test", GITHUB_REF: "refs/heads/main" };
  assert.equal(await main(["report"], { env, api: async () => { throw new Error("private body"); },
    log: (line) => output.push(JSON.parse(line)), error: () => {} }), 1);
  assert.equal(output[0].status, "unknown"); assert.doesNotMatch(JSON.stringify(output), /private body/);
});

test("50 historical main pushes use a verified checkpoint window and bounded linear API work", async () => {
  const targets = Array.from({ length: 50 }, (_, i) => (i + 1000).toString(16).padStart(40, "0"));
  const runs = targets.map((sha, i) => legacy(i + 100, sha, { created_at: at(i) }));
  const tip = targets.at(-1);
  runs.unshift(worker(999, tip, { created_at: at(50) }));
  const f = forge({ runs, currentMain: tip, history: [W, ...targets] });
  const health = await f.collect({ now: () => at(80) });
  assert.equal(health.status, "passing");
  assert.equal(health.checkpoint.targetSha, tip);
  assert.ok(f.data.requests.filter((path) => path.includes("/compare/")).length < 12);
  assert.ok(f.data.requests.length < 45, `unexpected API request count ${f.data.requests.length}`);
  assert.ok(!f.data.requests.some((path) => /\/runs\/1[0-3][0-9](?:\/|$)/.test(path)));
});

test("invalid non-main dispatches and stale cache hints do not poison healthy evidence", async () => {
  const f = forge({ runs: [worker(), worker(20, "e".repeat(40))] });
  const health = await f.collect({ pointers: [999] });
  assert.equal(health.status, "passing");
  const retainedIncident = await f.collect({ pointers: [999], incidentRunId: 999 });
  assert.equal(retainedIncident.status, "unknown", "missing incident evidence remains unknown");
});

test("startup failures open the existing alert without manufacturing a passing snapshot", async () => {
  const f = forge({ runs: [legacy(10, A, { conclusion: "startup_failure" })] });
  f.data.jobSets.set("10:1", []);
  assert.equal(await reconcile({ repository }, { api: f.api, log: () => {} }), "opened");
  assert.equal(f.data.state.status, "failing"); assert.equal(f.data.state.fullCertification, null);
});

test("an incomplete newer incident never closes from an older full pass", async () => {
  const f = forge({ currentMain: B, runs: [worker(10, A), legacy(20, B, { conclusion: "cancelled" })] });
  f.data.issues = [{ number: 7, state: "open", title: ALERT_TITLE, labels: [{ name: ALERT_LABEL }],
    user: { login: "github-actions[bot]" }, body: "<!-- main-ci-health latest:20 -->" }];
  assert.equal(await reconcile({ repository }, { api: f.api, log: () => {}, now: () => at(40) }), "unchanged");
  assert.ok(!f.data.mutations.some((mutation) => mutation.body?.state === "closed"));
});

test("late evidence invalidation cannot drive alert mutations", async () => {
  const f = forge({ runs: [worker(10, A, { conclusion: "failure" })] }); makeRed(f);
  let reads = 0;
  const api = (path, options) => path.endsWith("/git/ref/heads/main") && ++reads > 1
    ? { object: { sha: B } } : f.api(path, options);
  assert.equal(await reconcile({ repository }, { api, log: () => {} }), "unchanged");
  assert.equal(f.data.state.status, "unknown"); assert.deepEqual(f.data.state.unresolvedFailures, []);
  assert.ok(!f.data.mutations.some((mutation) => mutation.path.endsWith("/issues")));
});

test("deleted or expired worker sequences remain unknown instead of silently certifying", async () => {
  const f = forge({ runs: [worker(10, A, { run_number: 1 }), worker(30, A, { run_number: 3 })] });
  const health = await f.collect();
  assert.equal(health.status, "unknown"); assert.deepEqual(health.reasons, ["worker-history-incomplete"]);
});

test("read-only report recovers an older incident directly after health-ref loss", async () => {
  const f = forge({ currentMain: B, runs: [worker(), legacy(20, B, { created_at: at(-100), conclusion: "failure" })] }); makeRed(f, 20);
  f.data.issues = [{ number: 7, state: "open", title: ALERT_TITLE, labels: [{ name: ALERT_LABEL }],
    user: { login: "github-actions[bot]" }, body: "<!-- main-ci-health latest:20 -->" }];
  const output = [], env = { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test", GITHUB_REF: "refs/heads/main" };
  assert.equal(await main(["report"], { env, api: f.api, log: (line) => output.push(JSON.parse(line)) }), 0);
  assert.equal(output[0].status, "failing");
  assert.equal(output[0].unresolvedFailures[0].runId, 20);
  assert.deepEqual(f.data.mutations, []);
});

test("push-run delivery timestamps cannot exclude a verified worker", async () => {
  const f = forge();
  const api = async (path) => {
    const result = await f.api(path);
    return path.includes("/runs?branch=main&event=push&head_sha=") && result.workflow_runs?.length
      ? { ...result, workflow_runs: result.workflow_runs.map((run) => ({ ...run, created_at: at(1) })) } : result;
  };
  const health = await collectHealth(repository, { api });
  assert.equal(health.status, "passing"); assert.equal(health.fullCertification.testedSha, A);
});

test("a delayed push event cannot hide a failing descendant created before an older-target pass", async () => {
  const f = forge({ currentMain: C, runs: [worker(30, A, { created_at: at(100) }),
    worker(20, B, { created_at: at(50), conclusion: "failure" }),
    legacy(10, A, { created_at: at(90) }), legacy(11, B, { created_at: at(40) })] }); makeRed(f, 20);
  const health = await f.collect({ now: () => at(120) });
  assert.equal(health.status, "failing"); assert.equal(health.unresolvedFailures[0].testedSha, B);
  assert.ok(health.ancestryWindow.dispatcherShas.includes(B));
});

test("eight unvalidated pushes keep the API work bounded and avoid loading legacy-success jobs", async () => {
  const targets = Array.from({ length: 50 }, (_, i) => (i + 1000).toString(16).padStart(40, "0"));
  const runs = targets.map((sha, i) => legacy(i + 100, sha, { created_at: at(i) }));
  runs.unshift(worker(500, targets[41], { created_at: at(80) }),
    worker(999, targets.at(-1), { created_at: at(81), status: "in_progress", conclusion: null }));
  const f = forge({ runs, currentMain: targets.at(-1), history: [W, ...targets] });
  const health = await f.collect({ now: () => at(90) });
  assert.equal(health.status, "pending"); assert.equal(health.backlog.commits, 8);
  assert.ok(f.data.requests.length < 100, `API calls ${f.data.requests.length}`);
  assert.ok(!f.data.requests.some((path) => /\/runs\/1\d\d\/attempts\//.test(path)));
});

test("a nested evidence 404 is never swallowed as a stale cache hint", async () => {
  for (const pointers of [[], [20]]) {
    const f = forge({ currentMain: B, runs: [worker(), legacy(20, B, { conclusion: "failure" })] }); makeRed(f, 20);
    const health = await collectHealth(repository, { pointers, api: (path) => path.includes("/contents/") && path.endsWith(`ref=${B}`) ? missing() : f.api(path) });
    assert.equal(health.status, "unknown"); assert.equal(health.fullCertification, null);
  }
});

test("an alert without its identity marker stays open with explicit unknown diagnostics", async () => {
  const f = forge();
  f.data.issues = [{ number: 7, state: "open", title: ALERT_TITLE, labels: [{ name: ALERT_LABEL }],
    user: { login: "github-actions[bot]" }, body: "An edited incident with no marker" }];
  assert.equal(await reconcile({ repository }, { api: f.api, log: () => {} }), "unchanged");
  assert.equal(f.data.state.status, "unknown"); assert.ok(f.data.state.reasons.includes("incident-identity-unavailable"));
});

test("invalidated checkpoint recovery has its own budget and discards the rejected hint even on unknown", async () => {
  const targets = Array.from({ length: 10 }, (_, i) => (i + 1000).toString(16).padStart(40, "0"));
  const reds = targets.slice(1, 9).reverse().map((sha, i) => worker(100 + i, sha, { conclusion: "failure" }));
  const runs = [...reds, worker(11, targets[0], { conclusion: "failure" }), worker(10, targets[0])];
  const f = forge({ runs, currentMain: targets.at(-1), history: [W, ...targets] });
  for (const run of runs.filter((run) => run.conclusion === "failure")) makeRed(f, run.id);
  const health = await f.collect({ pointers: [10] });
  assert.equal(health.status, "unknown"); assert.equal(health.fullCertification, null);
  assert.deepEqual(health.reasons, ["api-budget-exhausted"]);
  assert.equal(health.checkpoint, undefined);
  assert.equal(health.recovery.reason, "checkpoint-invalidated");
  assert.equal(health.recovery.calls, RECOVERY_API_BUDGET);
  assert.deepEqual(health.unresolvedFailures, []);
  await writeHealthState(f.api, repository, { oid: null, sequence: 0, recovered: true, pointers: [10] }, health);
  assert.notEqual((await readHealthState(f.api, repository)).pointers[0], 10, "the rejected checkpoint is not promoted again");
});

test("the production entry point caps a long backlog and neither opens nor closes an incident on exhaustion", async () => {
  for (const quota of [1000, 5000]) for (const open of [false, true]) {
    const targets = Array.from({ length: 41 }, (_, i) => (i + 1000).toString(16).padStart(40, "0"));
    const f = forge({ runs: [worker(10, targets[0])], currentMain: targets.at(-1), history: [W, ...targets] });
    if (open) f.data.issues = [{ number: 7, state: "open", title: ALERT_TITLE, labels: [{ name: ALERT_LABEL }],
      user: { login: "github-actions[bot]" }, body: "<!-- main-ci-health latest:10 -->" }];
    const api = githubApi("test", async (url, options) => ({ ok: true, status: 200,
      headers: new Headers({ "x-ratelimit-limit": String(quota), "x-ratelimit-remaining": String(quota - 100) }),
      json: () => f.api(new URL(url).pathname + new URL(url).search,
        { ...options, body: options.body ? JSON.parse(options.body) : undefined }) }));
    const output = [];
    const code = await main([], { env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test", GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "schedule" }, api, log: (line) => output.push(line) });
    assert.equal(code, 0);
    const observed = output.filter((line) => line.startsWith("{")).map(JSON.parse);
    assert.equal(observed.find((entry) => entry.event === "main_ci_health_observed").status, "unknown");
    assert.equal(observed.at(-1).reason, "api-budget-exhausted");
    assert.equal(f.data.requests.length, (quota === 5000 ? API_MAX_BUDGET : API_BUDGET) - API_WRITE_RESERVE);
    assert.deepEqual(f.data.mutations, []);
  }
});

test("low remaining quota backs off before any health or incident mutation and records safe counts", async () => {
  const f = forge({ runs: [worker(10, A, { conclusion: "failure" })] }); makeRed(f);
  const api = githubApi("secret-token", async (url, options) => ({ ok: true, status: 200,
    headers: new Headers({ "x-ratelimit-limit": "1000", "x-ratelimit-remaining": String(API_REMAINING_FLOOR - 1) }),
    json: () => f.api(new URL(url).pathname + new URL(url).search, options),
  }));
  const output = [];
  const code = await main([], { env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "secret-token", GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "schedule" }, api, log: (line) => output.push(line), error: (line) => output.push(line) });
  assert.equal(code, 1);
  const usage = output.filter((line) => line.startsWith("{")).map(JSON.parse).at(-1);
  assert.equal(usage.calls, 1); assert.equal(usage.rateLimit, 1000);
  assert.equal(usage.rateRemaining, API_REMAINING_FLOOR - 1);
  assert.equal(usage.reason, "api-quota-reserved");
  assert.deepEqual(f.data.mutations, []); assert.doesNotMatch(output.join("\n"), /secret-token/);
  assert.deepEqual(f.data.requests, ["/rate_limit"], "low-quota wakes use only the primary-exempt preflight");
});

test("a caught-up production observation verifies and persists within the cap, including mutation calls", async () => {
  const f = forge(); let calls = 0;
  const api = githubApi("test", async (url, options) => {
    calls++;
    const path = new URL(url).pathname + new URL(url).search;
    return { ok: true, status: 200,
      headers: new Headers({ "x-ratelimit-limit": "1000", "x-ratelimit-remaining": String(1000 - calls) }),
      json: () => f.api(path, { ...options, body: options.body ? JSON.parse(options.body) : undefined }),
    };
  });
  const output = [];
  assert.equal(await main([], { env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test", GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "schedule" }, api, log: (line) => output.push(JSON.parse(line)) }), 0);
  assert.equal(f.data.state.status, "passing");
  assert.equal(f.data.state.fullCertification.testedSha, A);
  assert.ok(f.data.mutations.some((mutation) => mutation.path === "/graphql"));
  const usage = output.at(-1);
  assert.equal(usage.calls, calls); assert.ok(calls <= API_BUDGET);
  assert.equal(usage.reason, null); assert.equal(usage.rateRemaining, 1000 - calls + 1);
  assert.equal(usage.graphqlRemaining, 1000 - calls);
});

test("a terminal worker dispatch observes and persists its exact run within the same quota cap", async () => {
  const f = forge(); let calls = 0;
  const api = githubApi("test", async (url, options) => {
    calls++;
    return { ok: true, status: 200,
      headers: new Headers({ "x-ratelimit-limit": "1000", "x-ratelimit-remaining": String(1000 - calls) }),
      json: () => f.api(new URL(url).pathname + new URL(url).search,
        { ...options, body: options.body ? JSON.parse(options.body) : undefined }),
    };
  });
  const output = [];
  assert.equal(await main([], { env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test", GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch", MAIN_CI_HEALTH_WORKER_RUN_ID: "10", MAIN_CI_HEALTH_WORKER_ATTEMPT: "1" },
    api, log: line => output.push(JSON.parse(line)) }), 0);
  assert.equal(f.data.state.status, "passing");
  assert.equal(f.data.state.workerHandoff.runId, 10);
  assert.equal(f.data.state.workerHandoff.status, "completed");
  assert.ok(f.data.state.evidence.some(record => record.runId === 10 && record.certification === "full"));
  assert.ok(output.some(entry => entry.event === "main_ci_health_worker_terminal" && entry.runId === 10));
  assert.equal(output.at(-1).calls, calls); assert.ok(calls <= API_BUDGET);
});

test("terminal handoff preserves failure alerting and exact-run deduplication", async () => {
  const f = forge({ runs: [worker(10, A, { conclusion: "failure" })] });
  const failed = jobs(); failed[0].conclusion = "failure";
  f.data.jobSets.set("10:1", failed);
  const env = { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test", GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch", MAIN_CI_HEALTH_WORKER_RUN_ID: "10", MAIN_CI_HEALTH_WORKER_ATTEMPT: "1" };
  assert.equal(await main([], { env, api: f.api, log: () => {} }), 0);
  assert.equal(f.data.state.status, "failing");
  const opened = f.data.mutations.filter(m => m.path === `/repos/${repository}/issues`);
  assert.equal(opened.length, 1); assert.ok(opened[0].body.body.includes("evidence:10:1"));
  f.data.issues = [{ number: 7, state: "open", title: ALERT_TITLE, labels: [{ name: ALERT_LABEL }],
    user: { login: "github-actions[bot]", type: "Bot" }, body: opened[0].body.body }];
  f.data.mutations.length = 0;
  assert.equal(await main([], { env, api: f.api, log: () => {} }), 0);
  assert.equal(f.data.mutations.filter(m => m.path.includes("/issues")).length, 0,
    "a repeated exact-worker wake must not repeat the alert or close it");
});

test("the production entry point persists and alerts on one failing descendant with existing state and legacy red", async () => {
  for (const includeLegacy of [false, true]) {
    const f = forge();
    await writeHealthState(f.api, repository, { oid: null, sequence: 0, recovered: true }, await f.collect());
    f.data.currentMain = B;
    f.data.runs.unshift(worker(20, B, { conclusion: "failure", run_number: 2 })); makeRed(f, 20);
    if (includeLegacy) { f.data.runs.unshift(legacy(30, B, { conclusion: "failure" })); makeRed(f, 30); }
    f.data.requests.length = 0; f.data.mutations.length = 0;
    const output = [];
    const api = includeLegacy ? githubApi("test", async (url, options) => {
      const path = new URL(url).pathname + new URL(url).search;
      const graphql = path === "/graphql";
      return { ok: true, status: 200, headers: new Headers({
        "x-ratelimit-limit": graphql ? "5000" : "1000", "x-ratelimit-remaining": graphql ? "550" : "900",
      }), json: () => f.api(path, { ...options, body: options.body ? JSON.parse(options.body) : undefined }) };
    }) : f.api;
    assert.equal(await main([], { env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test", GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "schedule" }, api, log: (line) => output.push(line) }), 0);
    assert.equal(f.data.state.status, "failing");
    assert.ok(f.data.mutations.some((mutation) => mutation.path === `/repos/${repository}/issues`));
    assert.ok(f.data.requests.length <= API_BUDGET);
    const usage = JSON.parse(output.at(-1)); assert.equal(usage.reason, null);
    if (includeLegacy) { assert.equal(usage.rateRemaining, 900); assert.equal(usage.graphqlRemaining, 550); }
  }
});

test("a newer same-target failing seed invalidates green without repeatedly exhausting recovery", async () => {
  const f = forge({ runs: [worker(11, A, { conclusion: "failure" }), worker(10, A)] }); makeRed(f, 11);
  for (let wake = 0; wake < 2; wake++) {
    const health = await f.collect();
    assert.equal(health.status, "failing"); assert.equal(health.fullCertification, null);
    assert.ok(health.unresolvedFailures.some((failure) => failure.runId === 11));
    assert.equal(health.recovery, undefined);
  }
  f.data.requests.length = 0;
  assert.equal(await main([], { env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test", GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "schedule" }, api: f.api, log: () => {} }), 0);
  assert.equal(f.data.state.status, "failing");
  assert.ok(f.data.mutations.some((mutation) => mutation.path === `/repos/${repository}/issues`));
  assert.ok(f.data.requests.length <= API_BUDGET);
});

test("quota-sized production observations handle lag zero through five with active workers and incidents", async (t) => {
  for (let lag = 0; lag <= 5; lag++) for (const mode of ["pending", "red", "recovery"]) {
    await t.test(`${mode}, lag ${lag}`, async () => {
      const targets = Array.from({ length: lag + 3 }, (_, i) => (i + 1000).toString(16).padStart(40, "0"));
      const baseline = targets[1], currentMain = targets[lag + 1];
      const runs = [worker(20, baseline), worker(30, lag ? currentMain : targets[0], {
        status: "in_progress", conclusion: null, run_started_at: new Date().toISOString() })];
      if (mode === "red") runs.push(worker(25, currentMain, { conclusion: "failure", run_number: 2 }));
      if (mode === "recovery") runs.push(worker(10, targets[0], { conclusion: "failure", run_number: 1 }));
      runs.sort((a, b) => b.id - a.id);
      // Run numbers represent contiguous creation order, independently of target order.
      [...runs].sort((a, b) => a.id - b.id).forEach((run, index) => { run.run_number = index + 1; });
      const f = forge({ runs, currentMain, history: [W, ...targets] });
      for (const [index, sha] of targets.entries()) f.data.associatedPulls.set(sha, [{ number: index + 1,
        merged_at: new Date(Date.now() - 60_000).toISOString(), merge_commit_sha: sha,
        base: { ref: "main", repo: { full_name: repository } } }]);
      if (mode !== "pending") makeRed(f, mode === "red" ? 25 : 10);
      if (mode === "recovery") f.data.issues = [{ number: 7, state: "open", title: ALERT_TITLE,
        labels: [{ name: ALERT_LABEL }], user: { login: "github-actions[bot]" }, body: "<!-- main-ci-health latest:10 -->" }];
      const api = githubApi("test", async (url, options) => {
        const path = new URL(url).pathname + new URL(url).search;
        return { ok: true, status: 200,
          headers: new Headers({ "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4800" }),
          json: () => f.api(path, { ...options, body: options.body ? JSON.parse(options.body) : undefined }) };
      });
      const output = [];
      assert.equal(await main([], { env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test",
        GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "schedule" }, api,
        log: (line) => output.push(line), error: (line) => output.push(line) }), 0);
      const usage = JSON.parse(output.at(-1));
      assert.equal(usage.reason, null, JSON.stringify(usage));
      assert.ok(usage.calls <= usage.limit);
      assert.equal(usage.calls, usage.restCalls + usage.graphqlCalls);
      assert.equal(usage.calls, usage.readCalls + usage.mutationCalls);
      assert.equal(f.data.state.status, mode === "red" ? "failing" : lag ? "pending" : "passing", JSON.stringify(f.data.state.reasons));
      assert.equal(f.data.state.backlog.commits, mode === "red" && lag === 0 ? null : lag);
      if (mode === "red") assert.ok(f.data.mutations.some((m) => m.path.endsWith("/issues")), "opens the full failure");
      if (mode === "recovery") assert.ok(f.data.mutations.some((m) => m.body?.state === "closed"), "verified passing descendant closes the incident");
      t.diagnostic(`${mode} lag=${lag}: ${usage.calls}/${usage.limit}, reads=${usage.readCalls}, mutations=${usage.mutationCalls}`);
    });
  }
});

const skippedClaimJobs = () => [{ id: 90, name: "Admit Main Snapshot", status: "completed", conclusion: "success",
  started_at: at(), steps: [{ name: "Skip Superseded Rolling Claim", conclusion: "success" }] },
{ id: 91, name: "Full Validation", status: "completed", conclusion: "skipped", steps: [] }];

test("verified unexecuted workers retain certificates and remain distinct from covered history", async () => {
  for (const receipt of [false, true]) for (const target of [A, B]) {
    const f = forge({ currentMain: target, runs: [worker(11, target, {
      run_number: 2, conclusion: receipt ? "success" : "cancelled" }), worker(10, A, { run_number: 1 })] });
    f.data.jobSets.set("11:1", receipt ? skippedClaimJobs() : []);
    const health = await f.collect();
    assert.equal(health.status, target === A ? "passing" : "pending", JSON.stringify(health.reasons));
    assert.equal(health.latestAttempt.runId, 10);
    assert.equal(health.latestPassingSnapshot.runId, 10);
    assert.equal(health.fullCertification?.runId ?? null, target === A ? 10 : null);
    assert.equal(health.checkpoint.runId, 10);
    const evidence = health.evidence.find((record) => record.runId === 11);
    assert.equal(evidence.result, "non-verdict");
    assert.equal(evidence.nonVerdictReason, "superseded-worker-attempt");
    assert.equal(evidence.certification, "none");
    assert.equal(health.supersededRunIds.includes(11), false, "unexecuted work is not covered/resolved history");
    assert.equal(health.resolvedRunIds.includes(11), false, "a non-verdict supplies no incident resolution");
    assert.ok(f.data.requests.filter((path) => path.endsWith("/actions/runs/11")).length >= 2,
      "the non-verdict run still receives live identity and final race revalidation");
  }
});

test("unexecuted workers cannot replace or close a prior real full incident", async () => {
  for (const receipt of [false, true]) {
    const f = forge({ runs: [worker(11, A, { run_number: 2, conclusion: receipt ? "success" : "cancelled" }),
      worker(10, A, { run_number: 1, conclusion: "failure" })] });
    f.data.jobSets.set("11:1", receipt ? skippedClaimJobs() : []); makeRed(f, 10);
    f.data.issues = [{ number: 7, state: "open", title: ALERT_TITLE, labels: [{ name: ALERT_LABEL }],
      user: { login: "github-actions[bot]" }, body: "<!-- main-ci-health latest:10 -->" }];
    const output = [];
    assert.equal(await main([], { env: { GITHUB_REPOSITORY: repository, GITHUB_TOKEN: "test",
      GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "schedule" }, api: f.api,
      log: (line) => output.push(line) }), 0);
    assert.equal(f.data.state.status, "failing");
    assert.equal(f.data.state.latestAttempt.runId, 10);
    assert.equal(f.data.state.unresolvedFailures[0].runId, 10);
    assert.equal(f.data.state.evidence.find((record) => record.runId === 11).result, "non-verdict");
    assert.equal(f.data.mutations.some((mutation) => mutation.path.includes("/issues")), false);
    assert.ok(output.some((line) => line.includes('"reason":"already-reported"')));
  }
});

test("an unexecuted older target is retained even when a verified descendant covers it", async () => {
  const f = forge({ runs: [worker(10, A, { run_number: 2 }),
    worker(9, W, { head_sha: A, run_number: 1, conclusion: "cancelled" })] });
  f.data.jobSets.set("9:1", []);
  const health = await f.collect();
  assert.equal(health.status, "passing");
  assert.equal(health.latestAttempt.runId, 10);
  assert.equal(health.evidence.find((record) => record.runId === 9).result, "non-verdict");
  assert.equal(health.supersededRunIds.includes(9), false);
  assert.equal(health.resolvedRunIds.includes(9), false);
});

test("superseded-looking workers require source and target ancestry before reading their jobs", async () => {
  const outside = "f".repeat(40);
  for (const [source, target] of [[outside, A], [A, outside]]) {
    const f = forge({ runs: [worker(11, target, { head_sha: source, run_number: 2, conclusion: "cancelled" }),
      worker(10, A, { run_number: 1 })] });
    f.data.jobSets.set("11:1", []);
    const health = await f.collect();
    assert.equal(health.status, "passing");
    assert.equal(health.evidence.some((record) => record.runId === 11), false);
    assert.equal(f.data.requests.some((path) => path.includes("/actions/runs/11/attempts/1/jobs")), false);
  }
});

test("started, unknown and rerun attempts still withdraw an older same-target certificate", async () => {
  for (const [attempts, items] of [[1, [{ id: 90, name: "Admit Main Snapshot", started_at: at(), steps: [] }]],
    [1, [...skippedClaimJobs(), { id: 92, name: "Full Validation / Unknown Suite", conclusion: null }]],
    [2, []]]) {
    const f = forge({ runs: [worker(11, A, { run_number: 2, run_attempt: attempts, conclusion: "cancelled" }),
      worker(10, A, { run_number: 1 })] });
    for (let attempt = 1; attempt <= attempts; attempt++) f.data.jobSets.set(`11:${attempt}`, items);
    const health = await f.collect();
    assert.equal(health.status, "unknown");
    assert.equal(health.fullCertification, null);
    assert.equal(health.latestPassingSnapshot, null);
    assert.equal(health.evidence.find((record) => record.runId === 11 && record.attempt === attempts).result, "unknown");
    if (attempts === 2) assert.deepEqual(health.evidence.filter((record) => record.runId === 11)
      .map((record) => [record.attempt, record.result]), [[1, "unknown"], [2, "unknown"]],
    "a rerun retains conservative evidence for every attempt");
  }
});

test("non-verdict classification cannot bypass complete jobs, workflow binding or the run-number census", async () => {
  for (const mode of ["partial-jobs", "workflow", "missing-run"]) {
    const f = forge({ runs: [worker(11, A, { run_number: mode === "missing-run" ? 3 : 2, conclusion: "cancelled" }),
      worker(10, A, { run_number: 1 })] });
    f.data.jobSets.set("11:1", []);
    let jobReads = 0;
    const health = await f.collect({ api: async (path, options) => {
      if (path.includes("/actions/runs/11/attempts/1/jobs")) {
        jobReads++;
        if (mode === "partial-jobs") return { total_count: 1, jobs: [] };
      }
      const result = await f.api(path, options);
      if (mode === "workflow" && path.includes(`/contents/${WORKER}?`))
        return { ...result, content: Buffer.from("unsupported worker").toString("base64") };
      return result;
    } });
    assert.equal(health.status, "unknown");
    assert.equal(health.fullCertification, null);
    assert.deepEqual(health.reasons, [mode === "partial-jobs" ? "incomplete-pagination"
      : mode === "workflow" ? "unsupported-workflow-contract" : "worker-history-incomplete"]);
    if (mode === "workflow") assert.equal(jobReads, 0, "source binding must precede classification");
  }
});
