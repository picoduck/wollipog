import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { validCampaignBudgetAuthority, type CampaignBudgetAllocation, type CampaignBudgetAuthority, type CampaignBudgetView } from "@wollipog/protocol";

type Member = { session_id: string; root_id: string; cost: number; tools: number; cost_limit: number | null; tool_limit: number | null;
  user_cost_limit: number | null; user_tool_limit: number | null; active: number };

/** No foreign keys: deletion, transcript replacement and retired attempts must not refund spend.
 * Usage is each session's own monotonic peak, never the recursively reserved child charge. */
export class CampaignBudgetLedger {
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
    const header = this.sql.prepare("SELECT * FROM campaign_budgets WHERE root_id=?").get(rootId) as
      { authority: string; state: CampaignBudgetView["state"]; reason: string | null; accepted_follow_ups: number } | undefined;
    if (!header) return undefined;
    const authority = JSON.parse(header.authority) as CampaignBudgetAuthority;
    const unpriced = Boolean(this.sql.prepare(`SELECT 1 FROM usage_session_state u
      JOIN campaign_budget_members m ON m.session_id=u.session_id WHERE m.root_id=? AND u.unpriced_records>0 LIMIT 1`).get(rootId));
    if (header.state === "active" && unpriced) {
      this.stop(rootId, "accounting_unavailable", "Unpriced campaign usage detected; protected admission stopped without a continue prompt.");
      header.state = "accounting_unavailable"; header.reason = "Unpriced campaign usage detected; protected admission stopped without a continue prompt.";
    }
    const rows = this.sql.prepare("SELECT * FROM campaign_budget_members WHERE root_id=?").all(rootId) as unknown as Member[];
    const actual = { costUsd: 0, toolCalls: 0 }, outstanding = { costUsd: 0, toolCalls: 0 };
    for (const row of rows) {
      actual.costUsd += row.cost; actual.toolCalls += row.tools;
      if (row.active) {
        outstanding.costUsd += Math.max(0, (row.cost_limit ?? row.cost) - row.cost);
        outstanding.toolCalls += Math.max(0, (row.tool_limit ?? row.tools) - row.tools);
      }
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
      occupied: rows.filter((r) => r.active && r.session_id !== rootId).length,
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
          MAX(s.usage_peak_tool_calls,COALESCE((SELECT tool_calls FROM session_tool_call_counts WHERE session_id=s.id),0)) AS tools,
          s.cost_budget_usd AS cost_limit, s.max_tool_calls AS tool_limit FROM sessions s JOIN members m ON s.id=m.id`).all(rootId) as unknown as
          Array<{ id: string; status: string; cost: number; tools: number; cost_limit: number | null; tool_limit: number | null }>;
      for (const m of members) {
        const count = (this.sql.prepare("SELECT COUNT(DISTINCT json_extract(payload,'$.toolCallId')) AS n FROM session_events WHERE session_id=? AND kind='tool_call'").get(m.id) as { n: number }).n;
        if (!old && authority.toolCalls !== undefined && m.tools > count) throw new Error("Campaign tool accounting is unavailable because preauthorization history is incomplete; protected admission is refused.");
        this.sql.prepare(`INSERT OR IGNORE INTO campaign_budget_members(session_id,root_id,cost,tools,cost_limit,tool_limit,user_cost_limit,user_tool_limit,active)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(m.id,rootId,m.cost,m.tools,m.cost_limit,m.tool_limit,m.cost_limit,m.tool_limit,["completed","failed","stopped"].includes(m.status)?0:1);
        this.sql.prepare(`INSERT OR IGNORE INTO campaign_budget_tool_calls(session_id,tool_call_id)
          SELECT session_id,json_extract(payload,'$.toolCallId') FROM session_events WHERE session_id=? AND kind='tool_call' AND json_extract(payload,'$.toolCallId') IS NOT NULL`).run(m.id);
      }
      // All live members need finite reservations before authority is usable. Preserve tighter
      // existing session ceilings; otherwise divide free capacity, including a root share.
      const rows = this.sql.prepare("SELECT * FROM campaign_budget_members WHERE root_id=? AND active=1").all(rootId) as unknown as Member[];
      const used = this.view(rootId)!;
      for (const r of rows) {
        if (old && (authority.costUsd === undefined || r.cost_limit !== null) && (authority.toolCalls === undefined || r.tool_limit !== null)) continue;
        const cost = authority.costUsd === undefined ? r.cost_limit : Math.min(r.cost_limit ?? Infinity,
          r.cost + Math.max(0, authority.costUsd - used.actual.costUsd) / Math.max(1, rows.length + (authority.concurrency ?? 1)));
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
      if (!session || !["completed","failed","stopped"].includes(session.status) || history.historyEpoch !== checkpoint.historyEpoch ||
          history.hydratedSeq < checkpoint.throughSeq) return false;
      if (this.sql.prepare("SELECT 1 FROM usage_session_state WHERE session_id=? AND unpriced_records>0").get(sessionId)) {
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
    const row = this.sql.prepare("SELECT * FROM campaign_budget_members WHERE session_id=?").get(sessionId) as Member;
    if (v.authority.costUsd !== undefined && (row.cost_limit === null || row.cost >= row.cost_limit) ||
        v.authority.toolCalls !== undefined && (row.tool_limit === null || row.tools >= row.tool_limit)) return "session campaign allocation reached; reallocate within the existing envelope before dispatch";
    return null;
  }

  /** Must run inside the session insertion transaction. A failed insert releases the reservation. */
  admit(rootId: string, allocation: CampaignBudgetAllocation, userLimits: { costUsd?: number; toolCalls?: number }, activate = true): void {
    this.atomic(() => {
      const v = this.view(rootId); if (!v || v.state !== "active") throw new Error(v?.reason ?? "campaign allowance unavailable");
      const old = this.sql.prepare("SELECT * FROM campaign_budget_members WHERE session_id=?").get(allocation.sessionId) as Member | undefined;
      if (old) allocation = { ...allocation, costUsd: allocation.costUsd ?? old.cost_limit ?? undefined, toolCalls: allocation.toolCalls ?? old.tool_limit ?? undefined };
      if (old && old.root_id !== rootId) throw new Error("session belongs to another allowance");
      if (activate && !old?.active && allocation.sessionId !== rootId && v.authority.concurrency !== undefined && v.occupied >= v.authority.concurrency) throw new Error("campaign concurrency allowance reached");
      for (const [requested, spent, ceiling, userCeiling, remaining, prior] of [
        [allocation.costUsd, old?.cost ?? 0, v.authority.costUsd, old ? old.user_cost_limit : userLimits.costUsd, v.remaining.costUsd, old?.active ? Math.max(0,(old.cost_limit ?? 0)-old.cost) : 0],
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
