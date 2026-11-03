import { createHash } from "node:crypto";
import type {
  AgentContext, GithubIssueClosureInspection, GithubIssueClosureRefusal, GithubIssueClosureRefusalReason, GithubIssueClosureResult, GithubIssueClosureSnapshot,
} from "@wollipog/protocol";
import { campaignRepositoryLocation, githubIssueClosureRefusal } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";
import { githubSlug } from "./git-ops.js";
import { closeGitlabIssue, gitlabIssueOrigin, inspectGitlabIssueClosure } from "./gitlab-issue-closure.js";

/** Bounded authoritative reads; incomplete conflict evidence is a refusal, never an empty list. */
const INSPECTION_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ nameWithOwner
    issue(number:$number){ id number title body url state updatedAt
      assignees(first:100){nodes{login} pageInfo{hasNextPage}}
      labels(first:100){nodes{name} pageInfo{hasNextPage}}
      timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{
        ... on CrossReferencedEvent{source{... on PullRequest{number url state repository{nameWithOwner}}}}
      } pageInfo{hasNextPage}}
    }
    pullRequests(first:100,states:OPEN){nodes{number title body url headRefOid updatedAt
      closingIssuesReferences(first:100){nodes{number repository{nameWithOwner}} pageInfo{hasNextPage}}
    } pageInfo{hasNextPage}}
  }
}`;

/** Fixed, safe refusal text; command/provider errors are never surfaced as raw output. `failure`
 * classifies it for a refused closure (#4059). */
export class IssueClosureInspectionError extends Error {
  constructor(message: string, readonly failure: GithubIssueClosureRefusalReason = "evidence_unavailable") {
    super(message);
  }
}

/** The digest input for one related open PR (#4059): what the closure depends on, its identity and
 * whether it closes the issue. Its title, body, head and updatedAt are left out, so a push, a merge
 * from the default branch or a body edit keeps an approval unless it changes one of these, or
 * whether the PR is related at all. */
export function closureDigestPullRequest(pr: { number: number; url: string; closesIssue: boolean }) {
  return { number: pr.number, url: pr.url, closesIssue: pr.closesIssue };
}

type Run = (command: string, args: string[]) => Promise<string>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IssueClosureInspectionError("GitHub returned incomplete issue evidence");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new IssueClosureInspectionError("GitHub returned incomplete issue evidence");
  return value;
}
function nodes(value: unknown): unknown[] {
  const connection = object(value);
  if (object(connection.pageInfo).hasNextPage !== false || !Array.isArray(connection.nodes)) {
    throw new IssueClosureInspectionError("Issue closure requires complete evidence; GitHub's bounded inspection limit was exceeded");
  }
  return connection.nodes;
}

/** `agentEnv` is the environment the Orchestrator's agent launches with, so a `GH_TOKEN`,
 * `GITLAB_TOKEN` or `GLAB_CONFIG_DIR` configured for that agent selects the same login its own `gh`
 * or `glab` uses (#3539), as for forge observation and the GitLab merge preflight. */
export function issueClosureRun(context: AgentContext, cwd: string, agentEnv: Record<string, string> = {}): Run {
  return async (command, args) => (await runContextCommand(context, command, args, {
    cwd, timeoutMs: 25_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...agentEnv, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_PROMPT: "1" },
  })).stdout;
}

/** Inspect an issue of the origin's repository: GitHub through `gh`, or a GitLab project (#3539,
 * v249) through `glab` with the same result shape and digest. */
export async function inspectGithubIssueClosure(issue: number, run: Run, deliveryPullRequests?: Array<{number:number;headSha:string}>): Promise<GithubIssueClosureInspection> {
  if (!Number.isSafeInteger(issue) || issue < 1) throw new IssueClosureInspectionError("issue must be a positive integer");
  const origin = (await run("git", ["remote", "get-url", "origin"])).trim();
  const repository = githubSlug(origin);
  if (!repository) {
    const gitlab = gitlabIssueOrigin(origin);
    if (gitlab) return inspectGitlabIssueClosure(issue, run, gitlab, deliveryPullRequests);
    throw new IssueClosureInspectionError("Issue closure requires an exact github.com or GitLab origin remote");
  }
  const [owner, repo] = repository.split("/");
  const response = object(JSON.parse(await run("gh", ["api", "graphql", "--hostname", "github.com",
    "-f", `query=${INSPECTION_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${issue}`])));
  if (response.errors) throw new IssueClosureInspectionError("GitHub could not provide complete issue-closure evidence");
  const data = object(object(response.data).repository);
  const canonicalRepository = text(data.nameWithOwner);
  if (canonicalRepository.toLowerCase() !== repository.toLowerCase()) throw new IssueClosureInspectionError("GitHub repository identity changed", "repository_changed");
  const target = object(data.issue);
  const url = `https://github.com/${canonicalRepository}/issues/${issue}`;
  if (target.number !== issue || target.url !== url || !["OPEN", "CLOSED"].includes(text(target.state))) {
    throw new IssueClosureInspectionError("GitHub issue identity is invalid");
  }
  const assignees = nodes(target.assignees).map((item) => text(object(item).login)).sort();
  const labels = nodes(target.labels).map((item) => text(object(item).name)).sort();
  const referenced = nodes(target.timelineItems).flatMap((item) => {
    const source = object(item).source;
    if (!source) return [];
    const pr = object(source);
    return pr.state === "OPEN" && object(pr.repository).nameWithOwner === canonicalRepository ? [pr.number] : [];
  });
  const mention = new RegExp(`(?:^|[^A-Za-z0-9_/])#${issue}(?![0-9])`, "u");
  const relevant = nodes(data.pullRequests).flatMap((raw) => {
    const pr = object(raw);
    if (!Number.isSafeInteger(pr.number) || (pr.number as number) < 1 ||
        pr.url !== `https://github.com/${canonicalRepository}/pull/${pr.number}` ||
        !/^[0-9a-f]{40}$/u.test(text(pr.headRefOid))) throw new IssueClosureInspectionError("GitHub pull-request evidence is invalid");
    const closing = nodes(pr.closingIssuesReferences).some((rawIssue) => {
      const linked = object(rawIssue);
      return linked.number === issue && object(linked.repository).nameWithOwner === canonicalRepository;
    });
    const body = text(pr.body);
    const title = text(pr.title);
    return closing || referenced.includes(pr.number) || mention.test(`${title}\n${body}`) || body.includes(url)
      ? [{ number: pr.number as number, title, url: text(pr.url), headSha: text(pr.headRefOid), closesIssue: closing }] : [];
  }).sort((a, b) => a.number - b.number);
  const title = text(target.title);
  const delivery: NonNullable<GithubIssueClosureInspection["delivery"]> = [];
  if (deliveryPullRequests !== undefined) {
    if (!deliveryPullRequests.length || deliveryPullRequests.length > 100) throw new IssueClosureInspectionError("Completed closure requires bounded actual merged PR evidence");
    const defaultBranch = text(object(JSON.parse(await run("gh", ["api", "--hostname", "github.com", `repos/${repository}`]))).default_branch);
    for (const ref of deliveryPullRequests) {
      if (!Number.isSafeInteger(ref.number) || ref.number < 1 || !/^[0-9a-f]{40}$/u.test(ref.headSha)) throw new IssueClosureInspectionError("Invalid delivered PR reference");
      const pr = object(JSON.parse(await run("gh", ["api", "--hostname", "github.com", `repos/${repository}/pulls/${ref.number}`])));
      const mergeCommitSha = text(pr.merge_commit_sha);
      if (pr.merged !== true || pr.state !== "closed" || pr.number !== ref.number || object(pr.head).sha !== ref.headSha ||
          object(pr.base).ref !== defaultBranch || object(object(pr.base).repo).full_name !== canonicalRepository ||
          !/^[0-9a-f]{40}$/u.test(mergeCommitSha)) throw new IssueClosureInspectionError("Delivery PR has not actually merged at the verified head into the default branch");
      const comparison = object(JSON.parse(await run("gh", ["api", "--hostname", "github.com", `repos/${repository}/compare/${mergeCommitSha}...${encodeURIComponent(defaultBranch)}`])));
      if (!["ahead", "identical"].includes(text(comparison.status))) throw new IssueClosureInspectionError("Delivery merge is not contained in the default branch");
      delivery.push({ number: ref.number, headSha: ref.headSha, mergeCommitSha });
    }
  }
  const forgeDigest = createHash("sha256").update(JSON.stringify({
    repository: canonicalRepository, issue, id: text(target.id), title, body: text(target.body),
    state: target.state, updatedAt: text(target.updatedAt), assignees, labels, relevant: relevant.map(closureDigestPullRequest),
  })).digest("hex");
  return { repository: canonicalRepository, issue, title, url, state: target.state as "OPEN" | "CLOSED", forgeDigest,
    openPullRequests: relevant, ...(deliveryPullRequests === undefined ? {} : { delivery }) };
}

/** Name what changed when the forge digest no longer matches (#4059): a related PR that joined or
 * left the set, then one whose closing reference changed, and otherwise the issue itself. A snapshot
 * from a runner that predates `closesIssue` can name only set changes. */
function forgeChange(snapshot: GithubIssueClosureSnapshot, current: GithubIssueClosureInspection): GithubIssueClosureRefusal {
  const approved = new Map(snapshot.openPullRequests.map((pr) => [pr.number, pr]));
  const now = new Map(current.openPullRequests.map((pr) => [pr.number, pr]));
  const moved = [...approved.keys()].filter((number) => !now.has(number)).concat([...now.keys()].filter((number) => !approved.has(number)));
  if (moved.length) return githubIssueClosureRefusal("related_pull_requests_changed", { pullRequests: moved });
  if (snapshot.openPullRequests.some((pr) => typeof pr.closesIssue !== "boolean")) return githubIssueClosureRefusal("forge_evidence_changed");
  const flipped = current.openPullRequests.filter((pr) => pr.closesIssue !== approved.get(pr.number)!.closesIssue).map((pr) => pr.number);
  return flipped.length ? githubIssueClosureRefusal("closing_reference_changed", { pullRequests: flipped })
    : githubIssueClosureRefusal("issue_changed");
}

/** The delivered PRs whose verified merge differs between the approval and now. */
function deliveryChange(approved: GithubIssueClosureSnapshot["delivery"], current: GithubIssueClosureInspection["delivery"]): number[] {
  const key = (pr: { number: number; headSha: string; mergeCommitSha: string }) => JSON.stringify(pr);
  const before = new Map((approved ?? []).map((pr) => [pr.number, key(pr)]));
  const after = new Map((current ?? []).map((pr) => [pr.number, key(pr)]));
  return [...new Set([...before.keys(), ...after.keys()])].filter((number) => before.get(number) !== after.get(number));
}

/** Called only by the trusted runner command, after CP atomically consumes the human decision.
 * The durable attempt fence is written before any forge mutation; failures are never replayed.
 * On GitLab the note (a not-planned closure always states its reason) precedes the close. */
export async function executeGithubIssueClosure(
  snapshot: GithubIssueClosureSnapshot,
  run: Run,
  begin: () => boolean,
): Promise<GithubIssueClosureResult> {
  const result = (outcome: GithubIssueClosureResult["outcome"]): GithubIssueClosureResult => ({ outcome, completedAt: Date.now() });
  // Every refusal precedes the mutation fence, so it names its reason and nothing was written.
  const refused = (refusal: GithubIssueClosureRefusal): GithubIssueClosureResult => ({ ...result("refused"), refusal });
  const current = await inspectGithubIssueClosure(snapshot.issue, run, snapshot.delivery?.map(({number,headSha}) => ({number,headSha})));
  if (current.repository !== snapshot.repository) return refused(githubIssueClosureRefusal("repository_changed"));
  if (current.state === "CLOSED") return result("already_closed");
  if (current.forgeDigest !== snapshot.forgeDigest) return refused(forgeChange(snapshot, current));
  if (snapshot.issueAdmission && current.openPullRequests.length) {
    return refused(githubIssueClosureRefusal("related_pull_request_open", { pullRequests: current.openPullRequests.map((pr) => pr.number) }));
  }
  if (snapshot.issueAdmission && JSON.stringify(current.delivery) !== JSON.stringify(snapshot.delivery)) {
    return refused(githubIssueClosureRefusal("delivery_changed", { pullRequests: deliveryChange(snapshot.delivery, current.delivery) }));
  }
  if (!begin()) return refused(githubIssueClosureRefusal("mutation_fence_unavailable"));
  try {
    if (campaignRepositoryLocation(current.repository)?.forge === "gitlab") await closeGitlabIssue(run, snapshot);
    else await run("gh", ["issue", "close", current.url, "--reason", snapshot.reason === "completed" ? "completed" : "not planned",
      ...(snapshot.comment === undefined ? [] : ["--comment", snapshot.comment])]);
    const verified = await inspectGithubIssueClosure(snapshot.issue, run);
    return result(verified.repository === snapshot.repository && verified.state === "CLOSED" ? "closed" : "uncertain");
  } catch {
    // A comment or close may already have succeeded. Never automatically retry either mutation.
    return result("uncertain");
  }
}
