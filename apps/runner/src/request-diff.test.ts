import assert from "node:assert/strict";
import test from "node:test";
import { loadRequestDiff, type ForgeRemote } from "./git-ops.js";

const head = "a".repeat(40);
const target = "b".repeat(40);
const base = "c".repeat(40);
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+request head\n";
const gh: ForgeRemote = { provider: "github", host: "github.com", project: "owner/repo", webUrl: "https://github.com/owner/repo" };
const gl: ForgeRemote = { provider: "gitlab", host: "gitlab.example.test", project: "team/sub/repo", webUrl: "https://gitlab.example.test/team/sub/repo" };
const ghUrl = `${gh.webUrl}/pull/19`;
const glUrl = `${gl.webUrl}/-/merge_requests/19`;
const github = () => ({ number: 19, html_url: ghUrl, state: "open", base: { sha: target, ref: "release" }, head: { sha: head, ref: "feature" }, changed_files: 1, additions: 1, deletions: 1 });
const gitlab = () => ({ iid: 19, web_url: glUrl, state: "opened", diff_refs: { head_sha: head, base_sha: base, start_sha: target }, target_branch: "release", source_branch: "feature" });
const changes = () => ({ ...gitlab(), overflow: false, changes_count: "1", changes: [{ new_path: "src/a.ts", old_path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+request head\n" }] });

test("GitHub reads the request's own diff and target rather than local/default HEAD", async () => {
  const calls: string[][] = [];
  const result = await loadRequestDiff(gh, ghUrl, async (args) => {
    calls.push(args);
    if (args[1]?.includes("/compare/")) return JSON.stringify({ merge_base_commit: { sha: base } });
    return args.includes("-H") ? patch : JSON.stringify(github());
  });
  assert.equal(result.targetOid, target);
  assert.equal(result.baseOid, base);
  assert.equal(result.headOid, head);
  assert.equal(result.baseRef, "release");
  assert.equal(result.incomplete, false);
  assert.equal(result.diff.files[0]?.hunks[0]?.lines[1]?.text, "request head");
  assert.deepEqual(calls[1], ["api", `repos/owner/repo/compare/${target}...${head}`]);
  assert.equal(calls.length, 4);
});

test("nested host-qualified GitLab validates diff_refs and encodes the complete project", async () => {
  const calls: string[][] = [];
  const result = await loadRequestDiff(gl, glUrl, async (args) => {
    calls.push(args);
    return JSON.stringify(args[1]?.endsWith("/changes") ? changes() : gitlab());
  });
  assert.equal(result.incomplete, false);
  assert.equal(result.baseOid, base);
  assert.equal(result.targetOid, target);
  assert.equal(result.diff.stats.insertions, 1);
  assert.deepEqual(calls[1], ["api", "projects/team%2Fsub%2Frepo/merge_requests/19/changes"]);
});

test("GitHub canonical URL casing and configured HTTP GitLab retain exact repository identity", async () => {
  const canonical = "https://github.com/Owner/Repo/pull/19";
  const result = await loadRequestDiff(gh, canonical, async (args) => {
    if (args.includes("-H")) return patch;
    if (args[1]?.includes("compare")) return JSON.stringify({ merge_base_commit: { sha: base } });
    return JSON.stringify({ ...github(), html_url: canonical });
  });
  assert.equal(result.requestUrl, canonical);
  const httpUrl = glUrl.replace("https:", "http:");
  const httpResult = await loadRequestDiff(gl, httpUrl, async (args) => JSON.stringify({
    ...(args[1]?.endsWith("/changes") ? changes() : gitlab()), web_url: httpUrl,
  }));
  assert.equal(httpResult.requestUrl, httpUrl);
});

test("GitLab filenames cannot inject patch headers through control characters", async () => {
  for (const path of ["a\n+++ b/README.md", "a\rhidden", "a\tname", "a\x7fname"]) {
    await assert.rejects(loadRequestDiff(gl, glUrl, async (args) => JSON.stringify(args[1]?.endsWith("/changes")
      ? { ...changes(), changes: [{ ...changes().changes[0], new_path: path }] } : gitlab())), /invalid diff paths/);
  }
});

for (const url of ["https://evil.test/owner/repo/pull/19", `${ghUrl}?token=x`, `${ghUrl}/files`, `${gh.webUrl}/pull/19/../../20`, `${gh.webUrl}/pull/0`]) {
  test(`rejects untrusted request identity before any forge access: ${url}`, async () => {
    await assert.rejects(loadRequestDiff(gh, url, async () => { assert.fail("must not read"); }), /origin repository/);
  });
}

for (const key of ["head", "base", "state", "identity"]) {
  test(`rejects a GitHub ${key} change during the diff read`, async () => {
    let reads = 0;
    await assert.rejects(loadRequestDiff(gh, ghUrl, async (args) => {
      if (args.includes("-H")) return patch;
      if (args[1]?.includes("compare")) return JSON.stringify({ merge_base_commit: { sha: base } });
      const value = github();
      if (++reads > 1) {
        if (key === "head") value.head.sha = base;
        if (key === "base") value.base.sha = base;
        if (key === "state") value.state = "closed";
        if (key === "identity") value.number = 20;
      }
      return JSON.stringify(value);
    }), /changed|invalid request/);
  });
}

test("rejects GitLab changes for a stale diff revision", async () => {
  await assert.rejects(loadRequestDiff(gl, glUrl, async (args) => {
    const value = args[1]?.endsWith("/changes") ? changes() : gitlab();
    if (args[1]?.endsWith("/changes")) value.diff_refs.head_sha = base;
    return JSON.stringify(value);
  }), /changed/);
});

test("GitHub truncated file/hunk totals are visibly incomplete", async () => {
  const result = await loadRequestDiff(gh, ghUrl, async (args) => {
    if (args.includes("-H")) return patch.replace("+request head\n", "");
    if (args[1]?.includes("compare")) return JSON.stringify({ merge_base_commit: { sha: base } });
    return JSON.stringify({ ...github(), changed_files: 2 });
  });
  assert.equal(result.incomplete, true);
});

test("GitLab overflow, collapsed patches and missing counts remain incomplete", async () => {
  for (const change of [{ overflow: true }, { changes_count: "1000+" }, { changes: [{ ...changes().changes[0], diff: "", collapsed: true }] }]) {
    const result = await loadRequestDiff(gl, glUrl, async (args) => JSON.stringify(args[1]?.endsWith("/changes") ? { ...changes(), ...change } : gitlab()));
    assert.equal(result.incomplete, true);
  }
});

test("forge errors never fall back to a local diff", async () => {
  await assert.rejects(loadRequestDiff(gl, glUrl, async () => { throw new Error("unavailable"); }), /unavailable/);
});

test("unsafe GitLab paths and missing revision metadata are refused", async () => {
  await assert.rejects(loadRequestDiff(gl, glUrl, async (args) => JSON.stringify(args[1]?.endsWith("/changes")
    ? { ...changes(), changes: [{ ...changes().changes[0], new_path: "../secret" }] } : gitlab())), /paths/);
  await assert.rejects(loadRequestDiff(gh, ghUrl, async () => JSON.stringify({ ...github(), head: {} })), /invalid request/);
});
