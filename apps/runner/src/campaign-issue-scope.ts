import { epicChecklistMembers, campaignPublicationSafe, campaignPublicationSubject, campaignPublicationTitle, campaignRepositoryLocation, ISSUE_CLOSURE_EPIC_MEMBERS_MAX,
  CAMPAIGN_ISSUE_FACT_LIMITS, type CampaignIssueFacts, type CampaignIssueScopeView, type IssueClosureEpicMembers, type IssueClosureEpicMemberState } from "@wollipog/protocol";
import { createHash } from "node:crypto";
import { githubSlug } from "./git-ops.js";
import { gitlabIssueOrigin, readGitlabIssue, readGitlabProject } from "./gitlab-issue-closure.js";

type Run = (command: string, args: string[]) => Promise<string>;
type Candidates = NonNullable<CampaignIssueScopeView["candidates"]>;

/** A fixed refusal whose sentence is safe to return to the control plane as is. */
export class CampaignIssueScopeRefusal extends Error {}

export const GITLAB_PUBLICATION_REFUSAL = "Campaign issue publication supports GitHub repositories only";

/** One requested number's facts (#4103), bounded. Every string is the forge's untrusted text.
 * Labels are never truncated, because the Human Required label floor reads every one: an issue
 * whose labels exceed the bounds fails the read instead. */
function issueFacts(number: number, kind: CampaignIssueFacts["kind"], open: boolean, title: string, body: string,
  labels: string[], assignees: string[]): CampaignIssueFacts {
  const limits = CAMPAIGN_ISSUE_FACT_LIMITS;
  if (labels.length > limits.labels || labels.some((label) => label.length > limits.labelChars)) {
    throw new Error("Issue labels exceed the bounded inspection; the issue's labels could not be reported in full");
  }
  return { number, kind, state: open ? "open" : "closed", labels: [...labels],
    assignees: assignees.slice(0, limits.assignees).map((login) => login.slice(0, 100)),
    title: title.slice(0, limits.titleChars), bodyExcerpt: body.slice(0, limits.bodyExcerptChars) };
}

const names = (values: unknown, key: string): string[] | null => {
  if (!Array.isArray(values)) return null;
  const read = values.map((value) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined);
  return read.every((value): value is string => typeof value === "string") ? read : null;
};

/** `facts` (v290, #4103) also reports each of `issues` as `issueFacts`. A pull request is then
 * reported as one rather than failing the read, and it is never a candidate. */
export async function inspectCampaignIssueScope(run: Run, epic?: number, issues: number[] = [], publication?: { sanitizedTitle: string; sanitizedBody: string; labels: string[] },
  facts = false): Promise<{ repository: string; candidates: Candidates; issueFacts?: CampaignIssueFacts[] }> {
  const origin = (await run("git", ["remote", "get-url", "origin"])).trim();
  const repository = githubSlug(origin)?.toLowerCase();
  if (!repository) {
    const gitlab = gitlabIssueOrigin(origin);
    if (!gitlab) throw new Error("Campaign issue scope requires an exact github.com or GitLab origin remote");
    return inspectGitlabIssueScope(run, gitlab, epic, issues, publication, facts);
  }
  const candidates: NonNullable<CampaignIssueScopeView["candidates"]> = [];
  const reported: CampaignIssueFacts[] = [];
  const readIssue = async (number: number, report = false) => {
    const raw = JSON.parse(await run("gh", ["api", "--hostname", "github.com", `repos/${repository}/issues/${number}`]));
    if (report && raw.number === number && raw.pull_request && typeof raw.title === "string" && (raw.state === "open" || raw.state === "closed") &&
        typeof raw.html_url === "string" && raw.html_url.toLowerCase() === `https://github.com/${repository}/pull/${number}`) {
      reported.push(issueFacts(number, "pull_request", raw.state === "open", raw.title, typeof raw.body === "string" ? raw.body : "",
        names(raw.labels, "name") ?? [], names(raw.assignees, "login") ?? []));
      return null;
    }
    if (raw.number !== number || raw.pull_request || typeof raw.title !== "string" || typeof raw.body !== "string" && raw.body !== null ||
        typeof raw.html_url !== "string" || raw.html_url.toLowerCase() !== `https://github.com/${repository}/issues/${number}`) {
      throw new Error("GitHub could not verify a repository-qualified issue");
    }
    if (publication && (raw.title !== publication.sanitizedTitle || raw.body !== publication.sanitizedBody ||
        !Array.isArray(raw.labels) || JSON.stringify(raw.labels.map((label: {name:string}) => label.name).sort()) !== JSON.stringify([...publication.labels].sort()))) throw new Error("Published issue payload differs from its exact authorization");
    if (report) {
      const labels = names(raw.labels, "name");
      const assignees = names(raw.assignees, "login");
      if (!labels || !assignees || raw.state !== "open" && raw.state !== "closed") throw new Error("GitHub could not report the issue's state, labels and assignees");
      reported.push(issueFacts(number, "issue", raw.state === "open", raw.title, raw.body ?? "", labels, assignees));
    }
    return { title: raw.title as string, body: (raw.body ?? "") as string };
  };
  const readIssues = async (numbers: number[], report = false) => {
    if (candidates.length + numbers.length > 100) throw new Error("Issue selection exceeds 100 issues; select a smaller explicit scope");
    const results: Array<{number:number;title:string}> = [];
    // Bound subprocess/network concurrency while avoiding one round trip per issue in series.
    for (let offset=0; offset<numbers.length; offset+=4) {
      const batch = await Promise.all(numbers.slice(offset,offset+4).map(async (number) => {
        const issue = await readIssue(number, report);
        return issue ? [{ number, ...issue }] : [];
      }));
      results.push(...batch.flat());
    }
    return results;
  };
  if (epic !== undefined) {
    // Only a facts read reports a pull request instead of failing, so this is always an issue.
    const umbrella = (await readIssue(epic))!;
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
  const explicit = issues.filter((number) => facts || !candidates.some((c) => c.issue.number === number));
  for (const issue of await readIssues(explicit, facts)) {
    if (candidates.some((c) => c.issue.number === issue.number)) continue;
    candidates.push({ issue: { repository, number: issue.number }, title: issue.title, source: "member_checklist" });
  }
  return { repository, candidates, ...(facts ? { issueFacts: reported } : {}) };
}

/** A GitHub issue state as an epic member's state: only the forge's completed reason is `completed`. */
function epicMemberState(raw: { state?: unknown; state_reason?: unknown }): IssueClosureEpicMemberState | null {
  if (raw.state === "open") return "open";
  if (raw.state !== "closed") return null;
  return raw.state_reason === "completed" ? "completed" : "closed_not_completed";
}

/** An epic's members and their states at closure time (#4060), from exactly the sources scope
 * admission reads: GitHub sub-issues, then the epic body's member checklist. The member list is
 * all or nothing: an overflowing, malformed or cross-repository sub-issue list makes the whole read
 * unreadable, as it refuses scope admission. A checklist member that cannot be read is named
 * `unreadable` instead, so the closure can say which one. Agent-written text never adds a member:
 * the checklist is the forge's own copy of the epic body. */
export async function readEpicMemberStates(run: Run, repository: string, epic: number, body: string): Promise<IssueClosureEpicMembers> {
  const unreadable: IssueClosureEpicMembers = { readable: false, members: [] };
  const members = new Map<number, IssueClosureEpicMemberState>();
  let checklist: number[];
  try {
    const children = JSON.parse(await run("gh", ["api", "--hostname", "github.com", `repos/${repository}/issues/${epic}/sub_issues?per_page=100`]));
    if (!Array.isArray(children) || children.length > 99) return unreadable;
    for (const child of children) {
      const state = child && typeof child === "object" ? epicMemberState(child) : null;
      if (!state || !Number.isSafeInteger(child.number) || child.number < 1 || child.number === epic || child.pull_request ||
          typeof child.html_url !== "string" || child.html_url.toLowerCase() !== `https://github.com/${repository}/issues/${child.number}`.toLowerCase()) return unreadable;
      members.set(child.number, state);
    }
    checklist = epicChecklistMembers(body, repository).filter((number) => number !== epic && !members.has(number));
  } catch { return unreadable; }
  if (members.size + checklist.length > ISSUE_CLOSURE_EPIC_MEMBERS_MAX) return unreadable;
  for (let offset = 0; offset < checklist.length; offset += 4) {
    await Promise.all(checklist.slice(offset, offset + 4).map(async (number) => {
      try {
        const raw = JSON.parse(await run("gh", ["api", "--hostname", "github.com", `repos/${repository}/issues/${number}`]));
        const state = raw && typeof raw === "object" && raw.number === number && !raw.pull_request && typeof raw.html_url === "string" &&
          raw.html_url.toLowerCase() === `https://github.com/${repository}/issues/${number}`.toLowerCase() ? epicMemberState(raw) : null;
        members.set(number, state ?? "unreadable");
      } catch { members.set(number, "unreadable"); }
    }));
  }
  return { readable: true, members: [...members].sort(([a], [b]) => a - b).map(([number, state]) => ({ number, state })) };
}

/** GitLab scope (#3539, v249): issues are read with `glab`, and an epic is an ordinary issue of the
 * same project whose member checklist names its members. GitLab epics, issue links and work-item
 * children are never read, so there is no `sub_issue` source. The repository is the lower-case
 * `<host>/<project>`, so scope comparisons stay case-insensitive and stable. */
async function inspectGitlabIssueScope(run: Run, origin: { host: string; project: string }, epic: number | undefined, issues: number[],
  publication: { sanitizedTitle: string; sanitizedBody: string; labels: string[] } | undefined,
  facts = false): Promise<{ repository: string; candidates: Candidates; issueFacts?: CampaignIssueFacts[] }> {
  if (publication) throw new CampaignIssueScopeRefusal(GITLAB_PUBLICATION_REFUSAL);
  const repository = `${origin.host}/${origin.project}`.toLowerCase();
  const candidates: Candidates = [];
  const reported: CampaignIssueFacts[] = [];
  if (epic === undefined && !issues.length) return { repository, candidates, ...(facts ? { issueFacts: reported } : {}) };
  const fail = (message: string) => new Error(message);
  const project = await readGitlabProject(run, origin, fail);
  if (project.repository.toLowerCase() !== repository) throw new Error("GitLab project identity is invalid");
  // A GitLab merge request has its own numbers, so a number read here is always an issue.
  const readIssues = async (numbers: number[], report = false) => {
    if (candidates.length + numbers.length > 100) throw new Error("Issue selection exceeds 100 issues; select a smaller explicit scope");
    const results: Array<{ number: number; title: string }> = [];
    for (let offset = 0; offset < numbers.length; offset += 4) {
      results.push(...await Promise.all(numbers.slice(offset, offset + 4).map(async (number) => {
        const issue = await readGitlabIssue(run, project, number, fail);
        if (report) reported.push(issueFacts(number, "issue", issue.state === "OPEN", issue.title, issue.description, issue.labels, issue.assignees));
        return { number, title: issue.title };
      })));
    }
    return results;
  };
  if (epic !== undefined) {
    const umbrella = await readGitlabIssue(run, project, epic, fail);
    candidates.push({ issue: { repository, number: epic }, title: umbrella.title, source: "umbrella" });
    const checklist = epicChecklistMembers(umbrella.description, repository).filter((number) => number !== epic);
    for (const member of await readIssues(checklist)) {
      candidates.push({ issue: { repository, number: member.number }, title: member.title, source: "member_checklist" });
    }
  }
  const explicit = issues.filter((number) => facts || !candidates.some((c) => c.issue.number === number));
  for (const issue of await readIssues(explicit, facts)) {
    if (candidates.some((c) => c.issue.number === issue.number)) continue;
    candidates.push({ issue: { repository, number: issue.number }, title: issue.title, source: "member_checklist" });
  }
  return { repository, candidates, ...(facts ? { issueFacts: reported } : {}) };
}

/** Search both states and the latest issue page; bounded overflow cannot prove deduplication.
 * GitHub only: a GitLab repository is refused with a fixed sentence (#3539). */
export async function inspectCampaignPublication(run: Run, publication: { sanitizedTitle: string; sanitizedBody: string; labels: string[] }): Promise<{ repository: string; publicationDigest: string; duplicateSearch: "subject" }> {
  if (!campaignPublicationSafe(publication.sanitizedTitle, publication.sanitizedBody, publication.labels)) throw new Error("Publication requires sanitized issue-reporting content");
  const { repository } = await inspectCampaignIssueScope(run);
  if (campaignRepositoryLocation(repository)?.forge !== "github") throw new CampaignIssueScopeRefusal(GITLAB_PUBLICATION_REFUSAL);
  const recent = JSON.parse(await run("gh", ["api", "--hostname", "github.com", `repos/${repository}/issues?state=all&sort=created&direction=desc&per_page=100`]));
  const search = JSON.parse(await run("gh", ["api", "--hostname", "github.com", "search/issues", "-X", "GET", "-f",
    // Search the subject: a type tag's terms would filter out an older untagged duplicate.
    `q=repo:${repository} is:issue in:title ${campaignPublicationSubject(publication.sanitizedTitle)}`, "-f", "per_page=100"]));
  if (!Array.isArray(recent) || !Array.isArray(search.items) || search.incomplete_results !== false || !Number.isSafeInteger(search.total_count) || search.total_count > 100) throw new Error("Duplicate inspection is incomplete");
  const matches = [...recent, ...search.items].filter((row) => !row.pull_request);
  if (matches.some((row) => typeof row.title !== "string" || !Number.isSafeInteger(row.number) || typeof row.html_url !== "string" ||
      !row.html_url.toLowerCase().startsWith(`https://github.com/${repository}/issues/`))) throw new Error("Invalid duplicate evidence");
  if (matches.some((row) => campaignPublicationTitle(row.title) === campaignPublicationTitle(publication.sanitizedTitle))) throw new Error("An issue already has this normalized title");
  // Bind the payload, not volatile unrelated tracker rows. Inspection is repeated at consumption.
  const payload = { sanitizedTitle: publication.sanitizedTitle, sanitizedBody: publication.sanitizedBody, labels: publication.labels };
  return { repository, publicationDigest: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), duplicateSearch: "subject" };
}
