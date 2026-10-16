import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { githubApi } from "./merge-group-cleanup.mjs";

// Pull-request CI runs share a concurrency lane only with runs of the same head commit, so two
// runs GitHub starts for one head never cancel each other and leave a cancelled required check
// on it (#3283). Runs of an older head are cancelled here instead, once a run of the pull
// request's current ready head is in progress. Failing to cancel only costs runner time: the
// required check is read on the current head, which this never touches.

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// Git ref rules, enough to keep the value inert inside an encoded query parameter.
const BRANCH = /^(?!-)(?!.*\.\.)[^\x00-\x20~^:?*[\\\x7f]{1,255}$/u;
const ACTIVE = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const CI_PATH = ".github/workflows/ci.yml";
export const MAX_PAGES = 5;

export function targetFromEvent(event, repository) {
  const run = event?.workflow_run;
  if (!REPOSITORY.test(repository ?? "") ||
      event?.action !== "in_progress" || run?.event !== "pull_request" ||
      run?.repository?.full_name !== repository || run?.path !== CI_PATH ||
      !REPOSITORY.test(run?.head_repository?.full_name ?? "") ||
      !Number.isSafeInteger(run?.id) || run.id <= 0 ||
      !Number.isSafeInteger(run?.workflow_id) || run.workflow_id <= 0 ||
      !BRANCH.test(run?.head_branch ?? "") || !SHA.test(run?.head_sha))
    throw new Error("Unsupported CI pull-request event; no cancellation is authorized");
  return {
    repository, id: run.id, workflowId: run.workflow_id,
    headRepository: run.head_repository.full_name, branch: run.head_branch, sha: run.head_sha,
  };
}

/** The target is the current ready head only if every open pull request from its branch says so. */
export function currentReadyHead(pulls, target) {
  if (!Array.isArray(pulls) || pulls.length === 0) return { current: false, reason: "no-open-pull-request" };
  if (pulls.some((pull) => pull?.head?.repo?.full_name !== target.headRepository || pull?.head?.ref !== target.branch))
    return { current: false, reason: "pull-request-evidence-ambiguous" };
  if (pulls.some((pull) => pull.head.sha !== target.sha)) return { current: false, reason: "head-moved" };
  // A draft head runs no CI work, and a draft event never displaced a ready run before.
  if (pulls.some((pull) => pull.draft !== false)) return { current: false, reason: "draft" };
  return { current: true, reason: "current-ready-head" };
}

/** Active CI runs of the same pull-request branch for any other head commit. */
export function supersededRuns(runs, target) {
  return runs.filter((run) =>
    run?.event === "pull_request" && run?.path === CI_PATH && run?.id !== target.id &&
    run?.repository?.full_name === target.repository &&
    run?.head_repository?.full_name === target.headRepository &&
    run?.head_branch === target.branch && SHA.test(run?.head_sha) && run.head_sha !== target.sha &&
    ACTIVE.has(run?.status));
}

async function openPulls(api, target) {
  const owner = target.headRepository.split("/")[0];
  return api(`/repos/${target.repository}/pulls?state=open&per_page=100&head=${encodeURIComponent(`${owner}:${target.branch}`)}`);
}

async function branchRuns(api, target) {
  const runs = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await api(`/repos/${target.repository}/actions/workflows/${target.workflowId}/runs?event=pull_request` +
      `&branch=${encodeURIComponent(target.branch)}&per_page=100&page=${page}`);
    if (!Array.isArray(body?.workflow_runs) || !Number.isSafeInteger(body?.total_count))
      throw new Error("Unreadable workflow run listing");
    runs.push(...body.workflow_runs);
    if (runs.length >= body.total_count || body.workflow_runs.length === 0) return runs;
  }
  // Older pages hold older runs, which are far more likely to have finished long ago; cancelling
  // the active runs found so far is still correct, so a long history is not a refusal.
  return runs;
}

export async function supersede(target, { api, log = console.log } = {}) {
  const emit = (event, fields = {}) => log(JSON.stringify({
    event, entryPoint: "workflow_run", runId: target.id, headSha: target.sha, ...fields,
  }));
  try {
    const head = currentReadyHead(await openPulls(api, target), target);
    if (!head.current) {
      emit("pr_ci_supersede_skipped", { reason: head.reason });
      return [];
    }
    const candidates = supersededRuns(await branchRuns(api, target), target);
    if (candidates.length === 0) {
      emit("pr_ci_supersede_skipped", { reason: "no-older-head-runs" });
      return [];
    }
    // Re-read the pull request immediately before the only mutation: a newer push makes this
    // run the superseded one, and its own supersede pass will handle the rest.
    const recheck = currentReadyHead(await openPulls(api, target), target);
    if (!recheck.current) {
      emit("pr_ci_supersede_skipped", { reason: recheck.reason });
      return [];
    }
    const cancelled = [];
    for (const run of candidates) {
      try {
        await api(`/repos/${target.repository}/actions/runs/${run.id}/cancel`, {});
        cancelled.push(run.id);
        emit("pr_ci_supersede_cancel_requested", { cancelledRunId: run.id, cancelledHeadSha: run.head_sha });
      } catch (error) {
        // A run that finished in the meantime answers 409; nothing else needs doing.
        emit("pr_ci_supersede_cancel_failed", {
          cancelledRunId: run.id, status: Number.isInteger(error?.status) ? error.status : null,
        });
      }
    }
    return cancelled;
  } catch (error) {
    emit("pr_ci_supersede_evidence_unavailable", {
      status: Number.isInteger(error?.status) ? error.status : null,
      action: "Older-head CI keeps running; the current head's required check is unaffected",
    });
    return [];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.GITHUB_TOKEN) throw new Error("Missing GitHub token");
    const target = targetFromEvent(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")), process.env.GITHUB_REPOSITORY);
    await supersede(target, { api: githubApi(process.env.GITHUB_TOKEN) });
  } catch {
    console.error("::warning::Superseded pull-request CI was not cancelled; check the workflow event and credentials. Older-head CI keeps running.");
    process.exitCode = 1;
  }
}
