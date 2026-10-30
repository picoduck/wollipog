import assert from "node:assert/strict";
import { test } from "node:test";
import type { GithubIssueClosureSnapshot } from "@wollipog/protocol";
import { executeGithubIssueClosure, inspectGithubIssueClosure } from "./github-issue-closure.js";
import { gitlabClosureNote, gitlabIssueOrigin } from "./gitlab-issue-closure.js";

const HEAD = "b".repeat(40);
const MERGE = "c".repeat(40);
const SQUASH = "e".repeat(40);

/** A fake `glab api` shaped on GitLab's documented REST answers, for a nested project on a
 * self-managed host. Paths are matched case-insensitively, as GitLab resolves project paths. */
function gitlab(options: { host?: string; path?: string; remote?: string } = {}) {
  const host = options.host ?? "gitlab.example.com";
  const path = options.path ?? "Platform/Backend/Service";
  const web = `https://${host}/${path}`;
  const project: Record<string, unknown> = { id: 42, path_with_namespace: path, web_url: web, default_branch: "main" };
  const issue: Record<string, unknown> = {
    id: 9001, iid: 123, project_id: 42, title: "Obsolete task", description: "Original description", state: "opened",
    web_url: `${web}/-/issues/123`, updated_at: "2026-10-01T10:00:00Z", assignees: [{ username: "worker" }], labels: ["enhancement"],
  };
  const lists = { related: [] as unknown[], closedBy: [] as unknown[], open: [] as unknown[] };
  const mergeRequests = new Map<number, Record<string, unknown>>();
  let mergeBase: (commit: string) => string = (commit) => commit;
  const calls: Array<{ command: string; args: string[] }> = [];
  let remote = options.remote ?? `git@${host.replace(/:\d+$/u, "")}:${path.toLowerCase()}.git`;
  let failPut = false;
  let leaveOpen = false;
  const base = `projects/${encodeURIComponent(path)}`.toLowerCase();
  const run = async (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "git") return remote;
    assert.equal(command, "glab");
    assert.equal(args[0], "api");
    assert.equal(args[args.indexOf("--hostname") + 1], host, "every glab call names the origin's host");
    const method = args[1] === "--method" ? args[2] : "GET";
    const target = (method === "GET" ? args[1]! : args[3]!).toLowerCase();
    if (method === "POST") {
      assert.equal(target, `${base}/issues/123/notes`);
      return JSON.stringify({ id: 1 });
    }
    if (method === "PUT") {
      assert.equal(target, `${base}/issues/123`);
      assert.deepEqual(args.slice(-2), ["-f", "state_event=close"]);
      if (failPut) throw Object.assign(new Error("glab failed"), { stderr: "error connecting to gitlab.example.com", code: 1 });
      if (!leaveOpen) issue.state = "closed";
      return JSON.stringify(issue);
    }
    if (target === base) return JSON.stringify(project);
    if (target === `${base}/issues/123`) return JSON.stringify(issue);
    if (target === `${base}/issues/123/related_merge_requests?per_page=100`) return JSON.stringify(lists.related);
    if (target === `${base}/issues/123/closed_by?per_page=100`) return JSON.stringify(lists.closedBy);
    if (target === `${base}/merge_requests?state=opened&per_page=100`) return JSON.stringify(lists.open);
    const mr = /\/merge_requests\/(\d+)$/u.exec(target);
    if (mr && mergeRequests.has(Number(mr[1]))) return JSON.stringify(mergeRequests.get(Number(mr[1])));
    const bases = /\/repository\/merge_base\?refs\[\]=([0-9a-f]{40})&refs\[\]=main$/u.exec(target);
    if (bases) return JSON.stringify({ id: mergeBase(bases[1]!) });
    throw Object.assign(new Error("glab failed"), { stderr: "HTTP 404 Not Found", code: 1 });
  };
  const mergeRequest = (iid: number, extra: Record<string, unknown> = {}) => ({
    iid, project_id: 42, target_project_id: 42, state: "opened", title: "Work", description: "No mention",
    web_url: `${web}/-/merge_requests/${iid}`, sha: "a".repeat(40), updated_at: "2026-10-01T09:00:00Z",
    target_branch: "main", merge_commit_sha: null, squash_commit_sha: null, ...extra,
  });
  return { host, path, web, project, issue, lists, mergeRequests, mergeRequest, calls, run,
    setRemote: (value: string) => { remote = value; }, setMergeBase: (value: (commit: string) => string) => { mergeBase = value; },
    failPut: () => { failPut = true; }, leaveOpen: () => { leaveOpen = true; } };
}

const mutations = (f: ReturnType<typeof gitlab>) => f.calls.filter((call) => call.args[1] === "--method");

async function snapshot(f: ReturnType<typeof gitlab>, patch: Partial<GithubIssueClosureSnapshot> = {}): Promise<GithubIssueClosureSnapshot> {
  const { state: _state, ...inspection } = await inspectGithubIssueClosure(123, f.run);
  return { ...inspection, category: "issue_closure", reason: "completed", explanation: "Retire obsolete work.",
    evidence: ["Superseded by the new design."], activeChildren: [], ...patch };
}

test("GitLab origins are recognised by host-qualified project, never as GitHub", () => {
  assert.deepEqual(gitlabIssueOrigin("git@gitlab.example.com:Platform/Backend/Service.git"), { host: "gitlab.example.com", project: "Platform/Backend/Service" });
  assert.deepEqual(gitlabIssueOrigin("https://GitLab.Example.com:8443/group/sub/project.git"), { host: "gitlab.example.com:8443", project: "group/sub/project" });
  for (const remote of ["git@github.com:team/repo.git", "git@localhost:group/project.git", "/srv/repo.git", "https://user:token@gitlab.example.com/group/project.git"]) {
    assert.equal(gitlabIssueOrigin(remote), null, remote);
  }
});

test("GitLab closure inspection reads a nested self-managed project through glab with a stable digest", async () => {
  const f = gitlab();
  const first = await inspectGithubIssueClosure(123, f.run);
  assert.equal(first.repository, "gitlab.example.com/Platform/Backend/Service");
  assert.equal(first.url, "https://gitlab.example.com/Platform/Backend/Service/-/issues/123");
  assert.equal(first.state, "OPEN");
  assert.equal(first.title, "Obsolete task");
  assert.deepEqual(first.openPullRequests, []);
  assert.ok(f.calls.every((call) => call.command === "git" || call.command === "glab"), "GitLab never runs gh");
  assert.equal((await inspectGithubIssueClosure(123, f.run)).forgeDigest, first.forgeDigest);
  for (const change of [
    () => { f.issue.description = "Edited"; }, () => { f.issue.labels = ["blocked"]; },
    () => { f.issue.assignees = [{ username: "other" }]; }, () => { f.issue.updated_at = "2026-10-02T00:00:00Z"; },
  ]) {
    change();
    assert.notEqual((await inspectGithubIssueClosure(123, f.run)).forgeDigest, first.forgeDigest);
  }
});

test("GitLab closure inspection keeps a web port in the repository", async () => {
  const f = gitlab({ host: "gitlab.example.com:8443", path: "group/sub/project", remote: "https://gitlab.example.com:8443/group/sub/project.git" });
  const inspection = await inspectGithubIssueClosure(123, f.run);
  assert.equal(inspection.repository, "gitlab.example.com:8443/group/sub/project");
  assert.equal(inspection.url, "https://gitlab.example.com:8443/group/sub/project/-/issues/123");
});

test("GitLab conflict evidence unites related, closing and mentioning open merge requests of the project", async () => {
  const f = gitlab();
  f.lists.open = [
    f.mergeRequest(77, { title: "Fix #123" }),
    f.mergeRequest(78, { description: `See ${f.web}/-/issues/123` }),
    f.mergeRequest(79),
    f.mergeRequest(80, { title: "Fix #1234 and group/other#123" }),
    f.mergeRequest(81, { description: null }),
  ];
  f.lists.related = [f.mergeRequest(81), f.mergeRequest(83, { project_id: 7, web_url: "https://gitlab.example.com/fork/service/-/merge_requests/83" }),
    f.mergeRequest(84, { state: "merged" })];
  f.lists.closedBy = [f.mergeRequest(82)];
  const inspection = await inspectGithubIssueClosure(123, f.run);
  assert.deepEqual(inspection.openPullRequests.map((mr) => mr.number), [77, 78, 81, 82]);
  assert.deepEqual(inspection.openPullRequests[0], { number: 77, title: "Fix #123", url: `${f.web}/-/merge_requests/77`, headSha: "a".repeat(40) });
  const digest = inspection.forgeDigest;
  f.lists.open[0] = f.mergeRequest(77, { title: "Fix #123", sha: "d".repeat(40) });
  assert.notEqual((await inspectGithubIssueClosure(123, f.run)).forgeDigest, digest, "a moved merge-request head changes the digest");
});

test("a locked merge request is mid-merge, so it stays unresolved conflict evidence", async () => {
  const f = gitlab();
  // From each source: a mentioning open-list row, a related one and a closing one.
  f.lists.open = [f.mergeRequest(90, { state: "locked", title: "Fix #123" })];
  f.lists.related = [f.mergeRequest(91, { state: "locked" })];
  f.lists.closedBy = [f.mergeRequest(92, { state: "locked" })];
  const inspection = await inspectGithubIssueClosure(123, f.run);
  assert.deepEqual(inspection.openPullRequests.map((mr) => mr.number), [90, 91, 92]);
});

test("GitLab closure inspection refuses a full page from any list rather than a partial answer", async () => {
  for (const list of ["related", "closedBy", "open"] as const) {
    const f = gitlab();
    f.lists[list] = Array.from({ length: 100 }, (_, i) => f.mergeRequest(i + 1000, { state: "closed" }));
    await assert.rejects(inspectGithubIssueClosure(123, f.run), /GitLab's bounded inspection limit was exceeded/);
  }
});

test("GitLab closure inspection refuses identity and web-address mismatches with fixed sentences", async () => {
  const cases: Array<[(f: ReturnType<typeof gitlab>) => void, RegExp]> = [
    [(f) => { f.project.path_with_namespace = "Platform/Backend/Other"; }, /GitLab project identity is invalid/],
    [(f) => { f.project.web_url = "https://elsewhere.example.com/Platform/Backend/Service"; }, /GitLab project identity is invalid/],
    [(f) => { f.issue.iid = 124; }, /GitLab issue identity is invalid/],
    [(f) => { f.issue.project_id = 7; }, /GitLab issue identity is invalid/],
    [(f) => { f.issue.web_url = "https://gitlab.example.com/Platform/Backend/Other/-/issues/123"; }, /GitLab issue identity is invalid/],
    [(f) => { f.issue.state = "locked"; }, /GitLab issue identity is invalid/],
    [(f) => { f.lists.open = [f.mergeRequest(77, { title: "Fix #123", web_url: "https://gitlab.example.com/x/y/-/merge_requests/77" })]; }, /GitLab merge-request evidence is invalid/],
    [(f) => { f.lists.closedBy = [f.mergeRequest(77, { sha: "short" })]; }, /GitLab merge-request evidence is invalid/],
    [(f) => { f.setRemote("/srv/local/repository.git"); }, /exact github\.com or GitLab origin remote/],
  ];
  for (const [change, expected] of cases) {
    const f = gitlab();
    change(f);
    await assert.rejects(inspectGithubIssueClosure(123, f.run), expected);
  }
  const missing = gitlab();
  await assert.rejects(inspectGithubIssueClosure(124, missing.run), (error: Error) =>
    /^GitLab has no such project, issue or merge request/u.test(error.message) && !error.message.includes("404"));
});

test("GitLab delivery proof requires a merged head into the default branch, contained there", async () => {
  const merged = (extra: Record<string, unknown> = {}) => ({ state: "merged", sha: HEAD, merge_commit_sha: MERGE, ...extra });
  for (const [mode, patch, expected] of [
    ["merge commit", merged(), MERGE],
    ["squash commit", merged({ merge_commit_sha: null, squash_commit_sha: SQUASH }), SQUASH],
    ["not merged", merged({ state: "opened" }), /has not actually merged/],
    ["wrong head", merged({ sha: "d".repeat(40) }), /has not actually merged/],
    ["wrong target branch", merged({ target_branch: "feature" }), /has not actually merged/],
    ["wrong target project", merged({ target_project_id: 7 }), /has not actually merged/],
    ["no merge commit", merged({ merge_commit_sha: null }), /has not actually merged/],
    ["not contained", merged(), /not contained in the GitLab default branch/],
  ] as const) {
    const f = gitlab();
    f.mergeRequests.set(10, f.mergeRequest(10, patch));
    if (mode === "not contained") f.setMergeBase(() => "f".repeat(40));
    const inspect = inspectGithubIssueClosure(123, f.run, [{ number: 10, headSha: HEAD }]);
    if (typeof expected === "string") {
      assert.deepEqual((await inspect).delivery, [{ number: 10, headSha: HEAD, mergeCommitSha: expected }], mode);
      assert.ok(f.calls.some((call) => call.args[1] === `projects/${encodeURIComponent(f.path)}/repository/merge_base?refs[]=${expected}&refs[]=main`), mode);
    } else {
      await assert.rejects(inspect, expected, mode);
    }
  }
  const f = gitlab();
  await assert.rejects(inspectGithubIssueClosure(123, f.run, []), /bounded actual merged merge-request evidence/);
});

test("GitLab completed closure posts a supplied comment as a note, then closes, and verifies", async () => {
  for (const comment of [undefined, "Delivered in !77. `literal` $(literal)"]) {
    const f = gitlab();
    const approved = await snapshot(f, comment === undefined ? {} : { comment });
    let began = 0;
    assert.equal((await executeGithubIssueClosure(approved, f.run, () => ++began === 1)).outcome, "closed");
    const notes = `projects/${encodeURIComponent(f.path)}/issues/123`;
    assert.deepEqual(mutations(f).map((call) => call.args), [
      ...(comment === undefined ? [] : [["api", "--method", "POST", `${notes}/notes`, "--hostname", f.host, "-f", `body=${comment}`]]),
      ["api", "--method", "PUT", notes, "--hostname", f.host, "-f", "state_event=close"],
    ]);
    assert.equal((await executeGithubIssueClosure(approved, f.run, () => { began++; return true; })).outcome, "already_closed");
    assert.equal(began, 1, "an already-closed issue gets no second note");
  }
});

test("GitLab not-planned closure states its reason in a note before closing", async () => {
  for (const comment of [undefined, "Superseded by #200."]) {
    const f = gitlab();
    const approved = await snapshot(f, { reason: "not_planned", ...(comment === undefined ? {} : { comment }) });
    const expected = `Closed as not planned: Retire obsolete work.${comment === undefined ? "" : `\n\n${comment}`}`;
    assert.equal(gitlabClosureNote(approved), expected);
    assert.equal((await executeGithubIssueClosure(approved, f.run, () => true)).outcome, "closed");
    const [note, close] = mutations(f);
    assert.deepEqual(note!.args.slice(-2), ["-f", `body=${expected}`]);
    assert.equal(close!.args[2], "PUT");
    assert.equal(approved.reason, "not_planned");
  }
});

test("GitLab closure refuses digest drift before any mutation and never retries after a partial failure", async () => {
  for (const change of [
    (f: ReturnType<typeof gitlab>) => { f.issue.description = "Edited"; },
    (f: ReturnType<typeof gitlab>) => { f.lists.closedBy = [f.mergeRequest(90)]; },
  ]) {
    const f = gitlab();
    const approved = await snapshot(f, { reason: "not_planned", comment: "Retired." });
    change(f);
    assert.equal((await executeGithubIssueClosure(approved, f.run, () => assert.fail("no mutation fence should begin"))).outcome, "refused");
    assert.deepEqual(mutations(f), []);
  }
  for (const mode of ["failure", "unverified"] as const) {
    const f = gitlab();
    const approved = await snapshot(f, { reason: "not_planned" });
    if (mode === "failure") f.failPut(); else f.leaveOpen();
    assert.equal((await executeGithubIssueClosure(approved, f.run, () => true)).outcome, "uncertain");
    assert.deepEqual(mutations(f).map((call) => call.args[2]), ["POST", "PUT"], "the note and close each run once");
  }
});
