import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { HumanPrincipal } from "./identity.js";
import { AssistantThreadRefusal, type AssistantThreads } from "./assistant-threads.js";

/** Owner routes for Wollipog Assistant threads (#4663). The transcript and composer are the
 * backing session's own routes. Responses never carry a credential value or hash. */
export function registerAssistantThreadRoutes(app: FastifyInstance, deps: {
  threads: AssistantThreads;
  requestHuman(req: FastifyRequest): HumanPrincipal | null;
}): void {
  const handle = (run: (owner: HumanPrincipal, req: FastifyRequest) => unknown) => async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = deps.requestHuman(req);
    if (principal?.role !== "owner") return reply.code(403).send({ error: "Only an organization owner can use Wollipog Assistant threads." });
    reply.header("cache-control", "no-store");
    try {
      return await run(principal, req);
    } catch (error) {
      if (error instanceof AssistantThreadRefusal) return reply.code(error.status).send({ ...error.details, error: error.message });
      throw error;
    }
  };
  const threadId = (req: FastifyRequest) => (req.params as { threadId: string }).threadId;

  app.get("/api/assistant-threads", handle((owner, req) =>
    ({ threads: deps.threads.list(owner, (req.query as { includeArchived?: unknown }).includeArchived === "true") })));
  app.get("/api/assistant-threads/defaults", handle((owner) => deps.threads.defaults(owner)));
  app.post("/api/assistant-threads", handle(async (owner, req) => ({ thread: deps.threads.create(owner, req.body) })));
  app.get("/api/assistant-threads/:threadId", handle((owner, req) => ({ thread: deps.threads.get(owner, threadId(req)) })));
  app.patch("/api/assistant-threads/:threadId", handle((owner, req) => ({ thread: deps.threads.rename(owner, threadId(req), req.body) })));
  app.post("/api/assistant-threads/:threadId/archive", handle((owner, req) => ({ thread: deps.threads.archive(owner, threadId(req)) })));
}
