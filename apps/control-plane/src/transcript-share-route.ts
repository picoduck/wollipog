import type { FastifyInstance } from "fastify";
import type { ControlPlaneDb } from "./db.js";
import {
  TranscriptShareReadLimiter,
  loadPublicTranscriptShare,
  lookupPublicTranscriptShareCapability,
} from "./transcript-shares.js";
import { selectSingleRawHeader } from "./wire-compat.js";

export const PUBLIC_TRANSCRIPT_SHARE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  vary: "Authorization",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
} as const;

export function registerPublicTranscriptShareRoute(
  app: FastifyInstance,
  deps: { db: ControlPlaneDb; limiter?: TranscriptShareReadLimiter; now?: () => number },
): void {
  const limiter = deps.limiter ?? new TranscriptShareReadLimiter();
  app.get("/api/public/transcript-share", async (req, reply) => {
    const now = deps.now?.() ?? Date.now();
    const authorization = selectSingleRawHeader(req.raw, "authorization");
    const capability = authorization.ok
      ? lookupPublicTranscriptShareCapability(deps.db, authorization.value, now)
      : null;
    if (!capability) {
      return reply.headers(PUBLIC_TRANSCRIPT_SHARE_HEADERS).code(404).send({ error: "shared transcript unavailable" });
    }
    if (!limiter.allowTokenHash(capability.tokenHash, now)) {
      return reply
        .headers({ ...PUBLIC_TRANSCRIPT_SHARE_HEADERS, "retry-after": "60" })
        .code(429)
        .send({ error: "shared transcript rate limit exceeded" });
    }
    const shared = loadPublicTranscriptShare(deps.db, capability, now);
    if (!shared) {
      return reply.headers(PUBLIC_TRANSCRIPT_SHARE_HEADERS).code(404).send({ error: "shared transcript unavailable" });
    }
    return reply.headers(PUBLIC_TRANSCRIPT_SHARE_HEADERS).send(shared);
  });
}
