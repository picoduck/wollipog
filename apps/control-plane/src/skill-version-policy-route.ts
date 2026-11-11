import type { FastifyInstance } from "fastify";
import type { SkillsRouteDeps } from "./skills-route.js";
import { createSkillVersionPolicyManagement } from "./skill-version-policy-management.js";
export function registerSkillVersionPolicyRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  const service = createSkillVersionPolicyManagement(deps);
  for (const key of service.handlers.keys()) {
    const [method, url] = key.split(" ");
    app.route({method: method as "GET" | "PUT", url: url!, handler: async (req, reply) => {
      const principal = deps.requestPrincipal(req);
      const result = await service.execute(key, {principal, params: req.params, body: req.body, query: req.query});
      return reply.code(result.status).send(result.body);
    }});
  }
}
