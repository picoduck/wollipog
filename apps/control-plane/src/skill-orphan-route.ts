import type { FastifyInstance } from "fastify";
import type { SkillsRouteDeps } from "./skills-route.js";
import type { EditedCopyLock } from "./skill-edited-copy.js";
import { createSkillOrphanManagement } from "./skill-orphan-management.js";
export { listOrphanedSkillCopies } from "./skill-orphan-management.js";
export type { OrphanedSkillCopy, OrphanedSkillCopyRef } from "./skill-orphan-management.js";
export function registerSkillOrphanRoutes(app: FastifyInstance, deps: SkillsRouteDeps, lock: EditedCopyLock): void {
  createSkillOrphanManagement(deps, lock).registerHttp(app, deps);
}
