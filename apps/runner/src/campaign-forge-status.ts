/**
 * Campaign forge status (#2417 slice 8, docs/campaign-work-ledger.md "Forge Status"): read the
 * GitHub pull requests a campaign's work items name, through this runner's existing `gh` login.
 *
 * Read-only and status-only. One `gh api graphql` call reads a whole batch. Nothing `gh` prints is
 * returned: every failure is reduced to a fixed reason, and every value is validated against the
 * wire shape, so an unexpected answer becomes `forge_error` rather than a guessed status.
 */
import type {
  AgentContext,
  CampaignForgeCheckRollup,
  CampaignForgeMergeQueueState,
  CampaignForgeObservationFailure,
  CampaignForgeObserveResultMessage,
  CampaignForgePullRequestObservation,
  CampaignPullRequestRef,
} from "@wollipog/protocol";
import { CAMPAIGN_FORGE_OBSERVATION } from "@wollipog/protocol";
import { runContextCommand } from "./context-command.js";
import { summarizeCheckRollup } from "./git-ops.js";

/** Contexts read per pull request. More than this leaves the required rollup `unknown`. */
const CONTEXTS_PER_PULL_REQUEST = 100;
const GH_TIMEOUT_MS = 30_000;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const NAME = /^[A-Za-z0-9._-]{1,100}$/u;

/** The outcome of one `gh` invocation: what it printed, or how it failed. */
export interface GhOutcome {
  stdout: string;
  stderr: string;
  /** Exit code, a spawn error code such as `ENOENT`, or null on success. */
  code: number | string | null;
  /** Killed by the timeout. */
  timedOut: boolean;
}

export type GhRunner = (args: string[]) => Promise<GhOutcome>;

export function contextGhRunner(context: AgentContext, cwd: string): GhRunner {
  return async (args) => {
    try {
      const { stdout, stderr } = await runContextCommand(context, "gh", args, {
        cwd,
        timeoutMs: GH_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" },
      });
      return { stdout, stderr, code: null, timedOut: false };
    } catch (error) {
      const failure = error as { stdout?: unknown; stderr?: unknown; code?: unknown; killed?: unknown; signal?: unknown };
      return {
        stdout: typeof failure.stdout === "string" ? failure.stdout : "",
        stderr: typeof failure.stderr === "string" ? failure.stderr : String((error as Error)?.message ?? ""),
        code: typeof failure.code === "number" || typeof failure.code === "string" ? failure.code : 1,
        timedOut: failure.killed === true || typeof failure.signal === "string",
      };
    }
  };
}

/** A GitHub `owner/name` this runner may put in a query, or null. */
export function githubRepository(ref: CampaignPullRequestRef): { owner: string; name: string } | null {
  if (typeof ref?.repository !== "string" || !Number.isSafeInteger(ref.number) || ref.number < 1) return null;
  const [owner, name, extra] = ref.repository.split("/");
  if (extra !== undefined || !owner || !name || !OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") {
    return null;
  }
  return { owner, name };
}

/** One aliased query for the batch. Owner, name, and number are validated first, so inlining them
 * as GraphQL literals (JSON string syntax) cannot change the query's shape. */
export function forgeStatusQuery(refs: ReadonlyArray<{ owner: string; name: string; number: number }>): string {
  const fields = refs.map((ref, index) => `r${index}: repository(owner:${JSON.stringify(ref.owner)},name:${JSON.stringify(ref.name)}){
    pullRequest(number:${ref.number}){
      state isDraft headRefOid baseRefName reviewDecision mergeStateStatus
      mergeCommit{oid}
      mergeQueueEntry{position state}
      commits(last:1){nodes{commit{statusCheckRollup{state
        contexts(first:${CONTEXTS_PER_PULL_REQUEST}){pageInfo{hasNextPage} nodes{
          __typename
          ... on CheckRun{name status conclusion isRequired(pullRequestNumber:${ref.number})}
          ... on StatusContext{context state isRequired(pullRequestNumber:${ref.number})}
        }}
      }}}}
    }
  }`);
  return `query{\n  ${fields.join("\n  ")}\n}`;
}

/** Reduce a failed `gh` run to a fixed reason. Matching is on `gh`'s and Go's own error words. */
export function classifyGhFailure(outcome: Pick<GhOutcome, "stderr" | "code" | "timedOut">): CampaignForgeObservationFailure {
  const text = outcome.stderr;
  if (outcome.code === "ENOENT") return "forge_cli_missing";
  // WSL runs `gh` through wsl.exe, which reports a missing program in its own words.
  if (/execvpe?\(gh\) failed|gh: (?:command )?not found|'gh' is not recognized/iu.test(text)) return "forge_cli_missing";
  if (outcome.timedOut) return "forge_unreachable";
  if (outcome.code === 4 || /gh auth login|Bad credentials|HTTP 401|authentication required|not logged in/iu.test(text)) {
    return "forge_unauthenticated";
  }
  if (/rate limit|HTTP 429/iu.test(text)) return "forge_rate_limited";
  if (/error connecting to|dial tcp|no such host|connection refused|connection reset|i\/o timeout|TLS handshake|network is unreachable|proxyconnect|could not resolve host|context deadline exceeded/iu.test(text)) {
    return "forge_unreachable";
  }
  return "forge_error";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const REVIEW: Record<string, CampaignForgePullRequestObservation["reviewDecision"]> = {
  APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required",
};
const STATE: Record<string, CampaignForgePullRequestObservation["state"]> = { OPEN: "open", CLOSED: "closed", MERGED: "merged" };
const QUEUE: Record<string, CampaignForgeMergeQueueState> = {
  QUEUED: "queued", AWAITING_CHECKS: "awaiting_checks", MERGEABLE: "mergeable", UNMERGEABLE: "unmergeable", LOCKED: "locked",
};

function rollupState(counts: { failing: number; pending: number; passing: number }, complete: boolean): CampaignForgeCheckRollup["state"] {
  if (counts.failing > 0) return "failing";
  if (!complete) return "unknown";
  if (counts.pending > 0) return "pending";
  return counts.passing > 0 ? "passing" : "none";
}

/** `mergeStateStatus` values under which GitHub has every required check reported and passing.
 * Anything else (BLOCKED, BEHIND, DRAFT, DIRTY, UNKNOWN while GitHub computes) cannot confirm it. */
const REQUIREMENTS_MET = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/**
 * Fail closed: a check counts as passing only on GitHub's known-good results. A required check
 * that has not reported yet has no node at all, and branch rulesets are not readable here, so the
 * required checks seen can only read `passing` when GitHub's own merge state confirms nothing
 * required is missing (`requirementsMet`); otherwise they read `unknown`.
 */
export function checkRollups(
  rollup: unknown,
  requirementsMet = false,
): { checks: CampaignForgeCheckRollup; requiredChecks: CampaignForgeCheckRollup } | null {
  if (rollup === null) {
    const none: CampaignForgeCheckRollup = { state: "none", passing: 0, failing: 0, pending: 0 };
    return { checks: none, requiredChecks: none };
  }
  const value = record(rollup);
  const contexts = record(value?.contexts);
  const nodes = contexts?.nodes;
  const pageInfo = record(contexts?.pageInfo);
  if (!value || !Array.isArray(nodes) || typeof pageInfo?.hasNextPage !== "boolean") return null;
  const complete = pageInfo.hasNextPage === false;
  const all = summarizeCheckRollup(nodes);
  const required = summarizeCheckRollup(nodes.filter((node) => record(node)?.isRequired === true));
  // GitHub's own rollup state covers every check, even past the bounded page.
  const github = value.state;
  let overall: CampaignForgeCheckRollup["state"];
  if (all.failing > 0 || github === "FAILURE" || github === "ERROR") overall = "failing";
  else if (all.pending > 0 || github === "PENDING" || github === "EXPECTED") overall = "pending";
  else if (github === "SUCCESS") overall = "passing";
  else overall = "unknown";
  return {
    checks: { state: overall, passing: all.passing, failing: all.failing, pending: all.pending },
    requiredChecks: {
      state: ((state) => state === "passing" && !requirementsMet ? "unknown" : state)(rollupState(required, complete)),
      passing: required.passing,
      failing: required.failing,
      pending: required.pending,
    },
  };
}

/** Validate one pull request node into the wire shape, or null when anything is off. */
export function pullRequestObservation(node: unknown): CampaignForgePullRequestObservation | null {
  const pr = record(node);
  if (!pr) return null;
  const state = STATE[pr.state as string];
  const headSha = pr.headRefOid;
  const baseRef = pr.baseRefName;
  if (!state || typeof pr.isDraft !== "boolean" || typeof headSha !== "string" || !/^[0-9a-f]{40}$/u.test(headSha) ||
      typeof baseRef !== "string" || baseRef.length === 0 || baseRef.length > 256) return null;
  if (pr.reviewDecision !== null && !REVIEW[pr.reviewDecision as string]) return null;
  const mergeCommit = pr.mergeCommit === null ? null : record(pr.mergeCommit);
  if (pr.mergeCommit !== null && (typeof mergeCommit?.oid !== "string" || !/^[0-9a-f]{40}$/u.test(mergeCommit.oid))) return null;
  let mergeQueue: CampaignForgePullRequestObservation["mergeQueue"] = null;
  if (pr.mergeQueueEntry !== null && pr.mergeQueueEntry !== undefined) {
    const entry = record(pr.mergeQueueEntry);
    if (!entry || (entry.position !== null && (!Number.isSafeInteger(entry.position) || (entry.position as number) < 0))) return null;
    mergeQueue = { state: QUEUE[entry.state as string] ?? "unknown", position: entry.position as number | null };
  }
  const commits = record(pr.commits)?.nodes;
  if (!Array.isArray(commits) || commits.length > 1) return null;
  const commit = commits.length === 0 ? null : record(record(commits[0])?.commit);
  if (commits.length === 1 && !commit) return null;
  const rollups = checkRollups(commit ? commit.statusCheckRollup ?? null : null, REQUIREMENTS_MET.has(pr.mergeStateStatus as string));
  if (!rollups) return null;
  return {
    state,
    draft: pr.isDraft,
    headSha,
    baseRef,
    reviewDecision: pr.reviewDecision === null ? "none" : REVIEW[pr.reviewDecision as string]!,
    ...rollups,
    mergeQueue,
    mergeCommitSha: mergeCommit ? mergeCommit.oid as string : null,
  };
}

type Result = NonNullable<CampaignForgeObserveResultMessage["results"]>[number];
export type ForgeStatusOutcome =
  | { ok: true; results: Result[] }
  | { ok: false; failure: CampaignForgeObservationFailure };

/** Read every ref in one `gh` call. A malformed ref is `forge_unsupported` without being read. */
export async function observeForgeStatus(refs: readonly CampaignPullRequestRef[], gh: GhRunner): Promise<ForgeStatusOutcome> {
  if (!Array.isArray(refs) || refs.length > CAMPAIGN_FORGE_OBSERVATION.refsPerRequest) return { ok: false, failure: "forge_error" };
  const readable = refs.map((ref) => {
    const repository = githubRepository(ref);
    return repository ? { ...repository, number: ref.number } : null;
  });
  const queried = readable.flatMap((entry, index) => entry ? [{ ...entry, index }] : []);
  const unsupported = (ref: CampaignPullRequestRef): Result => ({ ref: { repository: String(ref?.repository), number: Number(ref?.number) }, ok: false, failure: "forge_unsupported" });
  if (queried.length === 0) return { ok: true, results: refs.map(unsupported) };
  const outcome = await gh(["api", "graphql", "--hostname", "github.com", "-f", `query=${forgeStatusQuery(queried)}`]);
  let response: Record<string, unknown> | null = null;
  try {
    response = record(JSON.parse(outcome.stdout));
  } catch {
    response = null;
  }
  const data = record(response?.data);
  if (!data) return { ok: false, failure: outcome.code === null ? "forge_error" : classifyGhFailure(outcome) };
  const errors = Array.isArray(response?.errors) ? response.errors.map(record).filter((error) => error !== null) : [];
  if (errors.some((error) => error.type === "RATE_LIMITED")) return { ok: false, failure: "forge_rate_limited" };
  const aliasErrors = new Map<string, string>();
  for (const error of errors) {
    const path = Array.isArray(error.path) ? error.path : [];
    if (typeof path[0] === "string" && !aliasErrors.has(path[0])) aliasErrors.set(path[0], String(error.type ?? ""));
  }
  const byIndex = new Map(queried.map((entry, position) => [entry.index, `r${position}`]));
  return {
    ok: true,
    results: refs.map((ref, index): Result => {
      const alias = byIndex.get(index);
      if (!alias) return unsupported(ref);
      const clean = { repository: ref.repository, number: ref.number };
      const node = record(data[alias])?.pullRequest;
      if (node === null || node === undefined) {
        const type = aliasErrors.get(alias);
        return { ref: clean, ok: false, failure: type === "NOT_FOUND" || type === "FORBIDDEN" || type === undefined ? "forge_not_found" : "forge_error" };
      }
      const observation = pullRequestObservation(node);
      return observation ? { ref: clean, ok: true, observation } : { ref: clean, ok: false, failure: "forge_error" };
    }),
  };
}
