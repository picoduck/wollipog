import { runnerSupportsProtocol, runnerCapabilityRequirementError } from "@wollipog/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal } from "./identity.js";
import type { Hub } from "./hub.js";

/** Executable trust is a host-owner decision, never an agent-session preference. */
export function registerReviewerSecurityRoutes(app: FastifyInstance, db: ControlPlaneDb,
  hub: Pick<Hub, "sendToRunner" | "runnerChanged" | "boxChanged">,
  principalFor: (request: FastifyRequest) => AuthPrincipal | null): void {
  app.put("/api/runners/:id/reviewer-security", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const principal = principalFor(request);
    if (principal?.kind !== "human" || !db.canManageRunner(principal, id)) {
      return reply.code(403).send({ error: "Machine owner or organization admin permission is required" });
    }
    const body = (request.body ?? {}) as { policy?: unknown; expectedRevision?: unknown };
    if (body.policy !== "strict" && body.policy !== "personal_machine") {
      return reply.code(400).send({ error: "Choose Strict or Personal Machine." });
    }
    if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
      return reply.code(400).send({ error: "expectedRevision must be a non-negative integer" });
    }
    const runner = db.getRunner(id);
    const boxId = db.boxIdForRunner(id);
    if (!runner && !boxId) return reply.code(404).send({ error: "runner not found" });
    if (runner?.status === "online" && !runnerSupportsProtocol(runner.protocolVersion, "reviewerSecurityPolicy")) {
      return reply.code(409).send(runnerCapabilityRequirementError(runner.protocolVersion,
        "reviewerSecurityPolicy", "reviewer executable policy changes"));
    }
    const changed = db.setMachineReviewerSecurity(id, body.policy, body.expectedRevision as number);
    if (!changed.ok) return reply.code(409).send({ error: "Reviewer Executable Policy changed in another client", current: changed.configuration });
    request.log.info({ event: "reviewer_security_update", entryPoint: "machine_settings", runnerId: id, ...changed.configuration }, "Reviewer executable policy updated");
    if (runner?.status === "online") hub.sendToRunner(id, { type: "configure_reviewer_security", ...changed.configuration });
    hub.runnerChanged(id);
    if (boxId) hub.boxChanged(boxId);
    return { reviewerSecurity: changed.configuration };
  });
}
