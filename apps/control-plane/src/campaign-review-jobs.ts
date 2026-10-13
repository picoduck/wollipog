import { createHash,randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { controlledReviewCapabilityKey, sanitizedCampaignReviewReason, type CampaignReviewJobCommand, type CampaignReviewJobUpdate, type CampaignReviewJobView, type ControlledReviewCapability, type CampaignReviewJobRequest } from "@wollipog/protocol";
import type { CampaignBudgetLedger } from "./campaign-budget.js";

type Row = { job_id: string; root_id: string; runner_id: string; command: string; state: CampaignReviewJobView["state"];
  round: number; attempt: number; cost: number | null; tools: number; valid: number; consumed: number; receipt: string | null; vote: CampaignReviewJobView["vote"] | null; reason: string | null; report: string|null };

/** This ledger has no agent-facing completion method. Authenticated runner receipts settle it. */
export class CampaignReviewJobs {
  constructor(private readonly sql: DatabaseSync, private readonly budgets: CampaignBudgetLedger,
    private readonly chargeScope:(rootId:string)=>{organizationId:string;userId:string}|null=()=>null) {
    sql.exec(`CREATE TABLE IF NOT EXISTS campaign_review_jobs (
      job_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, runner_id TEXT NOT NULL, request_id TEXT NOT NULL,
      target TEXT NOT NULL, base_sha TEXT NOT NULL, command TEXT NOT NULL, state TEXT NOT NULL,
      round INTEGER NOT NULL, attempt INTEGER NOT NULL, cost REAL, tools INTEGER NOT NULL DEFAULT 0,
      valid INTEGER NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 1, receipt TEXT, vote TEXT, reason TEXT,
      UNIQUE(root_id,request_id)
    );`);
    sql.exec("CREATE INDEX IF NOT EXISTS campaign_review_jobs_target ON campaign_review_jobs(root_id,target)");
    sql.exec(`CREATE TABLE IF NOT EXISTS campaign_review_daily_cost (
      job_id TEXT NOT NULL, organization_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL,
      cost REAL NOT NULL, PRIMARY KEY(job_id,day)
    );`);
    if(!(sql.prepare("PRAGMA table_info(campaign_review_jobs)").all() as Array<{name:string}>).some((c)=>c.name==="report")) sql.exec("ALTER TABLE campaign_review_jobs ADD COLUMN report TEXT");
    if(!(sql.prepare("PRAGMA table_info(campaign_review_jobs)").all() as Array<{name:string}>).some((c)=>c.name==="charge_scope")) sql.exec("ALTER TABLE campaign_review_jobs ADD COLUMN charge_scope TEXT");
  }

  private atomic<T>(work: () => T): T {
    this.sql.exec("SAVEPOINT campaign_review_job");
    try { const result=work(); this.sql.exec("RELEASE campaign_review_job"); return result; }
    catch(error) { this.sql.exec("ROLLBACK TO campaign_review_job; RELEASE campaign_review_job"); throw error; }
  }

  reserve(rootId: string, runnerId: string, worktreeSessionId: string, authorityRevision: number,
    profile: ControlledReviewCapability, request: CampaignReviewJobRequest, lineage?:CampaignReviewJobCommand["lineage"]): CampaignReviewJobCommand {
    return this.atomic(() => {
      const prior = this.sql.prepare("SELECT * FROM campaign_review_jobs WHERE root_id=? AND request_id=?").get(rootId,request.requestId) as Row | undefined;
      if (prior) {
        const command=JSON.parse(prior.command) as CampaignReviewJobCommand;
        if (JSON.stringify(command.request)!==JSON.stringify(request) || command.worktreeSessionId!==worktreeSessionId ||
            command.authorityRevision!==authorityRevision || JSON.stringify(command.lineage)!==JSON.stringify(lineage) || controlledReviewCapabilityKey(command.profile)!==controlledReviewCapabilityKey(profile)) throw new Error("review request identity conflicts with its durable dispatch");
        return command;
      }
      const target=`${request.pullRequest.repository.toLowerCase()}#${request.pullRequest.number}`;
      const epoch = this.sql.prepare("SELECT * FROM campaign_review_jobs WHERE root_id=? AND target=? AND base_sha=? ORDER BY rowid").all(rootId,target,request.baseSha) as unknown as Row[];
      if (epoch.some((r) => ["reserved","running","accounting_unavailable"].includes(r.state))) throw new Error("the exact review epoch already has an unsettled attempt");
      const round=1+epoch.filter((r)=>r.valid).length;
      const attempt=1+epoch.filter((r)=>r.round===round && r.consumed).length;
      if (round>4 || attempt>2) throw new Error("controlled review limit reached (four valid rounds, two launched attempts per round)");
      const jobId=`review_${randomUUID()}`;
      const command: CampaignReviewJobCommand={type:"campaign_review_job",jobId,nonce:randomUUID(),rootSessionId:rootId,
        authorityRevision,worktreeSessionId,profile,request,...(lineage?{lineage}:{})};
      this.budgets.admit(rootId,{sessionId:jobId,costUsd:request.costUsd,toolCalls:request.toolCalls},{});
      this.sql.prepare(`INSERT INTO campaign_review_jobs(job_id,root_id,runner_id,request_id,target,base_sha,command,state,round,attempt)
        VALUES (?,?,?,?,?,?,?,'reserved',?,?)`).run(jobId,rootId,runnerId,request.requestId,target,request.baseSha,JSON.stringify(command),round,attempt);
      this.sql.prepare("UPDATE campaign_review_jobs SET charge_scope=? WHERE job_id=?").run(JSON.stringify(this.chargeScope(rootId)),jobId);
      return command;
    });
  }

  commands(runnerId: string): CampaignReviewJobCommand[] {
    return (this.sql.prepare("SELECT command FROM campaign_review_jobs WHERE runner_id=? AND state IN ('reserved','running')").all(runnerId) as Array<{command:string}>).map((r)=>JSON.parse(r.command));
  }

  command(jobId: string): CampaignReviewJobCommand | null {
    const row=this.sql.prepare("SELECT command FROM campaign_review_jobs WHERE job_id=?").get(jobId) as {command:string} | undefined;
    return row?JSON.parse(row.command):null;
  }

  view(jobId: string): CampaignReviewJobView | null {
    const row=this.sql.prepare("SELECT * FROM campaign_review_jobs WHERE job_id=?").get(jobId) as Row | undefined;
    if (!row) return null;
    const command=JSON.parse(row.command) as CampaignReviewJobCommand;
    const {brief:_,...request}=command.request;
    const final=["completed","not_launched","accounting_unavailable"].includes(row.state);
    const reviewEpoch=createHash("sha256").update(JSON.stringify([row.root_id,request.pullRequest,request.baseSha,command.profile.controllerSha256])).digest("hex");
    return {jobId,rootSessionId:row.root_id,authorityRevision:command.authorityRevision,workItemAttemptId:command.lineage?.workItemAttemptId??null,issue:command.lineage?.issue??null,
      worktreeSessionId:command.worktreeSessionId,profile:command.profile,
      reviewEpoch,state:row.state,round:row.round,attempt:row.attempt,request,costUsd:row.cost,toolCalls:row.tools,
      attemptValid:final?Boolean(row.valid):null,attemptConsumed:final?Boolean(row.consumed):null,
      usageSettlement:row.state==="accounting_unavailable"?"unavailable":final?"settled":"pending",
      terminalOutcome:!final?null:row.state==="not_launched"?"not_launched":row.state==="accounting_unavailable"?"unknown":row.valid?"valid_review":"invalid_review",
      ...(row.receipt?{receiptSha256:row.receipt}:{}),...(row.vote?{vote:row.vote}:{}),...(row.reason?{reason:row.reason}:{})};
  }

  page(rootId:string,afterJobId:string|undefined,limit:number,workItemId?:string):{jobs:CampaignReviewJobView[];nextAfterJobId:string|null} {
    const rows=this.sql.prepare(`SELECT job_id FROM campaign_review_jobs WHERE root_id=? AND job_id>? AND
      (? IS NULL OR json_extract(command,'$.request.workItemId')=?) ORDER BY job_id LIMIT ?`).all(rootId,afterJobId??"",workItemId??null,workItemId??null,limit+1) as Array<{job_id:string}>;
    const visible=rows.slice(0,limit);
    return {jobs:visible.map((r)=>this.view(r.job_id)!),nextAfterJobId:rows.length>limit?visible.at(-1)!.job_id:null};
  }

  /** Server-owned recovery metadata, without provider output or a new priced admission. */
  recoveryJobs(rootId: string): CampaignReviewJobView[] {
    // Only the latest exact target's settled result can request repair. Every unknown outcome
    // remains retained, including an earlier epoch: a newer review cannot settle its spend.
    const rows = this.sql.prepare(`SELECT job_id FROM campaign_review_jobs job WHERE root_id=? AND
      (state='accounting_unavailable' OR NOT EXISTS (SELECT 1 FROM campaign_review_jobs newer
        WHERE newer.root_id=job.root_id AND newer.target=job.target AND newer.rowid>job.rowid))
      ORDER BY rowid`).all(rootId) as Array<{ job_id: string }>;
    return rows.map(row => this.view(row.job_id)!);
  }

  /** Separate, authorized review-output access. Recovery metadata never includes provider output. */
  validatedReport(jobId:string):string|null {
    const row=this.sql.prepare("SELECT report FROM campaign_review_jobs WHERE job_id=? AND state='completed' AND valid=1").get(jobId) as {report:string|null}|undefined;
    return row?.report??null;
  }

  /** Return false for another runner, a changed dispatch, or a malformed/replayed final result. */
  accept(runnerId: string, update: CampaignReviewJobUpdate): boolean {
    return this.atomic(() => {
      const row=this.sql.prepare("SELECT * FROM campaign_review_jobs WHERE job_id=? AND runner_id=?").get(update.jobId,runnerId) as Row | undefined;
      if (!row) return false;
      const command=JSON.parse(row.command) as CampaignReviewJobCommand;
      if (command.nonce!==update.nonce || !Number.isSafeInteger(update.toolCalls) || update.toolCalls<row.tools ||
          update.costUsd!==undefined && (!Number.isFinite(update.costUsd) || update.costUsd<0 || update.costUsd<(row.cost??0))) return false;
      if (["completed","not_launched"].includes(row.state)) return row.state===update.state && row.receipt===update.receiptSha256 &&
        row.cost===update.costUsd && row.tools===update.toolCalls && row.valid===(update.attemptValid?1:0);
      if (!["running","completed","accounting_unavailable","not_launched"].includes(update.state)) return false;
      if (["completed","not_launched"].includes(update.state) && (!/^[a-f0-9]{64}$/.test(update.receiptSha256??"") ||
          update.costUsd===undefined || update.attemptValid===true && !["UPVOTE","DOWNVOTE"].includes(update.vote??"") ||
          update.state==="not_launched" && (update.costUsd!==0 || update.toolCalls!==0 || update.attemptConsumed!==false))) return false;
      const final=["completed","not_launched"].includes(update.state);
      const delta=(update.costUsd??row.cost??0)-(row.cost??0);
      if(delta>0) {
        const scopeRow=this.sql.prepare("SELECT charge_scope FROM campaign_review_jobs WHERE job_id=?").get(update.jobId) as {charge_scope:string|null};
        const scope=scopeRow.charge_scope?JSON.parse(scopeRow.charge_scope):null;
        if(scope) this.sql.prepare(`INSERT INTO campaign_review_daily_cost VALUES (?,?,?,?,?)
          ON CONFLICT(job_id,day) DO UPDATE SET cost=cost+excluded.cost`).run(update.jobId,scope.organizationId,scope.userId,new Date().toISOString().slice(0,10),delta);
      }
      // Receipt, usage and reservation release commit together. Failed paid reviews also count.
      this.sql.prepare("UPDATE campaign_budget_members SET cost=MAX(cost,?),tools=MAX(tools,?),active=? WHERE session_id=?")
        .run(update.costUsd??row.cost??0,update.toolCalls,final?0:1,update.jobId);
      this.sql.prepare("UPDATE campaign_review_jobs SET state=?,cost=?,tools=?,valid=?,consumed=?,receipt=?,vote=?,reason=?,report=? WHERE job_id=?")
        .run(update.state,update.costUsd??row.cost,update.toolCalls,update.attemptValid?1:0,update.attemptConsumed===false?0:1,
          update.receiptSha256??null,update.vote??null,update.reason===undefined?null:sanitizedCampaignReviewReason(update.reason),update.report?.slice(0,200_000)??null,update.jobId);
      if (update.state==="accounting_unavailable") this.budgets.stop(row.root_id,"accounting_unavailable","Required native review usage is unavailable; its reservation is retained and protected admission stopped.");
      this.budgets.view(row.root_id); // Apply exhaustion before any next admission.
      return true;
    });
  }
}
