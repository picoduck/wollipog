import type { FastifyInstance } from "fastify";
import type { SkillsRouteDeps } from "./skills-route.js";
import type { BuiltInSkill } from "./built-in-skills.js";
import { createSkillBuiltInManagement } from "./skill-built-in-management.js";
export { withSkillRecommendation } from "./skill-built-in-management.js";
export function registerSkillBuiltInRoutes(app: FastifyInstance, deps: SkillsRouteDeps, builtIns: readonly BuiltInSkill[]): void {
  createSkillBuiltInManagement(deps, builtIns).registerHttp(app, deps);
}
