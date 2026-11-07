/**
 * Merge closure watch (#4323, protocol v328; see `@wollipog/protocol` merge-closure-watch). After a
 * `pr_merge` decision is consumed, the control plane asks this runner what the pull request (GitHub)
 * or merge request (GitLab) would close, in whatever state it is now, and, when that changed while it
 * was still open, to take it out of the merge queue or train.
 *
 * The read is the one the request and arm checks use (`inspectPullRequestClosures`,
 * `inspectMergeRequestClosures`), so a closure counts here exactly when it counts there. The
 * dequeue first reads the pull request again and acts only while it is open at the approved head.
 * Every failure is a fixed sentence or outcome, never forge output.
 */
import type { MergeClosureDequeueOutcome, MergeClosureWatchPullRequestState, PullRequestClosingReferenceCheck } from "@wollipog/protocol";
import { campaignRepositoryLocation } from "@wollipog/protocol";
import { classifyGhFailure, type GhRunner } from "./campaign-forge-status.js";
import { classifyGlabFailure, type GlabRunner } from "./campaign-gitlab-status.js";
import { inspectPullRequestClosures } from "./github-merge-preflight.js";
import { inspectMergeRequestClosures } from "./gitlab-merge-closures.js";

const GITHUB_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
const SHA = /^[0-9a-f]{40}$/u;

export type MergeClosureRead =
  | { ok: true; state: MergeClosureWatchPullRequestState; headSha: string; check: PullRequestClosingReferenceCheck }
  | { ok: false; reason: string };

export interface MergeClosureForges {
  gh: GhRunner;
  glab: GlabRunner;
}

interface WatchTarget {
  repository: string;
  pullRequest: number;
  headSha: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function gitlabTarget(repository: string): boolean {
  return campaignRepositoryLocation(repository)?.forge === "gitlab";
}

function validTarget(target: WatchTarget): boolean {
  return typeof target.repository === "string" && Number.isSafeInteger(target.pullRequest) && target.pullRequest > 0 &&
    typeof target.headSha === "string" && SHA.test(target.headSha) &&
    (gitlabTarget(target.repository) || GITHUB_REPOSITORY.test(target.repository));
}

/** What the pull request or merge request would close now, in any state. */
export async function readMergeClosures(target: WatchTarget, forges: MergeClosureForges, now: () => number = Date.now): Promise<MergeClosureRead> {
  if (!validTarget(target)) return { ok: false, reason: "The decision does not name a pull request or merge request this runner can check." };
  if (gitlabTarget(target.repository)) {
    const inspected = await inspectMergeRequestClosures(target.repository, target.pullRequest, forges.glab);
    if (!inspected.ok) return inspected;
    // `locked` is GitLab merging it right now: not landed yet.
    const state = inspected.state === "merged" ? "merged" : inspected.state === "closed" ? "closed" : "open";
    return { ok: true, state, headSha: inspected.headSha, check: { checkedAt: now(), closures: inspected.closures } };
  }
  const inspected = await inspectPullRequestClosures(target.repository, target.pullRequest, forges.gh);
  if (!inspected.ok) return inspected;
  const state = inspected.state === "MERGED" ? "merged" : inspected.state === "CLOSED" ? "closed" : "open";
  return { ok: true, state, headSha: inspected.headSha, check: { checkedAt: now(), closures: inspected.closures } };
}

/** Take the pull request or merge request out of the merge queue or train, and off auto-merge,
 * while it is open at the approved head. */
export async function dequeueMerge(target: WatchTarget, forges: MergeClosureForges): Promise<{ outcome: MergeClosureDequeueOutcome; reason?: string }> {
  if (!validTarget(target)) return { outcome: "refused", reason: "The decision does not name a pull request or merge request this runner can dequeue." };
  return gitlabTarget(target.repository) ? dequeueMergeRequest(target, forges.glab) : dequeuePullRequest(target, forges.gh);
}

const QUEUE_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ nameWithOwner
    pullRequest(number:$number){ id number state headRefOid mergeQueueEntry{ id } autoMergeRequest{ enabledAt } }
  }
}`;

const DEQUEUE_MUTATION = `mutation($id:ID!){ dequeuePullRequest(input:{id:$id}){ mergeQueueEntry{ id } } }`;
const DISABLE_AUTO_MERGE_MUTATION = `mutation($id:ID!){ disablePullRequestAutoMerge(input:{pullRequestId:$id}){ pullRequest{ id } } }`;

type QueueRead =
  | { ok: true; id: string; state: string; headSha: string; queued: boolean; autoMerge: boolean }
  | { ok: false; reason: string };

async function readQueue(target: WatchTarget, gh: GhRunner): Promise<QueueRead> {
  const [owner, name] = target.repository.split("/");
  const outcome = await gh(["api", "graphql", "--hostname", "github.com", "-f", `query=${QUEUE_QUERY}`,
    "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${target.pullRequest}`]);
  if (outcome.code !== null) {
    const failure = classifyGhFailure(outcome);
    return { ok: false, reason: failure === "forge_unauthenticated" ? "gh in this session's context is not signed in to github.com."
      : failure === "forge_cli_missing" ? "gh is not installed in this session's context." : "GitHub could not be read for the pull request." };
  }
  try {
    const repository = record(record(record(JSON.parse(outcome.stdout))?.data)?.repository);
    const pr = record(repository?.pullRequest);
    if (repository && typeof repository.nameWithOwner === "string" && repository.nameWithOwner.toLowerCase() === target.repository.toLowerCase() &&
        pr && pr.number === target.pullRequest && typeof pr.id === "string" && typeof pr.state === "string" && typeof pr.headRefOid === "string") {
      return { ok: true, id: pr.id, state: pr.state, headSha: pr.headRefOid, queued: record(pr.mergeQueueEntry) !== null,
        autoMerge: record(pr.autoMergeRequest) !== null };
    }
  } catch { /* falls through */ }
  return { ok: false, reason: "GitHub returned an unexpected answer for the pull request." };
}

function settled(read: Extract<QueueRead, { ok: true }>, headSha: string): MergeClosureDequeueOutcome | null {
  if (read.state === "MERGED") return "merged";
  if (read.state !== "OPEN") return "closed";
  if (read.headSha !== headSha) return "head_changed";
  return null;
}

async function dequeuePullRequest(target: WatchTarget, gh: GhRunner): Promise<{ outcome: MergeClosureDequeueOutcome; reason?: string }> {
  const before = await readQueue(target, gh);
  if (!before.ok) return { outcome: "refused", reason: before.reason };
  const done = settled(before, target.headSha);
  if (done) return { outcome: done };
  if (!before.queued && !before.autoMerge) return { outcome: "not_queued" };
  let sent = false;
  for (const [wanted, mutation] of [[before.queued, DEQUEUE_MUTATION], [before.autoMerge, DISABLE_AUTO_MERGE_MUTATION]] as const) {
    if (!wanted) continue;
    sent = true;
    await gh(["api", "graphql", "--hostname", "github.com", "-f", `query=${mutation}`, "-f", `id=${before.id}`]);
  }
  // Whatever the mutations printed, the pull request itself says whether it left the queue.
  const after = await readQueue(target, gh);
  if (!after.ok) return { outcome: sent ? "uncertain" : "refused", reason: after.reason };
  const now = settled(after, target.headSha);
  if (now) return { outcome: now };
  if (!after.queued && !after.autoMerge) return { outcome: "dequeued" };
  return { outcome: "refused", reason: "GitHub kept the pull request in the merge queue." };
}

type MergeRequestRead =
  | { ok: true; state: string; headSha: string; autoMerge: boolean }
  | { ok: false; reason: string };

async function readMergeRequest(target: WatchTarget, glab: GlabRunner, host: string, path: string): Promise<MergeRequestRead> {
  const outcome = await glab(["api", path, "--hostname", host]);
  if (outcome.code !== null) {
    const failure = classifyGlabFailure(outcome);
    return { ok: false, reason: failure === "forge_unauthenticated" ? `glab in this session's context is not signed in to ${host}.`
      : failure === "forge_cli_missing" ? "glab is not installed in this session's context." : "GitLab could not be read for the merge request." };
  }
  try {
    const mr = record(JSON.parse(outcome.stdout));
    if (mr && mr.iid === target.pullRequest && typeof mr.state === "string" && typeof mr.sha === "string") {
      // A merge train, like "merge when the pipeline succeeds", is GitLab's auto-merge.
      return { ok: true, state: mr.state, headSha: mr.sha.toLowerCase(), autoMerge: mr.merge_when_pipeline_succeeds === true || mr.auto_merge_enabled === true };
    }
  } catch { /* falls through */ }
  return { ok: false, reason: "GitLab returned an unexpected answer for the merge request." };
}

function settledMergeRequest(read: Extract<MergeRequestRead, { ok: true }>, headSha: string): MergeClosureDequeueOutcome | null {
  if (read.state === "merged") return "merged";
  if (read.state === "closed") return "closed";
  if (read.headSha !== headSha) return "head_changed";
  return null;
}

async function dequeueMergeRequest(target: WatchTarget, glab: GlabRunner): Promise<{ outcome: MergeClosureDequeueOutcome; reason?: string }> {
  const location = campaignRepositoryLocation(target.repository);
  if (location?.forge !== "gitlab") return { outcome: "refused", reason: "The decision does not name a GitLab merge request this runner can dequeue." };
  const host = location.host.toLowerCase();
  const path = `projects/${encodeURIComponent(location.project)}/merge_requests/${target.pullRequest}`;
  const before = await readMergeRequest(target, glab, host, path);
  if (!before.ok) return { outcome: "refused", reason: before.reason };
  const done = settledMergeRequest(before, target.headSha);
  if (done) return { outcome: done };
  if (!before.autoMerge) return { outcome: "not_queued" };
  // Cancelling the merge request's auto-merge also takes it off its merge train.
  await glab(["api", "--method", "POST", `${path}/cancel_merge_when_pipeline_succeeds`, "--hostname", host]);
  const after = await readMergeRequest(target, glab, host, path);
  if (!after.ok) return { outcome: "uncertain", reason: after.reason };
  const now = settledMergeRequest(after, target.headSha);
  if (now) return { outcome: now };
  return after.autoMerge ? { outcome: "refused", reason: "GitLab kept the merge request on its merge train." } : { outcome: "dequeued" };
}
