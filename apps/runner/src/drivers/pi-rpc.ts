import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { posix, win32 } from "node:path";
import {
  DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH,
  type AgentQuestion,
  type PromptImage,
  type SessionConfig,
} from "@wollipog/protocol";
import {
  PiRpcOversizedResponseError,
  PiRpcPeer,
  PiRpcRequestTimeoutError,
  PiRpcResponseError,
  PiRpcTransportError,
} from "../pi-rpc-peer.js";
import { runContextCommand } from "../context-command.js";
import { PI_AGENT_CONTROL_STATUS_KEY } from "../pi-agent-control-extension.js";
import { killTree, spawnAgent, terminateDescendantBoundaries, type AgentProcess } from "../spawn.js";
import type {
  Driver,
  DriverCallbacks,
  DriverOptions,
  DriverSteerInput,
  DriverSteerResult,
  StopReason,
} from "./driver.js";

type Json = Record<string, unknown>;

interface PendingPiQuestion {
  method: "select" | "confirm" | "input" | "editor";
  questionId: string;
  timer?: NodeJS.Timeout;
}

interface PendingAgentControlBridge {
  nonce: string;
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const MAX_PENDING_PI_QUESTIONS = 128;

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function boundedText(value: unknown, max = 16_000): string | undefined {
  if (typeof value === "string") return value.slice(0, max);
  if (value == null) return undefined;
  try {
    return JSON.stringify(value).slice(0, max);
  } catch {
    return undefined;
  }
}

function contentText(content: unknown, kind: "text" | "thinking"): string {
  if (!Array.isArray(content)) return typeof content === "string" && kind === "text" ? content : "";
  return content.flatMap((block) => {
    const item = object(block);
    if (item?.type !== kind) return [];
    const value = kind === "text" ? item.text : item.thinking;
    return typeof value === "string" ? [value] : [];
  }).join("");
}

function piModelSelection(model: string): { provider: string; modelId: string } | null {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  return { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

function promptImages(images: PromptImage[]): Json[] {
  return images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
}

function safelyAttributedSessionFile(sourceFile: string | null, targetFile: string, sessionId: string, wsl: boolean): boolean {
  if (sourceFile === targetFile) return false;
  const paths = wsl || process.platform !== "win32" ? posix : win32;
  if (!paths.isAbsolute(targetFile)) return false;
  const fileName = paths.basename(targetFile);
  if (fileName !== `${sessionId}.jsonl` && !fileName.endsWith(`_${sessionId}.jsonl`)) return false;
  // The fork id is minted by this driver and passed through --session-id, so an exact filename is
  // target-owned even when this helper deliberately was not initialized on the copied source.
  if (!sourceFile) return true;
  const sourceParts = sourceFile.split(paths.sep);
  const piRoot = sourceParts.findIndex((part, index) =>
    part === ".pi" && sourceParts[index + 1] === "agent" && sourceParts[index + 2] === "sessions");
  const root = piRoot >= 0
    ? sourceParts.slice(0, piRoot + 3).join(paths.sep) || paths.sep
    : paths.dirname(sourceFile);
  const relative = paths.relative(root, targetFile);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

export class PiRpcDriver implements Driver {
  private child: AgentProcess | null = null;
  private peer: PiRpcPeer | null = null;
  private config: SessionConfig;
  private cwd: string;
  private sessionId: string | null = null;
  private sessionFile: string | null = null;
  private completedTurnId: string | null = null;
  private checkpointRefreshDisabled = false;
  private turnId: string | null = null;
  private promptBusy = false;
  private promptAccepted = false;
  private providerSettled = false;
  private settling = false;
  private disposed = false;
  private exitReported = false;
  private cancelled = false;
  private turnResolve: ((reason: StopReason) => void) | null = null;
  private turnStop: StopReason = "end_turn";
  private currentMessageId: string | null = null;
  private currentTextStreamed = false;
  private currentThinkingStreamed = false;
  private streamedAgentResponse = false;
  private messageSeq = 0;
  private readonly toolCalls = new Set<string>();
  private readonly pendingQuestions = new Map<string, PendingPiQuestion>();
  private readonly forkedSessionFiles = new Map<string, string>();
  private readonly descendantOwner = {};
  private agentControlBridge: PendingAgentControlBridge | null = null;

  constructor(
    private readonly opts: DriverOptions,
    private readonly cb: DriverCallbacks,
    private readonly spawn: typeof spawnAgent = spawnAgent,
    private readonly kill: typeof killTree = killTree,
  ) {
    this.config = opts.config;
    this.cwd = opts.cwd;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  agentSessionId(): string | null {
    return this.sessionId;
  }

  agentTurnId(): string | null {
    return this.completedTurnId;
  }

  activeSteeringTurnId(): string | null {
    return this.promptBusy ? this.turnId : null;
  }

  async initialize(): Promise<void> {
    if (this.disposed) throw new Error("session disposed before Pi launch");
    this.exitReported = false;
    const bridgeNonce = this.opts.env.WOLLIPOG_PI_AGENT_CONTROL_READY_NONCE;
    let bridgeReady: Promise<void> | undefined;
    if (bridgeNonce) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const timer = setTimeout(() => this.rejectAgentControlBridge(
        new Error("Pi Agent Control extension did not become ready"),
      ), 10_000);
      timer.unref?.();
      this.agentControlBridge = { nonce: bridgeNonce, promise, resolve, reject, timer };
      bridgeReady = promise;
      void promise.catch(() => {});
    }
    const args = [
      ...this.opts.args,
      "--mode", "rpc",
      // Project-local .pi resources are executable. Until Wollipog has recorded a durable trust
      // grant, force Pi's documented fail-closed project behavior on every launch.
      "--no-approve",
      ...(this.opts.resumeId ? ["--session", this.opts.resumeId] : []),
    ];
    const child = this.spawn({
      command: this.opts.command,
      args,
      cwd: this.cwd,
      env: this.opts.env,
      context: this.opts.context,
      isolation: this.opts.isolation,
      containerAgentLaunch: true,
      cloudAgentLaunch: true,
      descendantOwner: this.descendantOwner,
      descendantMarker: this.opts.descendantMarker,
    });
    this.child = child;
    const peer = new PiRpcPeer(
      child.stdin,
      child.stdout,
      (event) => this.onRpcEvent(event),
      (error) => {
        if (this.disposed) return;
        this.cb.onStderr(`Pi RPC transport: ${error.message}`);
        if (this.child === child) this.kill(child);
        this.reportExit(null);
      },
    );
    this.peer = peer;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = String(chunk).trim();
      if (text && !this.disposed) this.cb.onStderr(text);
    });
    let finished = false;
    const finish = (code: number | null, detail?: Error) => {
      if (finished) return;
      finished = true;
      if (this.peer === peer) this.peer = null;
      if (this.child === child) this.child = null;
      peer.dispose(detail?.message ?? "Pi exited");
      this.dismissQuestions("provider_resolved");
      this.rejectAgentControlBridge(detail ?? new Error("Pi exited before Agent Control became ready"));
      this.reportExit(code);
      this.settleTurn(this.cancelled ? "cancelled" : "refusal");
    };
    child.on("error", (error: Error) => finish(null, error));
    child.on("close", (code) => finish(code));

    const state = await peer.request<Json>({ type: "get_state" });
    this.applyState(object(state.data));
    if (!this.sessionId) throw new Error("Pi RPC did not establish a persistent session id");
    if (this.opts.resumeId && this.sessionId !== this.opts.resumeId) {
      throw new Error(`Pi resumed session ${this.sessionId} instead of ${this.opts.resumeId}`);
    }
    await this.applyConfig(this.config);
    await bridgeReady;
  }

  async newSession(cwd: string): Promise<string> {
    if (cwd !== this.cwd) throw new Error("Pi RPC working directory changed after launch");
    if (!this.peer || !this.sessionId) throw new Error("Pi RPC session is not ready");
    this.cb.onSessionEstablished?.(this.sessionId);
    return this.sessionId;
  }

  /** Pi's --fork startup option clones the active branch into the process cwd without replacing
   * the source RPC process. Wollipog deliberately exposes only the latest completed checkpoint:
   * the public RPC can clone its current leaf, but cannot fork "at" an arbitrary historical entry. */
  async forkSession(
    lastTurnId: string,
    cwd: string,
    options: { isolation?: DriverOptions["isolation"]; descendantMarker?: string } = {},
  ): Promise<string> {
    const peer = this.peer;
    const sourceSessionId = this.sessionId ?? this.opts.resumeId;
    if (!sourceSessionId || this.disposed) throw new PiRpcTransportError("Pi RPC has no resumable source session");
    if (this.promptBusy) throw new Error("Pi cannot clone while a turn is running");
    if (peer) {
      if (this.completedTurnId !== lastTurnId) {
        throw new Error("Pi can clone only its latest completed conversation checkpoint");
      }
      const sourceEntries = object((await peer.request<Json>(
        { type: "get_entries", since: lastTurnId },
        5_000,
        { discardOversizedResponse: true },
      )).data);
      if (string(sourceEntries?.leafId) !== lastTurnId) {
        throw new Error("Pi can clone only its latest completed conversation checkpoint");
      }
    }

    const expectedForkSessionId = randomUUID();
    const child = this.spawn({
      command: this.opts.command,
      args: [
        ...this.opts.args,
        "--mode", "rpc",
        "--no-approve",
        "--fork", sourceSessionId,
        "--session-id", expectedForkSessionId,
      ],
      cwd,
      env: this.opts.env,
      context: this.opts.context,
      isolation: options.isolation ?? this.opts.isolation,
      containerAgentLaunch: true,
      cloudAgentLaunch: true,
      descendantOwner: this.descendantOwner,
      descendantMarker: options.descendantMarker ?? this.opts.descendantMarker,
    });
    const forkPeer = new PiRpcPeer(child.stdin, child.stdout, () => {}, () => {
      if (child.exitCode == null) this.kill(child);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = String(chunk).trim();
      if (text && !this.disposed) this.cb.onStderr(`Pi fork: ${text}`);
    });
    const close = (detail: string) => forkPeer.dispose(detail);
    child.on("error", (error: Error) => close(error.message));
    child.on("close", () => close("Pi fork helper exited"));
    try {
      const state = object((await forkPeer.request<Json>({ type: "get_state" })).data);
      const forkedSessionId = string(state?.sessionId);
      const sessionFile = string(state?.sessionFile);
      const fileIsTargetOwned = !!forkedSessionId && forkedSessionId !== sourceSessionId && !!sessionFile && safelyAttributedSessionFile(
        this.sessionFile, sessionFile, forkedSessionId, this.opts.context.kind === "wsl",
      );
      if (fileIsTargetOwned) this.forkedSessionFiles.set(expectedForkSessionId, sessionFile!);
      if (forkedSessionId !== expectedForkSessionId || forkedSessionId === sourceSessionId) {
        throw new Error("Pi did not establish an independent fork session");
      }
      const paths = this.opts.context.kind === "wsl" || process.platform !== "win32" ? posix : win32;
      const fileName = paths.basename(sessionFile ?? "");
      if (!fileIsTargetOwned || !sessionFile ||
          (fileName !== `${forkedSessionId}.jsonl` && !fileName.endsWith(`_${forkedSessionId}.jsonl`))) {
        throw new Error("Pi fork did not report a safely attributable session file");
      }
      const forkedEntries = object((await forkPeer.request<Json>(
        { type: "get_entries", since: lastTurnId },
        5_000,
        { discardOversizedResponse: true },
      )).data);
      if (string(forkedEntries?.leafId) !== lastTurnId) {
        throw new Error("Pi fork did not preserve the requested completed checkpoint");
      }
      return forkedSessionId;
    } catch (error) {
      try {
        await this.archiveSession(expectedForkSessionId);
      } catch (cleanupError) {
        this.cb.onStderr(`Pi fork cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
      throw error;
    } finally {
      forkPeer.dispose("Pi fork helper complete");
      this.kill(child);
    }
  }

  /** Roll back only a session file minted by this driver instance. Isolated forks live in the
   * target's hashed provider-state partition, which the manager removes atomically instead. */
  async archiveSession(sessionId: string): Promise<void> {
    const sessionFile = this.forkedSessionFiles.get(sessionId);
    if (!sessionFile) return;
    this.forkedSessionFiles.delete(sessionId);
    const backend = this.opts.isolation?.backend;
    if (backend === "bwrap" || backend === "wsl-bwrap") return;
    if (this.opts.context.kind === "wsl") {
      await runContextCommand(this.opts.context, "rm", ["-f", "--", sessionFile], {
        cwd: "/",
        timeoutMs: 5_000,
      });
      return;
    }
    if (backend === "container" || backend === "cloud") return;
    await rm(sessionFile, { force: true });
  }

  async prompt(text: string, images: PromptImage[] = [], slashCommand?: string): Promise<StopReason> {
    const peer = this.peer;
    if (!peer || this.disposed) throw new PiRpcTransportError("Pi RPC is not running");
    if (this.promptBusy) return "refusal";
    this.promptBusy = true;
    this.promptAccepted = false;
    this.providerSettled = false;
    this.settling = false;
    this.cancelled = false;
    this.turnStop = "end_turn";
    this.turnId = `pi-${randomUUID()}`;
    this.cb.onSteeringTurnChanged?.();
    this.toolCalls.clear();
    this.streamedAgentResponse = false;
    const message = slashCommand ? `/${slashCommand}${text ? ` ${text}` : ""}`.trim() : text;

    return new Promise<StopReason>((resolve, reject) => {
      this.turnResolve = resolve;
      peer.request<Json>({ type: "prompt", message, ...(images.length ? { images: promptImages(images) } : {}) })
        .then(() => {
          if (!this.turnResolve) return;
          this.promptAccepted = true;
          this.cb.onPromptAccepted?.();
          if (this.providerSettled) void this.finishSettledTurn();
        })
        .catch((error) => {
          if (!this.turnResolve) return;
          if (error instanceof PiRpcResponseError) {
            this.cb.onEvent({ kind: "error", message: `Pi rejected the prompt: ${error.message}` });
            this.settleTurn("refusal");
          } else {
            // A transport failure after stdin.write may have delivered the prompt. Let process
            // exit remove the active session so the manager records uncertainty and never replays.
            if (this.child) this.kill(this.child);
            this.reportExit(null);
            reject(error);
            this.turnResolve = null;
            this.promptBusy = false;
            this.promptAccepted = false;
            this.providerSettled = false;
            this.settling = false;
            this.turnId = null;
            this.cb.onSteeringTurnChanged?.();
          }
        });
    });
  }

  async steer({ text, images = [], deadlineAt }: DriverSteerInput): Promise<DriverSteerResult> {
    const peer = this.peer;
    const expectedTurnId = this.turnId;
    if (!peer || !this.promptBusy || !expectedTurnId) {
      return { outcome: "no_active_turn", reason: "Pi has no active run to steer" };
    }
    if (!text && !images.length) return { outcome: "rejected", reason: "steering input is empty" };
    const remaining = deadlineAt - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return { outcome: "rejected", reason: "steering submission deadline expired before provider delivery" };
    }
    try {
      await peer.request<Json>({
        type: "steer",
        message: text,
        ...(images.length ? { images: promptImages(images) } : {}),
      }, remaining);
      if (this.turnId !== expectedTurnId || !this.promptBusy) {
        return { outcome: "stale_turn", reason: "Pi run settled while steering was submitted" };
      }
      return { outcome: "accepted", providerTurnId: expectedTurnId };
    } catch (error) {
      if (error instanceof PiRpcResponseError) return { outcome: "rejected", reason: error.message };
      return { outcome: "uncertain", reason: (error as Error).message };
    }
  }

  async setConfig(config: SessionConfig): Promise<void> {
    this.config = config;
    if (this.peer) await this.applyConfig(config);
  }

  cancel(): void {
    this.cancelled = true;
    if (!this.peer || !this.promptBusy) return;
    void this.peer.request<Json>({ type: "abort" }).catch(() => {});
  }

  resolvePermission(): boolean {
    return false;
  }

  answerQuestion(
    requestId: string,
    answers: Record<string, string | string[]>,
    action: "submit" | "dismiss" = Object.keys(answers).length ? "submit" : "dismiss",
  ): boolean {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending || !this.peer) return false;
    this.pendingQuestions.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    const answer = answers[pending.questionId];
    const value = Array.isArray(answer) ? answer[0] : answer;
    const response: Json = action === "dismiss" || value == null
      ? { type: "extension_ui_response", id: requestId, cancelled: true }
      : pending.method === "confirm"
        ? { type: "extension_ui_response", id: requestId, confirmed: value === "Yes" }
        : { type: "extension_ui_response", id: requestId, value };
    return this.peer.send(response);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelled = true;
    this.dismissQuestions("replaced");
    this.settleTurn("cancelled");
    this.rejectAgentControlBridge(new Error("Pi driver disposed before Agent Control became ready"));
    this.peer?.dispose("Pi driver disposed");
    this.peer = null;
    if (this.child) this.kill(this.child);
    this.child = null;
    terminateDescendantBoundaries(this.descendantOwner);
  }

  private async applyConfig(config: SessionConfig): Promise<void> {
    const peer = this.peer;
    if (!peer) return;
    if (config.model && config.model !== "default") {
      const selection = piModelSelection(config.model);
      if (!selection) throw new Error(`Pi model ${config.model} is missing its provider prefix`);
      const response = await peer.request<Json>({ type: "set_model", ...selection });
      const model = object(response.data);
      if (string(model?.provider) && string(model?.id)) {
        this.cb.onModelResolved?.(`${model!.provider}/${model!.id}`);
      } else {
        this.cb.onModelResolved?.(config.model);
      }
    }
    if (config.effort) await peer.request({ type: "set_thinking_level", level: config.effort });
  }

  private applyState(state: Json | undefined): void {
    const id = string(state?.sessionId);
    if (id) this.sessionId = id;
    const sessionFile = string(state?.sessionFile);
    if (sessionFile) this.sessionFile = sessionFile;
    const model = object(state?.model);
    const provider = string(model?.provider);
    const modelId = string(model?.id);
    if (provider && modelId) this.cb.onModelResolved?.(`${provider}/${modelId}`);
  }

  private onRpcEvent(event: Json): void {
    switch (event.type) {
      case "agent_start":
        return;
      case "agent_settled":
        this.providerSettled = true;
        if (this.promptAccepted) void this.finishSettledTurn();
        return;
      case "message_start":
        this.currentMessageId = `pi-message-${++this.messageSeq}`;
        this.currentTextStreamed = false;
        this.currentThinkingStreamed = false;
        return;
      case "message_update":
        this.onMessageUpdate(object(event.assistantMessageEvent));
        return;
      case "message_end":
        this.onMessageEnd(object(event.message));
        return;
      case "tool_execution_start":
        this.onToolStart(event);
        return;
      case "tool_execution_update":
        this.onToolUpdate(event, false);
        return;
      case "tool_execution_end":
        this.onToolUpdate(event, true);
        return;
      case "extension_ui_request":
        if (this.acceptAgentControlReady(event)) return;
        this.onExtensionUiRequest(event);
        return;
      case "extension_error":
        this.rejectAgentControlBridge(new Error("Pi Agent Control extension failed during startup"));
        return;
      case "compaction_end": {
        const result = object(event.result);
        this.emitUsage(object(result?.usage));
        return;
      }
      default:
        return;
    }
  }

  private acceptAgentControlReady(event: Json): boolean {
    const pending = this.agentControlBridge;
    if (!pending || event.method !== "setStatus" || event.statusKey !== PI_AGENT_CONTROL_STATUS_KEY ||
        event.statusText !== pending.nonce) return false;
    clearTimeout(pending.timer);
    this.agentControlBridge = null;
    pending.resolve();
    return true;
  }

  private rejectAgentControlBridge(error: Error): void {
    const pending = this.agentControlBridge;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.agentControlBridge = null;
    pending.reject(error);
  }

  private onMessageUpdate(update: Json | undefined): void {
    if (!update) return;
    const messageId = this.currentMessageId ?? `pi-message-${++this.messageSeq}`;
    this.currentMessageId = messageId;
    if (update.type === "text_delta" && typeof update.delta === "string" && update.delta) {
      this.currentTextStreamed = true;
      this.streamedAgentResponse = true;
      this.cb.onEvent({ kind: "agent_message", text: update.delta, messageId });
    } else if (update.type === "thinking_delta" && typeof update.delta === "string" && update.delta) {
      this.currentThinkingStreamed = true;
      this.cb.onEvent({ kind: "agent_thought", text: update.delta, messageId });
    } else if (update.type === "toolcall_start") {
      const id = string(update.id);
      if (!id) return;
      this.toolCalls.add(id);
      this.cb.onEvent({
        kind: "tool_call",
        toolCallId: id,
        title: string(update.toolName) ?? "Pi Tool",
        toolKind: string(update.toolName),
        status: "pending",
      });
    } else if (update.type === "toolcall_delta") {
      const id = string(update.id) ?? string(object(update.toolCall)?.id);
      if (id && typeof update.delta === "string") {
        this.cb.onEvent({ kind: "tool_call_update", toolCallId: id, status: "pending", text: update.delta.slice(0, 16_000) });
      }
    }
  }

  private onMessageEnd(message: Json | undefined): void {
    if (!message) return;
    const messageId = this.currentMessageId ?? `pi-message-${++this.messageSeq}`;
    if (message.role === "assistant") {
      const thought = contentText(message.content, "thinking");
      const text = contentText(message.content, "text");
      if (thought && !this.currentThinkingStreamed) {
        this.cb.onEvent({ kind: "agent_thought", text: thought, final: true, messageId });
      }
      if (text && !this.currentTextStreamed) {
        this.streamedAgentResponse = true;
        this.cb.onEvent({ kind: "agent_message", text, final: true, messageId });
      }
    }
    this.emitUsage(object(message.usage), string(message.model));
    if (message.stopReason === "length") this.turnStop = "max_tokens";
    else if (message.stopReason === "error") this.turnStop = "refusal";
    else if (message.stopReason === "aborted") this.turnStop = "cancelled";
    this.currentMessageId = null;
    this.currentTextStreamed = false;
    this.currentThinkingStreamed = false;
  }

  private onToolStart(event: Json): void {
    const id = string(event.toolCallId);
    if (!id) return;
    const title = string(event.toolName) ?? "Pi Tool";
    const text = boundedText(event.args);
    if (this.toolCalls.has(id)) {
      this.cb.onEvent({ kind: "tool_call_update", toolCallId: id, title, status: "in_progress", text });
    } else {
      this.toolCalls.add(id);
      this.cb.onEvent({ kind: "tool_call", toolCallId: id, title, toolKind: string(event.toolName), status: "in_progress", text });
    }
  }

  private onToolUpdate(event: Json, terminal: boolean): void {
    const id = string(event.toolCallId);
    if (!id) return;
    const result = event.result ?? event.partialResult;
    const error = event.isError === true || object(result)?.isError === true;
    this.cb.onEvent({
      kind: "tool_call_update",
      toolCallId: id,
      status: terminal ? error ? "failed" : "completed" : "in_progress",
      text: boundedText(result),
    });
    if (terminal) this.emitUsage(object(object(result)?.usage));
  }

  private emitUsage(usage: Json | undefined, model?: string): void {
    if (!usage) return;
    const cost = object(usage.cost);
    const input = typeof usage.input === "number" ? usage.input : undefined;
    const output = typeof usage.output === "number" ? usage.output : undefined;
    const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : undefined;
    const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : undefined;
    const totalCost = typeof cost?.total === "number" ? cost.total : undefined;
    if (input != null || output != null || cacheRead != null || cacheWrite != null || totalCost != null) {
      this.cb.onEvent({
        kind: "token_usage",
        inputTokens: input,
        outputTokens: output,
        cachedInputTokens: cacheRead,
        cacheCreationInputTokens: cacheWrite,
        costUsd: totalCost,
        model,
      });
    }
  }

  private onExtensionUiRequest(event: Json): void {
    const requestId = string(event.id);
    const method = event.method;
    if (!requestId || !["select", "confirm", "input", "editor"].includes(String(method))) {
      if (method === "notify" && typeof event.message === "string") {
        this.cb.onEvent(event.notifyType === "error"
          ? { kind: "error", message: event.message.slice(0, 4000) }
          : { kind: "stderr", text: event.message.slice(0, 4000) });
      } else if (method === "setTitle" && typeof event.title === "string") {
        this.cb.onAcpSessionInfo?.({ title: event.title.slice(0, 200) });
      }
      return;
    }
    const typedMethod = method as PendingPiQuestion["method"];
    if (this.pendingQuestions.has(requestId) || this.pendingQuestions.size >= MAX_PENDING_PI_QUESTIONS) {
      this.peer?.send({ type: "extension_ui_response", id: requestId, cancelled: true });
      return;
    }
    const title = string(event.title) ?? "Pi Extension Request";
    const questionId = `${requestId}:value`;
    const question: AgentQuestion = typedMethod === "select"
      ? {
          id: questionId,
          header: "Pi Extension",
          question: title,
          options: Array.isArray(event.options)
            ? event.options.filter((option): option is string => typeof option === "string").slice(0, 100).map((label) => ({ label }))
            : [],
        }
      : typedMethod === "confirm"
        ? {
            id: questionId,
            header: "Pi Extension",
            question: title,
            context: boundedText(event.message, 4000),
            options: [{ label: "Yes" }, { label: "No" }],
          }
        : {
            id: questionId,
            header: typedMethod === "editor" ? "Pi Extension Editor" : "Pi Extension Input",
            question: title,
            context: boundedText(typedMethod === "editor" ? event.prefill : event.placeholder, 4000),
            options: [],
            allowOther: true,
            maxLength: DEFAULT_QUESTION_FREE_TEXT_MAX_LENGTH,
          };
    const pending: PendingPiQuestion = { method: typedMethod, questionId };
    const timeout = typeof event.timeout === "number" && event.timeout > 0 ? Math.min(event.timeout, 2_147_483_647) : undefined;
    if (timeout) {
      pending.timer = setTimeout(() => {
        if (!this.pendingQuestions.delete(requestId)) return;
        this.cb.onEvent({ kind: "question_resolved", requestId, answered: false, resolutionReason: "provider_resolved" });
      }, timeout);
      pending.timer.unref?.();
    }
    this.pendingQuestions.set(requestId, pending);
    this.cb.onEvent({ kind: "question_request", requestId, questions: [question] });
  }

  private async finishSettledTurn(): Promise<void> {
    if (this.settling) return;
    this.settling = true;
    this.dismissQuestions("provider_resolved");
    if (this.streamedAgentResponse) this.cb.onEvent({ kind: "agent_response_completed" });
    await this.refreshSessionStats();
    await this.refreshCompletedTurnId();
    this.settleTurn(this.cancelled ? "cancelled" : this.turnStop);
  }

  private async refreshCompletedTurnId(): Promise<void> {
    if (this.opts.capabilities?.supportsConversationFork !== true || this.checkpointRefreshDisabled) {
      this.completedTurnId = null;
      return;
    }
    const hadCursor = this.completedTurnId !== null;
    try {
      const response = await this.peer?.request<Json>(
        { type: "get_entries", ...(this.completedTurnId ? { since: this.completedTurnId } : {}) },
        5_000,
        { discardOversizedResponse: true },
      );
      const leafId = string(object(response?.data)?.leafId);
      this.completedTurnId = leafId ?? null;
      if (!leafId) this.cb.onStderr("Pi RPC did not report a completed conversation leaf; fork checkpoint omitted");
    } catch (error) {
      this.completedTurnId = null;
      if (error instanceof PiRpcOversizedResponseError || !hadCursor && error instanceof PiRpcRequestTimeoutError) {
        this.checkpointRefreshDisabled = true;
        return;
      }
      this.cb.onStderr(`Pi RPC could not read the completed conversation leaf: ${(error as Error).message}`);
    }
  }

  private async refreshSessionStats(): Promise<void> {
    try {
      const response = await this.peer?.request<Json>({ type: "get_session_stats" });
      const context = object(object(response?.data)?.contextUsage);
      const contextWindow = typeof context?.contextWindow === "number" ? context.contextWindow : undefined;
      const contextTokensUsed = typeof context?.tokens === "number" ? context.tokens : undefined;
      if (contextWindow && contextWindow > 0) this.cb.onAcpUsage?.({ contextWindow, contextTokensUsed });
    } catch {
      // Usage refresh is advisory; the turn's provider-reported token events remain authoritative.
    }
  }

  private settleTurn(reason: StopReason): void {
    const resolve = this.turnResolve;
    if (!resolve) return;
    this.turnResolve = null;
    this.promptBusy = false;
    this.promptAccepted = false;
    this.providerSettled = false;
    this.settling = false;
    this.turnId = null;
    this.cb.onSteeringTurnChanged?.();
    resolve(reason);
  }

  private reportExit(code: number | null): void {
    if (this.disposed || this.exitReported) return;
    this.exitReported = true;
    this.cb.onExit(code);
  }

  private dismissQuestions(resolutionReason: "replaced" | "provider_resolved"): void {
    for (const [requestId, pending] of this.pendingQuestions) {
      if (pending.timer) clearTimeout(pending.timer);
      this.peer?.send({ type: "extension_ui_response", id: requestId, cancelled: true });
      this.cb.onEvent({ kind: "question_resolved", requestId, answered: false, resolutionReason });
    }
    this.pendingQuestions.clear();
  }
}
