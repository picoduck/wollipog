import type { FastifyInstance } from "fastify";

/** Keep every HTTP and WebSocket route unavailable until post-listen database settlement ends. */
export function installStartupReadinessGate(app: FastifyInstance): () => void {
  let ready = false;
  app.addHook("onRequest", async (_request, reply) => {
    if (ready) return;
    return reply.code(503).send({ error: "control plane is starting" });
  });
  return () => {
    ready = true;
  };
}
