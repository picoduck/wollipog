import type { DatabaseSync } from "node:sqlite";
import {
  PULL_REQUEST_WATCH_OUTCOMES,
  PULL_REQUEST_WATCH_REASON_LIMIT,
  PULL_REQUEST_WATCH_SUMMARY_LIMIT_BYTES,
  type CampaignParkedChild,
  type PullRequestWatchContinuationState,
  type PullRequestWatchOutcome,
  type PullRequestWatchState,
  type PullRequestWatchUpdate,
  type PullRequestWatchView,
} from "@wollipog/protocol";

/** A parked session's merge-queue watch (#4071). The control plane owns it, so it outlives a runner
 * restart: every registration resends the watches still `watching` on that runner. Its end owes the
 * session one wake prompt, carried by a durable command exactly as a review continuation is:
 * held -> delivering -> delivered | uncertain | failed, or abandoned. */

interface Row {
  watch_id: string;
  session_id: string;
  runner_id: string;
  repository: string;
  pr_number: number;
  head_sha: string;
  state: PullRequestWatchState;
  outcome: PullRequestWatchOutcome | null;
  summary: string | null;
  reason: string | null;
  created_at: number;
  ended_at: number | null;
  continuation_state: PullRequestWatchContinuationState | null;
  continuation_command_id: string | null;
}

/** A watch whose wake is still owed: the session is parked on it, so its turn end owes the
 * Orchestrator nothing yet. */
const PARKED = "(state='watching' OR continuation_state IN ('held','delivering'))";
/** What a session view and a campaign show: parked, or ended without a delivered wake. */
const VISIBLE = "(state='watching' OR continuation_state IN ('held','delivering','uncertain','failed'))";
const OUTCOMES = new Set<string>(PULL_REQUEST_WATCH_OUTCOMES);

function boundedReason(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.replace(/[\r\n\t]+/gu, " ").trim() : "";
  const chosen = text || fallback;
  return chosen.length > PULL_REQUEST_WATCH_REASON_LIMIT ? `${chosen.slice(0, PULL_REQUEST_WATCH_REASON_LIMIT - 1)}…` : chosen;
}

export class PullRequestWatches {
  /** Prepared once: session views read a watch for every session they project. */
  private readonly statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  /** `ownsWrites`: this connection is the only one that writes the table (ControlPlaneDb.open), so
   * it may cache whether any watch is visible. An attached reader must not: the owner's writes
   * never reach its cache. */
  constructor(private readonly sql: DatabaseSync, private readonly ownsWrites = false) {}

  private stmt(text: string): ReturnType<DatabaseSync["prepare"]> {
    let statement = this.statements.get(text);
    if (!statement) {
      statement = this.sql.prepare(text);
      this.statements.set(text, statement);
    }
    return statement;
  }

  /** Whether any watch is visible, so the per-session reads every session view makes cost nothing
   * while none is. Unknown after any write; cached only by the owning connection, and never inside
   * an open transaction, which could still roll back. */
  private anyVisible: boolean | undefined;

  /** Every write goes through here, so the visibility answer is recomputed after it. */
  private write(text: string): ReturnType<DatabaseSync["prepare"]> {
    this.anyVisible = undefined;
    return this.stmt(text);
  }

  private noneVisible(): boolean {
    if (this.anyVisible !== undefined) return !this.anyVisible;
    const any = this.stmt(`SELECT 1 FROM pull_request_watches WHERE ${VISIBLE} LIMIT 1`).get() !== undefined;
    if (this.ownsWrites && !(this.sql as DatabaseSync & { isTransaction?: boolean }).isTransaction) this.anyVisible = any;
    return !any;
  }

  /** Only ControlPlaneDb.open installs this table; an attached connection never does (#3789). */
  static install(sql: DatabaseSync): void {
    sql.exec(`CREATE TABLE IF NOT EXISTS pull_request_watches (
      watch_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, runner_id TEXT NOT NULL,
      repository TEXT NOT NULL, pr_number INTEGER NOT NULL, head_sha TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('watching','fired','lost','cancelled')),
      outcome TEXT, summary TEXT, reason TEXT, created_at INTEGER NOT NULL, ended_at INTEGER,
      continuation_state TEXT CHECK (continuation_state IS NULL OR
        continuation_state IN ('held','delivering','delivered','uncertain','failed','abandoned')),
      continuation_command_id TEXT, continuation_updated_at INTEGER,
      parked_turn_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS pull_request_watches_session ON pull_request_watches(session_id);
    CREATE INDEX IF NOT EXISTS pull_request_watches_runner ON pull_request_watches(runner_id) WHERE state='watching';
    CREATE UNIQUE INDEX IF NOT EXISTS pull_request_watches_one_active ON pull_request_watches(session_id)
      WHERE state='watching';
    CREATE INDEX IF NOT EXISTS pull_request_watches_continuation_held ON pull_request_watches(session_id)
      WHERE continuation_state='held';
    CREATE INDEX IF NOT EXISTS pull_request_watches_continuation_command ON pull_request_watches(continuation_command_id)
      WHERE continuation_state='delivering';`);
  }

  /** One transaction, or the caller's when one is already open. */
  private atomic<T>(work: () => T): T {
    if ((this.sql as DatabaseSync & { isTransaction?: boolean }).isTransaction) return work();
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.sql.exec("COMMIT");
      return result;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  private row(watchId: string): Row | undefined {
    return this.stmt("SELECT * FROM pull_request_watches WHERE watch_id=?").get(watchId) as Row | undefined;
  }

  private static view(row: Row): PullRequestWatchView {
    return {
      watchId: row.watch_id,
      repository: row.repository,
      number: row.pr_number,
      headSha: row.head_sha,
      state: row.state,
      since: row.created_at,
      ...(row.outcome ? { outcome: row.outcome } : {}),
      ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      continuation: row.continuation_state ?? "none",
    };
  }

  view(watchId: string): PullRequestWatchView | undefined {
    const row = this.row(watchId);
    return row ? PullRequestWatches.view(row) : undefined;
  }

  /** The session's own watch for display: the one it is parked on, or the newest ended one whose
   * wake was not delivered. */
  visibleFor(sessionId: string): PullRequestWatchView | undefined {
    if (this.noneVisible()) return undefined;
    const row = this.stmt(`SELECT * FROM pull_request_watches WHERE session_id=? AND ${VISIBLE}
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sessionId) as Row | undefined;
    return row ? PullRequestWatches.view(row) : undefined;
  }

  /** True while the session is parked in the turn that parked it: watching, or its wake not yet
   * handed to the runner, and no later turn started (a newer user message). That turn's end then owes
   * a supervising Orchestrator no continuation; a later turn's report, such as one answering a
   * parent's prompt while the watch keeps running, still does. */
  isParked(sessionId: string): boolean {
    // Every parked watch is also visible.
    if (this.noneVisible()) return false;
    return this.stmt(`SELECT 1 FROM pull_request_watches w WHERE w.session_id=? AND ${PARKED}
      AND NOT EXISTS (SELECT 1 FROM session_events e WHERE e.session_id=w.session_id AND e.kind='user_message'
        AND e.seq>w.parked_turn_seq) LIMIT 1`).get(sessionId) !== undefined;
  }

  /** The visible watches of these sessions, newest first, at most `limit`. */
  visibleAmong(sessionIds: readonly string[], limit: number): CampaignParkedChild[] {
    if (!sessionIds.length || limit <= 0 || this.noneVisible()) return [];
    const parked: CampaignParkedChild[] = [];
    const ids = new Set(sessionIds);
    // One indexed read per session keeps this bounded by the campaign's own descendants.
    for (const sessionId of ids) {
      const watch = this.visibleFor(sessionId);
      if (watch) parked.push({ sessionId, watch });
    }
    return parked.sort((a, b) => b.watch.since - a.watch.since).slice(0, limit);
  }

  /** Register a watch, cancelling the session's previous one. Returns the ids it cancelled, whose
   * runner should stop polling. */
  register(input: { watchId: string; sessionId: string; runnerId: string; repository: string; number: number;
    headSha: string; now: number }): string[] {
    const replaced = (this.stmt("SELECT watch_id FROM pull_request_watches WHERE session_id=? AND state='watching'")
      .all(input.sessionId) as Array<{ watch_id: string }>).map((row) => row.watch_id);
    this.atomic(() => {
      this.write(`UPDATE pull_request_watches SET state='cancelled', reason=?, ended_at=? WHERE session_id=? AND state='watching'`)
        .run("replaced by a newer watch", input.now, input.sessionId);
      // A newer park supersedes a wake the session has not received yet: it is acting again.
      this.write(`UPDATE pull_request_watches SET continuation_state='abandoned', continuation_updated_at=?
        WHERE session_id=? AND continuation_state='held'`).run(input.now, input.sessionId);
      // The parking turn is the one whose user message is newest now; a newer one starts a later turn.
      this.write(`INSERT INTO pull_request_watches (watch_id, session_id, runner_id, repository, pr_number, head_sha,
        state, created_at, parked_turn_seq) VALUES (?,?,?,?,?,?,'watching',?,
        (SELECT COALESCE(MAX(seq),0) FROM session_events WHERE session_id=? AND kind='user_message'))`).run(
        input.watchId, input.sessionId, input.runnerId, input.repository, input.number, input.headSha, input.now,
        input.sessionId);
    });
    return replaced;
  }

  /** Watches still polling on a runner, oldest first, as start commands' fields. */
  watchingOn(runnerId: string): Array<{ watchId: string; sessionId: string; repository: string; number: number; headSha: string }> {
    return (this.stmt(`SELECT * FROM pull_request_watches WHERE runner_id=? AND state='watching' ORDER BY rowid`)
      .all(runnerId) as unknown as Row[]).map((row) => ({
      watchId: row.watch_id, sessionId: row.session_id, repository: row.repository, number: row.pr_number, headSha: row.head_sha,
    }));
  }

  /** Accept the owning runner's report: the first one ends the watch and owes the session its wake.
   * Returns the session to wake, or null when the report changed nothing. */
  accept(runnerId: string, update: PullRequestWatchUpdate, now: number): string | null {
    const row = typeof update?.watchId === "string" ? this.row(update.watchId) : undefined;
    if (!row || row.runner_id !== runnerId || row.state !== "watching") return null;
    if (update.state === "fired") {
      if (typeof update.outcome !== "string" || !OUTCOMES.has(update.outcome)) return null;
      const summary = typeof update.summary === "string" && Buffer.byteLength(update.summary) <= PULL_REQUEST_WATCH_SUMMARY_LIMIT_BYTES
        ? update.summary : null;
      const changed = this.write(`UPDATE pull_request_watches SET state='fired', outcome=?, summary=?, ended_at=?,
        continuation_state='held', continuation_updated_at=? WHERE watch_id=? AND state='watching'`)
        .run(update.outcome, summary, now, now, row.watch_id).changes > 0;
      return changed ? row.session_id : null;
    }
    if (update.state === "lost") {
      return this.markLost(row.watch_id, boundedReason(update.reason, "the runner stopped watching"), now) ? row.session_id : null;
    }
    return null;
  }

  /** End a watch no runner can keep, owing the session a wake that says so. */
  markLost(watchId: string, reason: string, now: number): boolean {
    return this.write(`UPDATE pull_request_watches SET state='lost', reason=?, ended_at=?, continuation_state='held',
      continuation_updated_at=? WHERE watch_id=? AND state='watching'`)
      .run(boundedReason(reason, "the watch was lost"), now, now, watchId).changes > 0;
  }

  /** The session ended, was archived, or chose to stop waiting: cancel its watch and abandon any
   * wake not yet delivered. Returns the cancelled ids, whose runner should stop polling. */
  cancelForSession(sessionId: string, reason: string, now: number): string[] {
    const cancelled = (this.stmt("SELECT watch_id FROM pull_request_watches WHERE session_id=? AND state='watching'")
      .all(sessionId) as Array<{ watch_id: string }>).map((row) => row.watch_id);
    this.atomic(() => {
      this.write(`UPDATE pull_request_watches SET state='cancelled', reason=?, ended_at=? WHERE session_id=? AND state='watching'`)
        .run(boundedReason(reason, "cancelled"), now, sessionId);
      this.write(`UPDATE pull_request_watches SET continuation_state='abandoned', continuation_updated_at=?
        WHERE session_id=? AND continuation_state IN ('held','delivering')`).run(now, sessionId);
    });
    return cancelled;
  }

  /** Ended watches still owed to this session as a wake, oldest first, with their summaries. */
  heldWakes(sessionId: string): Array<PullRequestWatchView & { summary: string | null }> {
    return (this.stmt(`SELECT * FROM pull_request_watches WHERE session_id=? AND continuation_state='held' ORDER BY rowid`)
      .all(sessionId) as unknown as Row[]).map((row) => ({ ...PullRequestWatches.view(row), summary: row.summary }));
  }

  /** Mark held wakes `delivering` on the command that carries them. Throws unless each is held. */
  bindWakes(sessionId: string, watchIds: readonly string[], commandId: string, now: number): void {
    const update = this.write(`UPDATE pull_request_watches SET continuation_state='delivering', continuation_command_id=?,
      continuation_updated_at=? WHERE watch_id=? AND session_id=? AND continuation_state='held'`);
    for (const id of watchIds) {
      if (Number(update.run(commandId, now, id, sessionId).changes) !== 1) throw new Error("watch wake changed before it could be staged");
    }
  }

  /** Record held wakes delivered just before they go out on the immediate lane, which has no
   * receipt. All or nothing: false, claiming none, unless every one is still held. */
  claimHeld(sessionId: string, watchIds: readonly string[], now: number): boolean {
    try {
      return this.atomic(() => {
        const update = this.write(`UPDATE pull_request_watches SET continuation_state='delivered', continuation_command_id=NULL,
          continuation_updated_at=? WHERE watch_id=? AND session_id=? AND continuation_state='held'`);
        for (const id of watchIds) {
          if (Number(update.run(now, id, sessionId).changes) !== 1) throw new Error("watch wake changed");
        }
        return true;
      });
    } catch {
      return false;
    }
  }

  /** The immediate send that followed a claim failed synchronously: owe the wakes again. */
  releaseClaim(sessionId: string, watchIds: readonly string[], now: number): void {
    const update = this.write(`UPDATE pull_request_watches SET continuation_state='held', continuation_updated_at=?
      WHERE watch_id=? AND session_id=? AND continuation_state='delivered' AND continuation_command_id IS NULL`);
    for (const id of watchIds) update.run(now, id, sessionId);
  }

  /** The session whose wake this command carries, while it is in flight. */
  sessionForCommand(commandId: string): string | null {
    const row = this.stmt(`SELECT session_id FROM pull_request_watches WHERE continuation_command_id=?
      AND continuation_state='delivering' LIMIT 1`).get(commandId) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  setCommandState(commandId: string, state: "delivered" | "uncertain" | "failed", now: number): number {
    return Number(this.write(`UPDATE pull_request_watches SET continuation_state=?, continuation_updated_at=?
      WHERE continuation_command_id=? AND continuation_state='delivering'`).run(state, now, commandId).changes);
  }

  /** A proven-unsent command: owe its wakes again. */
  holdCommand(sessionId: string, commandId: string, now: number): boolean {
    return Number(this.write(`UPDATE pull_request_watches SET continuation_state='held', continuation_command_id=NULL,
      continuation_updated_at=? WHERE session_id=? AND continuation_command_id=? AND continuation_state='delivering'`)
      .run(now, sessionId, commandId).changes) > 0;
  }

  sessionsWithHeldWakes(runnerId?: string): string[] {
    if (this.noneVisible()) return [];
    return (this.stmt(`SELECT DISTINCT w.session_id AS id FROM pull_request_watches w JOIN sessions s ON s.id=w.session_id
      WHERE w.continuation_state='held' ${runnerId ? "AND s.runner_id=?" : ""}`)
      .all(...(runnerId ? [runnerId] : [])) as Array<{ id: string }>).map((row) => row.id);
  }

  /** Commands carrying an in-flight wake whose outcome is recorded but never applied to it. */
  settledCommands(runnerId?: string, limit = 100): string[] {
    if (this.noneVisible()) return [];
    return (this.stmt(`SELECT DISTINCT w.continuation_command_id AS id FROM pull_request_watches w
      JOIN session_prompt_commands c ON c.command_id=w.continuation_command_id
      WHERE w.continuation_state='delivering' AND c.state IN ('started','completed','failed','uncertain')
        ${runnerId ? "AND c.runner_id=?" : ""} LIMIT ?`)
      .all(...(runnerId ? [runnerId, limit] : [limit])) as Array<{ id: string }>).map((row) => row.id);
  }
}
