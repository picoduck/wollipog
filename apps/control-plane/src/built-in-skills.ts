/**
 * Built-in Wollipog skills: the repository's skills/ directory, compiled into every release
 * (built-in-skills.generated.ts) and seeded into the Skill Library as unassigned, recommended
 * entries. Nothing here writes to a machine: deployment still needs an assignment, and then uses
 * the ordinary sync path.
 */
import type { SkillFile } from "@wollipog/protocol";
import type { BuiltInSkillSeedOutcome, ControlPlaneDb } from "./db.js";
import { BUILT_IN_SKILL_SOURCES, type BuiltInSkillSource } from "./built-in-skills.generated.js";
import { APP_RELEASE_VERSION } from "./release-version.js";
import { validateSkillPayload } from "./skills.js";

export interface BuiltInSkill {
  name: string;
  description: string | null;
  files: SkillFile[];
  manifest: string;
  digest: string;
  /** The Wollipog release that ships this content. */
  release: string;
}

/** Validate the compiled sources exactly like a library upload; a release never ships a skill the
 * library would refuse. */
export function builtInSkills(
  sources: readonly BuiltInSkillSource[] = BUILT_IN_SKILL_SOURCES,
  release: string = APP_RELEASE_VERSION,
): BuiltInSkill[] {
  return sources.map((source) => {
    const validated = validateSkillPayload({ name: source.name, files: source.files });
    if (!validated.ok) throw new Error(`built-in skill ${source.name} is invalid: ${validated.error}`);
    return {
      name: validated.name,
      description: validated.description,
      files: validated.files,
      manifest: validated.manifest,
      digest: validated.digest,
      release,
    };
  });
}

/** Reconcile the library with the running release's built-in skills (see db.seedBuiltInSkill).
 * Returns each skill's outcome; "created" and "updated" change what track-latest machines deploy. */
export function seedBuiltInSkills(
  db: ControlPlaneDb,
  skills: readonly BuiltInSkill[],
  now = Date.now(),
): Record<string, BuiltInSkillSeedOutcome> {
  const outcomes: Record<string, BuiltInSkillSeedOutcome> = {};
  for (const skill of skills) outcomes[skill.name] = db.seedBuiltInSkill({ ...skill, now });
  db.withdrawBuiltInSkillOffers(skills.map((skill) => skill.name), now);
  return outcomes;
}
