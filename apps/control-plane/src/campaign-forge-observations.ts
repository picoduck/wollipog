/**
 * Campaign forge status (#2417 slice 8, docs/campaign-work-ledger.md "Forge Status").
 *
 * The control plane stores no forge credentials. It asks the runner hosting the root campaign
 * session to read the GitHub pull requests the campaign's work items name, through that runner's
 * existing `gh` login, and keeps the last answer per pull request with its observation time. A
 * fact is derived on read: `fresh` until it is `CAMPAIGN_FORGE_OBSERVATION.staleAfterMs` old, then
 * `stale`; `unavailable{reason}` when the latest read failed or nothing could be read. Unavailable
 * and stale facts never stand in for a passing, approved, or merged one.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  CAMPAIGN_FORGE_OBSERVATION,
  runnerSupportsProtocol,
  type CampaignForgeObservationFailure,
  type CampaignForgeObserveMessage,
  type CampaignForgeObserveResultMessage,
  type CampaignForgePullRequestObservation,
  type CampaignObservedFact,
  type CampaignPullRequestRef,
} from "@wollipog/protocol";

export const CAMPAIGN_FORGE_OBSERVATION_SCHEMA = `
-- Campaign forge status (#2417 slice 8): the last GitHub read of each pull request a campaign's
-- work items name. Status data only. Deleting the root campaign deletes its observations.
CREATE TABLE IF NOT EXISTS campaign_forge_observations (
  campaign_session_id TEXT NOT NULL,
  repository_key      TEXT NOT NULL,
  number              INTEGER NOT NULL,
  runner_id           TEXT NOT NULL,
  value_json          TEXT,
  observed_at         INTEGER,
  failure_reason      TEXT,
  failed_at           INTEGER,
  PRIMARY KEY (campaign_session_id, repository_key, number),
  FOREIGN KEY (campaign_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
`;

export type ForgeFact = CampaignObservedFact<CampaignForgePullRequestObservation>;
export type ForgeFactEntry = { ref: CampaignPullRequestRef; fact: ForgeFact };

/** How the runner hosting the campaign stands right now. */
export type ForgeObserverState = "online" | "offline" | "unsupported";

interface ObservationRow {
  repository_key: string;
  number: number;
  value_json: string | null;
  observed_at: number | null;
  failure_reason: CampaignForgeObservationFailure | null;
  failed_at: number | null;
}

const FAILURES: ReadonlySet<string> = new Set<CampaignForgeObservationFailure>([
  "forge_cli_missing", "forge_unauthenticated", "forge_unreachable", "forge_unsupported",
  "forge_not_found", "forge_rate_limited", "forge_error",
]);

export function forgeRefKey(ref: CampaignPullRequestRef): string {
  return `${ref.repository.toLowerCase()}#${ref.number}`;
}

/** Pure derivation of one fact from its stored row, the observing runner's state, and the time. */
export function forgeFact(row: ObservationRow | undefined, observer: ForgeObserverState, now: number): ForgeFact {
  const value = row?.value_json ? JSON.parse(row.value_json) as CampaignForgePullRequestObservation : undefined;
  const last = value && row?.observed_at !== null && row?.observed_at !== undefined
    ? { lastValue: value, lastObservedAt: row.observed_at }
    : {};
  if (row?.failure_reason) return { availability: "unavailable", reason: row.failure_reason, ...last };
  if (value && row?.observed_at !== null && row?.observed_at !== undefined) {
    return now - row.observed_at > CAMPAIGN_FORGE_OBSERVATION.staleAfterMs
      ? { availability: "stale", value, observedAt: row.observed_at }
      : { availability: "fresh", value, observedAt: row.observed_at };
  }
  return {
    availability: "unavailable",
    reason: observer === "unsupported" ? "runner_unsupported" : observer === "offline" ? "runner_disconnected" : "not_observed",
  };
}

/** A reader who may not see the observing runner's facts gets this, with no last value. */
export const FORGE_NOT_AUTHORIZED: ForgeFact = { availability: "unavailable", reason: "not_authorized" };

export class CampaignForgeObservationStore {
  private readonly statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly observerState: (campaignId: string) => ForgeObserverState,
  ) {}

  private stmt(sql: string): ReturnType<DatabaseSync["prepare"]> {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private row(campaignId: string, ref: CampaignPullRequestRef): ObservationRow | undefined {
    return this.stmt(
      `SELECT repository_key, number, value_json, observed_at, failure_reason, failed_at
       FROM campaign_forge_observations WHERE campaign_session_id=? AND repository_key=? AND number=?`,
    ).get(campaignId, ref.repository.toLowerCase(), ref.number) as ObservationRow | undefined;
  }

  /** One fact per ref, in order. A ref is one point lookup; an item names at most 16. */
  facts(campaignId: string, refs: readonly CampaignPullRequestRef[], now: number): ForgeFactEntry[] {
    if (refs.length === 0) return [];
    const observer = this.observerState(campaignId);
    return refs.map((ref) => ({
      ref: { repository: ref.repository, number: ref.number },
      fact: forgeFact(this.row(campaignId, ref), observer, now),
    }));
  }

  /** Store one read's results. Returns whether any fact changed in a way a reader sees (a value or
   * an availability), not merely its observation time. */
  record(
    campaignId: string,
    runnerId: string,
    results: ReadonlyArray<{ ref: CampaignPullRequestRef; observation?: CampaignForgePullRequestObservation; failure?: CampaignForgeObservationFailure }>,
    at: number,
  ): boolean {
    let changed = false;
    for (const result of results) {
      const key = result.ref.repository.toLowerCase();
      const before = this.row(campaignId, result.ref);
      if (result.observation) {
        const json = JSON.stringify(result.observation);
        this.stmt(
          `INSERT INTO campaign_forge_observations
             (campaign_session_id, repository_key, number, runner_id, value_json, observed_at, failure_reason, failed_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT(campaign_session_id, repository_key, number) DO UPDATE SET
             runner_id=excluded.runner_id, value_json=excluded.value_json, observed_at=excluded.observed_at,
             failure_reason=NULL, failed_at=NULL`,
        ).run(campaignId, key, result.ref.number, runnerId, json, at);
        if (!before || before.value_json !== json || before.failure_reason !== null) changed = true;
      } else if (result.failure && FAILURES.has(result.failure)) {
        this.stmt(
          `INSERT INTO campaign_forge_observations
             (campaign_session_id, repository_key, number, runner_id, value_json, observed_at, failure_reason, failed_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
           ON CONFLICT(campaign_session_id, repository_key, number) DO UPDATE SET
             runner_id=excluded.runner_id, failure_reason=excluded.failure_reason, failed_at=excluded.failed_at`,
        ).run(campaignId, key, result.ref.number, runnerId, result.failure, at);
        if (!before || before.failure_reason !== result.failure) changed = true;
      }
    }
    return changed;
  }

  /** For the background pass: when each ref was last read, successfully or not (a failed read waits
   * the same interval as a successful one), and whether its last value is a finished pull request
   * (merged or closed) with no failure since. */
  readState(campaignId: string, refs: readonly CampaignPullRequestRef[]): Map<string, { readAt: number; finished: boolean }> {
    return new Map(refs.flatMap((ref) => {
      const row = this.row(campaignId, ref);
      if (!row) return [];
      const state = row.value_json ? (JSON.parse(row.value_json) as CampaignForgePullRequestObservation).state : null;
      return [[forgeRefKey(ref), {
        readAt: Math.max(row.observed_at ?? 0, row.failed_at ?? 0),
        finished: !row.failure_reason && (state === "merged" || state === "closed"),
      }]];
    }));
  }
}

/* ------------------------------ Observer ------------------------------ */

/** Runner requests waiting behind the concurrency limit; past this, new reads are dropped. */
const MAX_QUEUED_READS = 8;

export interface CampaignForgeObserverDeps {
  /** The runner hosting the root campaign session, or null when the session is gone. */
  observingRunner(campaignId: string): { runnerId: string; protocolVersion: number | null; online: boolean } | null;
  requestFromRunner(runnerId: string, requestId: string, message: CampaignForgeObserveMessage, timeoutMs: number): Promise<unknown>;
  store: Pick<CampaignForgeObservationStore, "record" | "readState">;
  /** Unfinished items' reported pull requests, per campaign whose root is live and for which
   * `include` holds (checked before any ledger is read). */
  backgroundTargets(include: (campaignId: string) => boolean): Array<{ campaignId: string; refs: CampaignPullRequestRef[] }>;
  /** A visible fact changed: give the campaign a coalesced revision and refresh. */
  changed(campaignId: string): void;
  warn(message: string): void;
  newRequestId(): string;
  now?: () => number;
}

/**
 * Reads forge status on demand and in the background, never on a session update's path. Each
 * pull request is read at most once per `minIntervalMs`; a read already in flight is shared; at
 * most `concurrentRequests` runner requests run at once and the queue behind them is bounded.
 */
export class CampaignForgeObserver {
  private readonly lastRead = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly queue: Array<() => void> = [];
  private running = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private backgroundBusy = false;

  constructor(private readonly deps: CampaignForgeObserverDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Read these refs now, subject to the rate limit. Resolves when every read it started or joined
   * has finished; never rejects. */
  async refresh(campaignId: string, refs: readonly CampaignPullRequestRef[]): Promise<void> {
    const runner = this.deps.observingRunner(campaignId);
    // An old or disconnected runner is never asked; facts derive their reason from its state.
    if (!runner || !runner.online || !runnerSupportsProtocol(runner.protocolVersion, "campaignForgeStatus")) return;
    const now = this.now();
    if (this.lastRead.size > 4_096) {
      for (const [key, at] of this.lastRead) if (now - at >= CAMPAIGN_FORGE_OBSERVATION.backgroundIntervalMs) this.lastRead.delete(key);
    }
    const waits: Promise<void>[] = [];
    const due: CampaignPullRequestRef[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = `${campaignId}|${forgeRefKey(ref)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const flight = this.inFlight.get(key);
      if (flight) waits.push(flight);
      else if (now - (this.lastRead.get(key) ?? -Infinity) >= CAMPAIGN_FORGE_OBSERVATION.minIntervalMs) due.push(ref);
    }
    for (let start = 0; start < due.length; start += CAMPAIGN_FORGE_OBSERVATION.refsPerRequest) {
      const batch = due.slice(start, start + CAMPAIGN_FORGE_OBSERVATION.refsPerRequest);
      // A full queue drops the read; the facts keep their last state and age into `stale`.
      if (this.queue.length >= MAX_QUEUED_READS) break;
      const keys = batch.map((ref) => `${campaignId}|${forgeRefKey(ref)}`);
      for (const key of keys) this.lastRead.set(key, now);
      const read = this.limited(() => this.read(campaignId, runner.runnerId, batch)).finally(() => {
        // The interval runs from when the read finished, whatever it learned: a read that waited in
        // the queue or timed out is not repeated at once, by a caller or by the background pass.
        const finished = this.now();
        for (const key of keys) {
          this.lastRead.set(key, finished);
          if (this.inFlight.get(key) === read) this.inFlight.delete(key);
        }
      });
      for (const key of keys) this.inFlight.set(key, read);
      waits.push(read);
    }
    await Promise.all(waits);
  }

  /** One background pass: unfinished items' pull requests not read for `backgroundIntervalMs`,
   * oldest first, at most `backgroundRefsPerTick`. A finished pull request (merged or closed) is
   * left to on-demand reads. */
  async backgroundPass(): Promise<void> {
    if (this.backgroundBusy) return;
    this.backgroundBusy = true;
    try {
      const now = this.now();
      const due: Array<{ campaignId: string; ref: CampaignPullRequestRef; readAt: number }> = [];
      const askable = (campaignId: string) => {
        const runner = this.deps.observingRunner(campaignId);
        return Boolean(runner?.online && runnerSupportsProtocol(runner.protocolVersion, "campaignForgeStatus"));
      };
      for (const { campaignId, refs } of this.deps.backgroundTargets(askable)) {
        const state = this.deps.store.readState(campaignId, refs);
        for (const ref of refs) {
          const stored = state.get(forgeRefKey(ref));
          if (stored?.finished) continue;
          // A read that stored nothing (timed out, disconnected, malformed) still counts.
          const readAt = Math.max(stored?.readAt ?? 0, this.lastRead.get(`${campaignId}|${forgeRefKey(ref)}`) ?? 0);
          if (now - readAt >= CAMPAIGN_FORGE_OBSERVATION.backgroundIntervalMs) due.push({ campaignId, ref, readAt });
        }
      }
      due.sort((a, b) => a.readAt - b.readAt);
      const byCampaign = new Map<string, CampaignPullRequestRef[]>();
      for (const entry of due.slice(0, CAMPAIGN_FORGE_OBSERVATION.backgroundRefsPerTick)) {
        byCampaign.set(entry.campaignId, [...(byCampaign.get(entry.campaignId) ?? []), entry.ref]);
      }
      await Promise.all([...byCampaign].map(([campaignId, refs]) => this.refresh(campaignId, refs)));
    } catch (error) {
      this.deps.warn(`campaign forge background pass failed: ${String(error)}`);
    } finally {
      this.backgroundBusy = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.backgroundPass(), CAMPAIGN_FORGE_OBSERVATION.backgroundTickMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.queue.length = 0;
  }

  private limited(work: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      const run = () => {
        this.running++;
        void work().catch((error: unknown) => {
          this.deps.warn(`campaign forge read failed: ${String(error)}`);
        }).finally(() => {
          this.running--;
          this.queue.shift()?.();
          resolve();
        });
      };
      if (this.running < CAMPAIGN_FORGE_OBSERVATION.concurrentRequests) run();
      else this.queue.push(run);
    });
  }

  private async read(campaignId: string, runnerId: string, refs: CampaignPullRequestRef[]): Promise<void> {
    const requestId = this.deps.newRequestId();
    let response: unknown;
    try {
      response = await this.deps.requestFromRunner(runnerId, requestId, {
        type: "campaign_forge_observe",
        requestId,
        sessionId: campaignId,
        pullRequests: refs.map((ref) => ({ repository: ref.repository, number: ref.number })),
      }, CAMPAIGN_FORGE_OBSERVATION.requestTimeoutMs);
    } catch (error) {
      // Disconnected or timed out: nothing was learned. The facts keep their last state, a missing
      // one reads `runner_disconnected` while the runner is gone, and every value ages into stale.
      this.deps.warn(`campaign forge read for ${campaignId} did not complete: ${String(error)}`);
      return;
    }
    try {
      // Validation itself must not throw past here: a malformed answer only stores nothing.
      const results = validResults(response, campaignId, refs);
      if (!results) {
        this.deps.warn(`campaign forge read for ${campaignId} returned a malformed answer`);
        return;
      }
      if (this.deps.store.record(campaignId, runnerId, results, this.now())) this.deps.changed(campaignId);
    } catch (error) {
      this.deps.warn(`campaign forge observation for ${campaignId} could not be stored: ${String(error)}`);
    }
  }
}

/** Accept only an answer for exactly the refs asked, in order, with recognized failures. */
function validResults(
  response: unknown,
  campaignId: string,
  refs: readonly CampaignPullRequestRef[],
): Array<{ ref: CampaignPullRequestRef; observation?: CampaignForgePullRequestObservation; failure?: CampaignForgeObservationFailure }> | null {
  const message = response as Partial<CampaignForgeObserveResultMessage> | null;
  if (!message || message.type !== "campaign_forge_observe_result" || message.sessionId !== campaignId) return null;
  if (message.ok === false) {
    return message.failure && FAILURES.has(message.failure) ? refs.map((ref) => ({ ref, failure: message.failure! })) : null;
  }
  if (message.ok !== true || !Array.isArray(message.results) || message.results.length !== refs.length) return null;
  const results = [];
  for (const [index, result] of message.results.entries()) {
    const ref = refs[index]!;
    if (!result || typeof result.ref?.repository !== "string" || result.ref.number !== ref.number ||
        result.ref.repository.toLowerCase() !== ref.repository.toLowerCase()) return null;
    if (result.ok === true) {
      if (!validObservation(result.observation)) return null;
      results.push({ ref, observation: sanitizedObservation(result.observation) });
    } else if (result.ok === false && FAILURES.has(result.failure)) {
      results.push({ ref, failure: result.failure });
    } else {
      return null;
    }
  }
  return results;
}

const ROLLUP_STATES = new Set(["passing", "failing", "pending", "none", "unknown"]);
const QUEUE_STATES = new Set(["queued", "awaiting_checks", "mergeable", "unmergeable", "locked", "unknown"]);

function validRollup(value: unknown): boolean {
  const rollup = value as Record<string, unknown> | null;
  return Boolean(rollup) && ROLLUP_STATES.has(rollup!.state as string) &&
    ["passing", "failing", "pending"].every((key) => Number.isSafeInteger(rollup![key]) && (rollup![key] as number) >= 0);
}

/** The runner is trusted to read, not to shape what is stored: only the wire fields survive. */
function validObservation(value: unknown): value is CampaignForgePullRequestObservation {
  const pr = value as Record<string, unknown> | null;
  if (!pr || typeof pr !== "object") return false;
  const queue = pr.mergeQueue as Record<string, unknown> | null;
  return ["open", "closed", "merged"].includes(pr.state as string) && typeof pr.draft === "boolean" &&
    typeof pr.headSha === "string" && /^[0-9a-f]{40}$/u.test(pr.headSha) &&
    typeof pr.baseRef === "string" && pr.baseRef.length > 0 && pr.baseRef.length <= 256 &&
    ["approved", "changes_requested", "review_required", "none"].includes(pr.reviewDecision as string) &&
    validRollup(pr.checks) && validRollup(pr.requiredChecks) &&
    (queue === null || (typeof queue === "object" && QUEUE_STATES.has(queue.state as string) &&
      (queue.position === null || (Number.isSafeInteger(queue.position) && (queue.position as number) >= 0)))) &&
    (pr.mergeCommitSha === null || (typeof pr.mergeCommitSha === "string" && /^[0-9a-f]{40}$/u.test(pr.mergeCommitSha)));
}

/** Store exactly the wire fields of a validated observation. */
export function sanitizedObservation(pr: CampaignForgePullRequestObservation): CampaignForgePullRequestObservation {
  const rollup = (value: CampaignForgePullRequestObservation["checks"]) =>
    ({ state: value.state, passing: value.passing, failing: value.failing, pending: value.pending });
  return {
    state: pr.state,
    draft: pr.draft,
    headSha: pr.headSha,
    baseRef: pr.baseRef,
    reviewDecision: pr.reviewDecision,
    checks: rollup(pr.checks),
    requiredChecks: rollup(pr.requiredChecks),
    mergeQueue: pr.mergeQueue ? { state: pr.mergeQueue.state, position: pr.mergeQueue.position } : null,
    mergeCommitSha: pr.mergeCommitSha,
  };
}
