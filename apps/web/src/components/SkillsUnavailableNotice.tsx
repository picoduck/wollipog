import { useEffect, useState } from "react";
import type { ExecutionTargetRef } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import type { RunnerDesiredSkill } from "../skills.js";

type TargetAdapter = ExecutionTargetRef["adapter"] | undefined;

/** Managed skills are deployed into the Machine's home directory, which container and cloud
 * targets never mount. Mirrors the runner's `includeClaudeUserCommandsForTarget` gate. */
export function managedSkillsAvailableForTarget(adapter: TargetAdapter): boolean {
  return adapter !== "container" && adapter !== "cloud";
}

export const SKILLS_UNAVAILABLE_ON_TARGET =
  "Managed skills from this Machine are unavailable on container and cloud targets, because only the workspace is mounted.";

/** Skill names this Machine would deploy for the session's agent. A missing agent id matches any
 * target so an older session still reports the absence instead of hiding it. */
export function assignedSkillNamesForAgent(desired: RunnerDesiredSkill[], agentId: string | null | undefined): string[] {
  return [...new Set(desired
    .filter((skill) => !agentId || skill.targets.some((target) => target.agentId === agentId))
    .map((skill) => skill.name))].sort();
}

export function SkillsUnavailableNotice({ skillNames }: { skillNames: string[] }) {
  const count = `${skillNames.length} Assigned ${skillNames.length === 1 ? "Skill" : "Skills"}`;
  return (
    <aside className="skills-unavailable-notice" role="status" aria-label="Skills Unavailable on This Target">
      <strong>Skills Unavailable on This Target</strong>
      <span>{SKILLS_UNAVAILABLE_ON_TARGET} The agent in this session cannot use them.</span>
      <small>{count}: {skillNames.join(", ")}</small>
    </aside>
  );
}

/** Fetches the Machine's assigned skills only for container and cloud sessions; host sessions
 * never issue the request and never render the notice. */
export function SessionSkillsUnavailableNotice({ runnerId, agentId, adapter }: {
  runnerId: string;
  agentId: string | null | undefined;
  adapter: TargetAdapter;
}) {
  const api = useApi();
  const unavailable = !managedSkillsAvailableForTarget(adapter);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  useEffect(() => {
    setSkillNames([]);
    if (!unavailable) return;
    let cancelled = false;
    // Best effort: a viewer without access to the Machine's skills simply sees no notice.
    void api.runnerSkills(runnerId).then((response) => {
      if (!cancelled) setSkillNames(assignedSkillNamesForAgent(response.desired ?? [], agentId));
    }, () => {});
    return () => { cancelled = true; };
  }, [api, runnerId, agentId, unavailable]);
  if (!unavailable || skillNames.length === 0) return null;
  return <SkillsUnavailableNotice skillNames={skillNames} />;
}
