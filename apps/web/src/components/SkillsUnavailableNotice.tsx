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

/** `skillNames` is null when the Machine's assignments could not be read: the target still lacks
 * every managed skill, so the notice stays and only the list is omitted. */
export function SkillsUnavailableNotice({ skillNames }: { skillNames: string[] | null }) {
  return (
    <aside className="skills-unavailable-notice" role="status" aria-label="Skills Unavailable on This Target">
      <strong>Skills Unavailable on This Target</strong>
      <span>{SKILLS_UNAVAILABLE_ON_TARGET} The agent in this session cannot use them.</span>
      {skillNames && (
        <small>
          {skillNames.length} Assigned {skillNames.length === 1 ? "Skill" : "Skills"}: {skillNames.join(", ")}
        </small>
      )}
    </aside>
  );
}

/** Fetches the Machine's assigned skills only for container and cloud sessions; host sessions
 * never issue the request and never render the notice. No push event announces assignment changes,
 * so the list is re-read whenever the tab regains visibility or focus, which covers a change made
 * in another tab or on another device; a change made in this tab's Skills view remounts the
 * session anyway. */
export function SessionSkillsUnavailableNotice({ runnerId, agentId, adapter }: {
  runnerId: string;
  agentId: string | null | undefined;
  adapter: TargetAdapter;
}) {
  const api = useApi();
  const unavailable = !managedSkillsAvailableForTarget(adapter);
  // [] until loaded or when nothing is assigned; null when the assignments could not be read.
  const [skillNames, setSkillNames] = useState<string[] | null>([]);
  useEffect(() => {
    setSkillNames([]);
    if (!unavailable) return;
    let disposed = false;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      const live = () => !disposed && current === generation;
      void api.runnerSkills(runnerId).then((response) => {
        if (live()) setSkillNames(assignedSkillNamesForAgent(response.desired ?? [], agentId));
      }, () => {
        if (live()) setSkillNames(null);
      });
    };
    const reloadWhenVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    document.addEventListener("visibilitychange", reloadWhenVisible);
    window.addEventListener("focus", load);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", reloadWhenVisible);
      window.removeEventListener("focus", load);
    };
  }, [api, runnerId, agentId, unavailable]);
  if (!unavailable || skillNames?.length === 0) return null;
  return <SkillsUnavailableNotice skillNames={skillNames} />;
}
