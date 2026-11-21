import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  runnerCapabilityRequirementError,
  runnerSupportsProtocol,
  validAntigravityOperationId,
  validAntigravitySetupView,
  type AntigravitySetupAction,
} from "@wollipog/protocol";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { HumanPrincipal } from "./identity.js";

/** Google Antigravity setup on one Machine (protocol v403, Refs #4780).
 *
 * Only a person who can manage the Machine may check the runtime or run Google's sign-in: the
 * sign-in link and authorization code are bearer-like, so agent principals and the Assistant have
 * no route here. The authorization code passes through to the runner once and is never logged or
 * stored. Wollipog never installs Antigravity; the card shows Google's install command instead. */
export function registerAntigravitySetupRoutes(
  app: FastifyInstance,
  db: ControlPlaneDb,
  hub: Hub,
  requestHuman: (req: FastifyRequest) => HumanPrincipal | null,
): void {
  const command = async (
    req: FastifyRequest,
    reply: FastifyReply,
    action: AntigravitySetupAction,
    extra: { operationId?: string; code?: string } = {},
  ) => {
    const id = (req.params as { id: string }).id;
    const principal = requestHuman(req);
    if (!principal || !db.canManageRunner(principal, id)) {
      return reply.code(403).send({ error: "Machine owner or organization admin permission is required" });
    }
    const runner = db.getRunner(id);
    if (!runner) return reply.code(404).send({ error: "runner not found" });
    if (!hub.isRunnerOnline(id)) return reply.code(409).send({ error: "runner is offline" });
    if (!runnerSupportsProtocol(runner.protocolVersion, "antigravitySetup")) {
      return reply.code(409).send(runnerCapabilityRequirementError(runner.protocolVersion, "antigravitySetup", "Google Antigravity setup"));
    }
    const requestId = `antigravity_setup_${randomUUID()}`;
    let result;
    try {
      result = await hub.requestFromRunner(id, requestId, {
        type: "antigravity_setup", requestId, runnerId: id, action, ...extra,
      });
    } catch (error) {
      return reply.code(504).send({ error: (error as Error).message });
    }
    if (result.type !== "antigravity_setup_result") return reply.code(502).send({ error: "unexpected runner reply" });
    const setup = validAntigravitySetupView(result.setup) ? result.setup : undefined;
    if (setup) {
      try {
        db.updateRunnerAntigravitySetup(id, setup, Date.now());
        hub.runnerChanged(id);
      } catch {
        // The runner's own antigravity_setup_updated frame remains authoritative.
      }
    }
    if (!result.ok) return reply.code(409).send({ error: result.error ?? "Google Antigravity setup could not continue." });
    return { setup };
  };

  app.post("/api/runners/:id/antigravity-setup/check", (req, reply) => command(req, reply, "check"));

  app.post("/api/runners/:id/antigravity-setup/sign-in", (req, reply) => command(req, reply, "start_sign_in"));

  app.post("/api/runners/:id/antigravity-setup/sign-in/:operationId/code", (req, reply) => {
    const { operationId } = req.params as { operationId: string };
    if (!validAntigravityOperationId(operationId)) return reply.code(400).send({ error: "operationId is invalid" });
    const code = (req.body as { code?: unknown } | undefined)?.code;
    if (typeof code !== "string" || !code.trim() || code.trim().length > 4_096 || /[\u0000\r\n]/u.test(code.trim())) {
      return reply.code(400).send({ error: "code must be a single line of 1 to 4096 characters" });
    }
    return command(req, reply, "submit_code", { operationId, code: code.trim() });
  });

  app.delete("/api/runners/:id/antigravity-setup/sign-in/:operationId", (req, reply) => {
    const { operationId } = req.params as { operationId: string };
    if (!validAntigravityOperationId(operationId)) return reply.code(400).send({ error: "operationId is invalid" });
    return command(req, reply, "cancel_sign_in", { operationId });
  });
}
