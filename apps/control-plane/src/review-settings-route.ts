import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthPrincipal } from "./identity.js";
import { ReviewSettingsError, type ReviewSettingsService } from "./review-settings.js";

export function registerReviewSettingsRoutes(app: FastifyInstance, service: ReviewSettingsService,
  principalFor: (request: FastifyRequest) => AuthPrincipal | null): void {
  for (const method of ["GET", "PUT"] as const) app.route({ method, url: "/api/review-settings", handler: async (request, reply) => {
    const principal = principalFor(request);
    if (principal?.kind !== "human") return reply.code(403).send({ error: "Review settings are available to signed-in users only." });
    const query = request.query as { projectId?: unknown };
    if (query.projectId !== undefined && (typeof query.projectId !== "string" || !query.projectId)) {
      return reply.code(400).send({ error: "Choose a valid Project." });
    }
    try {
      const projectId = typeof query.projectId === "string" ? query.projectId : null;
      if (method === "PUT") request.log.info({ event: "review_settings_update", entryPoint: "review_settings_route", projectOverride: projectId !== null }, "Updating review settings");
      return reply.header("cache-control", "private, no-store").send(method === "GET" ? service.view(principal, projectId)
        : service.update(principal, projectId, (request.body as { settings?: unknown } | null)?.settings));
    } catch (error) {
      if (error instanceof ReviewSettingsError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  } });
}
