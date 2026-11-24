import type { FastifyInstance, FastifyRequest } from "fastify";
import type { HumanPrincipal } from "./identity.js";
import type { SessionsService } from "./sessions.js";
import { failureBody } from "./capability-refusal.js";

/** Keep HTTP answer intent intact; the service decides legacy defaults for each question kind. */
export function registerQuestionAnswerRoute(app: FastifyInstance, deps: {
  service: Pick<SessionsService, "answerQuestion">;
  requestHuman: (req: FastifyRequest) => HumanPrincipal | null;
  humanActorId: (req: FastifyRequest) => string;
  canAccessSession: (human: HumanPrincipal, sessionId: string) => boolean;
}) {
  app.post("/api/sessions/:id/answer", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = req.body as { requestId?: string; occurrenceId?: string; answers?: Record<string, string | string[]>; action?: "submit" | "dismiss" };
    if (
      typeof body?.requestId !== "string" ||
      (body.occurrenceId != null && typeof body.occurrenceId !== "string") ||
      body.answers == null || typeof body.answers !== "object" || Array.isArray(body.answers) ||
      (body.action != null && body.action !== "submit" && body.action !== "dismiss")
    ) return reply.code(400).send({ error: "requestId and answers are required; action must be submit or dismiss" });
    const human = deps.requestHuman(req);
    const result = deps.service.answerQuestion(id, body.requestId, body.answers, {
      kind: "human", id: deps.humanActorId(req),
    }, body.action, undefined, body.occurrenceId, undefined,
    (sessionId) => human ? deps.canAccessSession(human, sessionId) : false);
    return reply.code(result.status).send(result.ok ? result.data : failureBody(result));
  });
}
