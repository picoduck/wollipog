import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { admissionEvidenceApi } from "./main-merge-admission-evidence.mjs";
import { rebuildAdmissionCycle } from "./main-merge-admission-controller.mjs";

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
    await assert.rejects(batched(path(files[1])));
    assert.equal(calls, 2, "a partial response must never populate the cache");
  }
  await assert.rejects(admissionEvidenceApi(async () => { throw new Error("unavailable"); }, repository)(path(files[0])));
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
