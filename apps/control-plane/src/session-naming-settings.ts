import type {
  SessionNamingMode,
  SessionNamingSettingsView,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import {
  sessionTitleGeneratorFromEnv,
  type SessionTitleGenerator,
  type SessionTitleRequest,
} from "./session-title-generator.js";

type PersistedSessionNamingMode = "prompt_text_only" | "custom_model_endpoint";

/** A user-selectable mode cannot currently run. Its messages are deliberately safe for clients. */
export class SessionNamingModeUnavailableError extends Error {
  override readonly name = "SessionNamingModeUnavailableError";
}

function publicEndpointOrigin(value: string): string {
  const endpoint = new URL(value);
  return endpoint.origin;
}

/** Runtime bridge for the legacy environment endpoint. Organization choices are durable and take
 * precedence; an organization without a saved choice inherits the old environment behavior. */
export class SessionNamingSettings {
  private readonly environment: ReturnType<typeof sessionTitleGeneratorFromEnv>;

  constructor(
    private readonly db: ControlPlaneDb,
    env: NodeJS.ProcessEnv = process.env,
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

  private effectiveMode(organizationId: string): PersistedSessionNamingMode {
    const selected = this.selectedMode(organizationId);
    return selected.mode === "custom_model_endpoint" && this.environment.generator && this.environment.customModel
      ? "custom_model_endpoint"
      : "prompt_text_only";
  }

  view(organizationId: string, canManage: boolean): SessionNamingSettingsView {
    const selected = this.selectedMode(organizationId);
    const customAvailable = Boolean(this.environment.generator && this.environment.customModel);
    const effectiveMode = selected.mode === "custom_model_endpoint" && customAvailable
      ? "custom_model_endpoint" : "prompt_text_only";
    return {
      mode: selected.mode,
      effectiveMode,
      source: selected.source,
      canManage,
      modes: {
        prompt_text_only: { available: true },
        session_agent_account: {
          available: false,
          reason: "Runner-hosted agent account naming is not available in this release.",
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
    };
  }

  setMode(organizationId: string, mode: SessionNamingMode, now = Date.now()): SessionNamingSettingsView {
    if (mode === "session_agent_account") {
      throw new SessionNamingModeUnavailableError("runner-hosted agent account naming is not available in this release");
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
    return this.effectiveMode(organizationId) === "custom_model_endpoint";
  };

  timeoutForSession = (sessionId: string): number => {
    return this.enabledForSession(sessionId) ? this.environment.timeoutMs : 5_000;
  };

  revisionForSession = (sessionId: string): string => {
    const organizationId = this.organizationIdForSession(sessionId);
    if (!organizationId) return "unowned";
    const preference = this.db.getSessionNamingPreference(organizationId);
    return preference ? `${preference.mode}:${preference.updatedAt}` : `inherited:${this.selectedMode(organizationId).mode}`;
  };

  generator: SessionTitleGenerator = async (request: SessionTitleRequest): Promise<string> => {
    if (!request.sessionId || !this.enabledForSession(request.sessionId) || !this.environment.generator) {
      throw new Error("semantic session naming is disabled or not configured");
    }
    return this.environment.generator(request);
  };
}
