import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const QUEUE_PREFIX = "gh-readonly-queue/main/";
const QUEUE_BRANCH = /^gh-readonly-queue\/main\/pr-[1-9][0-9]*-[a-f0-9]{40}$/;
const STATES = new Set(["QUEUED", "AWAITING_CHECKS", "MERGEABLE", "LOCKED", "UNMERGEABLE"]);
const CI_PATH = ".github/workflows/ci.yml";
export const POLL_MS = 60_000;
export const MAX_POLLS = 35;
export const REQUEST_MS = 10_000;
export const MONITOR_MS = 35 * 60_000;
// The newest merge-group CI runs. One older than this has long since finished or been cancelled;
// if it has not, it merely keeps running, which costs runner time and never a required check.
export const RUN_PAGE = 100;
const ACTIVE = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

// Both connections are bounded and must be complete before a negative lookup
// proves anything. Do not use a PR number as the cancellation/concurrency key:
// a merge group can contain changes required by several queued pull requests.
export const QUEUE_QUERY = `query($owner:String!, $repo:String!) {
  repository(owner:$owner, name:$repo) {
    nameWithOwner
    refs(refPrefix:"refs/heads/${QUEUE_PREFIX}", first:100) {
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

/** Whether one snapshot of the whole main queue proves the target integration is no longer needed. */
export function obsoleteEvidence(payload, target) {
  const repository = payload?.data?.repository;
  if (payload?.errors?.length || repository?.nameWithOwner !== target.repository)
    return { obsolete: false, reason: "repository-evidence-unavailable" };
  const refs = repository.refs;
  const entries = repository.mergeQueue?.entries;
  if (!complete(refs) || !complete(entries))
    return { obsolete: false, reason: "queue-evidence-incomplete" };
  if (refs.nodes.some((ref) => !QUEUE_BRANCH.test(QUEUE_PREFIX + ref?.name) || !SHA.test(ref?.target?.oid)) ||
      entries.nodes.some((entry) => !STATES.has(entry?.state) || !SHA.test(entry?.headCommit?.oid)))
    return { obsolete: false, reason: "queue-evidence-ambiguous" };
  // The ref listing is complete, so the integration's own ref exists exactly when it is listed.
  if (refs.nodes.some((ref) => QUEUE_PREFIX + ref.name === target.branch))
    return { obsolete: false, reason: "integration-ref-present" };
  if (refs.nodes.some((ref) => ref.target.oid === target.sha) ||
      entries.nodes.some((entry) => entry.headCommit.oid === target.sha))
    return { obsolete: false, reason: "integration-still-needed" };
  return { obsolete: true, reason: "integration-absent-from-complete-queue" };
}

/** The identity of a same-repository main merge-group CI attempt, or null for anything else. */
export function targetFromRun(run, repository) {
  if (!REPOSITORY.test(repository ?? "") ||
      run?.event !== "merge_group" ||
      run?.repository?.full_name !== repository ||
      run?.head_repository?.full_name !== repository ||
      run?.path !== CI_PATH ||
      !Number.isSafeInteger(run?.id) || run.id <= 0 ||
      !Number.isSafeInteger(run?.run_attempt) || run.run_attempt <= 0 ||
      !QUEUE_BRANCH.test(run?.head_branch) || !SHA.test(run?.head_sha))
    return null;
  return { repository, id: run.id, attempt: run.run_attempt, branch: run.head_branch, sha: run.head_sha };
}

/** The triggering event only wakes the monitor, but it must still be a merge-group CI attempt. */
export function targetFromEvent(event, repository) {
  const target = event?.action === "in_progress" || event?.action === "completed"
    ? targetFromRun(event.workflow_run, repository) : null;
  if (!target) throw new Error("Unsupported CI integration event; no cancellation is authorized");
  return target;
}

function sameRun(run, target) {
  const current = targetFromRun(run, target.repository);
  return current !== null && current.id === target.id && current.attempt === target.attempt &&
    current.branch === target.branch && current.sha === target.sha;
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

/** Active merge-group CI attempts among the newest runs; anything unrecognised is left alone. */
export async function activeTargets(api, repository) {
  const body = await api(`/repos/${repository}/actions/workflows/ci.yml/runs?event=merge_group` +
    `&exclude_pull_requests=true&per_page=${RUN_PAGE}`);
  if (!Array.isArray(body?.workflow_runs)) throw new Error("Unreadable workflow run listing");
  return body.workflow_runs
    .filter((run) => ACTIVE.has(run?.status))
    .map((run) => targetFromRun(run, repository))
    .filter((target) => target !== null);
}

const unavailable = (error) => ({
  status: Number.isInteger(error?.status) ? error.status : null,
  action: "Retain CI; check GitHub API availability, token permissions, and queue evidence",
});

/**
 * One monitor watches every active merge-group CI attempt, so cleanup holds at most one runner
 * however many integrations the queue builds (#2674). Each attempt is judged on its own: two
 * consecutive obsolete observations, then a fresh re-read of that run and the queue immediately
 * before the sole mutation.
 */
export async function monitor(repository, { api, wait = sleep, log = console.log, polls = MAX_POLLS, now = () => performance.now() } = {}) {
  const [owner, repo] = repository.split("/");
  const snapshot = () => api("/graphql", { query: QUEUE_QUERY, variables: { owner, repo } });
  const emit = (event, target, fields = {}) => log(JSON.stringify({
    event, entryPoint: "workflow_run",
    ...(target ? { runId: target.id, runAttempt: target.attempt, headSha: target.sha } : {}), ...fields,
  }));
  const key = (target) => `${target.id}:${target.attempt}`;
  // Per attempt: whether the previous poll found it obsolete, and the last reason logged.
  const tracked = new Map();
  // Cancellation takes effect asynchronously; an attempt already asked to stop is not asked again.
  const cancelRequested = new Set();
  const deadline = now() + MONITOR_MS;
  emit("merge_group_monitor_started");
  for (let poll = 0; poll < polls && now() < deadline; poll++) {
    try {
      const targets = await activeTargets(api, repository);
      if (targets.length === 0) {
        emit("merge_group_monitor_stopped", null, { reason: "no-active-merge-group-ci" });
        return "idle";
      }
      const payload = await snapshot();
      // An attempt that left the active listing must earn two fresh observations if it returns.
      const active = new Set(targets.map(key));
      for (const id of tracked.keys()) if (!active.has(id)) tracked.delete(id);
      for (const target of targets) {
        if (cancelRequested.has(key(target))) continue;
        if (!tracked.has(key(target))) tracked.set(key(target), { priorObsolete: false, lastReason: undefined });
        const state = tracked.get(key(target));
        const proof = obsoleteEvidence(payload, target);
        if (proof.reason !== state.lastReason) {
          emit("merge_group_evidence", target, { reason: proof.reason });
          state.lastReason = proof.reason;
        }
        if (!proof.obsolete || !state.priorObsolete) {
          state.priorObsolete = proof.obsolete;
          continue;
        }
        state.priorObsolete = false;
        try {
          // Re-read both identities and queue evidence immediately before the
          // sole mutation. A changed attempt, resurrected ref, or live dependency
          // invalidates the earlier observations.
          const currentRun = await api(`/repos/${repository}/actions/runs/${target.id}`);
          if (!sameRun(currentRun, target) || !ACTIVE.has(currentRun.status)) {
            emit("merge_group_cancel_withheld", target, { reason: "run-changed-before-cancel" });
            continue;
          }
          const finalProof = obsoleteEvidence(await snapshot(), target);
          if (finalProof.obsolete && now() < deadline) {
            await api(`/repos/${repository}/actions/runs/${target.id}/cancel`, {});
            cancelRequested.add(key(target));
            emit("merge_group_cancel_requested", target, { reason: finalProof.reason });
          } else {
            emit("merge_group_cancel_withheld", target, { reason: finalProof.reason });
          }
        } catch (error) {
          emit("merge_group_evidence_unavailable", target, unavailable(error));
        }
      }
    } catch (error) {
      for (const state of tracked.values()) state.priorObsolete = false;
      emit("merge_group_evidence_unavailable", null, unavailable(error));
    }
    if (poll + 1 < polls && now() + POLL_MS < deadline) await wait(POLL_MS);
    else break;
  }
  emit("merge_group_monitor_stopped", null, {
    reason: "monitor-budget-exhausted",
    action: "CI retained; the next merge-group CI event starts another monitor",
  });
  return "retained";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.GITHUB_TOKEN) throw new Error("Missing GitHub token");
    const repository = process.env.GITHUB_REPOSITORY;
    targetFromEvent(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")), repository);
    await monitor(repository, { api: githubApi(process.env.GITHUB_TOKEN) });
  } catch {
    console.error("::warning::Merge-group cleanup refused; check the workflow event, credentials, and trusted monitor configuration. CI was retained.");
    process.exitCode = 1;
  }
}
