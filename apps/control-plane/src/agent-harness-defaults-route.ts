import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "./identity.js";
import {
  AgentHarnessDefaultInputError,
  AgentHarnessDefaultUnavailableError,
  type AgentHarnessDefaultsSettings,
} from "./agent-harness-defaults.js";

export function registerAgentHarnessDefaultsRoutes(
  app: FastifyInstance,
  settings: AgentHarnessDefaultsSettings,
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null,
): void {
  app.get("/api/agent-harness-defaults", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "Agent Harness defaults are available to signed-in users only" });
    }
    return reply.header("cache-control", "private, no-store").send(settings.view(principal));
  });

  app.put("/api/agent-harness-defaults", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "Agent Harness defaults are available to signed-in users only" });
    }
    try {
      return reply.header("cache-control", "private, no-store").send(settings.update(principal, request.body));
    } catch (error) {
      if (error instanceof AgentHarnessDefaultInputError) return reply.code(400).send({ error: error.message });
      if (error instanceof AgentHarnessDefaultUnavailableError) return reply.code(409).send({ error: error.message });
      request.log.error({ err: error }, "could not update Agent Harness defaults");
      return reply.code(500).send({ error: "could not update Agent Harness defaults" });
    }
  });

  app.delete("/api/agent-harness-defaults", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "Agent Harness defaults are available to signed-in users only" });
    }
    try {
      return reply.header("cache-control", "private, no-store").send(settings.delete(principal, request.body));
    } catch (error) {
      if (error instanceof AgentHarnessDefaultInputError) return reply.code(400).send({ error: error.message });
      request.log.error({ err: error }, "could not reset Agent Harness defaults");
      return reply.code(500).send({ error: "could not reset Agent Harness defaults" });
    }
  });
}
