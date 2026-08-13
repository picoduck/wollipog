/**
 * ACP client (wire protocol version 1, official SDK schema 1.2.1). Wraps a JSON-RPC peer over a
 * spawned agent's stdio and translates ACP `session/update` notifications + agent->client calls
 * into our normalized SessionEventPayload taxonomy.
 *
 * See docs/ACP-NOTES.md for the exact wire shapes.
 */

import type {
  AuthenticateRequest,
  CloseSessionRequest,
  ContentBlock,
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  LoadSessionRequest,
  LoadSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  NewSessionResponse,
  LogoutRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ReleaseTerminalRequest,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SessionNotification,
  TerminalOutputRequest,
  TerminalOutputResponse,
  ToolCallContent,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  McpServer,
  NewSessionRequest,
} from "@agentclientprotocol/sdk";
import type { AcpRuntimeCapabilities, AcpSessionContextConfig, AgentCapabilities, AgentContext, AgentSlashCommand, PermissionOption, PromptImage, SessionConfig, SessionEventPayload } from "@wollipog/protocol";
import {
  acpInitializeRequest,
  negotiateAcpInitialize,
  type AcpAuthMethod,
  type AcpNegotiation,
} from "./acp-contract.js";
import type { RpcError } from "./jsonrpc.js";
import { JsonRpcPeer } from "./jsonrpc.js";
import { spawnAgent, killTree, type AgentProcess, type SpawnIsolation } from "./spawn.js";
import {
  acpSessionPresentation,
  normalizeAcpCommands,
  normalizeAcpConfigOptions,
  normalizeAcpModes,
  normalizeAcpSessionInfo,
  normalizeAcpUsage,
  optionForCategory,
  type SafeAcpCommand,
  type SafeAcpConfigOption,
  type SafeAcpModeState,
} from "./acp-session-state.js";
import { AcpFilesystemService, AcpTerminalService } from "./acp-client-services.js";
import { materializeAcpMcpServers } from "./acp-session-context.js";

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface AcpEvents {
  onEvent: (payload: SessionEventPayload) => void;
  onStderr: (text: string) => void;
  onExit: (code: number | null) => void;
  onAuthStatus?: (status: "authenticated" | "unauthenticated") => void;
  onAcpCapabilities?: (capabilities: AcpRuntimeCapabilities) => void;
  onAcpSessionState?: (state: { capabilities: AgentCapabilities; config: SessionConfig }) => void;
  onAcpUsage?: (usage: { contextTokensUsed: number; contextWindow: number; costUsd?: number }) => void;
  onAcpSessionInfo?: (info: { title?: string | null; providerUpdatedAt?: string }) => void;
}

export interface AcpListedSession {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
}

export class AcpClient {
  private readonly peer: JsonRpcPeer;
  private readonly child: AgentProcess;
  private sessionId: string | null = null;
  private readonly permPending = new Map<string, (optionId: string | null) => void>();
  private permCounter = 0;
  private disposed = false;
  private transportClosed = false;
  private supportsImages = false;
  private suppressUpdates = false;
  private negotiation: AcpNegotiation | null = null;
  private modes: SafeAcpModeState | null = null;
  private configOptions: SafeAcpConfigOption[] = [];
  private commands: SafeAcpCommand[] = [];
  private modeBarrier: string | null = null;
  private readonly configBarriers = new Map<string, string>();
  private establishingSession = false;
  private pendingSessionStateUpdates: SessionNotification[] = [];
  private replaySuppressedStateUpdates: SessionNotification[] = [];
  private readonly filesystem: AcpFilesystemService;
  private readonly terminals: AcpTerminalService;
  private readonly terminalEventOutput = new Map<string, { cursor: number }>();

  constructor(
    opts: {
      command: string;
      args: string[];
      cwd: string;
      env: Record<string, string>;
      context?: AgentContext;
      initialCommands?: AgentSlashCommand[];
      sessionContext?: AcpSessionContextConfig;
      isolation?: SpawnIsolation;
      containerAgentLaunch?: boolean;
      cloudAgentLaunch?: boolean;
    },
    private readonly ev: AcpEvents,
  ) {
    this.commands = normalizeAcpCommands(opts.initialCommands);
    this.sessionContext = opts.sessionContext;
    this.mcpEnvironment = { ...process.env, ...opts.env };
    const context = opts.context ?? { kind: "native" as const };
    this.filesystem = new AcpFilesystemService(opts.cwd, context);
    this.terminals = new AcpTerminalService(this.filesystem, context, opts.isolation);
    this.child = spawnAgent(opts);
    this.peer = new JsonRpcPeer(this.child.stdin, this.child.stdout, (err) =>
      this.ev.onStderr(`transport: ${err.message}`),
    );

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (t: string) => {
      if (this.disposed) return;
      const text = String(t).trim();
      if (text) this.ev.onStderr(text);
    });
    this.child.on("exit", (code) => {
      this.transportClosed = true;
      this.terminals.dispose();
      this.peer.dispose("agent process exited");
      this.settlePendingPermissions();
      if (!this.disposed) this.ev.onExit(code);
    });
    this.child.on("error", (err) => {
      this.ev.onStderr(`spawn error: ${err.message}`);
      // On POSIX a spawn failure (ENOENT/EACCES) emits 'error' but never 'exit',
      // so settle in-flight requests here or initialize()/prompt() would hang.
      if (this.disposed) return;
      this.disposed = true;
      this.transportClosed = true;
      this.terminals.dispose();
      this.peer.dispose(`spawn error: ${err.message}`);
      this.settlePendingPermissions();
      this.ev.onExit(null);
    });

    this.registerHandlers();
  }

  private readonly sessionContext: AcpSessionContextConfig | undefined;
  private readonly mcpEnvironment: NodeJS.ProcessEnv;

  get pid(): number | undefined {
    return this.child.pid;
  }

  private registerHandlers(): void {
    this.peer.onNotification("session/update", (params) =>
      this.handleUpdate(params as SessionNotification),
    );
    this.peer.onRequest("session/request_permission", (params) =>
      this.handlePermission(params as RequestPermissionRequest),
    );
    this.peer.onRequest("fs/read_text_file", (params) =>
      this.handleRead(params as ReadTextFileRequest),
    );
    this.peer.onRequest("fs/write_text_file", (params) =>
      this.handleWrite(params as WriteTextFileRequest),
    );
    this.peer.onRequest("terminal/create", (params) =>
      this.handleTerminalCreate(params as CreateTerminalRequest),
    );
    this.peer.onRequest("terminal/output", (params) =>
      this.handleTerminalOutput(params as TerminalOutputRequest),
    );
    this.peer.onRequest("terminal/wait_for_exit", (params) =>
      this.handleTerminalWait(params as WaitForTerminalExitRequest),
    );
    this.peer.onRequest("terminal/kill", (params) =>
      this.handleTerminalKill(params as KillTerminalRequest),
    );
    this.peer.onRequest("terminal/release", (params) =>
      this.handleTerminalRelease(params as ReleaseTerminalRequest),
    );
  }

  /* ----------------------------- Lifecycle ------------------------------- */

  async initialize(): Promise<void> {
    const res = await this.peer.request("initialize", acpInitializeRequest());
    this.negotiation = negotiateAcpInitialize(res);
    this.supportsImages = this.negotiation.stable.promptImage;
    this.ev.onAcpCapabilities?.(runtimeCapabilities(this.negotiation));
  }

  negotiatedCapabilities(): AcpNegotiation | null {
    return this.negotiation;
  }

  async newSession(cwd: string): Promise<string> {
    if (this.sessionId) this.terminals.releaseSession(this.sessionId);
    this.terminalEventOutput.clear();
    this.filesystem.setRoot(cwd);
    this.filesystem.setAdditionalRoots(this.sessionContext?.additionalDirectories ?? []);
    this.sessionId = null;
    this.modes = null;
    this.configOptions = [];
    this.commands = [];
    for (;;) {
      this.establishingSession = true;
      this.pendingSessionStateUpdates = [];
      try {
        const res = (await this.peer.request("session/new", this.sessionRequest(cwd))) as NewSessionResponse;
        this.sessionId = res.sessionId;
        this.establishingSession = false;
        this.acceptSessionState(res.modes, res.configOptions);
        this.replayPendingSessionState(res.sessionId);
        this.reportAuthenticated();
        return res.sessionId;
      } catch (error) {
        this.establishingSession = false;
        this.pendingSessionStateUpdates = [];
        if (this.transportClosed || !isAgentAuthRequiredError(error) || !this.negotiation?.authMethods.length) throw error;
        await this.authenticate();
      }
    }
  }

  async resumeSession(sessionId: string, cwd: string): Promise<string> {
    // The caller supplies the durable ACP id, so establish the notification boundary before the
    // request. Agents may publish same-session state immediately around the resume/load response.
    if (this.sessionId) this.terminals.releaseSession(this.sessionId);
    this.terminalEventOutput.clear();
    this.filesystem.setRoot(cwd);
    this.filesystem.setAdditionalRoots(this.sessionContext?.additionalDirectories ?? []);
    this.sessionId = sessionId;
    try {
      if (this.negotiation?.stable.sessionResume) {
        const request: ResumeSessionRequest = { sessionId, ...this.sessionRequest(cwd) };
        const response = await this.peer.request("session/resume", request) as ResumeSessionResponse;
        this.acceptSessionState(response.modes, response.configOptions);
      } else if (this.negotiation?.stable.loadSession) {
        const request: LoadSessionRequest = { sessionId, ...this.sessionRequest(cwd) };
        // session/load replays history through session/update. Wollipog already owns the durable event
        // log, so replaying it here would duplicate the transcript on every runner restart.
        this.suppressUpdates = true;
        this.replaySuppressedStateUpdates = [];
        try {
          const response = await this.peer.request("session/load", request) as LoadSessionResponse;
          this.acceptSessionState(response.modes, response.configOptions);
        } finally {
          this.suppressUpdates = false;
        }
        this.replaySuppressedState(sessionId);
      } else {
        throw new Error("ACP agent does not advertise session resume or load support");
      }
    } catch (error) {
      this.sessionId = null;
      this.replaySuppressedStateUpdates = [];
      if (error instanceof Error && error.message.startsWith("ACP agent does not advertise")) throw error;
      throw new Error(this.negotiation?.stable.sessionResume ? "ACP session resume failed" : "ACP session load failed");
    }
    this.reportAuthenticated();
    return sessionId;
  }

  private sessionRequest(cwd: string): NewSessionRequest {
    if (!this.negotiation) throw new Error("ACP initialize must complete before creating a session");
    const additionalDirectories = this.sessionContext?.additionalDirectories;
    if (additionalDirectories?.length && !this.negotiation.stable.sessionAdditionalDirectories) {
      throw new Error("ACP agent does not advertise additional-directory support");
    }
    const mcpServers: McpServer[] = materializeAcpMcpServers(this.sessionContext?.mcpServers, this.negotiation, this.mcpEnvironment);
    return {
      cwd,
      mcpServers,
      ...(additionalDirectories?.length ? { additionalDirectories: [...additionalDirectories] } : {}),
    };
  }

  async closeSession(): Promise<boolean> {
    if (!this.sessionId) return false;
    if (!this.negotiation?.stable.sessionClose) {
      return false;
    }
    const request: CloseSessionRequest = { sessionId: this.sessionId };
    try {
      await this.peer.request("session/close", request);
    } catch {
      throw new Error("ACP session close failed");
    }
    this.terminals.releaseSession(this.sessionId);
    this.terminalEventOutput.clear();
    this.sessionId = null;
    return true;
  }

  /** Enumerate stable ACP sessions without retaining provider metadata or allowing unbounded
   * pagination. Invalid entries are ignored; transport/provider failures remain generic because
   * they may contain account or workspace details. */
  async listSessions(): Promise<AcpListedSession[]> {
    if (!this.negotiation?.stable.sessionList) {
      throw new Error("ACP agent does not advertise session list support");
    }
    const sessions: AcpListedSession[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20 && sessions.length < 500; page += 1) {
      const request: ListSessionsRequest = cursor ? { cursor } : {};
      let response: ListSessionsResponse;
      try {
        response = await this.peer.request("session/list", request) as ListSessionsResponse;
      } catch {
        throw new Error("ACP session list failed");
      }
      if (!response || !Array.isArray(response.sessions)) {
        throw new Error("ACP session list failed");
      }
      for (const item of response.sessions) {
        if (sessions.length >= 500) break;
        if (
          !isRecord(item) ||
          typeof item.sessionId !== "string" ||
          !item.sessionId ||
          item.sessionId.length > 1_024 ||
          item.sessionId.includes("\0") ||
          typeof item.cwd !== "string" ||
          item.cwd.length > 32_768
        ) continue;
        sessions.push({
          sessionId: item.sessionId,
          cwd: item.cwd,
          title: typeof item.title === "string" ? item.title.slice(0, 4_096) : null,
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt.slice(0, 128) : null,
        });
      }
      const next = typeof response.nextCursor === "string" && response.nextCursor && response.nextCursor.length <= 4_096
        ? response.nextCursor
        : undefined;
      if (!next || seenCursors.has(next)) break;
      seenCursors.add(next);
      cursor = next;
    }
    return sessions;
  }

  async setConfig(config: SessionConfig): Promise<void> {
    if (!this.sessionId) throw new Error("ACP session is not established");
    if (config.model !== undefined) await this.setSelectConfig("model", config.model);
    if (config.effort !== undefined) await this.setSelectConfig("thought_level", config.effort);
    if (config.permissionMode !== undefined) {
      if (this.modes) await this.setMode(config.permissionMode);
      else await this.setSelectConfig("mode", config.permissionMode);
    }
  }

  /** Reconcile persisted controls after new/resume/load. A provider may omit or narrow controls
   * between processes; those live values are authoritative and must not make the session itself
   * unlaunchable. Prompt-time setConfig remains strict and fail-closed. */
  async restoreInitialConfig(config: SessionConfig): Promise<void> {
    const supported: SessionConfig = {};
    const model = optionForCategory(this.configOptions, "model");
    if (config.model && model?.options.some((candidate) => candidate.value === config.model)) {
      supported.model = config.model;
    }
    const effort = optionForCategory(this.configOptions, "thought_level");
    if (config.effort && effort?.options.some((candidate) => candidate.value === config.effort)) {
      supported.effort = config.effort;
    }
    const modeOption = optionForCategory(this.configOptions, "mode");
    if (
      config.permissionMode &&
      (this.modes?.availableModes.some((candidate) => candidate.id === config.permissionMode) ||
        (!this.modes && modeOption?.options.some((candidate) => candidate.value === config.permissionMode)))
    ) {
      supported.permissionMode = config.permissionMode;
    }
    if (!supported.model && !supported.effort && !supported.permissionMode) return;
    try {
      await this.setConfig(supported);
    } catch {
      // The setup response/update already published the provider's confirmed live values. A
      // restoration race must not make an otherwise resumable session fatal or expose its error.
      this.ev.onStderr("ACP session controls changed; using the agent-reported values");
    }
  }

  private async setMode(modeId: string): Promise<void> {
    if (!this.sessionId || !this.modes?.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error("ACP agent does not advertise the requested session mode");
    }
    if (this.modes.currentModeId === modeId) return;
    this.modeBarrier = modeId;
    const request: SetSessionModeRequest = { sessionId: this.sessionId, modeId };
    try {
      await this.peer.request("session/set_mode", request);
      this.modes = { ...this.modes, currentModeId: modeId };
      if (this.modeBarrier === modeId) this.modeBarrier = null;
      this.emitSessionState();
    } catch {
      this.modeBarrier = null;
      throw new Error("ACP session mode update failed");
    }
  }

  private async setSelectConfig(
    category: "model" | "thought_level" | "mode",
    value: string,
  ): Promise<void> {
    if (!this.sessionId) throw new Error("ACP session is not established");
    const option = optionForCategory(this.configOptions, category);
    if (!option || !option.options.some((candidate) => candidate.value === value)) {
      throw new Error("ACP agent does not advertise the requested session configuration");
    }
    if (option.currentValue === value) return;
    this.configBarriers.set(option.id, value);
    const request: SetSessionConfigOptionRequest = {
      sessionId: this.sessionId,
      configId: option.id,
      value,
    };
    try {
      const response = await this.peer.request("session/set_config_option", request) as SetSessionConfigOptionResponse;
      const next = normalizeAcpConfigOptions(response.configOptions);
      if (optionForCategory(next, category)?.currentValue !== value) {
        throw new Error("unconfirmed ACP session configuration");
      }
      this.configOptions = next;
      this.configBarriers.delete(option.id);
      this.emitSessionState();
    } catch {
      this.configBarriers.delete(option.id);
      throw new Error("ACP session configuration update failed");
    }
  }

  async logout(): Promise<void> {
    if (!this.negotiation?.stable.logout) {
      throw new Error("ACP agent does not advertise logout support");
    }
    const request: LogoutRequest = {};
    try {
      await this.peer.request("logout", request);
    } catch {
      // Provider logout failures may contain account details. Keep the UI state generic and leave
      // the prior readiness untouched because logout was not confirmed.
      throw new Error("ACP agent logout failed");
    }
    this.ev.onAuthStatus?.("unauthenticated");
  }

  /** Resolve an ACP auth-required response without ever moving agent credentials through Wollipog. */
  private async authenticate(): Promise<void> {
    let retry = false;
    for (;;) {
      const selected = await this.chooseAuthMethod(this.negotiation?.authMethods ?? [], retry);
      if (!selected) throw new Error("ACP authentication was cancelled");
      try {
        const request: AuthenticateRequest = { methodId: selected.id };
        await this.peer.request("authenticate", request);
        return;
      } catch {
        if (this.disposed || this.transportClosed) throw new Error("ACP authentication was interrupted");
        // Agent errors can contain provider details or credentials. Render only our bounded retry
        // state; the agent remains responsible for browser/device flow on its own host.
        retry = true;
      }
    }
  }

  private chooseAuthMethod(methods: AcpAuthMethod[], retry: boolean): Promise<AcpAuthMethod | null> {
    if (!methods.length) return Promise.resolve(null);
    const requestId = `auth_${++this.permCounter}`;
    const byOption = new Map<string, AcpAuthMethod>();
    const options: PermissionOption[] = methods.map((method, index) => {
      const optionId = `${requestId}_method_${index + 1}`;
      byOption.set(optionId, method);
      return {
        optionId,
        name: method.name,
        kind: "allow_once",
        ...(method.description ? { description: method.description } : {}),
      };
    });
    const cancelOptionId = `${requestId}_cancel`;
    options.push({ optionId: cancelOptionId, name: "Cancel sign-in", kind: "reject_once" });
    const result = new Promise<AcpAuthMethod | null>((resolve) => {
      this.permPending.set(requestId, (optionId) => resolve(optionId ? byOption.get(optionId) ?? null : null));
    });
    this.ev.onEvent({
      kind: "permission_request",
      purpose: "authentication",
      requestId,
      title: retry
        ? "Sign-in failed. Choose a method to retry."
        : `Sign in to ${this.negotiation?.agentInfo?.title ?? this.negotiation?.agentInfo?.name ?? "ACP agent"}`,
      options,
    });
    return result;
  }

  async prompt(text: string, images: PromptImage[] = [], slashCommand?: string): Promise<StopReason> {
    const content: Array<Record<string, unknown>> = [];
    if (slashCommand && !this.commands.some((command) => command.name === slashCommand)) {
      throw new Error("ACP command is not available in this session");
    }
    const promptText = slashCommand ? `/${slashCommand}${text ? ` ${text}` : ""}` : text;
    if (promptText) content.push({ type: "text", text: promptText });
    if (images.length) {
      if (this.supportsImages) {
        for (const img of images) {
          content.push({ type: "image", data: img.data, mimeType: img.mimeType });
        }
      } else {
        content.push({
          type: "text",
          text: `[${images.length} image(s) attached — this agent does not accept image input, so they were omitted]`,
        });
      }
    }
    if (content.length === 0) content.push({ type: "text", text: "" });
    try {
      const res = (await this.peer.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: content,
      })) as PromptResponse;
      return res.stopReason as StopReason;
    } finally {
      // User-write barriers exist only to reject stale notifications racing the write/next turn.
      this.modeBarrier = null;
      this.configBarriers.clear();
    }
  }

  /** Dispatch a command selected from the provider's live ACP catalog. The driver boundary that
   * calls this method accepts no attachment input, so a structured command can never accidentally
   * inherit images from the ordinary composer prompt path. */
  invokeCommand(commandName: string, argumentText: string): Promise<StopReason> {
    return this.prompt(argumentText, [], commandName);
  }

  cancel(): void {
    if (this.sessionId) this.peer.notify("session/cancel", { sessionId: this.sessionId });
  }

  resolvePermission(requestId: string, optionId: string | null): boolean {
    const resolve = this.permPending.get(requestId);
    if (!resolve) return false;
    this.permPending.delete(requestId);
    resolve(optionId);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transportClosed = true;
    this.terminals.dispose();
    this.settlePendingPermissions();
    this.peer.dispose("client disposed");
    killTree(this.child);
  }

  private settlePendingPermissions(): void {
    for (const [, resolve] of this.permPending) resolve(null);
    this.permPending.clear();
  }

  /* ----------------------- Inbound translation --------------------------- */

  private acceptSessionState(modes: unknown, configOptions: unknown): void {
    this.modeBarrier = null;
    this.configBarriers.clear();
    this.modes = normalizeAcpModes(modes);
    this.configOptions = normalizeAcpConfigOptions(configOptions);
    this.emitSessionState();
  }

  private acceptConfigOptionUpdate(value: unknown): void {
    const incoming = normalizeAcpConfigOptions(value);
    const previous = new Map(this.configOptions.map((option) => [option.id, option]));
    const merged = incoming.map((option) => {
      const expected = this.configBarriers.get(option.id);
      if (!expected) return option;
      if (option.currentValue === expected) {
        this.configBarriers.delete(option.id);
        return option;
      }
      return previous.get(option.id) ?? option;
    });
    for (const [id] of this.configBarriers) {
      if (!merged.some((option) => option.id === id) && previous.has(id)) merged.push(previous.get(id)!);
    }
    this.configOptions = merged;
    this.emitSessionState();
  }

  private emitSessionState(): void {
    this.ev.onAcpSessionState?.(
      acpSessionPresentation(this.modes, this.configOptions, this.commands, this.supportsImages),
    );
  }

  private handleUpdate(params: SessionNotification): void {
    if (!this.sessionId && this.establishingSession && isRuntimeStateUpdate(params?.update)) {
      this.pendingSessionStateUpdates.push(params);
      if (this.pendingSessionStateUpdates.length > 32) this.pendingSessionStateUpdates.shift();
      return;
    }
    if (
      this.suppressUpdates &&
      params?.sessionId === this.sessionId &&
      isRuntimeStateUpdate(params?.update)
    ) {
      this.replaySuppressedStateUpdates.push(params);
      if (this.replaySuppressedStateUpdates.length > 64) this.replaySuppressedStateUpdates.shift();
      return;
    }
    if (
      this.disposed ||
      this.suppressUpdates ||
      !this.sessionId ||
      params?.sessionId !== this.sessionId
    ) return; // ignore dying-process, load-replay, pre-session, or foreign-session events
    const u = params?.update;
    if (!u) return;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        this.ev.onEvent({
          kind: "agent_message",
          text: blockText(u.content as ContentBlock),
          ...(typeof u.messageId === "string" && u.messageId ? { messageId: u.messageId } : {}),
        });
        break;
      case "agent_thought_chunk":
        this.ev.onEvent({
          kind: "agent_thought",
          text: blockText(u.content as ContentBlock),
          ...(typeof u.messageId === "string" && u.messageId ? { messageId: u.messageId } : {}),
        });
        break;
      case "user_message_chunk":
        this.ev.onEvent({ kind: "user_message", text: blockText(u.content as ContentBlock) });
        break;
      case "tool_call":
        this.ev.onEvent({
          kind: "tool_call",
          toolCallId: u.toolCallId ?? "tool",
          title: u.title ?? "tool",
          toolKind: u.kind,
          status: u.status ?? "pending",
          text: toolText(u.content),
        });
        this.emitDiffs(u.content);
        this.emitTerminalOutputs(u.content);
        break;
      case "tool_call_update":
        this.ev.onEvent({
          kind: "tool_call_update",
          toolCallId: u.toolCallId ?? "tool",
          status: u.status ?? "in_progress",
          title: u.title ?? undefined,
          text: toolText(u.content ?? undefined),
        });
        this.emitDiffs(u.content ?? undefined);
        this.emitTerminalOutputs(u.content ?? undefined);
        break;
      case "plan":
        this.ev.onEvent({
          kind: "plan",
          entries: (u.entries ?? []).map((e) => ({
            content: e.content,
            status: (e.status as "pending" | "in_progress" | "completed") ?? "pending",
            priority: e.priority as "low" | "medium" | "high" | undefined,
          })),
        });
        break;
      case "available_commands_update":
        this.commands = normalizeAcpCommands(u.availableCommands);
        this.emitSessionState();
        break;
      case "current_mode_update": {
        const next = typeof u.currentModeId === "string" ? u.currentModeId : "";
        if (!this.modes?.availableModes.some((mode) => mode.id === next)) break;
        if (this.modeBarrier && next !== this.modeBarrier) break;
        if (this.modeBarrier === next) this.modeBarrier = null;
        this.modes = { ...this.modes, currentModeId: next };
        this.emitSessionState();
        break;
      }
      case "config_option_update":
        this.acceptConfigOptionUpdate(u.configOptions);
        break;
      case "usage_update": {
        const usage = normalizeAcpUsage(u);
        if (usage) this.ev.onAcpUsage?.(usage);
        break;
      }
      case "session_info_update": {
        const info = normalizeAcpSessionInfo(u);
        if (info) this.ev.onAcpSessionInfo?.(info);
        break;
      }
    }
  }

  private replayPendingSessionState(sessionId: string): void {
    const pending = this.pendingSessionStateUpdates;
    this.pendingSessionStateUpdates = [];
    for (const update of pending) {
      if (update.sessionId === sessionId) this.handleUpdate(update);
    }
  }

  private replaySuppressedState(sessionId: string): void {
    const pending = this.replaySuppressedStateUpdates;
    this.replaySuppressedStateUpdates = [];
    for (const update of pending) {
      if (update.sessionId === sessionId) this.handleUpdate(update);
    }
  }

  private reportAuthenticated(): void {
    if (this.negotiation?.stable.logout || this.negotiation?.authMethods.length) {
      this.ev.onAuthStatus?.("authenticated");
    }
  }

  private emitDiffs(content: ToolCallContent[] | undefined): void {
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (item.type === "diff" && item.path) {
        this.ev.onEvent({ kind: "file_edit", path: item.path, diff: renderDiff(item) });
      }
    }
  }

  private emitTerminalOutputs(content: ToolCallContent[] | undefined): void {
    if (!this.sessionId || !Array.isArray(content)) return;
    const embedded = content
      .filter((item): item is Extract<ToolCallContent, { type: "content" }> => item.type === "content")
      .map((item) => blockText(item.content))
      .filter(Boolean)
      .join("\n");
    for (const item of content) {
      if (item.type !== "terminal") continue;
      let snapshot: TerminalOutputResponse & { cursor: number };
      try {
        snapshot = this.terminals.snapshot(this.sessionId, item.terminalId);
      } catch {
        this.terminalEventOutput.delete(item.terminalId);
        continue;
      }
      const previous = this.terminalEventOutput.get(item.terminalId);
      const delta = terminalOutputDelta(previous?.cursor, snapshot);
      if (delta === null) continue;
      this.terminalEventOutput.set(item.terminalId, { cursor: snapshot.cursor });
      if (!delta || embedded.includes(delta) || embedded.includes(snapshot.output)) continue;
      for (const chunk of utf8Chunks(delta, 64 * 1024)) {
        this.ev.onEvent({ kind: "command_output", text: chunk });
      }
    }
  }

  private handlePermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.disposed) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const requestId = `perm_${++this.permCounter}`;
    const options: PermissionOption[] = (params.options ?? []).map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
    }));
    const result = new Promise<RequestPermissionResponse>((resolve) => {
      this.permPending.set(requestId, (optionId) =>
        resolve(
          optionId
            ? { outcome: { outcome: "selected", optionId } }
            : { outcome: { outcome: "cancelled" } },
        ),
      );
    });
    this.ev.onEvent({
      kind: "permission_request",
      requestId,
      title: params.toolCall?.title ?? "Permission requested",
      options,
    });
    return result;
  }

  private async handleRead(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    this.assertActiveSession(params.sessionId);
    return { content: await this.filesystem.read(params.path, params.line ?? undefined, params.limit ?? undefined) };
  }

  private async handleWrite(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    this.assertActiveSession(params.sessionId);
    await this.filesystem.write(params.path, params.content);
    this.ev.onEvent({ kind: "file_edit", path: params.path });
    return {};
  }

  private async handleTerminalCreate(params: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    this.assertActiveSession(params.sessionId);
    return this.terminals.create(params);
  }

  private handleTerminalOutput(params: TerminalOutputRequest): TerminalOutputResponse {
    this.assertActiveSession(params.sessionId);
    return this.terminals.output(params.sessionId, params.terminalId);
  }

  private handleTerminalWait(params: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    this.assertActiveSession(params.sessionId);
    return this.terminals.wait(params.sessionId, params.terminalId);
  }

  private handleTerminalKill(params: KillTerminalRequest): Record<string, never> {
    this.assertActiveSession(params.sessionId);
    this.terminals.kill(params.sessionId, params.terminalId);
    return {};
  }

  private handleTerminalRelease(params: ReleaseTerminalRequest): Record<string, never> {
    this.assertActiveSession(params.sessionId);
    this.terminals.release(params.sessionId, params.terminalId);
    this.terminalEventOutput.delete(params.terminalId);
    return {};
  }

  private assertActiveSession(sessionId: unknown): asserts sessionId is string {
    if (!this.sessionId || sessionId !== this.sessionId) throw new Error("ACP request is not for the active session");
  }
}

function isRuntimeStateUpdate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.sessionUpdate === "available_commands_update" ||
    value.sessionUpdate === "current_mode_update" ||
    value.sessionUpdate === "config_option_update" ||
    value.sessionUpdate === "usage_update" ||
    value.sessionUpdate === "session_info_update";
}

export function isAgentAuthRequiredError(value: unknown): value is RpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as RpcError).code === -32000 &&
    (value as RpcError).transportFailure !== true
  );
}

function runtimeCapabilities(negotiation: AcpNegotiation): AcpRuntimeCapabilities {
  return {
    logout: negotiation.stable.logout,
    loadSession: negotiation.stable.loadSession,
    sessionList: negotiation.stable.sessionList,
    sessionDelete: negotiation.stable.sessionDelete,
    sessionResume: negotiation.stable.sessionResume,
    sessionClose: negotiation.stable.sessionClose,
  };
}

function blockText(content: ContentBlock | undefined): string {
  if (!content) return "";
  if (content.type === "text" && typeof content.text === "string") return content.text;
  return "";
}

function toolText(content: ToolCallContent[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (c.type === "content") return blockText(c.content);
      if (c.type === "diff") return `edit ${c.path}`;
      if (c.type === "terminal") return "[terminal]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function utf8Chunks(text: string, maxBytes: number): string[] {
  const bytes = Buffer.from(text, "utf8");
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + maxBytes);
    while (end < bytes.length && end > start && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    if (end === start) end = Math.min(bytes.length, start + maxBytes);
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return chunks;
}

export function terminalOutputDelta(
  previousCursor: number | undefined,
  snapshot: Pick<TerminalOutputResponse, "output" | "truncated"> & { cursor: number },
): string | null {
  if (previousCursor !== undefined && snapshot.cursor <= previousCursor) return null;
  if (previousCursor === undefined) {
    return `${snapshot.truncated ? "[terminal output truncated]\n" : ""}${snapshot.output}`;
  }
  const current = Buffer.from(snapshot.output, "utf8");
  const newBytes = snapshot.cursor - previousCursor;
  if (newBytes >= current.length) {
    return `${snapshot.truncated ? "[terminal output truncated]\n" : ""}${snapshot.output}`;
  }
  let start = Math.max(0, current.length - newBytes);
  while (start < current.length && (current[start]! & 0xc0) === 0x80) start += 1;
  return current.subarray(start).toString("utf8");
}

function renderDiff(item: Extract<ToolCallContent, { type: "diff" }>): string {
  const path = item.path ?? "file";
  const oldText = item.oldText ?? "";
  const newText = item.newText ?? "";
  const minus = oldText
    ? oldText.split("\n").map((l) => `-${l}`).join("\n") + "\n"
    : "";
  const plus = newText.split("\n").map((l) => `+${l}`).join("\n");
  return `--- a/${path}\n+++ b/${path}\n${minus}${plus}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
