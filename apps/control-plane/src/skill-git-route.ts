import type { FastifyInstance } from "fastify";
import type { SkillsRouteDeps } from "./skills-route.js";
import { discoverGitSkills, discoverGitSkillsAtCommit } from "./skill-git.js";
import { createSkillGitManagement } from "./skill-git-management.js";
export function registerSkillGitRoutes(app: FastifyInstance, deps: SkillsRouteDeps, discover = discoverGitSkills, discoverAtCommit = discoverGitSkillsAtCommit): void {
  createSkillGitManagement(deps, discover, discoverAtCommit).registerHttp(app, deps);
}
