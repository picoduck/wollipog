import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import { canAdministerIdentity, type HumanPrincipal } from "./identity.js";
import { issueRunnerCredential, normalizeRunnerCredentialId } from "./runner-credentials.js";

const ONE_TIME_SECRET_HEADERS = {
  "cache-control": "private, no-store",
  pragma: "no-cache",
  vary: "Authorization",
} as const;

function organizationScope(principal: HumanPrincipal) {
  return {
    organizationId: principal.organizationId,
    owner: { kind: "organization" as const, organizationId: principal.organizationId },
  };
}

function administrator(
  deps: { requestHuman(req: FastifyRequest): HumanPrincipal | null },
  req: FastifyRequest,
): HumanPrincipal | null {
  const principal = deps.requestHuman(req);
  return principal && canAdministerIdentity(principal.role) ? principal : null;
}

/** Owner/admin-only lifecycle API. Plaintext appears solely in successful issue/rotate replies. */
export function registerRunnerCredentialRoutes(
  app: FastifyInstance,
  deps: {
    db: ControlPlaneDb;
    hub: Hub;
    requestHuman(req: FastifyRequest): HumanPrincipal | null;
  },
): void {
  app.get("/api/runner-credentials", async (req, reply) => {
    const principal = administrator(deps, req);
    if (!principal) return reply.code(403).send({ error: "organization owner or admin permission is required" });
    return { credentials: deps.db.listRunnerCredentials(principal.organizationId) };
  });

  app.post("/api/runner-credentials", async (req, reply) => {
    const principal = administrator(deps, req);
    if (!principal) return reply.code(403).send({ error: "organization owner or admin permission is required" });
    const body = (req.body ?? {}) as { runnerId?: unknown; label?: unknown };
    const runnerId = normalizeRunnerCredentialId(body.runnerId);
    if (!runnerId) return reply.code(400).send({ error: "runnerId is invalid" });
    const historyScope = deps.db.runnerCredentialScope(runnerId);
    const registeredScope = deps.db.runnerScope(runnerId);
    const existingScope = historyScope ?? registeredScope;
    if (existingScope && existingScope.organizationId !== principal.organizationId) {
      return reply.code(404).send({ error: "runner not found" });
    }
    if (deps.db.activeRunnerCredential(runnerId)) {
      return reply.code(409).send({ error: "registered runner already has an active credential; rotate it instead" });
    }
    try {
      const secret = issueRunnerCredential(deps.db, {
        runnerId,
        scope: existingScope ?? organizationScope(principal),
        createdByUserId: principal.userId,
        label: typeof body.label === "string" ? body.label : undefined,
        now: Date.now(),
      });
      return reply.code(201).headers(ONE_TIME_SECRET_HEADERS).send(secret);
    } catch (error) {
      const message = error instanceof Error ? error.message : "runner credential could not be issued";
      if (/another owner|reserved/u.test(message)) return reply.code(404).send({ error: "runner not found" });
      throw error;
    }
  });

  app.post("/api/runner-credentials/:runnerId/rotate", async (req, reply) => {
    const principal = administrator(deps, req);
    if (!principal) return reply.code(403).send({ error: "organization owner or admin permission is required" });
    const runnerId = normalizeRunnerCredentialId((req.params as { runnerId?: unknown }).runnerId);
    const scope = runnerId ? deps.db.runnerCredentialScope(runnerId) : null;
    if (!runnerId || !scope || scope.organizationId !== principal.organizationId) {
      return reply.code(404).send({ error: "runner not found" });
    }
    const body = (req.body ?? {}) as { label?: unknown };
    const secret = issueRunnerCredential(deps.db, {
      runnerId,
      scope,
      createdByUserId: principal.userId,
      label: typeof body.label === "string" ? body.label : undefined,
      now: Date.now(),
    });
    return reply.headers(ONE_TIME_SECRET_HEADERS).send(secret);
  });

  app.delete("/api/runner-credentials/:runnerId", async (req, reply) => {
    const principal = administrator(deps, req);
    if (!principal) return reply.code(403).send({ error: "organization owner or admin permission is required" });
    const runnerId = normalizeRunnerCredentialId((req.params as { runnerId?: unknown }).runnerId);
    const scope = runnerId ? deps.db.runnerCredentialScope(runnerId) : null;
    if (!runnerId || !scope || scope.organizationId !== principal.organizationId) {
      return reply.code(404).send({ error: "runner not found" });
    }
    if (!deps.db.revokeRunnerCredential(runnerId, principal.organizationId, Date.now())) {
      return reply.code(409).send({ error: "runner has no active or pending credential" });
    }
    deps.hub.closeRunner(runnerId);
    return reply.code(204).send();
  });
}
