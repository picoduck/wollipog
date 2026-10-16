import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CI_PATH = ".github/workflows/ci.yml";
// A cancelled or skipped run is superseded or filtered work, not a verdict on main.
const RED = new Set(["failure", "timed_out", "startup_failure"]);
const DECISIVE = new Set(["success", ...RED]);
const LATEST = /<!-- main-ci-health latest:(\d+) -->/;
export const ALERT_TITLE = "Main CI Is Failing";
export const ALERT_LABEL = "main-ci-red";
export const REQUEST_MS = 10_000;

export function targetFromEvent(event, repository) {
  const run = event?.workflow_run;
  if (!REPOSITORY.test(repository ?? "") || event?.action !== "completed" || !isMainPushRun(run, repository))
    throw new Error("Unsupported CI event; main CI health only follows completed main push CI");
  return { repository };
}

function isMainPushRun(run, repository) {
  return run?.event === "push" && run?.head_branch === "main" && run?.path === CI_PATH &&
    run?.repository?.full_name === repository && run?.head_repository?.full_name === repository &&
    Number.isSafeInteger(run?.id) && run.id > 0 && SHA.test(run?.head_sha) &&
    typeof run?.html_url === "string" && run.html_url === `https://github.com/${repository}/actions/runs/${run.id}`;
}

/**
 * The newest completed main push CI run with a verdict. The triggering event is only a wake-up:
 * deciding from the list keeps an out-of-order or cancelled completion from flipping the alert.
 */
export function latestDecisiveRun(payload, repository) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  return runs.find((run) => run?.status === "completed" && DECISIVE.has(run?.conclusion) && isMainPushRun(run, repository)) ?? null;
}

export function decide(run, issue) {
  if (!run) return { action: "none", reason: "no-decisive-run" };
  if (!RED.has(run.conclusion)) return issue ? { action: "close" } : { action: "none", reason: "main-green" };
  if (!issue) return { action: "open" };
  return Number(LATEST.exec(issue.body ?? "")?.[1]) === run.id
    ? { action: "none", reason: "already-reported" }
    : { action: "update" };
}

function isAlert(issue) {
  return issue?.state === "open" && !issue.pull_request && issue.title === ALERT_TITLE &&
    issue.user?.login === "github-actions[bot]" && Number.isSafeInteger(issue.number) &&
    Array.isArray(issue.labels) && issue.labels.some((label) => label?.name === ALERT_LABEL);
}

function runLine(repository, run) {
  return `[\`${run.head_sha.slice(0, 9)}\`](https://github.com/${repository}/commit/${run.head_sha}) ` +
    `in [CI run ${run.id}](${run.html_url})`;
}

function jobList(jobs) {
  // Job names come from the trusted workflow file; flattening keeps each on its own list item.
  return jobs.length
    ? jobs.map((name) => `- ${String(name).replace(/\s+/g, " ").trim()}`).join("\n")
    : "- (no failed job reported; open the run)";
}

export function alertBody({ repository, run, jobs, author }) {
  return [
    `<!-- main-ci-health latest:${run.id} -->`,
    `\`main\` CI failed on ${runLine(repository, run)}.`,
    "",
    "Failing jobs:",
    "",
    jobList(jobs),
    "",
    "Every merge-queue entry fails until `main` passes again. See " +
      `[docs/main-ci-health.md](https://github.com/${repository}/blob/main/docs/main-ci-health.md) for what to do.`,
    "",
    "This issue closes itself when a later `main` CI run passes.",
    ...(author ? ["", `cc @${author}`] : []),
  ].join("\n");
}

export function githubApi(token, fetchImpl = fetch) {
  return async (path, { method = "GET", body } = {}) => {
    const response = await fetchImpl("https://api.github.com" + path, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_MS),
      redirect: "error",
    });
    // Never print response bodies or exception messages: they are untrusted and
    // may contain credentials. The status code suffices to diagnose and retry.
    if (!response.ok) {
      const error = new Error("GitHub API request failed");
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
}

async function failedJobs(api, repository, run) {
  const payload = await api(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  return (Array.isArray(payload?.jobs) ? payload.jobs : [])
    .filter((job) => RED.has(job?.conclusion) && typeof job?.name === "string")
    .map((job) => job.name);
}

async function headAuthor(api, repository, run) {
  const commit = await api(`/repos/${repository}/commits/${run.head_sha}`);
  const login = commit?.author?.login;
  return commit?.author?.type === "User" && typeof login === "string" && /^[A-Za-z0-9-]+$/.test(login) ? login : null;
}

export async function reconcile(target, { api, log = console.log }) {
  const { repository } = target;
  const emit = (event, fields = {}) => log(JSON.stringify({ event, entryPoint: "workflow_run", ...fields }));
  try {
    const run = latestDecisiveRun(
      await api(`/repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=completed&per_page=20`),
      repository,
    );
    const issues = await api(`/repos/${repository}/issues?state=open&labels=${ALERT_LABEL}&per_page=20`);
    const issue = (Array.isArray(issues) ? issues : []).filter(isAlert).sort((a, b) => a.number - b.number)[0] ?? null;
    const decision = decide(run, issue);
    const fields = { runId: run?.id ?? null, headSha: run?.head_sha ?? null, conclusion: run?.conclusion ?? null, issue: issue?.number ?? null };
    if (decision.action === "none") {
      emit("main_ci_health_unchanged", { ...fields, reason: decision.reason });
      return "unchanged";
    }
    if (decision.action === "open") {
      const [jobs, author] = await Promise.all([failedJobs(api, repository, run), headAuthor(api, repository, run)]);
      try {
        await api(`/repos/${repository}/labels`, {
          method: "POST",
          body: { name: ALERT_LABEL, color: "b60205", description: "Opened and closed by Main CI Health while main CI is red" },
        });
      } catch (error) {
        if (error?.status !== 422) throw error; // 422: the label already exists.
      }
      const created = await api(`/repos/${repository}/issues`, {
        method: "POST",
        body: { title: ALERT_TITLE, labels: [ALERT_LABEL], body: alertBody({ repository, run, jobs, author }) },
      });
      emit("main_ci_alert_opened", { ...fields, issue: created?.number ?? null });
      return "opened";
    }
    const issuePath = `/repos/${repository}/issues/${issue.number}`;
    if (decision.action === "update") {
      const jobs = await failedJobs(api, repository, run);
      // Comment first: a lost marker update repeats a comment, but never drops a failure.
      await api(`${issuePath}/comments`, {
        method: "POST",
        body: { body: `\`main\` CI failed again on ${runLine(repository, run)}.\n\nFailing jobs:\n\n${jobList(jobs)}` },
      });
      const body = LATEST.test(issue.body ?? "")
        ? issue.body.replace(LATEST, `<!-- main-ci-health latest:${run.id} -->`)
        : `<!-- main-ci-health latest:${run.id} -->\n${issue.body ?? ""}`;
      await api(issuePath, { method: "PATCH", body: { body } });
      emit("main_ci_alert_updated", fields);
      return "updated";
    }
    await api(`${issuePath}/comments`, {
      method: "POST",
      body: { body: `\`main\` CI passed again on ${runLine(repository, run)}. Closing.` },
    });
    await api(issuePath, { method: "PATCH", body: { state: "closed", state_reason: "completed" } });
    emit("main_ci_alert_closed", fields);
    return "closed";
  } catch (error) {
    emit("main_ci_health_unavailable", {
      status: Number.isInteger(error?.status) ? error.status : null,
      action: "Nothing changed; check GitHub API availability and the workflow token's issues permission",
    });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.GITHUB_TOKEN) throw new Error("Missing GitHub token");
    const target = targetFromEvent(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")), process.env.GITHUB_REPOSITORY);
    await reconcile(target, { api: githubApi(process.env.GITHUB_TOKEN) });
  } catch {
    console.error("::warning::Main CI Health could not reconcile the alert issue; check the workflow event, credentials, and issues permission.");
    process.exitCode = 1;
  }
}
