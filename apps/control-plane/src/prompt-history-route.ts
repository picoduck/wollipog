import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ControlPlaneDb } from "./db.js";
import type { AuthPrincipal } from "./identity.js";
import { runnerSupportsProtocol } from "@wollipog/protocol";

export function registerPromptHistoryRoute(app: FastifyInstance, deps: {
  db: Pick<ControlPlaneDb, "canAccessSession" | "getSession" | "getRunnerHistoryState" | "getRunner" | "listPromptHistoryPage">;
  hydrateHistory: (id: string) => Promise<void>;
  requestPrincipal: (req: FastifyRequest) => AuthPrincipal | null;
}): void {
  app.get("/api/sessions/:id/prompt-history", async (req, reply) => {
    reply.header("cache-control", "private, no-store");
    const id = (req.params as { id: string }).id;
    const principal = deps.requestPrincipal(req);
    if (!principal || !deps.db.canAccessSession(principal, id)) {
      return reply.code(404).send({ error: "session not found" });
    }
    const query = req.query as { before?: string; limit?: string; eventEpoch?: string };
    const before = query.before === undefined ? undefined : Number(query.before);
    const limit = Number(query.limit ?? 100);
    const eventEpoch = Number(query.eventEpoch);
    if ((before !== undefined && (!Number.isSafeInteger(before) || before < 1)) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(eventEpoch) || eventEpoch < 0) {
      return reply.code(400).send({ error: "invalid prompt history page" });
    }
    const initial = deps.db.getRunnerHistoryState(id);
    if (!initial) return reply.code(404).send({ error: "session not found" });
    if (initial.eventEpoch !== eventEpoch) return reply.code(409).send({
      error: "session event history was replaced", code: "stale_event_epoch", eventEpoch: initial.eventEpoch,
    });
    // Join the existing deduplicated hydration, never send its full log to the browser. This also
    // makes cold-cache recall wait for authoritative history instead of treating a prefix as a tail.
    await deps.hydrateHistory(id);
    const state = deps.db.getRunnerHistoryState(id);
    const session = deps.db.getSession(id);
    if (!state || !session || !deps.db.canAccessSession(principal, id)) {
      return reply.code(404).send({ error: "session not found" });
    }
    if (state.eventEpoch !== eventEpoch) return reply.code(409).send({
      error: "session event history was replaced", code: "stale_event_epoch", eventEpoch: state.eventEpoch,
    });
    const indexed = runnerSupportsProtocol(deps.db.getRunner(session.runnerId)?.protocolVersion, "indexedHistory");
    const cacheComplete = indexed ? state.complete : state.hydratedSeq >= state.tailSeq;
    const page = deps.db.listPromptHistoryPage(id, before, limit);
    // Count/completeness and Fastify's request id, status and elapsed-time logs answer recall
    // availability/latency questions without ever recording prompt text or attachment contents.
    req.log.debug({ event: "prompt_history_page", promptCount: page.prompts.length,
      hasMore: page.hasMore, cacheComplete }, "prompt history page read");
    return { ...page, eventEpoch, cacheComplete };
  });
}
