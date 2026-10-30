import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeIssueClosureSnapshot } from "./github-issue-closure.js";

const DIGEST = "a".repeat(64);
const HEAD = "b".repeat(40);

function closure(repository: string, url: string, pullUrl: string): Record<string, unknown> {
  return { category: "issue_closure", repository, issue: 12, title: "Obsolete task", url, forgeDigest: DIGEST,
    reason: "not_planned", explanation: "Retire obsolete work.", evidence: ["Superseded."], activeChildren: [],
    openPullRequests: [{ number: 7, title: "Work", url: pullUrl, headSha: HEAD }] };
}

test("GitHub closure snapshots keep their exact github.com addresses", () => {
  const snapshot = closure("team/repo", "https://github.com/team/repo/issues/12", "https://github.com/team/repo/pull/7");
  assert.equal(normalizeIssueClosureSnapshot(snapshot)?.url, "https://github.com/team/repo/issues/12");
  for (const patch of [
    { url: "https://github.com/team/repo/issues/13" }, { url: "https://github.com/Team/Repo/issues/12" },
    { url: "https://gitlab.example.com/team/repo/-/issues/12" }, { repository: "team" },
    { openPullRequests: [{ number: 7, title: "Work", url: "https://github.com/team/repo/pull/8", headSha: HEAD }] },
  ]) assert.equal(normalizeIssueClosureSnapshot({ ...snapshot, ...patch }), null, JSON.stringify(patch));
});

test("GitLab closure snapshots accept host-qualified projects and their exact web addresses (#3539)", () => {
  const web = "https://gitlab.example.com/Platform/Backend/Service";
  const snapshot = closure("gitlab.example.com/Platform/Backend/Service", `${web}/-/issues/12`, `${web}/-/merge_requests/7`);
  const normalized = normalizeIssueClosureSnapshot(snapshot);
  assert.equal(normalized?.repository, "gitlab.example.com/Platform/Backend/Service");
  assert.equal(normalized?.reason, "not_planned");
  assert.deepEqual(normalized?.openPullRequests, [{ number: 7, title: "Work", url: `${web}/-/merge_requests/7`, headSha: HEAD }]);
  const ported = closure("gitlab.example.com:8443/group/project", "http://gitlab.example.com:8443/group/project/-/issues/12",
    "http://gitlab.example.com:8443/Group/Project/-/merge_requests/7");
  assert.ok(normalizeIssueClosureSnapshot(ported), "a self-managed port and http scheme are kept exactly");
  for (const patch of [
    { repository: "platform/backend/service" },
    { repository: "github.com/Platform/Backend/Service", url: "https://github.com/Platform/Backend/Service/-/issues/12" },
    { url: "https://gitlab.example.com:8443/Platform/Backend/Service/-/issues/12" },
    { url: "https://elsewhere.example.com/Platform/Backend/Service/-/issues/12" },
    { url: `${web}/issues/12` }, { url: `${web}/-/issues/13` }, { url: `${web}/-/merge_requests/12` },
    { url: "https://gitlab.example.com/Platform/Backend/Other/-/issues/12" },
    { openPullRequests: [{ number: 7, title: "Work", url: `${web}/-/merge_requests/8`, headSha: HEAD }] },
    { openPullRequests: [{ number: 7, title: "Work", url: "https://github.com/Platform/Backend/pull/7", headSha: HEAD }] },
  ]) assert.equal(normalizeIssueClosureSnapshot({ ...snapshot, ...patch }), null, JSON.stringify(patch));
});

test("follow-up publication stays GitHub-only while GitLab closures normalize (#3539)", async () => {
  const { normalizeWorkflowDecisionSnapshot } = await import("./sessions.js");
  const publication = { category: "follow_up_issue_publication", sanitizedTitle: "Title", sanitizedBody: "Body", labels: [] };
  const refused = normalizeWorkflowDecisionSnapshot({ ...publication, repository: "gitlab.example.com/group/project" });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "Campaign issue publication supports GitHub repositories only");
  assert.ok(normalizeWorkflowDecisionSnapshot({ ...publication, repository: "team/repo" }).ok);
  const web = "https://gitlab.example.com/group/project";
  assert.ok(normalizeWorkflowDecisionSnapshot(closure("gitlab.example.com/group/project", `${web}/-/issues/12`, `${web}/-/merge_requests/7`)).ok);
});
