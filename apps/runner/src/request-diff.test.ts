import assert from "node:assert/strict";
import test from "node:test";
import { computeDiffHash, loadRequestDiff, type ForgeRemote } from "./git-ops.js";

const head = "a".repeat(40);
const target = "b".repeat(40);
const base = "c".repeat(40);
const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+request head\n";
const gh: ForgeRemote = { provider: "github", host: "github.com", project: "owner/repo", webUrl: "https://github.com/owner/repo" };
const gl: ForgeRemote = { provider: "gitlab", host: "gitlab.example.test", project: "team/sub/repo", webUrl: "https://gitlab.example.test/team/sub/repo" };
const ghUrl = `${gh.webUrl}/pull/19`;
const glUrl = `${gl.webUrl}/-/merge_requests/19`;
const github = () => ({ number: 19, html_url: ghUrl, state: "open", base: { sha: target, ref: "release" }, head: { sha: head, ref: "feature" }, changed_files: 1, additions: 1, deletions: 1 });
const gitlab = (changesCount: string | null = "1") => ({
  iid: 19, web_url: glUrl, state: "opened", diff_refs: { head_sha: head, base_sha: base, start_sha: target },
  target_branch: "release", source_branch: "feature", changes_count: changesCount,
});
type GitLabFile = Record<string, unknown>;
const glFile = (name: string | number = "a", extra: GitLabFile = {}): GitLabFile => ({
  old_path: `src/${name}.ts`, new_path: `src/${name}.ts`, a_mode: "100644", b_mode: "100644",
  diff: "@@ -1 +1 @@\n-old\n+request head\n", new_file: false, renamed_file: false, deleted_file: false,
  generated_file: false, collapsed: false, too_large: false, ...extra,
});
const files = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => glFile(offset + index));
const diffPage = (args: string[]) => Number(args[1]?.match(/\/diffs\?per_page=100&page=(\d+)$/)?.[1] ?? 0);

/** A GitLab reader serving detail reads and /diffs pages; `detail` sees the 1-based detail read. */
function gitlabReader(pages: unknown[], options: { detail?: (read: number) => unknown; calls?: string[][] } = {}) {
  let detailReads = 0;
  return async (args: string[]) => {
    options.calls?.push(args);
    const page = diffPage(args);
    if (page) return JSON.stringify(pages[page - 1] ?? []);
    detailReads += 1;
    return JSON.stringify(options.detail?.(detailReads) ?? gitlab(String(pages.flat().length)));
  };
}

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

test("nested host-qualified GitLab reads /diffs pages between pinned detail reads", async () => {
  const calls: string[][] = [];
  const result = await loadRequestDiff(gl, glUrl, gitlabReader([[glFile()]], { calls }));
  assert.equal(result.incomplete, false);
  assert.equal(result.baseOid, base);
  assert.equal(result.targetOid, target);
  assert.equal(result.headOid, head);
  assert.equal(result.diff.stats.insertions, 1);
  assert.deepEqual(calls, [
    ["api", "projects/team%2Fsub%2Frepo/merge_requests/19"],
    ["api", "projects/team%2Fsub%2Frepo/merge_requests/19/diffs?per_page=100&page=1"],
    ["api", "projects/team%2Fsub%2Frepo/merge_requests/19"],
  ]);
  assert.ok(!calls.flat().some((arg) => arg.includes("/changes")));
});

test("a multi-page GitLab diff loads completely without an extra page", async () => {
  const calls: string[][] = [];
  const result = await loadRequestDiff(gl, glUrl, gitlabReader([files(100), files(50, 100)], { calls }));
  assert.equal(result.incomplete, false);
  assert.equal(result.diff.files.length, 150);
  assert.equal(result.diff.files[149]?.path, "src/149.ts");
  assert.deepEqual(calls.map(diffPage).filter(Boolean), [1, 2]);
});

test("an exactly-full final GitLab page is confirmed by an empty sentinel page", async () => {
  const calls: string[][] = [];
  const result = await loadRequestDiff(gl, glUrl, gitlabReader([files(100), files(100, 100), []], { calls }));
  assert.equal(result.incomplete, false);
  assert.equal(result.diff.files.length, 200);
  assert.deepEqual(calls.map(diffPage).filter(Boolean), [1, 2, 3]);
});

test("GitLab entries past the counted pages are never admitted and mark the diff incomplete", async () => {
  const calls: string[][] = [];
  const result = await loadRequestDiff(gl, glUrl, gitlabReader([files(100), files(100, 100), files(1, 200)], {
    calls, detail: () => gitlab("100"),
  }));
  assert.equal(result.incomplete, true);
  assert.equal(result.diff.files.length, 100);
  assert.deepEqual(calls.map(diffPage).filter(Boolean), [1, 2]);
});

test("a capped GitLab count reads at most ten pages and stays incomplete", async () => {
  const calls: string[][] = [];
  const pages = Array.from({ length: 12 }, (_, page) => files(100, page * 100));
  const result = await loadRequestDiff(gl, glUrl, gitlabReader(pages, { calls, detail: () => gitlab("1000+") }));
  assert.equal(result.incomplete, true);
  assert.equal(result.diff.files.length, 1000);
  assert.deepEqual(calls.map(diffPage).filter(Boolean), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("GitLab counts that disagree, are capped or are missing remain incomplete", async () => {
  for (const changesCount of ["2", "0", "1000+", null]) {
    const result = await loadRequestDiff(gl, glUrl, gitlabReader([[glFile()]], { detail: () => gitlab(changesCount) }));
    assert.equal(result.incomplete, true, String(changesCount));
  }
});

test("withheld or unexplained GitLab file content is visibly incomplete", async () => {
  for (const change of [
    { diff: "", collapsed: true },
    { diff: "", too_large: true },
    { collapsed: true },
    { diff: "" },
    { diff: "", b_mode: "100755", collapsed: undefined, too_large: undefined },
    { a_mode: undefined },
    { b_mode: "755; rm" },
  ]) {
    const result = await loadRequestDiff(gl, glUrl, gitlabReader([[glFile("a", change)]]));
    assert.equal(result.incomplete, true, JSON.stringify(change));
  }
});

test("GitLab file modes come from a_mode and b_mode", async () => {
  const added = glFile("tool", { a_mode: "0", b_mode: "100755", new_file: true, diff: "@@ -0,0 +1 @@\n+run\n" });
  const removed = glFile("link", { a_mode: "120000", b_mode: "0", deleted_file: true, diff: "@@ -1 +0,0 @@\n-target\n" });
  const renamed = glFile("new", { old_path: "src/old.ts", renamed_file: true, diff: "" });
  const modeOnly = glFile("script", { b_mode: "100755", diff: "" });
  const result = await loadRequestDiff(gl, glUrl, gitlabReader([[added, removed, renamed, modeOnly]]));
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.diff.files.map((file) => [file.path, file.status]), [
    ["src/tool.ts", "added"], ["src/link.ts", "deleted"], ["src/new.ts", "renamed"], ["src/script.ts", "modified"],
  ]);
  assert.equal(result.diff.diffHash, computeDiffHash(
    "diff --git a/src/tool.ts b/src/tool.ts\nnew file mode 100755\n--- /dev/null\n+++ b/src/tool.ts\n@@ -0,0 +1 @@\n+run\n\n"
    + "diff --git a/src/link.ts b/src/link.ts\ndeleted file mode 120000\n--- a/src/link.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-target\n\n"
    + "diff --git a/src/old.ts b/src/new.ts\nrename from src/old.ts\nrename to src/new.ts\n--- a/src/old.ts\n+++ b/src/new.ts\n\n"
    + "diff --git a/src/script.ts b/src/script.ts\nold mode 100644\nnew mode 100755\n--- a/src/script.ts\n+++ b/src/script.ts\n\n",
  ));
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
  const httpResult = await loadRequestDiff(gl, httpUrl, gitlabReader([[glFile()]], { detail: () => ({ ...gitlab(), web_url: httpUrl }) }));
  assert.equal(httpResult.requestUrl, httpUrl);
});

test("GitLab filenames cannot inject patch headers through control characters", async () => {
  for (const path of ["a\n+++ b/README.md", "a\rhidden", "a\tname", "a\x7fname"]) {
    await assert.rejects(loadRequestDiff(gl, glUrl, gitlabReader([[glFile("a", { new_path: path })]])), /invalid diff paths/);
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

for (const key of ["head", "base", "start", "state", "identity", "count"]) {
  test(`rejects a GitLab ${key} change while the diff pages load`, async () => {
    await assert.rejects(loadRequestDiff(gl, glUrl, gitlabReader([[glFile()]], {
      detail: (read) => {
        const value = gitlab();
        if (read > 1) {
          if (key === "head") value.diff_refs.head_sha = base;
          if (key === "base") value.diff_refs.base_sha = head;
          if (key === "start") value.diff_refs.start_sha = head;
          if (key === "state") value.state = "merged";
          if (key === "identity") value.iid = 20;
          if (key === "count") value.changes_count = "2";
        }
        return value;
      },
    })), /changed|invalid request/);
  });
}

test("GitHub truncated file/hunk totals are visibly incomplete", async () => {
  const result = await loadRequestDiff(gh, ghUrl, async (args) => {
    if (args.includes("-H")) return patch.replace("+request head\n", "");
    if (args[1]?.includes("compare")) return JSON.stringify({ merge_base_commit: { sha: base } });
    return JSON.stringify({ ...github(), changed_files: 2 });
  });
  assert.equal(result.incomplete, true);
});

test("GitLab hunk totals that disagree with their header are visibly incomplete", async () => {
  const result = await loadRequestDiff(gl, glUrl, gitlabReader([[glFile("a", { diff: "@@ -1,2 +1 @@\n-old\n+request head\n" })]]));
  assert.equal(result.incomplete, true);
});

test("forge errors never fall back to a local diff", async () => {
  await assert.rejects(loadRequestDiff(gl, glUrl, async () => { throw new Error("unavailable"); }), /unavailable/);
});

test("a failed or malformed GitLab diff page is refused without any fallback read", async () => {
  for (const page of [() => { throw new Error("page unavailable"); }, () => "{\"changes\":[]}", () => "not json",
    () => JSON.stringify(files(101))]) {
    const calls: string[][] = [];
    await assert.rejects(loadRequestDiff(gl, glUrl, async (args) => {
      calls.push(args);
      return diffPage(args) ? page() : JSON.stringify(gitlab());
    }), /page unavailable|invalid diff page/);
    assert.deepEqual(calls.map((args) => args[1]), [
      "projects/team%2Fsub%2Frepo/merge_requests/19",
      "projects/team%2Fsub%2Frepo/merge_requests/19/diffs?per_page=100&page=1",
    ]);
  }
});

test("a GitLab diff over the display limit is refused", async () => {
  const huge = glFile("a", { diff: `@@ -1 +1 @@\n-old\n+${"x".repeat(8 * 1024 * 1024)}\n` });
  await assert.rejects(loadRequestDiff(gl, glUrl, gitlabReader([[huge]])), /display limit/);
});

test("unsafe GitLab paths and missing revision metadata are refused", async () => {
  await assert.rejects(loadRequestDiff(gl, glUrl, gitlabReader([[glFile("a", { new_path: "../secret" })]])), /paths/);
  await assert.rejects(loadRequestDiff(gl, glUrl, gitlabReader([[glFile()]], { detail: () => ({ ...gitlab(), diff_refs: null }) })), /invalid request/);
  await assert.rejects(loadRequestDiff(gh, ghUrl, async () => JSON.stringify({ ...github(), head: {} })), /invalid request/);
});
