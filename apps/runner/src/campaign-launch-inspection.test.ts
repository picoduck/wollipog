import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CampaignLaunchInspectionMessage } from "@wollipog/protocol";
import { inspectCampaignLaunch } from "./campaign-launch-inspection.js";

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
