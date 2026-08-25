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

import {
  DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH,
  type AgentQuestion,
  type AuthoritativeSubagentLifecycle,
  type PlanEntry,
  type PromptImage,
  type ReviewDecision,
  type SessionConfig,
} from "@wollipog/protocol";
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

const CODEX_SUBAGENT_LIFECYCLES: Record<string, AuthoritativeSubagentLifecycle> = {
  pendingInit: "starting",
  running: "running",
  interrupted: "interrupted",
  completed: "completed",
  errored: "failed",
  shutdown: "interrupted",
  notFound: "unreachable",
};

function codexSubagentLifecycle(value: unknown): AuthoritativeSubagentLifecycle | undefined {
  return typeof value === "string" ? CODEX_SUBAGENT_LIFECYCLES[value] : undefined;
}

function subagentToolStatus(lifecycle: AuthoritativeSubagentLifecycle): string {
  switch (lifecycle) {
    case "starting": return "pending";
    case "running":
    case "waiting": return "in_progress";
    case "completed": return "completed";
    case "failed":
    case "unreachable": return "failed";
    case "interrupted": return "cancelled";
  }
}

function collabToolTitle(tool: unknown): string {
  switch (tool) {
    case "sendInput": return "Send Input to Agent";
    case "resumeAgent": return "Resume Agent";
    case "wait": return "Wait for Agent";
    case "closeAgent": return "Close Agent";
    default: return "Agent Collaboration";
  }
}

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

/** Item ids are documented only as thread-item identities, not as globally unique across the
 * App Server's multiplexed threads. Keep root ids stable for compatibility and scope every admitted
 * child id by its thread so a valid per-thread counter cannot update or suppress a root item. */
function scopedCodexItemId(value: unknown, threadId: unknown, rootThreadId: string | null): string | undefined {
  const id = normalizedCodexItemId(value);
  if (!id || typeof threadId !== "string" || !threadId || threadId === rootThreadId) return id;
  return `codex-child:${JSON.stringify([threadId, id])}`;
}
/**
 * "auto-review" = the Guardian subagent reviews each action. It is on-request approvals
 * with the reviewer swapped to `auto_review`: low-risk actions run automatically and risky
 * ones escalate to the human (arriving as the same requestApproval requests below).
 */
const AUTO_REVIEW_MODE = "auto-review";
const PERMISSIONS_METHOD = "item/permissions/requestApproval";
const APPROVAL_METHODS = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", PERMISSIONS_METHOD];
const USER_INPUT_METHOD = "item/tool/requestUserInput";
const MCP_ELICITATION_METHOD = "mcpServer/elicitation/request";
export const DEFAULT_MODE_QUESTION_FEATURE = "default_mode_request_user_input";

/** Place the global feature override before the subcommand. Codex currently has separate global
 * and app-server config parsers, and keeping the override global works across both old and new
 * app-server argument surfaces. */
export function codexAppServerArgs(baseArgs: string[], enableDefaultModeQuestions = true): string[] {
  return enableDefaultModeQuestions
    ? [...baseArgs, "--enable", DEFAULT_MODE_QUESTION_FEATURE, "app-server"]
    : [...baseArgs, "app-server"];
}

function defaultModeQuestionFeatureUnsupported(stderr: string): boolean {
  return /unknown feature flag:\s*default_mode_request_user_input/i.test(stderr) ||
    /(?:unexpected argument|unrecognized (?:option|argument)).*--enable/is.test(stderr);
}

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
export function approvalResponse(method: string, params: Json, choice: string | boolean | null): Json {
  const allow = choice === true || choice === "allow" || choice === "accept" || choice === "acceptForSession";
  if (method === PERMISSIONS_METHOD) {
    // RequestPermissionProfile and GrantedPermissionProfile are structurally identical
    // ({fileSystem?, network?}), so on allow we grant exactly what was requested.
    return allow ? { permissions: params?.permissions ?? {}, scope: "session" } : { permissions: {}, scope: "turn" };
  }
  const decision = choice === true || choice === "allow"
    ? "accept"
    : choice === false || choice === "deny"
      ? "decline"
      : choice === "accept" || choice === "acceptForSession" || choice === "decline" || choice === "cancel"
        ? choice
        : "cancel";
  return { decision };
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
  /** True after the active turn emits agent-message deltas. Successful turn settlement consumes
   * it into one content-free completion event; cancellation/failure clears it. */
  private streamedAgentResponse = false;
  /** approval correlation id -> the parked JSON-RPC approval request. */
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  /** question correlation id -> the parked provider request and native response mapper. */
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  /** Monotonic fallback correlation sequence for app-server schemas without approval ids. */
  private approvalSeq = 0;
  private stagedImages: StagedPromptImages | null = null;
  /** Steering image paths must remain live until the active turn settles after accepted or
   * uncertain delivery. Keyed independently so one steer cannot overwrite another's cleanup. */
  private readonly stagedSteerImages = new Map<string, StagedPromptImages>();
  /** Codex echoes steered input as userMessage items. SessionManager owns the canonical event. */
  private readonly steerClientIds = new Set<string>();
  /** App-server multiplexes parent and spawned threads over one notification stream. A child
   * thread is admitted to this session only after a structured spawn item binds it to the exact
   * spawning collaboration tool. */
  private readonly subagentToolByThread = new Map<string, string>();
  private readonly subagentParentByTool = new Map<string, string | undefined>();
  private readonly subagentLifecycleByThread = new Map<string, AuthoritativeSubagentLifecycle>();
  /** Latest per-child turn usage. Like root usage, it is emitted once when that child turn settles,
   * not once per cumulative update notification. */
  private readonly pendingSubagentUsage = new Map<string, ReturnType<typeof flattenUsage>>();
  private promptGeneration = 0;
  private promptBusy = false;
  /** Provider diagnostics are held until startup succeeds so an expected unsupported-feature
   * retry does not surface a false session error. */
  private initializationStderr: string[] | null = null;
  private initializationExit: { code: number | null } | null = null;
  private initializing = false;
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

  private emitProviderStderr(text: string): void {
    if (this.initializationStderr) this.initializationStderr.push(text);
    else this.cb.onStderr(text);
  }

  private flushInitializationStderr(): void {
    for (const line of this.initializationStderr ?? []) this.cb.onStderr(line);
    this.initializationStderr = [];
  }

  private takeInitializationExit(): { code: number | null } | null {
    const exit = this.initializationExit;
    this.initializationExit = null;
    return exit;
  }
  private async startAppServer(enableDefaultModeQuestions: boolean): Promise<void> {
    const child = this.spawn({
      command: this.opts.command,
      args: codexAppServerArgs(this.opts.args, enableDefaultModeQuestions),
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
    const peer = new JsonRpcPeer(child.stdin, child.stdout, (err) => this.emitProviderStderr(`transport: ${err.message}`));
    this.peer = peer;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (t: string) => {
      if (this.disposed || this.child !== child) return;
      const s = String(t).trim();
      if (s && !/DeprecationWarning|trace-deprecation/.test(s)) {
        if (isProviderAuthenticationFailure(s)) this.signalAuthenticationFailure();
        else this.emitProviderStderr(s);
      }
    });
    // JSON-RPC stdout may still contain a response or final notification when
    // `exit` fires. Tear the peer down only at the post-stdio `close` boundary.
    child.on("close", (code) => {
      peer.dispose("codex app-server exited");
      // A rejected feature probe can be replaced before its delayed close event arrives.
      // Only the current launch may tear down session state or report an exit.
      if (this.peer !== peer && this.child !== child) return;
      // The persistent server is gone: drop our handles so a later prompt() fails fast
      // instead of parking a turn/start request that never settles.
      if (this.peer === peer) this.peer = null;
      if (this.child === child) this.child = null;
      this.declinePendingRequests();
      this.closeTurnUsage();
      this.settleTurn(this.cancelled ? "cancelled" : this.turnResolve ? "refusal" : this.turnStop);
      // Tell SessionManager the process died (it removes the session and marks it failed),
      // unless this exit was our own dispose()/restart.
      if (!this.disposed) {
        if (this.initializing) this.initializationExit = { code };
        else this.cb.onExit(code);
      }
    });

    this.registerHandlers(peer);
    await peer.request("initialize", { clientInfo: { name: "wollipog", version: "0.4.0" } });
    peer.notify("initialized", {});
  }

  async initialize(): Promise<void> {
    this.initializing = true;
    this.initializationStderr = [];
    this.initializationExit = null;
    try {
      try {
        await this.startAppServer(true);
      } catch (error) {
        const startupDiagnostics = this.initializationStderr.join("\n");
        if (this.disposed || !defaultModeQuestionFeatureUnsupported(startupDiagnostics)) {
          this.flushInitializationStderr();
          throw error;
        }
        // Unsupported Codex versions have already exited after rejecting the flag. Their close
        // callback normally clears the exact child/peer handles. A transport error can reject the
        // initialize request before close, so explicitly stop that probe before replacing it; its
        // identity-guarded close callback cannot tear down the fallback launch.
        const rejectedChild = this.child;
        this.child = null;
        this.peer = null;
        if (rejectedChild) this.kill(rejectedChild);
        this.initializationStderr = [];
        this.initializationExit = null;
        this.cb.onStderr(
          "Codex does not support " + DEFAULT_MODE_QUESTION_FEATURE +
            "; continuing without Default-mode structured questions.",
        );
        await this.startAppServer(false);
      }
      this.flushInitializationStderr();
    } catch (error) {
      this.flushInitializationStderr();
      throw error;
    } finally {
      const initializationExit = this.takeInitializationExit();
      this.initializationStderr = null;
      this.initializationExit = null;
      this.initializing = false;
      if (initializationExit && !this.disposed) this.cb.onExit(initializationExit.code);
    }
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
      this.streamedAgentResponse = false;
      this.declinePendingRequests();
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
    // Cancel any in-flight requests (with the shape each method expects) so the
    // server-side turn unblocks instead of waiting on a response we'll never send.
    this.declinePendingRequests();
    this.closeTurnUsage();
    this.settleTurn("cancelled");
  }

  resolvePermission(requestId: string, optionId: string | null): boolean {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(requestId);
    pending.resolve(pending.method === MCP_ELICITATION_METHOD
      ? mcpElicitationResponse(optionId === "accept" ? "accept" : optionId === "decline" ? "decline" : "cancel")
      : approvalResponse(pending.method, pending.params, optionId));
    return true;
  }

  answerQuestion(requestId: string, answers: Record<string, string | string[]>, action?: "submit" | "dismiss"): boolean {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return false;
    this.pendingQuestions.delete(requestId);
    pending.resolve(pending.response(answers, action ?? (Object.keys(answers).length > 0 ? "submit" : "dismiss")));
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
    // The Codex thread remains durable, but this driver can no longer observe or control any
    // children that were active on its transport. Persist that loss of reachability so a later
    // replay cannot present stale work as live; a successful resume/sendInput collaboration item
    // will establish a fresh live boundary if the durable child is reattached.
    for (const [threadId, lifecycle] of this.subagentLifecycleByThread) {
      if (lifecycle === "starting" || lifecycle === "running" || lifecycle === "waiting") {
        this.updateSubagentLifecycle(threadId, "unreachable");
      }
    }
    this.declinePendingRequests();
    this.closeTurnUsage();
    this.settleTurn("cancelled");
    void this.cleanupStagedImages();
    this.peer?.dispose("disposed");
    if (this.child) this.kill(this.child);
    this.child = null;
  }

  private declinePendingRequests(resolutionReason?: "replaced"): void {
    for (const [requestId, p] of this.pendingApprovals) {
      p.resolve(p.method === MCP_ELICITATION_METHOD ? mcpElicitationResponse("cancel") : approvalResponse(p.method, p.params, null));
      if (resolutionReason) {
        this.cb.onEvent({ kind: "permission_resolved", requestId, optionId: null, resolutionReason });
      }
    }
    this.pendingApprovals.clear();
    for (const [requestId, p] of this.pendingQuestions) {
      p.resolve(p.response({}, "dismiss"));
      if (resolutionReason) {
        this.cb.onEvent({ kind: "question_resolved", requestId, answered: false, resolutionReason });
      }
    }
    this.pendingQuestions.clear();
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

  /** Admit only the root thread and descendants bound by a structured collaboration item. App
   * Server can multiplex unrelated loaded threads over the same transport, so treating every
   * notification as parent-session output would cross conversation boundaries. */
  private eventContext(threadId: unknown): { accepted: boolean; parentToolUseId?: string } {
    if (threadId == null || threadId === "") return { accepted: true };
    if (typeof threadId !== "string") return { accepted: false };
    if (threadId === this.threadId) return { accepted: true };
    const parentToolUseId = this.subagentToolByThread.get(threadId);
    return parentToolUseId ? { accepted: true, parentToolUseId } : { accepted: false };
  }

  private updateSubagentStates(states: unknown): void {
    if (!states || typeof states !== "object" || Array.isArray(states)) return;
    for (const [threadId, raw] of Object.entries(states as Record<string, Json>)) {
      const lifecycle = codexSubagentLifecycle(raw?.status);
      if (lifecycle) this.updateSubagentLifecycle(threadId, lifecycle);
    }
  }

  private updateSubagentLifecycle(threadId: string, lifecycle: AuthoritativeSubagentLifecycle): void {
    const toolCallId = this.subagentToolByThread.get(threadId);
    if (!toolCallId) return;
    if (this.subagentLifecycleByThread.get(threadId) === lifecycle) return;
    this.subagentLifecycleByThread.set(threadId, lifecycle);
    this.cb.onEvent({
      kind: "tool_call_update",
      toolCallId,
      status: subagentToolStatus(lifecycle),
      subagentLifecycle: lifecycle,
      ...(this.subagentParentByTool.get(toolCallId)
        ? { parentToolUseId: this.subagentParentByTool.get(toolCallId) }
        : {}),
    });
  }

  private flushSubagentUsage(threadId: string): void {
    const usage = this.pendingSubagentUsage.get(threadId);
    const parentToolUseId = this.subagentToolByThread.get(threadId);
    if (!usage || !parentToolUseId) return;
    this.pendingSubagentUsage.delete(threadId);
    this.cb.onEvent({
      kind: "token_usage",
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedInputTokens: usage.cached,
      parentToolUseId,
    });
  }

  private onCollabItem(item: Json, completed: boolean, id: string, notificationParent?: string): void {
    const senderParent = typeof item?.senderThreadId === "string"
      ? this.subagentToolByThread.get(item.senderThreadId)
      : undefined;
    const parentToolUseId = senderParent ?? notificationParent;
    const failed = item?.status === "failed";
    const receivers = Array.isArray(item?.receiverThreadIds)
      ? item.receiverThreadIds.filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
      : [];

    if (item?.tool !== "spawnAgent") {
      // A restarted App Server can report resume/sendInput for a durable child before this driver
      // has seen its original spawn item. That collaboration item is authoritative reattachment
      // evidence; bind only previously unknown receivers and represent them as a fresh selectable
      // agent boundary rather than dropping their subsequent multiplexed output.
      const reattached = !failed && (item?.tool === "resumeAgent" || item?.tool === "sendInput")
        ? receivers.filter((threadId: string) => !this.subagentToolByThread.has(threadId))
        : [];
      if (reattached.length > 0) {
        const firstState = reattached.map((threadId: string) => item?.agentsStates?.[threadId])
          .find((state: Json) => codexSubagentLifecycle(state?.status));
        const lifecycle = failed ? "failed" : codexSubagentLifecycle(firstState?.status) ?? "starting";
        this.emitTool(id, collabToolTitle(item?.tool), "agent", subagentToolStatus(lifecycle), parentToolUseId, lifecycle);
        this.subagentParentByTool.set(id, parentToolUseId);
        for (const threadId of reattached) {
          this.subagentToolByThread.set(threadId, id);
          this.subagentLifecycleByThread.set(threadId, lifecycle);
        }
      } else {
        this.emitTool(
          id,
          collabToolTitle(item?.tool),
          "other",
          completed ? (failed ? "failed" : "completed") : "in_progress",
          parentToolUseId,
        );
      }
      this.updateSubagentStates(item?.agentsStates);
      return;
    }

    const prompt = typeof item?.prompt === "string" ? item.prompt.trim() : "";
    const title = prompt ? `Agent: ${truncate(prompt, 80)}` : "Agent";
    const firstState = receivers.map((threadId: string) => item?.agentsStates?.[threadId])
      .find((state: Json) => codexSubagentLifecycle(state?.status));
    const lifecycle = failed ? "failed" : codexSubagentLifecycle(firstState?.status) ?? "starting";
    this.emitTool(id, title, "agent", subagentToolStatus(lifecycle), parentToolUseId, lifecycle);
    this.subagentParentByTool.set(id, parentToolUseId);
    for (const threadId of receivers) {
      this.subagentToolByThread.set(threadId, id);
      this.subagentLifecycleByThread.set(threadId, lifecycle);
    }
    this.updateSubagentStates(item?.agentsStates);
  }

  private registerHandlers(peer: JsonRpcPeer): void {
    // Server -> client approval requests: park a promise until the UI answers. The
    // method is captured so the response is built in the shape that method expects
    // (command/file -> {decision}; permissions -> {permissions, scope}).
    const makeApprover = (method: string) => (params: Json, rpcRequestId: number | string) =>
      new Promise<Json>((resolve) => {
        if (this.disposed || this.cancelled) return resolve(approvalResponse(method, params, null));
        const id = String(rpcRequestId ?? params?.approvalId ?? params?.itemId ?? `${params?.turnId}:${++this.approvalSeq}`);
        this.declinePendingRequests("replaced");
        if (this.disposed || this.cancelled) {
          return resolve(approvalResponse(method, params, null));
        }
        this.pendingApprovals.set(id, { method, params, resolve });
        this.cb.onEvent({
          kind: "permission_request",
          requestId: id,
          title: approvalTitle(params),
          options: method === PERMISSIONS_METHOD
            ? [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Reject", kind: "reject_once" },
              ]
            : [
                { optionId: "accept", name: "Allow Once", kind: "allow_once" },
                { optionId: "acceptForSession", name: "Allow for Session", kind: "allow_always" },
                { optionId: "decline", name: "Reject", kind: "reject_once" },
                { optionId: "cancel", name: "Cancel", kind: "cancel" },
              ],
          context: approvalContext(
            method,
            params,
            (this.config.permissionMode || AUTO_REVIEW_MODE) === AUTO_REVIEW_MODE,
          ),
        });
      });
    for (const m of APPROVAL_METHODS) peer.onRequest(m, makeApprover(m));

    peer.onRequest(USER_INPUT_METHOD, (params: Json, rpcRequestId: number | string) =>
      new Promise<Json>((resolve) => {
        if (this.disposed || this.cancelled) return resolve({ answers: {} });
        const normalized = normalizeCodexUserInput(params);
        if (!normalized) {
          this.cb.onStderr("Codex requestUserInput arrived with no safely answerable questions — auto-dismissing");
          return resolve({ answers: {} });
        }
        const id = String(rpcRequestId ?? params?.itemId ?? `${params?.turnId}:${++this.approvalSeq}`);
        this.declinePendingRequests("replaced");
        if (this.disposed || this.cancelled) {
          return resolve(normalized.response({}, "dismiss"));
        }
        this.pendingQuestions.set(id, { resolve, response: normalized.response });
        this.cb.onEvent({ kind: "question_request", requestId: id, questions: normalized.questions });
      }));

    peer.onRequest(MCP_ELICITATION_METHOD, (params: Json, rpcRequestId: number | string) =>
      new Promise<Json>((resolve) => {
        if (this.disposed || this.cancelled) return resolve(mcpElicitationResponse("cancel"));
        const id = String(rpcRequestId ?? params?.elicitationId ?? `${params?.turnId}:${++this.approvalSeq}`);
        if (params?.mode === "url") {
          const message = boundedString(params?.message, MAX_QUESTION_TEXT);
          const serverName = boundedString(params?.serverName, MAX_QUESTION_HEADER);
          const url = boundedString(params?.url, MAX_QUESTION_TEXT);
          if (!message || !serverName || !url) {
            this.cb.onStderr("Codex MCP URL elicitation was malformed — cancelling it");
            return resolve(mcpElicitationResponse("cancel"));
          }
          this.declinePendingRequests("replaced");
          if (this.disposed || this.cancelled) return resolve(mcpElicitationResponse("cancel"));
          this.pendingApprovals.set(id, { method: MCP_ELICITATION_METHOD, params, resolve });
          this.cb.onEvent({
            kind: "permission_request",
            requestId: id,
            title: `${serverName} requests a browser flow`,
            options: [
              { optionId: "accept", name: "Accept", kind: "allow_once" },
              { optionId: "decline", name: "Decline", kind: "reject_once" },
              { optionId: "cancel", name: "Cancel", kind: "cancel" },
            ],
            context: { toolName: serverName, input: message, network: url },
          });
          return;
        }
        const normalized = normalizeMcpFormElicitation(params);
        if (!normalized) {
          this.cb.onStderr(`unsupported or malformed Codex MCP elicitation mode=${diagnosticValue(params?.mode)} — cancelling it`);
          return resolve(mcpElicitationResponse("cancel"));
        }
        this.declinePendingRequests("replaced");
        if (this.disposed || this.cancelled) {
          return resolve(normalized.response({}, "dismiss"));
        }
        this.pendingQuestions.set(id, { resolve, response: normalized.response });
        this.cb.onEvent({ kind: "question_request", requestId: id, questions: normalized.questions });
      }));

    peer.onNotification("serverRequest/resolved", (params: Json) => {
      const id = String(params?.requestId ?? "");
      const question = this.pendingQuestions.get(id);
      if (question) {
        this.pendingQuestions.delete(id);
        question.resolve(question.response({}, "dismiss"));
        this.cb.onEvent({
          kind: "question_resolved",
          requestId: id,
          answered: false,
          resolutionReason: "provider_resolved",
        });
      }
      const approval = this.pendingApprovals.get(id);
      if (approval) {
        this.pendingApprovals.delete(id);
        approval.resolve(approval.method === MCP_ELICITATION_METHOD ? mcpElicitationResponse("cancel") : approvalResponse(approval.method, approval.params, null));
        this.cb.onEvent({
          kind: "permission_resolved",
          requestId: id,
          optionId: null,
          resolutionReason: "provider_resolved",
        });
      }
    });

    // Streamed turn events. Record the streamed item id so the matching item/completed
    // doesn't re-emit the same text (deltas are the source of truth; completed is the
    // fallback only when nothing streamed).
    peer.onNotification("item/agentMessage/delta", (p: Json) => {
      if (!p?.delta) return;
      const context = this.eventContext(p?.threadId);
      if (!context.accepted) return;
      const messageId = scopedCodexItemId(p.itemId, p?.threadId, this.threadId);
      if (!context.parentToolUseId) this.streamedAgentResponse = true;
      if (messageId) this.seenItems.add(`msg:${messageId}`);
      this.cb.onEvent({
        kind: "agent_message",
        text: String(p.delta),
        ...(messageId ? { messageId } : {}),
        ...(context.parentToolUseId ? { parentToolUseId: context.parentToolUseId } : {}),
      });
    });
    const onReasoningDelta = (p: Json) => {
      if (!p?.delta) return;
      const context = this.eventContext(p?.threadId);
      if (!context.accepted) return;
      const messageId = scopedCodexItemId(p.itemId, p?.threadId, this.threadId);
      if (messageId) this.seenItems.add(`think:${messageId}`);
      this.cb.onEvent({
        kind: "agent_thought",
        text: String(p.delta),
        ...(messageId ? { messageId } : {}),
        ...(context.parentToolUseId ? { parentToolUseId: context.parentToolUseId } : {}),
      });
    };
    // summaryTextDelta/textDelta are the stable v2 notifications. Keep the older generic method as
    // a compatibility alias; all three share the same required attribution envelope.
    peer.onNotification("item/reasoning/summaryTextDelta", onReasoningDelta);
    peer.onNotification("item/reasoning/textDelta", onReasoningDelta);
    peer.onNotification("item/reasoning/delta", onReasoningDelta);
    peer.onNotification("item/started", (p: Json) => this.onItem(p?.item, false, p?.threadId));
    peer.onNotification("item/completed", (p: Json) => this.onItem(p?.item, true, p?.threadId));
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
      if (p?.threadId && p.threadId !== this.threadId) return;
      this.declinePendingRequests();
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
      if (!u) return;
      const context = this.eventContext(p?.threadId);
      if (!context.accepted) return;
      if (context.parentToolUseId) {
        this.pendingSubagentUsage.set(String(p.threadId), u);
      } else if (!this.turnUsageClosed) {
        this.pendingTurnUsage = u;
      }
    });
    peer.onNotification("account/rateLimits/updated", (payload: Json) => {
      this.cb.onSubscriptionUsage?.({ provider: "codex", kind: "sparse", payload });
    });
    peer.onNotification("turn/completed", (p: Json) => {
      if (p?.threadId && p.threadId !== this.threadId) {
        if (this.subagentToolByThread.has(p.threadId)) {
          this.flushSubagentUsage(p.threadId);
          if (p?.turn?.status === "failed") this.updateSubagentLifecycle(p.threadId, "failed");
          if (p?.turn?.status === "interrupted") this.updateSubagentLifecycle(p.threadId, "interrupted");
        }
        return;
      }
      this.declinePendingRequests();
      this.closeTurnUsage();
      const status = p?.turn?.status;
      if (status === "failed") {
        this.streamedAgentResponse = false;
        this.emitDriverError(p?.turn?.error);
        this.settleTurn("refusal");
      } else if (status === "interrupted") {
        this.streamedAgentResponse = false;
        this.settleTurn("cancelled");
      } else {
        if (status === "completed" && this.turnResolve && this.streamedAgentResponse) {
          this.streamedAgentResponse = false;
          this.cb.onEvent({ kind: "agent_response_completed" });
        }
        this.settleTurn(this.turnStop);
      }
    });
    peer.onNotification("turn/failed", (p: Json) => {
      if (p?.threadId && p.threadId !== this.threadId) {
        if (this.subagentToolByThread.has(p.threadId)) {
          this.flushSubagentUsage(p.threadId);
          this.updateSubagentLifecycle(p.threadId, "failed");
        }
        return;
      }
      this.declinePendingRequests();
      this.streamedAgentResponse = false;
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
  private onItem(item: Json, completed: boolean, threadId?: unknown): void {
    if (!item || this.disposed) return;
    const context = this.eventContext(threadId);
    if (!context.accepted) return;
    const parentToolUseId = context.parentToolUseId;
    const id = scopedCodexItemId(item.id, threadId, this.threadId) ?? "item";
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
          this.cb.onEvent({
            kind: "agent_message",
            text: String(item.text),
            messageId: id,
            final: true,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
        break;
      case "reasoning":
        if (completed && item.text && !this.seenItems.has(`think:${id}`)) {
          this.cb.onEvent({
            kind: "agent_thought",
            text: String(item.text),
            messageId: id,
            final: true,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
        break;
      case "commandExecution": {
        const status: ToolStatus = completed ? (item.exitCode === 0 || item.status === "completed" ? "completed" : "failed") : "in_progress";
        this.emitTool(id, `$ ${truncate(String(item.command ?? ""), 80)}`, "execute", status, parentToolUseId);
        const out = item.aggregatedOutput ?? item.output;
        if (completed && out) {
          this.cb.onEvent({
            kind: "command_output",
            text: truncate(String(out), 2000),
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
        break;
      }
      case "fileChange": {
        const changes: Json[] = item.changes ?? [];
        for (const ch of changes) if (ch?.path) {
          this.cb.onEvent({
            kind: "file_edit",
            path: ch.path,
            diff: ch.diff,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          });
        }
        this.emitTool(id, `edit ${changes.length} file(s)`, "edit", completed ? "completed" : "in_progress", parentToolUseId);
        break;
      }
      case "mcpToolCall":
      case "webSearch": {
        const title = item.type === "webSearch" ? `web_search: ${item.query ?? ""}` : `${item.server ?? ""}/${item.tool ?? ""}`;
        this.emitTool(
          id,
          title,
          item.type === "webSearch" ? "fetch" : "other",
          completed ? "completed" : "in_progress",
          parentToolUseId,
        );
        break;
      }
      case "todoList": {
        const items: Json[] = item.items ?? [];
        const entries: PlanEntry[] = items.map((t) => ({
          content: String(t.text ?? t.content ?? ""),
          status: t.completed || t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending",
        }));
        if (entries.length) {
          this.cb.onEvent({ kind: "plan", entries, ...(parentToolUseId ? { parentToolUseId } : {}) });
        }
        break;
      }
      case "collabAgentToolCall":
        this.onCollabItem(item, completed, id, parentToolUseId);
        break;
    }
  }

  private emitTool(
    id: string,
    title: string,
    toolKind: string,
    status: string,
    parentToolUseId?: string,
    subagentLifecycle?: AuthoritativeSubagentLifecycle,
  ): void {
    if (!this.seenItems.has(id)) {
      this.seenItems.add(id);
      this.cb.onEvent({
        kind: "tool_call",
        toolCallId: id,
        title,
        toolKind,
        status,
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(subagentLifecycle ? { subagentLifecycle } : {}),
      });
    } else {
      this.cb.onEvent({
        kind: "tool_call_update",
        toolCallId: id,
        status,
        ...(parentToolUseId ? { parentToolUseId } : {}),
        ...(subagentLifecycle ? { subagentLifecycle } : {}),
      });
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

/** A parked structured question awaiting the normalized answer_question route. */
interface PendingQuestion {
  resolve: (response: Json) => void;
  response: (answers: Record<string, string | string[]>, action?: "submit" | "dismiss") => Json;
}

interface NormalizedQuestionRequest {
  questions: AgentQuestion[];
  response: (answers: Record<string, string | string[]>, action?: "submit" | "dismiss") => Json;
}

type McpElicitationAction = "accept" | "decline" | "cancel";
const MAX_STRUCTURED_QUESTIONS = 20;
const MAX_QUESTION_OPTIONS = 20;
const MAX_QUESTION_ID = 256;
const MAX_QUESTION_HEADER = 80;
const MAX_QUESTION_TEXT = 2000;
/** Provider free-text bound. The shared protocol default keeps the driver, the dashboard's submit
 * gate, and the control plane's authoritative validation on one number. */
const MAX_FREE_TEXT = DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH;
const MAX_DIAGNOSTIC_VALUE = 120;

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

/** Render a provider-controlled value for a diagnostic. The value reaches stderr and the durable
 * runner log, so it is always bounded and objects are never stringified in full. */
export function diagnosticValue(value: unknown): string {
  if (value == null) return "?";
  const text = typeof value === "string" ? value : typeof value === "object" ? "[object]" : String(value);
  return text.length > MAX_DIAGNOSTIC_VALUE ? `${text.slice(0, MAX_DIAGNOSTIC_VALUE)}…` : text;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function distinctQuestionIds(questions: AgentQuestion[]): boolean {
  return new Set(questions.map((question) => question.id)).size === questions.length;
}

function normalizedOptions(raw: unknown): AgentQuestion["options"] | null {
  if (!Array.isArray(raw) || raw.length > MAX_QUESTION_OPTIONS) return null;
  const options = raw.map((option: Json) => {
    const label = boundedString(option?.label, MAX_QUESTION_ID);
    const description = boundedString(option?.description, MAX_QUESTION_TEXT);
    if (!label || !description) return null;
    return { label, description };
  });
  if (options.some((option) => option == null)) return null;
  const valid = options as AgentQuestion["options"];
  return new Set(valid.map((option) => option.label)).size === valid.length ? valid : null;
}

/** Normalize Codex's item/tool/requestUserInput request without synthesizing a user message. */
export function normalizeCodexUserInput(params: Json): NormalizedQuestionRequest | null {
  if (!Array.isArray(params?.questions) || params.questions.length === 0 || params.questions.length > 3) return null;
  const questions: AgentQuestion[] = [];
  for (const raw of params.questions) {
    if (raw?.multiSelect === true && raw?.isOther === true) return null;
    const id = boundedString(raw?.id, MAX_QUESTION_ID);
    const question = boundedString(raw?.question, MAX_QUESTION_TEXT);
    const header = boundedString(raw?.header, MAX_QUESTION_HEADER);
    if (!id || !question || !header || (raw?.options != null && !Array.isArray(raw?.options))) return null;
    const options = raw.options == null ? [] : normalizedOptions(raw.options);
    if (!options || (options.length === 0 && raw?.isOther !== true)) return null;
    questions.push({
      id,
      header,
      question,
      options,
      ...(raw?.isOther === true ? { allowOther: true, inputFormat: "text" as const, maxLength: MAX_FREE_TEXT } : {}),
      ...(raw?.isSecret === true ? { secret: true } : {}),
    });
  }
  if (!distinctQuestionIds(questions)) return null;
  return {
    questions,
    response: (answers) => ({
      answers: Object.fromEntries(Object.entries(answers).map(([id, answer]) => [
        id,
        { answers: Array.isArray(answer) ? answer : [answer] },
      ])),
    }),
  };
}

interface NativeChoice {
  label: string;
  value: Json;
}

function enumChoices(schema: Json): NativeChoice[] | null {
  let choices: NativeChoice[];
  const titled = Array.isArray(schema?.oneOf) ? schema.oneOf : Array.isArray(schema?.anyOf) ? schema.anyOf : null;
  if (titled) {
    choices = titled.map((entry: Json) => ({
      label: boundedString(entry?.title, MAX_QUESTION_ID) ?? "",
      value: entry?.const,
    }));
  } else if (Array.isArray(schema?.enum)) {
    const names = Array.isArray(schema.enumNames) && schema.enumNames.length === schema.enum.length
      ? schema.enumNames
      : schema.enum;
    choices = schema.enum.map((value: Json, index: number) => ({
      label: boundedString(names[index], MAX_QUESTION_ID) ?? "",
      value,
    }));
  } else {
    return null;
  }
  if (
    choices.length === 0 || choices.length > MAX_QUESTION_OPTIONS ||
    choices.some((choice) => !choice.label || typeof choice.value !== "string") ||
    new Set(choices.map((choice) => choice.label)).size !== choices.length
  ) return null;
  return choices;
}

function inputFormat(value: unknown): AgentQuestion["inputFormat"] | null {
  if (value == null) return "text";
  return value === "email" || value === "uri" || value === "date" || value === "date-time"
    ? value === "uri" ? "url" : value
    : null;
}

/** Normalize the stable MCP form elicitation schema into Wollipog's structured question surface. */
export function normalizeMcpFormElicitation(params: Json): NormalizedQuestionRequest | null {
  const schema = params?.requestedSchema;
  const properties = schema?.properties;
  if (params?.mode !== "form" || schema?.type !== "object" || !properties || typeof properties !== "object" || Array.isArray(properties)) {
    return null;
  }
  const entries = Object.entries(properties);
  if (entries.length === 0 || entries.length > MAX_STRUCTURED_QUESTIONS) return null;
  if (schema.required != null && (!Array.isArray(schema.required) || schema.required.some((key: unknown) => typeof key !== "string"))) {
    return null;
  }
  const requiredKeys = (schema.required ?? []) as string[];
  const propertyKeys = new Set(entries.map(([key]) => key));
  if (new Set(requiredKeys).size !== requiredKeys.length || requiredKeys.some((key) => !propertyKeys.has(key))) return null;
  const required = new Set(requiredKeys);
  const questions: AgentQuestion[] = [];
  const nativeValues = new Map<string, Map<string, Json>>();
  const message = boundedString(params?.message, MAX_QUESTION_TEXT);
  const serverName = boundedString(params?.serverName, MAX_QUESTION_HEADER);
  if (!message || !serverName) return null;

  for (const [id, raw] of entries) {
    if (!boundedString(id, MAX_QUESTION_ID) || !raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const property = raw as Json;
    const title = property.title == null ? undefined : boundedString(property.title, MAX_QUESTION_HEADER);
    const description = property.description == null ? undefined : boundedString(property.description, MAX_QUESTION_TEXT);
    if ((property.title != null && !title) || (property.description != null && !description)) return null;
    const base = {
      id,
      ...(title ? { header: title } : {}),
      question: description ?? title ?? id,
      options: [] as AgentQuestion["options"],
      required: required.has(id),
      ...(questions.length === 0 ? { context: `${serverName}: ${message}` } : {}),
    };

    if (property.type === "boolean") {
      const choices = [{ label: "True", value: true }, { label: "False", value: false }];
      nativeValues.set(id, new Map(choices.map((choice) => [choice.label, choice.value])));
      questions.push({ ...base, options: choices.map(({ label }) => ({ label })) });
      continue;
    }

    if (property.type === "array") {
      const choices = enumChoices(property.items);
      if (!choices) return null;
      const minSelections = nonnegativeInteger(property.minItems) ?? 0;
      const maxSelections = nonnegativeInteger(property.maxItems);
      if (
        (property.minItems != null && nonnegativeInteger(property.minItems) == null) ||
        (property.maxItems != null && maxSelections == null) ||
        (maxSelections != null && maxSelections < minSelections)
      ) return null;
      nativeValues.set(id, new Map(choices.map((choice) => [choice.label, choice.value])));
      questions.push({
        ...base,
        multiSelect: true,
        options: choices.map(({ label }) => ({ label })),
        minSelections,
        ...(maxSelections != null ? { maxSelections } : {}),
      });
      continue;
    }

    if (property.type === "string") {
      const choices = enumChoices(property);
      if (choices) {
        nativeValues.set(id, new Map(choices.map((choice) => [choice.label, choice.value])));
        questions.push({ ...base, options: choices.map(({ label }) => ({ label })) });
        continue;
      }
      if (property.enum !== undefined || property.oneOf !== undefined || property.anyOf !== undefined) return null;
      const minLength = nonnegativeInteger(property.minLength);
      const providerMaxLength = nonnegativeInteger(property.maxLength);
      if (
        (property.minLength != null && minLength == null) ||
        (property.maxLength != null && providerMaxLength == null)
      ) return null;
      const maxLength = Math.min(providerMaxLength ?? MAX_FREE_TEXT, MAX_FREE_TEXT);
      if (minLength != null && minLength > maxLength) return null;
      const format = inputFormat(property.format);
      if (!format) return null;
      questions.push({
        ...base,
        allowOther: true,
        inputFormat: format,
        ...(minLength != null ? { minLength } : {}),
        maxLength,
      });
      continue;
    }

    if (property.type === "number" || property.type === "integer") {
      const minimum = finiteNumber(property.minimum);
      const maximum = finiteNumber(property.maximum);
      if (
        (property.minimum != null && minimum == null) ||
        (property.maximum != null && maximum == null) ||
        (minimum != null && maximum != null && minimum > maximum)
      ) return null;
      questions.push({
        ...base,
        allowOther: true,
        inputFormat: property.type,
        ...(minimum != null ? { minimum } : {}),
        ...(maximum != null ? { maximum } : {}),
      });
      continue;
    }
    return null;
  }

  return {
    questions,
    response: (answers, action) => {
      if (action === "dismiss" || (action == null && Object.keys(answers).length === 0)) {
        return mcpElicitationResponse("cancel");
      }
      const content = Object.fromEntries(Object.entries(answers).map(([id, answer]) => {
        const values = nativeValues.get(id);
        if (Array.isArray(answer)) return [id, answer.map((label) => values?.get(label) ?? label)];
        if (values) return [id, values.get(answer) ?? answer];
        const question = questions.find((candidate) => candidate.id === id);
        return [id, question?.inputFormat === "number" || question?.inputFormat === "integer" ? Number(answer) : answer];
      }));
      return mcpElicitationResponse("accept", content);
    },
  };
}

export function mcpElicitationResponse(action: McpElicitationAction, content: Json = null): Json {
  return { action, content: action === "accept" ? content : null, _meta: null };
}
