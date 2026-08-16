import type { FastifyInstance, FastifyRequest } from "fastify";
import { legacySshAccountBoxes, type BoxOrchestrator } from "./box-orchestrator.js";
import {
  canAuthorizeLegacyDataAdoption,
  decideScopedBoxLifecycleForRunners,
  parseLegacyDataAdoption,
} from "./box-lifecycle.js";
import type { ControlPlaneDb } from "./db.js";
import type { HumanPrincipal } from "./identity.js";

export function registerBoxLegacyAdoptionRoute(
  app: FastifyInstance,
  deps: {
    db: ControlPlaneDb;
    orchestrator: Pick<BoxOrchestrator, "authorizeLegacyDataAdoption">;
    requestHuman(req: FastifyRequest): HumanPrincipal | null;
  },
): void {
  app.post("/api/boxes/:id/adopt-legacy-data-dir", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const box = deps.db.getBox(id);
    if (!box) return reply.code(404).send({ error: "box not found" });
    const principal = deps.requestHuman(req);
    if (!canAuthorizeLegacyDataAdoption(principal)) {
      return reply.code(403).send({ error: "organization owner or admin permission is required" });
    }
    const targetConfig = deps.db.getBoxConfig(id);
    if (!targetConfig || !deps.db.canAccessRunner(principal, box.runnerId)) {
      return reply.code(404).send({ error: "box not found" });
    }
    const accountBoxes = legacySshAccountBoxes(deps.db.listBoxConfigs(), targetConfig);
    if (accountBoxes.some((candidate) => !deps.db.canAccessRunner(principal, candidate.runnerId))) {
      return reply.code(409).send({
        error: "legacy data adoption cannot safely fence every managed box on this SSH account",
        code: "LEGACY_SSH_ACCOUNT_SCOPE_CONFLICT",
      });
    }
    const adoption = parseLegacyDataAdoption(req.body);
    if (!adoption.ok) return reply.code(400).send({ error: adoption.error });
    const decision = decideScopedBoxLifecycleForRunners(
      deps.db.listSessions({ includeArchived: true }),
      accountBoxes.map((candidate) => candidate.runnerId),
      adoption.force,
      "adopt",
      (sessionId) => deps.db.canAccessSession(principal, sessionId),
    );
    if (!decision.ok) return reply.code(409).send(decision.conflict);
    const result = await deps.orchestrator.authorizeLegacyDataAdoption(id, {
      userId: principal.userId,
      role: principal.role,
    });
    if (result === "not_found") return reply.code(404).send({ error: "box not found" });
    if (result === "not_legacy") {
      return reply.code(409).send({ error: "box already uses an isolated runner data directory" });
    }
    if (result === "already_authorized") {
      return reply.code(409).send({ error: "legacy data adoption was already authorized for this box" });
    }
    if (result === "account_already_adopted") {
      return reply.code(409).send({
        error: "this SSH account's legacy data was already adopted; use the normal owner-aware runner launch",
        code: "LEGACY_SSH_ACCOUNT_ALREADY_ADOPTED",
      });
    }
    if (result === "in_progress") {
      return reply.code(409).send({ error: "legacy data adoption is already stopping this box's managed runner" });
    }
    if (result === "stop_failed") {
      return reply.code(409).send({ error: "the managed runner could not be stopped; legacy data adoption was not authorized" });
    }
    if (result === "superseded") {
      return reply.code(409).send({ error: "a newer box lifecycle operation superseded legacy data adoption" });
    }
    return { ok: true, status: result, forced: adoption.force };
  });
}
