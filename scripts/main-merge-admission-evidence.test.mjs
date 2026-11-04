import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { admissionEvidenceApi } from "./main-merge-admission-evidence.mjs";
import { rebuildAdmissionCycle } from "./main-merge-admission-controller.mjs";
import { collectHealth } from "./main-ci-health.mjs";
import { REQUIRED, UNIT_SHARDS } from "./main-rolling-validation.mjs";

const repository = "example/project", revision = "a".repeat(40);
const files = ["main-rolling-validation.yml", "ci.yml", "settings-rows-win32.yml"];
const path = (file, sha = revision) => `/repos/${repository}/contents/.github/workflows/${file}?ref=${sha}`;
function fixture(sha = revision) {
  return { data: { repository: { nameWithOwner: repository, revision: { __typename: "Commit", oid: sha },
    ...Object.fromEntries(files.map((file, i) => {
      const text = `# ${file}\n# Complete UTF-8: café 🦆\n`;
      const byteSize = Buffer.byteLength(text);
      return [`file${i}`, { __typename: "Blob", text, byteSize, isBinary: false,
        oid: createHash("sha1").update(`blob ${byteSize}\0${text}`).digest("hex") }];
    })) } } };
}

test("one exact-revision query supplies three complete Git-verified workflow blobs, isolated per rebuild", async () => {
  let calls = 0;
  const api = async (p, options) => {
    assert.equal(p, "/graphql"); calls++;
    const { query, variables } = options.body;
    assert.match(query, /^query AdmissionWorkflowEvidence/);
    assert.equal(variables.owner, "example"); assert.equal(variables.name, "project");
    for (const [i, file] of files.entries()) assert.equal(variables[`file${i}`], `${variables.revision}:.github/workflows/${file}`);
    return fixture(variables.revision);
  };
  api.rateLimit = { limit: 5000, remaining: 4900 };
  api.graphqlRateLimit = { limit: 5000, remaining: 4890 };
  const batched = admissionEvidenceApi(api, repository);
  for (const [i, file] of files.entries()) {
    const result = await batched(path(file));
    assert.equal(Buffer.from(result.content, "base64").toString("utf8"), fixture().data.repository[`file${i}`].text);
    assert.equal(result.sha, fixture().data.repository[`file${i}`].oid);
    result.content = "corrupted caller copy";
  }
  assert.equal(calls, 1);
  assert.notEqual((await batched(path(files[0]))).content, "corrupted caller copy");
  await batched(path(files[0], "b".repeat(40))); assert.equal(calls, 2);
  await admissionEvidenceApi(api, repository)(path(files[0])); assert.equal(calls, 3);
  assert.equal(batched.rateLimit, api.rateLimit); assert.equal(batched.graphqlRateLimit, api.graphqlRateLimit);
});

test("mutable evidence, other repositories, non-pinned files and writes always reach the underlying API", async () => {
  const calls = [];
  const api = async (...args) => { calls.push(args); return calls.length; };
  const batched = admissionEvidenceApi(api, repository);
  for (const p of [`/repos/${repository}/git/ref/heads/main`, `/repos/${repository}/actions/runs/42`,
    `/repos/${repository}/actions/runs/42/attempts/1/jobs`, path(files[0], "main"),
    path(files[0], revision + "&other=1"), path("other.yml"), path(files[0]).replace(repository, "other/project")]) {
    const before = calls.length;
    await batched(p); await batched(p);
    assert.equal(calls.length, before + 2);
  }
  const options = { method: "POST", body: { test: true } };
  await batched(path(files[0]), options);
  assert.deepEqual(calls.at(-1), [path(files[0]), options]);
});

test("wrong identities, partial or corrupted blobs and GraphQL errors cannot cache any workflow evidence", async () => {
  for (const edit of [r => { r.errors = [{}]; }, r => { r.errors = {}; },
    r => { r.data.repository.nameWithOwner = "foreign/project"; },
    r => { r.data.repository.revision.oid = "b".repeat(40); },
    r => { r.data.repository.revision.__typename = "Tag"; },
    r => { delete r.data.repository.file2; }, r => { r.data.repository.file2.text = null; },
    r => { r.data.repository.file2.text += "truncated"; }, r => { r.data.repository.file2.byteSize--; },
    r => { r.data.repository.file2.oid = "b".repeat(40); }, r => { r.data.repository.file2.isBinary = true; },
    r => { r.data.repository.file2.byteSize = 1_048_577; }]) {
    let calls = 0;
    const batched = admissionEvidenceApi(async () => { calls++; const r = fixture(); edit(r); return r; }, repository);
    await assert.rejects(batched(path(files[0])));
    await assert.rejects(batched(path(files[0])));
    assert.equal(calls, 2, "a partial response must never populate the cache");
  }
  await assert.rejects(admissionEvidenceApi(async () => { throw new Error("unavailable"); }, repository)(path(files[0])));
});

test("legacy two-file reads do not require a worker file or trigger a three-file query", async () => {
  const calls = [];
  const batched = admissionEvidenceApi(async (p, options) => {
    calls.push(p);
    if (p === "/graphql") return { data: { repository: { ...fixture().data.repository, file0: null } } };
    assert.equal(options, undefined);
    return { sha: revision, encoding: "base64", content: "bGVnYWN5" };
  }, repository);
  for (const file of files.slice(1)) assert.equal((await batched(path(file))).content, "bGVnYWN5");
  assert.deepEqual(calls, files.slice(1).map(file => path(file)));
});

// A complete worker fixture, following the authoritative health tests' job/step
// inventory. The real collector constructs every Contents URL and performs its
// normal final main, run and listing rechecks; no mocked report supplies a verdict.
test("real full-health collection preserves evidence and final rechecks while saving exactly two transport calls", async () => {
  const at = minute => new Date(Date.UTC(2026, 9, 26, 1, minute)).toISOString();
  const run = { id: 10, run_number: 1, run_attempt: 1, display_title: `Rolling ${revision} 12345678-1234-1234-1234-123456789012`,
    path: ".github/workflows/main-rolling-validation.yml", head_sha: revision, head_branch: "main", event: "workflow_dispatch",
    status: "completed", conclusion: "success", created_at: at(1), updated_at: at(30),
    repository: { full_name: repository }, head_repository: { full_name: repository } };
  const core = ["Typecheck", "Verify Node 22 Engine Boundary", "Verify Excluded Node Engine Boundary",
    "Verify Node 23 Engine Boundary", "Verify Recommended Node Engine Boundary", "Verify Delegated Linux Provider Containment",
    "Validate Web Production Build", "Validate Runner Bundle", "Validate Control-Plane Bundle"];
  const steps = [core, ["Remote-Instance Browser End-to-End Tests", "Rendered Production Browser Smoke"],
    ...[2, 3, 4, 5].map(() => ["Remote-Instance Browser End-to-End Tests"]), ["WebKit Browser End-to-End Tests"],
    ["Compare the Diff Against the Settings-Rows Paths"], ["Compare Against the Committed win32 Baselines"],
    ["Verify Recorded-Boundary Pipeline Recovery"], ...UNIT_SHARDS.map(() => ["Unit Tests"]), ["Require Every Job to Have Succeeded"]];
  const jobs = REQUIRED.map((name, i) => ({ id: i + 1, name, status: "completed", conclusion: "success",
    steps: ["Verify Rolling Checkout", ...steps[i]].map(name => ({ name, conclusion: "success" })) }));
  const response = fixture();
  for (const [i, file] of files.entries()) {
    const blob = response.data.repository[`file${i}`];
    blob.text = readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    blob.byteSize = Buffer.byteLength(blob.text);
    blob.oid = createHash("sha1").update(`blob ${blob.byteSize}\0${blob.text}`).digest("hex");
  }
  async function observe(batched, changed = null) {
    const requests = [];
    let runReads = 0, mainReads = 0;
    const api = async (p, options) => {
      requests.push(p);
      if (p === "/graphql") {
        assert.match(options.body.query, /^query AdmissionWorkflowEvidence/);
        assert.equal(options.body.variables.revision, revision);
        return response;
      }
      if (p.endsWith("/git/ref/heads/main")) return { object: { sha: ++mainReads === 2 && changed === "main" ? "b".repeat(40) : revision } };
      if (p.endsWith("/actions/workflows/main-rolling-validation.yml")) return { path: run.path, created_at: at(0) };
      if (p.includes("/workflows/") && p.includes("/runs?")) {
        const params = new URL("https://api.github.com" + p).searchParams;
        const matches = p.includes("main-rolling-validation.yml") && (!params.has("status") || params.get("status") === "completed");
        return { workflow_runs: matches ? [run] : [], total_count: matches ? 1 : 0 };
      }
      if (p.endsWith("/actions/runs/10")) return { ...run, run_attempt: ++runReads === 2 && changed === "attempt" ? 2 : 1 };
      if (p.includes("/attempts/1/jobs?")) return { jobs, total_count: jobs.length };
      if (p.includes("/contents/")) {
        const i = files.findIndex(file => p === path(file));
        assert.ok(i >= 0, p);
        const blob = response.data.repository[`file${i}`];
        return { sha: blob.oid, encoding: "base64", content: Buffer.from(blob.text).toString("base64") };
      }
      assert.fail(`Unexpected health fixture request: ${p}`);
    };
    const health = await collectHealth(repository, { api: batched ? admissionEvidenceApi(api, repository) : api, now: () => at(40) });
    assert.equal(mainReads, 2);
    if (changed !== "main") assert.equal(runReads, 2);
    return { health, requests };
  }
  const original = await observe(false), batched = await observe(true);
  assert.equal(original.health.status, "passing");
  assert.equal(original.health.fullCertification.runId, 10);
  assert.deepEqual(batched.health, original.health);
  assert.equal(original.requests.length - batched.requests.length, 2);
  assert.equal(batched.requests.filter(p => p === "/graphql").length, 1);
  assert.equal(batched.requests.filter(p => p.includes("/contents/")).length, 0);
  for (const changed of ["main", "attempt"]) {
    const raced = await observe(true, changed);
    assert.equal(raced.health.status, "unknown"); assert.equal(raced.health.fullCertification, null);
    assert.ok(raced.health.reasons.includes(changed === "main" ? "main-moved" : "run-changed"));
  }
});

test("batch evidence failure produces an unknown-health hold through the shared rebuild", async () => {
  const api = async (_path, options) => options.body.query.includes("AdmissionWorkflowEvidence") ? { errors: [{}] } :
    { data: { repository: { defaultBranchRef: { name: "main", target: { oid: revision } },
      pullRequests: { pageInfo: { hasNextPage: false }, nodes: [{ number: 1, isDraft: false,
        headRefOid: "b".repeat(40), baseRefOid: revision }] } } } };
  const plan = await rebuildAdmissionCycle({ repository, api, control: { available: true },
    report: async (_args, { api, log }) => {
      try { await api(path(files[0])); } catch { log(JSON.stringify({ status: "unknown", currentMainSha: revision })); return 1; }
      assert.fail("corrupted evidence must fail");
    } });
  assert.equal(plan.decisions.length, 1); assert.equal(plan.decisions[0].decision, "hold");
  assert.equal(plan.healthSummary.status, "unknown");
});
