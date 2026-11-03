import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CampaignLaunchInspectionMessage } from "@wollipog/protocol";
import { CampaignLaunchInspections, inspectCampaignLaunch } from "./campaign-launch-inspection.js";
import { CAMPAIGN_LAUNCH_INSPECTION_ERRORS, type CampaignLaunchInspectionFailure } from "@wollipog/protocol";

test("registered workspace inspection reads exact issues and returns only sanitized identity and digest", async () => {
  const path = await mkdtemp(join(tmpdir(), "campaign-launch-inspection-"));
  const calls: unknown[] = [];
  try {
    const result = await inspectCampaignLaunch({ type: "campaign_launch_inspect", requestId: "read-1", workspaceId: "w", issueNumbers: [2, 1] }, [{ id: "w", path }],
      async (cwd, command, args) => {
        calls.push([cwd, command, args]);
        assert.equal(cwd, path);
        if (command === "git") return args[0] === "remote" ? "https://github.com/owner/repo.git" : args.includes("--is-inside-work-tree") ? "true" : "a".repeat(40);
        const number = Number(args.at(-1)!.split("/").at(-1));
        return JSON.stringify({ number, title: "Fixture issue", body: "Private fixture body", html_url: `https://github.com/owner/repo/issues/${number}` });
      });
    assert.equal(result.ok, true);
    assert.deepEqual(result.issueNumbers, [1, 2]);
    assert.match(result.digest!, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /Private fixture|github\.com|\/tmp\//);
    assert.equal(calls.length, 5);
    let executed = false;
    const bad = await inspectCampaignLaunch({ type: "campaign_launch_inspect", requestId: "read-2", workspaceId: "w", issueNumbers: [1], path: "/foreign" } as CampaignLaunchInspectionMessage,
      [{ id: "w", path }], async () => { executed = true; return ""; });
    assert.equal(bad.ok, false);
    assert.equal(executed, false);
    const unknown = await inspectCampaignLaunch({ type: "campaign_launch_inspect", requestId: "read-3", workspaceId: "foreign", issueNumbers: [1] }, [{ id: "w", path }]);
    assert.equal(unknown.ok, false);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("inspection errors cannot expose credential-bearing origin or environment diagnostics", async () => {
  const result = await inspectCampaignLaunch({ type: "campaign_launch_inspect", requestId: "read-1", workspaceId: "w", issueNumbers: [1] }, [{ id: "w", path: tmpdir() }],
    async () => { throw new Error("https://secret:token@github.com/owner/repo PRIVATE_ENV=value"); });
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /secret|token|PRIVATE_ENV/);
});

type Pending = { args: string[]; signal: AbortSignal; release: () => void };
/** Deterministic injected commands: issue reads park until released or until their signal aborts. */
function parkedReads(path: string) {
  const pending: Pending[] = [];
  const calls: string[][] = [];
  const run = async (cwd: string, command: string, args: string[], signal: AbortSignal) => {
    assert.equal(cwd, path);
    calls.push([command, ...args]);
    if (command === "git") return args[0] === "remote" ? "https://github.com/owner/repo.git" : args.includes("--is-inside-work-tree") ? "true" : "a".repeat(40);
    const number = Number(args.at(-1)!.split("/").at(-1));
    await new Promise<void>((resolve, reject) => {
      pending.push({ args, signal, release: resolve });
      signal.addEventListener("abort", () => reject(new Error("terminated by its own signal")), { once: true });
    });
    return JSON.stringify({ number, title: "Fixture issue", body: "", html_url: `https://github.com/owner/repo/issues/${number}` });
  };
  return { pending, calls, run };
}
const issueReads = (calls: string[][]) => calls.filter((call) => call[0] === "gh").length;
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("cancellation during a multi-issue inspection starts no further issue reads and reports an incomplete result (#3360)", async () => {
  const path = await mkdtemp(join(tmpdir(), "campaign-launch-cancel-"));
  try {
    const reads = parkedReads(path);
    const controller = new AbortController();
    const result = inspectCampaignLaunch({ type: "campaign_launch_inspect", requestId: "cancel-1", workspaceId: "w",
      issueNumbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, [{ id: "w", path }], reads.run, controller.signal);
    while (reads.pending.length < 4) await turn();
    assert.equal(issueReads(reads.calls), 4, "reads are bounded to one batch of four");
    controller.abort();
    const settled = await result;
    assert.equal(settled.ok, false);
    assert.equal(settled.cancelled, true);
    assert.equal(settled.repository, undefined);
    assert.equal(settled.digest, undefined);
    assert.ok(reads.pending.every((entry) => entry.signal.aborted), "every in-flight command was signalled");
    for (let tick = 0; tick < 20; tick++) await turn();
    assert.equal(issueReads(reads.calls), 4, "no issue read starts after cancellation is observed");
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("a cancel reaches only its own inspection, unknown ids are ignored and the runner lifetime bounds a lost cancel (#3360)", async () => {
  const path = await mkdtemp(join(tmpdir(), "campaign-launch-owned-"));
  try {
    const inspections = new CampaignLaunchInspections();
    const mine = parkedReads(path), theirs = parkedReads(path);
    const a = inspections.run({ type: "campaign_launch_inspect", requestId: "mine", workspaceId: "w", issueNumbers: [1, 2] }, [{ id: "w", path }], mine.run);
    const b = inspections.run({ type: "campaign_launch_inspect", requestId: "theirs", workspaceId: "w", issueNumbers: [3] }, [{ id: "w", path }], theirs.run);
    while (mine.pending.length < 2 || theirs.pending.length < 1) await turn();
    assert.equal(inspections.size, 2);
    assert.equal(inspections.cancel("unknown"), false);
    assert.equal(inspections.cancel(42), false);
    assert.equal(inspections.cancel("mine"), true);
    assert.equal((await a).cancelled, true);
    assert.equal(theirs.pending[0]!.signal.aborted, false, "the other inspection's command is untouched");
    theirs.pending[0]!.release();
    const other = await b;
    assert.equal(other.ok, true);
    assert.deepEqual(other.issueNumbers, [3]);
    assert.equal(inspections.size, 0);
    assert.equal(inspections.cancel("mine"), false, "a finished inspection cannot be cancelled again");

    const bounded = new CampaignLaunchInspections(20);
    const lost = parkedReads(path);
    const expired = await bounded.run({ type: "campaign_launch_inspect", requestId: "lost", workspaceId: "w", issueNumbers: [1] }, [{ id: "w", path }], lost.run);
    assert.equal(expired.ok, false);
    assert.equal(expired.cancelled, true);
    assert.equal(bounded.size, 0);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("a repository-only inspection verifies the origin without reading issues", async () => {
  const path = await mkdtemp(join(tmpdir(), "campaign-launch-repository-"));
  try {
    const reads = parkedReads(path);
    const result = await inspectCampaignLaunch({ type: "campaign_launch_inspect", requestId: "repo-only", workspaceId: "w", issueNumbers: [] },
      [{ id: "w", path }], reads.run);
    assert.equal(result.ok, true);
    assert.equal(result.repository, "owner/repo");
    assert.deepEqual(result.issueNumbers, []);
    assert.equal(issueReads(reads.calls), 0);
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("SSH home workspace inspection uses the authorized project subfolder, including dynamic ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspection-location-"));
  const { mkdir } = await import("node:fs/promises");
  const repository = join(root, "project");
  await mkdir(repository);
  try {
    for (const workspaceId of ["home", "dynamic-location"]) {
      const result = await inspectCampaignLaunch({ type: "campaign_launch_inspect", requestId: "location", workspaceId,
        workspacePath: repository, issueNumbers: [] } as CampaignLaunchInspectionMessage, [{ id: "home", path: root }],
      async (cwd, command, args) => {
        assert.equal(cwd, repository, "inspect the project, never the registered home root");
        return args[0] === "remote" ? "git@github.com:owner/repo.git" : args.includes("--is-inside-work-tree") ? "true" : "a".repeat(40);
      });
      assert.equal(result.ok, true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native git inspection succeeds for a subfolder with only home:. registered (#4090)", async () => {
  const path = await mkdtemp(join(tmpdir(), "inspection-native-"));
  const git = promisify(execFile);
  try {
    await git("git", ["init", path]);
    await git("git", ["-C", path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "Fixture"]);
    await git("git", ["-C", path, "remote", "add", "origin", "git@github.com:owner/repo.git"]);
    for (const workspaceId of ["home", "dynamic-location"]) {
      const result = await inspectCampaignLaunch({ type: "campaign_launch_inspect", requestId: "native", workspaceId,
        workspacePath: path, issueNumbers: [] }, [{ id: "home", path: "." }]);
      assert.equal(result.ok, true);
      assert.equal(result.repository, "owner/repo");
      assert.doesNotMatch(JSON.stringify(result), /inspection-native|git@|\/tmp\//);
    }
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("GitLab launch inspection preserves public and self-managed origins with exact issue reads", async () => {
  const path = await mkdtemp(join(tmpdir(), "inspection-gitlab-"));
  try {
    for (const host of ["gitlab.com", "gitlab.example.com"]) {
      for (const issueNumbers of [[], [7]]) {
        const calls: string[][] = [];
        const repository = `${host}/group/project`;
        const result = await inspectCampaignLaunch({ type: "campaign_launch_inspect", requestId: "gitlab",
          workspaceId: "dynamic-location", workspacePath: path, issueNumbers }, [], async (_cwd, command, args) => {
          calls.push([command, ...args]);
          if (command === "git") return args[0] === "remote" ? `git@${host}:group/project.git`
            : args.includes("--is-inside-work-tree") ? "true" : "a".repeat(40);
          assert.equal(command, "glab");
          assert.equal(args[args.indexOf("--hostname") + 1], host);
          return JSON.stringify(args[1]!.endsWith("/issues/7")
            ? { id: 70, iid: 7, project_id: 42, title: "Private fixture issue", description: null,
              state: "opened", web_url: `https://${repository}/-/issues/7`, updated_at: "2026-10-01T10:00:00Z", assignees: [], labels: [] }
            : { id: 42, path_with_namespace: "group/project", web_url: `https://${repository}`, default_branch: "main" });
        });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.repository, repository);
        assert.deepEqual(result.issueNumbers, issueNumbers);
        assert.match(result.digest!, /^[a-f0-9]{64}$/);
        assert.doesNotMatch(JSON.stringify(result), /Private fixture|inspection-gitlab|git@|\/tmp\//);
        assert.equal(calls.filter(([command]) => command === "glab").length, issueNumbers.length ? 2 : 0);
      }
    }
  } finally { await rm(path, { recursive: true, force: true }); }
});

test("each inspection step has a fixed sanitized failure without command output or paths", async () => {
  const path = await mkdtemp(join(tmpdir(), "inspection-errors-"));
  try {
    for (const failure of Object.keys(CAMPAIGN_LAUNCH_INSPECTION_ERRORS) as CampaignLaunchInspectionFailure[]) {
      const result = await inspectCampaignLaunch({ type: "campaign_launch_inspect", requestId: "failure",
        workspaceId: failure === "unknown_location" ? "unknown" : "w", issueNumbers: [1],
        ...(failure === "missing_path" ? { workspacePath: join(path, "absent") } : {}),
        ...(failure === "invalid_request" ? { workspacePath: "" } : {}),
      }, [{ id: "w", path }], async (_cwd, command, args) => {
        if ((failure === "not_repository" && args.includes("--is-inside-work-tree")) ||
            (failure === "issue_read_failed" && command === "gh")) throw new Error("secret://token /private/path RAW_OUTPUT");
        if (args[0] === "remote") return failure === "unsupported_origin" ? "file:///private/path" : "git@github.com:owner/repo.git";
        return args.includes("--is-inside-work-tree") ? "true" : "a".repeat(40);
      });
      assert.equal(result.ok, false, failure);
      assert.equal(result.failure, failure);
      assert.equal(result.error, CAMPAIGN_LAUNCH_INSPECTION_ERRORS[failure]);
      assert.doesNotMatch(JSON.stringify(result), /secret|token|private|RAW_OUTPUT|gitlab|inspection-errors-/);
      assert.equal(result.digest, undefined);
    }
  } finally { await rm(path, { recursive: true, force: true }); }
});
