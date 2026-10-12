import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CONTROLLED_REVIEW_PROFILE, controlledReviewCapabilityKey, sanitizedCampaignReviewReason, type CampaignReviewJobCommand, type CampaignReviewJobUpdate, type ControlledReviewCapability } from "@wollipog/protocol";
import type { SessionStore } from "./session-store.js";
import { githubSlug } from "./git-ops.js";
import { githubRepository } from "./campaign-forge-status.js";

// Audited installed controller; no code is copied, edited, or substituted by this adapter.
const CONTROLLER_SHA = "769fd5ddec331f150caef27775b4f3cff2dd08c31096f9f24c9543c9fdcd8bb3";
const sha=(bytes: string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
const finite=(v:unknown):v is number=>typeof v==="number" && Number.isFinite(v) && v>=0;
const hashFile=(path:string)=>sha(readFileSync(path));
const run=promisify(execFile);
function executable(name:string):string {
  for(const dir of (process.env.PATH??"").split(":")) {
    if (!dir || !dir.startsWith("/")) continue;
    const path=join(dir,name);
    if(existsSync(path) && statSync(path).isFile() && (statSync(path).mode & 0o111)) return realpathSync(path);
  }
  throw new Error(`${name} is unavailable`);
}
async function installation(agentId:string) {
  if(process.platform!=="linux") throw new Error("controlled native review accounting supports audited Linux hosts only");
  const controller=resolve(homedir(),".agents/skills/cross-model-review/scripts/run_review.py");
  if(hashFile(controller)!==CONTROLLER_SHA) throw new Error("installed review controller differs from the audited version");
  const claude=executable("claude"), python=executable("python3");
  const version=(await run(claude,["--version"],{encoding:"utf8",timeout:10_000})).stdout.trim().split(" ")[0];
  if(version!=="2.1.287") throw new Error("native reviewer usage provenance is unsupported for this CLI version");
  const help=(await run(claude,["--help"],{encoding:"utf8",timeout:10_000})).stdout;
  for(const flag of ["--model","--effort","--tools","--allowedTools","--permission-mode","--disable-slash-commands","--strict-mcp-config","--no-session-persistence","--output-format"]) {
    if(!help.includes(flag)) throw new Error(`controlled reviewer lacks ${flag}`);
  }
  const profile:ControlledReviewCapability={profile:CONTROLLED_REVIEW_PROFILE,controllerSha256:CONTROLLER_SHA,
    executableSha256:hashFile(claude),cliVersion:"2.1.287",accounting:"provider_list_estimate",account:"runner_default_claude",agentId};
  return {controller,claude,python,profile};
}
export async function discoverControlledReview(agentId:string|undefined):Promise<ControlledReviewCapability|undefined> {
  try { return agentId?(await installation(agentId)).profile:undefined; } catch { return undefined; }
}

/** Canonical, bounded REST route works with older gh versions lacking baseRefOid JSON fields. */
export async function controlledReviewForgeTarget(request:CampaignReviewJobCommand["request"],origin:string,
  gh:(args:string[])=>Promise<string>):Promise<void> {
  const ref=request.pullRequest;
  if(!githubRepository(ref) || githubSlug(origin)?.toLowerCase()!==ref.repository.toLowerCase()) throw new Error("native reviewer repository identity is outside its authorized target");
  const response=JSON.parse(await gh(["api",`repos/${ref.repository}/pulls/${ref.number}`]));
  const url=`https://github.com/${ref.repository}/pull/${ref.number}`;
  if(response.number!==ref.number || typeof response.html_url!=="string" || response.html_url.toLowerCase()!==url.toLowerCase() ||
      response.state!=="open" || response.base?.repo?.full_name?.toLowerCase()!==ref.repository.toLowerCase() ||
      response.head?.repo?.full_name?.toLowerCase()!==ref.repository.toLowerCase() ||
      response.head?.sha!==request.headSha || response.base?.sha!==request.baseSha) throw new Error("review epoch differs from the current canonical forge target");
}

/** Parse bytes captured directly from the owned provider pipe, never caller-supplied cost JSON. */
export function controlledReviewUsage(raw:string, final:boolean):{costUsd?:number;toolCalls:number;priced:boolean;reason?:string} {
  let initialized=false, sessionId:string|undefined, costUsd:number|undefined;
  const ids=new Set<string>();
  try {
    const lines=raw.split("\n");
    if(!final) lines.pop();
    for(const line of lines) {
      if(!line.trim()) continue;
      const event=JSON.parse(line);
      if(event.type==="system" && event.subtype==="init") {
        if(initialized || event.model!=="claude-opus-5-5" || event.permissionMode!=="dontAsk" ||
            JSON.stringify(event.tools)!==JSON.stringify(["Read"]) || typeof event.session_id!=="string") throw new Error("native reviewer init identity/tool policy mismatch");
        initialized=true; sessionId=event.session_id;
      }
      for(const item of event.message?.content??[]) {
        if(item.type!=="tool_use") continue;
        if(!initialized || item.name!=="Read" || typeof item.id!=="string") throw new Error("native reviewer tool provenance mismatch");
        ids.add(item.id);
      }
      if(event.type==="result") {
        if(!initialized || event.session_id!==sessionId || !finite(event.total_cost_usd)) throw new Error("native reviewer final usage identity missing");
        const entries=Object.entries(event.modelUsage??{});
        if(entries.length!==1 || entries[0]![0]!=="claude-opus-5-5") throw new Error("native reviewer model pricing is unavailable");
        const u=entries[0]![1] as Record<string,unknown>;
        if(u.canonicalModel!=="claude-opus-5-5" || u.provider!=="firstParty" || u.costBasis!=="list" || !finite(u.costUSD) ||
            [u.inputTokens,u.outputTokens,u.cacheReadInputTokens,u.cacheCreationInputTokens].some((v)=>!Number.isSafeInteger(v) || (v as number)<0) ||
            Math.abs(u.costUSD-event.total_cost_usd)>1e-8) throw new Error("native reviewer cost is unpriced or inconsistent");
        if(event.is_error && event.total_cost_usd===0 && [u.inputTokens,u.outputTokens,u.cacheReadInputTokens,u.cacheCreationInputTokens].every((v)=>v===0)) throw new Error("native reviewer final usage identity missing");
        // Fresh process totals are cumulative. Intermediate result cycles must never refund.
        if(costUsd!==undefined && event.total_cost_usd<costUsd) throw new Error("native reviewer cost regressed");
        costUsd=event.total_cost_usd;
      }
    }
    return {costUsd,toolCalls:ids.size,priced:!final || initialized && costUsd!==undefined};
  } catch(error) {
    return {costUsd,toolCalls:ids.size,priced:false,reason:sanitizedCampaignReviewReason((error as Error).message)};
  }
}

interface State { command:CampaignReviewJobCommand; repo:string; args:string[]; phase:"prepared"|"launching"|"running"|"finished";
  pid?:number; startIdentity?:string; providerPid?:number; providerStartIdentity?:string; recoveryAttempted?:boolean; cancelled?:boolean; update?:CampaignReviewJobUpdate }
function processIdentity(pid:number):string|null {
  try { const stat=readFileSync(`/proc/${pid}/stat`,"utf8");return stat.slice(stat.lastIndexOf(")")+2).split(" ")[19]??null; }
  catch { return null; }
}

/** Runner-owned private artifacts and process identity make retry/restart one-shot. */
export class ControlledCampaignReviewer {
  private readonly polling=new Map<string,ReturnType<typeof setTimeout>>();
  private readonly dispatching=new Set<string>();
  constructor(private readonly root:string,private readonly store:SessionStore,private readonly send:(u:CampaignReviewJobUpdate)=>void,
    private readonly reserve:(jobId:string,agentId:string)=>boolean,private readonly release:(jobId:string)=>void) {
    mkdirSync(root,{recursive:true,mode:0o700});
    // Reclaim host capacity for surviving owned jobs before ordinary provider dispatch resumes.
    // No provider is launched here; current server authority is required for reconciliation.
    for(const name of readdirSync(root)) {
      if(!/^review_[a-f0-9-]{36}$/.test(name)) continue;
      try {
        const state=JSON.parse(readFileSync(join(root,name,"state.json"),"utf8")) as State;
        const alive=state.pid && state.startIdentity && processIdentity(state.pid)===state.startIdentity ||
          state.providerPid && state.providerStartIdentity && processIdentity(state.providerPid)===state.providerStartIdentity;
        if(state.phase!=="finished" && alive && !reserve(name,state.command.profile.agentId)) this.cancel(name,state.command.nonce);
      } catch {}
    }
  }
  private dir(id:string):string {
    if(!/^review_[a-f0-9-]{36}$/.test(id)) throw new Error("invalid managed review job identity");
    return join(this.root,id);
  }
  private save(dir:string,state:State):void {
    const path=join(dir,"state.json");writeFileSync(`${path}.next`,JSON.stringify(state),{mode:0o600});renameSync(`${path}.next`,path);
  }
  private emit(dir:string,state:State,update:CampaignReviewJobUpdate):void {
    state.update=update;
    if(["completed","not_launched","accounting_unavailable"].includes(update.state)) state.phase="finished";
    this.save(dir,state);
    if(["completed","not_launched"].includes(update.state)) this.release(state.command.jobId);
    this.send(update);
  }
  async dispatch(command:CampaignReviewJobCommand):Promise<void> {
    if(this.dispatching.has(command.jobId)) return;
    this.dispatching.add(command.jobId);
    try { await this.dispatchOwned(command); } finally {this.dispatching.delete(command.jobId);}
  }
  private async dispatchOwned(command:CampaignReviewJobCommand):Promise<void> {
    const dir=this.dir(command.jobId);
    if(existsSync(join(dir,"state.json"))) {
      const state=JSON.parse(readFileSync(join(dir,"state.json"),"utf8")) as State;
      if(JSON.stringify(state.command)!==JSON.stringify(command)) return;
      if(state.phase==="finished" && state.update) this.send(state.update);
      else {
        if(!this.reserve(command.jobId,command.profile.agentId)) this.cancel(command.jobId,command.nonce);
        this.poll(dir,state);
      }
      return;
    }
    mkdirSync(dir,{mode:0o700});
    const state:State={command,repo:"",args:[],phase:"prepared"};
    this.save(dir,state); // Durable intent exists before anything can launch.
    try {
      const install=await installation(command.profile.agentId);
      if(controlledReviewCapabilityKey(install.profile)!==controlledReviewCapabilityKey(command.profile)) throw new Error("human-authorized native profile changed");
      if(!this.reserve(command.jobId,command.profile.agentId)) throw new Error("native reviewer host/provider admission is currently unavailable");
      const meta=this.store.readMeta(command.worktreeSessionId);
      if(!meta?.worktreePath || !meta.worktrees?.some((w)=>w.path===meta.worktreePath && w.source==="created") ||
          meta.context?.kind==="wsl" || meta.executionTarget?.adapter && meta.executionTarget.adapter!=="host") throw new Error("review requires the owned native managed worktree");
      state.repo=realpathSync(meta.worktreePath);
      const git=async(args:string[])=>(await run("git",["-C",state.repo,...args],{encoding:"utf8",timeout:10_000,maxBuffer:4_000_000})).stdout;
      const r=command.request;
      if((await git(["status","--porcelain"])).trim() || (await git(["rev-parse","HEAD"])).trim()!==r.headSha) throw new Error("controlled review requires the exact clean assigned head");
      await controlledReviewForgeTarget(r,(await git(["remote","get-url","origin"])).trim(),async(args)=>
        (await run("gh",args,{encoding:"utf8",timeout:30_000,maxBuffer:2_000_000,env:{...process.env,GH_PROMPT_DISABLED:"1",GH_PAGER:"cat"}})).stdout);
      const diff=await git(["diff","--binary","--no-ext-diff","--no-textconv",`${r.baseSha}...HEAD`,"--"]);
      const files=await git(["diff","--name-only","--diff-filter=ACDMRTUXB",`${r.baseSha}...HEAD`,"--"]);
      if((JSON.parse(readFileSync(join(dir,"state.json"),"utf8")) as State).cancelled) throw new Error("review admission was revoked before provider dispatch");
      writeFileSync(join(dir,"changed-files.txt"),files,{mode:0o600});
      writeFileSync(join(dir,"brief.md"),r.brief,{mode:0o600});
      state.args=[install.controller,"--repo",state.repo,"--base-ref",r.baseSha,"--expected-base",r.baseSha,"--expected-head",r.headSha,
        "--expected-diff-sha256",sha(diff),"--changed-files-file",join(dir,"changed-files.txt"),"--prompt-file",join(dir,"brief.md"),
        "--stdout-file",join(dir,"provider.jsonl"),"--stderr-file",join(dir,"provider.stderr"),"--summary-file",join(dir,"summary.json")];
      state.phase="launching";this.save(dir,state);
      // The installed controller resolves `claude` itself. Put only its verified directory first;
      // verify the resulting executable again immediately before owned dispatch.
      const bin=join(dir,"bin");mkdirSync(bin,{mode:0o700});symlinkSync(install.claude,join(bin,"claude"));
      const env:NodeJS.ProcessEnv={...process.env,PATH:`${bin}:/usr/bin:/bin`};
      delete env.CLAUDE_MODEL; delete env.CLAUDE_CODE_EFFORT_LEVEL;
      const child=spawn(install.python,["-I",...state.args],{cwd:state.repo,env,stdio:"ignore",detached:true});
      state.pid=child.pid;state.startIdentity=child.pid?processIdentity(child.pid)??undefined:undefined;
      state.phase="running";this.save(dir,state);
      child.on("error",()=>this.poll(dir,state));child.on("exit",()=>this.poll(dir,state));
      this.poll(dir,state);
    } catch(error) {
      // Once launching was persisted, failure is ambiguous and capacity cannot be refunded.
      const launched=state.phase!=="prepared";
      const reason=sanitizedCampaignReviewReason((error as Error).message);
      const receipt=sha(JSON.stringify({jobId:command.jobId,nonce:command.nonce,reason,launched}));
      this.emit(dir,state,{type:"campaign_review_job_update",jobId:command.jobId,nonce:command.nonce,
        state:launched?"accounting_unavailable":"not_launched",...(launched?{}:{costUsd:0}),toolCalls:0,
        attemptConsumed:launched,attemptValid:false,receiptSha256:receipt,reason});
    }
  }
  private poll(dir:string,state:State):void {
    if(state.phase==="finished") return;
    const key=state.command.jobId;
    const previous=this.polling.get(key);if(previous) clearTimeout(previous);
    let summary:any;
    try { summary=JSON.parse(readFileSync(join(dir,"summary.json"),"utf8")); } catch {}
    const final=summary?.status==="complete";
    if(Number.isSafeInteger(summary?.child_pid) && !state.providerPid) {
      state.providerPid=summary.child_pid;state.providerStartIdentity=processIdentity(summary.child_pid)??undefined;this.save(dir,state);
    }
    let raw="";
    try { const path=join(dir,"provider.jsonl");if(statSync(path).size>128_000_000) throw new Error("review output exceeds bounded accounting capacity");raw=readFileSync(path,"utf8"); }
    catch(error) { if(existsSync(join(dir,"provider.jsonl"))) { this.cancel(key,state.command.nonce); } }
    const usage=controlledReviewUsage(raw,final);
    const alive=Boolean(state.pid && state.startIdentity && processIdentity(state.pid)===state.startIdentity ||
      state.providerPid && state.providerStartIdentity && processIdentity(state.providerPid)===state.providerStartIdentity);
    if(!final && !alive && !state.recoveryAttempted && controlledReviewUsage(raw,true).priced && state.args.length) {
      state.recoveryAttempted=true;this.save(dir,state);
      void (async()=>{
        try {
          const install=await installation(state.command.profile.agentId);
          if(controlledReviewCapabilityKey(install.profile)!==controlledReviewCapabilityKey(state.command.profile)) throw new Error("native recovery profile changed");
          await run(install.python,["-I",...state.args,"--recover"],{cwd:state.repo,timeout:30_000,maxBuffer:100_000});
        } catch {}
        this.poll(dir,state);
      })();return;
    }
    if(final && summary.launched===false && summary.phase==="preflight") {
      this.emit(dir,state,{type:"campaign_review_job_update",jobId:key,nonce:state.command.nonce,state:"not_launched",costUsd:0,toolCalls:0,
        attemptConsumed:false,attemptValid:false,receiptSha256:sha(readFileSync(join(dir,"summary.json"))),reason:"controlled reviewer preflight refused"});return;
    }
    if(final || !alive || !usage.priced) {
      if(alive && !usage.priced) this.cancel(key,state.command.nonce);
      const priced=final && usage.priced && usage.costUsd!==undefined;
      const bound=summary?.reviewed_head===state.command.request.headSha && summary?.reviewed_base===state.command.request.baseSha &&
        summary?.models?.length===1 && summary.models[0]==="claude-opus-5-5" && summary?.diff_sha256===state.args[state.args.indexOf("--expected-diff-sha256")+1];
      let report:string|undefined;
      if(final && priced) for(const line of raw.split("\n")) {
        if(!line.trim()) continue;
        const item=JSON.parse(line);if(item.type==="result" && typeof item.result==="string") report=item.result.slice(0,200_000);
      }
      this.emit(dir,state,{type:"campaign_review_job_update",jobId:key,nonce:state.command.nonce,state:priced?"completed":"accounting_unavailable",
        costUsd:usage.costUsd,toolCalls:usage.toolCalls,attemptConsumed:true,attemptValid:priced && bound && summary?.attempt_valid===true,
        vote:priced && bound && summary?.attempt_valid?summary.effective_vote:"INVALID",receiptSha256:sha(raw+JSON.stringify(summary??{})),
        ...(report?{report}:{}),
        ...(!priced?{reason:usage.reason??"Native reviewer ended without durable priced final usage; reservation retained."}:{})});return;
    }
    this.send({type:"campaign_review_job_update",jobId:key,nonce:state.command.nonce,state:"running",costUsd:usage.costUsd,toolCalls:usage.toolCalls});
    if(usage.toolCalls>=state.command.request.toolCalls || usage.costUsd!==undefined && usage.costUsd>=state.command.request.costUsd) this.cancel(key,state.command.nonce);
    const timer=setTimeout(()=>this.poll(dir,state),1000);timer.unref();this.polling.set(key,timer);
  }
  cancel(jobId:string,nonce:string):void {
    try {
      const dir=this.dir(jobId),state=JSON.parse(readFileSync(join(dir,"state.json"),"utf8")) as State;
      if(state.command.nonce!==nonce || state.phase==="finished") return;
      state.cancelled=true;this.save(dir,state);
      if(!state.pid) return;
      const controllerAlive=state.startIdentity && processIdentity(state.pid)===state.startIdentity;
      const providerAlive=state.providerPid && state.providerStartIdentity && processIdentity(state.providerPid)===state.providerStartIdentity;
      if(!controllerAlive && !providerAlive) return;
      // Only our recorded process-group leader and its provider children, never hosting services.
      process.kill(-state.pid,"SIGTERM");
    } catch {}
  }
}
