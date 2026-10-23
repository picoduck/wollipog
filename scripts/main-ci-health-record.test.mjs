import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { ALERT_LABEL, ALERT_TITLE, collectHealth, HEALTH_REF, HEALTH_SCHEMA, main, readHealthState, reconcile, STALE_MS, writeHealthState } from "./main-ci-health.mjs";
import { REQUIRED, WORKER } from "./main-rolling-validation.mjs";

const repository = "example/project";
const W = "d".repeat(40), A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const chain = [W, A, B, C], claim = "12345678-1234-1234-1234-123456789012";
const at = (minutes = 0) => new Date(Date.UTC(2026, 9, 23, 12, minutes)).toISOString();
const worker = (id = 10, target = A, extra = {}) => ({ id, run_attempt: 1,
  display_title: `Rolling ${target} ${claim}`, path: WORKER, head_sha: W, head_branch: "main",
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

function forge({ runs = [worker()], currentMain = A, state = null } = {}) {
  const data = { runs, currentMain, state, oid: state ? C : null, mutations: [], requests: [],
    attempts: new Map(), jobSets: new Map(), issues: [], count: 0 };
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
    if (path === root) return { node_id: "repo-id" };
    if (path === `${root}/git/ref/heads/main`) return { object: { sha: data.currentMain } };
    if (path === `${root}/git/ref/heads/ci/main-health-state`) return data.oid ? { object: { sha: data.oid } } : missing();
    if (path.startsWith(`${root}/git/commits/`)) return { tree: { sha: B } };
    if (path.startsWith(`${root}/git/trees/`)) return { tree: [{ path: "health.json", type: "blob", sha: W }] };
    if (path.startsWith(`${root}/git/blobs/`)) {
      const content = JSON.stringify(data.state);
      return { encoding: "base64", size: content.length, content: Buffer.from(content).toString("base64") };
    }
    if (path === `${root}/actions/workflows/main-rolling-validation.yml`) return { path: WORKER, created_at: at(-60) };
    if (path.includes("/actions/workflows/") && path.includes("/runs?")) {
      const rolling = path.includes("main-rolling-validation.yml");
      const selected = data.runs.filter((run) => rolling ? run.path === WORKER : run.path === ".github/workflows/ci.yml");
      const page = Number(new URL("https://api.github.com" + path).searchParams.get("page"));
      return { workflow_runs: selected.slice((page - 1) * 100, page * 100), total_count: selected.length };
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
        commit: { committer: { date: at(31) } } })) : [];
      return { merge_base_commit: { sha: i >= 0 && j >= i ? from : W }, commits, total_commits: commits.length };
    }
    if (path.includes("/commits/") && path.includes("/pulls?")) return [{ number: chain.indexOf(path.split("/commits/")[1].slice(0, 40)),
      merged_at: at(31), merge_commit_sha: path.split("/commits/")[1].slice(0, 40), base: { ref: "main", repo: { full_name: repository } } }];
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
  assert.equal(health.fullCertification.dispatcherSha, W);
  assert.equal(health.fullCertification.workflowPath, WORKER);
  assert.equal(health.fullCertification.attempt, 1);
  assert.match(health.fullCertification.suiteVersion, /^[a-f0-9]{64}$/);
  assert.equal(health.fullCertification.inventory.length, REQUIRED.length);
  assert.equal(health.backlog.commits, 0);
  assert.ok(!f.data.requests.some((path) => path.includes("main-rolling-state") || path.includes("artifacts")));
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
    async (path, fallback) => path.endsWith("/attempts/1") ? worker(10, A, { run_attempt: 2 }) : fallback(),
    async (path, fallback) => path.endsWith("/runs/10") ? worker(10, A, { run_attempt: 2 }) : fallback(),
    async () => { throw new Error("token private response"); },
  ];
  for (const variant of variants) {
    const f = forge(), health = await collectHealth(repository, { api: (path) => variant(path, () => f.api(path)), now: () => at(40) });
    assert.equal(health.status, "unknown"); assert.equal(health.fullCertification, null);
    assert.doesNotMatch(JSON.stringify(health), /token private/);
  }
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
  assert.equal(unknown.status, "unknown"); assert.equal(unknown.fullCertification, null);
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
    if (path.includes("main-rolling-validation.yml/runs?") && ++listings > 1)
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
  assert.ok(f.data.state.supersededRunIds.includes(10));
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
