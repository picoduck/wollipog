import {
  CONTROL_PLANE_API_VERSION,
  CONTROL_PLANE_CAPABILITIES,
  CONTROL_PLANE_SERVICE,
  type ControlPlaneInstanceInfo,
} from "@wollipog/protocol";
import type { FastifyInstance } from "fastify";
import { APP_RELEASE_VERSION } from "./release-version.js";

export interface ControlPlaneInstanceIdentity {
  instanceId(): string;
  displayName(): string;
}

/** Register the authenticated compatibility probe used before selecting a remote instance. */
export function registerInstanceRoute(
  app: FastifyInstance,
  identity: ControlPlaneInstanceIdentity,
): void {
  app.get("/api/instance", async (_req, reply): Promise<ControlPlaneInstanceInfo> => {
    // Endpoint reuse must be observed immediately; a cached identity could make a client switch
    // into a different control plane than the one whose credential it just validated.
    reply.header("cache-control", "no-store");
    return {
      service: CONTROL_PLANE_SERVICE,
      instanceId: identity.instanceId(),
      displayName: identity.displayName(),
      apiVersion: CONTROL_PLANE_API_VERSION,
      appVersion: APP_RELEASE_VERSION,
      capabilities: [...CONTROL_PLANE_CAPABILITIES],
    };
  });
}
