import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectCampaignIssueScope } from "./campaign-issue-scope.js";

test("runner resolves native and checklist members, includes the umbrella, and never expands dependencies", async () => {
  const calls: string[] = [];
  const run = async (command: string, args: string[]) => {
    if (command === "git") return "git@github.com:Team/Repo.git";
    const path = args.at(-1)!; calls.push(path);
    if (path.includes("sub_issues")) return JSON.stringify([{ number: 2, title: "Native", html_url: "https://github.com/Team/Repo/issues/2" }]);
    const number = Number(path.split("/").at(-1));
    return JSON.stringify({ number, title: `Issue ${number}`, html_url: `https://github.com/team/repo/issues/${number}`,
      body: number === 1 ? "## Units\n- [ ] #3 Work (depends on #99)\n## Dependencies\n- [ ] #98 Other" : "" });
  };
  const result = await inspectCampaignIssueScope(run, 1);
  assert.deepEqual(result.candidates.map((c) => [c.issue.number, c.source]), [[1,"umbrella"],[2,"sub_issue"],[3,"member_checklist"]]);
  assert.ok(!calls.some((p) => p.endsWith("/99") || p.endsWith("/98")));
});

test("runner fails closed on incomplete, external or excessive membership", async () => {
  for (const members of [null, [{ number: 2, title: "Other", html_url: "https://github.com/other/repo/issues/2" }], Array(100).fill({})]) {
    const run = async (command: string, args: string[]) => command === "git" ? "https://github.com/team/repo.git"
      : JSON.stringify(args.at(-1)!.includes("sub_issues") ? members : { number: 1, title: "Epic", body: "", html_url: "https://github.com/team/repo/issues/1" });
    await assert.rejects(inspectCampaignIssueScope(run, 1));
  }
});
