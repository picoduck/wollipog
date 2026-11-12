import { SkillApplicationService } from "./skills-management.js";
import type { SkillsRouteDeps } from "./skills-route.js";
import { createSkillBuiltInManagement } from "./skill-built-in-management.js";
import { createSkillGitManagement } from "./skill-git-management.js";
import { createMachineSkillManagement } from "./skill-machine-management.js";
import { createSkillDriftManagement } from "./skill-drift-management.js";
import { createSkillGroupsManagement } from "./skill-groups-management.js";

/** One preview/lock lifetime for both adapters. Never recreate this per Assistant call. */
export function createExtendedSkillsManagement(deps: SkillsRouteDeps, inspection: {
  discoverGit?: Parameters<typeof createSkillGitManagement>[1];
  discoverGitAtCommit?: Parameters<typeof createSkillGitManagement>[2];
} = {}): SkillApplicationService {
  const service = new SkillApplicationService();
  service.include(createSkillBuiltInManagement(deps, deps.builtInSkills ?? []));
  service.include(createSkillGitManagement(deps, inspection.discoverGit, inspection.discoverGitAtCommit));
  service.include(createMachineSkillManagement(deps));
  service.include(createSkillDriftManagement(deps));
  service.include(createSkillGroupsManagement(deps));
  return service;
}
