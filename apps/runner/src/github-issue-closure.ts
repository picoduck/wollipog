import { createHash } from "node:crypto";
import type { AgentContext, GithubIssueClosureInspection, GithubIssueClosureResult, GithubIssueClosureSnapshot } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";
import { githubSlug } from "./git-ops.js";

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

/** Fixed, safe refusal text; command/provider errors are never surfaced as raw output. */
export class IssueClosureInspectionError extends Error {}

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

export function issueClosureRun(context: AgentContext, cwd: string): Run {
  return async (command, args) => (await runContextCommand(context, command, args, {
    cwd, timeoutMs: 25_000, maxBuffer: 2 * 1024 * 1024,
    env: { GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
  })).stdout;
}

export async function inspectGithubIssueClosure(issue: number, run: Run): Promise<GithubIssueClosureInspection> {
  if (!Number.isSafeInteger(issue) || issue < 1) throw new IssueClosureInspectionError("issue must be a positive integer");
  const repository = githubSlug((await run("git", ["remote", "get-url", "origin"])).trim());
  if (!repository) throw new IssueClosureInspectionError("Issue closure requires an exact github.com origin remote");
  const [owner, repo] = repository.split("/");
  const response = object(JSON.parse(await run("gh", ["api", "graphql", "--hostname", "github.com",
    "-f", `query=${INSPECTION_QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${issue}`])));
  if (response.errors) throw new IssueClosureInspectionError("GitHub could not provide complete issue-closure evidence");
  const data = object(object(response.data).repository);
  const canonicalRepository = text(data.nameWithOwner);
  if (canonicalRepository.toLowerCase() !== repository.toLowerCase()) throw new IssueClosureInspectionError("GitHub repository identity changed");
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
      ? [{ number: pr.number as number, title, url: text(pr.url), headSha: text(pr.headRefOid),
          body, updatedAt: text(pr.updatedAt) }] : [];
  }).sort((a, b) => a.number - b.number);
  const title = text(target.title);
  const forgeDigest = createHash("sha256").update(JSON.stringify({
    repository: canonicalRepository, issue, id: text(target.id), title, body: text(target.body),
    state: target.state, updatedAt: text(target.updatedAt), assignees, labels, relevant,
  })).digest("hex");
  return { repository: canonicalRepository, issue, title, url, state: target.state as "OPEN" | "CLOSED", forgeDigest,
    openPullRequests: relevant.map(({ number, title, url, headSha }) => ({ number, title, url, headSha })) };
}

/** Called only by the trusted runner command, after CP atomically consumes the human decision.
 * The durable attempt fence is written before any GitHub mutation; failures are never replayed. */
export async function executeGithubIssueClosure(
  snapshot: GithubIssueClosureSnapshot,
  run: Run,
  begin: () => boolean,
): Promise<GithubIssueClosureResult> {
  const result = (outcome: GithubIssueClosureResult["outcome"]) => ({ outcome, completedAt: Date.now() });
  const current = await inspectGithubIssueClosure(snapshot.issue, run);
  if (current.repository !== snapshot.repository) return result("refused");
  if (current.state === "CLOSED") return result("already_closed");
  if (current.forgeDigest !== snapshot.forgeDigest) return result("refused");
  if (!begin()) return result("refused");
  try {
    await run("gh", ["issue", "close", current.url, "--reason", snapshot.reason === "completed" ? "completed" : "not planned",
      ...(snapshot.comment === undefined ? [] : ["--comment", snapshot.comment])]);
    const verified = await inspectGithubIssueClosure(snapshot.issue, run);
    return result(verified.repository === snapshot.repository && verified.state === "CLOSED" ? "closed" : "uncertain");
  } catch {
    // A comment or close may already have succeeded. Never automatically retry either mutation.
    return result("uncertain");
  }
}
