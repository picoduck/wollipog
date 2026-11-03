import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeIssueClosureSnapshot, sanitizedIssueClosureRunnerError, WITHHELD_RUNNER_ERROR } from "./github-issue-closure.js";

const DIGEST = "a".repeat(64);
const HEAD = "b".repeat(40);

test("a refused closure keeps a runner message only with every credential redacted (#4059)", () => {
  const messages = (separator: string) => [`Bearer${separator}secretValueA`, `password=${separator}secretValueB`,
    `token:${separator}secretValueC`, `Authorization:${separator}Basic secretValueD`,
    `https://user:${separator}secretValueE@github.com`, `api_key =${separator}"secretValueF"`, `https://user:secretValueG${separator}@github.com`];
  // Whitespace of any kind between a credential's label and its value is redacted on one line.
  // (Whitespace inside URL userinfo ends the URL, in raw text as on one line.)
  for (const separator of [" ", "\t", "\n", "\r\n", " \n\t ", "\u000b", "\u000c", " "]) {
    for (const message of messages(separator).filter((text) => !text.startsWith("https://"))) {
      const kept = sanitizedIssueClosureRunnerError(`GitHub refused: ${message}`) ?? "";
      assert.ok(kept.startsWith("GitHub refused: ") && !/secretValue|[\r\n\t]/u.test(kept), JSON.stringify([separator, kept]));
    }
  }
  // Any other control or format character could hide a credential from one reading and split it in
  // another, so the message is withheld.
  for (const separator of ["\u0007", "\u0000", "​", "\u0007\n", "\n\u0007", "\u0007 ​", " \r\n\u0000 ", "\u0085", "‮"]) {
    for (const message of messages(separator)) {
      assert.equal(sanitizedIssueClosureRunnerError(`GitHub refused: ${message}`), WITHHELD_RUNNER_ERROR, JSON.stringify(separator));
    }
  }
  // A credential straddling the read bound loses its tail rather than slipping under its pattern.
  const token = `ghp_${"A".repeat(36)}`;
  const long = sanitizedIssueClosureRunnerError(`${token} ${"x ".repeat(8_190)}${token}`) ?? "";
  assert.ok(!long.includes("ghp_") && long.length <= 300 && long.endsWith("…"), long.slice(0, 80));
  assert.equal(sanitizedIssueClosureRunnerError(`${"word ".repeat(3_277)}ghp_${"B".repeat(36)}`)?.includes("ghp_"), false);
  assert.equal(sanitizedIssueClosureRunnerError("Campaign scope revision is stale."), "Campaign scope revision is stale.");
  assert.equal(sanitizedIssueClosureRunnerError(" \n\t "), undefined);
  assert.equal(sanitizedIssueClosureRunnerError(42), undefined);
});

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
