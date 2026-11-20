import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AssistantOwnerConfirmation, OrchestratorCampaignBudgetDefault } from "@wollipog/protocol";
import { AssistantRefusal } from "./assistant-connections.js";
import type { HumanPrincipal } from "./identity.js";
import { AssistantThreadRefusal, type AssistantThreads } from "./assistant-threads.js";
import { AssistantOwnerConfirmationRefusal, type AssistantOwnerConfirmationService } from "./assistant-owner-confirmations.js";

/** Owner routes for Wollipog Assistant threads (#4663). The transcript and composer are the
 * backing session's own routes. Responses never carry a credential value or hash. */
export function registerAssistantThreadRoutes(app: FastifyInstance, deps: {
  threads: AssistantThreads;
  /** Owner confirmations of the threads' destructive commands (#4665). */
  confirmations?: AssistantOwnerConfirmationService;
  reviseCampaign?(owner: HumanPrincipal, threadId: string, confirmationId: string, expectedDigest: string,
    budget: OrchestratorCampaignBudgetDefault): Promise<AssistantOwnerConfirmation | null>;
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
      if (error instanceof AssistantOwnerConfirmationRefusal) return reply.code(error.status).send({ error: error.message });
      if (error instanceof AssistantRefusal) return reply.code(409).send({ error: error.message });
      throw error;
    }
  };
  const threadId = (req: FastifyRequest) => (req.params as { threadId: string }).threadId;

  app.get("/api/assistant-threads", handle((owner, req) =>
    ({ threads: deps.threads.list(owner, (req.query as { includeArchived?: unknown }).includeArchived === "true") })));
  app.get("/api/assistant-threads/defaults", handle((owner) => deps.threads.defaults(owner)));
  app.put("/api/assistant-threads/defaults/launch", handle((owner, req) => deps.threads.setLaunchDefaults(owner, req.body)));
  // Separate write routes ensure older control planes refuse these inputs instead of silently
  // treating an update as a rename or applying the historic fixed limits.
  app.get("/api/assistant-threads/defaults/limits", handle((owner) => deps.threads.limitDefaults(owner)));
  app.put("/api/assistant-threads/defaults/limits", handle((owner, req) => deps.threads.setLimitDefaults(owner, req.body)));
  app.post("/api/assistant-threads", handle(async (owner, req) => ({ thread: deps.threads.create(owner, req.body) })));
  app.get("/api/assistant-threads/:threadId", handle((owner, req) => ({ thread: deps.threads.get(owner, threadId(req)) })));
  app.patch("/api/assistant-threads/:threadId", handle((owner, req) => ({ thread: deps.threads.rename(owner, threadId(req), req.body) })));
  app.put("/api/assistant-threads/:threadId/limits", handle((owner, req) => ({ thread: deps.threads.setLimits(owner, threadId(req), req.body) })));
  app.put("/api/assistant-threads/:threadId/delegation", handle((owner, req) =>
    ({ thread: deps.threads.setDecisionDelegation(owner, threadId(req), req.body) })));
  app.post("/api/assistant-threads/:threadId/archive", handle((owner, req) => ({ thread: deps.threads.archive(owner, threadId(req)) })));
  app.get("/api/assistant-threads/:threadId/account", handle((owner, req) => deps.threads.accountChoices(owner, threadId(req))));
  app.post("/api/assistant-threads/:threadId/account", handle(async (owner, req) =>
    ({ thread: await deps.threads.changeAccount(owner, threadId(req), req.body) })));

  app.get("/api/assistant-threads/:threadId/harness", handle((owner, req) =>
    ({ harnesses: deps.threads.harnessChoices(owner, threadId(req)) })));
  app.post("/api/assistant-threads/:threadId/harness", handle(async (owner, req) =>
    ({ thread: await deps.threads.changeHarness(owner, threadId(req), req.body) })));

  const confirmations = deps.confirmations;
  if (!confirmations) return;
  const answer = (decide: (owner: HumanPrincipal, thread: string, id: string, body: unknown) => unknown) => handle(async (owner, req) => {
    const thread = threadId(req), id = (req.params as { confirmationId: string }).confirmationId;
    deps.threads.get(owner, thread); // 404 unless the thread is this owner's
    const confirmation = await decide(owner, thread, id, req.body);
    return { confirmation, thread: deps.threads.get(owner, thread) };
  });
  // Approve Once runs the bound command and answers with how it ended; repeating it runs nothing.
  app.post("/api/assistant-threads/:threadId/confirmations/:confirmationId/approve", answer((owner, thread, id) => confirmations.approve(owner, thread, id)));
  app.post("/api/assistant-threads/:threadId/confirmations/:confirmationId/deny", answer((owner, thread, id) => confirmations.deny(owner, thread, id)));
  if (deps.reviseCampaign) {
    const digest = (body: unknown) => {
      const value = (body as { digest?: unknown } | null)?.digest;
      if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
        throw new AssistantOwnerConfirmationRefusal("The current campaign review is required.", 400);
      }
      return value;
    };
    app.post("/api/assistant-threads/:threadId/confirmations/:confirmationId/approve-campaign",
      answer((owner, thread, id, body) => confirmations.approve(owner, thread, id, digest(body))));
    app.put("/api/assistant-threads/:threadId/confirmations/:confirmationId/campaign-budget", answer(async (owner, thread, id, body) => {
      const next = await deps.reviseCampaign!(owner, thread, id, digest(body), (body as { budget: OrchestratorCampaignBudgetDefault }).budget);
      if (!next) throw new AssistantOwnerConfirmationRefusal("The campaign request changed or expired. Refresh the thread to review it.", 409);
      return next;
    }));
  }
}
