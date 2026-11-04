import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { budgetApi, githubApi, readAlert } from "./main-ci-health.mjs";
import { readState } from "./main-regression-automation.mjs";

/** #3637 follow-up: deliver an exhausted regression investigation to a human. Disabled by default.
 * Main CI Health's trusted job, which already owns the incident with `issues: write`, runs this after
 * its reconciliation with the same workflow token: no new credential, secret or permission. It reads
 * the automation's own CAS state and posts at most one marked comment per incident, investigated run,
 * attempt and exhaustion reason. Any later invocation, health rerun or repeat finds the marker and
 * does nothing; a new attempt that exhausts again is a new escalation.
 */
export const ESCALATION_REASONS = Object.freeze(["delivery-exhausted", "elapsed-exhausted"]);
export const MAX_COMMENT_PAGES = 10;
export const API_LIMIT = 16; // State ref + file, incident listing, up to 10 comment pages, one comment.
const BOT = "github-actions[bot]";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// A user (`@name`) or a team (`@org/team`); nothing else can reach the comment body.
const MENTION = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?$/;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const fail = (reason) => { throw Object.assign(new Error(reason), { reason }); };

/** Pure: the configured notification target. Absent or empty is disabled; malformed is refused. */
export function parseMentions(value) {
  if (value === undefined || value === null || String(value).trim() === "") return { enabled: false, mentions: [] };
  const mentions = [...new Set(String(value).trim().split(/[\s,]+/))];
  if (mentions.length > 5 || !mentions.every((mention) => MENTION.test(mention))) return { enabled: false, mentions: [], invalid: true };
  return { enabled: true, mentions };
}

/** Pure: the escalation implied by the automation's blocked state, or null. */
export function pendingEscalation(state) {
  if (!ESCALATION_REASONS.includes(state?.blocked) || !positive(state.active?.runId) || !positive(state.active?.attempt)) return null;
  const { runId, attempt } = state.active;
  return { reason: state.blocked, runId, attempt, eventId: `main-regression:${runId}:${attempt}` };
}

export const escalationMarker = (e) => `<!-- main-regression-escalation:${e.runId}:${e.attempt}:${e.reason} -->`;

/** Pure: fixed text plus validated identifiers only; nothing author-controlled reaches the body. */
export function escalationBody(repository, escalation, mentions) {
  const what = escalation.reason === "elapsed-exhausted" ? "ran out of its elapsed-time budget after bounded stop attempts"
    : "ran out of delivery attempts without starting";
  return [escalationMarker(escalation),
    `${mentions.join(" ")} The bounded regression investigation for [run ${escalation.runId}, attempt ${escalation.attempt}]` +
      `(https://github.com/${repository}/actions/runs/${escalation.runId}/attempts/${escalation.attempt}) ${what} ` +
      `(\`${escalation.reason}-operator-required\`).`,
    "",
    "Holds stay in place and nothing is released automatically. Investigate the failure yourself or repair it through the " +
      "reviewed path in `docs/main-merge-admission.md`; see `docs/main-regression-automation.md` for clearing the block.",
  ].join("\n");
}

/** Read the state, find the open incident, and post one marked comment unless it already exists. */
export async function deliverEscalation(repository, { api, mentions }) {
  if (!REPOSITORY.test(repository ?? "")) fail("invalid-repository");
  const { value } = await readState(api, repository);
  const escalation = pendingEscalation(value);
  if (!escalation) return { status: "no-escalation", writes: 0 };
  const issue = await readAlert(api, repository);
  if (!issue) return { status: "no-open-incident", escalation, writes: 0 };
  const marker = escalationMarker(escalation);
  for (let page = 1; ; page++) {
    // An incomplete listing cannot prove the marker is absent: report rather than risk a duplicate.
    if (page > MAX_COMMENT_PAGES) return { status: "dedup-unavailable", escalation, issue: issue.number, writes: 0 };
    const comments = await api(`/repos/${repository}/issues/${issue.number}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments) || comments.length > 100) fail("comment-listing-unavailable");
    // Only this workflow's own comments count; a pasted marker cannot suppress a notification.
    if (comments.some((comment) => comment?.user?.login === BOT && typeof comment.body === "string" && comment.body.includes(marker)))
      return { status: "already-notified", escalation, issue: issue.number, writes: 0 };
    if (comments.length < 100) break;
  }
  const created = await api(`/repos/${repository}/issues/${issue.number}/comments`, { method: "POST",
    body: { body: escalationBody(repository, escalation, mentions) } });
  if (!positive(created?.id)) fail("comment-receipt-unavailable");
  return { status: "notified", escalation, issue: issue.number, commentId: created.id, writes: 1 };
}

export async function main({ env = process.env, api, log = console.log } = {}) {
  const config = parseMentions(env.MAIN_REGRESSION_ESCALATION_MENTION);
  const emit = (result) => log(JSON.stringify({ event: "main_regression_escalation", ...result }));
  // Disabled or misconfigured: no API work at all.
  if (!config.enabled) { emit({ status: config.invalid ? "invalid-configuration" : "disabled", writes: 0 }); return 0; }
  let result;
  try {
    if (!REPOSITORY.test(env.GITHUB_REPOSITORY ?? "") || env.GITHUB_REF !== "refs/heads/main") fail("untrusted-entry-point");
    if (!api && !env.GITHUB_TOKEN) fail("missing-github-token");
    const bounded = budgetApi(api ?? githubApi(env.GITHUB_TOKEN), { limit: API_LIMIT, reserve: 0 });
    result = await deliverEscalation(env.GITHUB_REPOSITORY, { api: bounded, mentions: config.mentions });
    result.apiCalls = bounded.budget.calls;
  } catch (error) {
    // Never echo API bodies. Delivery failure is visible but does not change the health verdict.
    result = { status: "unavailable", reason: typeof error?.reason === "string" ? error.reason : "github-read-unavailable", writes: 0 };
    log(`::warning::Regression escalation delivery unavailable (${result.reason}); see docs/main-regression-automation.md.`);
  }
  emit(result);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `Regression escalation: **${result.status}**\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
