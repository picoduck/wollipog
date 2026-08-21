/**
 * CodexAppServerDriver - drives `codex app-server` (a persistent JSON-RPC server)
 * instead of one-shot `codex exec`. This unlocks INTERACTIVE per-tool approvals:
 * the server sends item/<kind>/requestApproval requests over the same stdio the runner
 * owns, which we surface as permission_request events and answer from
 * resolvePermission - reusing the existing Allow/Reject UI.
 *
 * Auth is the ChatGPT-plan `~/.codex/auth.json` (no API key), same as the exec path.
 *
 * Protocol (codex 0.144.x, v2): initialize -> initialized -> thread/start|thread/resume -> per turn
 * turn/start; streamed via item/* + thread/* notifications; turn/completed ends it.
 * Approval decisions: "accept" (allow) / "decline" (deny).
 */

import type { PlanEntry, PromptImage, ReviewDecision, SessionConfig } from "@wollipog/protocol";
import { JsonRpcPeer } from "../jsonrpc.js";
import { killTree, spawnAgent, type AgentProcess } from "../spawn.js";
import type {
  Driver,
  DriverCallbacks,
  DriverOptions,
  DriverSteerInput,
  DriverSteerResult,
  StopReason,
} from "./driver.js";
import { isProviderAuthenticationFailure } from "./provider-auth-failure.js";
import { stagePromptImages, type StagedPromptImages } from "./prompt-images.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
type ToolStatus = "in_progress" | "completed" | "failed";

/** Map our approval-mode ids to the app-server SandboxPolicy `type`. */
const SANDBOX_TYPE: Record<string, string> = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "danger-full-access": "dangerFullAccess",
};
/** Interactive "ask" modes map straight to the AskForApproval string. */
const ASK_MODES = new Set(["on-request", "untrusted", "on-failure"]);

function normalizedCodexItemId(value: unknown): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" && Number.isFinite(value)) return `item-${value}`;
  return undefined;
}
/**
 * "auto-review" = the Guardian subagent reviews each action. It is on-request approvals
 * with the reviewer swapped to `auto_review`: low-risk actions run automatically and risky
 * ones escalate to the human (arriving as the same requestApproval requests below).
 */
const AUTO_REVIEW_MODE = "auto-review";
const PERMISSIONS_METHOD = "item/permissions/requestApproval";
const APPROVAL_METHODS = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", PERMISSIONS_METHOD];

/** A parked server->client approval request awaiting the UI's verdict. */
interface PendingApproval {
  /** Which requestApproval method it came from — decides the response shape. */
  method: string;
  /** The original request params (echoed back for permissions grants). */
  params: Json;
  /** Settles the JSON-RPC request with the response the app-server expects. */
  resolve: (response: Json) => void;
}

/**
 * Build the response shape the app-server expects for an approval method. command/file
 * approvals take `{decision}`; permissions approvals take `{permissions, scope}` (a
 * GrantedPermissionProfile), per the app-server schema — answering a permissions request
 * with a `decision` would leave the grant unapplied even after the user clicks Allow.
 * Exported for tests.
 */
export function approvalResponse(method: string, params: Json, allow: boolean): Json {
  if (method === PERMISSIONS_METHOD) {
    // RequestPermissionProfile and GrantedPermissionProfile are structurally identical
    // ({fileSystem?, network?}), so on allow we grant exactly what was requested.
    return allow ? { permissions: params?.permissions ?? {}, scope: "session" } : { permissions: {}, scope: "turn" };
  }
  return { decision: allow ? "accept" : "decline" };
}

/**
 * Build the turn/start params for a permission mode. Exported for tests.
 * - default / "auto-review": on-request + approvalsReviewer=auto_review (Guardian model review).
 * - "on-request": Codex's standard Ask for approval preset (workspace sandbox + escalation).
 * - "read-only": read-only sandbox, with escalation available for edits/network access.
 * - "danger-full-access": never-ask with no sandbox.
 *
 * Legacy "workspace-write" sessions are treated like on-request. Combining workspaceWrite
 * with approvalPolicy=never makes network denial terminal, so commands such as git fetch can
 * never request the sandbox escape that Codex CLI/Desktop normally offer.
 */
export function buildCodexTurnParams(
  cfg: SessionConfig,
  threadId: string | null,
  cwd: string,
  input: Json[],
): Json {
  const mode = cfg.permissionMode || AUTO_REVIEW_MODE;
  const autoReview = mode === AUTO_REVIEW_MODE;
  const askMode = ASK_MODES.has(mode)
    ? mode
    : mode === "workspace-write" || mode === "read-only"
      ? "on-request"
      : null;
  const sandboxType = autoReview || ASK_MODES.has(mode) ? "workspaceWrite" : SANDBOX_TYPE[mode] ?? "workspaceWrite";
  const params: Json = {
    threadId,
    input,
    approvalPolicy: autoReview ? "on-request" : askMode ?? "never",
    sandboxPolicy: { type: sandboxType },
    cwd,
  };
  if (autoReview) params.approvalsReviewer = "auto_review";
  if (cfg.model && cfg.model !== "default") params.model = cfg.model;
  if (cfg.effort) params.effort = cfg.effort;
  return params;
}

/** A persisted Codex thread could not be resumed. Callers may retry conflicts after the
 * other app-server releases the thread, but must never replace it with a fresh thread. */
export class CodexAppServerResumeError extends Error {
  readonly name = "CodexAppServerResumeError";
  readonly code = "CODEX_APP_SERVER_RESUME";
  readonly operation = "thread/resume";

  constructor(
    message: string,
    readonly threadId: string,
    readonly retryable: boolean,
    readonly rpcCode?: number,
  ) {
    super(message);
  }
}

function resumeError(threadId: string, err: Json): CodexAppServerResumeError {
  const message = err?.message ?? String(err);
  const retryable =
    err?.code === -32001 ||
    /already[- ]?(?:active|running|in use)|conflict|busy|locked|try again|temporar|overload|transport|connection (?:closed|reset)|exited|EPIPE/i.test(message);
  return new CodexAppServerResumeError(`could not resume Codex thread ${threadId}: ${message}`, threadId, retryable, err?.code);
}

export class CodexAppServerDriver implements Driver {
  private child: AgentProcess | null = null;
  private peer: JsonRpcPeer | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  /** Last provider turn remains available for post-turn fork checkpoints after active admission closes. */
  private lastTurnId: string | null = null;
  private cwd: string;
  private config: SessionConfig;
  private disposed = false;
  private cancelled = false;
  private turnResolve: ((r: StopReason) => void) | null = null;
  private turnStop: StopReason = "end_turn";
  /** Latest usage for the current turn. Emitted once when that turn settles so cumulative
   * thread usage restored during resume is never appended to the runner totals again. */
  private pendingTurnUsage: { input?: number; output?: number; cached?: number } | null = null;
  /** Once a turn settles, ignore late usage/completion notifications from its interrupt race. */
  private turnUsageClosed = false;
  private readonly seenItems = new Set<string>();
  private readonly emittedErrors = new Set<string>();
  /** approval correlation id -> the parked JSON-RPC approval request. */
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** Monotonic fallback correlation sequence for app-server schemas without approval ids. */
  private approvalSeq = 0;
  private stagedImages: StagedPromptImages | null = null;
  /** Steering image paths must remain live until the active turn settles after accepted or
   * uncertain delivery. Keyed independently so one steer cannot overwrite another's cleanup. */
  private readonly stagedSteerImages = new Map<string, StagedPromptImages>();
  /** Codex echoes steered input as userMessage items. SessionManager owns the canonical event. */
  private readonly steerClientIds = new Set<string>();
  private promptGeneration = 0;
  private promptBusy = false;
  private readonly spawn: typeof spawnAgent;
  private readonly kill: typeof killTree;

  constructor(
    private readonly opts: DriverOptions,
    private readonly cb: DriverCallbacks,
    private readonly imageStager: typeof stagePromptImages = stagePromptImages,
    deps: Partial<{ spawn: typeof spawnAgent; kill: typeof killTree }> = {},
  ) {
    this.cwd = opts.cwd;
    this.config = opts.config;
    this.spawn = deps.spawn ?? spawnAgent;
    this.kill = deps.kill ?? killTree;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  agentSessionId(): string | null {
    return this.threadId;
  }

  agentTurnId(): string | null {
    return this.turnId ?? this.lastTurnId;
  }

  async forkSession(lastTurnId: string, cwd: string): Promise<string> {
    if (!this.peer || !this.threadId) throw new Error("Codex app-server thread is not ready to fork");
    const res = await this.peer.request<Json>("thread/fork", { threadId: this.threadId, lastTurnId, cwd });
    const id = res?.thread?.id;
    if (typeof id !== "string" || !id) throw new Error("Codex fork did not return a thread id");
    return id;
  }

  async archiveSession(threadId: string): Promise<void> {
    if (!this.peer) throw new Error("Codex app-server is not running");
    await this.peer.request("thread/archive", { threadId });
  }

  setConfig(config: SessionConfig): void {
    this.config = config;
  }

  async initialize(): Promise<void> {
    const child = this.spawn({
      command: this.opts.command,
      args: [...this.opts.args, "app-server"],
      cwd: this.cwd,
      env: this.opts.env,
      context: this.opts.context,
      // Same billing guard as the exec driver: subscription auth reads ~/.codex/auth.json;
      // only the daemon-inherited key is scrubbed, an explicit agent-config env wins.
      scrubInheritedEnv: ["OPENAI_API_KEY"],
      isolation: this.opts.isolation,
      containerAgentLaunch: true,
      cloudAgentLaunch: true,
    });
    this.child = child;
    const peer = new JsonRpcPeer(child.stdin, child.stdout, (err) => this.cb.onStderr(`transport: ${err.message}`));
    this.peer = peer;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (t: string) => {
      if (this.disposed) return;
      const s = String(t).trim();
      if (s && !/DeprecationWarning|trace-deprecation/.test(s)) {
        if (isProviderAuthenticationFailure(s)) this.signalAuthenticationFailure();
        else this.cb.onStderr(s);
      }
    });
    // JSON-RPC stdout may still contain a response or final notification when
    // `exit` fires. Tear the peer down only at the post-stdio `close` boundary.
    child.on("close", (code) => {
      peer.dispose("codex app-server exited");
      // The persistent server is gone: drop our handles so a later prompt() fails fast
      // instead of parking a turn/start request that never settles.
      if (this.peer === peer) this.peer = null;
      this.child = null;
      this.pendingApprovals.clear();
      this.closeTurnUsage();
      this.settleTurn(this.cancelled ? "cancelled" : this.turnResolve ? "refusal" : this.turnStop);
      // Tell SessionManager the process died (it removes the session and marks it failed),
      // unless this exit was our own dispose()/restart.
      if (!this.disposed) this.cb.onExit(code);
    });

    this.registerHandlers(peer);
    await peer.request("initialize", { clientInfo: { name: "wollipog", version: "0.4.0" } });
    peer.notify("initialized", {});
  }

  async newSession(cwd: string): Promise<string> {
    this.cwd = cwd;
    const resumeId = this.opts.resumeId;
    let res: Json;
    try {
      if (resumeId) {
        const read = await this.peer!.request<Json>("thread/read", { threadId: resumeId, includeTurns: false });
        const readId = read?.thread?.id;
        if (readId !== resumeId) {
          throw new CodexAppServerResumeError(
            `Codex returned thread ${String(readId)} while validating ${resumeId}`,
            resumeId,
            false,
          );
        }
        if (read?.thread?.status?.type === "active") {
          throw new CodexAppServerResumeError(
            `Codex thread ${resumeId} is already active in another app-server`,
            resumeId,
            true,
          );
        }
        res = await this.peer!.request<Json>("thread/resume", { threadId: resumeId });
      } else {
        res = await this.peer!.request<Json>("thread/start", { cwd });
      }
    } catch (err) {
      if (err instanceof CodexAppServerResumeError) throw err;
      if (resumeId) throw resumeError(resumeId, err);
      throw err;
    }
    const actualId = res?.thread?.id;
    if (typeof actualId !== "string" || !actualId) {
      if (resumeId) throw new CodexAppServerResumeError(`Codex resumed thread ${resumeId} without returning its id`, resumeId, false);
      throw new Error("Codex started a thread without returning its id");
    }
    if (resumeId && actualId !== resumeId) {
      throw new CodexAppServerResumeError(
        `Codex returned thread ${actualId} while resuming ${resumeId}`,
        resumeId,
        false,
      );
    }
    this.threadId = actualId;
    return actualId;
  }

  async prompt(text: string, images?: PromptImage[], slashCommand?: string): Promise<StopReason> {
    if (this.promptBusy) {
      this.cb.onEvent({ kind: "error", message: "codex app-server already has a turn in progress" });
      return "refusal";
    }
    this.promptBusy = true;
    this.cancelled = false;
    // A new provider submission must not inherit the prior completed-turn checkpoint. If a skewed
    // server accepts turn/start but never emits turn/started, agentTurnId() must fail closed.
    this.lastTurnId = null;
    const generation = ++this.promptGeneration;
    let staged: StagedPromptImages;
    try {
      staged = await this.imageStager(images ?? [], this.opts.context);
    } catch (error) {
      this.promptBusy = false;
      this.cb.onEvent({ kind: "error", message: `image attachment rejected: ${(error as Error).message}` });
      return "refusal";
    }
    if (this.disposed || this.cancelled || generation !== this.promptGeneration || !this.peer) {
      await staged.cleanup();
      this.promptBusy = false;
      if (!this.cancelled && !this.disposed) this.cb.onEvent({ kind: "error", message: "codex app-server is not running" });
      return this.cancelled || this.disposed ? "cancelled" : "refusal";
    }
    this.stagedImages = staged;
    return new Promise<StopReason>((resolve) => {
      this.seenItems.clear();
      this.emittedErrors.clear();
      this.pendingApprovals.clear();
      this.pendingTurnUsage = null;
      this.turnUsageClosed = false;
      this.turnResolve = resolve;
      this.turnStop = "end_turn";
      // The manager must never mistake the previous provider turn for this one if turn/start
      // fails or a skewed server omits turn/started.
      this.turnId = null;

      const base = slashCommand ? `/${slashCommand}${text ? " " + text : ""}`.trim() : text;
      const input: Json[] = base || !staged.inputs.length ? [{ type: "text", text: base }] : [];
      input.push(...staged.inputs);
      const params = buildCodexTurnParams(this.config, this.threadId, this.cwd, input);

      this.peer!.request("turn/start", params).catch((e: Json) => {
        this.emitDriverError(`turn/start failed: ${e?.message ?? String(e)}`);
        this.settleTurn("refusal");
      });
    });
  }

  async steer({ submissionId, text, images = [], deadlineAt }: DriverSteerInput): Promise<DriverSteerResult> {
    const peer = this.peer;
    const expectedTurnId = this.turnId;
    const generation = this.promptGeneration;
    if (!text && images.length === 0) return { outcome: "rejected", reason: "steering input is empty" };
    if (
      !this.promptBusy || this.disposed || this.cancelled || !peer || !this.threadId ||
      !expectedTurnId
    ) {
      return { outcome: "no_active_turn", reason: "Codex has no active provider turn to steer" };
    }
    if (this.stagedSteerImages.has(submissionId) || this.steerClientIds.has(submissionId)) {
      return { outcome: "rejected", reason: "steering submission is already active" };
    }

    let staged: StagedPromptImages;
    try {
      staged = await this.imageStager(images, this.opts.context);
    } catch (error) {
      return { outcome: "rejected", reason: `image attachment rejected: ${(error as Error).message}` };
    }
    if (!this.promptBusy || this.disposed || this.cancelled || !this.peer || !this.turnId) {
      await this.cleanupOneStagedSteer(submissionId, staged);
      return { outcome: "no_active_turn", reason: "Codex provider turn closed before steering submission" };
    }
    if (generation !== this.promptGeneration || this.peer !== peer || this.turnId !== expectedTurnId) {
      await this.cleanupOneStagedSteer(submissionId, staged);
      return { outcome: "stale_turn", reason: "Codex active turn changed before steering submission" };
    }
    if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) {
      await this.cleanupOneStagedSteer(submissionId, staged);
      return { outcome: "rejected", reason: "Steering submission deadline expired before provider delivery" };
    }

    const steerInput: Json[] = text || !staged.inputs.length ? [{ type: "text", text }] : [];
    steerInput.push(...staged.inputs);
    this.stagedSteerImages.set(submissionId, staged);
    this.steerClientIds.add(submissionId);

    try {
      const response = await peer.requestWithDeadline<Json>("turn/steer", {
        threadId: this.threadId,
        input: steerInput,
        expectedTurnId,
        clientUserMessageId: submissionId,
      }, deadlineAt);
      if (response?.turnId !== expectedTurnId) {
        return {
          outcome: "uncertain",
          reason: `Codex returned steering turn ${String(response?.turnId)} instead of ${expectedTurnId}`,
        };
      }
      return { outcome: "accepted", providerTurnId: expectedTurnId };
    } catch (error) {
      const rpc = error as { message?: string; transportFailure?: true; requestTimeout?: true };
      if (rpc.requestTimeout) {
        return { outcome: "uncertain", reason: "Codex did not acknowledge steering before the submission deadline" };
      }
      if (rpc.transportFailure) {
        return { outcome: "uncertain", reason: rpc.message ?? "Codex steering transport failed" };
      }
      this.steerClientIds.delete(submissionId);
      const rejected = this.stagedSteerImages.get(submissionId);
      this.stagedSteerImages.delete(submissionId);
      if (rejected) await this.cleanupOneStagedSteer(submissionId, rejected);
      return { outcome: "rejected", reason: rpc.message ?? String(error) };
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.promptGeneration++;
    if (this.threadId && this.peer) {
      try {
        this.peer.notify("turn/interrupt", { threadId: this.threadId });
      } catch {
        /* ignore */
      }
    }
    // Decline any in-flight approvals (with the shape each method expects) so the
    // server-side turn unblocks instead of waiting on a response we'll never send.
    this.declinePendingApprovals();
    this.closeTurnUsage();
    this.settleTurn("cancelled");
  }

  resolvePermission(requestId: string, optionId: string | null): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(requestId);
    pending.resolve(approvalResponse(pending.method, pending.params, optionId === "allow"));
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelled = true;
    this.promptGeneration++;
    // Shutdown is deliberately non-destructive: interrupt the live turn and unblock every
    // parked server request, but never archive/delete the durable Codex thread.
    if (this.threadId && this.peer) {
      try {
        this.peer.notify("turn/interrupt", { threadId: this.threadId });
      } catch {
        /* ignore */
      }
    }
    this.declinePendingApprovals();
    this.closeTurnUsage();
    this.settleTurn("cancelled");
    void this.cleanupStagedImages();
    this.peer?.dispose("disposed");
    if (this.child) this.kill(this.child);
    this.child = null;
  }

  private declinePendingApprovals(): void {
    for (const [, p] of this.pendingApprovals) p.resolve(approvalResponse(p.method, p.params, false));
    this.pendingApprovals.clear();
  }

  private settleTurn(r: StopReason): void {
    const resolve = this.turnResolve;
    if (!resolve) return;
    this.turnResolve = null;
    // Close active-turn admission synchronously. In particular, an image stager already awaited by
    // steer() must observe the generation/turn/busy fence before cleanup performs its first await.
    this.lastTurnId = this.turnId ?? this.lastTurnId;
    this.turnId = null;
    this.promptBusy = false;
    this.promptGeneration++;
    void this.cleanupStagedImages().finally(() => {
      resolve(r);
    });
  }

  private async cleanupStagedImages(): Promise<void> {
    const staged = this.stagedImages;
    this.stagedImages = null;
    const steers = [...this.stagedSteerImages.entries()];
    this.stagedSteerImages.clear();
    this.steerClientIds.clear();
    if (staged) await this.cleanupOneStagedSteer("prompt", staged);
    for (const [submissionId, steer] of steers) {
      await this.cleanupOneStagedSteer(submissionId, steer);
    }
  }

  private async cleanupOneStagedSteer(submissionId: string, staged: StagedPromptImages): Promise<void> {
    try {
      await staged.cleanup();
    } catch (error) {
      this.cb.onStderr(`image cleanup failed for ${submissionId}: ${(error as Error).message}`);
    }
  }

  private registerHandlers(peer: JsonRpcPeer): void {
    // Server -> client approval requests: park a promise until the UI answers. The
    // method is captured so the response is built in the shape that method expects
    // (command/file -> {decision}; permissions -> {permissions, scope}).
    const makeApprover = (method: string) => (params: Json) =>
      new Promise<Json>((resolve) => {
        if (this.disposed || this.cancelled) return resolve(approvalResponse(method, params, false));
        const id = String(params?.approvalId ?? params?.itemId ?? `${params?.turnId}:${++this.approvalSeq}`);
        // Provider ids should be unique, but fail closed if schema drift repeats one: settle the
        // older parked RPC before replacing its UI correlation entry so no resolver is orphaned.
        const replaced = this.pendingApprovals.get(id);
        if (replaced) replaced.resolve(approvalResponse(replaced.method, replaced.params, false));
        this.pendingApprovals.set(id, { method, params, resolve });
        this.cb.onEvent({
          kind: "permission_request",
          requestId: id,
          title: approvalTitle(params),
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Reject", kind: "reject_once" },
          ],
          context: approvalContext(
            method,
            params,
            (this.config.permissionMode || AUTO_REVIEW_MODE) === AUTO_REVIEW_MODE,
          ),
        });
      });
    for (const m of APPROVAL_METHODS) peer.onRequest(m, makeApprover(m));

    // Streamed turn events. Record the streamed item id so the matching item/completed
    // doesn't re-emit the same text (deltas are the source of truth; completed is the
    // fallback only when nothing streamed).
    peer.onNotification("item/agentMessage/delta", (p: Json) => {
      if (!p?.delta) return;
      const messageId = normalizedCodexItemId(p.itemId);
      if (messageId) this.seenItems.add(`msg:${messageId}`);
      this.cb.onEvent({ kind: "agent_message", text: String(p.delta), ...(messageId ? { messageId } : {}) });
    });
    peer.onNotification("item/reasoning/delta", (p: Json) => {
      if (!p?.delta) return;
      const messageId = normalizedCodexItemId(p.itemId);
      if (messageId) this.seenItems.add(`think:${messageId}`);
      this.cb.onEvent({ kind: "agent_thought", text: String(p.delta), ...(messageId ? { messageId } : {}) });
    });
    peer.onNotification("item/started", (p: Json) => this.onItem(p?.item, false));
    peer.onNotification("item/completed", (p: Json) => this.onItem(p?.item, true));
    // Guardian auto-review (approvalsReviewer=auto_review): surface the model's verdict so
    // the user can see that a boundary-crossing action was AI-reviewed rather than silently
    // auto-approved. One thought per review; genuine escalations arrive as requestApproval
    // (the Allow/Reject prompt) instead. (The separate guardianWarning notification is
    // skipped — it duplicates this verdict for plain approvals.)
    peer.onNotification("item/autoApprovalReview/completed", (p: Json) => {
      const decision = parseReviewDecision(p);
      if (decision) this.cb.onEvent({ kind: "review_decision", ...decision });
    });
    peer.onNotification("turn/started", (p: Json) => {
      const id = p?.turn?.id;
      if (typeof id === "string" && id) {
        this.turnId = id;
        this.lastTurnId = id;
      }
      this.pendingTurnUsage = null;
      this.turnUsageClosed = false;
    });
    peer.onNotification("thread/tokenUsage/updated", (p: Json) => {
      // Prefer the per-turn field. The total is cumulative across a resumed thread and adding it
      // to SessionMeta would double-count restored history. Keep only the latest update and emit
      // once at settlement because app-server may publish several updates during one turn.
      const u = flattenUsage(p?.tokenUsage?.last ?? p?.tokenUsage?.lastTurn ?? p?.tokenUsage?.last_turn);
      if (u && !this.turnUsageClosed) this.pendingTurnUsage = u;
    });
    peer.onNotification("account/rateLimits/updated", (payload: Json) => {
      this.cb.onSubscriptionUsage?.({ provider: "codex", kind: "sparse", payload });
    });
    peer.onNotification("turn/completed", (p: Json) => {
      this.closeTurnUsage();
      const status = p?.turn?.status;
      if (status === "failed") {
        this.emitDriverError(p?.turn?.error);
        this.settleTurn("refusal");
      } else if (status === "interrupted") {
        this.settleTurn("cancelled");
      } else {
        this.settleTurn(this.turnStop);
      }
    });
    peer.onNotification("turn/failed", (p: Json) => {
      this.emitDriverError(p?.error);
      this.closeTurnUsage();
      this.settleTurn("refusal");
    });
    peer.onNotification("error", (p: Json) => {
      this.emitDriverError(p?.error ?? p?.message);
    });
  }

  private emitDriverError(error: unknown): void {
    let message = "";
    if (typeof error === "string") message = error;
    else if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      message = (error as { message: string }).message;
    } else if (error != null) {
      try {
        message = JSON.stringify(error);
      } catch {
        message = String(error);
      }
    }
    if (!message || this.emittedErrors.has(message)) return;
    this.emittedErrors.add(message);
    if (isProviderAuthenticationFailure(message)) this.signalAuthenticationFailure();
    else this.cb.onEvent({ kind: "error", message });
  }

  private signalAuthenticationFailure(): void {
    if (this.cb.onAuthenticationFailure) this.cb.onAuthenticationFailure();
    else this.cb.onStderr("provider authentication is required");
  }

  private emitPendingTurnUsage(): void {
    const u = this.pendingTurnUsage;
    this.pendingTurnUsage = null;
    if (u) this.cb.onEvent({ kind: "token_usage", inputTokens: u.input, outputTokens: u.output, cachedInputTokens: u.cached });
  }

  private closeTurnUsage(): void {
    if (this.turnUsageClosed) return;
    this.turnUsageClosed = true;
    this.emitPendingTurnUsage();
  }

  /** Map an item.started/completed payload to our normalized events. */
  private onItem(item: Json, completed: boolean): void {
    if (!item || this.disposed) return;
    const id = normalizedCodexItemId(item.id) ?? "item";
    switch (item.type) {
      case "userMessage": {
        // A steered user message can arrive before the turn/steer response. Suppress both item
        // lifecycle notifications: SessionManager appends the one canonical user_message only
        // after provider acceptance and tags it with this same submission identity.
        const clientId = item.clientId;
        if (typeof clientId === "string" && this.steerClientIds.has(clientId) && completed) {
          this.steerClientIds.delete(clientId);
        }
        break;
      }
      case "agentMessage":
        // Keep the legacy event SEQUENCE for rolling compatibility: an older dashboard ignores
        // messageId, so emitting a second authoritative completion after deltas would duplicate
        // the bubble. A completion-only item is already whole and may be marked final safely.
        if (completed && item.text && !this.seenItems.has(`msg:${id}`)) {
          this.cb.onEvent({ kind: "agent_message", text: String(item.text), messageId: id, final: true });
        }
        break;
      case "reasoning":
        if (completed && item.text && !this.seenItems.has(`think:${id}`)) {
          this.cb.onEvent({ kind: "agent_thought", text: String(item.text), messageId: id, final: true });
        }
        break;
      case "commandExecution": {
        const status: ToolStatus = completed ? (item.exitCode === 0 || item.status === "completed" ? "completed" : "failed") : "in_progress";
        this.emitTool(id, `$ ${truncate(String(item.command ?? ""), 80)}`, "execute", status);
        const out = item.aggregatedOutput ?? item.output;
        if (completed && out) this.cb.onEvent({ kind: "command_output", text: truncate(String(out), 2000) });
        break;
      }
      case "fileChange": {
        const changes: Json[] = item.changes ?? [];
        for (const ch of changes) if (ch?.path) this.cb.onEvent({ kind: "file_edit", path: ch.path, diff: ch.diff });
        this.emitTool(id, `edit ${changes.length} file(s)`, "edit", completed ? "completed" : "in_progress");
        break;
      }
      case "mcpToolCall":
      case "webSearch": {
        const title = item.type === "webSearch" ? `web_search: ${item.query ?? ""}` : `${item.server ?? ""}/${item.tool ?? ""}`;
        this.emitTool(id, title, item.type === "webSearch" ? "fetch" : "other", completed ? "completed" : "in_progress");
        break;
      }
      case "todoList": {
        const items: Json[] = item.items ?? [];
        const entries: PlanEntry[] = items.map((t) => ({
          content: String(t.text ?? t.content ?? ""),
          status: t.completed || t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending",
        }));
        if (entries.length) this.cb.onEvent({ kind: "plan", entries });
        break;
      }
    }
  }

  private emitTool(id: string, title: string, toolKind: string, status: ToolStatus): void {
    if (!this.seenItems.has(id)) {
      this.seenItems.add(id);
      this.cb.onEvent({ kind: "tool_call", toolCallId: id, title, toolKind, status });
    } else {
      this.cb.onEvent({ kind: "tool_call_update", toolCallId: id, status });
    }
  }
}

/**
 * Best-effort summary of a Guardian auto-review verdict for the activity log. The
 * payload is flagged [UNSTABLE] in the schema, so dig defensively and bail to null
 * (no event) rather than risk emitting garbage if the shape shifts.
 */
const REVIEW_OUTCOMES = {
  approved: "allowed",
  denied: "denied",
  escalated: "escalated",
  timedOut: "timed_out",
  aborted: "aborted",
} as const;
const REVIEW_RISK_LEVELS = new Set(["low", "medium", "high"]);

export function parseReviewDecision(p: Json): ReviewDecision | null {
  const r = p?.review ?? p?.autoApprovalReview ?? p?.guardianApprovalReview ?? p?.item ?? p;
  const status = r?.status;
  if (status === "inProgress" || typeof status !== "string" || !(status in REVIEW_OUTCOMES)) return null;
  const reviewId = r?.reviewId ?? r?.id ?? p?.reviewId ?? p?.itemId ?? p?.approvalId ?? p?.turnId;
  if (typeof reviewId !== "string" || !reviewId) return null;
  const riskLevel = typeof r?.riskLevel === "string" && REVIEW_RISK_LEVELS.has(r.riskLevel)
    ? r.riskLevel as ReviewDecision["riskLevel"]
    : undefined;
  const rationale = typeof r?.rationale === "string" && r.rationale.trim()
    ? truncate(r.rationale.trim(), 200)
    : undefined;
  const requestId = r?.requestId ?? r?.approvalId ?? p?.requestId ?? p?.approvalId;
  return {
    reviewId,
    reviewer: { kind: "agent", id: "codex-guardian" },
    outcome: REVIEW_OUTCOMES[status as keyof typeof REVIEW_OUTCOMES],
    ...(riskLevel ? { riskLevel } : {}),
    ...(rationale ? { rationale } : {}),
    ...(typeof requestId === "string" && requestId ? { requestId } : {}),
  };
}

/** Backward-compatible visible summary helper retained for callers outside the driver. */
export function reviewSummary(p: Json): string | null {
  const decision = parseReviewDecision(p);
  if (!decision) return null;
  const verb = decision.outcome === "allowed" ? "approved" : decision.outcome.replace("_", " ");
  const risk = decision.riskLevel ? ` (${decision.riskLevel} risk)` : "";
  const why = decision.rationale ? `: ${decision.rationale}` : "";
  return `[AI review] ${verb}${risk}${why}`;
}

function approvalTitle(params: Json): string {
  if (params?.command) return `Run: ${truncate(String(params.command), 80)}`;
  if (params?.changes || params?.fileChange) return "Apply file changes";
  if (params?.permissions) return "Grant elevated permissions";
  if (params?.reason) return String(params.reason);
  return "Codex requests approval";
}

export function approvalContext(method: string, params: Json, escalated: boolean) {
  const toolName = method === PERMISSIONS_METHOD
    ? "permissions"
    : method.includes("fileChange")
      ? "fileChange"
      : "commandExecution";
  const changes = Array.isArray(params?.changes) ? params.changes : null;
  // A single path selector must describe the whole action. Multi-file changes expose no path so
  // a path-scoped auto-allow rule fails closed instead of authorizing by only the first file.
  const onlyChange = changes?.length === 1 ? changes[0] : changes ? null : params?.fileChange;
  const path = params?.path ?? params?.filePath ?? onlyChange?.path ?? onlyChange?.filePath;
  const branch = params?.branch ?? params?.branchName;
  const input = params?.command ?? params?.reason;
  const networkRequested = params?.permissions?.network;
  return {
    toolName,
    ...(typeof input === "string" && input ? { input: truncate(input, 2000) } : {}),
    ...(typeof path === "string" && path ? { path: truncate(path, 1024) } : {}),
    ...(networkRequested ? { network: typeof networkRequested === "string" ? truncate(networkRequested, 1024) : "requested" } : {}),
    ...(typeof branch === "string" && branch ? { branch: truncate(branch, 1024) } : {}),
    ...(escalated ? { escalatedBy: { kind: "agent" as const, id: "codex-guardian" } } : {}),
  };
}

/** Dig token counts out of the app-server's nested token-usage object. */
function flattenUsage(tu: Json): { input?: number; output?: number; cached?: number } | null {
  if (!tu) return null;
  const u = tu.total ?? tu.lastTurn ?? tu.tokenUsage ?? tu;
  const input = u.input_tokens ?? u.inputTokens ?? u.input;
  const output = u.output_tokens ?? u.outputTokens ?? u.output;
  const cached = u.cached_input_tokens ?? u.cachedInputTokens ?? u.cached;
  if (input == null && output == null) return null;
  return { input, output, cached };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}
