import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CreateSideChatRequest, SessionView, SideChatView } from "@wollipog/protocol";
import type { AuthPrincipal } from "./identity.js";
import type { ServiceResult } from "./sessions.js";
import { failureBody } from "./capability-refusal.js";
import { withSessionCommandPermissions } from "./session-command-permissions.js";

/**
 * A session's side chat (#1206, #2863). Both routes answer with the side chat's session as the
 * session lookup does: its live turn coordinate and queue state (`withQueue`), which the database
 * view lacks, and what the asking person may do to it. Without them Side Chat could never offer Stop
 * Turn: its `activeTurnId` only exists in the hub's live overlay.
 */
export function registerSideChatRoutes(
  app: FastifyInstance,
  deps: {
    service: {
      sideChat(parentSessionId: string): ServiceResult<SideChatView | null>;
      createSideChat(parentSessionId: string, replaceEnded?: boolean): ServiceResult<SideChatView>;
    };
    permissions: Parameters<typeof withSessionCommandPermissions>[0];
    requestPrincipal: (req: FastifyRequest) => AuthPrincipal | null | undefined;
    withQueue: (session: SessionView) => SessionView;
  },
): void {
  const live = (req: FastifyRequest, sideChat: SideChatView): SideChatView => ({
    ...sideChat,
    session: withSessionCommandPermissions(deps.permissions, deps.requestPrincipal(req), deps.withQueue(sideChat.session)),
  });

  app.get("/api/sessions/:id/side-chat", async (req, reply) => {
    const result = deps.service.sideChat((req.params as { id: string }).id);
    if (!result.ok) return reply.code(result.status).send(failureBody(result));
    return { sideChat: result.data ? live(req, result.data) : null };
  });

  app.post("/api/sessions/:id/side-chat", async (req, reply) => {
    const body = (req.body ?? {}) as CreateSideChatRequest;
    if (body.replaceEnded !== undefined && typeof body.replaceEnded !== "boolean") {
      return reply.code(400).send({ error: "replaceEnded must be a boolean" });
    }
    const result = deps.service.createSideChat((req.params as { id: string }).id, body.replaceEnded === true);
    if (!result.ok || !result.data) return reply.code(result.status).send(failureBody(result));
    return reply.code(result.status).send(live(req, result.data));
  });
}
