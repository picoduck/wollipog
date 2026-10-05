import { epicChecklistMembers, type CampaignIssueScopeView } from "@wollipog/protocol";
import { githubSlug } from "./git-ops.js";

type Run = (command: string, args: string[]) => Promise<string>;
export async function inspectCampaignIssueScope(run: Run, epic?: number, issues: number[] = []): Promise<{ repository: string; candidates: NonNullable<CampaignIssueScopeView["candidates"]> }> {
  const repository = githubSlug((await run("git", ["remote", "get-url", "origin"])).trim())?.toLowerCase();
  if (!repository) throw new Error("Campaign issue scope requires an exact github.com origin remote");
  const candidates: NonNullable<CampaignIssueScopeView["candidates"]> = [];
  const readIssue = async (number: number) => {
    const raw = JSON.parse(await run("gh", ["api", "--hostname", "github.com", `repos/${repository}/issues/${number}`]));
    if (raw.number !== number || raw.pull_request || typeof raw.title !== "string" || typeof raw.body !== "string" && raw.body !== null ||
        typeof raw.html_url !== "string" || raw.html_url.toLowerCase() !== `https://github.com/${repository}/issues/${number}`) {
      throw new Error("GitHub could not verify a repository-qualified issue");
    }
    return { title: raw.title as string, body: (raw.body ?? "") as string };
  };
  if (epic !== undefined) {
    const umbrella = await readIssue(epic);
    candidates.push({ issue: { repository, number: epic }, title: umbrella.title, source: "umbrella" });
    // Read one extra row to detect overflow, rather than silently authorizing a partial epic.
    const children = JSON.parse(await run("gh", ["api", "--hostname", "github.com", `repos/${repository}/issues/${epic}/sub_issues?per_page=100`]));
    if (!Array.isArray(children) || children.length > 99) throw new Error("Epic members exceed the bounded scope; select explicit issues");
    for (const child of children) {
      if (!Number.isSafeInteger(child.number) || child.number < 1 || typeof child.title !== "string" || child.pull_request ||
          typeof child.html_url !== "string" || child.html_url.toLowerCase() !== `https://github.com/${repository}/issues/${child.number}`) {
        throw new Error("Epic contains a member outside the campaign repository; select explicit issues");
      }
      candidates.push({ issue: { repository, number: child.number }, title: child.title, source: "sub_issue" });
    }
    for (const number of epicChecklistMembers(umbrella.body, repository)) {
      if (candidates.some((c) => c.issue.number === number)) continue;
      const member = await readIssue(number);
      candidates.push({ issue: { repository, number }, title: member.title, source: "member_checklist" });
      if (candidates.length > 100) throw new Error("Epic scope exceeds 100 issues; select explicit issues");
    }
  }
  for (const number of issues) {
    if (!candidates.some((c) => c.issue.number === number)) {
      const issue = await readIssue(number);
      candidates.push({ issue: { repository, number }, title: issue.title, source: "member_checklist" });
    }
  }
  return { repository, candidates };
}
