import { createHash, randomUUID } from "node:crypto";
import type {
  AgentDefinition,
  AgentContext,
  ConfigureSessionNamingHarnessRequest,
  ConfigureSessionNamingCustomModelRequest,
  GenerateSessionTitleResultMessage,
  SessionNamingAccountBoundary,
  SessionNamingConnectionTestResult,
  SessionNamingCustomModelResultMessage,
  SessionNamingHarnessMachine,
  SessionNamingHarnessTarget,
  SessionNamingMode,
  SessionNamingRunnerErrorCode,
  SessionNamingSettingsView,
} from "@wollipog/protocol";
import { runnerSupportsProtocol, sessionNamingAgentFailureCode } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import {
  isRunnerRequestNotSentError,
  isRunnerRequestTimeoutError,
  type Hub,
} from "./hub.js";
import {
  SessionTitleGenerationError,
  sessionTitleGeneratorFromEnv,
  type SessionTitleGenerator,
  type SessionTitleRequest,
} from "./session-title-generator.js";

type PersistedSessionNamingMode = SessionNamingMode;

const CUSTOM_MODEL_MIN_TIMEOUT_MS = 250;
const CUSTOM_MODEL_MAX_TIMEOUT_MS = 30_000;
const CUSTOM_MODEL_MAX_ENDPOINT_LENGTH = 2_048;
const CUSTOM_MODEL_MAX_MODEL_LENGTH = 200;
const CUSTOM_MODEL_MAX_API_KEY_BYTES = 8 * 1024;

/** A user-selectable mode cannot currently run. Its messages are deliberately safe for clients. */
export class SessionNamingModeUnavailableError extends Error {
  override readonly name = "SessionNamingModeUnavailableError";
}

function publicEndpointOrigin(value: string): string {
  const endpoint = new URL(value);
  return endpoint.origin;
}

function endpointProtectsApiKey(value: string | URL): boolean {
  const endpoint = typeof value === "string" ? new URL(value) : value;
  return endpoint.protocol === "https:" || endpoint.hostname === "localhost" || endpoint.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(endpoint.hostname);
}

export function validateSessionNamingCustomModelInput(input: ConfigureSessionNamingCustomModelRequest): {
  runnerId: string;
  endpoint: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
} {
  if (typeof input.runnerId !== "string" || !input.runnerId || input.runnerId.length > 256) {
    throw new Error("a valid Machine is required");
  }
  if (typeof input.endpoint !== "string" || !input.endpoint.trim() || input.endpoint.length > CUSTOM_MODEL_MAX_ENDPOINT_LENGTH) {
    throw new Error("a valid endpoint is required");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint.trim());
  } catch {
    throw new Error("a valid endpoint is required");
  }
  if ((endpoint.protocol !== "https:" && endpoint.protocol !== "http:") || endpoint.username || endpoint.password ||
      endpoint.hash || endpoint.search) {
    throw new Error("the endpoint must be an HTTP or HTTPS URL without credentials, query parameters, or a fragment");
  }
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model || model.length > CUSTOM_MODEL_MAX_MODEL_LENGTH || /[\0-\x1f\x7f]/u.test(model)) {
    throw new Error("a valid model is required");
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < CUSTOM_MODEL_MIN_TIMEOUT_MS ||
      input.timeoutMs > CUSTOM_MODEL_MAX_TIMEOUT_MS) {
    throw new Error(`timeout must be between ${CUSTOM_MODEL_MIN_TIMEOUT_MS} and ${CUSTOM_MODEL_MAX_TIMEOUT_MS} milliseconds`);
  }
  if (input.apiKey !== undefined && (
    typeof input.apiKey !== "string" || !input.apiKey ||
    Buffer.byteLength(input.apiKey, "utf8") > CUSTOM_MODEL_MAX_API_KEY_BYTES || /[\0\r\n]/u.test(input.apiKey)
  )) {
    throw new Error("the API key is invalid");
  }
  if (input.apiKey !== undefined && !endpointProtectsApiKey(endpoint)) {
    throw new Error("an API key requires HTTPS unless the endpoint is loopback-only");
  }
  return {
    runnerId: input.runnerId,
    endpoint: endpoint.toString(),
    model,
    timeoutMs: input.timeoutMs,
    ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
  };
}

function customModelDigest(value: { endpoint: string; model: string; timeoutMs: number }): string {
  return createHash("sha256").update(`${value.endpoint}\0${value.model}\0${value.timeoutMs}`).digest("hex");
}

export function sanitizeSessionNamingCustomModelResult(
  message: SessionNamingCustomModelResultMessage,
  operation: SessionNamingCustomModelResultMessage["operation"],
): SessionNamingCustomModelResultMessage | null {
  if (message.type !== "session_naming_custom_model_result" || message.operation !== operation ||
      typeof message.requestId !== "string" || !message.requestId) return null;
  if (message.ok !== true) {
    return message.ok === false && [
      "invalid_configuration", "authentication_failed", "endpoint_failed", "timed_out", "rate_limited", "unavailable",
    ].includes(message.code ?? "")
      ? { type: message.type, requestId: message.requestId, operation, ok: false, code: message.code }
      : null;
  }
  const status = message.status;
  if (!status || typeof status.configured !== "boolean" || typeof status.apiKeyConfigured !== "boolean" ||
      (status.configDigest !== undefined && !/^[0-9a-f]{64}$/u.test(status.configDigest))) return null;
  return { type: message.type, requestId: message.requestId, operation, ok: true, status: { ...status } };
}

function accountForAgent(agent: AgentDefinition | undefined): Omit<SessionNamingAccountBoundary, "machineCount"> | null {
  if (!agent || agent.available === false || agent.authStatus !== "authenticated") return null;
  const driver = agent.driver ?? "acp";
  if ((driver === "codex" || driver === "codex-app-server") && agent.codexAppServer?.status === "supported" &&
      agent.codexAppServer.sessionNaming === true) {
    return { provider: "codex", billingSource: agent.codexBillingSource ?? "provider_account" };
  }
  if (driver === "claude-code" && agent.claudeCode?.status === "ready" &&
      agent.claudeCode.sessionNaming === true && agent.claudeCode.auth.status === "authenticated") {
    return { provider: "claude", billingSource: agent.claudeCode.auth.billingSource };
  }
  return null;
}

function harnessModelsForAgent(agent: AgentDefinition): SessionNamingHarnessMachine["harnesses"][number]["models"] {
  if (!accountForAgent(agent)) return [];
  const capabilities = agent.capabilities;
  if (!capabilities) return [];
  return capabilities.models.flatMap((model) => {
    if (model.hidden || model.id === "default") return [];
    const efforts = model.efforts?.length ? model.efforts : capabilities.effortLevels;
    return efforts.length ? [{
      id: model.id,
      displayName: model.displayName ?? model.id,
      efforts: [...new Set(efforts)],
    }] : [];
  });
}

function canonicalHarnessName(agent: AgentDefinition): string {
  const generatedCodexName = /^Codex(?: —)? Interactive$/u.test(agent.name);
  return (agent.driver ?? "acp") === "codex-app-server" &&
    (agent.source === "discovered" || generatedCodexName)
    ? "Codex App Server"
    : agent.name;
}

function harnessContext(agent: AgentDefinition): AgentContext {
  return agent.context ?? { kind: "native" };
}

function validHarnessContext(context: AgentContext): boolean {
  return context.kind === "native" || (
    Boolean(context.distro) && context.distro === context.distro.trim() && context.distro.length <= 256 &&
    !/[\p{Cc}\p{Cf}]/u.test(context.distro)
  );
}

function contextLabel(context: AgentContext): string {
  return context.kind === "wsl" ? `WSL: ${context.distro}` : "Native";
}

function sameContext(left: AgentContext, right: AgentContext): boolean {
  return left.kind === right.kind && (left.kind !== "wsl" || (right.kind === "wsl" && left.distro === right.distro));
}

function namingHarnesses(agents: AgentDefinition[]): SessionNamingHarnessMachine["harnesses"] {
  const candidates = agents.flatMap((agent) => {
    const driver = agent.driver ?? "acp";
    if (driver !== "codex" && driver !== "codex-app-server" && driver !== "claude-code") return [];
    const context = harnessContext(agent);
    if (!validHarnessContext(context)) return [];
    const account = accountForAgent(agent);
    const models = harnessModelsForAgent(agent);
    return account && models.length ? [{
      agentId: agent.id,
      name: canonicalHarnessName(agent),
      driver,
      context,
      provider: account.provider,
      billingSource: account.billingSource,
      models,
    }] : [];
  });
  const nameCounts = new Map<string, number>();
  for (const candidate of candidates) nameCounts.set(candidate.name, (nameCounts.get(candidate.name) ?? 0) + 1);
  const contextual = candidates.map((candidate) => nameCounts.get(candidate.name) === 1
    ? candidate
    : { ...candidate, name: `${candidate.name} (${contextLabel(candidate.context)})` });
  const contextualCounts = new Map<string, number>();
  for (const candidate of contextual) {
    contextualCounts.set(candidate.name, (contextualCounts.get(candidate.name) ?? 0) + 1);
  }
  return contextual.map((candidate) => contextualCounts.get(candidate.name) === 1
    ? candidate
    : { ...candidate, name: `${candidate.name} · ${candidate.agentId}` })
    .sort((left, right) => left.name.localeCompare(right.name) || left.agentId.localeCompare(right.agentId));
}

function unavailableHarnessName(saved: NonNullable<ReturnType<ControlPlaneDb["getSessionNamingHarnessTarget"]>>): string {
  if (!saved.context) return saved.agentId;
  const canonical = saved.driver === "codex-app-server"
    ? "Codex App Server"
    : saved.driver === "claude-code"
      ? "Claude Code"
      : "Codex (Non-Interactive)";
  return `${canonical} (${contextLabel(saved.context)}) · ${saved.agentId}`;
}

function billingSourceLabel(value: SessionNamingAccountBoundary["billingSource"]): string {
  return value === "api"
    ? "API"
    : value.split("_").map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`).join(" ");
}

const SESSION_NAMING_FAILURE_CODES = new Set([
  "session_unavailable", "account_unavailable", "runner_outdated", "harness_unavailable",
  "model_unavailable", "provider_unsupported", "rate_limited",
  "timed_out", "provider_failed", "invalid_result",
]);
const SESSION_NAMING_FAILURE_PHASES = new Set([
  "preflight", "isolation", "initialization", "thread_start", "turn_start", "generation", "output_validation",
]);
const SESSION_NAMING_BILLING_SOURCES = new Set([
  "subscription", "api", "bedrock", "vertex", "gateway", "provider_account", "unknown",
]);

function runnerNamingTransportFailure(error: unknown): SessionTitleGenerationError {
  if (isRunnerRequestTimeoutError(error)) return new SessionTitleGenerationError("timed_out", "generation");
  if (isRunnerRequestNotSentError(error)) return new SessionTitleGenerationError("session_unavailable", "preflight");
  return new SessionTitleGenerationError("provider_failed", "generation");
}

/** Validate and canonicalize the only runner fields allowed across the naming boundary. */
export function sanitizeSessionNamingRunnerResult(
  message: GenerateSessionTitleResultMessage,
): GenerateSessionTitleResultMessage | null {
  if (typeof message.requestId !== "string" || !message.requestId) return null;
  if (message.ok === false) {
    if (typeof message.code !== "string" || !SESSION_NAMING_FAILURE_CODES.has(message.code)) return null;
    if (message.phase !== undefined &&
        (typeof message.phase !== "string" || !SESSION_NAMING_FAILURE_PHASES.has(message.phase))) return null;
    return {
      type: "generate_session_title_result",
      requestId: message.requestId,
      ok: false,
      code: message.code,
      ...(message.phase ? { phase: message.phase } : {}),
    };
  }
  if (message.ok !== true || typeof message.title !== "string" || !message.title || message.title.length > 120 ||
      /[\r\n]/.test(message.title) ||
      (message.provider !== "codex" && message.provider !== "claude" && message.provider !== "custom") ||
      typeof message.billingSource !== "string" || !SESSION_NAMING_BILLING_SOURCES.has(message.billingSource)) return null;
  return {
    type: "generate_session_title_result",
    requestId: message.requestId,
    ok: true,
    title: message.title,
    provider: message.provider,
    billingSource: message.billingSource,
  };
}

/** Runtime bridge for the legacy environment endpoint. Organization choices are durable and take
 * precedence; an organization without a saved choice inherits the old environment behavior. */
export class SessionNamingSettings {
  private readonly environment: ReturnType<typeof sessionTitleGeneratorFromEnv>;

  constructor(
    private readonly db: ControlPlaneDb,
    env: NodeJS.ProcessEnv = process.env,
    private readonly hub?: Pick<Hub, "requestFromRunner"> & Partial<Pick<Hub, "cancelRunnerRequest">>,
  ) {
    this.environment = sessionTitleGeneratorFromEnv(env);
  }

  private organizationIdForSession(sessionId: string): string | null {
    return this.db.sessionScope(sessionId)?.organizationId ?? null;
  }

  private selectedMode(organizationId: string): {
    mode: PersistedSessionNamingMode;
    source: SessionNamingSettingsView["source"];
  } {
    const preference = this.db.getSessionNamingPreference(organizationId);
    if (preference) return { mode: preference.mode, source: "organization" };
    return this.environment.generator
      ? { mode: "custom_model_endpoint", source: "environment" }
      : { mode: "prompt_text_only", source: "default" };
  }

  private accountBoundaries(organizationId: string): SessionNamingAccountBoundary[] {
    const machines = new Map<string, Set<string>>();
    for (const runner of this.db.listRunners()) {
      if (runner.status !== "online" || !runnerSupportsProtocol(runner.protocolVersion, "sessionAgentNaming") ||
          this.db.runnerScope(runner.runnerId)?.organizationId !== organizationId) continue;
      for (const agent of runner.agents) {
        const account = accountForAgent(agent);
        if (!account) continue;
        const key = `${account.provider}:${account.billingSource}`;
        const runnerIds = machines.get(key) ?? new Set<string>();
        runnerIds.add(runner.runnerId);
        machines.set(key, runnerIds);
      }
    }
    return [...machines].map(([key, runnerIds]) => {
      const [provider, billingSource] = key.split(":") as [SessionNamingAccountBoundary["provider"], SessionNamingAccountBoundary["billingSource"]];
      return { provider, billingSource, machineCount: runnerIds.size };
    }).sort((left, right) => left.provider.localeCompare(right.provider) || left.billingSource.localeCompare(right.billingSource));
  }

  private harnessMachines(organizationId: string): SessionNamingHarnessMachine[] {
    if (!this.hub) return [];
    return this.db.listRunners().flatMap((runner) => {
      if (runner.status !== "online" || !runnerSupportsProtocol(runner.protocolVersion, "sessionNamingTargets") ||
          this.db.runnerScope(runner.runnerId)?.organizationId !== organizationId) return [];
      const harnesses = namingHarnesses(runner.agents);
      return harnesses.length ? [{
        runnerId: runner.runnerId,
        machineName: runner.displayName ?? runner.hostname ?? runner.runnerId,
        harnesses,
      }] : [];
    }).sort((left, right) => left.machineName.localeCompare(right.machineName));
  }

  private harnessTarget(organizationId: string): {
    view: SessionNamingHarnessTarget;
    runner?: NonNullable<ReturnType<ControlPlaneDb["getRunner"]>>;
    agent?: AgentDefinition;
    account?: Omit<SessionNamingAccountBoundary, "machineCount">;
    failureCode?: SessionNamingRunnerErrorCode;
  } | null {
    const saved = this.db.getSessionNamingHarnessTarget?.(organizationId) ?? null;
    if (!saved) return null;
    const runner = this.db.getRunner(saved.runnerId);
    const runnerInOrganization = runner &&
      this.db.runnerScope(runner.runnerId)?.organizationId === organizationId
      ? runner
      : undefined;
    const machineName = runnerInOrganization?.displayName ?? runnerInOrganization?.hostname ?? saved.runnerId;
    const agent = runnerInOrganization?.agents.find((candidate) => candidate.id === saved.agentId &&
      (candidate.driver ?? "acp") === saved.driver);
    const harness = runnerInOrganization
      ? namingHarnesses(runnerInOrganization.agents).find((candidate) =>
          candidate.agentId === saved.agentId && candidate.driver === saved.driver)
      : undefined;
    const model = agent?.capabilities?.models.find((candidate) => candidate.id === saved.model);
    const efforts = model?.efforts?.length ? model.efforts : agent?.capabilities?.effortLevels ?? [];
    const account = accountForAgent(agent);
    const agentFailureCode = sessionNamingAgentFailureCode(agent);
    const reason = !runnerInOrganization
      ? "The selected Machine is no longer available."
      : runnerInOrganization.status !== "online"
        ? "The selected Machine is offline."
        : !runnerSupportsProtocol(runnerInOrganization.protocolVersion, "sessionNamingTargets")
          ? "Update the selected Machine runner to use an explicit naming target."
          : !agent
            ? "The selected Agent Harness is no longer advertised."
            : !account
              ? agentFailureCode === "harness_unavailable"
                ? "The selected Agent Harness is unavailable or no longer supports session naming."
                : "The selected Agent Harness is no longer authenticated."
              : !saved.provider || !saved.billingSource
                ? "Review and save the selected Agent Harness to confirm its provider and billing source."
                : account.provider !== saved.provider
                  ? "The selected Agent Harness now advertises a different provider. Review and save it to confirm the change."
                  : account.billingSource !== saved.billingSource
                    ? `The selected Agent Harness billing source changed from ${billingSourceLabel(saved.billingSource)} to ${billingSourceLabel(account.billingSource)}. Review and save it to confirm the change.`
                    : saved.context && !sameContext(saved.context, harnessContext(agent))
                      ? "The selected Agent Harness execution context changed. Review and save it to confirm the change."
                      : !model || model.hidden || model.id === "default"
                        ? "The selected model is no longer advertised."
                        : !efforts.includes(saved.effort)
                          ? "The selected reasoning effort is no longer supported by that model."
                          : !this.hub
                            ? "Runner requests are unavailable."
                          : undefined;
    const failureCode: SessionNamingRunnerErrorCode | undefined = reason === undefined
      ? undefined
      : !runnerInOrganization || runnerInOrganization.status !== "online" || !this.hub
        ? "session_unavailable"
        : !runnerSupportsProtocol(runnerInOrganization.protocolVersion, "sessionNamingTargets")
          ? "runner_outdated"
          : !agent
            ? "harness_unavailable"
            : !account
              ? agentFailureCode ?? "account_unavailable"
              : !saved.provider || !saved.billingSource
                ? "harness_unavailable"
                : account.provider !== saved.provider || account.billingSource !== saved.billingSource
                  ? "account_unavailable"
                  : saved.context && !sameContext(saved.context, harnessContext(agent))
                    ? "harness_unavailable"
                    : !model || model.hidden || model.id === "default" || !efforts.includes(saved.effort)
                      ? "model_unavailable"
                      : "provider_unsupported";
    return {
      view: {
        runnerId: saved.runnerId,
        machineName,
        agentId: saved.agentId,
        harnessName: harness?.name ?? unavailableHarnessName(saved),
        driver: saved.driver,
        ...(saved.context ? { context: saved.context } : {}),
        ...(saved.provider ? { provider: saved.provider } : {}),
        ...(saved.billingSource ? { billingSource: saved.billingSource } : {}),
        model: saved.model,
        modelName: model?.displayName ?? saved.model,
        effort: saved.effort,
        available: reason === undefined,
        ...(reason ? { reason } : {}),
      },
      ...(reason === undefined && runnerInOrganization && agent && account
        ? { runner: runnerInOrganization, agent, account }
        : {}),
      ...(failureCode ? { failureCode } : {}),
    };
  }

  private customModelTargets(organizationId: string): NonNullable<SessionNamingSettingsView["customModelTargets"]> {
    const selected = this.db.getSessionNamingCustomModel(organizationId);
    return this.db.listRunners()
      .filter((runner) => this.db.runnerScope(runner.runnerId)?.organizationId === organizationId)
      .map((runner) => {
        const current = runnerSupportsProtocol(runner.protocolVersion, "sessionCustomModelNaming");
        const online = runner.status === "online";
        return {
          runnerId: runner.runnerId,
          machineName: runner.displayName ?? runner.hostname ?? runner.runnerId,
          online,
          available: online && current && Boolean(this.hub),
          configured: selected?.runnerId === runner.runnerId,
          ...(!online
            ? { reason: "This Machine is offline." }
            : !current
              ? { reason: "Update this Machine runner to configure a custom naming endpoint." }
              : !this.hub
                ? { reason: "Runner requests are unavailable." }
                : {}),
        };
      })
      .sort((left, right) => left.machineName.localeCompare(right.machineName));
  }

  private runnerCustomModel(organizationId: string): {
    config: NonNullable<ReturnType<ControlPlaneDb["getSessionNamingCustomModel"]>>;
    runner: NonNullable<ReturnType<ControlPlaneDb["getRunner"]>>;
  } | null {
    const config = this.db.getSessionNamingCustomModel(organizationId);
    if (!config || !config.runnerConfigured) return null;
    const runner = this.db.getRunner(config.runnerId);
    if (!runner || runner.status !== "online" ||
        !runnerSupportsProtocol(runner.protocolVersion, "sessionCustomModelNaming") || !this.hub) return null;
    return { config, runner };
  }

  private customModelAvailable(organizationId: string): boolean {
    const saved = this.db.getSessionNamingCustomModel(organizationId);
    if (saved) return this.runnerCustomModel(organizationId) !== null;
    return Boolean(this.environment.generator && this.environment.customModel);
  }

  private effectiveMode(organizationId: string): PersistedSessionNamingMode {
    const selected = this.selectedMode(organizationId);
    if (selected.mode === "custom_model_endpoint" && this.customModelAvailable(organizationId)) {
      return "custom_model_endpoint";
    }
    if (selected.mode === "session_agent_account" && this.hub) {
      const explicit = this.harnessTarget(organizationId);
      if (explicit ? explicit.view.available : this.accountBoundaries(organizationId).length > 0) {
        return "session_agent_account";
      }
    }
    return "prompt_text_only";
  }

  view(organizationId: string, canManage: boolean): SessionNamingSettingsView {
    const selected = this.selectedMode(organizationId);
    const savedCustom = this.db.getSessionNamingCustomModel(organizationId);
    const runnerCustom = this.runnerCustomModel(organizationId);
    const customAvailable = this.customModelAvailable(organizationId);
    const customModelTargets = this.customModelTargets(organizationId);
    const sessionAgentAccounts = this.hub ? this.accountBoundaries(organizationId) : [];
    const harnessMachines = this.harnessMachines(organizationId);
    const harnessTarget = this.harnessTarget(organizationId);
    const effectiveMode = selected.mode === "custom_model_endpoint" && customAvailable
      ? "custom_model_endpoint"
      : selected.mode === "session_agent_account" && (harnessTarget?.view.available ||
          (!harnessTarget && sessionAgentAccounts.length))
        ? "session_agent_account"
        : "prompt_text_only";
    return {
      mode: selected.mode,
      effectiveMode,
      source: selected.source,
      canManage,
      modes: {
        prompt_text_only: { available: true },
        session_agent_account: {
          available: harnessMachines.length > 0 || (!harnessTarget && sessionAgentAccounts.length > 0),
          ...(harnessMachines.length || (!harnessTarget && sessionAgentAccounts.length) ? {} : {
            reason: harnessTarget?.view.reason ??
              "No online current runner advertises an authenticated naming-compatible Agent Harness, model, and effort.",
          }),
        },
        custom_model_endpoint: customAvailable
          ? { available: true }
          : {
              available: false,
              reason: savedCustom
                ? "The selected Machine is offline, outdated, or no longer has the matching endpoint configuration."
                : "Configure a runner-local custom endpoint or the legacy control-plane environment first.",
            },
      },
      ...(savedCustom ? {
        customModel: {
          endpointOrigin: publicEndpointOrigin(savedCustom.endpoint),
          model: savedCustom.model,
          apiKeyConfigured: savedCustom.apiKeyConfigured,
          timeoutMs: savedCustom.timeoutMs,
          configurationSource: "runner" as const,
          runnerId: savedCustom.runnerId,
          machineName: this.db.getRunner(savedCustom.runnerId)?.displayName ??
            this.db.getRunner(savedCustom.runnerId)?.hostname ?? savedCustom.runnerId,
          online: runnerCustom !== null,
        },
      } : this.environment.customModel ? {
        customModel: {
          endpointOrigin: publicEndpointOrigin(this.environment.customModel.endpoint),
          model: this.environment.customModel.model,
          apiKeyConfigured: this.environment.customModel.apiKeyConfigured,
          timeoutMs: this.environment.timeoutMs,
          configurationSource: "environment" as const,
        },
      } : {}),
      ...(customModelTargets.length ? { customModelTargets } : {}),
      ...(sessionAgentAccounts.length ? { sessionAgentAccounts } : {}),
      ...(harnessTarget ? { harnessTarget: harnessTarget.view } : {}),
      ...(harnessMachines.length ? { harnessMachines } : {}),
    };
  }

  setMode(organizationId: string, mode: SessionNamingMode, now = Date.now()): SessionNamingSettingsView {
    const explicitTarget = this.harnessTarget(organizationId);
    if (mode === "session_agent_account" && (!this.hub || (explicitTarget
      ? !explicitTarget.view.available
      : this.accountBoundaries(organizationId).length === 0))) {
      throw new SessionNamingModeUnavailableError("no eligible authenticated runner agent account is currently available");
    }
    if (mode === "custom_model_endpoint" && !this.customModelAvailable(organizationId)) {
      throw new SessionNamingModeUnavailableError("an available runner-local or legacy environment custom model must be configured");
    }
    const previousRevision = this.db.getSessionNamingPreference(organizationId)?.updatedAt ?? 0;
    this.db.setSessionNamingPreference(organizationId, mode, Math.max(now, previousRevision + 1));
    return this.view(organizationId, true);
  }

  configureHarness(
    organizationId: string,
    input: ConfigureSessionNamingHarnessRequest,
    now = Date.now(),
  ): SessionNamingSettingsView {
    if (!input || typeof input.runnerId !== "string" || typeof input.agentId !== "string" ||
        (input.driver !== "codex" && input.driver !== "codex-app-server" && input.driver !== "claude-code") ||
        typeof input.model !== "string" || typeof input.effort !== "string" ||
        !input.runnerId || !input.agentId || !input.model || !input.effort ||
        [input.runnerId, input.agentId, input.model, input.effort].some((value) => value.length > 256)) {
      throw new Error("a complete valid Agent Harness target is required");
    }
    const machine = this.harnessMachines(organizationId).find((candidate) => candidate.runnerId === input.runnerId);
    const harness = machine?.harnesses.find((candidate) => candidate.agentId === input.agentId &&
      candidate.driver === input.driver);
    const model = harness?.models.find((candidate) => candidate.id === input.model);
    if (!machine || !harness || !model || !model.efforts.includes(input.effort)) {
      throw new SessionNamingModeUnavailableError(
        "the selected Machine, Agent Harness, model, or reasoning effort is no longer available",
      );
    }
    this.db.configureSessionNamingHarnessTarget(organizationId, {
      ...input,
      context: harness.context ?? { kind: "native" },
      provider: harness.provider,
      billingSource: harness.billingSource,
    }, now);
    return this.view(organizationId, true);
  }

  enabledForSession = (sessionId: string): boolean => {
    const organizationId = this.organizationIdForSession(sessionId);
    if (!organizationId) return false;
    const mode = this.effectiveMode(organizationId);
    if (mode === "custom_model_endpoint") return true;
    const selected = this.selectedMode(organizationId);
    if (selected.mode !== "session_agent_account") return false;
    const explicit = this.harnessTarget(organizationId);
    return explicit !== null || (mode === "session_agent_account" && this.sessionAgentTarget(sessionId) !== null);
  };

  timeoutForSession = (sessionId: string): number => {
    const organizationId = this.organizationIdForSession(sessionId);
    if (!organizationId || this.effectiveMode(organizationId) !== "custom_model_endpoint") return 5_000;
    return this.db.getSessionNamingCustomModel(organizationId)?.timeoutMs ?? this.environment.timeoutMs;
  };

  revisionForSession = (sessionId: string): string => {
    const organizationId = this.organizationIdForSession(sessionId);
    if (!organizationId) return "unowned";
    const preference = this.db.getSessionNamingPreference(organizationId);
    const selected = preference ? `${preference.mode}:${preference.updatedAt}` : `inherited:${this.selectedMode(organizationId).mode}`;
    if (this.effectiveMode(organizationId) === "custom_model_endpoint") {
      const custom = this.db.getSessionNamingCustomModel(organizationId);
      return custom
        ? `${selected}:${custom.runnerId}:${custom.updatedAt}:${custom.runnerConfigured}:${custom.apiKeyConfigured}`
        : selected;
    }
    if (this.effectiveMode(organizationId) !== "session_agent_account") return selected;
    const explicit = this.harnessTarget(organizationId);
    if (explicit) {
      const target = explicit.view;
      return `${selected}:${target.runnerId}:${target.agentId}:${target.driver}:${target.model}:${target.effort}:${target.available}`;
    }
    const target = this.sessionAgentTarget(sessionId);
    return target
      ? `${selected}:${target.runner.runnerId}:${target.runner.protocolVersion}:${target.agent.id}:${target.agent.authStatus}:${target.agent.available}`
      : `${selected}:no-session-account`;
  };

  private manageableCustomRunner(organizationId: string, runnerId: string) {
    const runner = this.db.getRunner(runnerId);
    if (!runner || this.db.runnerScope(runnerId)?.organizationId !== organizationId) {
      throw new SessionNamingModeUnavailableError("the selected Machine is unavailable");
    }
    if (runner.status !== "online" || !runnerSupportsProtocol(runner.protocolVersion, "sessionCustomModelNaming") || !this.hub) {
      throw new SessionNamingModeUnavailableError("the selected Machine must be online and running a current runner");
    }
    return runner;
  }

  async configureCustomModel(
    organizationId: string,
    raw: ConfigureSessionNamingCustomModelRequest,
    now = Date.now(),
    activateMode = true,
  ): Promise<SessionNamingSettingsView> {
    const input = validateSessionNamingCustomModelInput(raw);
    const previous = this.db.getSessionNamingCustomModel(organizationId);
    if (previous && previous.runnerId !== input.runnerId && previous.apiKeyConfigured) {
      throw new SessionNamingModeUnavailableError(
        "delete the API key from the currently selected Machine before selecting another Machine",
      );
    }
    if (previous?.runnerId === input.runnerId && previous.apiKeyConfigured &&
        input.apiKey === undefined && !endpointProtectsApiKey(input.endpoint)) {
      throw new Error("an API key already configured on this Machine requires HTTPS unless the endpoint is loopback-only");
    }
    const runner = this.manageableCustomRunner(organizationId, input.runnerId);
    const stagedAt = Math.max(now, (previous?.updatedAt ?? 0) + 1);
    // Persist only secret-free intent before relaying a key. If delivery becomes ambiguous, the
    // runner's next registration can reconcile this digest instead of leaving an untracked secret.
    this.db.setSessionNamingCustomModel(organizationId, {
      runnerId: runner.runnerId,
      endpoint: input.endpoint,
      model: input.model,
      timeoutMs: input.timeoutMs,
      runnerConfigured: false,
      apiKeyConfigured: input.apiKey !== undefined ||
        (previous?.runnerId === runner.runnerId && previous.apiKeyConfigured),
    }, stagedAt);
    const requestId = `session_naming_config_${randomUUID()}`;
    const response = await this.hub!.requestFromRunner(runner.runnerId, requestId, {
      type: "configure_session_naming_custom_model",
      requestId,
      endpoint: input.endpoint,
      model: input.model,
      timeoutMs: input.timeoutMs,
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    }, 10_000);
    if (response.type !== "session_naming_custom_model_result") {
      throw new Error("runner returned an invalid custom model result");
    }
    const result = sanitizeSessionNamingCustomModelResult(response, "configure");
    if (!result?.ok || !result.status?.configured ||
        result.status.configDigest !== customModelDigest(input)) {
      throw new SessionNamingModeUnavailableError(
        `the selected Machine rejected the custom model configuration (${result?.code ?? "unavailable"})`,
      );
    }
    this.db.setSessionNamingCustomModel(organizationId, {
      runnerId: runner.runnerId,
      endpoint: input.endpoint,
      model: input.model,
      timeoutMs: input.timeoutMs,
      runnerConfigured: true,
      apiKeyConfigured: result.status.apiKeyConfigured,
    }, stagedAt + 1);
    if (activateMode) {
      const priorPreference = this.db.getSessionNamingPreference(organizationId)?.updatedAt ?? 0;
      this.db.setSessionNamingPreference(
        organizationId,
        "custom_model_endpoint",
        Math.max(now, priorPreference + 1),
      );
    }
    return this.view(organizationId, true);
  }

  async deleteCustomModelApiKey(organizationId: string, now = Date.now()): Promise<SessionNamingSettingsView> {
    const saved = this.db.getSessionNamingCustomModel(organizationId);
    if (!saved) throw new SessionNamingModeUnavailableError("no runner-local custom model is configured");
    const runner = this.manageableCustomRunner(organizationId, saved.runnerId);
    const requestId = `session_naming_delete_key_${randomUUID()}`;
    const response = await this.hub!.requestFromRunner(runner.runnerId, requestId, {
      type: "delete_session_naming_custom_model_key",
      requestId,
    }, 10_000);
    if (response.type !== "session_naming_custom_model_result") {
      throw new Error("runner returned an invalid custom model result");
    }
    const result = sanitizeSessionNamingCustomModelResult(response, "delete_api_key");
    const matchingConfig = result?.status?.configured === true &&
      result.status.configDigest === customModelDigest(saved);
    if (!result?.ok || !result.status || result.status.apiKeyConfigured) {
      throw new SessionNamingModeUnavailableError("the selected Machine could not delete the API key");
    }
    this.db.reconcileSessionNamingCustomModelRunnerStatus(
      runner.runnerId,
      matchingConfig,
      false,
      Math.max(now, saved.updatedAt + 1),
    );
    return this.view(organizationId, true);
  }

  async replaceCustomModelApiKey(
    organizationId: string,
    apiKey: string,
    now = Date.now(),
  ): Promise<SessionNamingSettingsView> {
    const saved = this.db.getSessionNamingCustomModel(organizationId);
    if (!saved) throw new SessionNamingModeUnavailableError("no runner-local custom model is configured");
    return this.configureCustomModel(organizationId, {
      runnerId: saved.runnerId,
      endpoint: saved.endpoint,
      model: saved.model,
      timeoutMs: saved.timeoutMs,
      apiKey,
    }, now, false);
  }

  async testCustomModel(organizationId: string): Promise<SessionNamingConnectionTestResult> {
    const saved = this.db.getSessionNamingCustomModel(organizationId);
    if (!saved) throw new SessionNamingModeUnavailableError("no runner-local custom model is configured");
    const runner = this.manageableCustomRunner(organizationId, saved.runnerId);
    const requestId = `session_naming_test_${randomUUID()}`;
    const response = await this.hub!.requestFromRunner(runner.runnerId, requestId, {
      type: "test_session_naming_custom_model",
      requestId,
    }, saved.timeoutMs + 2_000);
    if (response.type !== "session_naming_custom_model_result") {
      return { ok: false, status: "unavailable" };
    }
    const result = sanitizeSessionNamingCustomModelResult(response, "test");
    if (result?.ok && result.status?.configured &&
        result.status.configDigest === customModelDigest(saved)) {
      this.db.reconcileSessionNamingCustomModelRunnerStatus(
        runner.runnerId,
        true,
        result.status.apiKeyConfigured,
        Math.max(Date.now(), saved.updatedAt + 1),
      );
      return { ok: true, status: "available" };
    }
    return {
      ok: false,
      status: result?.code === "authentication_failed"
        ? "authentication_failed"
        : result?.code === "timed_out"
          ? "timed_out"
          : result?.code === "endpoint_failed"
            ? "endpoint_failed"
            : "unavailable",
    };
  }

  reconcileRunnerCustomModelStatus(
    runnerId: string,
    status: { configured: boolean; apiKeyConfigured: boolean; configDigest?: string } | undefined,
    now = Date.now(),
  ): void {
    const organizationId = this.db.runnerScope(runnerId)?.organizationId;
    if (!organizationId) return;
    const saved = this.db.getSessionNamingCustomModel(organizationId);
    if (!saved || saved.runnerId !== runnerId) return;
    const matches = status?.configured === true && typeof status.apiKeyConfigured === "boolean" &&
      status.configDigest === customModelDigest(saved);
    this.db.reconcileSessionNamingCustomModelRunnerStatus(
      runnerId,
      matches,
      matches && status.apiKeyConfigured,
      Math.max(now, saved.updatedAt + 1),
    );
  }

  private sessionAgentTarget(sessionId: string): {
    runner: NonNullable<ReturnType<ControlPlaneDb["getRunner"]>>;
    agent: AgentDefinition;
    account: Omit<SessionNamingAccountBoundary, "machineCount">;
  } | null {
    const session = this.db.getSession(sessionId);
    if (!session?.agentId) return null;
    const runner = this.db.getRunner(session.runnerId);
    if (!runner || runner.status !== "online" || !runnerSupportsProtocol(runner.protocolVersion, "sessionAgentNaming")) return null;
    const agent = runner.agents.find((candidate) =>
      candidate.id === session.agentId && (candidate.driver ?? "acp") === session.driver,
    );
    const account = accountForAgent(agent);
    return agent && account ? { runner, agent, account } : null;
  }

  generator: SessionTitleGenerator = async (request: SessionTitleRequest): Promise<string> => {
    if (!request.sessionId || !this.enabledForSession(request.sessionId)) {
      throw new Error("semantic session naming is disabled or not configured");
    }
    const organizationId = this.organizationIdForSession(request.sessionId);
    if (!organizationId) throw new Error("semantic session naming is disabled or not configured");
    if (this.effectiveMode(organizationId) === "custom_model_endpoint") {
      const custom = this.db.getSessionNamingCustomModel(organizationId);
      if (!custom) {
        if (!this.environment.generator) throw new Error("semantic session naming is disabled or not configured");
        try {
          return await this.environment.generator(request);
        } catch (error) {
          if (request.signal.aborted) throw error;
          throw new SessionTitleGenerationError("provider_failed", "generation");
        }
      }
      const target = this.runnerCustomModel(organizationId);
      if (!target || !this.hub) throw new SessionTitleGenerationError("session_unavailable", "preflight");
      const requestId = `session_name_${randomUUID()}`;
      const resultPromise = this.hub.requestFromRunner(target.runner.runnerId, requestId, {
        type: "generate_session_title",
        requestId,
        sessionId: request.sessionId,
        mode: "custom_model_endpoint",
        messages: request.messages.map((message) => ({ role: message.role, text: message.text })),
        timeoutMs: custom.timeoutMs,
      }, custom.timeoutMs + 1_000);
      const result = await new Promise<GenerateSessionTitleResultMessage>((resolve, reject) => {
        const aborted = () => {
          this.hub?.cancelRunnerRequest?.(target.runner.runnerId, requestId);
          reject(new Error("runner custom model naming was cancelled"));
        };
        if (request.signal.aborted) {
          aborted();
          void resultPromise.catch(() => {});
          return;
        }
        request.signal.addEventListener("abort", aborted, { once: true });
        void resultPromise.then((value) => {
          request.signal.removeEventListener("abort", aborted);
          if (value.type !== "generate_session_title_result" || (value.ok && value.provider !== "custom")) {
            reject(new SessionTitleGenerationError("invalid_result", "output_validation"));
          } else resolve(value);
        }, (error) => {
          request.signal.removeEventListener("abort", aborted);
          reject(runnerNamingTransportFailure(error));
        });
      });
      if (!result.ok || typeof result.title !== "string") {
        throw new SessionTitleGenerationError(
          result.code ?? "provider_failed",
          result.phase ?? "generation",
        );
      }
      return result.title;
    }
    const explicitTarget = this.harnessTarget(organizationId);
    const target = explicitTarget?.view.available && explicitTarget.runner && explicitTarget.agent && explicitTarget.account
      ? { runner: explicitTarget.runner, agent: explicitTarget.agent, account: explicitTarget.account }
      : explicitTarget
        ? null
        : this.sessionAgentTarget(request.sessionId);
    if (!target || !this.hub) {
      if (explicitTarget) {
        throw new SessionTitleGenerationError(explicitTarget.failureCode ?? "session_unavailable", "preflight");
      }
      throw new SessionTitleGenerationError("session_unavailable", "preflight");
    }
    const requestId = `session_name_${randomUUID()}`;
    const resultPromise = this.hub.requestFromRunner(target.runner.runnerId, requestId, {
      type: "generate_session_title",
      requestId,
      sessionId: request.sessionId,
      ...(explicitTarget?.view.available ? {
        target: {
          agentId: explicitTarget.view.agentId,
          driver: explicitTarget.view.driver,
          model: explicitTarget.view.model,
          effort: explicitTarget.view.effort,
        },
      } : {}),
      messages: request.messages.map((message) => ({ role: message.role, text: message.text })),
      timeoutMs: this.timeoutForSession(request.sessionId),
    }, this.timeoutForSession(request.sessionId) + 1_000);
    const result = await new Promise<GenerateSessionTitleResultMessage>((resolve, reject) => {
      const aborted = () => {
        this.hub?.cancelRunnerRequest?.(target.runner.runnerId, requestId);
        reject(new Error("runner session naming was cancelled"));
      };
      if (request.signal.aborted) {
        aborted();
        void resultPromise.catch(() => {});
        return;
      }
      request.signal.addEventListener("abort", aborted, { once: true });
      void resultPromise.then((value) => {
        request.signal.removeEventListener("abort", aborted);
        if (value.type !== "generate_session_title_result") {
          reject(new SessionTitleGenerationError("invalid_result", "output_validation"));
        }
        else resolve(value);
      }, (error) => {
        request.signal.removeEventListener("abort", aborted);
        reject(runnerNamingTransportFailure(error));
      });
    });
    if (!result.ok || typeof result.title !== "string") {
      throw new SessionTitleGenerationError(
        result.code ?? "provider_failed",
        result.phase ?? "generation",
      );
    }
    if (explicitTarget?.view.available && (
      result.provider !== explicitTarget.account?.provider ||
      result.billingSource !== explicitTarget.account?.billingSource
    )) {
      throw new SessionTitleGenerationError("account_unavailable", "preflight");
    }
    return result.title;
  };
}
