/**
 * GitLab issue closure and campaign issue reads (#3539, protocol v249): the GitLab counterpart of
 * `inspectGithubIssueClosure`, run through the session's own `glab` login and always naming the
 * host. Every read is bounded and validated against GitLab's documented API shape; a list that
 * reaches its bound is a refusal, never a partial answer. Every failure is a fixed sentence that
 * names GitLab, never `glab` output.
 */
import { createHash } from "node:crypto";
import type { GithubIssueClosureInspection, GithubIssueClosureSnapshot } from "@wollipog/protocol";
import { campaignIssueForgeUrl, campaignRepositoryLocation } from "@wollipog/protocol";
import { classifyGlabFailure } from "./campaign-gitlab-status.js";
import { parseForgeRemote } from "./git-ops.js";
import { IssueClosureInspectionError } from "./github-issue-closure.js";

type Run = (command: string, args: string[]) => Promise<string>;

/** GitLab lists are read one page of 100; a full page cannot prove the list is complete. */
const PAGE = 100;
const SHA = /^[0-9a-f]{40}$/u;

/** A non-GitHub origin that can name a host-qualified GitLab project, or null. The host is lower
 * case; the project keeps the origin's spelling until GitLab confirms it. */
export function gitlabIssueOrigin(origin: string): { host: string; project: string } | null {
  const parsed = parseForgeRemote(origin);
  if (!parsed || parsed.provider === "github") return null;
  const location = campaignRepositoryLocation(`${parsed.host.toLowerCase()}/${parsed.project}`);
  return location?.forge === "gitlab" ? { host: location.host, project: location.project } : null;
}

function record(value: unknown, error: () => Error): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw error();
  return value as Record<string, unknown>;
}

/** A fixed sentence for a failed `glab` run; only `glab`'s status words are matched, never echoed. */
function glabFailure(error: unknown, host: string): string {
  const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown; signal?: unknown; message?: unknown };
  const reason = classifyGlabFailure({
    stdout: typeof failure?.stdout === "string" ? failure.stdout : "",
    stderr: typeof failure?.stderr === "string" ? failure.stderr : String(failure?.message ?? ""),
    code: typeof failure?.code === "number" || typeof failure?.code === "string" ? failure.code : 1,
    timedOut: failure?.killed === true || typeof failure?.signal === "string",
  });
  const words: Record<string, string> = {
    forge_cli_missing: "GitLab issue access requires glab in this session's context",
    forge_unauthenticated: `glab in this session's context is not signed in to GitLab at ${host}`,
    forge_unreachable: `GitLab at ${host} could not be reached`,
    forge_rate_limited: `GitLab at ${host} rate-limited this glab login`,
    forge_not_found: "GitLab has no such project, issue or merge request, or this glab login cannot see it",
  };
  return words[reason] ?? "GitLab could not provide complete issue evidence";
}

/** One `glab api` read, parsed. Failures become `fail(sentence)`. */
async function glabRead(run: Run, host: string, path: string, fail: (message: string) => Error): Promise<unknown> {
  let stdout: string;
  try {
    stdout = await run("glab", ["api", path, "--hostname", host]);
  } catch (error) {
    throw fail(glabFailure(error, host));
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw fail("GitLab returned incomplete issue evidence");
  }
}

export interface GitlabProject {
  host: string;
  /** GitLab's own `path_with_namespace`. */
  project: string;
  /** `${host}/${project}`, the campaign repository. */
  repository: string;
  encoded: string;
  id: number;
  webUrl: string;
  defaultBranch: string | null;
}

/** Read the origin's project and prove it is the same project, at the host the origin names. */
export async function readGitlabProject(run: Run, origin: { host: string; project: string }, fail: (message: string) => Error): Promise<GitlabProject> {
  const encoded = encodeURIComponent(origin.project);
  const raw = record(await glabRead(run, origin.host, `projects/${encoded}`, fail), () => fail("GitLab returned incomplete project evidence"));
  const path = raw.path_with_namespace;
  if (typeof path !== "string" || path.toLowerCase() !== origin.project.toLowerCase() || !Number.isSafeInteger(raw.id) || (raw.id as number) < 1 ||
      (raw.web_url !== `https://${origin.host}/${path}` && raw.web_url !== `http://${origin.host}/${path}`) ||
      (raw.default_branch !== null && raw.default_branch !== undefined && (typeof raw.default_branch !== "string" || !raw.default_branch))) {
    throw fail("GitLab project identity is invalid");
  }
  const repository = `${origin.host}/${path}`;
  if (campaignRepositoryLocation(repository)?.forge !== "gitlab") throw fail("GitLab project identity is invalid");
  return { host: origin.host, project: path, repository, encoded: encodeURIComponent(path), id: raw.id as number,
    webUrl: raw.web_url as string, defaultBranch: typeof raw.default_branch === "string" ? raw.default_branch : null };
}

export interface GitlabIssue {
  id: number;
  iid: number;
  title: string;
  description: string;
  state: "OPEN" | "CLOSED";
  url: string;
  updatedAt: string;
  assignees: string[];
  labels: string[];
}

/** Read one issue of `project`, proving its number, project and web address. */
export async function readGitlabIssue(run: Run, project: GitlabProject, iid: number, fail: (message: string) => Error): Promise<GitlabIssue> {
  const invalid = () => fail("GitLab issue identity is invalid");
  const raw = record(await glabRead(run, project.host, `projects/${project.encoded}/issues/${iid}`, fail), invalid);
  const url = `${project.webUrl}/-/issues/${iid}`;
  const state = raw.state === "opened" ? "OPEN" : raw.state === "closed" ? "CLOSED" : null;
  if (raw.iid !== iid || !Number.isSafeInteger(raw.id) || raw.project_id !== project.id || raw.web_url !== url ||
      !campaignIssueForgeUrl(url, project.repository, "issue", iid) || !state ||
      typeof raw.title !== "string" || typeof raw.updated_at !== "string" ||
      (typeof raw.description !== "string" && raw.description !== null) ||
      !Array.isArray(raw.assignees) || raw.assignees.length > PAGE || !Array.isArray(raw.labels) || raw.labels.length > PAGE) throw invalid();
  const assignees = raw.assignees.map((item) => {
    const username = record(item, invalid).username;
    if (typeof username !== "string") throw invalid();
    return username;
  }).sort();
  const labels = raw.labels.map((label) => {
    if (typeof label !== "string") throw invalid();
    return label;
  }).sort();
  return { id: raw.id as number, iid, title: raw.title, description: raw.description ?? "", state, url,
    updatedAt: raw.updated_at, assignees, labels };
}

const closureError = (message: string) => new IssueClosureInspectionError(message);

async function boundedList(run: Run, project: GitlabProject, path: string): Promise<unknown[]> {
  const list = await glabRead(run, project.host, path, closureError);
  if (!Array.isArray(list)) throw closureError("GitLab returned incomplete issue evidence");
  if (list.length >= PAGE) throw closureError("Issue closure requires complete evidence; GitLab's bounded inspection limit was exceeded");
  return list;
}

type Relevant = { number: number; title: string; url: string; headSha: string; body: string; updatedAt: string };

/** The GitLab half of `inspectGithubIssueClosure`, with the same result shape and digest. */
export async function inspectGitlabIssueClosure(
  issue: number,
  run: Run,
  origin: { host: string; project: string },
  deliveryPullRequests?: Array<{ number: number; headSha: string }>,
): Promise<GithubIssueClosureInspection> {
  const project = await readGitlabProject(run, origin, closureError);
  const target = await readGitlabIssue(run, project, issue, closureError);
  const base = `projects/${project.encoded}`;
  // Merge requests GitLab links to the issue, those that close it on merge, and every open merge
  // request of the project, of which only those naming the issue count.
  const related = await boundedList(run, project, `${base}/issues/${issue}/related_merge_requests?per_page=${PAGE}`);
  const closing = await boundedList(run, project, `${base}/issues/${issue}/closed_by?per_page=${PAGE}`);
  const open = await boundedList(run, project, `${base}/merge_requests?state=opened&per_page=${PAGE}`);
  const invalidMr = () => closureError("GitLab merge-request evidence is invalid");
  const evidence = (raw: unknown): Relevant | null => {
    const mr = record(raw, invalidMr);
    // Other projects' merge requests and closed or merged ones are not conflict evidence.
    if (mr.state !== "opened" || mr.project_id !== project.id) return null;
    if (!Number.isSafeInteger(mr.iid) || (mr.iid as number) < 1 || mr.web_url !== `${project.webUrl}/-/merge_requests/${mr.iid}` ||
        typeof mr.sha !== "string" || !SHA.test(mr.sha) || typeof mr.title !== "string" ||
        (typeof mr.description !== "string" && mr.description !== null) || typeof mr.updated_at !== "string") throw invalidMr();
    return { number: mr.iid as number, title: mr.title, url: mr.web_url as string, headSha: mr.sha,
      body: (mr.description ?? "") as string, updatedAt: mr.updated_at };
  };
  const mention = new RegExp(`(?:^|[^A-Za-z0-9_/])#${issue}(?![0-9])`, "u");
  const relevant = new Map<number, Relevant>();
  const listed = new Map<number, Relevant>();
  for (const raw of open) {
    const mr = evidence(raw);
    if (!mr) continue;
    listed.set(mr.number, mr);
    const text = `${mr.title}\n${mr.body}`;
    if (mention.test(text) || text.includes(target.url)) relevant.set(mr.number, mr);
  }
  for (const raw of [...related, ...closing]) {
    const mr = evidence(raw);
    // The project list's row is preferred, so one merge request has one digest input.
    if (mr && !relevant.has(mr.number)) relevant.set(mr.number, listed.get(mr.number) ?? mr);
  }
  const sorted = [...relevant.values()].sort((a, b) => a.number - b.number);
  const delivery: NonNullable<GithubIssueClosureInspection["delivery"]> = [];
  if (deliveryPullRequests !== undefined) {
    if (!deliveryPullRequests.length || deliveryPullRequests.length > 100) throw closureError("Completed closure requires bounded actual merged merge-request evidence");
    if (!project.defaultBranch) throw closureError("GitLab project has no default branch to prove delivery against");
    for (const ref of deliveryPullRequests) {
      if (!Number.isSafeInteger(ref.number) || ref.number < 1 || !SHA.test(ref.headSha)) throw closureError("Invalid delivered merge-request reference");
      const notMerged = () => closureError("Delivery merge request has not actually merged at the verified head into the GitLab default branch");
      const mr = record(await glabRead(run, project.host, `${base}/merge_requests/${ref.number}`, closureError), notMerged);
      const mergeCommitSha = mr.merge_commit_sha ?? mr.squash_commit_sha;
      if (mr.iid !== ref.number || mr.state !== "merged" || mr.sha !== ref.headSha || mr.target_branch !== project.defaultBranch ||
          mr.target_project_id !== project.id || typeof mergeCommitSha !== "string" || !SHA.test(mergeCommitSha)) throw notMerged();
      const mergeBase = record(await glabRead(run, project.host,
        `${base}/repository/merge_base?refs[]=${mergeCommitSha}&refs[]=${encodeURIComponent(project.defaultBranch)}`, closureError),
      () => closureError("Delivery merge is not contained in the GitLab default branch"));
      if (mergeBase.id !== mergeCommitSha) throw closureError("Delivery merge is not contained in the GitLab default branch");
      delivery.push({ number: ref.number, headSha: ref.headSha, mergeCommitSha });
    }
  }
  const forgeDigest = createHash("sha256").update(JSON.stringify({
    repository: project.repository, issue, id: String(target.id), title: target.title, body: target.description,
    state: target.state, updatedAt: target.updatedAt, assignees: target.assignees, labels: target.labels, relevant: sorted,
  })).digest("hex");
  return { repository: project.repository, issue, title: target.title, url: target.url, state: target.state, forgeDigest,
    openPullRequests: sorted.map(({ number, title, url, headSha }) => ({ number, title, url, headSha })),
    ...(deliveryPullRequests === undefined ? {} : { delivery }) };
}

/** The text a closure posts as a note before closing, or undefined for none. A not-planned closure
 * always states its reason, since GitLab issues have no close reason of their own. */
export function gitlabClosureNote(snapshot: Pick<GithubIssueClosureSnapshot, "reason" | "explanation" | "comment">): string | undefined {
  if (snapshot.reason === "not_planned") {
    return `Closed as not planned: ${snapshot.explanation}${snapshot.comment === undefined ? "" : `\n\n${snapshot.comment}`}`;
  }
  return snapshot.comment;
}

/** The GitLab mutation: the note (if any), then the close. Each runs once; a failure propagates to
 * the caller, which reports the outcome as uncertain and never retries. */
export async function closeGitlabIssue(run: Run, snapshot: GithubIssueClosureSnapshot): Promise<void> {
  const location = campaignRepositoryLocation(snapshot.repository);
  if (location?.forge !== "gitlab") throw new IssueClosureInspectionError("GitLab issue closure requires a GitLab repository");
  const host = location.host.toLowerCase();
  const path = `projects/${encodeURIComponent(location.project)}/issues/${snapshot.issue}`;
  const note = gitlabClosureNote(snapshot);
  if (note !== undefined) await run("glab", ["api", "--method", "POST", `${path}/notes`, "--hostname", host, "-f", `body=${note}`]);
  await run("glab", ["api", "--method", "PUT", path, "--hostname", host, "-f", "state_event=close"]);
}
