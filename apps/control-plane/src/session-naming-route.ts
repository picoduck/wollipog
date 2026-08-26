import type {
  ConfigureSessionNamingCustomModelRequest,
  ReplaceSessionNamingCustomModelApiKeyRequest,
  SessionNamingMode,
  UpdateSessionNamingSettingsRequest,
} from "@wollipog/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "./identity.js";
import { canAdministerIdentity } from "./identity.js";
import {
  SessionNamingModeUnavailableError,
  type SessionNamingSettings,
} from "./session-naming-settings.js";

const MODES = new Set<SessionNamingMode>([
  "prompt_text_only",
  "session_agent_account",
  "custom_model_endpoint",
]);

export function registerSessionNamingRoutes(
  app: FastifyInstance,
  settings: SessionNamingSettings,
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null,
): void {
  app.get("/api/session-naming", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "session naming settings are available to organization members only" });
    }
    try {
      return settings.view(principal.organizationId, canAdministerIdentity(principal.role));
    } catch (error) {
      request.log.error({ err: error }, "could not load session naming settings");
      return reply.code(500).send({ error: "could not load session naming settings" });
    }
  });

  app.put("/api/session-naming", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    const mode = (request.body as Partial<UpdateSessionNamingSettingsRequest> | null)?.mode;
    if (typeof mode !== "string" || !MODES.has(mode as SessionNamingMode)) {
      return reply.code(400).send({ error: "a valid session naming mode is required" });
    }
    try {
      return settings.setMode(principal.organizationId, mode as SessionNamingMode);
    } catch (error) {
      if (error instanceof SessionNamingModeUnavailableError) {
        return reply.code(409).send({ error: error.message });
      }
      request.log.error({ err: error }, "could not update session naming settings");
      return reply.code(500).send({ error: "could not update session naming settings" });
    }
  });

  app.put("/api/session-naming/custom-model", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    const body = request.body as Partial<ConfigureSessionNamingCustomModelRequest> | null;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "custom model configuration is required" });
    }
    try {
      return await settings.configureCustomModel(
        principal.organizationId,
        body as ConfigureSessionNamingCustomModelRequest,
      );
    } catch (error) {
      if (error instanceof SessionNamingModeUnavailableError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof Error && /^(a valid|the endpoint|timeout|the API key|an API key)/u.test(error.message)) {
        return reply.code(400).send({ error: error.message });
      }
      request.log.error({ err: error }, "could not configure runner-local session naming");
      return reply.code(500).send({ error: "could not configure runner-local session naming" });
    }
  });

  app.delete("/api/session-naming/custom-model/api-key", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    try {
      return await settings.deleteCustomModelApiKey(principal.organizationId);
    } catch (error) {
      if (error instanceof SessionNamingModeUnavailableError) {
        return reply.code(409).send({ error: error.message });
      }
      request.log.error({ err: error }, "could not delete runner-local session naming API key");
      return reply.code(500).send({ error: "could not delete runner-local session naming API key" });
    }
  });

  app.post("/api/session-naming/custom-model/api-key", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    const apiKey = (request.body as Partial<ReplaceSessionNamingCustomModelApiKeyRequest> | null)?.apiKey;
    if (typeof apiKey !== "string") return reply.code(400).send({ error: "an API key is required" });
    try {
      return await settings.replaceCustomModelApiKey(principal.organizationId, apiKey);
    } catch (error) {
      if (error instanceof SessionNamingModeUnavailableError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof Error && error.message === "the API key is invalid") {
        return reply.code(400).send({ error: error.message });
      }
      request.log.error({ err: error }, "could not replace runner-local session naming API key");
      return reply.code(500).send({ error: "could not replace runner-local session naming API key" });
    }
  });

  app.post("/api/session-naming/custom-model/test", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human" || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    try {
      return await settings.testCustomModel(principal.organizationId);
    } catch (error) {
      if (error instanceof SessionNamingModeUnavailableError) {
        return reply.code(409).send({ error: error.message });
      }
      request.log.error({ err: error }, "could not test runner-local session naming");
      return reply.code(500).send({ error: "could not test runner-local session naming" });
    }
  });
}
