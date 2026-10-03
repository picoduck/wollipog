import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "./identity.js";
import type { ControlPlaneDb } from "./db.js";
import type { Hub } from "./hub.js";
import type { ArtifactUploadPreference } from "@wollipog/protocol";

export function registerArtifactUploadSettingsRoutes(app: FastifyInstance, db: ControlPlaneDb, hub: Hub,
  requestPrincipal: (request: FastifyRequest) => AuthPrincipal | null): void {
  app.get("/api/artifact-upload-settings", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (principal?.kind !== "human") return reply.code(403).send({ error: "Artifact upload preferences require a signed-in user" });
    return reply.header("cache-control", "private, no-store").send({ preference: db.artifactUploadPreference(principal.userId) });
  });
  app.put("/api/artifact-upload-settings", async (request, reply) => {
    const principal = requestPrincipal(request);
    if (principal?.kind !== "human") return reply.code(403).send({ error: "only an authenticated human may change artifact upload preferences" });
    const body = request.body as { preference?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 ||
        !["manual", "wollipog_automatic", "external_hosting"].includes(body.preference as string)) {
      return reply.code(400).send({ error: "invalid artifact upload preference" });
    }
    const preference = body.preference as ArtifactUploadPreference;
    db.setArtifactUploadPreference(principal.userId, preference);
    hub.syncArtifactUploads(principal.userId);
    return reply.header("cache-control", "private, no-store").send({ preference });
  });
}
