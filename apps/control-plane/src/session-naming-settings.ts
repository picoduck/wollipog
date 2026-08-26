import { randomUUID } from "node:crypto";
import type {
  AgentDefinition,
  GenerateSessionTitleResultMessage,
  SessionNamingAccountBoundary,
  SessionNamingMode,
  SessionNamingSettingsView,
} from "@wollipog/protocol";
import { runnerSupportsProtocol } from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import {
  sessionTitleGeneratorFromEnv,
  type SessionTitleGenerator,
  type SessionTitleRequest,
} from "./session-title-generator.js";

type PersistedSessionNamingMode = SessionNamingMode;

/** A user-selectable mode cannot currently run. Its messages are deliberately safe for clients. */
export class SessionNamingModeUnavailableError extends Error {
  override readonly name = "SessionNamingModeUnavailableError";
}

function publicEndpointOrigin(value: string): string {
  const endpoint = new URL(value);
  return endpoint.origin;
}

function accountForAgent(agent: AgentDefinition | undefined): Omit<SessionNamingAccountBoundary, "machineCount"> | null {
  if (!agent || agent.available === false || agent.authStatus !== "authenticated") return null;
  const driver = agent.driver ?? "acp";
  if ((driver === "codex" || driver === "codex-app-server") && agent.codexAppServer?.status === "supported" &&
      agent.codexAppServer.sessionNaming === true) {
    return { provider: "codex", billingSource: "provider_account" };
  }
  if (driver === "claude-code" && agent.claudeCode?.status === "ready" &&
      agent.claudeCode.auth.status === "authenticated") {
    return { provider: "claude", billingSource: agent.claudeCode.auth.billingSource };
  }
  return null;
}

const SESSION_NAMING_FAILURE_CODES = new Set([
  "session_unavailable", "account_unavailable", "provider_unsupported", "rate_limited",
  "timed_out", "provider_failed", "invalid_result",
]);
const SESSION_NAMING_BILLING_SOURCES = new Set([
  "subscription", "api", "bedrock", "vertex", "gateway", "provider_account", "unknown",
]);

/** Validate and canonicalize the only runner fields allowed across the naming boundary. */
export function sanitizeSessionNamingRunnerResult(
  message: GenerateSessionTitleResultMessage,
): GenerateSessionTitleResultMessage | null {
  if (typeof message.requestId !== "string" || !message.requestId) return null;
  if (message.ok === false) {
    if (typeof message.code !== "string" || !SESSION_NAMING_FAILURE_CODES.has(message.code)) return null;
    return { type: "generate_session_title_result", requestId: message.requestId, ok: false, code: message.code };
  }
  if (message.ok !== true || typeof message.title !== "string" || !message.title || message.title.length > 120 ||
      /[\r\n]/.test(message.title) || (message.provider !== "codex" && message.provider !== "claude") ||
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
    private readonly hub?: Pick<Hub, "requestFromRunner">,
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

  private effectiveMode(organizationId: string): PersistedSessionNamingMode {
    const selected = this.selectedMode(organizationId);
    if (selected.mode === "custom_model_endpoint" && this.environment.generator && this.environment.customModel) {
      return "custom_model_endpoint";
    }
    if (selected.mode === "session_agent_account" && this.hub && this.accountBoundaries(organizationId).length) {
      return "session_agent_account";
    }
    return "prompt_text_only";
  }

  view(organizationId: string, canManage: boolean): SessionNamingSettingsView {
    const selected = this.selectedMode(organizationId);
    const customAvailable = Boolean(this.environment.generator && this.environment.customModel);
    const sessionAgentAccounts = this.hub ? this.accountBoundaries(organizationId) : [];
    const effectiveMode = selected.mode === "custom_model_endpoint" && customAvailable
      ? "custom_model_endpoint"
      : selected.mode === "session_agent_account" && sessionAgentAccounts.length
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
          available: sessionAgentAccounts.length > 0,
          ...(sessionAgentAccounts.length ? {} : {
            reason: "No online current runner reports an eligible authenticated Codex or Claude account.",
          }),
        },
        custom_model_endpoint: customAvailable
          ? { available: true }
          : {
              available: false,
              reason: "Configure WOLLIPOG_TITLE_MODEL_URL and WOLLIPOG_TITLE_MODEL on the control plane first.",
            },
      },
      ...(this.environment.customModel ? {
        customModel: {
          endpointOrigin: publicEndpointOrigin(this.environment.customModel.endpoint),
          model: this.environment.customModel.model,
          apiKeyConfigured: this.environment.customModel.apiKeyConfigured,
          timeoutMs: this.environment.timeoutMs,
          configurationSource: "environment" as const,
        },
      } : {}),
      ...(sessionAgentAccounts.length ? { sessionAgentAccounts } : {}),
    };
  }

  setMode(organizationId: string, mode: SessionNamingMode, now = Date.now()): SessionNamingSettingsView {
    if (mode === "session_agent_account" && (!this.hub || this.accountBoundaries(organizationId).length === 0)) {
      throw new SessionNamingModeUnavailableError("no eligible authenticated runner agent account is currently available");
    }
    if (mode === "custom_model_endpoint" && !this.environment.generator) {
      throw new SessionNamingModeUnavailableError("a custom model endpoint and model must be configured in the control-plane environment");
    }
    const previousRevision = this.db.getSessionNamingPreference(organizationId)?.updatedAt ?? 0;
    this.db.setSessionNamingPreference(organizationId, mode, Math.max(now, previousRevision + 1));
    return this.view(organizationId, true);
  }

  enabledForSession = (sessionId: string): boolean => {
    const organizationId = this.organizationIdForSession(sessionId);
    if (!organizationId) return false;
    const mode = this.effectiveMode(organizationId);
    if (mode === "custom_model_endpoint") return true;
    return mode === "session_agent_account" && this.sessionAgentTarget(sessionId) !== null;
  };

  timeoutForSession = (sessionId: string): number => {
    const organizationId = this.organizationIdForSession(sessionId);
    return organizationId && this.effectiveMode(organizationId) === "custom_model_endpoint"
      ? this.environment.timeoutMs
      : 5_000;
  };

  revisionForSession = (sessionId: string): string => {
    const organizationId = this.organizationIdForSession(sessionId);
    if (!organizationId) return "unowned";
    const preference = this.db.getSessionNamingPreference(organizationId);
    const selected = preference ? `${preference.mode}:${preference.updatedAt}` : `inherited:${this.selectedMode(organizationId).mode}`;
    if (this.effectiveMode(organizationId) !== "session_agent_account") return selected;
    const target = this.sessionAgentTarget(sessionId);
    return target
      ? `${selected}:${target.runner.runnerId}:${target.runner.protocolVersion}:${target.agent.id}:${target.agent.authStatus}:${target.agent.available}`
      : `${selected}:no-session-account`;
  };

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
      if (!this.environment.generator) throw new Error("semantic session naming is disabled or not configured");
      return this.environment.generator(request);
    }
    const target = this.sessionAgentTarget(request.sessionId);
    if (!target || !this.hub) throw new Error("runner session naming is unavailable");
    const requestId = `session_name_${randomUUID()}`;
    const resultPromise = this.hub.requestFromRunner(target.runner.runnerId, requestId, {
      type: "generate_session_title",
      requestId,
      sessionId: request.sessionId,
      messages: request.messages.map((message) => ({ role: message.role, text: message.text })),
      timeoutMs: this.timeoutForSession(request.sessionId),
    }, this.timeoutForSession(request.sessionId) + 1_000);
    const result = await new Promise<GenerateSessionTitleResultMessage>((resolve, reject) => {
      const aborted = () => reject(new Error("runner session naming was cancelled"));
      if (request.signal.aborted) {
        aborted();
        return;
      }
      request.signal.addEventListener("abort", aborted, { once: true });
      void resultPromise.then((value) => {
        request.signal.removeEventListener("abort", aborted);
        if (value.type !== "generate_session_title_result") reject(new Error("runner returned an invalid session naming result"));
        else resolve(value);
      }, (error) => {
        request.signal.removeEventListener("abort", aborted);
        reject(error);
      });
    });
    if (!result.ok || typeof result.title !== "string") {
      throw new Error(`runner session naming failed (${result.code ?? "provider_failed"})`);
    }
    return result.title;
  };
}
