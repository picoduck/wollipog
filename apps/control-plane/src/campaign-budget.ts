import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET, SESSION_EVENT_WIRE_PROJECTION_VARIANTS, validCampaignBudgetAuthority,
  type CampaignBudgetAllocation, type CampaignBudgetAuthority, type CampaignBudgetView } from "@wollipog/protocol";

type Member = { session_id: string; root_id: string; cost: number; tools: number; cost_limit: number | null; tool_limit: number | null;
  user_cost_limit: number | null; user_tool_limit: number | null; active: number };

/** A member session's open live estimate for a running Claude turn, on the terms cost guardrails
 * use (#3112): none while a checkpoint is accounting the window its recorded cost already holds. */
const LIVE_COST = "CASE WHEN s.live_settling=0 AND s.live_cost_usd>0 THEN s.live_cost_usd ELSE 0 END";

/** Whether member `m` (sessions joined as `s`) holds one of its campaign's concurrent slots. A slot
 * is not a reservation (#2940): `active` keeps a member's unspent allocation outstanding until its
 * final usage settles, which can wait on history, but its slot ends once its provider has retired.
 * A terminal status is not that proof: a runner reports `stopped` as soon as a Stop begins closing
 * the provider, which can still run until the close completes or stay unconfirmed if it fails. The
 * runner withholds its final checkpoint until retirement, so a checkpoint for the member's current
 * generation proves it, as does a reconnect that no longer holds the session alive, recorded for
 * that generation by `noteProviderAbsent` (a stop the runner already confirmed keeps that earlier
 * confirmation). Until then, and while a stop is pending or provisional, the session keeps its
 * slot. A member without a session row, a native review job or a deleted session whose runner may
 * not have removed it yet, holds one until its usage settles. Reviewer sessions never hold one.
 * Every comparison is NULL-safe, and an indeterminate result still holds the slot. */
const OCCUPYING = `(m.active=1 AND NOT EXISTS (SELECT 1 FROM review_sessions WHERE review_session_id=m.session_id) AND CASE
    WHEN s.id IS NULL THEN 1
    ELSE COALESCE(NOT (s.status IN ('completed','failed','stopped')
      AND NOT EXISTS (SELECT 1 FROM session_stop_intents WHERE session_id=m.session_id)
      AND (s.status IS NOT 'stopped' OR s.stop_confirmation IS NOT NULL)
      AND (s.stop_confirmation IS 'runner_absent' OR m.absent_generation IS m.generation
        OR EXISTS (SELECT 1 FROM campaign_budget_checkpoints c
          WHERE c.session_id=m.session_id AND json_extract(c.checkpoint,'$.generation') IS m.generation))), 1) END)`;

/** Whether a runner's final checkpoint, in its local history coordinates, names the history the
 * control plane hydrated, which it stores in the wire coordinates that runner projected for it.
 * Comparing the two directly never matched, so no checkpoint settled (#2940). A runner no newer
 * than this control plane omits no events for it, so its sequence numbers are unchanged and its
 * epoch is the format offset plus the local epoch times the projection radix. Any other format
 * stays pending rather than being guessed. An epoch below the offset predates projection. */
function checkpointEpochMatches(localEpoch: number, hydratedEpoch: number | null): boolean {
  if (hydratedEpoch === null) return false;
  if (hydratedEpoch < SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET) return hydratedEpoch === localEpoch;
  return hydratedEpoch === SESSION_EVENT_WIRE_EPOCH_FORMAT_OFFSET + localEpoch * SESSION_EVENT_WIRE_PROJECTION_VARIANTS;
}

/** A sum of float USD amounts at the ledger's micro-USD precision. */
function roundUsdMicros(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

/** No foreign keys: deletion, transcript replacement and retired attempts must not refund spend.
 * Usage is each session's own monotonic peak, never the recursively reserved child charge. */
export class CampaignBudgetLedger {
  get database(): DatabaseSync { return this.sql; }
  constructor(private readonly sql: DatabaseSync) {
    sql.exec(`CREATE TABLE IF NOT EXISTS campaign_budgets (
      root_id TEXT PRIMARY KEY, authority TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active', reason TEXT,
      accepted_follow_ups INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS campaign_budget_members (
      session_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, cost REAL NOT NULL, tools INTEGER NOT NULL,
      cost_limit REAL, tool_limit INTEGER, user_cost_limit REAL, user_tool_limit INTEGER, active INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS campaign_budget_members_root ON campaign_budget_members(root_id);
    CREATE TABLE IF NOT EXISTS campaign_budget_tool_calls (
      session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, PRIMARY KEY(session_id,tool_call_id)
    );
    CREATE TABLE IF NOT EXISTS campaign_budget_follow_ups (
      root_id TEXT NOT NULL, recommendation_id TEXT NOT NULL, PRIMARY KEY(root_id,recommendation_id)
    );
    CREATE TABLE IF NOT EXISTS campaign_budget_checkpoints (
      session_id TEXT PRIMARY KEY, checkpoint TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS campaign_budget_settlements (
      session_id TEXT NOT NULL, checkpoint TEXT NOT NULL, cost REAL NOT NULL, tools INTEGER NOT NULL,
      PRIMARY KEY(session_id,checkpoint)
    );
    DROP TRIGGER IF EXISTS campaign_budget_session_usage;
    CREATE TRIGGER campaign_budget_session_usage AFTER UPDATE OF cost_usd, usage_peak_cost_usd, usage_peak_tool_calls, status ON sessions
    BEGIN
      UPDATE campaign_budget_members SET cost=MAX(cost, NEW.cost_usd, NEW.usage_peak_cost_usd),
        tools=MAX(tools, NEW.usage_peak_tool_calls)
      WHERE session_id=NEW.id;
    END;
    DROP TRIGGER IF EXISTS campaign_budget_tool_usage;
    CREATE TRIGGER campaign_budget_tool_usage AFTER INSERT ON session_events WHEN NEW.kind='tool_call'
    BEGIN
      INSERT OR IGNORE INTO campaign_budget_tool_calls(session_id,tool_call_id)
        SELECT NEW.session_id,json_extract(NEW.payload,'$.toolCallId') WHERE json_extract(NEW.payload,'$.toolCallId') IS NOT NULL
          AND EXISTS(SELECT 1 FROM campaign_budget_members WHERE session_id=NEW.session_id);
      UPDATE campaign_budget_members SET tools=MAX(tools,
        (SELECT COUNT(*) FROM campaign_budget_tool_calls WHERE session_id=NEW.session_id))
      WHERE session_id=NEW.session_id;
    END;
    DROP TRIGGER IF EXISTS campaign_budget_stop_settled;
    `);
    if (!(sql.prepare("PRAGMA table_info(campaign_budget_members)").all() as Array<{name:string}>).some((c) => c.name === "generation")) {
      sql.exec("ALTER TABLE campaign_budget_members ADD COLUMN generation TEXT NOT NULL DEFAULT ''");
    }
    for (const row of sql.prepare("SELECT session_id FROM campaign_budget_members WHERE generation=''").all() as Array<{session_id:string}>) {
      sql.prepare("UPDATE campaign_budget_members SET generation=? WHERE session_id=?").run(randomUUID(),row.session_id);
    }
    // The generation a reconnect proved no provider runs for (#2940). It frees only that
    // generation's slot; a relaunch's new generation needs its own proof.
    if (!(sql.prepare("PRAGMA table_info(campaign_budget_members)").all() as Array<{name:string}>).some((c) => c.name === "absent_generation")) {
      sql.exec("ALTER TABLE campaign_budget_members ADD COLUMN absent_generation TEXT");
    }
    // Cost availability outlives the usage rows that showed it: deleting an unpriced member drops
    // its usage state, but its cost stays unknown. The marker is set once and never cleared (#2940).
    // It is written from code, on every read and before any session deletion, rather than by
    // triggers on usage tables, so migrations of those tables stay independent of this ledger.
    if (!(sql.prepare("PRAGMA table_info(campaign_budgets)").all() as Array<{name:string}>).some((c) => c.name === "cost_unpriced")) {
      sql.exec("ALTER TABLE campaign_budgets ADD COLUMN cost_unpriced INTEGER NOT NULL DEFAULT 0");
    }
    // Usage recorded before this marker existed.
    this.noteUnpriced();
  }

  /** Persist that a campaign (every campaign when omitted) has unpriced usage, from its members'
   * current rows. Callers deleting sessions call it first, while those rows still exist. */
  noteUnpriced(rootId?: string): void {
    this.sql.prepare(`UPDATE campaign_budgets SET cost_unpriced=1 WHERE cost_unpriced=0 AND (? IS NULL OR root_id=?) AND root_id IN (
        SELECT m.root_id FROM campaign_budget_members m JOIN usage_session_state u ON u.session_id=m.session_id WHERE u.unpriced_records>0
        UNION SELECT m.root_id FROM campaign_budget_members m JOIN sessions s ON s.id=m.session_id
          WHERE s.live_settling=0 AND s.live_unpriced_records>0)`).run(rootId ?? null, rootId ?? null);
  }

  private atomic<T>(work: () => T): T {
    this.sql.exec("SAVEPOINT campaign_budget_write");
    try { const result = work(); this.sql.exec("RELEASE campaign_budget_write"); return result; }
    catch (error) { this.sql.exec("ROLLBACK TO campaign_budget_write; RELEASE campaign_budget_write"); throw error; }
  }

  root(sessionId: string): string | null {
    return (this.sql.prepare("SELECT root_id FROM campaign_budget_members WHERE session_id=?").get(sessionId) as { root_id: string } | undefined)?.root_id ?? null;
  }

  view(rootId: string): CampaignBudgetView | undefined {
    // First, so the header read below includes any accounting stop a settlement makes.
    this.settleEnded(rootId);
    const header = this.sql.prepare("SELECT * FROM campaign_budgets WHERE root_id=?").get(rootId) as
      { authority: string; state: CampaignBudgetView["state"]; reason: string | null; accepted_follow_ups: number; cost_unpriced: number } | undefined;
    if (!header) return undefined;
    const authority = JSON.parse(header.authority) as CampaignBudgetAuthority;
    // An open live request without a rate is unpriced usage too, not free (#3196). The durable
    // marker keeps it unpriced after a member's usage rows are deleted.
    const observed = Boolean(this.sql.prepare(`SELECT 1 FROM usage_session_state u
      JOIN campaign_budget_members m ON m.session_id=u.session_id WHERE m.root_id=? AND u.unpriced_records>0 LIMIT 1`).get(rootId)) ||
      Boolean(this.sql.prepare(`SELECT 1 FROM sessions s JOIN campaign_budget_members m ON m.session_id=s.id
        WHERE m.root_id=? AND s.live_settling=0 AND s.live_unpriced_records>0 LIMIT 1`).get(rootId));
    if (observed && header.cost_unpriced !== 1) this.noteUnpriced(rootId);
    const unpriced = observed || header.cost_unpriced === 1;
    // Only a cost ceiling needs priced usage. Without one the campaign keeps running, counts tool
    // calls and reports its cost as unavailable (#2940).
    if (header.state === "active" && unpriced && authority.costUsd !== undefined) {
      this.stop(rootId, "accounting_unavailable", "Unpriced campaign usage detected; protected admission stopped without a continue prompt.");
      header.state = "accounting_unavailable"; header.reason = "Unpriced campaign usage detected; protected admission stopped without a continue prompt.";
    }
    const rows = this.sql.prepare(`SELECT m.*, ${LIVE_COST} AS live_cost, ${OCCUPYING} AS occupying FROM campaign_budget_members m
      LEFT JOIN sessions s ON s.id=m.session_id WHERE m.root_id=?`).all(rootId) as unknown as Array<Member & { live_cost: number; occupying: number }>;
    const actual: CampaignBudgetView["actual"] = { costUsd: 0, toolCalls: 0 }, outstanding = { costUsd: 0, toolCalls: 0 };
    let live = 0;
    for (const row of rows) {
      // A running Claude turn's open estimate is spend no settled total includes yet (#3196). It is
      // never written to the member's recorded peak, so settlement replaces it rather than adding.
      const cost = row.cost + row.live_cost;
      live += row.live_cost;
      actual.costUsd += cost; actual.toolCalls += row.tools;
      if (row.active) {
        outstanding.costUsd += Math.max(0, (row.cost_limit ?? cost) - cost);
        outstanding.toolCalls += Math.max(0, (row.tool_limit ?? row.tools) - row.tools);
      }
    }
    if (live > 0) {
      // Round the conserved total, then split it, so spend plus reservations stays what the
      // reservations sum to rather than gaining a rounding unit from each half.
      const total = roundUsdMicros(actual.costUsd + outstanding.costUsd);
      actual.costUsd = roundUsdMicros(actual.costUsd);
      outstanding.costUsd = roundUsdMicros(total - actual.costUsd);
      actual.includesEstimate = true;
    }
    const exhausted = authority.costUsd !== undefined && actual.costUsd >= authority.costUsd ||
      authority.toolCalls !== undefined && actual.toolCalls >= authority.toolCalls;
    if (exhausted && header.state === "active") {
      this.stop(rootId, "exhausted", "Campaign allowance reached; unfinished work remains incomplete.");
      header.state = "exhausted"; header.reason = "Campaign allowance reached; unfinished work remains incomplete.";
    }
    return { authority, state: header.state, ...(header.reason ? { reason: header.reason } : {}), actual, outstanding,
      remaining: { costUsd: authority.costUsd === undefined ? null : Math.max(0, authority.costUsd - actual.costUsd - outstanding.costUsd),
        toolCalls: authority.toolCalls === undefined ? null : Math.max(0, authority.toolCalls - actual.toolCalls - outstanding.toolCalls) },
      occupied: rows.filter((r) => r.occupying && r.session_id !== rootId).length,
      acceptedFollowUps: header.accepted_follow_ups,
      reachedCheckpointsUsd: authority.checkpointsUsd?.filter((v) => actual.costUsd >= v) ?? [],
      enforcement: "admission_and_best_effort_cancellation", externalWorkers: "unsupported",
      sessionLimits: this.userLimits(rootId), rootAllocation: this.allocation(rootId) ?? undefined,
      costAccounting: unpriced || header.state==="accounting_unavailable" ? "unavailable" : "priced" };
  }

  authorize(rootId: string, authority: CampaignBudgetAuthority): void {
    if (!validCampaignBudgetAuthority(authority)) throw new Error("invalid campaign allowance");
    this.atomic(() => {
      const old = this.view(rootId);
      // A new human grant can enlarge ceilings, but cannot silently resume revoked accounting.
      if (old && old.state !== "active") throw new Error("a stopped campaign allowance cannot be reset; start an explicitly authorized new campaign");
      this.sql.prepare(`INSERT INTO campaign_budgets(root_id,authority) VALUES (?,?)
        ON CONFLICT(root_id) DO UPDATE SET authority=excluded.authority`).run(rootId, JSON.stringify(authority));
      const existingFollowUps = this.sql.prepare("SELECT id FROM campaign_work_items WHERE campaign_session_id=? AND origin='follow_up'").all(rootId) as unknown as Array<{ id: string }>;
      for (const item of existingFollowUps) {
        const inserted = this.sql.prepare("INSERT OR IGNORE INTO campaign_budget_follow_ups VALUES (?,?)").run(rootId,item.id);
        if (Number(inserted.changes)) this.sql.prepare("UPDATE campaign_budgets SET accepted_follow_ups=accepted_follow_ups+1 WHERE root_id=?").run(rootId);
      }
      const members = this.sql.prepare(`WITH RECURSIVE members(id) AS (SELECT ? UNION SELECT s.id FROM sessions s JOIN members m ON s.parent_session_id=m.id)
        SELECT s.id, s.status, MAX(s.cost_usd,s.usage_peak_cost_usd) AS cost,
          MAX(s.usage_peak_tool_calls,COALESCE((SELECT tool_calls FROM session_tool_call_counts WHERE session_id=s.id),0)
            +s.history_pruned_tool_calls) AS tools, s.history_pruned_tool_calls AS pruned_tools,
          s.cost_budget_usd AS cost_limit, s.max_tool_calls AS tool_limit FROM sessions s JOIN members m ON s.id=m.id`).all(rootId) as unknown as
          Array<{ id: string; status: string; cost: number; tools: number; pruned_tools: number; cost_limit: number | null; tool_limit: number | null }>;
      for (const m of members) {
        // Tool calls whose events retention pruned are recorded, not missing history (#2777).
        const count = (this.sql.prepare("SELECT COUNT(DISTINCT json_extract(payload,'$.toolCallId')) AS n FROM session_events WHERE session_id=? AND kind='tool_call'").get(m.id) as { n: number }).n
          + m.pruned_tools;
        if (!old && authority.toolCalls !== undefined && m.tools > count) throw new Error("Campaign tool accounting is unavailable because preauthorization history is incomplete; protected admission is refused.");
        this.sql.prepare(`INSERT OR IGNORE INTO campaign_budget_members(session_id,root_id,cost,tools,cost_limit,tool_limit,user_cost_limit,user_tool_limit,active)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(m.id,rootId,m.cost,m.tools,m.cost_limit,m.tool_limit,m.cost_limit,m.tool_limit,["completed","failed","stopped"].includes(m.status)?0:1);
        this.sql.prepare(`INSERT OR IGNORE INTO campaign_budget_tool_calls(session_id,tool_call_id)
          SELECT session_id,json_extract(payload,'$.toolCallId') FROM session_events WHERE session_id=? AND kind='tool_call' AND json_extract(payload,'$.toolCallId') IS NOT NULL`).run(m.id);
        // Calls retention pruned are recorded by id, so they count once however their history returns.
        this.sql.prepare(`INSERT OR IGNORE INTO campaign_budget_tool_calls(session_id,tool_call_id)
          SELECT session_id,tool_call_id FROM session_pruned_tool_calls WHERE session_id=?`).run(m.id);
      }
      // All live members need finite reservations before authority is usable. Preserve tighter
      // existing session ceilings; otherwise divide free capacity, including a root share.
      const rows = this.sql.prepare(`SELECT m.*, ${LIVE_COST} AS live_cost FROM campaign_budget_members m
        LEFT JOIN sessions s ON s.id=m.session_id WHERE m.root_id=? AND m.active=1`).all(rootId) as unknown as Array<Member & { live_cost: number }>;
      const used = this.view(rootId)!;
      for (const r of rows) {
        if (old && (authority.costUsd === undefined || r.cost_limit !== null) && (authority.toolCalls === undefined || r.tool_limit !== null)) continue;
        // A turn running at authorization has spent its estimate already, as `used` counts it (#3196).
        const spent = r.live_cost > 0 ? roundUsdMicros(r.cost + r.live_cost) : r.cost;
        const cost = authority.costUsd === undefined ? r.cost_limit : Math.min(r.cost_limit ?? Infinity,
          spent + Math.max(0, authority.costUsd - used.actual.costUsd) / Math.max(1, rows.length + (authority.concurrency ?? 1)));
        const tools = authority.toolCalls === undefined ? r.tool_limit : Math.min(r.tool_limit ?? Infinity,
          r.tools + Math.floor(Math.max(0, authority.toolCalls - used.actual.toolCalls) / Math.max(1, rows.length + (authority.concurrency ?? 1))));
        this.sql.prepare("UPDATE campaign_budget_members SET cost_limit=?,tool_limit=? WHERE session_id=?").run(cost,tools,r.session_id);
      }
      const view = this.view(rootId)!;
      if (view.state !== "active" || (authority.costUsd !== undefined && view.actual.costUsd + view.outstanding.costUsd > authority.costUsd + 1e-9) ||
          (authority.toolCalls !== undefined && view.actual.toolCalls + view.outstanding.toolCalls > authority.toolCalls) ||
          (authority.concurrency !== undefined && view.occupied > authority.concurrency) ||
          (authority.acceptedFollowUps !== undefined && view.acceptedFollowUps > authority.acceptedFollowUps)) throw new Error("allowance is below existing spend or reservations");
    });
  }

  /** Whether the Human authorized a cost ceiling, the only limit that needs priced usage. */
  costCeiling(rootId: string): boolean {
    const row = this.sql.prepare("SELECT authority FROM campaign_budgets WHERE root_id=?").get(rootId) as { authority: string } | undefined;
    return row !== undefined && (JSON.parse(row.authority) as CampaignBudgetAuthority).costUsd !== undefined;
  }

  stop(rootId: string, state: Exclude<CampaignBudgetView["state"], "active">, reason: string): void {
    this.sql.prepare("UPDATE campaign_budgets SET state=?,reason=? WHERE root_id=? AND state='active'").run(state,reason,rootId);
  }

  allocation(sessionId: string): CampaignBudgetAllocation | null {
    const r = this.sql.prepare("SELECT * FROM campaign_budget_members WHERE session_id=?").get(sessionId) as Member | undefined;
    return r ? { sessionId, ...(r.cost_limit === null ? {} : { costUsd: r.cost_limit }), ...(r.tool_limit === null ? {} : { toolCalls: r.tool_limit }) } : null;
  }

  userLimits(sessionId: string): { costBudgetUsd: number | null; maxToolCalls: number | null } | undefined {
    const row = this.sql.prepare("SELECT * FROM campaign_budget_members WHERE session_id=?").get(sessionId) as Member | undefined;
    return row ? { costBudgetUsd: row.user_cost_limit, maxToolCalls: row.user_tool_limit } : undefined;
  }

  prepare(rootId: string, sessionId: string, requested: { costUsd?: number; toolCalls?: number }): CampaignBudgetAllocation {
    const view = this.view(rootId); if (!view || view.state !== "active") throw new Error(view?.reason ?? "campaign allowance unavailable");
    const slots = Math.max(1, (view.authority.concurrency ?? 1) - view.occupied);
    const prior = this.allocation(sessionId);
    return { sessionId,
      ...(view.authority.costUsd === undefined ? requested.costUsd === undefined ? {} : { costUsd: requested.costUsd } :
        { costUsd: requested.costUsd ?? prior?.costUsd ?? (view.remaining.costUsd ?? 0) / slots }),
      ...(view.authority.toolCalls === undefined ? requested.toolCalls === undefined ? {} : { toolCalls: requested.toolCalls } :
        { toolCalls: requested.toolCalls ?? prior?.toolCalls ?? Math.floor((view.remaining.toolCalls ?? 0) / slots) }) };
  }

  members(rootId: string): string[] {
    return (this.sql.prepare("SELECT session_id FROM campaign_budget_members WHERE root_id=?").all(rootId) as unknown as Member[]).map((r) => r.session_id);
  }

  active(sessionId: string): boolean {
    return Boolean((this.sql.prepare("SELECT active FROM campaign_budget_members WHERE session_id=?").get(sessionId) as Member | undefined)?.active);
  }

  /** Narrow server-only #1321 cancellation adapter, not generic reallocation or usage settlement.
   * Coordinator's cancellation claim and this reservation-only deactivation MUST share a transaction.
   * No cost/tool history, checkpoint, settlement, ceiling or generation is changed or synthesized. */
  deactivateNeverDispatchedMediaReservation(sessionId: string, expected: { rootSessionId: string; runnerId: string;
    generation: string; commandSha256: string; dispatchSha256: string | null }): boolean {
    if (!this.sql.isTransaction) return false;
    // Media tables are optional until the separately owned production integration lands.
    for (const name of ["prepared_media_sessions", "media_session_purposes", "media_never_dispatched_fences"]) {
      if (!this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) return false;
    }
    const row = this.sql.prepare("SELECT payload,payload_sha256,state FROM prepared_media_sessions WHERE json_extract(payload,'$.sessionId')=?")
      .get(sessionId) as { payload: string; payload_sha256: string; state: string } | undefined;
    const purpose = this.sql.prepare("SELECT record,sha256 FROM media_session_purposes WHERE session_id=?")
      .get(sessionId) as { record: string; sha256: string } | undefined;
    if (!row || row.state !== "cancelling" || !purpose) return false;
    const r = JSON.parse(row.payload), p = JSON.parse(purpose.record);
    const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
    if (sha(r) !== row.payload_sha256 || sha(p) !== purpose.sha256 || r.state !== row.state ||
      r.sessionId !== sessionId || r.rootSessionId !== expected.rootSessionId || r.runnerId !== expected.runnerId ||
      r.admission?.dispatch?.generation !== expected.generation || r.commandSha256 !== expected.commandSha256 ||
      r.command?.type !== "start_session" || r.command.spec?.sessionId !== sessionId ||
      r.command.spec.campaignBudgetDispatch?.rootSessionId !== expected.rootSessionId ||
      r.command.spec.campaignBudgetDispatch?.generation !== expected.generation ||
      sha(r.command) !== expected.commandSha256 || r.dispatchSha256 !== expected.dispatchSha256 ||
      p.sessionId !== sessionId || p.rootSessionId !== expected.rootSessionId || p.childSessionId !== r.childSessionId ||
      p.admissionId !== r.admissionId || p.generation !== expected.generation || sha(p.command) !== expected.commandSha256) return false;
    if (r.cancellation?.kind === "never_enqueued") {
      if (!["prepared", "bound"].includes(r.cancellation.from)) return false;
    } else if (r.cancellation?.kind === "terminal_fenced") {
      if (!["dispatching", "uncertain"].includes(r.cancellation.from) || !expected.dispatchSha256) return false;
      const fence = this.sql.prepare("SELECT * FROM media_never_dispatched_fences WHERE session_id=? AND generation=?")
        .get(sessionId, expected.generation) as { receipt: string; sha256: string; root_id: string; runner_id: string;
          command_sha256: string; dispatch_sha256: string } | undefined;
      if (!fence || fence.root_id !== expected.rootSessionId || fence.runner_id !== expected.runnerId ||
        fence.command_sha256 !== expected.commandSha256 || fence.dispatch_sha256 !== expected.dispatchSha256 ||
        sha(JSON.parse(fence.receipt)) !== fence.sha256) return false;
    } else return false;
    const actual = this.sql.prepare("SELECT 1 FROM campaign_budget_members m JOIN sessions s ON s.id=m.session_id " +
      "WHERE m.session_id=? AND m.root_id=? AND m.generation=? AND m.active=1 AND m.cost=0 AND m.tools=0 " +
      "AND s.parent_session_id=? AND s.runner_id=? AND s.status='queued' AND s.cost_usd=0 " +
      "AND s.usage_peak_cost_usd=0 AND s.usage_peak_tool_calls=0").get(sessionId, expected.rootSessionId,
        expected.generation, expected.rootSessionId, expected.runnerId);
    if (!actual || this.sql.prepare("SELECT 1 FROM campaign_budget_checkpoints WHERE session_id=?").get(sessionId) ||
      this.sql.prepare("SELECT 1 FROM campaign_budget_settlements WHERE session_id=?").get(sessionId) ||
      this.sql.prepare("SELECT 1 FROM campaign_budget_tool_calls WHERE session_id=?").get(sessionId) ||
      this.sql.prepare("SELECT 1 FROM usage_session_state WHERE session_id=?").get(sessionId) ||
      this.sql.prepare("SELECT 1 FROM session_events WHERE session_id=? AND kind IN ('token_usage','tool_call')").get(sessionId)) return false;
    return Number(this.sql.prepare("UPDATE campaign_budget_members SET active=0 WHERE session_id=? AND root_id=? " +
      "AND generation=? AND active=1 AND cost=0 AND tools=0").run(sessionId, expected.rootSessionId, expected.generation).changes) === 1;
  }

  /** #1321 dedicated media reviewer final usage. The reviewer reports no checkpoint stream, only
   * the owning runner's exact `media_review_finished`, so the caller must have authenticated that
   * channel and matched its generation, command and dispatch. Priced usage settles once, never
   * lowers recorded spend, and releases the unused reservation. Unpriced usage stops accounting
   * and retains the reservation, so historical provenance stays withheld. */
  settleMediaReview(sessionId: string, expected: { rootSessionId: string; generation: string },
    usage: { priced: true; costUsd: number; toolCalls: number } | { priced: false; toolCalls: number }): boolean {
    if (!Number.isSafeInteger(usage.toolCalls) || usage.toolCalls < 0 ||
      usage.priced && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) return false;
    return this.atomic(() => {
      const member = this.sql.prepare("SELECT * FROM campaign_budget_members WHERE session_id=?").get(sessionId) as
        (Member & { generation: string }) | undefined;
      if (!member || member.root_id !== expected.rootSessionId || member.generation !== expected.generation) return false;
      if (!member.active) return Boolean(this.completedAttestation(sessionId)); // Replay settles nothing new.
      if (!usage.priced) {
        this.stop(expected.rootSessionId, "accounting_unavailable", "Final media review usage is unpriced; reservation retained.");
        return false;
      }
      const cost = Math.max(member.cost, usage.costUsd), tools = Math.max(member.tools, usage.toolCalls);
      const checkpoint: import("@wollipog/protocol").CampaignBudgetUsageCheckpoint = {
        generation: expected.generation, historyEpoch: 0, throughSeq: 0, costUsd: usage.costUsd };
      this.sql.prepare("INSERT OR IGNORE INTO campaign_budget_settlements VALUES (?,?,?,?)").run(sessionId, JSON.stringify(checkpoint), cost, tools);
      this.sql.prepare("UPDATE campaign_budget_members SET cost=?,tools=?,active=0 WHERE session_id=?").run(cost, tools, sessionId);
      this.sql.prepare("DELETE FROM campaign_budget_checkpoints WHERE session_id=?").run(sessionId);
      return true;
    });
  }

  /** Only for a child whose creation failed before its launch was sent (#3183): it never ran, so
   * its reservation is returned rather than retained like a deleted child's (#1496). */
  releaseUnlaunched(sessionId: string): void {
    for (const table of ["campaign_budget_members", "campaign_budget_tool_calls", "campaign_budget_checkpoints", "campaign_budget_settlements"]) {
      this.sql.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
    }
  }

  membersForRunner(runnerId:string):string[] {
    return (this.sql.prepare(`SELECT m.session_id FROM campaign_budget_members m JOIN sessions s ON s.id=m.session_id
      WHERE s.runner_id=? AND m.active=1`).all(runnerId) as Array<{session_id:string}>).map((r)=>r.session_id);
  }

  dispatchState(sessionId:string):{active:boolean;generation:string;checkpoint:string|null} {
    const checkpoint=this.sql.prepare("SELECT checkpoint FROM campaign_budget_checkpoints WHERE session_id=?").get(sessionId) as {checkpoint:string}|undefined;
    return {active:this.active(sessionId),generation:this.dispatch(sessionId)!.generation,checkpoint:checkpoint?.checkpoint??null};
  }

  /** Only for a runner send that proved no command was enqueued; preserve old final evidence. */
  restoreUnsentDispatch(sessionId: string, state: ReturnType<CampaignBudgetLedger["dispatchState"]>): void {
    this.atomic(()=>{
      this.sql.prepare("UPDATE campaign_budget_members SET active=?,generation=? WHERE session_id=?").run(state.active?1:0,state.generation,sessionId);
      this.sql.prepare("DELETE FROM campaign_budget_checkpoints WHERE session_id=?").run(sessionId);
      if(state.checkpoint) this.sql.prepare("INSERT INTO campaign_budget_checkpoints VALUES (?,?)").run(sessionId,state.checkpoint);
    });
  }

  /** Record that the owning runner reconnected without this session alive, so no provider of its
   * current generation runs. That proves retirement for the slot even when the stop was already
   * confirmed by an earlier terminal status, or the final checkpoint never arrives. It settles no
   * usage: the reservation stays until a checkpoint does. Only the reconnect reconciliation may
   * call it. */
  noteProviderAbsent(sessionId: string): void {
    const dispatch = this.dispatch(sessionId);
    if (!dispatch) return;
    this.sql.prepare("UPDATE campaign_budget_members SET absent_generation=? WHERE session_id=? AND generation=? AND active=1")
      .run(dispatch.generation, sessionId, dispatch.generation);
  }

  /** Only the authenticated owning runner may supply a checkpoint. Do not accept agent JSON. */
  recordCheckpoint(sessionId: string, checkpoint: import("@wollipog/protocol").CampaignBudgetUsageCheckpoint): void {
    if (!this.root(sessionId) || !checkpoint || !Number.isSafeInteger(checkpoint.historyEpoch) || checkpoint.historyEpoch < 0 ||
        !Number.isSafeInteger(checkpoint.throughSeq) || checkpoint.throughSeq < 0 || !Number.isFinite(checkpoint.costUsd) || checkpoint.costUsd < 0 ||
        checkpoint.generation !== this.dispatch(sessionId)?.generation) return;
    this.sql.prepare("INSERT INTO campaign_budget_checkpoints VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET checkpoint=excluded.checkpoint")
      .run(sessionId,JSON.stringify(checkpoint));
  }

  /** Persist priced final usage before releasing unused capacity. Replay cannot refund spend. */
  settleCheckpoint(sessionId: string, history: { historyEpoch: number | null; hydratedSeq: number }): boolean {
    return this.atomic(() => {
      const record = this.sql.prepare("SELECT checkpoint FROM campaign_budget_checkpoints WHERE session_id=?").get(sessionId) as { checkpoint: string } | undefined;
      if (!record || this.sql.prepare("SELECT 1 FROM session_stop_intents WHERE session_id=?").get(sessionId)) return false;
      const checkpoint = JSON.parse(record.checkpoint) as import("@wollipog/protocol").CampaignBudgetUsageCheckpoint;
      if (checkpoint.generation !== this.dispatch(sessionId)?.generation) return false;
      const session = this.sql.prepare("SELECT status FROM sessions WHERE id=?").get(sessionId) as { status: string } | undefined;
      if (!session || !["completed","failed","stopped"].includes(session.status) || !checkpointEpochMatches(checkpoint.historyEpoch, history.historyEpoch) ||
          history.hydratedSeq < checkpoint.throughSeq) return false;
      // Unpriced final usage can settle only where no cost ceiling depends on it: the charge then keeps
      // the recorded cost, and the view reports cost accounting as unavailable.
      if (this.costCeiling(this.root(sessionId)!) &&
          this.sql.prepare("SELECT 1 FROM usage_session_state WHERE session_id=? AND unpriced_records>0").get(sessionId)) {
        this.stop(this.root(sessionId)!, "accounting_unavailable", "Final campaign usage is unpriced; reservation retained."); return false;
      }
      const member = this.sql.prepare("SELECT * FROM campaign_budget_members WHERE session_id=?").get(sessionId) as Member | undefined;
      if (!member) return false;
      // Runner cost can lag control-plane pricing; neither coordinate may lower the charge.
      const cost = Math.max(member.cost,checkpoint.costUsd);
      this.sql.prepare("INSERT OR IGNORE INTO campaign_budget_settlements VALUES (?,?,?,?)").run(sessionId,record.checkpoint,cost,member.tools);
      this.sql.prepare("UPDATE campaign_budget_members SET cost=?,active=0 WHERE session_id=?").run(cost,sessionId);
      this.sql.prepare("DELETE FROM campaign_budget_checkpoints WHERE session_id=?").run(sessionId);
      return true;
    });
  }

  /** Settle every ended member of a campaign whose final checkpoint its hydrated history already
   * covers. Hydration, reconnect and startup each try once, but a member's stop intent can outlive
   * all of them, and an archived member's history is never reloaded, so its reservation stayed
   * outstanding for good (#2940). Reads retry, so a campaign that leaked repairs on its next read.
   * Settlement is one-shot: a settled member leaves the set, and its charge never lowers. */
  private settleEnded(rootId: string): void {
    const ended = this.sql.prepare(`SELECT m.session_id, s.runner_history_epoch, s.hydrated_seq FROM campaign_budget_members m
      JOIN campaign_budget_checkpoints c ON c.session_id=m.session_id JOIN sessions s ON s.id=m.session_id
      WHERE m.root_id=? AND m.active=1 AND s.status IN ('completed','failed','stopped')
        AND NOT EXISTS (SELECT 1 FROM session_stop_intents WHERE session_id=m.session_id)`).all(rootId) as
      Array<{ session_id: string; runner_history_epoch: number | null; hydrated_seq: number }>;
    for (const row of ended) {
      this.settleCheckpoint(row.session_id, { historyEpoch: row.runner_history_epoch, hydratedSeq: row.hydrated_seq });
    }
  }

  dispatch(sessionId: string): import("@wollipog/protocol").CampaignBudgetDispatch | undefined {
    const row = this.sql.prepare("SELECT root_id,generation FROM campaign_budget_members WHERE session_id=?").get(sessionId) as {root_id:string;generation:string} | undefined;
    if (!row) return undefined;
    if (!row.generation) {
      row.generation = randomUUID();
      this.sql.prepare("UPDATE campaign_budget_members SET generation=? WHERE session_id=?").run(row.generation,sessionId);
    }
    return { rootSessionId: row.root_id, generation: row.generation };
  }

  /** Each replacement invalidates old terminal receipts before any runner dispatch. */
  replaceDispatch(sessionId: string): import("@wollipog/protocol").CampaignBudgetDispatch {
    this.sql.prepare("UPDATE campaign_budget_members SET generation=? WHERE session_id=?").run(randomUUID(),sessionId);
    this.sql.prepare("DELETE FROM campaign_budget_checkpoints WHERE session_id=?").run(sessionId);
    return this.dispatch(sessionId)!;
  }

  completedAttestation(sessionId:string):{rootSessionId:string;sessionId:string;checkpoint:import("@wollipog/protocol").CampaignBudgetUsageCheckpoint;
    actual:{costUsd:number;toolCalls:number};settlementDigest:string}|null {
    const member=this.sql.prepare("SELECT * FROM campaign_budget_members WHERE session_id=?").get(sessionId) as Member|undefined;
    if(!member || member.active) return null;
    const row=this.sql.prepare("SELECT * FROM campaign_budget_settlements WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(sessionId) as
      {checkpoint:string;cost:number;tools:number}|undefined;
    if(!row || member.cost>row.cost || member.tools>row.tools) return null;
    const checkpoint=JSON.parse(row.checkpoint) as import("@wollipog/protocol").CampaignBudgetUsageCheckpoint;
    if(checkpoint.generation!==this.dispatch(sessionId)?.generation) return null;
    const receipt={rootSessionId:member.root_id,sessionId,checkpoint,actual:{costUsd:row.cost,toolCalls:row.tools}};
    return {...receipt,settlementDigest:createHash("sha256").update(JSON.stringify(receipt)).digest("hex")};
  }

  admissionError(sessionId: string): string | null {
    const rootId = this.root(sessionId); if (!rootId) return null;
    const v = this.view(rootId)!;
    if (v.state !== "active") return v.reason ?? "campaign allowance unavailable";
    const row = this.sql.prepare(`SELECT m.*, ${LIVE_COST} AS live_cost FROM campaign_budget_members m
      LEFT JOIN sessions s ON s.id=m.session_id WHERE m.session_id=?`).get(sessionId) as Member & { live_cost: number };
    // An allocation reached by a running turn's estimate stops its worker, as a settled one does (#3196).
    const cost = row.live_cost > 0 ? roundUsdMicros(row.cost + row.live_cost) : row.cost;
    if (v.authority.costUsd !== undefined && (row.cost_limit === null || cost >= row.cost_limit) ||
        v.authority.toolCalls !== undefined && (row.tool_limit === null || row.tools >= row.tool_limit)) return "session campaign allocation reached; reallocate within the existing envelope before dispatch";
    return null;
  }

  /** Must run inside the session insertion transaction. A failed insert releases the reservation.
   * A launch needs a free slot unless the member still holds its own; changing a member's
   * allocation without launching it (`launch` false) needs none. */
  admit(rootId: string, allocation: CampaignBudgetAllocation, userLimits: { costUsd?: number; toolCalls?: number }, activate = true,
    launch = activate): void {
    this.atomic(() => {
      const v = this.view(rootId); if (!v || v.state !== "active") throw new Error(v?.reason ?? "campaign allowance unavailable");
      const old = this.sql.prepare(`SELECT m.*, ${LIVE_COST} AS live_cost, ${OCCUPYING} AS occupying FROM campaign_budget_members m
        LEFT JOIN sessions s ON s.id=m.session_id WHERE m.session_id=?`).get(allocation.sessionId) as Member & { live_cost: number; occupying: number } | undefined;
      // Spend includes a running turn's open estimate, as the view counts it (#3196).
      const spentCost = old ? old.live_cost > 0 ? roundUsdMicros(old.cost + old.live_cost) : old.cost : 0;
      if (old) allocation = { ...allocation, costUsd: allocation.costUsd ?? old.cost_limit ?? undefined, toolCalls: allocation.toolCalls ?? old.tool_limit ?? undefined };
      if (old && old.root_id !== rootId) throw new Error("session belongs to another allowance");
      const review = this.sql.prepare("SELECT 1 FROM review_sessions WHERE review_session_id=?").get(allocation.sessionId);
      if (!review && launch && !old?.occupying && allocation.sessionId !== rootId && v.authority.concurrency !== undefined && v.occupied >= v.authority.concurrency) throw new Error("campaign concurrency allowance reached");
      for (const [requested, spent, ceiling, userCeiling, remaining, prior] of [
        [allocation.costUsd, spentCost, v.authority.costUsd, old ? old.user_cost_limit : userLimits.costUsd, v.remaining.costUsd, old?.active ? Math.max(0,(old.cost_limit ?? 0)-spentCost) : 0],
        [allocation.toolCalls, old?.tools ?? 0, v.authority.toolCalls, old ? old.user_tool_limit : userLimits.toolCalls, v.remaining.toolCalls, old?.active ? Math.max(0,(old.tool_limit ?? 0)-old.tools) : 0],
      ]) {
        if (requested != null && (!Number.isFinite(requested) || requested < spent! || (userCeiling != null && requested > userCeiling))) throw new Error("allocation exceeds a tighter session ceiling or is below spent usage");
        if (ceiling != null && (requested == null || requested <= spent! || requested - spent! > (remaining ?? 0) + prior! + 1e-9)) throw new Error("allocation exceeds unreserved campaign allowance");
      }
      if (allocation.toolCalls !== undefined && !Number.isSafeInteger(allocation.toolCalls)) throw new Error("tool allocation must be an integer");
      this.sql.prepare(`INSERT INTO campaign_budget_members(session_id,root_id,cost,tools,cost_limit,tool_limit,user_cost_limit,user_tool_limit,active)
        VALUES (?,?,0,0,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET cost_limit=excluded.cost_limit,tool_limit=excluded.tool_limit,active=excluded.active`)
        .run(allocation.sessionId,rootId,allocation.costUsd??null,allocation.toolCalls??null,userLimits.costUsd??null,userLimits.toolCalls??null,activate?1:0);
      if (activate) this.sql.prepare("DELETE FROM campaign_budget_checkpoints WHERE session_id=?").run(allocation.sessionId);
      // A member that joins with unpriced usage already recorded makes the campaign's cost unknown.
      this.noteUnpriced(rootId);
    });
  }

  acceptFollowUp<T>(rootId: string, recommendationId: string, write: () => T): T {
    return this.atomic(() => {
      const view = this.view(rootId);
      if (!view) return write();
      const duplicate = this.sql.prepare("SELECT 1 FROM campaign_budget_follow_ups WHERE root_id=? AND recommendation_id=?").get(rootId,recommendationId);
      if (!duplicate && (view.state !== "active" || view.authority.acceptedFollowUps !== undefined && view.acceptedFollowUps >= view.authority.acceptedFollowUps)) throw new Error("campaign accepted follow-up allowance reached");
      const result = write();
      if (!duplicate) {
        this.sql.prepare("INSERT INTO campaign_budget_follow_ups VALUES (?,?)").run(rootId,recommendationId);
        this.sql.prepare("UPDATE campaign_budgets SET accepted_follow_ups=accepted_follow_ups+1 WHERE root_id=?").run(rootId);
      }
      return result;
    });
  }
}
