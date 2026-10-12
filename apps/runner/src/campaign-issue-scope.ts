import { epicChecklistMembers, campaignPublicationSafe, campaignPublicationTitle, type CampaignIssueScopeView } from "@wollipog/protocol";
import { createHash } from "node:crypto";
import { githubSlug } from "./git-ops.js";

type Run = (command: string, args: string[]) => Promise<string>;
export async function inspectCampaignIssueScope(run: Run, epic?: number, issues: number[] = [], publication?: { sanitizedTitle: string; sanitizedBody: string; labels: string[] }): Promise<{ repository: string; candidates: NonNullable<CampaignIssueScopeView["candidates"]> }> {
  const repository = githubSlug((await run("git", ["remote", "get-url", "origin"])).trim())?.toLowerCase();
  if (!repository) throw new Error("Campaign issue scope requires an exact github.com origin remote");
  const candidates: NonNullable<CampaignIssueScopeView["candidates"]> = [];
  const readIssue = async (number: number) => {
    const raw = JSON.parse(await run("gh", ["api", "--hostname", "github.com", `repos/${repository}/issues/${number}`]));
    if (raw.number !== number || raw.pull_request || typeof raw.title !== "string" || typeof raw.body !== "string" && raw.body !== null ||
        typeof raw.html_url !== "string" || raw.html_url.toLowerCase() !== `https://github.com/${repository}/issues/${number}`) {
      throw new Error("GitHub could not verify a repository-qualified issue");
    }
    if (publication && (raw.title !== publication.sanitizedTitle || raw.body !== publication.sanitizedBody ||
        !Array.isArray(raw.labels) || JSON.stringify(raw.labels.map((label: {name:string}) => label.name).sort()) !== JSON.stringify([...publication.labels].sort()))) throw new Error("Published issue payload differs from its exact authorization");
    return { title: raw.title as string, body: (raw.body ?? "") as string };
  };
  const readIssues = async (numbers: number[]) => {
    if (candidates.length + numbers.length > 100) throw new Error("Issue selection exceeds 100 issues; select a smaller explicit scope");
    const results: Array<{number:number;title:string}> = [];
    // Bound subprocess/network concurrency while avoiding one round trip per issue in series.
    for (let offset=0; offset<numbers.length; offset+=4) {
      const batch = await Promise.all(numbers.slice(offset,offset+4).map(async (number) => ({number,...await readIssue(number)})));
      results.push(...batch);
    }
    return results;
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
    const checklist = epicChecklistMembers(umbrella.body, repository).filter((number) => !candidates.some((c) => c.issue.number === number));
    for (const member of await readIssues(checklist)) {
      candidates.push({ issue: { repository, number: member.number }, title: member.title, source: "member_checklist" });
    }
  }
  const explicit = issues.filter((number) => !candidates.some((c) => c.issue.number === number));
  for (const issue of await readIssues(explicit)) {
    candidates.push({ issue: { repository, number: issue.number }, title: issue.title, source: "member_checklist" });
  }
  return { repository, candidates };
}

/** Search both states and the latest issue page; bounded overflow cannot prove deduplication. */
export async function inspectCampaignPublication(run: Run, publication: { sanitizedTitle: string; sanitizedBody: string; labels: string[] }): Promise<{ repository: string; publicationDigest: string }> {
  if (!campaignPublicationSafe(publication.sanitizedTitle, publication.sanitizedBody, publication.labels)) throw new Error("Publication requires sanitized issue-reporting content");
  const { repository } = await inspectCampaignIssueScope(run);
  const recent = JSON.parse(await run("gh", ["api", "--hostname", "github.com", `repos/${repository}/issues?state=all&sort=created&direction=desc&per_page=100`]));
  const search = JSON.parse(await run("gh", ["api", "--hostname", "github.com", "search/issues", "-X", "GET", "-f",
    `q=repo:${repository} is:issue in:title ${publication.sanitizedTitle}`, "-f", "per_page=100"]));
  if (!Array.isArray(recent) || !Array.isArray(search.items) || search.incomplete_results !== false || !Number.isSafeInteger(search.total_count) || search.total_count > 100) throw new Error("Duplicate inspection is incomplete");
  const matches = [...recent, ...search.items].filter((row) => !row.pull_request);
  if (matches.some((row) => typeof row.title !== "string" || !Number.isSafeInteger(row.number) || typeof row.html_url !== "string" ||
      !row.html_url.toLowerCase().startsWith(`https://github.com/${repository}/issues/`))) throw new Error("Invalid duplicate evidence");
  if (matches.some((row) => campaignPublicationTitle(row.title) === campaignPublicationTitle(publication.sanitizedTitle))) throw new Error("An issue already has this normalized title");
  // Bind the payload, not volatile unrelated tracker rows. Inspection is repeated at consumption.
  return { repository, publicationDigest: createHash("sha256").update(JSON.stringify(publication)).digest("hex") };
}
