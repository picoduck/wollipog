import type { FastifyInstance } from "fastify";
import type { SkillsRouteDeps } from "./skills-route.js";
import { createSkillDriftManagement } from "./skill-drift-management.js";
export function registerSkillDriftRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  createSkillDriftManagement(deps).registerHttp(app, deps);
}
