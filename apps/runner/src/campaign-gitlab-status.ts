/**
 * Campaign forge status for GitLab (#3600, docs/campaign-work-ledger.md "Forge Status"): read the
 * GitLab merge requests a campaign's work items name, through this runner's existing `glab` login.
 *
 * The same contract as the GitHub read: read-only and status-only, nothing `glab` prints is
 * returned, and every value is validated against the wire shape, so an unexpected answer becomes
 * `forge_error` rather than a guessed status. A host is read only when it is gitlab.com or global
 * `glab` configuration names it (the forge summary's own check), so a generic Git server is never
 * probed. A host that fails as a whole (not signed in, unreachable, rate limited, no `glab`) is not
 * asked again within the same read, so one slow instance cannot hold the whole answer.
 */
import type {
  AgentContext,
  CampaignForgeGitLabMergeRequestObservation,
  CampaignForgeObservationFailure,
  CampaignGitLabMergeTrainStatus,
  CampaignGitLabPipelineStatus,
  CampaignPullRequestRef,
} from "@wollipog/protocol";
import { campaignRepositoryLocation } from "@wollipog/protocol";
import type { GhOutcome } from "./campaign-forge-status.js";
import { runContextCommand } from "./context-command.js";

const GLAB_TIMEOUT_MS = 15_000;
/** Merge requests read at once within one runner request. */
const CONCURRENT_READS = 4;
/** Train cars read to find a merge request's position; beyond this the position is unknown. */
const TRAIN_CARS_READ = 100;

/** Runs `glab`; aborting `signal` kills the process. */
export type GlabRunner = (args: string[], signal?: AbortSignal) => Promise<GhOutcome>;

/** `glab` in the root Orchestrator's agent context and repository, with the environment its agent is
 * launched with, so a `GITLAB_TOKEN` or `GLAB_CONFIG_DIR` configured for that agent selects the same
 * login the Orchestrator's own `glab` uses. */
export function contextGlabRunner(context: AgentContext, cwd: string, agentEnv: Record<string, string> = {}): GlabRunner {
  return async (args, signal) => {
    try {
      const { stdout, stderr } = await runContextCommand(context, "glab", args, {
        cwd,
        timeoutMs: GLAB_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...agentEnv, NO_PROMPT: "1", NO_COLOR: "1", PAGER: "cat" },
        ...(signal ? { signal } : {}),
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

/** Reduce a failed `glab` run to a fixed reason. Matching is on `glab`'s HTTP status words and Go's
 * own network errors; the response body is consulted only for its status line. */
export function classifyGlabFailure(outcome: Pick<GhOutcome, "stdout" | "stderr" | "code" | "timedOut">): CampaignForgeObservationFailure {
  const text = `${outcome.stderr}\n${outcome.stdout.slice(0, 2_000)}`;
  if (outcome.code === "ENOENT") return "forge_cli_missing";
  // WSL runs `glab` through wsl.exe, which reports a missing program in its own words.
  if (/execvpe?\(glab\) failed|glab: (?:command )?not found|'glab' is not recognized/iu.test(text)) return "forge_cli_missing";
  if (outcome.timedOut) return "forge_unreachable";
  if (/HTTP 401|401 Unauthorized|glab auth login|not authenticated|invalid_token|token is expired|token was revoked/iu.test(text)) {
    return "forge_unauthenticated";
  }
  if (/HTTP 429|429 Too Many Requests|rate limit/iu.test(text)) return "forge_rate_limited";
  if (/HTTP 40[34]|40[34] (?:Not Found|Forbidden)/iu.test(text)) return "forge_not_found";
  if (/error connecting to|dial tcp|no such host|connection refused|connection reset|i\/o timeout|TLS handshake|network is unreachable|proxyconnect|could not resolve host|context deadline exceeded/iu.test(text)) {
    return "forge_unreachable";
  }
  return "forge_error";
}

/** Failures that describe the host or the login rather than one merge request. */
const HOST_FAILURES = new Set<CampaignForgeObservationFailure>([
  "forge_cli_missing", "forge_unauthenticated", "forge_unreachable", "forge_rate_limited",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function json(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

const SHA = /^[0-9a-f]{40}$/u;
const STATE: Record<string, CampaignForgeGitLabMergeRequestObservation["state"]> = {
  opened: "open", locked: "open", closed: "closed", merged: "merged",
};
const PIPELINE: Record<string, CampaignGitLabPipelineStatus> = {
  success: "success", failed: "failed", running: "running", canceled: "canceled", skipped: "skipped", manual: "manual",
  created: "pending", waiting_for_resource: "pending", preparing: "pending", pending: "pending", scheduled: "pending",
};
const TRAIN: Record<string, CampaignGitLabMergeTrainStatus> = {
  idle: "idle", stale: "stale", fresh: "fresh", merging: "merging", merged: "merged", skip_merged: "skip_merged",
};

/** Validate a merge request's detail and approvals into the wire shape (train read separately), or
 * null when anything is off. */
export function gitlabMergeRequestObservation(
  detail: unknown,
  approvals: unknown,
  iid: number,
): Omit<CampaignForgeGitLabMergeRequestObservation, "mergeTrain"> | null {
  const mr = record(detail);
  if (!mr || mr.iid !== iid) return null;
  const state = STATE[mr.state as string];
  const draft = typeof mr.draft === "boolean" ? mr.draft : mr.work_in_progress;
  const headSha = mr.sha;
  const baseRef = mr.target_branch;
  if (!state || typeof draft !== "boolean" || typeof headSha !== "string" || !SHA.test(headSha) ||
      typeof baseRef !== "string" || baseRef.length === 0 || baseRef.length > 256) return null;
  const commit = (value: unknown) => value === null || value === undefined ? null
    : typeof value === "string" && SHA.test(value) ? value : undefined;
  const mergeCommit = commit(mr.merge_commit_sha);
  const squashCommit = commit(mr.squash_commit_sha);
  if (mergeCommit === undefined || squashCommit === undefined) return null;
  let pipeline: CampaignForgeGitLabMergeRequestObservation["pipeline"] = null;
  if (mr.head_pipeline !== null && mr.head_pipeline !== undefined) {
    const head = record(mr.head_pipeline);
    if (!head || !Number.isSafeInteger(head.id) || (head.id as number) < 1 || typeof head.status !== "string") return null;
    pipeline = { id: head.id as number, status: PIPELINE[head.status] ?? "unknown" };
  }
  const approval = record(approvals);
  if (!approval || typeof approval.approved !== "boolean" || !Array.isArray(approval.approved_by)) return null;
  const left = approval.approvals_left;
  if (left !== undefined && left !== null && (!Number.isSafeInteger(left) || (left as number) < 0)) return null;
  return {
    forge: "gitlab",
    state,
    draft,
    headSha,
    baseRef,
    approvals: {
      approved: approval.approved,
      approvedBy: approval.approved_by.length,
      left: typeof left === "number" ? left : null,
    },
    pipeline,
    mergeCommitSha: mergeCommit ?? squashCommit,
  };
}

type Read =
  | { ok: true; observation: CampaignForgeGitLabMergeRequestObservation }
  | { ok: false; failure: CampaignForgeObservationFailure };

class HostRead {
  private readonly ready = new Map<string, Promise<CampaignForgeObservationFailure | null>>();
  private readonly failed = new Map<string, CampaignForgeObservationFailure>();
  private readonly firstCall = new Map<string, Promise<void>>();

  constructor(private readonly glab: GlabRunner) {}

  /** gitlab.com, or a host global `glab` configuration names; anything else is never asked. */
  private readiness(host: string): Promise<CampaignForgeObservationFailure | null> {
    let check = this.ready.get(host);
    if (!check) {
      check = host === "gitlab.com" ? Promise.resolve(null) : this.glab(["config", "get", "api_protocol", "--host", host, "--global"])
        .then((outcome) => {
          if (outcome.code === null) return new Set(["http", "https"]).has(outcome.stdout.trim().toLowerCase()) ? null : "forge_unsupported";
          return classifyGlabFailure(outcome) === "forge_cli_missing" ? "forge_cli_missing" : "forge_unsupported";
        });
      this.ready.set(host, check);
    }
    return check;
  }

  /** One API read. A host's first call runs alone, so a host-wide failure (remembered here) costs one
   * call, and the host's other reads skip the network. */
  private async api(host: string, path: string): Promise<{ ok: true; value: unknown } | { ok: false; failure: CampaignForgeObservationFailure }> {
    const first = this.firstCall.get(host);
    if (first) await first;
    const known = this.failed.get(host);
    if (known) return { ok: false, failure: known };
    const call = this.glab(["api", path, "--hostname", host]);
    if (!first) this.firstCall.set(host, call.then(() => undefined, () => undefined));
    const outcome = await call;
    if (outcome.code !== null) {
      const failure = classifyGlabFailure(outcome);
      if (HOST_FAILURES.has(failure)) this.failed.set(host, failure);
      return { ok: false, failure };
    }
    const value = json(outcome.stdout);
    return value === undefined ? { ok: false, failure: "forge_error" } : { ok: true, value };
  }

  async read(host: string, project: string, iid: number): Promise<Read> {
    const unready = await this.readiness(host);
    if (unready) return { ok: false, failure: unready };
    const encoded = encodeURIComponent(project);
    const base = `projects/${encoded}/merge_requests/${iid}`;
    const detail = await this.api(host, base);
    if (!detail.ok) return detail;
    const approvals = await this.api(host, `${base}/approvals`);
    if (!approvals.ok) return approvals;
    const observed = gitlabMergeRequestObservation(detail.value, approvals.value, iid);
    if (!observed) return { ok: false, failure: "forge_error" };
    if (observed.state !== "open") return { ok: true, observation: { ...observed, mergeTrain: null } };
    // Not on a train, and trains unavailable on this project or tier, both read 404 or 403.
    const car = await this.api(host, `projects/${encoded}/merge_trains/merge_requests/${iid}`);
    if (!car.ok) {
      return car.failure === "forge_not_found" ? { ok: true, observation: { ...observed, mergeTrain: null } } : car;
    }
    const carRecord = record(car.value);
    if (!carRecord || typeof carRecord.status !== "string") return { ok: false, failure: "forge_error" };
    const status = TRAIN[carRecord.status] ?? "unknown";
    let position: number | null = null;
    // A car that already left the train has no position; the order read is display only, so its
    // failure leaves the position unknown rather than failing the merge request.
    if (status !== "merged" && status !== "skip_merged") {
      const train = await this.api(host,
        `projects/${encoded}/merge_trains/${encodeURIComponent(observed.baseRef)}?scope=active&sort=asc&per_page=${TRAIN_CARS_READ}`);
      if (train.ok && Array.isArray(train.value)) {
        const index = train.value.findIndex((entry) => record(record(entry)?.merge_request)?.iid === iid);
        position = index >= 0 ? index + 1 : null;
      }
    }
    return { ok: true, observation: { ...observed, mergeTrain: { status, position } } };
  }
}

/** Read each GitLab ref, at most `CONCURRENT_READS` at once. A ref that is not a host-qualified
 * GitLab project is `forge_unsupported` without being read. Results are in `refs` order. */
export async function observeGitLabMergeRequests(
  refs: readonly CampaignPullRequestRef[],
  glab: GlabRunner,
): Promise<Read[]> {
  const hosts = new HostRead(glab);
  const results: Read[] = new Array(refs.length);
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      const index = next++;
      const ref = refs[index]!;
      const location = campaignRepositoryLocation(ref?.repository);
      if (location?.forge !== "gitlab" || !Number.isSafeInteger(ref.number) || ref.number < 1) {
        results[index] = { ok: false, failure: "forge_unsupported" };
        continue;
      }
      try {
        results[index] = await hosts.read(location.host.toLowerCase(), location.project, ref.number);
      } catch {
        results[index] = { ok: false, failure: "forge_error" };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENT_READS, refs.length) }, worker));
  return results;
}
