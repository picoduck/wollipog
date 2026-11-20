/**
 * Wollipog-performed forge actions (#4067, protocol v284; see `@wollipog/protocol`
 * forge-decision-action). The control plane has already checked the approval, its authority and
 * its snapshot; this module performs exactly the one approved action through the child session's
 * own `gh` login, after re-reading the forge, and reports a fixed outcome. Nothing `gh` prints
 * crosses back: every failure is a fixed code and sentence.
 *
 * Only `gh api` against an explicit `owner/repo` is used. No `git` runs in the session's worktree,
 * so nothing the agent can write there (hooks, `core.sshCommand`, credential helpers, `insteadOf`
 * rewrites, a changed `origin`) is ever executed or consulted by the runner on its behalf.
 *
 * - A branch deletion proves the pull request merged the approved head from the approved branch in
 *   the same repository with the approved merge commit, that no open pull request targets the
 *   branch, and that the remote tip is still the approved head. It then deletes the ref through
 *   GitHub's `updateRefs` mutation with `beforeOid` set to that head, so GitHub itself refuses the
 *   deletion if the tip moved after the read.
 * - An enqueue proves the pull request is open at the approved head, then runs the canonical
 *   `gh pr merge <url> --squash --match-head-commit <sha>`. A pull request already in the queue,
 *   or already merged at that head, is the approved action having taken effect.
 * - A publication (#4119) runs on the runner of a Location of the approved repository, with that
 *   runner's own login and no session of its own: `SessionManager` checks the Location's origin
 *   names that repository, then this module creates the issue behind a durable fence.
 */
import type {
  ForgeDecisionAction,
  ForgeDecisionActionOutcome,
  ForgeDecisionActionRefusalReason,
} from "@wollipog/protocol";
import { createHash } from "node:crypto";
import {
  forgeActionBranchName, normalizeCiRerunTarget, normalizeReleaseAssets, normalizeReleaseDecision,
  releaseDecisionPayloadBytes, releasePublishMutation, releaseTagPayload,
  type ReleaseForgeAction, type ReleasePublishDecisionSnapshot,
} from "@wollipog/protocol";
import { classifyGhFailure, type GhRunner } from "./campaign-forge-status.js";

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const ZERO_OID = "0".repeat(40);

export interface ForgeDecisionActionResult {
  outcome: ForgeDecisionActionOutcome;
  refusal?: { reason: ForgeDecisionActionRefusalReason; summary: string };
  temporaryBranchProof?: { defaultBranch: string; defaultHeadSha: string };
}

const refused = (reason: ForgeDecisionActionRefusalReason, summary: string): ForgeDecisionActionResult =>
  ({ outcome: "refused", refusal: { reason, summary } });

const UNAVAILABLE_WORDS: Record<string, string> = {
  forge_cli_missing: "gh is not installed in this session's context.",
  forge_unauthenticated: "gh in this session's context is not signed in to github.com.",
  forge_unreachable: "github.com could not be reached.",
  forge_rate_limited: "github.com rate-limited this gh login.",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const CI_API = ["api", "--hostname", "github.com"];

async function readCiTarget(gh: GhRunner, path: string): Promise<Record<string, unknown> | null> {
  const result = await gh(CI_API.concat("--method", "GET", path));
  if (result.code !== null || result.timedOut) return null;
  try { return record(JSON.parse(result.stdout)); } catch { return null; }
}

async function readCiJob(
  gh: GhRunner, target: NonNullable<ReturnType<typeof normalizeCiRerunTarget>>,
): Promise<{ job: Record<string, unknown> } | { refusal: ForgeDecisionActionResult }> {
  const { repository, runId, headSha, jobId, attempt } = target;
  const job = await readCiTarget(gh, `repos/${repository}/actions/jobs/${jobId}`);
  if (!job) return { refusal: refused("forge_unavailable", "GitHub could not verify the approved CI job.") };
  if (job.id !== jobId || job.run_id !== runId || job.run_attempt !== attempt || job.head_sha !== headSha ||
      typeof job.html_url !== "string" ||
      job.html_url.toLowerCase() !== `https://github.com/${repository}/actions/runs/${runId}/job/${jobId}`) {
    return { refusal: refused("ci_target_mismatch", "The CI job does not match the approved repository, run, head or attempt.") };
  }
  return { job };
}

export async function inspectCiRerunJob(
  action: Extract<ForgeDecisionAction, { kind: "ci_rerun_inspect_job" }>, gh: GhRunner,
): Promise<ForgeDecisionActionResult & { jobName?: string }> {
  const target = normalizeCiRerunTarget(action);
  if (!target || target.jobId === undefined) return refused("ci_target_mismatch", "The CI job target is invalid.");
  const result = await readCiJob(gh, target);
  if ("refusal" in result) return result.refusal;
  const name = typeof result.job.name === "string" ? result.job.name.trim() : "";
  return { outcome: "ci_job_inspected", ...(name && name.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(name) ? { jobName: name } : {}) };
}

export async function executeCiRerun(
  action: Extract<ForgeDecisionAction, { kind: "ci_rerun" }>,
  gh: GhRunner,
  writeFence: { begin: () => boolean; release: () => void },
): Promise<ForgeDecisionActionResult> {
  const target = normalizeCiRerunTarget(action);
  if (!target) return refused("ci_target_mismatch", "The approved CI target is invalid.");
  const { repository, runId, jobId, headSha, attempt } = target;
  const runs = `repos/${repository}/actions/runs/${runId}`;
  const jobs = `repos/${repository}/actions/jobs/${jobId}`;
  if (jobId !== undefined) {
    const result = await readCiJob(gh, target);
    if ("refusal" in result) return result.refusal;
    if (result.job.status !== "completed") return refused("forge_refused", "The CI job is not complete.");
  }
  // Read the run last. GitHub's write is addressed by immutable run or job ID and does not
  // accept an attempt precondition. The fence excludes other Wollipog writes to this attempt.
  const run = await readCiTarget(gh, runs);
  if (!run) return refused("forge_unavailable", "GitHub could not verify the approved CI run.");
  const reportedRepository = record(run.repository)?.full_name;
  if (run.id !== runId || run.head_sha !== headSha || run.run_attempt !== attempt ||
      typeof reportedRepository !== "string" || reportedRepository.toLowerCase() !== repository) {
    return refused("ci_target_mismatch", "The CI run does not match the approved repository, run, head or attempt.");
  }
  if (run.status !== "completed") return refused("forge_refused", "The CI run is not complete.");
  if (!writeFence.begin()) return { outcome: "uncertain" };
  const written = await gh(CI_API.concat("--include", "--method", "POST", `${jobId === undefined ? runs : jobs}/rerun`));
  if (written.timedOut) return { outcome: "uncertain" };
  const status = Number(/^HTTP\/\S+ (\d{3})\b/u.exec(written.stdout)?.[1]);
  if (written.code === null && status === 201) return { outcome: "rerun_requested" };
  if ([400, 401, 403, 404, 409, 422, 429].includes(status)) {
    writeFence.release();
    return refused("forge_refused", "GitHub refused the CI rerun.");
  }
  return { outcome: "uncertain" };
}

const RELEASE_REF_QUERY = `query($owner:String!,$name:String!,$ref:String!){
  repository(owner:$owner,name:$name){ nameWithOwner defaultBranchRef{target{oid}}
    ref(qualifiedName:$ref){target{oid __typename}} } }`;

const releaseStale = (summary: string) => refused("release_target_mismatch", summary);
const releaseUnavailable = () => refused("forge_unavailable", "GitHub could not verify the release state.");

function stableBefore(previous: string, next: string): boolean {
  const left = previous.slice(1).split(".").map(Number);
  const right = next.slice(1).split(".").map(Number);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index]! < right[index]!;
  }
  return false;
}

async function observedPublishPreconditions(target: ReleasePublishDecisionSnapshot, gh: GhRunner): Promise<ForgeDecisionActionResult | null> {
  const { repository, releaseId, releasePayload, commitSha, tag } = target;
  const root = `repos/${repository}`;
  if (releasePayload.workflow) {
    const { runId, attempt } = releasePayload.workflow;
    const run = await readCiTarget(gh, `${root}/actions/runs/${runId}`);
    if (!run) return releaseUnavailable();
    const runRepository = record(run.repository)?.full_name;
    if (run.id !== runId || run.run_attempt !== attempt || run.head_sha !== commitSha || run.head_branch !== tag ||
        run.status !== "completed" || run.conclusion !== "success" || typeof runRepository !== "string" ||
        runRepository.toLowerCase() !== repository) return releaseStale("The approved release workflow attempt changed.");
  }
  const latest = await gh(CI_API.concat(`${root}/releases/latest`));
  const expected = releasePayload.previousStable;
  if (latest.code !== null) {
    if (latest.timedOut || !/\(HTTP 404\)/u.test(latest.stderr)) return releaseUnavailable();
    if (expected) return releaseStale("The latest stable release no longer matches the approval.");
  } else {
    const found = record(parseJsonOrNull(latest.stdout));
    if (!found) return releaseUnavailable();
    if (!expected || found.id !== expected.id || found.tag_name !== expected.tag || found.draft !== false ||
        found.prerelease !== false || !stableBefore(expected.tag, tag)) {
      return releaseStale("The latest stable release changed or is newer than the approved release.");
    }
  }
  const rows: unknown[] = [];
  for (const page of [1, 2]) {
    const result = await gh(CI_API.concat(`${root}/releases/${releaseId}/assets?per_page=100&page=${page}`));
    const assets = result.code === null && !result.timedOut ? parseJsonOrNull(result.stdout) : null;
    if (!Array.isArray(assets) || assets.length > 100) return releaseUnavailable();
    rows.push(...assets);
    if (assets.length < 100) break;
  }
  const inventory = normalizeReleaseAssets(rows);
  if (!inventory || JSON.stringify(inventory) !== JSON.stringify(releasePayload.assets)) {
    return releaseStale("The approved release asset identities or digests changed.");
  }
  const draft = await readCiTarget(gh, `${root}/releases/${releaseId}`);
  if (!draft) return releaseUnavailable();
  if (draft.id !== releaseId || draft.tag_name !== tag || draft.draft !== true || draft.prerelease !== false ||
      draft.name !== releasePayload.draft.name || draft.body !== releasePayload.draft.body ||
      draft.target_commitish !== releasePayload.draft.targetCommitish) {
    return releaseStale("The approved draft or its metadata changed.");
  }
  return null;
}

/** GitHub has no conditional release update. Check the draft, inventory and tag immediately before
 * the one write and fence the target across occurrences. Never retry a write with an unclear result. */
export async function executeReleaseDecision(
  action: ReleaseForgeAction,
  runGh: GhRunner,
  writeFence: { begin: () => boolean; release: () => void },
): Promise<ForgeDecisionActionResult> {
  const { kind, ...input } = action;
  const target = normalizeReleaseDecision({ ...input, category: kind });
  if (!target || createHash("sha256").update(releaseDecisionPayloadBytes(target)).digest("hex") !== target.releasePayloadDigest) {
    return releaseStale("The release payload does not match its approved digest.");
  }
  // Leave time to report the outcome before the control plane's dispatch timeout.
  const deadline = AbortSignal.timeout(90_000);
  const gh: GhRunner = (args, _signal, stdin) => runGh(args, deadline, stdin);
  const { repository, tag, commitSha } = target;
  const root = `repos/${repository}`;
  const ref = `refs/tags/${tag}`;
  const readRef = () => readRepository(gh, RELEASE_REF_QUERY, repository, [["ref", ref]]);
  let endpoint: string;
  let method: string;
  let payload: object;
  if (target.category === "release_tag") {
    const before = await readRef();
    if ("refusal" in before) return before.refusal;
    const defaultTip = record(record(before.data.defaultBranchRef)?.target)?.oid;
    if (typeof defaultTip !== "string" || !SHA.test(defaultTip) || before.data.ref === undefined) return releaseUnavailable();
    if (before.data.ref !== null) return releaseStale("The approved release tag already exists.");
    const contained = await readCiTarget(gh, `${root}/compare/${commitSha}...${defaultTip}?per_page=1`);
    if (!contained) return releaseUnavailable();
    if ((contained.status !== "ahead" && contained.status !== "identical") || contained.behind_by !== 0 ||
        record(contained.merge_base_commit)?.sha !== commitSha) {
      return releaseStale("The approved commit is no longer on the default branch.");
    }
    const current = await readRef();
    if ("refusal" in current) return current.refusal;
    if (current.data.ref !== null || record(record(current.data.defaultBranchRef)?.target)?.oid !== defaultTip) {
      return releaseStale("The release tag or default branch changed during verification.");
    }
    endpoint = `${root}/git/refs`;
    method = "POST";
    payload = releaseTagPayload(target);
  } else {
    const problem = await observedPublishPreconditions(target, gh);
    if (problem) return problem;
    const current = await readRef();
    if ("refusal" in current) return current.refusal;
    let tagObject = record(record(current.data.ref)?.target);
    if (tagObject?.__typename === "Tag") {
      for (let depth = 0; depth < 5 && tagObject?.__typename === "Tag"; depth++) {
        if (typeof tagObject.oid !== "string" || !SHA.test(tagObject.oid)) return releaseUnavailable();
        const annotated = await readCiTarget(gh, `${root}/git/tags/${tagObject.oid}`);
        const object = record(annotated?.object);
        if (!object) return releaseUnavailable();
        tagObject = { oid: object.sha, __typename: object.type === "tag" ? "Tag" : object.type === "commit" ? "Commit" : "" };
      }
    }
    if (tagObject?.__typename !== "Commit" || tagObject.oid !== commitSha) {
      return releaseStale("The release tag no longer points to the approved commit.");
    }
    endpoint = `${root}/releases/${target.releaseId}`;
    method = "PATCH";
    payload = releasePublishMutation(target);
  }
  if (deadline.aborted) return releaseUnavailable();
  if (!writeFence.begin()) return { outcome: "uncertain" };
  const written = await gh(CI_API.concat("--method", method, endpoint, "--input", "-"), undefined, JSON.stringify(payload));
  if (written.timedOut) return { outcome: "uncertain" };
  if (written.code === null) {
    const result = record(parseJsonOrNull(written.stdout));
    if (target.category === "release_tag" && result?.ref === ref && record(result.object)?.sha === commitSha &&
        record(result.object)?.type === "commit") return { outcome: "release_tagged" };
    if (target.category === "release_publish" && result?.id === target.releaseId && result.tag_name === tag &&
        result.draft === false && result.prerelease === false && result.name === target.releasePayload.name &&
        result.body === target.releasePayload.body && typeof result.published_at === "string" && result.published_at) {
      return { outcome: "release_published" };
    }
    return { outcome: "uncertain" };
  }
  if (/\(HTTP (?:400|401|403|404|409|422|429)\)/u.test(written.stderr) && !/connection|timeout|EOF/u.test(written.stderr)) {
    writeFence.release();
    return refused("forge_refused", "GitHub refused the approved release write.");
  }
  return { outcome: "uncertain" };
}

/** One GraphQL read; the repository object, or a refusal. */
async function readRepository(
  gh: GhRunner, query: string, repository: string, variables: Array<[string, string]>,
): Promise<{ data: Record<string, unknown> } | { refusal: ForgeDecisionActionResult }> {
  const [owner, name] = repository.split("/");
  const args = ["api", "graphql", "--hostname", "github.com", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
  for (const [key, value] of variables) args.push(key === "number" ? "-F" : "-f", `${key}=${value}`);
  const outcome = await gh(args);
  if (outcome.code !== null) {
    return { refusal: refused("forge_unavailable", UNAVAILABLE_WORDS[classifyGhFailure(outcome)] ?? "GitHub returned an error.") };
  }
  try {
    const response = record(JSON.parse(outcome.stdout));
    const data = response && !response.errors ? record(record(response.data)?.repository) : null;
    if (data && typeof data.nameWithOwner === "string" && data.nameWithOwner.toLowerCase() === repository.toLowerCase()) return { data };
  } catch { /* falls through */ }
  return { refusal: refused("forge_unavailable", "GitHub returned an unexpected answer for the pull request.") };
}

const DELETION_QUERY = `query($owner:String!,$name:String!,$number:Int!,$ref:String!,$branch:String!){
  repository(owner:$owner,name:$name){ id nameWithOwner
    pullRequest(number:$number){ number state headRefName headRefOid isCrossRepository mergeCommit{ oid } }
    ref(qualifiedName:$ref){ target{ oid } }
    pullRequests(states:OPEN, baseRefName:$branch, first:1){ totalCount }
  }
}`;

const DELETION_MUTATION = `mutation($repositoryId:ID!,$ref:GitRefname!,$before:GitObjectID!,$after:GitObjectID!){
  updateRefs(input:{repositoryId:$repositoryId, refUpdates:[{name:$ref, beforeOid:$before, afterOid:$after}]}){ clientMutationId }
}`;

/** Temporary refs are created only from commits already on the remote default branch. Immutable
 * compare endpoints avoid worktree Git configuration and bound the answer to one commit page. */
export async function executeTemporaryBranch(
  action: Extract<ForgeDecisionAction, { kind: "temporary_branch_create" | "temporary_branch_deletion" }>,
  gh: GhRunner,
): Promise<ForgeDecisionActionResult> {
  if (!REPOSITORY.test(action.repository) || !forgeActionBranchName(action.branch) || !SHA.test(action.headSha)) {
    return refused("pull_request_mismatch", "Invalid temporary branch coordinates.");
  }
  const readState = () => readRepository(gh, `query($owner:String!,$name:String!,$ref:String!,$branch:String!){
    repository(owner:$owner,name:$name){ id nameWithOwner defaultBranchRef{ name target{ oid } }
      ref(qualifiedName:$ref){ target{ oid } }
      heads:pullRequests(states:OPEN,headRefName:$branch,first:1){ totalCount }
      bases:pullRequests(states:OPEN,baseRefName:$branch,first:1){ totalCount }
    } }`, action.repository, [["ref", `refs/heads/${action.branch}`], ["branch", action.branch]]);
  const creating = action.kind === "temporary_branch_create";
  const read = await readState();
  if ("refusal" in read) return read.refusal;
  const state = (data: Record<string, unknown>) => ({
    tip: data.ref === null ? null : record(record(data.ref)?.target)?.oid,
    defaultTip: record(record(data.defaultBranchRef)?.target)?.oid,
    defaultName: record(data.defaultBranchRef)?.name,
    heads: record(data.heads)?.totalCount, bases: record(data.bases)?.totalCount,
  });
  const before = state(read.data);
  if (typeof read.data.id !== "string" || !read.data.id || typeof before.defaultTip !== "string" ||
      !SHA.test(before.defaultTip) || typeof before.defaultName !== "string" ||
      (before.tip !== null && (typeof before.tip !== "string" || !SHA.test(before.tip))) ||
      !Number.isSafeInteger(before.heads) || !Number.isSafeInteger(before.bases)) {
    return refused("forge_unavailable", "GitHub returned incomplete temporary branch evidence.");
  }
  if (before.defaultName === action.branch) return refused("pull_request_mismatch", "The default branch is never temporary.");
  if (creating && before.tip !== null) return refused("forge_refused", "The remote ref already exists; no creation receipt was issued.");
  if (!creating && before.tip !== null && before.tip !== action.headSha) return refused("tip_moved", "The temporary branch tip moved; it was left alone.");
  if ((before.heads as number) > 0 || (before.bases as number) > 0) {
    return refused("dependent_pull_request_open", "An open pull request uses this branch as head or base; it was left alone.");
  }
  const compare = await gh(["api", "--hostname", "github.com",
    `repos/${action.repository}/compare/${action.headSha}...${before.defaultTip}?per_page=1`]);
  let contained = false;
  if (compare.code === null && !compare.timedOut) {
    try {
      const result = record(JSON.parse(compare.stdout));
      contained = Boolean(result && (result.status === "ahead" || result.status === "identical") &&
        result.behind_by === 0 && record(result.merge_base_commit)?.sha === action.headSha);
    } catch { /* unreadable evidence refuses */ }
  }
  if (!contained) return refused("forge_unavailable", "The created tip could not be proven contained in the default branch; nothing changed.");
  // Re-read after the compare: a default ref rewrite or PR opened during that read must stop the
  // operation. The final mutation independently pins the temporary ref's exact current tip.
  const fresh = await readState();
  if ("refusal" in fresh) return fresh.refusal;
  const after = state(fresh.data);
  if (fresh.data.id !== read.data.id || after.defaultTip !== before.defaultTip || after.defaultName !== before.defaultName ||
      after.tip !== before.tip || after.heads !== 0 || after.bases !== 0) {
    return refused("tip_moved", "The branch or its dependency evidence changed during verification; nothing changed.");
  }
  if (!creating && before.tip === null) return { outcome: "already_deleted" };
  // beforeOid=zero is create-only: even an existing ref at this SAME tip must refuse. No force,
  // shell Git, credential helper, hook or worktree-controlled origin participates.
  const updated = await gh(["api", "graphql", "--hostname", "github.com", "-f", `query=${DELETION_MUTATION}`,
    "-f", `repositoryId=${read.data.id}`, "-f", `ref=refs/heads/${action.branch}`,
    "-f", `before=${creating ? ZERO_OID : action.headSha}`, "-f", `after=${creating ? action.headSha : ZERO_OID}`]);
  if (updated.code === null && !updated.timedOut) {
    try {
      const result = record(JSON.parse(updated.stdout));
      if (result && !result.errors && record(record(result.data)?.updateRefs)) return creating
        ? { outcome: "published", temporaryBranchProof: { defaultBranch: before.defaultName, defaultHeadSha: before.defaultTip } }
        : { outcome: "deleted" };
    } catch { /* a lost or malformed creation response never mints provenance */ }
  }
  // Never infer creation from a later matching ref: it could have been created by someone else.
  return { outcome: "uncertain" };
}

/** What the branch looks like now: gone, at a tip, or unreadable. */
async function branchTip(gh: GhRunner, action: Extract<ForgeDecisionAction, { kind: "branch_deletion" }>): Promise<string | null | undefined> {
  const read = await readRepository(gh, `query($owner:String!,$name:String!,$ref:String!){
    repository(owner:$owner,name:$name){ nameWithOwner ref(qualifiedName:$ref){ target{ oid } } } }`,
  action.repository, [["ref", `refs/heads/${action.branch}`]]);
  if ("refusal" in read) return undefined;
  if (read.data.ref === null) return null;
  const tip = record(record(read.data.ref)?.target)?.oid;
  return typeof tip === "string" ? tip : undefined;
}

export async function executeBranchDeletion(
  action: Extract<ForgeDecisionAction, { kind: "branch_deletion" }>,
  gh: GhRunner,
): Promise<ForgeDecisionActionResult> {
  if (!REPOSITORY.test(action.repository) || !forgeActionBranchName(action.branch) || !Number.isSafeInteger(action.pullRequest) ||
      action.pullRequest < 1 || !SHA.test(action.headSha) || !SHA.test(action.mergeCommitSha)) {
    return refused("pull_request_mismatch", "The decision does not name a GitHub branch this runner can delete.");
  }
  const ref = `refs/heads/${action.branch}`;
  const read = await readRepository(gh, DELETION_QUERY, action.repository, [
    ["number", String(action.pullRequest)], ["ref", ref], ["branch", action.branch],
  ]);
  if ("refusal" in read) return read.refusal;
  const pr = record(read.data.pullRequest);
  const current = read.data.ref === null ? null : record(read.data.ref);
  const tip = current ? record(current.target)?.oid : null;
  const dependents = record(read.data.pullRequests)?.totalCount;
  if (!pr || pr.number !== action.pullRequest || (current && typeof tip !== "string") || !Number.isSafeInteger(dependents) ||
      typeof read.data.id !== "string" || !read.data.id) {
    return refused("forge_unavailable", "GitHub returned an unexpected answer for the pull request.");
  }
  if (pr.state !== "MERGED" || pr.headRefName !== action.branch || pr.headRefOid !== action.headSha ||
      pr.isCrossRepository !== false || record(pr.mergeCommit)?.oid !== action.mergeCommitSha) {
    return refused("pull_request_mismatch", "The pull request did not merge the approved head from this branch with the approved merge commit.");
  }
  if ((dependents as number) > 0) {
    return refused("dependent_pull_request_open", "An open pull request targets this branch, so it was left alone.");
  }
  if (current === null) return { outcome: "already_deleted" };
  if (tip !== action.headSha) {
    return refused("tip_moved", "The branch tip is no longer the approved merged head, so it was left alone.");
  }
  // GitHub applies `beforeOid` atomically: the deletion happens only while the tip is the head.
  const deleted = await gh(["api", "graphql", "--hostname", "github.com", "-f", `query=${DELETION_MUTATION}`,
    "-f", `repositoryId=${read.data.id}`, "-f", `ref=${ref}`, "-f", `before=${action.headSha}`, "-f", `after=${ZERO_OID}`]);
  if (deleted.timedOut) return { outcome: "uncertain" };
  let accepted = false;
  if (deleted.code === null) {
    try {
      const response = record(JSON.parse(deleted.stdout));
      accepted = Boolean(response && !response.errors && record(record(response.data)?.updateRefs));
    } catch { accepted = false; }
  }
  if (accepted) return { outcome: "deleted" };
  const failure = deleted.code === null ? null : classifyGhFailure(deleted);
  if (failure && UNAVAILABLE_WORDS[failure]) return refused("forge_unavailable", `${UNAVAILABLE_WORDS[failure]} Nothing was deleted.`);
  // GitHub refused the update. Read the branch again to say why, without trusting the error text.
  const after = await branchTip(gh, action);
  if (after === null) return { outcome: "already_deleted" };
  if (typeof after === "string" && after !== action.headSha) {
    return refused("tip_moved", "The branch tip moved before the deletion, so it was left alone.");
  }
  if (after === undefined) return { outcome: "uncertain" };
  return refused("forge_refused", "GitHub refused the deletion (for example, a branch protection rule); nothing was deleted.");
}

const ENQUEUE_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ nameWithOwner
    pullRequest(number:$number){ number state headRefOid mergeQueueEntry{ state } }
  }
}`;

export async function executePullRequestEnqueue(
  action: Extract<ForgeDecisionAction, { kind: "pr_merge_enqueue" }>,
  gh: GhRunner,
): Promise<ForgeDecisionActionResult> {
  return pullRequestEnqueue(action, gh, true);
}

/** A reconciliation read (#4067): the same read as an enqueue, then stop. `already_merged` only for
 * the exact approved head; an open, queued, closed or moved pull request refuses. Never writes. */
export async function observePullRequestMerge(
  action: Extract<ForgeDecisionAction, { kind: "pr_merge_observe" }>,
  gh: GhRunner,
): Promise<ForgeDecisionActionResult> {
  return pullRequestEnqueue(action, gh, false);
}

export async function observePullRequestRetirement(
  action: Extract<ForgeDecisionAction, { kind: "pr_merge_retirement_observe" }>, gh: GhRunner,
): Promise<ForgeDecisionActionResult> {
  return pullRequestEnqueue(action, gh, false, true);
}

async function pullRequestEnqueue(
  action: { repository: string; pullRequest: number; headSha: string },
  gh: GhRunner,
  write: boolean,
  retirement = false,
): Promise<ForgeDecisionActionResult> {
  if (!REPOSITORY.test(action.repository) || !Number.isSafeInteger(action.pullRequest) || action.pullRequest < 1 || !SHA.test(action.headSha)) {
    return refused("pull_request_mismatch", "The decision does not name a GitHub pull request this runner can enqueue.");
  }
  const read = await readRepository(gh, ENQUEUE_QUERY, action.repository, [["number", String(action.pullRequest)]]);
  if ("refusal" in read) return read.refusal;
  const pr = record(read.data.pullRequest);
  if (!pr || pr.number !== action.pullRequest || typeof pr.headRefOid !== "string") {
    return refused("forge_unavailable", "GitHub returned an unexpected answer for the pull request.");
  }
  if (pr.headRefOid !== action.headSha) {
    return refused("pull_request_mismatch", "The pull request's head is no longer the approved head.");
  }
  if (retirement) {
    if (pr.state === "OPEN" && pr.mergeQueueEntry === null) return { outcome: "open_unqueued" };
    return refused("pull_request_mismatch", "Retirement requires an open pull request outside the merge queue.");
  }
  if (pr.state === "MERGED") return { outcome: "already_merged" };
  if (!write) return refused("pull_request_mismatch", "The pull request has not merged; nothing was enqueued.");
  if (pr.state !== "OPEN") return refused("pull_request_mismatch", "The pull request is closed.");
  if (record(pr.mergeQueueEntry)) return { outcome: "already_queued" };
  const url = `https://github.com/${action.repository}/pull/${action.pullRequest}`;
  // The canonical approved command: pinned to the head, never --delete-branch.
  const merged = await gh(["pr", "merge", url, "--squash", "--match-head-commit", action.headSha]);
  if (merged.code === null) return { outcome: "enqueued" };
  if (merged.timedOut) return { outcome: "uncertain" };
  // Only a failure that proves GitHub never accepted the write may be retried. A missing CLI or
  // login fails before any request, and a rate limit or an explicit GitHub refusal is an answer
  // that changed nothing. A transport failure (a reset connection, a 5xx, anything unrecognized)
  // may have followed an accepted enqueue, so it is uncertain and is never replayed.
  const failure = classifyGhFailure(merged);
  if (failure === "forge_cli_missing" || failure === "forge_unauthenticated" || failure === "forge_rate_limited") {
    return refused("forge_unavailable", `${UNAVAILABLE_WORDS[failure]} Nothing was enqueued.`);
  }
  if (failure !== "forge_error") return { outcome: "uncertain" };
  if (/head branch was modified|head commit .*does not match|expected head/iu.test(merged.stderr)) {
    return refused("pull_request_mismatch", "The pull request's head changed before the enqueue.");
  }
  if (/GraphQL: |HTTP 4(?:0[0-9]|2[0-9])\b|not mergeable|is not mergeable|merge queue|required status|protected branch/iu.test(merged.stderr) &&
      !/HTTP 5\d\d|connection|timeout|EOF/iu.test(merged.stderr)) {
    return refused("forge_refused", "GitHub refused the enqueue (for example, the pull request is not mergeable yet); nothing was enqueued.");
  }
  return { outcome: "uncertain" };
}

/** What a publication needs from the runner (#4119): a durable one-attempt fence, its release when
 * GitHub proves it created nothing, and the payload in a file, so the exact body never travels as a
 * command-line argument with that platform's length limit. */
export interface IssuePublicationSteps {
  fence: () => boolean;
  release: () => void;
  withPayloadFile: <T>(payload: string, use: (path: string) => Promise<T>) => Promise<T>;
}

/** Create the approved issue once, through this runner's own `gh` login. The answer must name an
 * issue of the approved repository; anything short of that may have created one, so it is uncertain
 * and never repeated. */
export async function executeIssuePublication(
  action: Extract<ForgeDecisionAction, { kind: "issue_publication" }>,
  gh: GhRunner,
  steps: IssuePublicationSteps,
): Promise<ForgeDecisionActionResult & { issue?: number }> {
  if (!REPOSITORY.test(action.repository) || typeof action.title !== "string" || !action.title || typeof action.body !== "string" ||
      !Array.isArray(action.labels) || action.labels.some((label) => typeof label !== "string")) {
    return refused("repository_mismatch", "The decision does not name an issue this runner can create.");
  }
  // An earlier attempt, even from before a restart, may have created it.
  if (!steps.fence()) return { outcome: "uncertain" };
  const created = await steps.withPayloadFile(JSON.stringify({ title: action.title, body: action.body, labels: action.labels }),
    (path) => gh(["api", "--hostname", "github.com", "-X", "POST", `repos/${action.repository}/issues`, "--input", path]));
  if (created.code === null) {
    const issue = publishedIssueNumber(record(parseJsonOrNull(created.stdout)), action.repository);
    return issue === null ? { outcome: "uncertain" } : { outcome: "published", issue };
  }
  if (created.timedOut) return { outcome: "uncertain" };
  // As for an enqueue: only a failure that proves GitHub accepted nothing leaves the approval to retry.
  const failure = classifyGhFailure(created);
  if (failure === "forge_cli_missing" || failure === "forge_unauthenticated" || failure === "forge_rate_limited") {
    steps.release();
    return refused("forge_unavailable", `${UNAVAILABLE_WORDS[failure]} Nothing was published.`);
  }
  if (failure === "forge_error" && /HTTP 4(?:0[0-9]|1[0-9]|2[0-9])\b/u.test(created.stderr) && !/HTTP 5\d\d|connection|timeout|EOF/iu.test(created.stderr)) {
    steps.release();
    return refused("forge_refused", "GitHub refused to create the issue (for example, this runner's login can't write to the repository); nothing was published.");
  }
  return { outcome: "uncertain" };
}

/** Look for the approved issue among the repository's newest, after a publication that may have run.
 * Never writes: an exact title and body is the approved issue, and not finding it proves nothing,
 * because the answer may lag, so it stays uncertain. */
export async function observeIssuePublication(
  action: Extract<ForgeDecisionAction, { kind: "issue_publication_observe" }>,
  gh: GhRunner,
): Promise<ForgeDecisionActionResult & { issue?: number }> {
  if (!REPOSITORY.test(action.repository)) return { outcome: "uncertain" };
  if (action.issue !== undefined) {
    if (!Number.isSafeInteger(action.issue) || action.issue < 1) return { outcome: "uncertain" };
    const known = await gh(["api", "--hostname", "github.com", "-X", "GET", `repos/${action.repository}/issues/${action.issue}`]);
    if (known.code !== null) return { outcome: "uncertain" };
    const row = record(parseJsonOrNull(known.stdout));
    const issue = row && !row.pull_request && row.title === action.title &&
      (typeof row.body === "string" ? row.body : "").trimEnd() === action.body.trimEnd()
      ? publishedIssueNumber(row, action.repository) : null;
    return issue === action.issue ? { outcome: "already_published", issue } : { outcome: "uncertain" };
  }
  const read = await gh(["api", "--hostname", "github.com", "-X", "GET",
    `repos/${action.repository}/issues?state=all&sort=created&direction=desc&per_page=100`]);
  if (read.code !== null) return { outcome: "uncertain" };
  const rows = parseJsonOrNull(read.stdout);
  if (!Array.isArray(rows)) return { outcome: "uncertain" };
  for (const value of rows) {
    const row = record(value);
    if (!row || row.pull_request || row.title !== action.title || (typeof row.body === "string" ? row.body : "").trimEnd() !== action.body.trimEnd()) continue;
    const issue = publishedIssueNumber(row, action.repository);
    if (issue !== null) return { outcome: "already_published", issue };
  }
  return { outcome: "uncertain" };
}

function parseJsonOrNull(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** The number of an issue GitHub reports in exactly this repository, or null. */
function publishedIssueNumber(row: Record<string, unknown> | null, repository: string): number | null {
  const number = row?.number;
  const url = row?.html_url;
  return typeof number === "number" && Number.isSafeInteger(number) && number > 0 && typeof url === "string" &&
    url.toLowerCase() === `https://github.com/${repository.toLowerCase()}/issues/${number}` ? number : null;
}
