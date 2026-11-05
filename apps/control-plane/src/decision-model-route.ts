import type { ConfigureDecisionModelRequest, DecisionModelTestResult } from "@wollipog/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { DECISION_PROBE_INPUTS } from "./decision-kinds.js";
import {
  DecisionModelInputError,
  DecisionModelUnavailableError,
  type DecisionModelSettings,
} from "./decision-model-settings.js";
import type { DecisionRuntime } from "./decision-runtime.js";
import type { AuthPrincipal } from "./identity.js";
import { canAdministerIdentity } from "./identity.js";

const ADMIN_REQUIRED = { error: "organization owner or admin permission is required" };

export function registerDecisionModelRoutes(
  app: FastifyInstance,
  deps: {
    settings: DecisionModelSettings;
    runtime: DecisionRuntime;
    requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null;
    now?: () => number;
  },
): void {
  const now = deps.now ?? Date.now;
  const admin = (request: FastifyRequest) => {
    const principal = deps.requestPrincipal(request);
    return principal && principal.kind === "human" && canAdministerIdentity(principal.role) ? principal : null;
  };

  // Every organization member reads the setting; only administrators change or test it.
  app.get("/api/decision-model", async (request, reply) => {
    const principal = deps.requestPrincipal(request);
    if (!principal || principal.kind !== "human") {
      return reply.code(403).send({ error: "the Decision Model setting is available to organization members only" });
    }
    return deps.settings.view(principal.organizationId, canAdministerIdentity(principal.role));
  });

  app.put("/api/decision-model", async (request, reply) => {
    const principal = admin(request);
    if (!principal) return reply.code(403).send(ADMIN_REQUIRED);
    try {
      return deps.settings.configure(principal.organizationId, request.body as ConfigureDecisionModelRequest);
    } catch (error) {
      if (error instanceof DecisionModelInputError) return reply.code(400).send({ error: error.message });
      if (error instanceof DecisionModelUnavailableError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/decision-model", async (request, reply) => {
    const principal = admin(request);
    if (!principal) return reply.code(403).send(ADMIN_REQUIRED);
    return deps.settings.useAutomatic(principal.organizationId);
  });

  /** Test Decision Model: one fixed probe decision through the full runtime, with its audit. */
  app.post("/api/decision-model/test", async (request, reply) => {
    const principal = admin(request);
    if (!principal) return reply.code(403).send(ADMIN_REQUIRED);
    const startedAt = now();
    const outcome = await deps.runtime.decide({
      organizationId: principal.organizationId,
      kind: "probe",
      inputs: DECISION_PROBE_INPUTS,
      // The probe asks nobody: its result is shown to the administrator who ran it.
      routeToHuman: () => null,
    });
    const occurrence = deps.runtime.view(outcome.occurrenceId);
    if (!occurrence) return reply.code(500).send({ error: "the Decision Model test was not recorded" });
    const result: DecisionModelTestResult = { occurrence, latencyMs: Math.max(0, now() - startedAt) };
    return result;
  });
}
