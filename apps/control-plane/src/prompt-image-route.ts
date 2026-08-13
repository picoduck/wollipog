import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  MAX_PROMPT_IMAGE_BYTES,
  PROMPT_IMAGE_MIME_TYPES,
  type GovernanceActor,
} from "@wollipog/protocol";
import { extractBearer, hashToken } from "./auth.js";
import type { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal } from "./identity.js";
import { runnerPromptImage } from "./runner-prompt-image.js";
import type { SessionsService } from "./sessions.js";

export function registerPromptImageRoutes(app: FastifyInstance, deps: {
  db: ControlPlaneDb;
  service: Pick<SessionsService, "createPromptImageArtifact">;
  requestPrincipal(req: FastifyRequest): AuthPrincipal | null;
  actor(req: FastifyRequest): GovernanceActor;
}): void {
  for (const mimeType of PROMPT_IMAGE_MIME_TYPES) {
    app.addContentTypeParser(mimeType, { parseAs: "buffer", bodyLimit: MAX_PROMPT_IMAGE_BYTES }, (_req, body, done) => {
      done(null, body);
    });
  }

  app.post("/api/sessions/:id/prompt-images", {
    bodyLimit: MAX_PROMPT_IMAGE_BYTES,
    preParsing: async (req, reply, payload) => {
      const id = (req.params as { id: string }).id;
      const principal = deps.requestPrincipal(req);
      if (!principal || !deps.db.canAccessSession(principal, id)) {
        void reply.code(404).send({ error: "session not found" });
      }
      return payload;
    },
  }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const mimeType = typeof req.headers["content-type"] === "string"
      ? req.headers["content-type"].split(";", 1)[0]!.trim().toLowerCase()
      : "";
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: "an allowed raw image media type is required" });
    const result = deps.service.createPromptImageArtifact(id, mimeType, req.body, deps.actor(req));
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.headers({ "cache-control": "private, no-store", pragma: "no-cache" }).code(result.status).send(result.data);
  });

  app.get("/runner/:runnerId/sessions/:sessionId/artifacts/:artifactId", async (req, reply) => {
    const { runnerId, sessionId, artifactId } = req.params as {
      runnerId: string; sessionId: string; artifactId: string;
    };
    const bearer = extractBearer(req.headers.authorization);
    const result = runnerPromptImage(deps.db, runnerId, sessionId, artifactId, bearer ? hashToken(bearer) : null);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.headers({
      "content-type": result.mimeType,
      "content-length": String(result.body.byteLength),
      "cache-control": "private, no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    }).send(result.body);
  });
}
