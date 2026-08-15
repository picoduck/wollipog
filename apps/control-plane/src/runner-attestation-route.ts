import {
  CONTROL_PLANE_SERVICE,
  PROTOCOL_VERSION,
  type RunnerControlPlaneAttestation,
} from "@wollipog/protocol";
import type { FastifyInstance } from "fastify";
import { extractBearer, hashToken } from "./auth.js";
import type { ControlPlaneDb } from "./db.js";
import { normalizeRunnerCredentialId } from "./runner-credentials.js";

const ATTESTATION_HEADERS = {
  "cache-control": "private, no-store",
  pragma: "no-cache",
  vary: "Authorization",
} as const;

/** Runner-token authenticated identity probe. It deliberately lives outside /api, whose device
 * gate serves human clients, and performs no credential activation or last-used mutation. */
export function registerRunnerAttestationRoute(
  app: FastifyInstance,
  deps: Pick<ControlPlaneDb, "instanceId" | "verifyRunnerCredentialForAttestation">,
  now: () => number = Date.now,
): void {
  app.get("/runner/attestation/:runnerId", async (req, reply) => {
    const runnerId = normalizeRunnerCredentialId((req.params as { runnerId?: unknown }).runnerId);
    const bearer = extractBearer(req.headers.authorization);
    if (!runnerId || !bearer || !deps.verifyRunnerCredentialForAttestation(runnerId, hashToken(bearer), now())) {
      return reply.code(401).headers(ATTESTATION_HEADERS).send({ error: "runner credential is invalid" });
    }
    return reply.headers(ATTESTATION_HEADERS).send({
      service: CONTROL_PLANE_SERVICE,
      instanceId: deps.instanceId(),
      protocolVersion: PROTOCOL_VERSION,
    } satisfies RunnerControlPlaneAttestation);
  });
}
