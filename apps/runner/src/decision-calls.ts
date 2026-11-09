import type {
  AgentDefinition,
  DecisionErrorClass,
  RunDecisionMessage,
  RunDecisionResultMessage,
  SessionNamingRunnerFailurePhase,
} from "@wollipog/protocol";
import {
  DECISION_ATTEMPT_BUDGET_MS,
  DECISION_CLEANUP_BUDGET_MS,
  DECISION_INPUT_MAX_CHARS,
  DECISION_OUTPUT_MAX_BYTES,
  DECISION_PREPARATION_BUDGET_MS,
  DECISION_SCHEMA_MAX_CHARS,
  claudeModelDependsOnPlanMode,
  decisionAgentFailureClass,
} from "@wollipog/protocol";
import { CLAUDE_TOOLLESS_CALL_PERMISSION_MODE } from "./discovery/claude-code.js";
import { JsonRpcPeer } from "./jsonrpc.js";
import {
  codexSessionNamingArgs,
  prepareNeutralDirectory,
  sessionNamingAccountForAgent,
  type NeutralDirectory,
  type SessionNamingAccount,
} from "./session-naming.js";
import { killTree, spawnAgent, type AgentProcess, type SpawnAgentOptions, type SpawnIsolation } from "./spawn.js";

const MIN_TIMEOUT_MS = 250;
const INSTRUCTIONS_MAX_CHARS = 8_000;
/** A typed-question call (#4283) carries one schema entry per question and item. */
const SCHEMA_MAX_CHARS = DECISION_SCHEMA_MAX_CHARS;
/** Claude's JSON envelope carries usage and metadata around the structured output. */
const CLAUDE_ENVELOPE_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_RATE_LIMIT = 30;
const DEFAULT_RATE_WINDOW_MS = 60_000;

/** One attempt's raw provider answer before the control plane validates it. */
export interface DecisionGeneration {
  outputText: string;
  model?: string;
  usage?: RunDecisionResultMessage["usage"];
}

export class DecisionCallFailure extends Error {
  override readonly name = "DecisionCallFailure";
  constructor(
    readonly errorClass: DecisionErrorClass,
    readonly phase: SessionNamingRunnerFailurePhase,
    readonly usage?: RunDecisionResultMessage["usage"],
    readonly retryAfterMs?: number,
  ) {
    super(errorClass);
  }
}

/** Claude Code with the naming lockdown plus an enforced schema: no tools, no MCP servers, no
 * settings, no persistence, a permission mode that refuses everything, and the kind's fixed
 * instructions as the system prompt. The untrusted input arrives only on stdin. */
export function claudeDecisionArgs(
  baseArgs: readonly string[],
  target: RunDecisionMessage["target"],
  instructions: string,
  outputSchema: Record<string, unknown>,
): string[] {
  return [
    ...baseArgs,
    "--model", target.model,
    "--effort", target.effort,
    "-p",
    "--output-format", "json",
    "--permission-mode", CLAUDE_TOOLLESS_CALL_PERMISSION_MODE,
    "--tools", "",
    "--safe-mode",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "",
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome",
    "--system-prompt", instructions,
    "--json-schema", JSON.stringify(outputSchema),
  ];
}

export function codexDecisionThreadParams(cwd: string, instructions: string): Record<string, unknown> {
  return {
    cwd,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    developerInstructions: instructions,
  };
}

export function codexDecisionTurnParams(
  threadId: string,
  cwd: string,
  input: string,
  target: RunDecisionMessage["target"],
  outputSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    threadId,
    cwd,
    input: [{ type: "text", text: input }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    outputSchema,
    model: target.model,
    effort: target.effort,
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/** Classify a provider HTTP status. Unknown statuses are not guessed transient or permanent here;
 * they fall through to the caller's default. */
export function decisionErrorClassForStatus(status: unknown): DecisionErrorClass | null {
  if (typeof status !== "number" || !Number.isFinite(status)) return null;
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "authentication";
  if (status === 404) return "model_unavailable";
  if (status === 408) return "timed_out";
  if (status >= 500) return "provider_overloaded";
  if (status >= 400) return "refused";
  return null;
}

/** Usage from Claude's result envelope. `input_tokens` already excludes both cache buckets. */
function claudeUsage(envelope: Record<string, unknown>): RunDecisionResultMessage["usage"] | undefined {
  const usage = envelope.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;
  return {
    inputTokens: count(value.input_tokens),
    outputTokens: count(value.output_tokens),
    cacheReadInputTokens: count(value.cache_read_input_tokens),
    cacheCreationInputTokens: count(value.cache_creation_input_tokens),
  };
}

function claudeModel(envelope: Record<string, unknown>): string | undefined {
  const modelUsage = envelope.modelUsage;
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  const [model] = Object.keys(modelUsage);
  return model && model.length <= 200 ? model : undefined;
}

/** Read Claude's single JSON result envelope. Only `structured_output` is ever used as the answer;
 * the free-text `result` is never parsed as a fallback. */
export function interpretClaudeDecisionEnvelope(stdout: string, exitCode: number | null): DecisionGeneration {
  let envelope: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    envelope = parsed as Record<string, unknown>;
  } catch {
    throw new DecisionCallFailure(exitCode === 0 ? "invalid_output" : "transport", "generation");
  }
  const usage = claudeUsage(envelope);
  const model = claudeModel(envelope);
  if (envelope.stop_reason === "refusal") throw new DecisionCallFailure("refused", "generation", usage);
  if (envelope.is_error === true || envelope.subtype !== "success") {
    throw new DecisionCallFailure(
      decisionErrorClassForStatus(envelope.api_error_status) ?? "provider_failed",
      "generation",
      usage,
    );
  }
  if (envelope.structured_output === undefined || envelope.structured_output === null) {
    throw new DecisionCallFailure("invalid_output", "output_validation", usage);
  }
  const outputText = JSON.stringify(envelope.structured_output);
  if (Buffer.byteLength(outputText, "utf8") > DECISION_OUTPUT_MAX_BYTES) {
    throw new DecisionCallFailure("invalid_output", "output_validation", usage);
  }
  return { outputText, ...(model ? { model } : {}), ...(usage ? { usage } : {}) };
}

function claudeEnvironment(env: Record<string, string>): Record<string, string> {
  const result = { ...env };
  if (result.CLAUDE_CODE_OAUTH_TOKEN) delete result.ANTHROPIC_API_KEY;
  return result;
}

function generateClaudeDecision(
  agent: AgentDefinition,
  message: RunDecisionMessage,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  isolation: SpawnIsolation | undefined,
  spawn: (options: SpawnAgentOptions) => AgentProcess,
): Promise<DecisionGeneration> {
  return new Promise((resolve, reject) => {
    let child: AgentProcess;
    try {
      child = spawn({
        command: agent.command,
        args: claudeDecisionArgs(agent.args, message.target, message.instructions, message.outputSchema),
        cwd,
        env: claudeEnvironment(env),
        context: agent.context,
        scrubInheritedEnv: ["ANTHROPIC_API_KEY"],
        isolation,
      });
    } catch {
      reject(new DecisionCallFailure("configuration", "initialization"));
      return;
    }
    let output = "";
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      work();
    };
    const timer = setTimeout(() => finish(() => {
      killTree(child);
      reject(new DecisionCallFailure("timed_out", "generation"));
    }), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > CLAUDE_ENVELOPE_MAX_BYTES) {
        finish(() => {
          killTree(child);
          reject(new DecisionCallFailure("invalid_output", "output_validation"));
        });
      }
    });
    child.stderr.resume();
    child.once("error", () => finish(() => reject(new DecisionCallFailure("transport", "generation"))));
    child.once("close", (code) => finish(() => {
      try {
        resolve(interpretClaudeDecisionEnvelope(output, code));
      } catch (error) {
        reject(error);
      }
    }));
    child.stdin.once("error", () => finish(() => reject(new DecisionCallFailure("transport", "initialization"))));
    child.stdin.end(message.input);
  });
}

/** Codex App Server error classification from its typed `codexErrorInfo`. */
export function codexDecisionErrorClass(info: unknown): DecisionErrorClass {
  if (typeof info === "string") {
    switch (info) {
      case "unauthorized": return "authentication";
      case "usageLimitExceeded": return "rate_limited";
      case "internalServerError":
      case "serverOverloaded": return "provider_overloaded";
      case "badRequest":
      case "contextWindowExceeded": return "configuration";
      default: return "provider_failed";
    }
  }
  if (info && typeof info === "object") {
    const [variant, detail] = Object.entries(info as Record<string, unknown>)[0] ?? [];
    const status = (detail as { httpStatusCode?: unknown } | null | undefined)?.httpStatusCode;
    const byStatus = decisionErrorClassForStatus(status);
    if (byStatus) return byStatus;
    if (variant === "httpConnectionFailed" || variant?.startsWith("responseStream")) return "transport";
  }
  return "provider_failed";
}

async function generateCodexDecision(
  agent: AgentDefinition,
  message: RunDecisionMessage,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  isolation: SpawnIsolation | undefined,
  spawn: (options: SpawnAgentOptions) => AgentProcess,
): Promise<DecisionGeneration> {
  let child: AgentProcess;
  try {
    child = spawn({
      command: agent.command,
      args: codexSessionNamingArgs(agent.args),
      cwd,
      env,
      context: agent.context,
      scrubInheritedEnv: ["OPENAI_API_KEY"],
      isolation,
    });
  } catch {
    throw new DecisionCallFailure("configuration", "initialization");
  }
  child.stderr.resume();
  let output = "";
  let sawDelta = false;
  let usage: RunDecisionResultMessage["usage"] | undefined;
  let answeredBy = message.target.model;
  let lastError: DecisionErrorClass | null = null;
  let settleTurn!: (value: void | PromiseLike<void>) => void;
  let rejectTurn!: (reason?: unknown) => void;
  const turn = new Promise<void>((resolve, reject) => { settleTurn = resolve; rejectTurn = reject; });
  void turn.catch(() => {});
  let phase: SessionNamingRunnerFailurePhase = "initialization";
  const fail = (errorClass: DecisionErrorClass) => rejectTurn(new DecisionCallFailure(errorClass, phase, usage));
  const peer = new JsonRpcPeer(child.stdin, child.stdout, () => fail("transport"), DECISION_OUTPUT_MAX_BYTES * 4);
  const append = (value: unknown) => {
    if (typeof value !== "string") return;
    output += value;
    if (Buffer.byteLength(output, "utf8") > DECISION_OUTPUT_MAX_BYTES) fail("invalid_output");
  };
  peer.onNotification("item/agentMessage/delta", (params: unknown) => {
    const delta = (params as { delta?: unknown } | null)?.delta;
    if (typeof delta === "string") {
      sawDelta = true;
      append(delta);
    }
  });
  peer.onNotification("item/completed", (params: unknown) => {
    const item = (params as { item?: { type?: unknown; text?: unknown } } | null)?.item;
    if (!sawDelta && item?.type === "agentMessage") append(item.text);
  });
  // A no-tool call that starts anything but a message or reasoning is not a usable answer.
  peer.onNotification("item/started", (params: unknown) => {
    const type = (params as { item?: { type?: unknown } } | null)?.item?.type;
    if (type !== "userMessage" && type !== "agentMessage" && type !== "reasoning") fail("invalid_output");
  });
  peer.onNotification("thread/tokenUsage/updated", (params: unknown) => {
    const last = (params as { tokenUsage?: { last?: Record<string, unknown> } } | null)?.tokenUsage?.last;
    if (!last) return;
    const cached = count(last.cachedInputTokens);
    usage = {
      inputTokens: Math.max(0, count(last.inputTokens) - cached),
      outputTokens: count(last.outputTokens),
      cacheReadInputTokens: cached,
      cacheCreationInputTokens: 0,
    };
  });
  // Codex answers on the model the turn names unless it says it rerouted the turn.
  peer.onNotification("model/rerouted", (params: unknown) => {
    const toModel = (params as { toModel?: unknown } | null)?.toModel;
    if (typeof toModel === "string" && toModel && toModel.length <= 200) answeredBy = toModel;
  });
  peer.onNotification("error", (params: unknown) => {
    const value = params as { error?: { codexErrorInfo?: unknown }; willRetry?: unknown } | null;
    if (value?.willRetry === true) return;
    lastError = codexDecisionErrorClass(value?.error?.codexErrorInfo);
  });
  peer.onNotification("turn/completed", (params: unknown) => {
    const status = (params as { turn?: { status?: unknown } } | null)?.turn?.status;
    if (status === "completed") settleTurn();
    else fail(lastError ?? "provider_failed");
  });
  peer.onNotification("turn/failed", () => fail(lastError ?? "provider_failed"));
  for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]) {
    peer.onRequest(method, () => ({ decision: "decline" }));
  }
  peer.onRequest("item/permissions/requestApproval", () => ({ permissions: {}, scope: "turn" }));
  peer.onRequest("item/tool/requestUserInput", () => ({ answers: {} }));
  peer.onRequest("mcpServer/elicitation/request", () => ({ action: "cancel" }));
  child.once("error", () => fail("transport"));
  child.once("close", () => fail(lastError ?? "transport"));
  const timer = setTimeout(() => fail("timed_out"), timeoutMs);
  try {
    const deadline = Date.now() + timeoutMs;
    await peer.requestWithDeadline("initialize", { clientInfo: { name: "wollipog-decision", version: "1" } }, deadline);
    peer.notify("initialized", {});
    phase = "thread_start";
    const started = await peer.requestWithDeadline<{ thread?: { id?: unknown } }>(
      "thread/start",
      codexDecisionThreadParams(cwd, message.instructions),
      deadline,
    );
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string" || !threadId) throw new DecisionCallFailure("provider_failed", "thread_start");
    phase = "turn_start";
    await peer.requestWithDeadline(
      "turn/start",
      codexDecisionTurnParams(threadId, cwd, message.input, message.target, message.outputSchema),
      deadline,
    );
    phase = "generation";
    await turn;
    if (!output.trim()) throw new DecisionCallFailure("invalid_output", "output_validation", usage);
    return { outputText: output, model: answeredBy, ...(usage ? { usage } : {}) };
  } catch (error) {
    if (error instanceof DecisionCallFailure) throw error;
    const rpc = error as { requestTimeout?: boolean } | null;
    throw new DecisionCallFailure(rpc?.requestTimeout ? "timed_out" : lastError ?? "provider_failed", phase, usage);
  } finally {
    clearTimeout(timer);
    peer.dispose("decision call complete");
    killTree(child);
  }
}

function validMessage(message: RunDecisionMessage): boolean {
  return typeof message.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 200 &&
    typeof message.occurrenceId === "string" && message.occurrenceId.length > 0 && message.occurrenceId.length <= 200 &&
    Number.isSafeInteger(message.attempt) && message.attempt > 0 &&
    typeof message.instructions === "string" && message.instructions.length > 0 &&
    message.instructions.length <= INSTRUCTIONS_MAX_CHARS &&
    typeof message.input === "string" && message.input.length > 0 && message.input.length <= DECISION_INPUT_MAX_CHARS &&
    Boolean(message.outputSchema) && typeof message.outputSchema === "object" && !Array.isArray(message.outputSchema) &&
    JSON.stringify(message.outputSchema).length <= SCHEMA_MAX_CHARS &&
    Boolean(message.target) && typeof message.target.model === "string" && typeof message.target.effort === "string";
}

function targetFailureClass(target: RunDecisionMessage["target"], agent: AgentDefinition): DecisionErrorClass | null {
  if (target.agentId !== agent.id || target.driver !== (agent.driver ?? "acp")) return "harness_unavailable";
  const capabilities = agent.capabilities;
  const model = capabilities?.models.find((candidate) =>
    candidate.id === target.model && candidate.id !== "default" && !candidate.hidden &&
    !claudeModelDependsOnPlanMode(target.driver, candidate.id),
  );
  const efforts = model?.efforts?.length ? model.efforts : capabilities?.effortLevels ?? [];
  return model && efforts.includes(target.effort) ? null : "model_unavailable";
}

function validatedTimeout(value: number): number {
  return Number.isFinite(value)
    ? Math.min(DECISION_ATTEMPT_BUDGET_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(value)))
    : DECISION_ATTEMPT_BUDGET_MS;
}

async function withinBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  release: (value: T) => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DecisionCallFailure("timed_out", "isolation")), Math.max(0, budgetMs));
  });
  try {
    return await Promise.race([work, expiry]);
  } catch (error) {
    void work.then((value) => release(value).catch(() => {}), () => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export interface DecisionExecutorOptions {
  maxConcurrent?: number;
  rateLimit?: number;
  rateWindowMs?: number;
  cleanupBudgetMs?: number;
  now?: () => number;
  spawn?: (options: SpawnAgentOptions) => AgentProcess;
  preflight?: (agent: AgentDefinition) => void | Promise<void>;
  prepareDirectory?: (agent: AgentDefinition) => Promise<NeutralDirectory>;
  authorize?: (
    agent: AgentDefinition,
    env: Record<string, string>,
    cwd: string,
  ) => Promise<{ isolation?: SpawnIsolation; cleanup(children?: readonly AgentProcess[]): Promise<void> }>;
  /** Tests replace the provider invocation; the real paths are the Claude and Codex functions above. */
  generate?: (
    account: SessionNamingAccount,
    agent: AgentDefinition,
    message: RunDecisionMessage,
    cwd: string,
    env: Record<string, string>,
    timeoutMs: number,
    isolation: SpawnIsolation | undefined,
  ) => Promise<DecisionGeneration>;
}

/** Runs one Decision attempt in a neutral directory under the provider-HOME boundary naming uses.
 * Retries, schema validation and the verdict belong to the control plane; this only reports what
 * one attempt produced. There is no queue: overload answers `rate_limited` at once. */
export class DecisionExecutor {
  private active = 0;
  private recent: number[] = [];
  private readonly maxConcurrent: number;
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;
  private readonly cleanupBudgetMs: number;
  private readonly now: () => number;
  private readonly spawn: (options: SpawnAgentOptions) => AgentProcess;
  private readonly preflight?: DecisionExecutorOptions["preflight"];
  private readonly prepareDirectory: (agent: AgentDefinition) => Promise<NeutralDirectory>;
  private readonly authorize?: DecisionExecutorOptions["authorize"];
  private readonly generateOverride?: DecisionExecutorOptions["generate"];

  constructor(options: DecisionExecutorOptions = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
    this.rateLimit = Math.max(1, Math.floor(options.rateLimit ?? DEFAULT_RATE_LIMIT));
    this.rateWindowMs = Math.max(1, Math.floor(options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS));
    this.cleanupBudgetMs = Math.max(0, Math.floor(options.cleanupBudgetMs ?? DECISION_CLEANUP_BUDGET_MS));
    this.now = options.now ?? Date.now;
    this.spawn = options.spawn ?? spawnAgent;
    this.preflight = options.preflight;
    this.prepareDirectory = options.prepareDirectory ??
      ((agent) => prepareNeutralDirectory(agent, "wollipog-decision-"));
    this.authorize = options.authorize;
    this.generateOverride = options.generate;
  }

  async execute(
    message: RunDecisionMessage,
    agent: AgentDefinition | undefined,
    env: Record<string, string>,
  ): Promise<RunDecisionResultMessage> {
    const fail = (
      errorClass: DecisionErrorClass,
      phase: SessionNamingRunnerFailurePhase = "preflight",
      extra: Pick<RunDecisionResultMessage, "usage" | "retryAfterMs" | "provider" | "billingSource" | "model"> = {},
    ): RunDecisionResultMessage => ({
      type: "run_decision_result",
      requestId: message.requestId,
      ok: false,
      errorClass,
      phase,
      ...extra,
    });
    if (!validMessage(message)) return fail("configuration");
    if (!agent) return fail("harness_unavailable");
    const agentFailure = decisionAgentFailureClass(agent);
    if (agentFailure) return fail(agentFailure);
    const targetFailure = targetFailureClass(message.target, agent);
    if (targetFailure) return fail(targetFailure);
    const account = sessionNamingAccountForAgent(agent);
    if (!account) return fail("authentication");
    try {
      await this.preflight?.(agent);
    } catch (error) {
      return error instanceof DecisionCallFailure ? fail(error.errorClass, error.phase) : fail("configuration", "isolation");
    }
    const now = this.now();
    this.recent = this.recent.filter((startedAt) => now - startedAt < this.rateWindowMs);
    if (this.active >= this.maxConcurrent || this.recent.length >= this.rateLimit) return fail("rate_limited");
    this.active++;
    this.recent.push(now);
    const accountFields = { provider: account.provider, billingSource: account.billingSource };
    let neutral: NeutralDirectory | undefined;
    let authorization: Awaited<ReturnType<NonNullable<DecisionExecutorOptions["authorize"]>>> | undefined;
    let failurePhase: SessionNamingRunnerFailurePhase = "isolation";
    const children: AgentProcess[] = [];
    const spawn = (options: SpawnAgentOptions): AgentProcess => {
      const child = this.spawn(options);
      children.push(child);
      return child;
    };
    try {
      const totalTimeoutMs = validatedTimeout(message.timeoutMs);
      const startedAt = this.now();
      const deadlineAt = startedAt + totalTimeoutMs;
      const preparationDeadlineAt = startedAt + Math.min(DECISION_PREPARATION_BUDGET_MS, Math.floor(totalTimeoutMs / 3));
      const preparationRemaining = () => preparationDeadlineAt - this.now();
      neutral = await withinBudget(this.prepareDirectory(agent), preparationRemaining(), (directory) => directory.cleanup());
      if (this.authorize) {
        authorization = await withinBudget(
          this.authorize(agent, env, neutral.cwd),
          preparationRemaining(),
          (boundary) => boundary.cleanup(),
        );
      }
      if (preparationRemaining() < 0) throw new DecisionCallFailure("timed_out", "isolation");
      const timeoutMs = Math.max(0, deadlineAt - this.now());
      if (timeoutMs < MIN_TIMEOUT_MS) throw new DecisionCallFailure("timed_out", "isolation");
      failurePhase = "generation";
      const generated = this.generateOverride
        ? await this.generateOverride(account, agent, message, neutral.cwd, env, timeoutMs, authorization?.isolation)
        : account.provider === "claude"
          ? await generateClaudeDecision(agent, message, neutral.cwd, env, timeoutMs, authorization?.isolation, spawn)
          : await generateCodexDecision(agent, message, neutral.cwd, env, timeoutMs, authorization?.isolation, spawn);
      if (!generated.outputText.trim() || Buffer.byteLength(generated.outputText, "utf8") > DECISION_OUTPUT_MAX_BYTES) {
        return fail("invalid_output", "output_validation", {
          ...accountFields,
          ...(generated.usage ? { usage: generated.usage } : {}),
        });
      }
      return {
        type: "run_decision_result",
        requestId: message.requestId,
        ok: true,
        outputText: generated.outputText,
        ...accountFields,
        // Only what the provider reported: a record must never show the target as the answering model.
        ...(generated.model ? { model: generated.model } : {}),
        ...(generated.usage ? { usage: generated.usage } : {}),
      };
    } catch (error) {
      return error instanceof DecisionCallFailure
        ? fail(error.errorClass, error.phase, {
            ...accountFields,
            ...(error.usage ? { usage: error.usage } : {}),
            ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
          })
        : fail("provider_failed", failurePhase, accountFields);
    } finally {
      this.active--;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([
          (async () => authorization?.cleanup(children))(),
          (async () => neutral?.cleanup())(),
        ]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.cleanupBudgetMs); }),
      ]);
      clearTimeout(timer);
    }
  }
}
