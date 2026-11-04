/**
 * Merge request wait (#3602): the GitLab counterpart of pull-request-wait.ts. Block in the runner,
 * not in the model, until a GitLab merge request's pipeline or its merge-train car reaches an
 * outcome, then return one bounded summary.
 *
 * Read-only, through this runner's existing `glab` login, always naming the host. Each poll reads
 * the merge request (state, head, and its head pipeline, which is the merged-results pipeline where
 * the project runs them) and, while it is open, its merge-train car. Only a `success` pipeline
 * passes; a skipped one, or one waiting for a manual action, is `checks_blocked`, never passing. A
 * project that does not require a successful pipeline, with none on the merge request, returns
 * `no_required_checks` at once, as a GitHub base branch without required checks does.
 */
import type { CampaignGitLabMergeTrainStatus, CampaignGitLabPipelineStatus } from "@wollipog/protocol";
import { campaignRepositoryLocation } from "@wollipog/protocol";
import type { GhOutcome } from "./campaign-forge-status.js";
import { classifyGlabFailure, gitlabMergeTrainStatus, gitlabPipelineStatus, type GlabRunner } from "./campaign-gitlab-status.js";
import {
  PULL_REQUEST_WAIT_DEFAULT_INTERVAL_MS,
  PULL_REQUEST_WAIT_DEFAULT_TIMEOUT_MS,
  PULL_REQUEST_WAIT_MAX_INTERVAL_MS,
  PULL_REQUEST_WAIT_MAX_TIMEOUT_MS,
  PULL_REQUEST_WAIT_MIN_INTERVAL_MS,
  PULL_REQUEST_WAIT_READ_GRACE_MS,
  cancellableSleep,
  type PullRequestWaitOutcome,
} from "./pull-request-wait.js";

/** Consecutive transient `glab` failures (rate limit, network) tolerated before giving up. */
const MAX_TRANSIENT_FAILURES = 3;
/** Pause before confirming that a train car which vanished without a merge was really dropped. */
const EJECTION_CONFIRM_MS = 10_000;
const MAX_NAME = 120;
const MAX_URL = 300;
const SHA = /^[0-9a-f]{40}$/u;
const BUDGET_SPENT: GhOutcome = { stdout: "", stderr: "the wait's time budget is spent", code: "ETIMEDOUT", timedOut: true };

/** The pull request outcomes, plus `checks_blocked`: a skipped pipeline or one waiting for a
 * manual action, which will not finish on its own and never counts as passing. */
export type MergeRequestWaitOutcome = PullRequestWaitOutcome | "checks_blocked";

export interface MergeRequestWaitSummary {
  forge: "gitlab";
  outcome: MergeRequestWaitOutcome;
  /** `<host>/group[/subgroup…]/project`. */
  repository: string;
  /** The merge request IID. */
  number: number;
  url: string;
  state: "open" | "closed" | "merged";
  merged: boolean;
  /** The merge commit, or the squash commit of a squash merge without one. */
  mergeCommitSha: string | null;
  isDraft: boolean;
  headSha: string;
  /** The target branch. */
  baseRef: string;
  /** Whether the project only allows merging after a successful pipeline; null when unread. */
  pipelineRequired: boolean | null;
  /** GitLab's own reason the merge request can or cannot merge now, as GitLab spells it. */
  detailedMergeStatus: string | null;
  pipeline: { id: number; status: CampaignGitLabPipelineStatus; url?: string } | null;
  mergeTrain: null | {
    status: CampaignGitLabMergeTrainStatus;
    pipeline: { id: number; status: CampaignGitLabPipelineStatus } | null;
  };
  waitedMs: number;
  polls: number;
}

export interface MergeRequestWaitInput {
  repository: string;
  number: number;
  /** The head the caller reviewed; a different head returns `head_changed`. */
  headSha?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface MergeRequestWaitDeps {
  glab: GlabRunner;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  readGraceMs?: number;
}

export type MergeRequestWaitResult =
  | { ok: true; summary: MergeRequestWaitSummary }
  | { ok: false; error: string };

interface Observation {
  url: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  headSha: string;
  baseRef: string;
  mergeCommitSha: string | null;
  detailedMergeStatus: string | null;
  pipeline: MergeRequestWaitSummary["pipeline"];
  /** Undefined until read: a closed or merged merge request is not asked about the train. */
  train?: MergeRequestWaitSummary["mergeTrain"];
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string; retryable: boolean };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function pipelineOf(value: unknown, host: string): MergeRequestWaitSummary["pipeline"] | undefined {
  if (value === null || value === undefined) return null;
  const pipeline = record(value);
  if (!pipeline || !Number.isSafeInteger(pipeline.id) || (pipeline.id as number) < 1) return undefined;
  const url = typeof pipeline.web_url === "string" && pipeline.web_url.startsWith(`https://${host}/`)
    ? clip(pipeline.web_url, MAX_URL) : undefined;
  return { id: pipeline.id as number, status: gitlabPipelineStatus(pipeline.status), ...(url ? { url } : {}) };
}

/** Validate a merge request's detail into an observation, or null when anything is off. */
export function mergeRequestObservation(value: unknown, number: number, host: string): Observation | null {
  const mr = record(value);
  if (!mr || mr.iid !== number) return null;
  const state = mr.state === "opened" || mr.state === "locked" ? "open"
    : mr.state === "closed" ? "closed" : mr.state === "merged" ? "merged" : null;
  const isDraft = typeof mr.draft === "boolean" ? mr.draft : mr.work_in_progress;
  if (!state || typeof isDraft !== "boolean" || typeof mr.sha !== "string" || !SHA.test(mr.sha) ||
      typeof mr.target_branch !== "string" || mr.target_branch.length === 0 ||
      typeof mr.web_url !== "string" || !mr.web_url.startsWith(`https://${host}/`)) return null;
  const commit = (candidate: unknown) => candidate === null || candidate === undefined ? null
    : typeof candidate === "string" && SHA.test(candidate) ? candidate : undefined;
  const mergeCommit = commit(mr.merge_commit_sha);
  const squashCommit = commit(mr.squash_commit_sha);
  const pipeline = pipelineOf(mr.head_pipeline, host);
  if (mergeCommit === undefined || squashCommit === undefined || pipeline === undefined) return null;
  return {
    url: clip(mr.web_url, MAX_URL),
    state,
    isDraft,
    headSha: mr.sha,
    baseRef: clip(mr.target_branch, MAX_NAME),
    mergeCommitSha: mergeCommit ?? squashCommit,
    detailedMergeStatus: typeof mr.detailed_merge_status === "string" ? clip(mr.detailed_merge_status, MAX_NAME) : null,
    pipeline,
  };
}

/** Wait for one GitLab merge request. `repository` must be a host-qualified GitLab project. */
export async function waitForMergeRequest(input: MergeRequestWaitInput, deps: MergeRequestWaitDeps): Promise<MergeRequestWaitResult> {
  const location = campaignRepositoryLocation(input.repository);
  if (location?.forge !== "gitlab" || !Number.isSafeInteger(input.number) || input.number < 1) {
    return { ok: false, error: "a host-qualified GitLab project and merge request IID are required" };
  }
  if (input.headSha !== undefined && !SHA.test(input.headSha)) return { ok: false, error: "headSha must be a full 40-character commit SHA" };
  const host = location.host.toLowerCase();
  const project = encodeURIComponent(location.project);
  const timeoutMs = clampInteger(input.timeoutMs, PULL_REQUEST_WAIT_DEFAULT_TIMEOUT_MS, 1, PULL_REQUEST_WAIT_MAX_TIMEOUT_MS);
  const intervalMs = clampInteger(input.intervalMs, PULL_REQUEST_WAIT_DEFAULT_INTERVAL_MS,
    PULL_REQUEST_WAIT_MIN_INTERVAL_MS, PULL_REQUEST_WAIT_MAX_INTERVAL_MS);
  const now = deps.now ?? Date.now;
  const started = now();
  const deadline = started + timeoutMs;
  const what = `could not read ${input.repository}!${input.number}`;
  let expectedHead = input.headSha;
  let pipelineRequired: boolean | null = null;
  let sawTrain = false;
  let vanishedAt: number | null = null;
  let transientFailures = 0;
  let polls = 0;
  let last: Observation | null = null;

  const summarize = (outcome: MergeRequestWaitOutcome, seen: Observation): MergeRequestWaitSummary => ({
    forge: "gitlab",
    outcome,
    repository: input.repository,
    number: input.number,
    url: seen.url,
    state: seen.state,
    merged: seen.state === "merged",
    mergeCommitSha: seen.mergeCommitSha,
    isDraft: seen.isDraft,
    headSha: seen.headSha,
    baseRef: seen.baseRef,
    pipelineRequired,
    detailedMergeStatus: seen.detailedMergeStatus,
    pipeline: seen.pipeline,
    mergeTrain: seen.train ?? null,
    waitedMs: Math.max(0, now() - started),
    polls,
  });

  const pause = async (milliseconds: number): Promise<boolean> => {
    const remaining = deadline - now();
    if (remaining <= 0) return true;
    return cancellableSleep(deps, Math.min(milliseconds, remaining));
  };

  // Every read shares one budget, as in the GitHub wait: no read starts once it is spent, and one
  // still in flight then is killed (reads have no effects).
  const stopAt = deadline + (deps.readGraceMs ?? PULL_REQUEST_WAIT_READ_GRACE_MS);
  const glab = async (path: string): Promise<GhOutcome> => {
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
      return await Promise.race([deps.glab(["api", path, "--hostname", host], read.signal), spent]);
    } finally {
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", cancel);
    }
  };
  const api = async (path: string, missing?: "absent"): Promise<Read<unknown> | { ok: true; value: undefined }> => {
    const outcome = await glab(path);
    if (outcome.code !== null) {
      const failure = classifyGlabFailure(outcome);
      if (missing && failure === "forge_not_found") return { ok: true, value: undefined };
      const retryable = failure === "forge_unreachable" || failure === "forge_rate_limited";
      const words: Record<string, string> = {
        forge_cli_missing: "glab is not installed in this context",
        forge_unauthenticated: `glab is not signed in to ${host}`,
        forge_unreachable: `${host} could not be reached`,
        forge_rate_limited: `${host} rate-limited this glab login`,
        forge_not_found: "the merge request does not exist or this glab login cannot see it",
      };
      return { ok: false, error: `${what}: ${words[failure] ?? "GitLab returned an error"}`, retryable };
    }
    try {
      return { ok: true, value: JSON.parse(outcome.stdout) as unknown };
    } catch {
      return { ok: false, error: `${what}: GitLab returned an unexpected answer`, retryable: false };
    }
  };

  const read = async (): Promise<Read<Observation>> => {
    const detail = await api(`projects/${project}/merge_requests/${input.number}`);
    if (!detail.ok) return detail;
    const seen = mergeRequestObservation(detail.value, input.number, host);
    if (!seen) return { ok: false, error: `${what}: GitLab returned an unexpected answer`, retryable: false };
    if (seen.state !== "open") return { ok: true, value: seen };
    if (pipelineRequired === null) {
      const settings = await api(`projects/${project}`);
      if (!settings.ok) return settings;
      const flag = record(settings.value)?.only_allow_merge_if_pipeline_succeeds;
      if (typeof flag !== "boolean") return { ok: false, error: `${what}: GitLab returned an unexpected answer`, retryable: false };
      pipelineRequired = flag;
    }
    // Not on a train, or a project or tier without trains, both read 404 or 403.
    const car = await api(`projects/${project}/merge_trains/merge_requests/${input.number}`, "absent");
    if (!car.ok) return car;
    if (car.value === undefined) return { ok: true, value: { ...seen, train: null } };
    const entry = record(car.value);
    const pipeline = pipelineOf(entry?.pipeline, host);
    if (!entry || typeof entry.status !== "string" || pipeline === undefined) {
      return { ok: false, error: `${what}: GitLab returned an unexpected answer`, retryable: false };
    }
    return {
      ok: true,
      value: { ...seen, train: { status: gitlabMergeTrainStatus(entry.status), pipeline: pipeline && { id: pipeline.id, status: pipeline.status } } },
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
    transientFailures = 0;
    const seen = result.value;
    last = seen;

    if (seen.state === "merged") return { ok: true, summary: summarize("merged", seen) };
    if (seen.state === "closed") return { ok: true, summary: summarize("closed", seen) };
    if (expectedHead && seen.headSha !== expectedHead) return { ok: true, summary: summarize("head_changed", seen) };
    expectedHead = seen.headSha;

    if (seen.train) {
      sawTrain = true;
      vanishedAt = null;
      // A failed train pipeline drops the merge request from the train; GitLab, not this wait,
      // decides whether it rejoins.
      const status = seen.train.pipeline?.status;
      if (status === "failed" || status === "canceled") return { ok: true, summary: summarize("queue_failed", seen) };
      // A train pipeline waiting for a manual action, or skipped, will not finish on its own either.
      if (status === "skipped" || status === "manual") return { ok: true, summary: summarize("checks_blocked", seen) };
    } else if (sawTrain) {
      // The car can go a moment before the merge request reads merged, so a drop stands only once
      // the car has stayed missing for the whole confirmation interval.
      vanishedAt ??= now();
      const missingFor = now() - vanishedAt;
      if (missingFor >= EJECTION_CONFIRM_MS) return { ok: true, summary: summarize("queue_ejected", seen) };
      if (now() >= deadline) return { ok: true, summary: summarize("timeout", seen) };
      if (!await pause(EJECTION_CONFIRM_MS - missingFor)) return { ok: false, error: "request cancelled" };
      continue;
    } else {
      const status = seen.pipeline?.status;
      if (status === "success") return { ok: true, summary: summarize("checks_passed", seen) };
      if (status === "failed" || status === "canceled") return { ok: true, summary: summarize("checks_failed", seen) };
      if (status === "skipped" || status === "manual") return { ok: true, summary: summarize("checks_blocked", seen) };
      if (!seen.pipeline && pipelineRequired === false) return { ok: true, summary: summarize("no_required_checks", seen) };
    }

    if (now() >= deadline) return { ok: true, summary: summarize("timeout", seen) };
    if (!await pause(intervalMs)) return { ok: false, error: "request cancelled" };
  }
}
