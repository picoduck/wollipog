import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Notice } from "./Notice.js";
import type { ExecutionTargetDefinition, ExecutionTargetRef } from "@wollipog/protocol";
import { useApi } from "../api-context.js";
import { useInstanceScope } from "../instance-scope.js";
import { loadInstanceStorageValue, saveInstanceStorageValue } from "../instance-storage.js";
import type { RunnerDesiredSkill } from "../skills.js";

type TargetAdapter = ExecutionTargetRef["adapter"] | undefined;

/** Managed skills are deployed into the Machine's home directory, which container and cloud
 * targets never mount. Mirrors the runner's `includeClaudeUserCommandsForTarget` gate. */
export function managedSkillsAvailableForTarget(adapter: TargetAdapter): boolean {
  return adapter !== "container" && adapter !== "cloud";
}

export const SKILLS_UNAVAILABLE_ON_TARGET =
  "Managed skills from this Machine are unavailable on container and cloud targets, because only the workspace is mounted.";

/** Names of a Machine's advertised execution targets that cannot see its managed skills, in the
 * runner's order. Empty for host-only Machines and for runners that advertise no targets. */
export function targetsWithoutManagedSkills(targets: Pick<ExecutionTargetDefinition, "name" | "adapter">[] | undefined): string[] {
  return (targets ?? []).filter((target) => !managedSkillsAvailableForTarget(target.adapter)).map((target) => target.name);
}

/** Skill names this Machine would deploy for the session's agent. A missing agent id matches any
 * target so an older session still reports the absence instead of hiding it. */
export function assignedSkillNamesForAgent(desired: RunnerDesiredSkill[], agentId: string | null | undefined): string[] {
  return [...new Set(desired
    .filter((skill) => !agentId || skill.targets.some((target) => target.agentId === agentId))
    .map((skill) => skill.name))].sort();
}

/** The sentence the session notice and the Pinned Summary share (#1977). The machine is named by
 * its display name; the skills are named while there are at most three, and counted after that. When
 * the assignments could not be read (`skillNames` null) it stops after "sessions". */
export function skillsUnavailableSentence(machine: string, adapter: "container" | "cloud", skillNames: string[] | null): string {
  const base = `Skills from ${machine || "this machine"} aren’t available in ${adapter} sessions`;
  if (!skillNames || skillNames.length === 0) return `${base}.`;
  const skills = skillNames.length > 3 ? `${skillNames.length} assigned skills`
    : skillNames.length === 1 ? skillNames[0]!
      : skillNames.length === 2 ? `${skillNames[0]} and ${skillNames[1]}`
        : `${skillNames.slice(0, -1).join(", ")}, and ${skillNames.at(-1)}`;
  return `${base}, so ${skills} can’t be used here.`;
}

/** The slot's info condition for a container or cloud session with assigned skills. Nothing waits on
 * the person, so it is info rather than a warning, and dismissible; the Pinned Summary keeps the
 * fact after that. */
export function SkillsUnavailableNotice({ machine, adapter, skillNames, trailing, onDismiss, onOpenSkills }: {
  machine: string;
  adapter: "container" | "cloud";
  skillNames: string[] | null;
  trailing?: ReactNode;
  onDismiss?: () => void;
  onOpenSkills: () => void;
}) {
  return (
    <Notice tone="info" compact role="status" ariaLabel="Skills Unavailable" trailing={trailing}
      dismissLabel="Dismiss Notice" onDismiss={onDismiss}
      actions={<button type="button" className="btn sm" onClick={onOpenSkills}>Open Agent Skills</button>}>
      <p>{skillsUnavailableSentence(machine, adapter, skillNames)}</p>
    </Notice>
  );
}

export interface SessionSkillsUnavailable {
  adapter: "container" | "cloud";
  /** Null when the Machine's assignments could not be read: the target still lacks every managed
   * skill, so the condition holds and only the names are unknown. */
  skillNames: string[] | null;
}

/** Whether this session's target lacks the Machine's assigned skills. The assignments are read only
 * for container and cloud sessions; host sessions never issue the request. Null while loading and
 * when nothing is assigned to the session's agent. No push event announces assignment changes, so
 * the list is re-read whenever the tab regains visibility or focus, which covers a change made in
 * another tab or on another device; a change made in this tab's Skills view remounts the session
 * anyway. */
export function useSessionSkillsUnavailable({ runnerId, agentId, adapter }: {
  runnerId: string;
  agentId: string | null | undefined;
  adapter: TargetAdapter;
}): SessionSkillsUnavailable | null {
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
  return useMemo(() => {
    if ((adapter !== "container" && adapter !== "cloud") || skillNames?.length === 0) return null;
    return { adapter, skillNames };
  }, [adapter, skillNames]);
}

/** Sessions whose skills notice was dismissed on this device, most recent last. One list per
 * instance, capped so it cannot grow without bound. */
export const SKILLS_NOTICE_DISMISSALS_KEY = "wollipog.sessions.skillsNoticeDismissed";
export const SKILLS_NOTICE_DISMISSALS_CAP = 200;

export function parseSkillsNoticeDismissals(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Adds a session, keeping the newest `SKILLS_NOTICE_DISMISSALS_CAP`. */
export function withSkillsNoticeDismissal(dismissed: readonly string[], sessionId: string): string[] {
  return [...dismissed.filter((id) => id !== sessionId), sessionId].slice(-SKILLS_NOTICE_DISMISSALS_CAP);
}

/** The per-session dismissal, stored on this device so a reload does not bring the notice back. */
export function useSkillsNoticeDismissal(sessionId: string): [dismissed: boolean, dismiss: () => void] {
  const instanceScope = useInstanceScope();
  const [version, setVersion] = useState(0);
  const dismissed = useMemo(
    () => parseSkillsNoticeDismissals(loadInstanceStorageValue(SKILLS_NOTICE_DISMISSALS_KEY, instanceScope)).includes(sessionId),
    // `version` re-reads storage after this component writes it.
    [instanceScope, sessionId, version],
  );
  const dismiss = useCallback(() => {
    const current = parseSkillsNoticeDismissals(loadInstanceStorageValue(SKILLS_NOTICE_DISMISSALS_KEY, instanceScope));
    saveInstanceStorageValue(SKILLS_NOTICE_DISMISSALS_KEY, JSON.stringify(withSkillsNoticeDismissal(current, sessionId)), instanceScope);
    setVersion((value) => value + 1);
  }, [instanceScope, sessionId]);
  return [dismissed, dismiss];
}
