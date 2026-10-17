/**
 * Pull request wait (#3081): block in the runner, not in the model, until a GitHub pull request's
 * required checks or its merge-queue entry reach an outcome, then return one bounded summary.
 *
 * Read-only, through this runner's existing `gh` login: one REST pair reads the base branch's
 * required checks (rulesets plus classic branch protection) and one GraphQL query per poll reads
 * the pull request. Nothing here merges, enqueues, retries, or writes anything.
 *
 * Which checks are required comes from the base branch's rules, never from the job list: a
 * required check GitHub has not reported yet has no node at all, so it reads `pending`
 * (`reported: false`), never passing. A base with no required checks returns at once.
 */
import { classifyGhFailure, githubRepository, type GhOutcome, type GhRunner } from "./campaign-forge-status.js";

export const PULL_REQUEST_WAIT_DEFAULT_TIMEOUT_MS = 240_000;
export const PULL_REQUEST_WAIT_MAX_TIMEOUT_MS = 10_800_000;
export const PULL_REQUEST_WAIT_DEFAULT_INTERVAL_MS = 30_000;
export const PULL_REQUEST_WAIT_MIN_INTERVAL_MS = 10_000;
export const PULL_REQUEST_WAIT_MAX_INTERVAL_MS = 600_000;

/** Contexts read per page, and pages read per commit. Past the last page a pass also needs GitHub's
 * own merge state to confirm it. */
const CONTEXTS_PER_COMMIT = 100;
const MAX_CONTEXT_PAGES = 10;
/** At most one run list, ten check lookups, and ten attempt job lists per special-path poll. */
const MAX_SKIP_PROVENANCE_CHECKS = 10;
const MAX_LISTED_CHECKS = 30;
const MAX_FAILED_JOBS = 20;
const MAX_NAME = 120;
const MAX_URL = 300;
/** Consecutive transient `gh` failures (rate limit, network) tolerated before giving up. */
const MAX_TRANSIENT_FAILURES = 3;
/** Pause before confirming that a queue entry which vanished without a merge was really ejected. */
const EJECTION_CONFIRM_MS = 10_000;
/** How far past the timeout one in-flight observation may run; no read starts after it. */
export const PULL_REQUEST_WAIT_READ_GRACE_MS = 20_000;
const BUDGET_SPENT: GhOutcome = { stdout: "", stderr: "the wait's time budget is spent", code: "ETIMEDOUT", timedOut: true };

export type PullRequestWaitOutcome =
  | "checks_passed"
  | "checks_failed"
  | "no_required_checks"
  | "merged"
  | "closed"
  | "queue_failed"
  | "queue_ejected"
  | "head_changed"
  | "timeout";

export type CheckState = "passed" | "failed" | "pending";

export interface RequiredCheckSummary {
  name: string;
  state: CheckState;
  /** False while GitHub has not reported the check on this commit; such a check is pending. */
  reported: boolean;
}

export interface FailedJob {
  name: string;
  required: boolean;
  conclusion: string;
  url?: string;
}

export interface CommitChecksSummary {
  sha: string;
  required: RequiredCheckSummary[];
  /** Checks outside the required set, counted. */
  other: { passed: number; failed: number; pending: number };
  failedJobs: FailedJob[];
  /** Set when a list was cut to its bound or GitHub had more contexts than one page. */
  truncated?: true;
}

export interface PullRequestWaitSummary {
  outcome: PullRequestWaitOutcome;
  repository: string;
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  merged: boolean;
  mergeCommitSha: string | null;
  isDraft: boolean;
  headSha: string;
  baseRef: string;
  defaultBranch: string | null;
  mergeStateStatus: string | null;
  /** Required check names from the base branch's rules; empty means none are required there.
   * Null when the rules were not read because the pull request had already merged, closed, or
   * moved to another head. */
  requiredCheckNames: string[] | null;
  checks: CommitChecksSummary;
  mergeQueue: null | {
    state: string;
    position: number | null;
    enqueuedAt: string | null;
    checks: CommitChecksSummary | null;
  };
  waitedMs: number;
  polls: number;
}

export interface PullRequestWaitInput {
  repository: string;
  number: number;
  /** The head the caller reviewed; a different head returns `head_changed`. */
  headSha?: string;
  timeoutMs?: number;
  intervalMs?: number;
  /** Also return when a check outside the required set fails on the head. A queued pull request
   * still waits for GitHub's own verdict on its entry. */
  returnOnAnyFailure?: boolean;
}

export interface PullRequestWaitDeps {
  gh: GhRunner;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  /** PULL_REQUEST_WAIT_READ_GRACE_MS, or what remains of it after a caller's own read. */
  readGraceMs?: number;
}

export type PullRequestWaitResult =
  | { ok: true; summary: PullRequestWaitSummary }
  | { ok: false; error: string };

const SHA = /^[0-9a-f]{40}$/u;
/** `mergeStateStatus` values under which GitHub has every required check reported and passing. */
const REQUIREMENTS_MET = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);
const PASS_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function httpsUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.startsWith("https://") ? clip(value, MAX_URL) : undefined;
}

/** Parse `owner/name#123`, a github.com pull request URL, or a bare number plus a repository. */
export function parsePullRequestRef(
  pullRequest: unknown,
  repository: unknown,
): { repository: string; number: number } | { error: string } {
  let repo = typeof repository === "string" ? repository.trim() : undefined;
  let number: number | undefined;
  if (typeof pullRequest === "number") {
    number = pullRequest;
  } else if (typeof pullRequest === "string") {
    const text = pullRequest.trim();
    const url = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/u.exec(text);
    const short = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/u.exec(text);
    const match = url ?? short;
    if (match) {
      if (repo && repo.toLowerCase() !== match[1]!.toLowerCase()) {
        return { error: `pull request ${text} is not in repository ${repo}` };
      }
      repo = match[1]!;
      number = Number(match[2]);
    } else if (/^#?\d+$/u.test(text)) {
      number = Number(text.replace(/^#/u, ""));
    } else {
      return { error: "pullRequest must be a number, owner/name#number, or a github.com pull request URL" };
    }
  } else {
    return { error: "pullRequest is required" };
  }
  if (!Number.isSafeInteger(number) || number! < 1) return { error: "pullRequest number must be a positive integer" };
  if (!repo) return { error: "repository (owner/name) is required when pullRequest is a bare number" };
  if (!githubRepository({ repository: repo, number: number! })) return { error: `invalid GitHub repository: ${repo}` };
  return { repository: repo, number: number! };
}

/** `gh api` reports an HTTP error as `gh: Not Found (HTTP 404)`, which the shared classifier would
 * read as a missing `gh`, so a status code is classified first. GitHub also answers a rate limit
 * with 403, so its wording is checked before the status. */
function failureReason(outcome: GhOutcome): string {
  const status = /\(HTTP (\d{3})\)/u.exec(outcome.stderr)?.[1];
  if (/rate limit/iu.test(outcome.stderr) || status === "429") return "forge_rate_limited";
  if (status === "401") return "forge_unauthenticated";
  if (status?.startsWith("5")) return "forge_unreachable";
  if (status) return `http_${status}`;
  return classifyGhFailure(outcome);
}

function ghError(what: string, outcome: GhOutcome): string {
  const reason = failureReason(outcome);
  const detail = outcome.stderr.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  return `${what}: ${reason}${detail ? ` (${clip(detail, 200)})` : ""}`;
}

function transient(outcome: GhOutcome): boolean {
  const reason = failureReason(outcome);
  return reason === "forge_unreachable" || reason === "forge_rate_limited";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The base branch's required checks: names, plus the GitHub App ids a name is restricted to. */
export interface RequiredChecks {
  names: string[];
  /** Names a rule restricts to particular apps (ruleset `integration_id`, protection `app_id`). */
  apps: Record<string, number[]>;
}

/**
 * The base branch's required status checks: every active ruleset's `required_status_checks` rule
 * plus classic branch protection. Both endpoints need only read access. Any failure is an error
 * rather than an empty set, so an unreadable base can never look like "nothing required".
 */
export async function requiredCheckNames(
  gh: GhRunner,
  repository: string,
  branch: string,
  signal?: AbortSignal,
): Promise<({ ok: true } & RequiredChecks) | { ok: false; error: string; transient: boolean }> {
  const ref = encodeURIComponent(branch);
  const names = new Set<string>();
  const apps = new Map<string, Set<number>>();
  const add = (context: unknown, app: unknown) => {
    if (typeof context !== "string" || !context) return;
    names.add(context);
    if (Number.isSafeInteger(app) && (app as number) > 0) apps.set(context, (apps.get(context) ?? new Set()).add(app as number));
  };
  const rules = await gh(["api", "--hostname", "github.com", `repos/${repository}/rules/branches/${ref}?per_page=100`]);
  if (rules.code !== null) return { ok: false, error: ghError(`could not read the rules for ${branch}`, rules), transient: transient(rules) };
  const ruleList = parseJson(rules.stdout);
  if (!Array.isArray(ruleList)) return { ok: false, error: `could not read the rules for ${branch}: unexpected response`, transient: false };
  for (const rule of ruleList) {
    const value = record(rule);
    if (value?.type !== "required_status_checks") continue;
    const checks = record(value.parameters)?.required_status_checks;
    for (const check of Array.isArray(checks) ? checks : []) add(record(check)?.context, record(check)?.integration_id);
  }
  if (signal?.aborted) return { ok: false, error: "request cancelled", transient: false };
  const branchInfo = await gh(["api", "--hostname", "github.com", `repos/${repository}/branches/${ref}`]);
  if (branchInfo.code !== null) {
    return { ok: false, error: ghError(`could not read branch ${branch}`, branchInfo), transient: transient(branchInfo) };
  }
  const protection = record(record(parseJson(branchInfo.stdout))?.protection);
  const classic = record(protection?.required_status_checks);
  if (protection?.enabled !== false && classic) {
    for (const context of Array.isArray(classic.contexts) ? classic.contexts : []) add(context, null);
    for (const check of Array.isArray(classic.checks) ? classic.checks : []) add(record(check)?.context, record(check)?.app_id);
  }
  return {
    ok: true,
    names: [...names].sort(),
    apps: Object.fromEntries([...apps].map(([name, ids]) => [name, [...ids].sort((a, b) => a - b)])),
  };
}

const contextFields = (after: string) => `contexts(first:${CONTEXTS_PER_COMMIT}${after}){pageInfo{hasNextPage endCursor} nodes{
  __typename
  ... on CheckRun{databaseId name status conclusion startedAt detailsUrl checkSuite{app{databaseId}} isRequired(pullRequestNumber:$number)}
  ... on StatusContext{context state createdAt targetUrl isRequired(pullRequestNumber:$number)}
}}`;
const CONTEXT_FIELDS = contextFields("");

export const PULL_REQUEST_WAIT_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    defaultBranchRef{name}
    pullRequest(number:$number){
      url state isDraft headRefOid baseRefName mergeStateStatus createdAt
      timelineItems(last:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{... on ReadyForReviewEvent{createdAt}}}
      mergeCommit{oid}
      mergeQueueEntry{position state enqueuedAt headCommit{oid statusCheckRollup{${CONTEXT_FIELDS}}}}
      commits(last:1){nodes{commit{oid statusCheckRollup{${CONTEXT_FIELDS}}}}}
    }
  }
}`;

/** One further page of a commit's check contexts. */
export const PULL_REQUEST_CONTEXTS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$oid:GitObjectID!,$after:String!){
  repository(owner:$owner,name:$name){
    object(oid:$oid){... on Commit{statusCheckRollup{${contextFields(",after:$after")}}}}
  }
}`;

interface CheckNode {
  kind: "CheckRun" | "StatusContext";
  name: string;
  state: CheckState;
  conclusion: string;
  /** Check run id (assigned in creation order), absent for a status context. */
  id?: number;
  /** When the run started or the status was created; empty when unknown. */
  at: string;
  /** The GitHub App that reported a check run. */
  appId?: number;
  url?: string;
  isRequired: boolean;
}

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function checkNode(raw: unknown): CheckNode | null {
  const node = record(raw);
  if (!node) return null;
  if (node.__typename === "CheckRun" && typeof node.name === "string") {
    const completed = node.status === "COMPLETED";
    const conclusion = typeof node.conclusion === "string" ? node.conclusion : "";
    const appId = record(record(node.checkSuite)?.app)?.databaseId;
    return {
      kind: "CheckRun",
      name: node.name,
      state: !completed ? "pending" : PASS_CONCLUSIONS.has(conclusion) ? "passed" : "failed",
      conclusion: completed ? conclusion || "UNKNOWN" : String(node.status ?? "PENDING"),
      ...(Number.isSafeInteger(node.databaseId) ? { id: node.databaseId as number } : {}),
      at: typeof node.startedAt === "string" ? node.startedAt : "",
      ...(Number.isSafeInteger(appId) ? { appId: appId as number } : {}),
      url: httpsUrl(node.detailsUrl),
      isRequired: node.isRequired === true,
    };
  }
  if (node.__typename === "StatusContext" && typeof node.context === "string") {
    const state = String(node.state ?? "PENDING");
    return {
      kind: "StatusContext",
      name: node.context,
      state: state === "SUCCESS" ? "passed" : state === "FAILURE" || state === "ERROR" ? "failed" : "pending",
      conclusion: state,
      at: typeof node.createdAt === "string" ? node.createdAt : "",
      url: httpsUrl(node.targetUrl),
      isRequired: node.isRequired === true,
    };
  }
  return null;
}

/** Whether `node` supersedes `previous`, a run of the same kind and name: check run ids grow in
 * creation order, so a re-run (even one not started yet) has the larger id; otherwise the later
 * known time wins, and an unknown time never displaces a known one. */
function newer(node: CheckNode, previous: CheckNode): boolean {
  if (node.id !== undefined && previous.id !== undefined) return node.id > previous.id;
  return node.at !== "" && (previous.at === "" || node.at > previous.at);
}

/**
 * Fold one commit's rollup into a bounded summary. Of several runs of one kind sharing a name
 * (re-runs), the newest wins. A check run and a status context that share a required name must
 * both pass, and a name a rule restricts to particular apps counts only check runs from those apps
 * (a status context carries no app here, so it still matches by name). The verdict covers every
 * required check, including any cut from the bounded list; `complete` is false when GitHub had
 * more contexts than one page, so an unseen context could still change it. When the PR's merge
 * state is supplied, skipped requirements need either GitHub's merge-state confirmation or
 * independently verified admission/run provenance. Unknown provenance remains pending.
 */
export function evaluateCommitChecks(
  sha: string,
  rollup: unknown,
  requiredNames: readonly string[],
  requiredApps: Readonly<Record<string, readonly number[]>> = {},
  mergeStateStatus?: string | null,
  admittedSkippedRuns: ReadonlySet<number> = new Set(),
): { summary: CommitChecksSummary; requiredState: CheckState | "none"; complete: boolean } {
  const contexts = record(record(rollup)?.contexts);
  const rawNodes = Array.isArray(contexts?.nodes) ? contexts.nodes : [];
  const moreContexts = record(contexts?.pageInfo)?.hasNextPage === true;
  // Own properties only: a check may be named `constructor` or `__proto__`.
  const appsFor = (name: string): readonly number[] | undefined =>
    Object.hasOwn(requiredApps, name) ? requiredApps[name] : undefined;
  const latest = new Map<string, CheckNode>();
  for (const raw of rawNodes) {
    const node = checkNode(raw);
    if (!node) continue;
    // Restricted names keep each app's runs apart, so another app's run cannot replace them.
    const app = node.kind === "CheckRun" && appsFor(node.name) ? String(node.appId ?? "") : "";
    const key = `${node.kind}\0${app}\0${node.name}`;
    const previous = latest.get(key);
    if (!previous || newer(node, previous)) latest.set(key, node);
  }
  const counts = (node: CheckNode, name: string): boolean => {
    const apps = appsFor(name);
    return node.name === name &&
      (node.kind === "StatusContext" || !apps || (node.appId !== undefined && apps.includes(node.appId)));
  };
  // Rules are the authority; a check GitHub itself marks required is added, never removed.
  const required = new Set(requiredNames);
  for (const node of latest.values()) if (node.isRequired && !appsFor(node.name)) required.add(node.name);
  // A draft run can leave a skipped required job on the same head while a newly admitted
  // ready_for_review run has not created its aggregator yet. With a PR observation, a skip
  // needs confirmation or current admitted-run provenance; genuine successes and optional skips pass.
  const requiredNodeState = (node: CheckNode | undefined): CheckState | undefined =>
    node?.conclusion === "SKIPPED" && mergeStateStatus !== undefined && !REQUIREMENTS_MET.has(mergeStateStatus ?? "") &&
      !(node.id !== undefined && admittedSkippedRuns.has(node.id))
      ? "pending" : node?.state;
  const requiredList: RequiredCheckSummary[] = [...required].sort().map((name) => {
    const named = [...latest.values()].filter((node) => node.name === name);
    const apps = appsFor(name);
    // One result per requirement: every reported run of an unrestricted name, or each required
    // app's own run plus every same-name status context, which must pass as well. A status context
    // names no app here, so it also stands in for a required app that has no run.
    const statuses = named.filter((node) => node.kind === "StatusContext");
    const results: Array<CheckState | undefined> = apps
      ? [
        ...apps.map((app) => requiredNodeState(named.find((node) => node.kind === "CheckRun" && node.appId === app) ?? statuses[0])),
        ...statuses.map(requiredNodeState),
      ]
      : named.length > 0 ? named.map(requiredNodeState) : [undefined];
    const state: CheckState = results.includes("failed") ? "failed"
      : results.every((result) => result === "passed") ? "passed" : "pending";
    return { name: clip(name, MAX_NAME), state, reported: results.every((result) => result !== undefined) };
  });
  const other = { passed: 0, failed: 0, pending: 0 };
  const failed: FailedJob[] = [];
  for (const node of latest.values()) {
    const isRequired = required.has(node.name) && counts(node, node.name);
    if (!isRequired) other[node.state]++;
    if (node.state === "failed") {
      failed.push({ name: clip(node.name, MAX_NAME), required: isRequired, conclusion: node.conclusion, ...(node.url ? { url: node.url } : {}) });
    }
  }
  failed.sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name));
  const truncated = moreContexts || requiredList.length > MAX_LISTED_CHECKS || failed.length > MAX_FAILED_JOBS;
  const requiredState = requiredList.length === 0 ? "none"
    : requiredList.some((check) => check.state === "failed") ? "failed"
    : requiredList.every((check) => check.state === "passed") ? "passed"
    : "pending";
  return {
    summary: {
      sha,
      required: requiredList.slice(0, MAX_LISTED_CHECKS),
      other,
      failedJobs: failed.slice(0, MAX_FAILED_JOBS),
      ...(truncated ? { truncated: true as const } : {}),
    },
    requiredState,
    complete: !moreContexts,
  };
}

export function summarizeCommitChecks(
  sha: string,
  rollup: unknown,
  requiredNames: readonly string[],
  requiredApps: Readonly<Record<string, readonly number[]>> = {},
  mergeStateStatus?: string | null,
  admittedSkippedRuns?: ReadonlySet<number>,
): CommitChecksSummary {
  return evaluateCommitChecks(sha, rollup, requiredNames, requiredApps, mergeStateStatus, admittedSkippedRuns).summary;
}

interface Observation {
  url: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  headSha: string;
  baseRef: string;
  defaultBranch: string | null;
  mergeStateStatus: string | null;
  mergeCommitSha: string | null;
  queue: null | { state: string; position: number | null; enqueuedAt: string | null; headSha: string | null; rollup: unknown };
  rollup: unknown;
  /** The commit `rollup` belongs to. */
  rollupSha: string | null;
  /** Latest ready event, or creation for a PR with a known empty ready-event timeline. */
  admittedAfter: number | null;
  admittedSkippedRuns?: ReadonlySet<number>;
}

function observation(data: unknown): Observation | null {
  const repository = record(record(data)?.repository);
  const pr = record(repository?.pullRequest);
  if (!pr) return null;
  const state = pr.state === "OPEN" ? "open" : pr.state === "CLOSED" ? "closed" : pr.state === "MERGED" ? "merged" : null;
  if (!state || typeof pr.headRefOid !== "string" || !SHA.test(pr.headRefOid) ||
      typeof pr.baseRefName !== "string" || !pr.baseRefName || typeof pr.url !== "string") return null;
  const commit = record(record((record(pr.commits)?.nodes as unknown[] | undefined)?.[0])?.commit);
  const entry = record(pr.mergeQueueEntry);
  const entryHead = record(entry?.headCommit);
  const defaultBranch = record(repository?.defaultBranchRef)?.name;
  const mergeCommit = record(pr.mergeCommit)?.oid;
  const readyEvents = record(pr.timelineItems)?.nodes;
  const admittedAfter = Array.isArray(readyEvents)
    ? timestamp(readyEvents.length === 0 ? pr.createdAt : record(readyEvents[0])?.createdAt) : null;
  return {
    url: clip(pr.url, MAX_URL),
    state,
    isDraft: pr.isDraft === true,
    headSha: pr.headRefOid,
    baseRef: pr.baseRefName,
    defaultBranch: typeof defaultBranch === "string" ? clip(defaultBranch, MAX_NAME) : null,
    mergeStateStatus: typeof pr.mergeStateStatus === "string" ? pr.mergeStateStatus : null,
    mergeCommitSha: typeof mergeCommit === "string" && SHA.test(mergeCommit) ? mergeCommit : null,
    queue: entry
      ? {
          state: typeof entry.state === "string" ? entry.state : "UNKNOWN",
          position: Number.isSafeInteger(entry.position) ? entry.position as number : null,
          enqueuedAt: typeof entry.enqueuedAt === "string" ? entry.enqueuedAt : null,
          headSha: typeof entryHead?.oid === "string" && SHA.test(entryHead.oid) ? entryHead.oid : null,
          rollup: entryHead?.statusCheckRollup ?? null,
        }
      : null,
    rollup: commit?.statusCheckRollup ?? null,
    rollupSha: typeof commit?.oid === "string" && SHA.test(commit.oid) ? commit.oid : null,
    admittedAfter,
  };
}

/** Optional provenance must never turn an otherwise usable PR observation into an error. */
async function provenanceRead(gh: GhRunner, path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await gh(["api", "--hostname", "github.com", path]);
    const body = response.code === null && !response.timedOut ? record(parseJson(response.stdout)) : null;
    return body && (body.errors === undefined || (Array.isArray(body.errors) && body.errors.length === 0)) ? body : null;
  } catch {
    return null;
  }
}

/** Only conditional skips with complete, current Actions provenance can pass independently of
 * aggregate merge state. A bounded REST read sees newer runs before they create any jobs, and
 * per-attempt job reads bind each skipped check to that attempt rather than a suite's latest one.
 * A denied read, truncated list, missing timeline, or same-second admission cannot prove freshness.
 */
async function admittedSkippedRuns(
  gh: GhRunner, repository: string, seen: Observation, required: RequiredChecks,
): Promise<ReadonlySet<number>> {
  const admitted = new Set<number>();
  if (seen.isDraft || seen.queue || seen.mergeStateStatus !== "BLOCKED" || seen.admittedAfter === null ||
      seen.rollupSha !== seen.headSha) return admitted;
  const contexts = record(record(seen.rollup)?.contexts);
  const nodes = (Array.isArray(contexts?.nodes) ? contexts.nodes : []).map(checkNode);
  const latest = new Map<string, CheckNode>();
  for (const node of nodes) {
    if (!node || node.kind !== "CheckRun" || (!required.names.includes(node.name) && !node.isRequired)) continue;
    const apps = Object.hasOwn(required.apps, node.name) ? required.apps[node.name] : undefined;
    if (apps && (node.appId === undefined || !apps.includes(node.appId))) continue;
    const key = `${apps ? node.appId : ""}\0${node.name}`;
    const previous = latest.get(key);
    if (!previous || newer(node, previous)) latest.set(key, node);
  }
  const candidates = [...latest.values()].filter((node) => node.conclusion === "SKIPPED" && positiveId(node.id));
  if (candidates.length === 0 || candidates.length > MAX_SKIP_PROVENANCE_CHECKS) return admitted;
  const possible = new Set(candidates.map((check) => check.id!));
  const checks = evaluateCommitChecks(seen.headSha, seen.rollup, required.names, required.apps, seen.mergeStateStatus, possible);
  if (!checks.complete || checks.requiredState !== "passed") return admitted;
  // The common success/failure/missing-check/optional-skip paths never need this extra request.
  const body = await provenanceRead(gh, `repos/${repository}/actions/runs?head_sha=${seen.headSha}&per_page=100`);
  const runs = body?.workflow_runs;
  if (!Array.isArray(runs) || body?.total_count !== runs.length || runs.length > 100) return admitted;
  const records = runs.map(record);
  if (records.some((run) => !run || !positiveId(run.id) || !positiveId(run.workflow_id) || !positiveId(run.check_suite_id) ||
      !positiveId(run.run_attempt) || run.head_sha !== seen.headSha || timestamp(run.created_at) === null ||
      typeof run.event !== "string" || typeof run.status !== "string")) return admitted;
  const eligibleEvents = new Set(["push", "pull_request", "pull_request_target", "pull_request_review", "deployment", "deployment_status"]);
  const attempts = new Map<string, unknown[]>();
  for (const check of candidates) {
    const detail = await provenanceRead(gh, `repos/${repository}/check-runs/${check.id}`);
    const suiteId = record(detail?.check_suite)?.id;
    if (detail?.id !== check.id || detail?.head_sha !== seen.headSha || detail?.name !== check.name ||
        detail?.status !== "completed" || detail?.conclusion !== "skipped" || !positiveId(suiteId)) continue;
    const matching = records.filter((run) => run!.check_suite_id === suiteId);
    const current = matching.length === 1 ? matching[0] : null;
    if (!current || !eligibleEvents.has(current.event as string) || current.status !== "completed" ||
        timestamp(current.created_at)! <= seen.admittedAfter) continue;
    if (records.some((run) => run!.workflow_id === current.workflow_id && run!.id !== current.id &&
        ((run!.id as number) > (current.id as number) || timestamp(run!.created_at)! >= timestamp(current.created_at)!))) continue;
    const key = `${current.id}:${current.run_attempt}`;
    if (!attempts.has(key)) {
      // Bound total extra reads even when many required workflows report skips.
      if (attempts.size >= MAX_SKIP_PROVENANCE_CHECKS) return new Set();
      const jobsBody = await provenanceRead(gh,
        `repos/${repository}/actions/runs/${current.id}/attempts/${current.run_attempt}/jobs?per_page=100`);
      const jobs = jobsBody?.jobs;
      attempts.set(key, Array.isArray(jobs) && jobsBody?.total_count === jobs.length && jobs.length <= 100 ? jobs : []);
    }
    // This job list already came from the requested repository/run/attempt. Check ids are global;
    // canonical owner/name casing or a repository redirect must not invalidate that identity.
    const exactJob = attempts.get(key)!.map(record).find((job) => {
      const match = typeof job?.check_run_url === "string"
        ? /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/check-runs\/(\d+)$/u.exec(job.check_run_url) : null;
      return Number(match?.[1]) === check.id;
    });
    if (exactJob && exactJob.run_attempt === current.run_attempt && exactJob.status === "completed" &&
        exactJob.conclusion === "skipped" && exactJob.name === check.name) admitted.add(check.id!);
  }
  return admitted;
}

type Read<T> = { ok: true; value: T } | { ok: false; retryable: boolean; error: string };

/** One GraphQL read. An answer carrying any error is never trusted: a partial answer can null an
 * outcome field such as mergeQueueEntry. Rate limits, transport failures, and partial answers are
 * retryable. */
async function graphqlRead<T>(gh: GhRunner, args: string[], what: string, parse: (data: unknown) => T | null): Promise<Read<T>> {
  const outcome = await gh(["api", "graphql", "--hostname", "github.com", ...args]);
  const response = record(parseJson(outcome.stdout));
  const errors = Array.isArray(response?.errors) ? response.errors.map(record) : [];
  const value = parse(response?.data);
  if (value !== null && errors.length === 0) return { ok: true, value };
  const retryable = errors.some((error) => error?.type === "RATE_LIMITED") || value !== null ||
    (outcome.code !== null && transient(outcome));
  const message = errors.map((error) => typeof error?.message === "string" ? error.message : "").find(Boolean);
  return {
    ok: false,
    retryable,
    error: message ? `${what}: ${clip(message, 200)}`
      : outcome.code === null ? `${what}: unexpected response` : ghError(what, outcome),
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback));
}

async function cancellableSleep(deps: PullRequestWaitDeps, milliseconds: number): Promise<boolean> {
  const sleep = deps.sleep ?? ((duration: number) => new Promise<void>((resolve) => setTimeout(resolve, duration)));
  const signal = deps.signal;
  if (!signal) {
    await sleep(milliseconds);
    return true;
  }
  if (signal.aborted) return false;
  let onAbort!: () => void;
  const cancelled = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([sleep(milliseconds).then(() => true), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Wait for an outcome. Every observation is a read; the loop sleeps between them, so a caller
 * blocked here makes no model requests until this returns. */
export async function waitForPullRequest(input: PullRequestWaitInput, deps: PullRequestWaitDeps): Promise<PullRequestWaitResult> {
  const repo = githubRepository({ repository: input.repository, number: input.number });
  const ref = repo ? { ...repo, number: input.number } : null;
  if (!ref) return { ok: false, error: "a valid GitHub repository and pull request number are required" };
  if (input.headSha !== undefined && !SHA.test(input.headSha)) return { ok: false, error: "headSha must be a full 40-character commit SHA" };
  const timeoutMs = clampInteger(input.timeoutMs, PULL_REQUEST_WAIT_DEFAULT_TIMEOUT_MS, 1, PULL_REQUEST_WAIT_MAX_TIMEOUT_MS);
  const intervalMs = clampInteger(input.intervalMs, PULL_REQUEST_WAIT_DEFAULT_INTERVAL_MS,
    PULL_REQUEST_WAIT_MIN_INTERVAL_MS, PULL_REQUEST_WAIT_MAX_INTERVAL_MS);
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = started + timeoutMs;
  const repository = `${ref.owner}/${ref.name}`;
  let expectedHead = input.headSha;
  let required: ({ base: string } & RequiredChecks) | null = null;
  let sawQueue = false;
  /** When the queue entry was first seen missing without a merge; null while it is present. */
  let vanishedAt: number | null = null;
  let transientFailures = 0;
  let polls = 0;

  const summarize = (outcome: PullRequestWaitOutcome, seen: Observation): PullRequestWaitSummary => ({
    outcome,
    repository,
    number: ref.number,
    url: seen.url,
    state: seen.state,
    merged: seen.state === "merged",
    mergeCommitSha: seen.mergeCommitSha,
    isDraft: seen.isDraft,
    headSha: seen.headSha,
    baseRef: clip(seen.baseRef, MAX_NAME),
    defaultBranch: seen.defaultBranch,
    mergeStateStatus: seen.mergeStateStatus,
    requiredCheckNames: required ? required.names.slice(0, MAX_LISTED_CHECKS).map((name) => clip(name, MAX_NAME)) : null,
    checks: summarizeCommitChecks(seen.headSha, seen.rollup, required?.names ?? [], required?.apps, seen.mergeStateStatus, seen.admittedSkippedRuns),
    mergeQueue: seen.queue
      ? {
          state: seen.queue.state,
          position: seen.queue.position,
          enqueuedAt: seen.queue.enqueuedAt,
          checks: seen.queue.headSha
            ? summarizeCommitChecks(seen.queue.headSha, seen.queue.rollup, required?.names ?? [], required?.apps)
            : null,
        }
      : null,
    waitedMs: Math.max(0, now() - started),
    polls,
  });

  // Sleep until the next poll; false when cancelled. A transient failure retries on the same pace.
  const pause = async (milliseconds: number): Promise<boolean> => {
    const remaining = deadline - now();
    if (remaining <= 0) return true;
    return cancellableSleep(deps, Math.min(milliseconds, remaining));
  };

  // Every read shares one budget, so the call returns within the timeout plus one read's grace: no
  // read starts once it is spent, and one still in flight then is killed (reads have no effects).
  const stopAt = deadline + (deps.readGraceMs ?? PULL_REQUEST_WAIT_READ_GRACE_MS);
  const gh: GhRunner = async (args) => {
    const budget = stopAt - now();
    if (deps.signal?.aborted || budget <= 0) return BUDGET_SPENT;
    const read = new AbortController();
    const cancel = () => read.abort();
    deps.signal?.addEventListener("abort", cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const spent = new Promise<GhOutcome>((resolve) => {
      timer = setTimeout(() => {
        read.abort();
        resolve(BUDGET_SPENT);
      }, budget);
      timer.unref?.();
    });
    try {
      return await Promise.race([deps.gh(args, read.signal), spent]);
    } finally {
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", cancel);
    }
  };
  /** The latest complete observation, reported if a read fails once the timeout has passed. */
  let last: Observation | null = null;
  const what = `could not read ${repository}#${ref.number}`;
  const variables = ["-f", `owner=${ref.owner}`, "-f", `name=${ref.name}`, "-F", `number=${ref.number}`];

  /** Append further pages of one commit's contexts, up to MAX_CONTEXT_PAGES in all. */
  const completeContexts = async (rollup: unknown, sha: string | null): Promise<Read<unknown>> => {
    const contexts = record(record(rollup)?.contexts);
    if (!sha || !contexts) return { ok: true, value: rollup };
    const nodes = Array.isArray(contexts.nodes) ? [...contexts.nodes] : [];
    let pageInfo = record(contexts.pageInfo);
    for (let page = 1; page < MAX_CONTEXT_PAGES && pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === "string"; page++) {
      if (deps.signal?.aborted) break;
      const read = await graphqlRead(gh, [
        "-f", `query=${PULL_REQUEST_CONTEXTS_QUERY}`, ...variables, "-f", `oid=${sha}`, "-f", `after=${pageInfo.endCursor}`,
      ], what, (data) => {
        const more = record(record(record(record(record(data)?.repository)?.object)?.statusCheckRollup)?.contexts);
        return more && Array.isArray(more.nodes) && record(more.pageInfo) ? more : null;
      });
      if (!read.ok) return read;
      nodes.push(...read.value.nodes as unknown[]);
      pageInfo = record(read.value.pageInfo);
    }
    return { ok: true, value: { ...record(rollup), contexts: { pageInfo: { hasNextPage: pageInfo?.hasNextPage === true }, nodes } } };
  };

  const read = async (): Promise<Read<Observation>> => {
    const main = await graphqlRead(gh, ["-f", `query=${PULL_REQUEST_WAIT_QUERY}`, ...variables], what, observation);
    if (!main.ok || main.value.state !== "open") return main;
    const seen = main.value;
    const head = await completeContexts(seen.rollup, seen.rollupSha);
    if (!head.ok) return head;
    const group = seen.queue ? await completeContexts(seen.queue.rollup, seen.queue.headSha) : null;
    if (group && !group.ok) return group;
    return {
      ok: true,
      value: { ...seen, rollup: head.value, ...(seen.queue && group ? { queue: { ...seen.queue, rollup: group.value } } : {}) },
    };
  };

  for (;;) {
    if (deps.signal?.aborted) return { ok: false, error: "request cancelled" };
    polls++;
    const result = await read();
    if (deps.signal?.aborted) return { ok: false, error: "request cancelled" };
    if (!result.ok) {
      if (result.retryable && ++transientFailures <= MAX_TRANSIENT_FAILURES && now() < deadline) {
        if (!await pause(intervalMs)) return { ok: false, error: "request cancelled" };
        continue;
      }
      if (last && now() >= deadline) return { ok: true, summary: summarize("timeout", last) };
      return { ok: false, error: result.error };
    }
    const seen = result.value;

    if (seen.state === "merged") return { ok: true, summary: summarize("merged", seen) };
    if (seen.state === "closed") return { ok: true, summary: summarize("closed", seen) };
    if (expectedHead && seen.headSha !== expectedHead) return { ok: true, summary: summarize("head_changed", seen) };
    expectedHead = seen.headSha;

    if (!required || required.base !== seen.baseRef) {
      const names = await requiredCheckNames(gh, repository, seen.baseRef, deps.signal);
      if (deps.signal?.aborted) return { ok: false, error: "request cancelled" };
      if (!names.ok) {
        if (names.transient && ++transientFailures <= MAX_TRANSIENT_FAILURES && now() < deadline) {
          if (!await pause(intervalMs)) return { ok: false, error: "request cancelled" };
          continue;
        }
        if (last && now() >= deadline) return { ok: true, summary: summarize("timeout", last) };
        return { ok: false, error: names.error };
      }
      required = { base: seen.baseRef, names: names.names, apps: names.apps };
    }
    // Only a complete observation, rules included, resets the transient-failure budget.
    transientFailures = 0;
    last = seen;

    if (seen.queue) {
      sawQueue = true;
      vanishedAt = null;
      // A failed merge-group check is not GitHub's verdict: when an entry ahead caused it, GitHub
      // drops that entry and rebuilds this one's group on a new commit. Only GitHub giving up ends
      // the wait: the entry reads UNMERGEABLE, or it leaves the queue unmerged (confirmed below).
      if (seen.queue.state === "UNMERGEABLE") return { ok: true, summary: summarize("queue_failed", seen) };
    } else if (sawQueue) {
      // GitHub can drop the entry a moment before the pull request reads MERGED, so an ejection
      // stands only once the entry has stayed missing for the whole confirmation interval.
      vanishedAt ??= now();
      const missingFor = now() - vanishedAt;
      if (missingFor >= EJECTION_CONFIRM_MS) return { ok: true, summary: summarize("queue_ejected", seen) };
      // Unconfirmed at the deadline: report a timeout rather than an ejection that may be a merge.
      if (now() >= deadline) return { ok: true, summary: summarize("timeout", seen) };
      if (!await pause(EJECTION_CONFIRM_MS - missingFor)) return { ok: false, error: "request cancelled" };
      continue;
    } else {
      const initial = evaluateCommitChecks(seen.headSha, seen.rollup, required.names, required.apps, seen.mergeStateStatus);
      if (initial.requiredState === "pending" && initial.complete &&
          !(input.returnOnAnyFailure && initial.summary.failedJobs.length > 0)) {
        seen.admittedSkippedRuns = await admittedSkippedRuns(gh, repository, seen, required);
        if (deps.signal?.aborted) return { ok: false, error: "request cancelled" };
      }
      const checks = evaluateCommitChecks(seen.headSha, seen.rollup, required.names, required.apps, seen.mergeStateStatus, seen.admittedSkippedRuns);
      if (checks.requiredState === "failed" || (input.returnOnAnyFailure && checks.summary.failedJobs.length > 0)) {
        return { ok: true, summary: summarize("checks_failed", seen) };
      }
      if (checks.requiredState === "none") return { ok: true, summary: summarize("no_required_checks", seen) };
      // Past one page of contexts an unseen one could still fail, so a pass then also needs GitHub's
      // own merge state to confirm that every requirement is met.
      if (checks.requiredState === "passed" && (checks.complete || REQUIREMENTS_MET.has(seen.mergeStateStatus ?? ""))) {
        return { ok: true, summary: summarize("checks_passed", seen) };
      }
    }

    if (now() >= deadline) return { ok: true, summary: summarize("timeout", seen) };
    // The read after the final pause lands at the deadline, so a timeout summary is current.
    if (!await pause(intervalMs)) return { ok: false, error: "request cancelled" };
  }
}
