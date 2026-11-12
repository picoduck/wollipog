import type { FastifyInstance } from "fastify";
import type { SkillsRouteDeps } from "./skills-route.js";
import { createMachineSkillManagement } from "./skill-machine-management.js";
export function registerMachineSkillRoutes(app: FastifyInstance, deps: SkillsRouteDeps): void {
  createMachineSkillManagement(deps).registerHttp(app, deps);
}
