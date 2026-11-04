import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ControlPlaneDb } from "./db.js";
import { canAdministerIdentity, type HumanPrincipal } from "./identity.js";

/** The 409 code for a team name another team in the organization already has. */
export const TEAM_NAME_TAKEN = "team_name_taken";

/**
 * Rename a team (#3000). Like the other `/api/identity/` mutations it is for organization owners
 * and admins only, and the shared mutation-audit hooks record it. A rename changes nobody's access,
 * so unlike membership changes it closes no dashboard: others show the new name the next time they
 * load the directory.
 */
export function registerIdentityTeamRoutes(app: FastifyInstance, deps: {
  db: ControlPlaneDb;
  requestHuman: (request: FastifyRequest) => HumanPrincipal | null;
}): void {
  app.patch("/api/identity/teams/:teamId", async (request, reply) => {
    const principal = deps.requestHuman(request);
    if (!principal || !canAdministerIdentity(principal.role)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    const { teamId } = request.params as { teamId: string };
    const body = (request.body ?? {}) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return reply.code(400).send({ error: "team name must be 1-80 characters" });
    const team = deps.db.renameIdentityTeam({ teamId, organizationId: principal.organizationId, name, now: Date.now() });
    if (team === "not_found") return reply.code(404).send({ error: "team not found" });
    if (team === "name_taken") {
      return reply.code(409).send({ error: "another team in this organization already has this name", code: TEAM_NAME_TAKEN });
    }
    return { team };
  });
}
