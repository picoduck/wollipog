import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CampaignLaunchInspectionMessage } from "@wollipog/protocol";
import { CampaignLaunchInspections, inspectCampaignLaunch } from "./campaign-launch-inspection.js";

test("registered workspace inspection reads exact issues and returns only sanitized identity and digest", async () => {
  const path = await mkdtemp(join(tmpdir(), "campaign-launch-inspection-"));
  const calls: unknown[] = [];
  try {
    const result = await inspectCampaignLaunch({ type: "campaign_launch_inspect", requestId: "read-1", workspaceId: "w", issueNumbers: [2, 1] }, [{ id: "w", path }],
      async (cwd, command, args) => {
        calls.push([cwd, command, args]);
        assert.equal(cwd, path);
        if (command === "git") return args[0] === "remote" ? "https://github.com/owner/repo.git" : "a".repeat(40);
        const number = Number(args.at(-1)!.split("/").at(-1));
        return JSON.stringify({ number, title: "Fixture issue", body: "Private fixture body", html_url: `https://github.com/owner/repo/issues/${number}` });
      });
    assert.equal(result.ok, true);
    assert.deepEqual(result.issueNumbers, [1, 2]);
    assert.match(result.digest!, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), /Private fixture|github\.com|\/tmp\//);
    assert.equal(calls.length, 4);
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
    if (command === "git") return args[0] === "remote" ? "https://github.com/owner/repo.git" : "a".repeat(40);
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
