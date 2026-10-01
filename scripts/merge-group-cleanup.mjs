import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const SHA = /^[a-f0-9]{40}$/;
const QUEUE_BRANCH = /^gh-readonly-queue\/main\/pr-[1-9][0-9]*-[a-f0-9]{40}$/;
const STATES = new Set(["QUEUED", "AWAITING_CHECKS", "MERGEABLE", "LOCKED", "UNMERGEABLE"]);
export const POLL_MS = 60_000;
export const MAX_POLLS = 35;
export const REQUEST_MS = 10_000;
export const MONITOR_MS = 35 * 60_000;
const ACTIVE = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

// Both connections are bounded and must be complete before a negative lookup
// proves anything. Do not use a PR number as the cancellation/concurrency key:
// a merge group can contain changes required by several queued pull requests.
export const QUEUE_QUERY = `query($owner:String!, $repo:String!, $ref:String!) {
  repository(owner:$owner, name:$repo) {
    nameWithOwner
    ref(qualifiedName:$ref) { target { oid } }
    refs(refPrefix:"refs/heads/gh-readonly-queue/main/", first:100) {
      totalCount pageInfo { hasNextPage } nodes { name target { oid } }
    }
    mergeQueue(branch:"main") {
      entries(first:100) {
        totalCount pageInfo { hasNextPage } nodes { state headCommit { oid } }
      }
    }
  }
}`;

function complete(connection) {
  return Array.isArray(connection?.nodes) &&
    connection.pageInfo?.hasNextPage === false &&
    Number.isSafeInteger(connection.totalCount) &&
    connection.totalCount === connection.nodes.length;
}

export function obsoleteEvidence(payload, target) {
  const repository = payload?.data?.repository;
  if (payload?.errors?.length || repository?.nameWithOwner !== target.repository)
    return { obsolete: false, reason: "repository-evidence-unavailable" };
  if (repository.ref !== null)
    return { obsolete: false, reason: "integration-ref-present-or-unknown" };
  const refs = repository.refs;
  const entries = repository.mergeQueue?.entries;
  if (!complete(refs) || !complete(entries))
    return { obsolete: false, reason: "queue-evidence-incomplete" };
  if (refs.nodes.some((ref) => !QUEUE_BRANCH.test("gh-readonly-queue/main/" + ref?.name) || !SHA.test(ref?.target?.oid)) ||
      entries.nodes.some((entry) => !STATES.has(entry?.state) || !SHA.test(entry?.headCommit?.oid)))
    return { obsolete: false, reason: "queue-evidence-ambiguous" };
  if (refs.nodes.some((ref) => ref.target.oid === target.sha) ||
      entries.nodes.some((entry) => entry.headCommit.oid === target.sha))
    return { obsolete: false, reason: "integration-still-needed" };
  return { obsolete: true, reason: "integration-absent-from-complete-queue" };
}

export function targetFromEvent(event, repository) {
  const run = event?.workflow_run;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      event?.action !== "in_progress" || run?.event !== "merge_group" ||
      run?.repository?.full_name !== repository ||
      run?.head_repository?.full_name !== repository ||
      run?.path !== ".github/workflows/ci.yml" ||
      !Number.isSafeInteger(run?.id) || run.id <= 0 ||
      !Number.isSafeInteger(run?.run_attempt) || run.run_attempt <= 0 ||
      !QUEUE_BRANCH.test(run?.head_branch) || !SHA.test(run?.head_sha))
    throw new Error("Unsupported CI integration event; no cancellation is authorized");
  return { repository, id: run.id, attempt: run.run_attempt, branch: run.head_branch, sha: run.head_sha };
}

function sameRun(run, target) {
  return run?.id === target.id && run?.run_attempt === target.attempt &&
    run?.event === "merge_group" && run?.path === ".github/workflows/ci.yml" &&
    run?.repository?.full_name === target.repository &&
    run?.head_repository?.full_name === target.repository &&
    run?.head_branch === target.branch && run?.head_sha === target.sha;
}

export function githubApi(token, fetchImpl = fetch) {
  return async (path, body) => {
    const response = await fetchImpl("https://api.github.com" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_MS),
      redirect: "error",
    });
    // Never print response bodies or exception messages: they are untrusted and
    // may contain credentials. Error codes plus the run id suffice to retry.
    if (!response.ok) {
      const error = new Error("GitHub API request failed");
      error.status = response.status;
      throw error;
    }
    return response.status === 204 || response.status === 202 ? null : response.json();
  };
}

export async function monitor(target, { api, wait = sleep, log = console.log, polls = MAX_POLLS, now = () => performance.now() } = {}) {
  const [owner, repo] = target.repository.split("/");
  const runPath = `/repos/${target.repository}/actions/runs/${target.id}`;
  const evidence = () => api("/graphql", {
    query: QUEUE_QUERY, variables: { owner, repo, ref: "refs/heads/" + target.branch },
  });
  const emit = (event, fields = {}) => log(JSON.stringify({
    event, entryPoint: "workflow_run", runId: target.id, headSha: target.sha, ...fields,
  }));
  let priorObsolete = false;
  let lastReason;
  const deadline = now() + MONITOR_MS;
  emit("merge_group_monitor_started");
  for (let poll = 0; poll < polls && now() < deadline; poll++) {
    try {
      const run = await api(runPath);
      if (!sameRun(run, target)) {
        emit("merge_group_monitor_stopped", { reason: "run-identity-changed" });
        return "retained";
      }
      if (run.status === "completed") {
        emit("merge_group_monitor_stopped", { reason: "ci-completed" });
        return "completed";
      }
      if (!ACTIVE.has(run.status))
        throw new Error("Unknown workflow run status");
      const proof = obsoleteEvidence(await evidence(), target);
      if (proof.reason !== lastReason) {
        emit("merge_group_evidence", { reason: proof.reason });
        lastReason = proof.reason;
      }
      if (proof.obsolete && priorObsolete) {
        // Re-read both identities and queue evidence immediately before the
        // sole mutation. A changed attempt, resurrected ref, or live dependency
        // invalidates the earlier observations.
        const currentRun = await api(runPath);
        if (!sameRun(currentRun, target) || !ACTIVE.has(currentRun.status)) {
          emit("merge_group_monitor_stopped", { reason: "run-changed-before-cancel" });
          return "retained";
        }
        const finalProof = obsoleteEvidence(await evidence(), target);
        if (finalProof.obsolete && now() < deadline) {
          await api(runPath + "/cancel", {});
          emit("merge_group_cancel_requested", { reason: finalProof.reason });
          return "cancel-requested";
        }
        priorObsolete = false;
        emit("merge_group_cancel_withheld", { reason: finalProof.reason });
      } else {
        priorObsolete = proof.obsolete;
      }
    } catch (error) {
      priorObsolete = false;
      emit("merge_group_evidence_unavailable", {
        status: Number.isInteger(error?.status) ? error.status : null,
        action: "Retain CI; check GitHub API availability, token permissions, and queue evidence",
      });
    }
    if (poll + 1 < polls && now() + POLL_MS < deadline) await wait(POLL_MS);
    else break;
  }
  emit("merge_group_monitor_stopped", {
    reason: "monitor-budget-exhausted",
    action: "CI retained; inspect the run and complete queue evidence before cancelling manually",
  });
  return "retained";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.GITHUB_TOKEN) throw new Error("Missing GitHub token");
    const target = targetFromEvent(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")), process.env.GITHUB_REPOSITORY);
    await monitor(target, { api: githubApi(process.env.GITHUB_TOKEN) });
  } catch {
    console.error("::warning::Merge-group cleanup refused; check the workflow event, credentials, and trusted monitor configuration. CI was retained.");
    process.exitCode = 1;
  }
}
