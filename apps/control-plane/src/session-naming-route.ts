import type {
  SessionNamingMode,
  UpdateSessionNamingSettingsRequest,
} from "@wollipog/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "./identity.js";
import { canAdministerIdentity } from "./identity.js";
import type { SessionNamingSettings } from "./session-naming-settings.js";

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
    return settings.view(principal.organizationId, canAdministerIdentity(principal.role));
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
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "the session naming mode is unavailable",
      });
    }
  });
}
